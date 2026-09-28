import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { env } from "./test-env";

const worker = workerExports as unknown as { default: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> } };

describe("Telegram webhook integration", () => {
  it("claims an update once and returns duplicate for a repeated update_id", async () => {
    const updateId = 5001;
    const body = JSON.stringify({ update_id: updateId, message: { from: { id: 987654321, username: "integration", first_name: "Test" }, text: "/start" } });
    const headers = { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" };
    const first = await worker.default.fetch("https://example.test/telegram/webhook", { method: "POST", headers, body });
    const firstBody = (await first.json()) as { ok?: boolean; duplicate?: boolean };
    const second = await worker.default.fetch("https://example.test/telegram/webhook", { method: "POST", headers, body });
    const secondBody = (await second.json()) as { ok?: boolean; duplicate?: boolean };
    expect(first.status).toBe(200);
    expect(firstBody).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(secondBody).toEqual({ ok: true, duplicate: true });
    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM telegram_updates WHERE update_id = ?1").bind(updateId).first<{ count: number }>();
    const user = await env.DB.prepare("SELECT telegram_user_id FROM users WHERE telegram_user_id = ?1").bind(987654321).first<{ telegram_user_id: number }>();
    expect(row?.count).toBe(1);
    expect(user?.telegram_user_id).toBe(987654321);
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe("test-secret");
  });

  it("rate-limits a user within the configured minute bucket", async () => {
    const userId = 987654322;
    await env.DB.prepare("INSERT INTO system_config(config_key,config_value,updated_at) VALUES ('limits.telegram_updates_per_minute','1','2026-09-28T12:00:00Z') ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value,updated_at=excluded.updated_at").run();
    const headers = { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" };
    const first = await worker.default.fetch("https://example.test/telegram/webhook", { method: "POST", headers, body: JSON.stringify({ update_id: 5101, message: { from: { id: userId, first_name: "Rate" }, text: "/start" } }) });
    const second = await worker.default.fetch("https://example.test/telegram/webhook", { method: "POST", headers, body: JSON.stringify({ update_id: 5102, message: { from: { id: userId, first_name: "Rate" }, text: "/start" } }) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok?: boolean; duplicate?: boolean };
    expect(secondBody).toEqual({ ok: true, duplicate: true });
    const ignored = await env.DB.prepare("SELECT status,error_code FROM telegram_updates WHERE update_id=?1").bind(5102).first<{status:string;error_code:string}>();
    expect(ignored?.status).toBe("ignored");
    expect(ignored?.error_code).toBe("rate_limited");
  });

  it("rejects webhook requests without the configured secret", async () => {
    const response = await worker.default.fetch("https://example.test/telegram/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ update_id: 5002 }) });
    expect(response.status).toBe(401);
  });
});
