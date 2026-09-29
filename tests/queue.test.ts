import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { enqueueHeavyJob } from "../src/queue/producer";
import { processQueueMessage } from "../src/queue/consumer";
import { processDeadLetterBatch } from "../src/queue/dead-letter";
import type { QueueJobMessage } from "../src/queue/types";
import { encryptCredentialSecret } from "../src/security/credentials";

let telegramId = 980000000;
let sequence = 0;
const encryptionKey = "queue-test-key";

async function seedHeavyUser(dailyPoints = 50, cost = 10) {
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

function fakeQueue() {
  const sent: QueueJobMessage[] = [];
  const queue = { send: async (body: QueueJobMessage) => { sent.push(body); }, sent } as unknown as Queue & { sent: QueueJobMessage[] };
  return queue;
}

function fakeMessage(body: unknown) {
  let acked = false;
  let retried = false;
  let retryOptions: unknown;
  return {
    body,
    ack: () => { acked = true; },
    retry: (options?: unknown) => { retried = true; retryOptions = options; },
    get acked() { return acked; },
    get retried() { return retried; },
    get retryOptions() { return retryOptions; },
  } as unknown as Message<unknown> & { readonly acked: boolean; readonly retried: boolean; readonly retryOptions: unknown };
}

describe("heavy queue producer", () => {
  it("reserves and enqueues only a small reference payload", async () => {
    const { userId, modelId } = await seedHeavyUser();
    const queue = fakeQueue();
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z", metadata: { mediaRef: "telegram-file-id:test" } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("queued");
    expect(job?.status).toBe("pending");
    expect(queue.sent).toHaveLength(1);
    expect(JSON.stringify(queue.sent[0])).toContain(operationId);
    expect(JSON.stringify(queue.sent[0])).not.toContain("base64");
  });

  it("does not enqueue a duplicate operation or reserve points twice", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 7);
    const queue = fakeQueue();
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,7,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 7, now: "2026-09-28T12:00:00Z" });
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 7, now: "2026-09-28T12:01:00Z" });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(user?.daily_points_remaining).toBe(43);
    expect(queue.sent).toHaveLength(1);
  });

  it("marks enqueue operations failed when points cannot be reserved", async () => {
    const { userId, modelId } = await seedHeavyUser(5, 10);
    const queue = fakeQueue();
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await expect(enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" })).rejects.toThrow("insufficient_points");
    const operation = await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?1").bind(operationId).first<{status:string;error_code:string|null}>();
    expect(operation?.status).toBe("failed");
    expect(operation?.error_code).toBe("insufficient_points");
    expect(queue.sent).toHaveLength(0);
  });

  it("claims concurrent enqueue ownership exactly once", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 14);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,14,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const enqueue = () => enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 14, now: "2026-09-28T12:00:00Z" });
    await Promise.all([enqueue(), enqueue()]);
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const operation = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(user?.daily_points_remaining).toBe(36);
    expect(operation?.status).toBe("queued");
    expect(job?.status).toBe("pending");
    expect(queue.sent).toHaveLength(1);
  });
});

describe("heavy queue consumer", () => {
  it("processes success exactly once and captures reservation", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });
    let calls = 0;
    const first = fakeMessage(queue.sent[0]);
    const handler = async () => { calls += 1; return { ok: true } as const; };
    const result = await processQueueMessage(first, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: handler, voice: async () => ({ ok: true } as const), document: async () => ({ ok: true } as const) } });
    const second = fakeMessage(queue.sent[0]);
    await processQueueMessage(second, { db: env.DB, now: () => "2026-09-28T12:02:00Z", handlers: { image: handler, voice: async () => ({ ok: true } as const), document: async () => ({ ok: true } as const) } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(result).toBe("acked");
    expect(first.acked).toBe(true);
    expect(second.acked).toBe(true);
    expect(calls).toBe(1);
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("succeeded");
    expect(job?.status).toBe("succeeded");
  });

  it("prevents concurrent duplicate deliveries from invoking the external handler twice", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 11);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,11,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 11, now: "2026-09-28T12:00:00Z" });
    let handlerCalls = 0;
    let releaseHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handler = async () => { handlerCalls += 1; await handlerStarted; return { ok: true } as const; };
    const deps = { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: handler, voice: async () => ({ ok: true } as const), document: async () => ({ ok: true } as const) } };
    const first = processQueueMessage(fakeMessage(queue.sent[0]), deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondMessage = fakeMessage(queue.sent[0]);
    const second = await processQueueMessage(secondMessage, deps);
    expect(second).toBe("retried");
    expect(secondMessage.retried).toBe(true);
    expect(handlerCalls).toBe(1);
    releaseHandler();
    expect(await first).toBe("acked");
    expect(handlerCalls).toBe(1);
  });

  it("reclaims a stale processing lease after a worker crash", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 12);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,12,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 12, now: "2026-09-28T12:00:00Z" });
    await env.DB.prepare("UPDATE queue_jobs SET status='processing', attempt=1, updated_at='2026-09-28T12:00:00Z' WHERE operation_id=?1").bind(operationId).run();
    let handlerCalls = 0;
    const result = await processQueueMessage(fakeMessage(queue.sent[0]), { db: env.DB, now: () => "2026-09-28T12:11:00Z", handlers: { image: async () => { handlerCalls += 1; return { ok: true }; }, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) } });
    const job = await env.DB.prepare("SELECT status, attempt FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string;attempt:number}>();
    expect(result).toBe("acked");
    expect(handlerCalls).toBe(1);
    expect(job?.status).toBe("succeeded");
    expect(job?.attempt).toBe(2);
  });

  it("settles after Telegram delivery without invoking the external handler again", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });
    await env.DB.prepare("UPDATE operations SET status='delivering', telegram_delivery_status='sent', temporary_result_ref='https://cdn.example.com/image.png' WHERE id=?1 AND user_id=?2").bind(operationId, userId).run();
    let handlerCalls = 0;
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: async () => { handlerCalls += 1; return { ok: true }; }, voice: async () => ({ ok: true } as const), document: async () => ({ ok: true } as const) } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status,temporary_result_ref FROM operations WHERE id=?1").bind(operationId).first<{status:string;temporary_result_ref:string|null}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(result).toBe("acked");
    expect(message.acked).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("succeeded");
    expect(op?.temporary_result_ref).toBeNull();
    expect(reservation?.status).toBe("captured");
    expect(job?.status).toBe("succeeded");
  });

  it("honors retry_after when a heavy handler requests a Telegram delivery retry", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 5);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,5,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 5, now: "2026-09-28T12:00:00Z" });
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, {
      db: env.DB,
      now: () => "2026-09-28T12:01:00Z",
      handlers: {
        image: async () => ({ ok: false, retryable: true, code: "telegram_delivery_retry", retryAfterSeconds: 7 }),
        voice: async () => ({ ok: true } as const),
        document: async () => ({ ok: true } as const),
      },
    });
    expect(result).toBe("retried");
    expect(message.retried).toBe(true);
    expect(message.retryOptions).toEqual({ delaySeconds: 7 });
  });

  it("retries transient failures without releasing reserved points", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 9);
    const operationId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,9,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 9, now: "2026-09-28T12:00:00Z" });
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, { db: env.DB, now: () => "2026-09-28T12:01:00Z", handlers: { image: async () => ({ ok: false, retryable: true, code: "provider_503" }), voice: async () => ({ ok: true } as const), document: async () => ({ ok: true } as const) } });
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(result).toBe("retried");
    expect(message.retried).toBe(true);
    expect(user?.daily_points_remaining).toBe(41);
  });

  it("captures a delivered job instead of releasing points when it reaches DLQ", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 13);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,13,'2026-09-28T12:00:00Z')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 13, now: "2026-09-28T12:00:00Z" });
    await env.DB.prepare("UPDATE operations SET status='delivering', telegram_delivery_status='sent' WHERE id=?1 AND user_id=?2").bind(operationId, userId).run();
    const message = fakeMessage(queue.sent[0]);
    const batch = { queue: "veylora-ai-jobs-dlq", messages: [message] } as unknown as MessageBatch<unknown>;
    await processDeadLetterBatch(batch, env.DB, () => "2026-09-28T12:02:00Z");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const operation = await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?1").bind(operationId).first<{status:string;error_code:string|null}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(user?.daily_points_remaining).toBe(37);
    expect(operation?.status).toBe("succeeded");
    expect(operation?.error_code).toBeNull();
    expect(reservation?.status).toBe("captured");
    expect(message.acked).toBe(true);
  });

  it("cleans up failed document upload sessions before dead-letter release", async () => {
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,active_mode,active_document_session_id,created_at,updated_at) VALUES (?1,?2,'2026-09-28',48,'documents',?3,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(userId, 981000001, sessionId),
      env.DB.prepare("INSERT INTO operations (id,user_id,type,status,points_cost,telegram_delivery_status,temporary_result_ref,created_at) VALUES (?1,?2,'document','queued',2,'pending',?3,'2026-09-28T12:00:00Z')").bind(operationId, userId, sessionId),
      env.DB.prepare("INSERT INTO point_reservations (id,operation_id,daily_amount,bonus_amount,daily_billing_day,status,created_at) VALUES (?1,?2,2,0,'2026-09-28','reserved','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId),
      env.DB.prepare("INSERT INTO queue_jobs (id,operation_id,queue_type,status,attempt,created_at,updated_at) VALUES (?1,?2,'document','processing',3,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId),
      env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',20,'2026-09-29T12:00:00Z','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')").bind(sessionId, userId),
      env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,'temporary document','2026-09-29T12:00:00Z')").bind(crypto.randomUUID(), sessionId),
    ]);
    const message = fakeMessage({ version: 1, operationId, userId, jobType: "document", enqueuedAt: "2026-09-28T12:00:00Z" });
    const batch = { queue: "veylora-ai-jobs-dlq", messages: [message] } as unknown as MessageBatch<unknown>;

    await processDeadLetterBatch(batch, env.DB, () => "2026-09-28T12:03:00Z");

    const user = await env.DB.prepare("SELECT daily_points_remaining,active_document_session_id,active_mode FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number;active_document_session_id:string|null;active_mode:string}>();
    const session = await env.DB.prepare("SELECT id FROM document_sessions WHERE id=?1").bind(sessionId).first<{id:string}>();
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE session_id=?1").bind(sessionId).first<{count:number}>();
    const operation = await env.DB.prepare("SELECT status,error_code,temporary_result_ref FROM operations WHERE id=?1").bind(operationId).first<{status:string;error_code:string|null;temporary_result_ref:string|null}>();

    expect(user?.daily_points_remaining).toBe(50);
    expect(user?.active_document_session_id).toBeNull();
    expect(user?.active_mode).toBe("chat");
    expect(session).toBeNull();
    expect(chunks?.count).toBe(0);
    expect(operation?.status).toBe("failed");
    expect(operation?.error_code).toBe("queue_dead_lettered");
    expect(operation?.temporary_result_ref).toBeNull();
    expect(message.acked).toBe(true);
  });

  it("terminally fails dead-lettered jobs and releases points", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 8);
    const operationId = crypto.randomUUID();
    const queue = fakeQueue();
    await env.DB.prepare("INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at,temporary_result_ref) VALUES (?1,?2,'image','created',?3,8,'2026-09-28T12:00:00Z','https://cdn.example.com/failed.png')").bind(operationId, userId, modelId).run();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 8, now: "2026-09-28T12:00:00Z" });
    const batch = { queue: "veylora-ai-jobs-dlq", messages: [fakeMessage(queue.sent[0])] } as unknown as MessageBatch<unknown>;
    await processDeadLetterBatch(batch, env.DB, () => "2026-09-28T12:02:00Z");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status,error_code,temporary_result_ref FROM operations WHERE id=?1").bind(operationId).first<{status:string;error_code:string|null;temporary_result_ref:string|null}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    expect(user?.daily_points_remaining).toBe(50);
    expect(op?.status).toBe("failed");
    expect(op?.error_code).toBe("queue_dead_lettered");
    expect(op?.temporary_result_ref).toBeNull();
    expect(job?.status).toBe("dead_lettered");
  });
});
