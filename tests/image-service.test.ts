import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { createAIGateway } from "../src/ai-gateway";
import { processImageJob } from "../src/image/service";
import { type ProviderAdapter } from "../src/providers/types";
import { encryptCredentialSecret } from "../src/security/credentials";

let telegramId = 950000000;
let seq = 0;
const key = "image-test-key";

async function seedImageOperation(cost = 10) {
  const userId = crypto.randomUUID();
  const providerId = "image_provider_" + (++seq);
  const credentialId = "image_credential_" + seq;
  const modelId = "image_model_" + seq;
  const operationId = crypto.randomUUID();

  await env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(userId, ++telegramId).run();
  await env.DB.prepare("INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'image_test','https://image.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(providerId, "Image Provider " + seq).run();
  await env.DB.prepare("INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Image',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(credentialId, providerId, await encryptCredentialSecret("secret", key)).run();
  await env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'image-model','Image Test','image',?4,0,NULL,NULL,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(modelId, providerId, credentialId, cost).run();
  await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','processing',?3,?4,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId, cost).run();
  await env.DB.prepare("INSERT INTO point_reservations (id,operation_id,daily_amount,bonus_amount,status,created_at) VALUES (?1,?2,?3,0,'reserved','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId, cost).run();
  await env.DB.prepare("UPDATE users SET daily_points_remaining = 50 - ?2 WHERE id=?1").bind(userId, cost).run();
  return { userId, modelId, operationId };
}

function imageAdapter(): ProviderAdapter {
  return { type: "image_test", async invoke() { return { ok: true, kind: "image", url: "https://cdn.example.com/image.png", providerRequestId: "image-1" }; } };
}

describe("image queue lifecycle", () => {
  it("generates through the AI Gateway, delivers once, and settles exactly once", async () => {
    const { userId, modelId, operationId } = await seedImageOperation(10);
    const gateway = createAIGateway(env.DB, key, [imageAdapter()]);
    const calls: Request[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(new Request(input, init)); return new Response(JSON.stringify({ ok: true, result: { message_id: 777, photo: [{ file_id: "telegram-default" }] } }), { status: 200, headers: { "content-type": "application/json" } }); };
    const result = await processImageJob({ operationId, userId, metadata: { chatId: 123, prompt: "a robot", modelId } }, { db: env.DB, gateway, botToken: "test-token", encryptionKey: key, now: () => "2026-09-28T12:01:00Z", fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendPhoto");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status,telegram_delivery_status,temporary_result_ref FROM operations WHERE id=?1").bind(operationId).first<{status:string;telegram_delivery_status:string;temporary_result_ref:string|null}>();
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("delivering");
    expect(op?.telegram_delivery_status).toBe("sent");
    expect(op?.temporary_result_ref).toBe("telegram-default");
  });

  it("reuses the temporary provider result after Telegram 429 without regenerating", async () => {
    const { userId, modelId, operationId } = await seedImageOperation(9);
    await env.DB.prepare("UPDATE operations SET temporary_result_ref=?2, telegram_delivery_status='pending' WHERE id=?1").bind(operationId, "https://cdn.example.com/retry.png").run();
    let providerCalls = 0;
    const adapter: ProviderAdapter = { type: "image_test", async invoke() { providerCalls += 1; return { ok: true, kind: "image", url: "https://cdn.example.com/new.png" }; } };
    const gateway = createAIGateway(env.DB, key, [adapter]);
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } }), { status: 429, headers: { "content-type": "application/json" } });
    const result = await processImageJob({ operationId, userId, metadata: { chatId: 123, prompt: "retry", modelId } }, { db: env.DB, gateway, botToken: "test-token", encryptionKey: key, now: () => "2026-09-28T12:02:00Z", fetchImpl });
    expect(result).toEqual({ ok: false, retryable: true, code: "telegram_delivery_retry", retryAfterSeconds: 2 });
    expect(providerCalls).toBe(0);
  });

  it("captures the Telegram file_id after delivery without permanent image storage", async () => {
    const { userId, modelId, operationId } = await seedImageOperation(8);
    let providerCalls = 0;
    const gateway = createAIGateway(env.DB, key, [{ type: "image_test", async invoke() { providerCalls += 1; return { ok: true, kind: "image", url: "https://cdn.example.com/image.png" }; } }]);
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 778, photo: [{ file_id: "telegram-small" }, { file_id: "telegram-large" }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await processImageJob(
      { operationId, userId, metadata: { chatId: 123, prompt: "file id", modelId } },
      { db: env.DB, gateway, botToken: "test-token", encryptionKey: key, now: () => "2026-09-28T12:03:00Z", fetchImpl },
    );
    expect(result).toEqual({ ok: true });
    expect(providerCalls).toBe(1);
    const op = await env.DB.prepare("SELECT telegram_delivery_status,temporary_result_ref FROM operations WHERE id=?1").bind(operationId).first<{telegram_delivery_status:string;temporary_result_ref:string|null}>();
    expect(op?.telegram_delivery_status).toBe("sent");
    expect(op?.temporary_result_ref).toBe("telegram-large");
  });

  it("rejects oversized binary image results before Telegram delivery", async () => {
    const { userId, modelId, operationId } = await seedImageOperation(7);
    const gateway = createAIGateway(env.DB, key, [{ type: "image_test", async invoke() { return { ok: true, kind: "image", bytes: new Uint8Array(10 * 1024 * 1024 + 1), contentType: "image/png" }; } }]);
    const result = await processImageJob({ operationId, userId, metadata: { chatId: 123, prompt: "huge", modelId } }, { db: env.DB, gateway, botToken: "bot", encryptionKey: key, now: () => "2026-09-28T12:05:00Z", fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }) });
    expect(result).toEqual({ ok: false, retryable: false, code: "image_too_large" });
  });
});
