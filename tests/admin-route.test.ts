import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { env } from "./test-env";

const worker = workerExports as unknown as {
  default: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

async function buildInitData(botToken: string, authDate: number, userId: number) {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", "AA-admin-test");
  params.set("user", JSON.stringify({ id: userId, username: "admin-test", first_name: "Admin" }));

  const sorted: Array<[string, string]> = [];
  params.forEach((value, key) => sorted.push([key, value]));
  sorted.sort(([a], [b]) => a.localeCompare(b));
  const dataCheck = sorted.map(([key, value]) => key + "=" + value).join("\n");

  const firstKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", firstKey, new TextEncoder().encode(botToken));
  const secondKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", secondKey, new TextEncoder().encode(dataCheck)));
  params.set("hash", Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

async function seedAdminUser(userId: string, telegramUserId: number, role: "owner" | "admin" | "support") {
  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, telegramUserId).run();
  await env.DB.prepare(
    "INSERT INTO admin_roles (user_id,role,created_at,updated_at) VALUES (?1,?2,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, role).run();
}

describe("Admin Mini App HTTP surface", () => {
  it("serves the app shell but requires verified initData for every API request", async () => {
    const shell = await worker.default.fetch("https://example.test/admin");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const unauthorized = await worker.default.fetch("https://example.test/admin/api/session");
    expect(unauthorized.status).toBe(401);
  });

  it("rejects a valid Telegram identity that is not server-authorized as admin", async () => {
    const telegramUserId = 940000001;
    await env.DB.prepare(
      "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(crypto.randomUUID(), telegramUserId).run();

    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, telegramUserId);
    const response = await worker.default.fetch("https://example.test/admin/api/session", {
      headers: { "X-Telegram-Init-Data": initData },
    });
    expect(response.status).toBe(403);
  });

  it("loads the server-side role and enforces permission checks", async () => {
    const telegramUserId = 940000002;
    const userId = crypto.randomUUID();
    await seedAdminUser(userId, telegramUserId, "support");

    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, telegramUserId);
    const headers = { "X-Telegram-Init-Data": initData };

    const session = await worker.default.fetch("https://example.test/admin/api/session", { headers });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ ok: true, role: "support", user: { id: telegramUserId } });

    const dashboard = await worker.default.fetch("https://example.test/admin/api/dashboard", { headers });
    expect(dashboard.status).toBe(200);
    expect((await dashboard.json() as { ok: boolean }).ok).toBe(true);

    const search = await worker.default.fetch("https://example.test/admin/api/search", { headers });
    expect(search.status).toBe(200);
    expect((await search.json() as { ok: boolean }).ok).toBe(true);

    const statistics = await worker.default.fetch("https://example.test/admin/api/statistics", { headers });
    expect(statistics.status).toBe(200);
    expect((await statistics.json() as { ok: boolean }).ok).toBe(true);

    const configWrite = await worker.default.fetch("https://example.test/admin/api/config", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ key: "forbidden.test", value: "x" }),
    });
    expect(configWrite.status).toBe(403);
  });
});
