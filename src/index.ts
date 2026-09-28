import { claimTelegramUpdate, markTelegramUpdate, upsertTelegramUser } from "./db/telegram";
import { hasValidWebhookSecret, isTelegramWebhookPath, jsonResponse } from "./http";
import { classifyTelegramUpdate } from "./telegram/router";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const MAX_TELEGRAM_UPDATE_BYTES = 1_048_576;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, environment: env.ENVIRONMENT }), {
        status: 200,
        headers: { ...jsonHeaders, "cache-control": "no-store" },
      });
    }

    if (isTelegramWebhookPath(url.pathname)) {
      if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
      if (!hasValidWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_TELEGRAM_UPDATE_BYTES) {
        return jsonResponse({ error: "payload_too_large" }, 413);
      }

      let update: Record<string, unknown>;
      try {
        update = await request.json<Record<string, unknown>>();
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }

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

        // Business routing is intentionally introduced in later stages. This boundary
        // establishes authenticated identity and exactly-once update claiming first.
        await markTelegramUpdate(env.DB, envelope.update_id, "processed", new Date().toISOString());
        return jsonResponse({ ok: true });
      } catch (error) {
        const updateId = typeof update.update_id === "number" ? update.update_id : null;
        if (updateId !== null) {
          await markTelegramUpdate(env.DB, updateId, "failed", new Date().toISOString(), error instanceof Error ? error.message : "unknown_error");
        }
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }

    return jsonResponse({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (typeof message.body !== "object" || message.body === null) {
        throw new Error("invalid_queue_message");
      }
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Retention/cleanup is implemented in its dedicated stage.
  },
} satisfies ExportedHandler<Env>;
