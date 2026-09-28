import { hasValidWebhookSecret, isTelegramWebhookPath, jsonResponse } from "./http";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

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
      if (request.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      if (!hasValidWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ error: "telegram_handler_not_initialized" }, 501);
    }

    return jsonResponse({ error: "not_found" }, 404);
  },

  async queue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
    for (const message of batch.messages) {
      // Foundation-only consumer: acknowledge only after parsing safe metadata.
      // Business execution is introduced with the Queue stage.
      if (typeof message.body !== "object" || message.body === null) {
        throw new Error("invalid_queue_message");
      }
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Retention/cleanup is implemented in its dedicated stage.
  },
} satisfies ExportedHandler<Env>;
