import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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

  it("supports owner control writes with audit attribution and Telegram Stars refund", async () => {
    const ownerTelegramId = 940000003;
    const ownerUserId = crypto.randomUUID();
    await seedAdminUser(ownerUserId, ownerTelegramId, "owner");

    const targetTelegramId = 940000004;
    const targetUserId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(targetUserId, targetTelegramId).run();

    const credentialId = crypto.randomUUID();
    const modelId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO credentials (id,provider_id,name,encrypted_secret,created_at,updated_at) VALUES (?1,'provider_groq','Test Credential','encrypted-placeholder','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(credentialId).run();
    await env.DB.prepare(
      "INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,enabled,capabilities,config,created_at,updated_at) VALUES (?1,'family_gpt','provider_groq',?2,'test-model','Admin Test','chat',7,0,1,'{}','{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(modelId, credentialId).run();

    const orderId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,'plan_month','active','2026-09-28T12:00:00Z','2026-10-28T12:00:00Z','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(crypto.randomUUID(), targetUserId).run();
    await env.DB.prepare(
      "INSERT INTO orders (id,user_id,plan_id,status,amount,currency,provider,telegram_payment_charge_id,created_at,paid_at) VALUES (?1,?2,'plan_month','paid',120,'XTR','telegram_stars','charge-admin-refund','2026-09-28T12:00:00Z','2026-09-28T12:01:00Z')",
    ).bind(orderId, targetUserId).run();
    await env.DB.prepare(
      "INSERT INTO payments (id,order_id,provider,external_payment_id,status,raw_safe_metadata,created_at) VALUES (?1,?2,'telegram_stars','charge-admin-refund','paid','{}','2026-09-28T12:01:00Z')",
    ).bind(crypto.randomUUID(), orderId).run();

    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, ownerTelegramId);
    const headers = { "X-Telegram-Init-Data": initData };

    const bonus = await worker.default.fetch(`https://example.test/admin/api/users/${targetTelegramId}/bonus`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 25 }),
    });
    expect(bonus.status).toBe(200);

    const modelList = await worker.default.fetch("https://example.test/admin/api/models", { headers });
    expect(modelList.status).toBe(200);
    const modelListBody = await modelList.json() as { rows?: Array<Record<string, unknown>> };
    expect(modelListBody.rows?.[0]).not.toHaveProperty("provider_name");
    expect(modelListBody.rows?.[0]).not.toHaveProperty("credential_name");

    const modelUpdate = await worker.default.fetch(`https://example.test/admin/api/models/${modelId}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ pointsCost: 11, subscriptionOnly: true, enabled: false }),
    });
    expect(modelUpdate.status).toBe(200);

    const planUpdate = await worker.default.fetch("https://example.test/admin/api/plans/plan_month", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ priceStars: 777 }),
    });
    expect(planUpdate.status).toBe(200);

    let refundUrl = "";
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      refundUrl = String(input);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const refund = await worker.default.fetch(`https://example.test/admin/api/payments/${orderId}/refund`, {
        method: "POST",
        headers,
      });
      expect(refund.status).toBe(200);
      expect(refundUrl).toContain("/refundStarPayment");
    } finally {
      vi.unstubAllGlobals();
    }

    const target = await env.DB.prepare("SELECT bonus_points FROM users WHERE id=?1").bind(targetUserId).first<{bonus_points:number}>();
    const model = await env.DB.prepare("SELECT points_cost,subscription_only,enabled FROM models WHERE id=?1").bind(modelId).first<{points_cost:number;subscription_only:number;enabled:number}>();
    const plan = await env.DB.prepare("SELECT price_stars FROM plans WHERE id='plan_month'").first<{price_stars:number}>();
    const order = await env.DB.prepare("SELECT status FROM orders WHERE id=?1").bind(orderId).first<{status:string}>();
    const subscription = await env.DB.prepare("SELECT status FROM subscriptions WHERE user_id=?1 AND plan_id='plan_month'").bind(targetUserId).first<{status:string}>();
    const audit = await env.DB.prepare("SELECT actor_user_id,event_type FROM audit_log WHERE event_type IN ('bonus.grant','model.update','plan.update','payment.refund') ORDER BY created_at DESC LIMIT 4").all<{actor_user_id:string|null;event_type:string}>();

    expect(target?.bonus_points).toBe(25);
    expect(model).toEqual({ points_cost: 11, subscription_only: 1, enabled: 0 });
    expect(plan?.price_stars).toBe(777);
    expect(order?.status).toBe("refunded");
    expect(subscription?.status).toBe("refunded");
    expect(audit.results.every((row) => row.actor_user_id === ownerUserId)).toBe(true);
  });

  it("prevents support from granting bonus points", async () => {
    const supportTelegramId = 940000005;
    const supportUserId = crypto.randomUUID();
    await seedAdminUser(supportUserId, supportTelegramId, "support");
    const targetTelegramId = 940000006;
    const targetUserId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(targetUserId, targetTelegramId).run();
    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, supportTelegramId);
    const response = await worker.default.fetch(`https://example.test/admin/api/users/${targetTelegramId}/bonus`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initData, "content-type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(response.status).toBe(403);
  });
  it("manages providers and credentials without exposing encrypted secrets", async () => {
    const ownerTelegramId = 940000007;
    const ownerUserId = crypto.randomUUID();
    await seedAdminUser(ownerUserId, ownerTelegramId, "owner");

    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, ownerTelegramId);
    const headers = { "X-Telegram-Init-Data": initData, "content-type": "application/json" };
    const providerId = crypto.randomUUID();

    const createdProvider = await worker.default.fetch("https://example.test/admin/api/providers/" + providerId, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Admin Test Provider", adapterType: "openai_compatible", endpoint: "https://provider.example/v1", enabled: true }),
    });
    expect(createdProvider.status).toBe(200);

    const credentialId = crypto.randomUUID();
    const createdCredential = await worker.default.fetch("https://example.test/admin/api/providers/" + providerId + "/credentials/" + credentialId, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Admin Key", secret: "super-secret", enabled: true }),
    });
    expect(createdCredential.status).toBe(200);

    const listed = await worker.default.fetch("https://example.test/admin/api/providers/" + providerId + "/credentials", {
      headers: { "X-Telegram-Init-Data": initData },
    });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { rows?: Array<Record<string, unknown>> };
    expect(body.rows?.[0]?.name).toBe("Admin Key");
    expect(body.rows?.[0]).not.toHaveProperty("encrypted_secret");

    const stored = await env.DB.prepare("SELECT encrypted_secret FROM credentials WHERE id=?1").bind(credentialId).first<{encrypted_secret:string}>();
    expect(stored?.encrypted_secret).toMatch(/^v1\./);
    expect(stored?.encrypted_secret).not.toContain("super-secret");
  });

  it("supports Model Registry CRUD, Search controls and maintenance RBAC", async () => {
    const ownerTelegramId = 940000008;
    const ownerUserId = crypto.randomUUID();
    await seedAdminUser(ownerUserId, ownerTelegramId, "owner");
    const initData = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, ownerTelegramId);
    const headers = { "X-Telegram-Init-Data": initData, "content-type": "application/json" };

    const options = await worker.default.fetch("https://example.test/admin/api/models/options", { headers });
    expect(options.status).toBe(200);
    const optionsBody = await options.json() as {families?:Array<{id:string}>;providers?:Array<{id:string}>;credentials?:Array<{id:string;provider_id:string}>};
    const familyId = optionsBody.families?.[0]?.id;
    const providerId = optionsBody.providers?.[0]?.id;
    const credentialId = optionsBody.credentials?.find((row) => row.provider_id === providerId)?.id;
    expect(familyId).toBeTruthy();
    expect(providerId).toBeTruthy();
    expect(credentialId).toBeTruthy();

    const modelId = "admin-crud-" + crypto.randomUUID();
    const created = await worker.default.fetch("https://example.test/admin/api/models", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: modelId,
        familyId,
        providerId,
        credentialId,
        displayName: "Admin CRUD Model",
        type: "chat",
        providerModelId: "admin-crud-model",
        pointsCost: 9,
        subscriptionOnly: false,
        enabled: true,
      }),
    });
    expect(created.status).toBe(200);

    const deleted = await worker.default.fetch("https://example.test/admin/api/models/" + modelId, { method: "DELETE", headers });
    expect(deleted.status).toBe(200);

    const searchWrite = await worker.default.fetch("https://example.test/admin/api/search", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        "search.enabled": true,
        "search.primary_url": "https://search.example",
        "search.fallback_url": "https://fallback.example",
        "search.language": "ru",
        "search.categories": "general",
        "search.time_range": "week",
        "search.safe_search": 2,
      }),
    });
    expect(searchWrite.status).toBe(200);

    const searchRead = await worker.default.fetch("https://example.test/admin/api/search", { headers });
    expect(searchRead.status).toBe(200);
    const searchBody = await searchRead.json() as {config?:Array<{config_key:string;config_value:string}>};
    expect(searchBody.config?.some((row) => row.config_key === "search.language" && row.config_value === "ru")).toBe(true);

    const secretConfig = await worker.default.fetch("https://example.test/admin/api/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ key: "provider_api_token", value: "secret" }),
    });
    expect(secretConfig.status).toBe(403);

    const maintenance = await worker.default.fetch("https://example.test/admin/api/queue", {
      method: "PUT",
      headers,
      body: JSON.stringify({ maintenanceMode: true }),
    });
    expect(maintenance.status).toBe(200);

    const queueRead = await worker.default.fetch("https://example.test/admin/api/queue", { headers });
    expect(queueRead.status).toBe(200);
    expect((await queueRead.json() as {maintenanceMode:boolean}).maintenanceMode).toBe(true);

    const supportTelegramId = 940000009;
    const supportUserId = crypto.randomUUID();
    await seedAdminUser(supportUserId, supportTelegramId, "support");
    const supportInit = await buildInitData("test-bot-token", Math.floor(Date.now() / 1000) - 30, supportTelegramId);
    const supportMaintenance = await worker.default.fetch("https://example.test/admin/api/queue", {
      method: "PUT",
      headers: { "X-Telegram-Init-Data": supportInit, "content-type": "application/json" },
      body: JSON.stringify({ maintenanceMode: false }),
    });
    expect(supportMaintenance.status).toBe(403);
  });

});
