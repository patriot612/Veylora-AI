import { env } from "./test-env";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueHeavyJob } from "../src/queue/producer";
import { processQueueMessage } from "../src/queue/consumer";
import type { QueueJobMessage } from "../src/queue/types";
import { encryptCredentialSecret } from "../src/security/credentials";

function fakeQueue() {
  const sent: QueueJobMessage[] = [];
  return { sent, send: async (message: QueueJobMessage) => { sent.push(message); } } as unknown as Queue;
}

function fakeMessage(body: unknown) {
  return {
    body,
    acked: false,
    retried: false,
    ack() { this.acked = true; },
    retry() { this.retried = true; },
  } as unknown as Message<unknown> & { acked: boolean; retried: boolean };
}

let telegramId = 980000000;
let sequence = 0;
const encryptionKey = "queue-test-key";

async function seedHeavyUser(dailyPoints: number, cost: number) {
  const userId = crypto.randomUUID();
  const providerId = "queue_provider_" + (++sequence);
  const credentialId = "queue_credential_" + sequence;
  const modelId = "queue_model_" + sequence;
  await env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,active_mode,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,0,'chat','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(userId, ++telegramId, dailyPoints).run();
  await env.DB.prepare("INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'queue_test','https://queue.test',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(providerId, "Queue Provider " + sequence).run();
  await env.DB.prepare("INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Queue',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(credentialId, providerId, await encryptCredentialSecret("secret", encryptionKey)).run();
  await env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'queue-test','Queue Test','image',?4,0,8000,1000,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(modelId, providerId, credentialId, cost).run();
  return { userId, modelId };
}

describe("heavy queue consumer", () => {
  beforeEach(() => { sequence += 1; });

  it("reserves and enqueues only a small reference payload", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z", metadata: { mediaRef: "r2:key" } });
    expect(queue.sent).toHaveLength(1);
    expect(JSON.stringify(queue.sent[0])).toContain("r2:key");
    expect(JSON.stringify(queue.sent[0])).not.toContain("base64");
  });

  it("does not enqueue a duplicate operation or reserve points twice", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:01:00Z" });
    expect(queue.sent).toHaveLength(1);
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(user?.daily_points_remaining).toBe(40);
  });

  it("processes success exactly once and captures reservation", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });
    let calls = 0;
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: async () => { calls += 1; return { ok: true }; }, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) } });
    expect(result).toBe("acked");
    expect(calls).toBe(1);
  });

  it("settles after Telegram delivery without invoking the external handler again", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,telegram_delivery_status,created_at) VALUES (?1,?2,'image','delivering',?3,10,'sent','2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO queue_jobs (id,operation_id,queue_type,status,attempt,created_at,updated_at) VALUES (?1,?2,'image','pending',0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId).run();
    let handlerCalls = 0;
    const message = fakeMessage({ version: 1, operationId, userId, jobType: "image", enqueuedAt: "2026-09-28T12:00:00Z" });
    const result = await processQueueMessage(message, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: async () => { handlerCalls += 1; return { ok: true }; }, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(result).toBe("acked");
    expect(handlerCalls).toBe(0);
    expect(user?.daily_points_remaining).toBe(50);
    expect(op?.status).toBe("succeeded");
    expect(job?.status).toBe("succeeded");
  });

  it("retries transient failures without releasing reserved points", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: async () => { throw new Error("provider_timeout"); }, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(result).toBe("retried");
    expect(user?.daily_points_remaining).toBe(40);
  });

  it("terminally fails malformed or exhausted jobs through the DLQ handler and releases points", async () => {
    const { userId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,points_cost,created_at) VALUES (?1,?2,'image','created',10,'2026-09-28T12:00:00Z')").bind(operationId, userId).run();
    await env.DB.prepare("INSERT INTO reservations (id,operation_id,user_id,points,kind,status,created_at,updated_at) VALUES (?1,?2,?3,10,'daily','reserved','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId, userId).run();
    await env.DB.prepare("UPDATE users SET daily_points_remaining=40 WHERE id=?1").bind(userId).run();
    const { handleQueueDeadLetter } = await import("../src/queue/dlq");
    await handleQueueDeadLetter({ operationId, userId, reason: "exhausted" }, env.DB, "2026-09-28T12:05:00Z");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(user?.daily_points_remaining).toBe(50);
  });
});
