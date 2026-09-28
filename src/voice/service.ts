import { getSystemConfig } from "../config";
import { createOperation } from "../operations/service";
import { enqueueHeavyJob } from "../queue/producer";
import { resolveModel } from "../models/registry";
import { getActivePlan } from "../subscriptions";
import { getTelegramFile, downloadTelegramFile, sendTelegramMessage, sendTelegramVoice, TelegramApiError } from "../telegram/api";
import type { AIGateway } from "../ai-gateway";
import { ProviderGatewayError } from "../providers/types";

export async function enterVoiceMode(db: D1Database, userId: string, now: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const plan = await getActivePlan(db, userId, now);
  if (!plan?.voiceEnabled) return { ok: false, reason: "subscription_required" };
  await db.prepare("UPDATE users SET active_mode='voice', updated_at=?2 WHERE id=?1").bind(userId, now).run();
  return { ok: true };
}

export async function exitVoiceMode(db: D1Database, userId: string, now: string): Promise<void> {
  await db.prepare("UPDATE users SET active_mode='chat', updated_at=?2 WHERE id=?1").bind(userId, now).run();
}

export async function enqueueVoiceMessage(input: {
  db: D1Database;
  queue: Queue;
  userId: string;
  fileId: string;
  mimeType?: string;
  duration?: number;
  chatId: number;
  telegramUpdateId: number;
  now: string;
  credentialEncryptionKey: string;
}): Promise<{ operationId: string } | { error: string }> {
  const plan = await getActivePlan(input.db, input.userId, input.now);
  if (!plan?.voiceEnabled) return { error: "subscription_required" };

  const modelId = await getSystemConfig(input.db, "default_voice_model_id");
  if (!modelId) return { error: "voice_model_unavailable" };

  const model = await resolveModel(input.db, {
    userId: input.userId,
    modelId,
    expectedType: "voice",
    now: input.now,
    credentialEncryptionKey: input.credentialEncryptionKey,
  }).catch(() => null);
  if (!model) return { error: "voice_model_unavailable" };

  const operation = await createOperation(input.db, {
    userId: input.userId,
    type: "voice",
    telegramUpdateId: input.telegramUpdateId,
    modelId: model.id,
    pointsCost: model.pointsCost,
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
      jobType: "voice",
      pointsCost: model.pointsCost,
      now: input.now,
      metadata: {
        fileId: input.fileId,
        mimeType: input.mimeType,
        duration: input.duration,
        chatId: input.chatId,
        modelId: model.id,
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "voice_enqueue_failed" };
  }

  return { operationId: operation.operation.id };
}

export async function processVoiceJob(
  message: { operationId: string; userId: string; metadata?: Record<string, unknown> },
  deps: {
    db: D1Database;
    gateway: AIGateway;
    botToken: string;
    now: () => string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ ok: true } | { ok: false; retryable: boolean; code: string }> {
  const operation = await deps.db
    .prepare("SELECT status, model_id FROM operations WHERE id=?1 AND user_id=?2")
    .bind(message.operationId, message.userId)
    .first<{ status: string; model_id: string | null }>();

  if (!operation?.model_id) return { ok: false, retryable: false, code: "voice_operation_not_found" };
  if (["succeeded", "failed", "timeout", "cancelled"].includes(operation.status)) return { ok: true };

  const fileId = stringValue(message.metadata?.fileId);
  const chatId = numberValue(message.metadata?.chatId);
  if (!fileId || chatId === null) return { ok: false, retryable: false, code: "voice_payload_invalid" };

  try {
    const file = await getTelegramFile(deps.botToken, fileId, deps.fetchImpl ?? fetch);
    const audio = await downloadTelegramFile(deps.botToken, file.file_path, 20 * 1024 * 1024, deps.fetchImpl ?? fetch);
    const reply = await deps.gateway.generateVoiceReply({
      userId: message.userId,
      modelId: operation.model_id,
      input: audio.bytes,
      inputContentType: stringValue(message.metadata?.mimeType) ?? audio.contentType,
      now: deps.now(),
      timeoutMs: 5 * 60 * 1000,
    });

    await sendTelegramVoice(
      deps.botToken,
      chatId,
      { bytes: reply.bytes, contentType: reply.contentType },
      {},
      deps.fetchImpl ?? fetch,
    );

    return { ok: true };
  } catch (error) {
    if (error instanceof TelegramApiError && error.retryable) {
      return { ok: false, retryable: true, code: "telegram_voice_delivery_retry" };
    }
    if (error instanceof ProviderGatewayError && error.retryable) {
      return { ok: false, retryable: true, code: error.code };
    }
    if (error instanceof Error && error.message.includes("timeout")) {
      return { ok: false, retryable: true, code: "voice_timeout" };
    }
    return { ok: false, retryable: false, code: error instanceof Error ? error.message : "voice_failed" };
  }
}

export async function handleVoiceTextWhileActive(
  db: D1Database,
  userId: string,
  botToken: string,
  chatId: number,
  fetchImpl?: typeof fetch,
): Promise<void> {
  await sendTelegramMessage(
    botToken,
    chatId,
    "Voice режим активен. Отключите Voice, чтобы вернуться в обычный Chat.",
    { reply_markup: { inline_keyboard: [[{ text: "Отключить Voice", callback_data: "voice_exit" }]] } },
    fetchImpl,
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
