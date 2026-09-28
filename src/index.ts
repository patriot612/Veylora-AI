import { createAIGateway } from "./ai-gateway";
import { getSystemConfig } from "./config";
import { createDefaultProviderAdapters } from "./providers/factory";
import { handleChatMessage } from "./chat/service";
import { executeSearch } from "./search/service";
import { claimTelegramUpdate, markTelegramUpdate, upsertTelegramUser } from "./db/telegram";
import { hasValidWebhookSecret, isTelegramWebhookPath, jsonResponse } from "./http";
import { editTelegramMessage, sendTelegramMessage } from "./telegram/api";
import { classifyTelegramUpdate } from "./telegram/router";
import { processQueueBatch } from "./queue/consumer";
import { processDeadLetterBatch } from "./queue/dead-letter";
import { processImageJob } from "./image/service";
import { enqueueVoiceMessage, enterVoiceMode, exitVoiceMode, handleVoiceTextWhileActive, processVoiceJob } from "./voice/service";
import { answerDocumentQuestion, enterDocumentsMode, exitDocumentsMode, processDocumentUpload } from "./documents/service";

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

        if (envelope.kind === "command" && typeof envelope.chat_id === "number") {
          const command = extractMessageText(update);
          if (command === "/documents") {
            await enterDocumentsMode(env.DB, user.id, now);
            if (env.TELEGRAM_BOT_TOKEN) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Documents mode включён. Отправьте PDF/DOCX/TXT до 10 МБ.");
          }
          if (command === "/voice") {
            if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("voice_runtime_secrets_missing");
            const mode = await enterVoiceMode(env.DB, user.id, now);
            await sendTelegramMessage(
              env.TELEGRAM_BOT_TOKEN,
              envelope.chat_id,
              mode.ok
                ? "Voice Mode включён. Отправьте голосовое сообщение."
                : "Voice Mode доступен только по активной подписке.",
            );
          }
        }

        if (envelope.kind === "document" && envelope.document && typeof envelope.chat_id === "number") {
          if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
          const result = await processDocumentUpload({
            db: env.DB,
            botToken: env.TELEGRAM_BOT_TOKEN,
            userId: user.id,
            fileId: envelope.document.fileId,
            mimeType: envelope.document.mimeType,
            fileName: envelope.document.fileName,
            now,
            encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY!,
          });
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "error" in result ? "Не удалось обработать документ: " + result.error : "Документ принят. Задайте вопрос по содержимому.");
        }

        if (envelope.kind === "text" && typeof envelope.text === "string" && typeof envelope.chat_id === "number" && typeof envelope.message_id === "number") {
          const activeMode = await env.DB.prepare("SELECT active_mode FROM users WHERE id=?1").bind(user.id).first<{ active_mode: string }>();
          if (activeMode?.active_mode === "documents") {
            if (!env.CREDENTIAL_ENCRYPTION_KEY || !env.TELEGRAM_BOT_TOKEN) throw new Error("document_runtime_secrets_missing");
            const documentModelId = await getSystemConfig(env.DB, "default_chat_model_id");
            const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, createDefaultProviderAdapters());
            const result = await answerDocumentQuestion({
              db: env.DB,
              gateway,
              userId: user.id,
              question: envelope.text,
              now,
              modelId: documentModelId ?? undefined,
              encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
            });
            if (result && "answer" in result) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, result.answer);
            else if (env.TELEGRAM_BOT_TOKEN) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Не удалось получить ответ по документу: " + (result as {error:string}).error);
          } else if (activeMode?.active_mode === "voice") {
            if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
            await handleVoiceTextWhileActive(env.TELEGRAM_BOT_TOKEN, envelope.chat_id);
          } else {
          if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("telegram_chat_runtime_secrets_missing");
          const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, createDefaultProviderAdapters());
          const send = (text: string, options?: Parameters<typeof sendTelegramMessage>[3]) => sendTelegramMessage(env.TELEGRAM_BOT_TOKEN!, envelope.chat_id!, text, options);
          const edit = (messageId: number, text: string, options?: Parameters<typeof editTelegramMessage>[4]) => editTelegramMessage(env.TELEGRAM_BOT_TOKEN!, envelope.chat_id!, messageId, text, options);
          await handleChatMessage({ db: env.DB, gateway, userId: user.id, text: envelope.text, telegramUpdateId: envelope.update_id, chatId: envelope.chat_id, messageId: envelope.message_id, now, credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY, send, edit });
          }
        }

        if (envelope.kind === "voice" && typeof envelope.chat_id === "number") {
          const message = isRecord(update.message) ? update.message : null;
          const voice = message && isRecord(message.voice) ? message.voice : null;
          const fileId = voice && typeof voice.file_id === "string" ? voice.file_id : null;
          if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("voice_runtime_secrets_missing");
          if (!fileId) throw new Error("voice_file_id_missing");
          const result = await enqueueVoiceMessage({
            db: env.DB,
            queue: env.AI_JOBS,
            userId: user.id,
            fileId,
            mimeType: voice && typeof voice.mime_type === "string" ? voice.mime_type : undefined,
            duration: voice && typeof voice.duration === "number" ? voice.duration : undefined,
            chatId: envelope.chat_id,
            telegramUpdateId: envelope.update_id,
            now,
            credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
          });
          if ("error" in result) {
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, result.error === "subscription_required" ? "Voice Mode доступен только по активной подписке." : "Не удалось принять голосовое сообщение. Попробуйте ещё раз.");
          } else {
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "🎙️ Обрабатываю голосовое сообщение...");
          }
        }

        if (envelope.kind === "callback" && envelope.callbackData === "voice_exit" && typeof envelope.chat_id === "number") {
          await exitVoiceMode(env.DB, user.id, now);
          if (env.TELEGRAM_BOT_TOKEN) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Voice Mode отключён. Вы вернулись в обычный Chat.");
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
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "veylora-ai-jobs-dlq") {
      await processDeadLetterBatch(batch, env.DB, () => new Date().toISOString());
      return;
    }

    await processQueueBatch(batch, {
      db: env.DB,
      now: () => new Date().toISOString(),
      handlers: {
        image: async (message) => processImageJob(message, {
          db: env.DB,
          gateway: createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY!, createDefaultProviderAdapters()),
          botToken: env.TELEGRAM_BOT_TOKEN!,
          encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY!,
          now: () => new Date().toISOString(),
        }),
        voice: async (message) => processVoiceJob(message, {
          db: env.DB,
          gateway: createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY!, createDefaultProviderAdapters()),
          botToken: env.TELEGRAM_BOT_TOKEN!,
          now: () => new Date().toISOString(),
        }),
        document: async () => ({ ok: false, retryable: false, code: "document_handler_not_registered" }),
      },
    });
  },
  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {},
} satisfies ExportedHandler<Env>;

function extractMessageText(update: Record<string, unknown>): string | undefined {
  const message = update.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
