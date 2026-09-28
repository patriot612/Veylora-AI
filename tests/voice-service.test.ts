import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { enterVoiceMode, exitVoiceMode, enqueueVoiceMessage, processVoiceJob } from "../src/voice/service";
import { encryptCredentialSecret } from "../src/security/credentials";
import { createAIGateway } from "../src/ai-gateway";
import type { ProviderAdapter } from "../src/providers/types";

let seq = 0;
let tg = 960000000;
const key = "voice-test-key";

async function seedVoiceUser(points = 50, cost = 8) {
  const n = ++seq;
  const userId = crypto.randomUUID();
  const providerId = "voice_provider_" + n;
  const credentialId = "voice_credential_" + n;
  const modelId = "voice_model_" + n;

  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,active_mode,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,0,'chat','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, ++tg, points).run();
  await env.DB.prepare(
    "INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,'plan_month','active','2026-09-28T00:00:00Z','2026-10-28T00:00:00Z','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(crypto.randomUUID(), userId).run();
  await env.DB.prepare(
    "INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'voice_test','https://voice.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(providerId, "Voice Provider " + n).run();
  await env.DB.prepare(
    "INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Voice',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(credentialId, providerId, await encryptCredentialSecret("secret", key)).run();
  await env.DB.prepare(
    "INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'voice-model','Voice Test','voice',?4,1,NULL,NULL,'{}',1,'{"voice_reply_path":"/audio/replies"}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(modelId, providerId, credentialId, cost).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO system_config (config_key,config_value,updated_at) VALUES ('default_voice_model_id',?1,'2026-09-28T12:00:00Z')",
  ).bind(modelId).run();
  return { userId, modelId };
}

function gateway(modelId: string) {
  const adapter: ProviderAdapter = {
    type: "voice_test",
    async invoke() {
      return { ok: true, kind: "binary", bytes: new Uint8Array([1, 2, 3]), contentType: "audio/ogg" };
    },
  };
  return createAIGateway(env.DB, key, [adapter]);
}

describe("Voice mode", () => {
  it("requires paid voice-enabled subscription and toggles mode", async () => {
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,active_mode,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'chat','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(userId, ++tg).run();
    expect((await enterVoiceMode(env.DB, userId, "2026-09-28T12:00:00Z")).ok).toBe(false);

    await env.DB.prepare(
      "INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,'plan_month','active','2026-09-28T00:00:00Z','2026-10-28T00:00:00Z','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(crypto.randomUUID(), userId).run();

    expect((await enterVoiceMode(env.DB, userId, "2026-09-28T12:00:00Z")).ok).toBe(true);
    expect((await env.DB.prepare("SELECT active_mode FROM users WHERE id=?1").bind(userId).first<{active_mode:string}>())?.active_mode).toBe("voice");
    await exitVoiceMode(env.DB, userId, "2026-09-28T12:01:00Z");
    expect((await env.DB.prepare("SELECT active_mode FROM users WHERE id=?1").bind(userId).first<{active_mode:string}>())?.active_mode).toBe("chat");
  });

  it("enqueues a voice operation without archiving conversation text", async () => {
    const { userId, modelId } = await seedVoiceUser();
    await enterVoiceMode(env.DB, userId, "2026-09-28T12:00:00Z");
    const sent: unknown[] = [];
    const queue = { send: async (body: unknown) => { sent.push(body); } } as unknown as Queue;

    const result = await enqueueVoiceMessage({
      db: env.DB,
      queue,
      userId,
      fileId: "voice-file-1",
      mimeType: "audio/ogg",
      duration: 7,
      chatId: 123,
      telegramUpdateId: 30001,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
    });

    expect(result).toHaveProperty("operationId");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("voice-file-1");
    const conversations = await env.DB.prepare("SELECT COUNT(*) AS count FROM conversations WHERE user_id=?1").bind(userId).first<{count:number}>();
    expect(conversations?.count).toBe(0);
    expect(modelId).toBeDefined();
  });

  it("processes a queued voice reply and charges only after delivery", async () => {
    const { userId, modelId } = await seedVoiceUser(50, 8);
    await enterVoiceMode(env.DB, userId, "2026-09-28T12:00:00Z");
    const opId = crypto.randomUUID();

    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'voice','processing',?3,8,'2026-09-28T12:00:00Z')",
    ).bind(opId, userId, modelId).run();
    await env.DB.prepare(
      "INSERT INTO point_reservations (id,operation_id,daily_amount,bonus_amount,status,created_at) VALUES (?1,?2,8,0,'reserved','2026-09-28T12:00:00Z')",
    ).bind(crypto.randomUUID(), opId).run();
    await env.DB.prepare("UPDATE users SET daily_points_remaining=42 WHERE id=?1").bind(userId).run();

    let sentVoices = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/getFile")) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: "voices/in.ogg" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/file/bot")) {
        return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "content-type": "audio/ogg" } });
      }
      if (url.includes("/sendVoice")) {
        sentVoices += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 700 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected_fetch " + url + " " + (init?.method ?? "GET"));
    };

    const result = await processVoiceJob(
      { operationId: opId, userId, metadata: { fileId: "voice-file", chatId: 123, mimeType: "audio/ogg" } },
      { db: env.DB, gateway: gateway(modelId), botToken: "bot-test", now: () => "2026-09-28T12:01:00Z", fetchImpl },
    );

    expect(result).toEqual({ ok: true });
    expect(sentVoices).toBe(1);
    const op = await env.DB.prepare("SELECT status,telegram_delivery_status FROM operations WHERE id=?1").bind(opId).first<{status:string;telegram_delivery_status:string}>();
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(op?.status).toBe("delivering");
    expect(op?.telegram_delivery_status).toBe("sent");
    expect(user?.daily_points_remaining).toBe(42);
  });

  it("retries Telegram 429 without regenerating the voice reply", async () => {
    const { userId, modelId } = await seedVoiceUser(50, 6);
    const opId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'voice','processing',?3,6,'2026-09-28T12:00:00Z')",
    ).bind(opId, userId, modelId).run();
    await env.DB.prepare(
      "INSERT INTO point_reservations (id,operation_id,daily_amount,bonus_amount,status,created_at) VALUES (?1,?2,6,0,'reserved','2026-09-28T12:00:00Z')",
    ).bind(crypto.randomUUID(), opId).run();
    await env.DB.prepare("UPDATE users SET daily_points_remaining=44 WHERE id=?1").bind(userId).run();

    let providerCalls = 0;
    const adapter: ProviderAdapter = {
      type: "voice_test",
      async invoke() {
        providerCalls += 1;
        return { ok: true, kind: "binary", bytes: new Uint8Array([1]), contentType: "audio/ogg" };
      },
    };
    const gateway = createAIGateway(env.DB, key, [adapter]);
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "voices/in.ogg" } }), { status: 200 });
      if (url.includes("/file/bot")) return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/ogg" } });
      if (url.includes("/sendVoice")) return new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } }), { status: 429, headers: { "content-type": "application/json" } });
      throw new Error("unexpected");
    };

    const first = await processVoiceJob(
      { operationId: opId, userId, metadata: { fileId: "voice-file", chatId: 123, mimeType: "audio/ogg" } },
      { db: env.DB, gateway, botToken: "bot-test", now: () => "2026-09-28T12:02:00Z", fetchImpl },
    );
    expect(first).toEqual({ ok: false, retryable: true, code: "telegram_voice_delivery_retry" });
    expect(providerCalls).toBe(1);
  });
});
