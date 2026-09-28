import { getSystemConfig } from "../config";
import { createOperation } from "../operations/service";
import { enqueueHeavyJob } from "../queue/producer";
import { resolveModel } from "../models/registry";
import type { AIGateway, GatewayImageResult } from "../ai-gateway";
import { sendTelegramPhoto } from "../telegram/api";
import { transitionOperation } from "../operations/service";
import { TelegramApiError } from "../telegram/api";

export type ImageRequest = {
  db: D1Database;
  queue: Queue;
  userId: string;
  prompt: string;
  modelId?: string;
  templateId?: string;
  size?: string;
  quality?: string;
  format?: string;
  telegramUpdateId: number;
  chatId: number;
  now: string;
  encryptionKey: string;
};

export type ImageQueueDeps = {
  db: D1Database;
  gateway: AIGateway;
  botToken: string;
  encryptionKey: string;
  now: () => string;
  fetchImpl?: typeof fetch;
};

export async function handleImageRequest(input: ImageRequest): Promise<{ operationId: string } | { error: string }> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4000) return { error: "invalid_image_prompt" };

  const selectedModelId = input.modelId ?? await getSystemConfig(input.db, "default_image_model_id");
  if (!selectedModelId) return { error: "image_model_unavailable" };

  const model = await resolveModel(input.db, {
    userId: input.userId,
    modelId: selectedModelId,
    expectedType: "image",
    now: input.now,
    credentialEncryptionKey: input.encryptionKey ?? "",
  });

  let finalPrompt = prompt;
  let templateCost = 0;

  if (input.templateId) {
    const template = await input.db
      .prepare("SELECT prompt_template, extra_points_cost, enabled FROM image_templates WHERE id = ?1")
      .bind(input.templateId)
      .first<{ prompt_template: string; extra_points_cost: number; enabled: number }>();
    if (!template || template.enabled !== 1) return { error: "image_template_unavailable" };
    finalPrompt = template.prompt_template.replace("{{prompt}}", prompt);
    templateCost = template.extra_points_cost;
  }

  const totalCost = model.pointsCost + templateCost;
  const operation = await createOperation(input.db, {
    userId: input.userId,
    type: "image",
    telegramUpdateId: input.telegramUpdateId,
    modelId: model.id,
    pointsCost: totalCost,
    now: input.now,
    requestHash: String(input.chatId),
  });

  if (operation.duplicate) return { operationId: operation.operation.id };

  try {
    await enqueueHeavyJob({
      db: input.db,
      queue: input.queue,
      operationId: operation.operation.id,
      userId: input.userId,
      jobType: "image",
      pointsCost: totalCost,
      now: input.now,
      metadata: {
        modelId: model.id,
        prompt: finalPrompt,
        templateId: input.templateId,
        templateCost,
        size: input.size,
        quality: input.quality,
        format: input.format,
        chatId: input.chatId,
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "image_enqueue_failed" };
  }

  return { operationId: operation.operation.id };
}

export async function processImageJob(message: {
  operationId: string;
  userId: string;
  metadata?: Record<string, unknown>;
}, deps: ImageQueueDeps): Promise<{ ok: true } | { ok: false; retryable: boolean; code: string }> {
  const operation = await deps.db
    .prepare("SELECT status, model_id, temporary_result_ref, telegram_delivery_status FROM operations WHERE id=?1 AND user_id=?2")
    .bind(message.operationId, message.userId)
    .first<{ status: string; model_id: string | null; temporary_result_ref: string | null; telegram_delivery_status: string }>();

  if (!operation || !operation.model_id) return { ok: false, retryable: false, code: "image_operation_not_found" };
  if (operation.status === "succeeded" || operation.status === "failed" || operation.status === "timeout" || operation.status === "cancelled") {
    return { ok: true };
  }

  const chatId = numberValue(message.metadata?.chatId);
  if (chatId === null) return { ok: false, retryable: false, code: "image_chat_missing" };

  const existingRef = operation.temporary_result_ref;
  if (operation.telegram_delivery_status === "sent" && existingRef) {
    return { ok: true };
  }

  let result: GatewayImageResult;
  try {
    if (existingRef) {
      result = { modelId: operation.model_id, url: existingRef };
    } else {
      const generation = await deps.gateway.generateImage({
        userId: message.userId,
        modelId: operation.model_id,
        prompt: stringValue(message.metadata?.prompt) ?? "",
        size: stringValue(message.metadata?.size),
        quality: stringValue(message.metadata?.quality),
        format: stringValue(message.metadata?.format),
        now: deps.now(),
        timeoutMs: 5 * 60 * 1000,
      });
      result = generation;
      if (generation.url) {
        await deps.db
          .prepare("UPDATE operations SET temporary_result_ref = ?3, telegram_delivery_status='pending' WHERE id=?1 AND user_id=?2")
          .bind(generation.url, message.operationId, message.userId)
          .run();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout")) return { ok: false, retryable: true, code: "image_timeout" };
    return { ok: false, retryable: true, code: error instanceof Error ? error.message : "image_generation_failed" };
  }

  await transitionOperation(deps.db, {
    operationId: message.operationId,
    userId: message.userId,
    to: "delivering",
    now: deps.now(),
  });

  try {
    await sendTelegramPhoto(
      deps.botToken,
      chatId,
      { url: result.url, bytes: result.bytes, contentType: result.contentType },
      {},
      deps.fetchImpl ?? fetch,
    );
    await deps.db
      .prepare("UPDATE operations SET telegram_delivery_status='sent' WHERE id=?1 AND user_id=?2")
      .bind(message.operationId, message.userId)
      .run();
    return { ok: true };
  } catch (error) {
    if (error instanceof TelegramApiError && error.retryable) {
      return { ok: false, retryable: true, code: "telegram_delivery_retry" };
    }
    return { ok: false, retryable: false, code: "telegram_delivery_failed" };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
