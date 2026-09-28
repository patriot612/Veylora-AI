import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { encryptCredentialSecret } from "../src/security/credentials";
import { createAIGateway } from "../src/ai-gateway";
import { handleChatMessage } from "../src/chat/service";

const key = "chat-test-key";
let tgId = 920000000;
let modelSeq = 0;

async function seedUser(modelCost = 4, points = 50) {
  const userId = crypto.randomUUID();
  const providerId = "chat_provider_" + (++modelSeq);
  const credentialId = "chat_credential_" + modelSeq;
  const modelId = "chat_model_" + modelSeq;
  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at,active_chat_model_id) VALUES (?1,?2,'2026-09-28',?3,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z',?4)",
  ).bind(userId, ++tgId, points, modelId).run();
  await env.DB.prepare(
    "INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'test','https://provider.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(providerId, "Chat Provider " + modelSeq).run();
  const encrypted = await encryptCredentialSecret("secret", key);
  await env.DB.prepare(
    "INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Chat',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(credentialId, providerId, encrypted).run();
  await env.DB.prepare(
    "INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'chat-model','Chat Test','chat',?4,0,8000,1000,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(modelId, providerId, credentialId, modelCost).run();
  return { userId, modelId };
}

function harness() {
  let sent: string[] = [];
  let edited: string[] = [];
  let editsShouldFail = false;
  return {
    send: async (text: string) => {
      sent.push(text);
      return { message_id: 100 + sent.length };
    },
    edit: async (_messageId: number, text: string) => {
      if (editsShouldFail) throw new Error("telegram_edit_failed");
      edited.push(text);
      return { ok: true };
    },
    sent,
    edited,
    setEditFailure: () => { editsShouldFail = true; },
  };
}

describe("Chat service", () => {
  it("successfully executes, captures points, stores the turn and clears the lock", async () => {
    const { userId, modelId } = await seedUser(4, 50);
    const h = harness();
    let calls = 0;
    const gateway = {
      generateText: async () => {
        calls += 1;
        return { text: "Ответ модели", modelId };
      },
    } as unknown as ReturnType<typeof createAIGateway>;

    const result = await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text: "Привет",
      telegramUpdateId: 10001,
      chatId: 123,
      messageId: 1,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
      send: h.send,
      edit: h.edit,
    });

    expect(result.kind).toBe("answered");
    expect(calls).toBe(1);
    expect(h.sent).toEqual(["✋ Формулирую ответ..."]);
    expect(h.edited).toEqual(["Ответ модели"]);

    const user = await env.DB.prepare("SELECT daily_points_remaining, active_operation_id, active_conversation_id FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number; active_operation_id:string|null; active_conversation_id:string|null}>();
    const op = await env.DB.prepare("SELECT status, points_cost FROM operations WHERE id=?1").bind((result as any).operationId).first<{status:string;points_cost:number}>();
    const turns = await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE conversation_id=?1").bind((result as any).conversationId).first<{count:number}>();

    expect(user?.daily_points_remaining).toBe(46);
    expect(user?.active_operation_id).toBeNull();
    expect(user?.active_conversation_id).toBe((result as any).conversationId);
    expect(op?.status).toBe("succeeded");
    expect(op?.points_cost).toBe(4);
    expect(turns?.count).toBe(1);
  });

  it("releases reservation on provider failure and does not keep a turn", async () => {
    const { userId, modelId } = await seedUser(7, 50);
    const h = harness();
    const gateway = {
      generateText: async () => {
        throw new Error("provider_failed");
      },
    } as unknown as ReturnType<typeof createAIGateway>;

    const result = await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text: "Ошибка",
      telegramUpdateId: 10002,
      chatId: 123,
      messageId: 2,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
      send: h.send,
      edit: h.edit,
    });

    expect(result.kind).toBe("failed");
    const user = await env.DB.prepare("SELECT daily_points_remaining, active_operation_id FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number; active_operation_id:string|null}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind((result as any).operationId).first<{status:string}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind((result as any).operationId).first<{status:string}>();

    expect(user?.daily_points_remaining).toBe(50);
    expect(user?.active_operation_id).toBeNull();
    expect(op?.status).toBe("failed");
    expect(reservation?.status).toBe("released");
    expect(h.sent[0]).toBe("✋ Формулирую ответ...");
  });

  it("blocks insufficient points before calling the gateway", async () => {
    const { userId, modelId } = await seedUser(60, 50);
    const h = harness();
    let calls = 0;
    const gateway = {
      generateText: async () => {
        calls += 1;
        return { text: "unexpected", modelId };
      },
    } as unknown as ReturnType<typeof createAIGateway>;

    const result = await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text: "Слишком дорого",
      telegramUpdateId: 10003,
      chatId: 123,
      messageId: 3,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
      send: h.send,
      edit: h.edit,
    });

    expect(result.kind).toBe("insufficient_points");
    expect(calls).toBe(0);
    expect(h.sent[0]).toContain("У вас закончились баллы");
  });

  it("rejects a second request while the user has an active operation", async () => {
    const { userId } = await seedUser(4, 50);
    await env.DB.prepare("UPDATE users SET active_operation_id='already-busy' WHERE id=?1").bind(userId).run();
    const h = harness();
    let calls = 0;
    const gateway = {
      generateText: async () => {
        calls += 1;
        return { text: "unexpected", modelId };
      },
    } as unknown as ReturnType<typeof createAIGateway>;

    const result = await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text: "Busy",
      telegramUpdateId: 10004,
      chatId: 123,
      messageId: 4,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
      send: h.send,
      edit: h.edit,
    });

    expect(result.kind).toBe("busy");
    expect(calls).toBe(0);
    expect(h.sent[0]).toContain("Предыдущий запрос");
  });

  it("releases billing when Telegram delivery fails after the AI response", async () => {
    const { userId, modelId } = await seedUser(5, 50);
    const h = harness();
    h.setEditFailure();
    const gateway = {
      generateText: async () => ({ text: "Ответ", modelId }),
    } as unknown as ReturnType<typeof createAIGateway>;

    const result = await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text: "Доставка",
      telegramUpdateId: 10005,
      chatId: 123,
      messageId: 5,
      now: "2026-09-28T12:00:00Z",
      credentialEncryptionKey: key,
      send: h.send,
      edit: h.edit,
    });

    expect(result.kind).toBe("failed");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind((result as any).operationId).first<{status:string}>();
    expect(user?.daily_points_remaining).toBe(50);
    expect(reservation?.status).toBe("released");
  });
});
