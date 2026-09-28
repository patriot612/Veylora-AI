import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { encryptCredentialSecret } from "../src/security/credentials";
import { enqueueHeavyJob } from "../src/queue/producer";
import { processQueueMessage } from "../src/queue/consumer";
import { processDeadLetterBatch } from "../src/queue/dead-letter";

let tgId = 940000000;
let seq = 0;

async function seedHeavyUser(points = 50, cost = 10) {
  const userId = crypto.randomUUID();
  const providerId = "queue_provider_" + (++seq);
  const credentialId = "queue_credential_" + seq;
  const modelId = "queue_model_" + seq;

  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, ++tgId, points).run();
  await env.DB.prepare(
    "INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'test','https://provider.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(providerId, "Queue Provider " + seq).run();
  await env.DB.prepare(
    "INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Queue',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(credentialId, providerId, await encryptCredentialSecret("secret", "queue-key")).run();
  await env.DB.prepare(
    "INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'queue-model','Queue Test','image',?4,0,NULL,NULL,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(modelId, providerId, credentialId, cost).run();
  return { userId, modelId };
}

function fakeQueue() {
  const sent: unknown[] = [];
  return {
    send: async (body: unknown) => { sent.push(body); },
    sent,
  } as unknown as Queue & { sent: unknown[] };
}

function fakeMessage(body: unknown) {
  let acked = false;
  let retried = false;
  return {
    body,
    ack: () => { acked = true; },
    retry: () => { retried = true; },
    get acked() { return acked; },
    get retried() { return retried; },
  } as unknown as Message<unknown> & { readonly acked: boolean; readonly retried: boolean };
}

describe("heavy queue producer", () => {
  it("reserves and enqueues only a small reference payload", async () => {
    const { userId, modelId } = await seedHeavyUser();
    const queue = fakeQueue();
    const operationId = crypto.randomUUID();

    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();

    await enqueueHeavyJob({
      db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10,
      now: "2026-09-28T12:00:00Z", metadata: { templateId: "template-1" },
    });

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

    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,7,'2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();

    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 7, now: "2026-09-28T12:00:00Z" });
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 7, now: "2026-09-28T12:00:01Z" });

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(user?.daily_points_remaining).toBe(43);
    expect(queue.sent).toHaveLength(1);
  });
});

describe("heavy queue consumer", () => {
  it("processes success exactly once and captures reservation", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,10,'2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });

    const first = fakeMessage(queue.sent[0]);
    const handler = async () => ({ ok: true } as const);
    const result = await processQueueMessage(first, {
      db: env.DB, now: () => "2026-09-28T12:01:00Z",
      handlers: { image: handler, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) },
    });
    const second = fakeMessage(queue.sent[0]);
    await processQueueMessage(second, {
      db: env.DB, now: () => "2026-09-28T12:02:00Z",
      handlers: { image: handler, voice: async () => ({ ok: true }), document: async () => ({ ok: true }) },
    });

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();

    expect(result).toBe("acked");
    expect(first.acked).toBe(true);
    expect(second.acked).toBe(true);
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("succeeded");
    expect(job?.status).toBe("succeeded");
  });

  it("settles after Telegram delivery without invoking the external handler again", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 10);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,telegram_delivery_status,created_at) VALUES (?1,?2,'image','delivering',?3,10,'sent','2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 10, now: "2026-09-28T12:00:00Z" });

    let handlerCalls = 0;
    const message = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(message, {
      db: env.DB,
      now: () => "2026-09-28T12:01:00Z",
      handlers: {
        image: async () => { handlerCalls += 1; return { ok: true }; },
        voice: async () => ({ ok: true }),
        document: async () => ({ ok: true }),
      },
    });

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();

    expect(result).toBe("acked");
    expect(handlerCalls).toBe(0);
    expect(user?.daily_points_remaining).toBe(40);
    expect(op?.status).toBe("succeeded");
    expect(job?.status).toBe("succeeded");
  });

  it("retries transient failures without releasing reserved points", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 9);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,9,'2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 9, now: "2026-09-28T12:00:00Z" });

    const msg = fakeMessage(queue.sent[0]);
    const result = await processQueueMessage(msg, {
      db: env.DB, now: () => "2026-09-28T12:01:00Z",
      handlers: { image: async () => ({ ok: false, retryable: true, code: "provider_503" }), voice: async () => ({ ok: true }), document: async () => ({ ok: true }) },
    });

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const job = await env.DB.prepare("SELECT status, attempt FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string;attempt:number}>();

    expect(result).toBe("retried");
    expect(msg.retried).toBe(true);
    expect(user?.daily_points_remaining).toBe(41);
    expect(job?.status).toBe("processing");
    expect(job?.attempt).toBe(1);
  });

  it("terminally fails malformed or exhausted jobs through the DLQ handler and releases points", async () => {
    const { userId, modelId } = await seedHeavyUser(50, 8);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO operations (id,user_id,type,status,model_id,points_cost,created_at) VALUES (?1,?2,'image','created',?3,8,'2026-09-28T12:00:00Z')",
    ).bind(operationId, userId, modelId).run();
    const queue = fakeQueue();
    await enqueueHeavyJob({ db: env.DB, queue, operationId, userId, jobType: "image", pointsCost: 8, now: "2026-09-28T12:00:00Z" });

    const batch = { queue: "veylora-ai-jobs-dlq", messages: [fakeMessage(queue.sent[0])] } as unknown as MessageBatch<unknown>;
    await processDeadLetterBatch(batch, env.DB, () => "2026-09-28T12:02:00Z");

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const op = await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?1").bind(operationId).first<{status:string;error_code:string|null}>();
    const job = await env.DB.prepare("SELECT status FROM queue_jobs WHERE operation_id=?1").bind(operationId).first<{status:string}>();

    expect(user?.daily_points_remaining).toBe(50);
    expect(op?.status).toBe("failed");
    expect(op?.error_code).toBe("queue_dead_lettered");
    expect(job?.status).toBe("dead_lettered");
  });
});
