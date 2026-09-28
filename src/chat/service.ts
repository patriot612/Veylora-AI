import { getSystemConfig, getSystemConfigInt } from "../config";
import { reservePoints, releaseReservation, settleReservation } from "../billing/points";
import type { AIGateway } from "../ai-gateway";
import { resolveModel } from "../models/registry";
import { acquireActiveChatOperation, releaseActiveChatOperation } from "../operations/locks";
import { createOperation, transitionOperation } from "../operations/service";
import { getActivePlan } from "../subscriptions";
import type { GatewayMessage } from "../providers/types";
import { TelegramApiError } from "../telegram/api";
import { getUserLocale, t } from "../i18n";

export type ChatRequest = {
  db: D1Database;
  gateway: AIGateway;
  userId: string;
  text: string;
  telegramUpdateId?: number;
  chatId: number;
  messageId: number;
  now: string;
  credentialEncryptionKey: string;
  send: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
  edit: (messageId: number, text: string, options?: Record<string, unknown>) => Promise<unknown>;
};

export type ChatResult =
  | { kind: "answered"; operationId: string; conversationId: string; temporaryMessageId: number; answer: string }
  | { kind: "busy" | "insufficient_points" | "subscription_required" | "invalid_input" | "failed"; operationId?: string; temporaryMessageId?: number; retryable: boolean };

export async function handleChatMessage(input: ChatRequest): Promise<ChatResult> {
  const text = input.text.trim();
  const locale = await getUserLocale(input.db, input.userId);
  await rememberChatRetryText(input.db, input.userId, text);
  const maxChars = await getSystemConfigInt(input.db, "limits.chat_chars", 4096);
  if (!text || text.length > maxChars) {
    await safeSend(input.send, locale === "ru" ? `Максимальная длина сообщения — ${maxChars} символов.` : `${t(locale, "chat.failed")} (max ${maxChars})`);
    return { kind: "invalid_input", retryable: false };
  }

  const existingLock = await input.db
    .prepare("SELECT active_operation_id FROM users WHERE id = ?1")
    .bind(input.userId)
    .first<{ active_operation_id: string | null }>();

  if (existingLock?.active_operation_id) {
    await safeSend(input.send, t(locale, "chat.busy"));
    return { kind: "busy", retryable: true };
  }

  let conversation = await loadActiveConversation(input.db, input.userId);
  const modelId = conversation?.model_id ?? await getSelectedChatModelId(input.db, input.userId);

  if (!modelId) {
    await safeSend(input.send, t(locale, "chat.modelMissing"));
    return { kind: "failed", retryable: false };
  }

  let model;
  try {
    model = await resolveModel(input.db, {
      userId: input.userId,
      modelId,
      expectedType: "chat",
      now: input.now,
      credentialEncryptionKey: input.credentialEncryptionKey,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "subscription_required") {
      await safeSend(input.send, t(locale, "subscription.required"));
      return { kind: "subscription_required", retryable: false };
    }
    await safeSend(input.send, t(locale, "chat.failed"));
    return { kind: "failed", retryable: true };
  }

  if (!conversation) {
    conversation = await createConversation(input.db, {
      userId: input.userId,
      modelId: model.id,
      roleId: await getSelectedRoleId(input.db, input.userId),
      title: text.slice(0, 80),
      expiresAt: await calculateConversationExpiry(input.db, input.userId, input.now),
      now: input.now,
    });
    await input.db
      .prepare("UPDATE users SET active_conversation_id = ?2, active_chat_model_id = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(input.userId, conversation.id, model.id, input.now)
      .run();
  }

  const operation = await createOperation(input.db, {
    userId: input.userId,
    type: "chat",
    telegramUpdateId: input.telegramUpdateId,
    conversationId: conversation.id,
    modelId: model.id,
    pointsCost: model.pointsCost,
    now: input.now,
  });

  if (operation.duplicate) {
    return { kind: "failed", operationId: operation.operation.id, retryable: false };
  }

  if (!(await acquireActiveChatOperation(input.db, input.userId, operation.operation.id))) {
    await transitionOperation(input.db, {
      operationId: operation.operation.id,
      userId: input.userId,
      to: "cancelled",
      now: new Date().toISOString(),
      errorCode: "busy",
    });
    await safeSend(input.send, t(locale, "chat.busy"));
    return { kind: "busy", operationId: operation.operation.id, retryable: true };
  }

  let temporaryMessageId: number | undefined;
  let telegramDelivered = false;

  try {
    const reservation = await reservePoints(input.db, input.userId, operation.operation.id, model.pointsCost, input.now);
    if (!reservation.ok) {
      await transitionOperation(input.db, {
        operationId: operation.operation.id,
        userId: input.userId,
        to: "failed",
        now: new Date().toISOString(),
        errorCode: reservation.reason,
      });
      await safeSend(input.send, t(locale, "billing.insufficient"));
      return { kind: "insufficient_points", operationId: operation.operation.id, retryable: false };
    }

    const temporary = await input.send(t(locale, "chat.processing"));
    temporaryMessageId = temporary.message_id;
    await transitionOperation(input.db, {
      operationId: operation.operation.id,
      userId: input.userId,
      to: "processing",
      now: new Date().toISOString(),
    });

    const messages = await buildContext(input.db, conversation.id, input.userId, model.contextWindow ?? 16_000);
    const answer = await input.gateway.generateText({
      userId: input.userId,
      modelId: model.id,
      modelType: "chat",
      messages: [...messages, { role: "user", content: text }],
      now: input.now,
      timeoutMs: 60_000,
    });

    await transitionOperation(input.db, {
      operationId: operation.operation.id,
      userId: input.userId,
      to: "delivering",
      now: new Date().toISOString(),
    });

    try {
      await input.edit(temporaryMessageId, answer.text);
    } catch (error) {
      throw error instanceof TelegramApiError ? error : new Error("telegram_delivery_failed", { cause: error });
    }
    await input.db
      .prepare("UPDATE operations SET telegram_delivery_status='sent' WHERE id=?1 AND user_id=?2 AND status='delivering' AND telegram_delivery_status='not_started'")
      .bind(operation.operation.id, input.userId)
      .run();
    telegramDelivered = true;

    await persistTurn(input.db, conversation.id, model.id, conversation.role_id, text, answer.text, input.now, input.userId);
    const settled = await settleReservation(input.db, operation.operation.id, new Date().toISOString());
    if (!settled) throw new Error("settlement_failed");

    await clearChatRetryText(input.db, input.userId);

    await input.db
      .prepare("UPDATE conversations SET updated_at = ?2, expires_at = ?3 WHERE id = ?1 AND user_id = ?4")
      .bind(conversation.id, input.now, await calculateConversationExpiry(input.db, input.userId, input.now), input.userId)
      .run();

    return {
      kind: "answered",
      operationId: operation.operation.id,
      conversationId: conversation.id,
      temporaryMessageId,
      answer: answer.text,
    };
  } catch (error) {
    if (!telegramDelivered) {
      await releaseReservation(input.db, operation.operation.id, new Date().toISOString()).catch(() => false);
      await transitionOperation(input.db, {
        operationId: operation.operation.id,
        userId: input.userId,
        to: "failed",
        now: new Date().toISOString(),
        errorCode: error instanceof Error ? error.message : "chat_failed",
      }).catch(() => false);

      if (temporaryMessageId) {
        await safeEdit(input.edit, temporaryMessageId, t(locale, "chat.failed"), { reply_markup: { inline_keyboard: [[{ text: t(locale, "common.retry"), callback_data: "chat_retry" }]] } });
      } else {
        await safeSend(input.send, t(locale, "chat.failed"), { reply_markup: { inline_keyboard: [[{ text: t(locale, "common.retry"), callback_data: "chat_retry" }]] } });
      }
    }

    return { kind: "failed", operationId: operation.operation.id, retryable: !telegramDelivered, temporaryMessageId };
  } finally {
    await releaseActiveChatOperation(input.db, input.userId, operation.operation.id).catch(() => false);
  }
}

async function loadActiveConversation(db: D1Database, userId: string) {
  return db.prepare(
    "SELECT id, model_id, role_id FROM conversations WHERE id = (SELECT active_conversation_id FROM users WHERE id = ?1) AND user_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)",
  ).bind(userId, new Date().toISOString()).first<{ id: string; model_id: string; role_id: string | null }>();
}

async function getSelectedChatModelId(db: D1Database, userId: string): Promise<string | null> {
  const user = await db.prepare("SELECT active_chat_model_id FROM users WHERE id = ?1").bind(userId).first<{ active_chat_model_id: string | null }>();
  if (user?.active_chat_model_id) return user.active_chat_model_id;
  return getSystemConfig(db, "default_chat_model_id");
}

async function getSelectedRoleId(db: D1Database, userId: string): Promise<string | null> {
  const user = await db.prepare("SELECT active_role_id FROM users WHERE id = ?1").bind(userId).first<{ active_role_id: string | null }>();
  return user?.active_role_id ?? null;
}

async function createConversation(
  db: D1Database,
  input: { userId: string; modelId: string; roleId: string | null; title: string; expiresAt: string; now: string },
) {
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO conversations (id,user_id,title,model_id,role_id,created_at,updated_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,?6,?7)",
  ).bind(id, input.userId, input.title, input.modelId, input.roleId, input.now, input.expiresAt).run();
  return { id, model_id: input.modelId, role_id: input.roleId };
}

async function calculateConversationExpiry(db: D1Database, userId: string, now: string): Promise<string> {
  const plan = await getActivePlan(db, userId, now);
  const hours = plan?.retentionHours ?? 24;
  return new Date(Date.parse(now) + hours * 3_600_000).toISOString();
}

async function buildContext(db: D1Database, conversationId: string, userId: string, contextWindow: number): Promise<GatewayMessage[]> {
  const role = await db.prepare(
    "SELECT r.system_prompt FROM conversations c JOIN ai_roles r ON r.id = c.role_id WHERE c.id = ?1 AND c.user_id = ?2 AND r.enabled = 1",
  ).bind(conversationId, userId).first<{ system_prompt: string }>();

  const rows = await db.prepare(
    "SELECT user_text, assistant_text FROM conversation_turns WHERE conversation_id = ?1 AND EXISTS (SELECT 1 FROM conversations WHERE id = ?1 AND user_id = ?2) ORDER BY created_at DESC LIMIT 99",
  ).bind(conversationId, userId).all<{ user_text: string; assistant_text: string }>();

  const turns = [...(rows.results ?? [])].reverse();
  const messages: GatewayMessage[] = [];
  if (role?.system_prompt) messages.push({ role: "system", content: role.system_prompt });

  const reserve = Math.max(1024, Math.floor(contextWindow * 0.85));
  let used = 0;
  for (const turn of turns) {
    const pair = [
      { role: "user" as const, content: turn.user_text },
      { role: "assistant" as const, content: turn.assistant_text },
    ];
    const pairChars = pair[0].content.length + pair[1].content.length;
    if (used + pairChars > reserve) continue;
    messages.push(...pair);
    used += pairChars;
  }

  return messages;
}

async function persistTurn(
  db: D1Database,
  conversationId: string,
  modelId: string,
  roleId: string | null,
  userText: string,
  assistantText: string,
  now: string,
  userId: string,
) {
  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM conversation_turns WHERE conversation_id = ?1 AND EXISTS (SELECT 1 FROM conversations WHERE id = ?1 AND user_id = ?2)",
  ).bind(conversationId, userId).first<{ count: number }>();

  if ((count?.count ?? 0) >= 100) {
    await db.prepare(
      "DELETE FROM conversation_turns WHERE id IN (SELECT id FROM conversation_turns WHERE conversation_id = ?1 ORDER BY created_at ASC LIMIT 1)",
    ).bind(conversationId).run();
  }

  await db.prepare(
    "INSERT INTO conversation_turns (id,conversation_id,user_text,assistant_text,model_id,role_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",
  ).bind(crypto.randomUUID(), conversationId, userText, assistantText, modelId, roleId, now).run();
}

async function safeSend(
  send: ChatRequest["send"],
  text: string,
  options?: Record<string, unknown>,
) {
  try {
    return await send(text, options);
  } catch {
    return { message_id: 0 };
  }
}

async function safeEdit(
  edit: ChatRequest["edit"],
  messageId: number,
  text: string,
  options?: Record<string, unknown>,
) {
  try {
    return await edit(messageId, text, options);
  } catch {
    return undefined;
  }
}

async function rememberChatRetryText(db: D1Database, userId: string, text: string): Promise<void> {
  const row = await db.prepare("SELECT ui_preferences FROM user_settings WHERE user_id=?1").bind(userId).first<{ ui_preferences: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.ui_preferences ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
  } catch {}
  prefs.lastChatText = text.slice(0, 4096);
  await db.prepare("UPDATE user_settings SET ui_preferences=?2 WHERE user_id=?1").bind(userId, JSON.stringify(prefs)).run();
}

async function clearChatRetryText(db: D1Database, userId: string): Promise<void> {
  const row = await db.prepare("SELECT ui_preferences FROM user_settings WHERE user_id=?1").bind(userId).first<{ ui_preferences: string }>();
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.ui_preferences ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed as Record<string, unknown>;
  } catch {}
  delete prefs.lastChatText;
  await db.prepare("UPDATE user_settings SET ui_preferences=?2 WHERE user_id=?1").bind(userId, JSON.stringify(prefs)).run();
}
