import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { env as typedEnv } from "./test-env";

describe("Telegram webhook integration", () => {
  it("claims an update once and returns duplicate for a repeated update_id", async () => {
    const updateId = 5001;
    const body = JSON.stringify({
      update_id: updateId,
      message: {
        from: { id: 987654321, username: "integration", first_name: "Test" },
        text: "/start",
      },
    });

    const headers = {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-secret",
    };

    const first = await exports.default.fetch("https://example.test/telegram/webhook", {
      method: "POST",
      headers,
      body,
    });
    const firstBody = (await first.json()) as { ok?: boolean; duplicate?: boolean };

    const second = await exports.default.fetch("https://example.test/telegram/webhook", {
      method: "POST",
      headers,
      body,
    });
    const secondBody = (await second.json()) as { ok?: boolean; duplicate?: boolean };

    expect(first.status).toBe(200);
    expect(firstBody).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(secondBody).toEqual({ ok: true, duplicate: true });

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM telegram_updates WHERE update_id = ?1")
      .bind(updateId)
      .first<{ count: number }>();
    const user = await env.DB
      .prepare("SELECT telegram_user_id FROM users WHERE telegram_user_id = ?1")
      .bind(987654321)
      .first<{ telegram_user_id: number }>();

    expect(row?.count).toBe(1);
    expect(user?.telegram_user_id).toBe(987654321);
    expect(typedEnv.TELEGRAM_WEBHOOK_SECRET).toBe("test-secret");
  });

  it("rejects webhook requests without the configured secret", async () => {
    const response = await exports.default.fetch("https://example.test/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 5002 }),
    });

    expect(response.status).toBe(401);
  });
});
