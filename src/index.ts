import { createAIGateway } from "./ai-gateway";
import { createDefaultProviderAdapters } from "./providers/factory";
import { handleChatMessage } from "./chat/service";
import { executeSearch } from "./search/service";
import { claimTelegramUpdate, markTelegramUpdate, upsertTelegramUser } from "./db/telegram";
import { hasValidWebhookSecret, isTelegramWebhookPath, jsonResponse } from "./http";
import { editTelegramMessage, sendTelegramMessage } from "./telegram/api";
import { classifyTelegramUpdate } from "./telegram/router";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const MAX_TELEGRAM_UPDATE_BYTES = 1_048_576;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, environment: env.ENVIRONMENT }), { status: 200, headers: { ...jsonHeaders, "cache-control": "no-store" } });
    }
    if (isTelegramWebhookPath(url.pathname)) {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      if (!hasValidWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) return jsonResponse({ error: "unauthorized" }, 401);
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_TELEGRAM_UPDATE_BYTES) return jsonResponse({ error: "payload_too_large" }, 413);
      let update: Record<string, unknown>;
      try { update = await request.json<Record<string, unknown>>(); } catch { return jsonResponse({ error: "invalid_json" }, 400); }

      try {
        const envelope = classifyTelegramUpdate(update);
        const now = new Date().toISOString();
        const user = envelope.user ? await upsertTelegramUser(env.DB, envelope.user, now) : null;
        const claim = await claimTelegramUpdate(env.DB, envelope.update_id, user?.id ?? null, now);
        if (claim.duplicate) return jsonResponse({ ok: true, duplicate: true });
        await markTelegramUpdate(env.DB, envelope.update_id, "processing", now);
        if (!user) {
          await markTelegramUpdate(env.DB, envelope.update_id, "ignored", new Date().toISOString(), "user_not_found");
          return jsonResponse({ ok: true, ignored: true });
        }

        if (envelope.kind === "text" && typeof envelope.text === "string" && typeof envelope.chat_id === "number" && typeof envelope.message_id === "number") {
          if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("telegram_chat_runtime_secrets_missing");
          const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, createDefaultProviderAdapters());
          const send = (text: string, options?: Parameters<typeof sendTelegramMessage>[3]) => sendTelegramMessage(env.TELEGRAM_BOT_TOKEN!, envelope.chat_id!, text, options);
          const edit = (messageId: number, text: string, options?: Parameters<typeof editTelegramMessage>[4]) => editTelegramMessage(env.TELEGRAM_BOT_TOKEN!, envelope.chat_id!, messageId, text, options);
          await handleChatMessage({ db: env.DB, gateway, userId: user.id, text: envelope.text, telegramUpdateId: envelope.update_id, chatId: envelope.chat_id, messageId: envelope.message_id, now, credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY, send, edit });
        }

        const commandText = extractMessageText(update);
        if (envelope.kind === "command" && commandText?.startsWith("/search") && typeof envelope.chat_id === "number") {
          if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY || !env.SEARXNG_URL) throw new Error("search_runtime_secrets_missing");
          const query = commandText.slice("/search".length).trim();
          if (!query) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Использование: /search <запрос>");
          else {
            const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, createDefaultProviderAdapters());
            const outcome = await executeSearch({ db: env.DB, gateway, userId: user.id, query, telegramUpdateId: envelope.update_id, now, searxngUrl: env.SEARXNG_URL, credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY });
            const message = outcome.kind === "answered" ? outcome.text : outcome.kind === "no_result" ? "Результат не найден. Попробуйте изменить запрос." : outcome.kind === "insufficient_points" ? "У вас закончились баллы для Search Mode." : "Не удалось выполнить поиск. Попробуйте ещё раз.";
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, message);
          }
        }

        await markTelegramUpdate(env.DB, envelope.update_id, "processed", new Date().toISOString());
        return jsonResponse({ ok: true });
      } catch (error) {
        const updateId = typeof update.update_id === "number" ? update.update_id : null;
        if (updateId !== null) await markTelegramUpdate(env.DB, updateId, "failed", new Date().toISOString(), error instanceof Error ? error.message : "unknown_error");
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }
    return jsonResponse({ error: "not_found" }, 404);
  },
  async queue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
    for (const message of batch.messages) if (typeof message.body !== "object" || message.body === null) throw new Error("invalid_queue_message");
  },
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
} satisfies ExportedHandler<Env>;

function extractMessageText(update: Record<string, unknown>): string | undefined {
  const message = update.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}
