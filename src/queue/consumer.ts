import { releaseReservation, settleReservation } from "../billing/points";
import { transitionOperation } from "../operations/service";
import type { QueueJobMessage } from "./types";
import { isQueueJobMessage } from "./types";

export type HeavyJobHandler = (
  message: QueueJobMessage,
) => Promise<{ ok: true; terminal?: boolean } | { ok: false; retryable: boolean; code: string }>;

export type QueueConsumerDeps = {
  db: D1Database;
  now: () => string;
  handlers: Record<QueueJobMessage["jobType"], HeavyJobHandler>;
};

const PROCESSING_LEASE_MS = 10 * 60 * 1000;

export async function processQueueMessage(
  message: Message<unknown>,
  deps: QueueConsumerDeps,
): Promise<"acked" | "retried"> {
  if (!isQueueJobMessage(message.body)) {
    message.ack();
    return "acked";
  }

  const now = deps.now();
  const claim = await claimQueueJob(deps.db, message.body.operationId, now);
  if (claim === "missing" || claim === "terminal") {
    message.ack();
    return "acked";
  }
  if (claim === "busy") {
    message.retry();
    return "retried";
  }

  const operation = await deps.db
    .prepare("SELECT status, user_id, telegram_delivery_status FROM operations WHERE id=?1 AND user_id=?2")
    .bind(message.body.operationId, message.body.userId)
    .first<{ status: string; user_id: string; telegram_delivery_status: string | null }>();

  if (!operation || ["succeeded", "failed", "timeout", "cancelled"].includes(operation.status)) {
    await deps.db
      .prepare("UPDATE queue_jobs SET status='succeeded', updated_at=?2 WHERE operation_id=?1")
      .bind(message.body.operationId, deps.now())
      .run();
    message.ack();
    return "acked";
  }

  // A provider/media handler may have completed Telegram delivery and then lost
  // the process before the reservation settlement. Never invoke the external
  // handler again in that state: settle the existing operation idempotently.
  if (operation.telegram_delivery_status === "sent") {
    const settled = await settleReservation(deps.db, message.body.operationId, deps.now());
    if (!settled) {
      await touchQueueJob(deps.db, message.body.operationId, deps.now());
      message.retry();
      return "retried";
    }
    await deps.db
      .prepare("UPDATE queue_jobs SET status='succeeded', updated_at=?2 WHERE operation_id=?1")
      .bind(message.body.operationId, deps.now())
      .run();
    message.ack();
    return "acked";
  }

  if (operation.status === "queued") {
    await transitionOperation(deps.db, {
      operationId: message.body.operationId,
      userId: message.body.userId,
      to: "processing",
      now: deps.now(),
    });
  }

  try {
    const result = await deps.handlers[message.body.jobType](message.body);

    if (!result.ok) {
      if (result.retryable) {
        await touchQueueJob(deps.db, message.body.operationId, deps.now());
        message.retry();
        return "retried";
      }
      await releaseReservation(deps.db, message.body.operationId, deps.now(), "failed", result.code);
      await deps.db
        .prepare("UPDATE queue_jobs SET status='failed', updated_at=?2 WHERE operation_id=?1")
        .bind(message.body.operationId, deps.now())
        .run();
      message.ack();
      return "acked";
    }

    const settled = await settleReservation(deps.db, message.body.operationId, deps.now());
    if (!settled) {
      message.retry();
      return "retried";
    }

    await deps.db
      .prepare("UPDATE queue_jobs SET status='succeeded', updated_at=?2 WHERE operation_id=?1")
      .bind(message.body.operationId, deps.now())
      .run();
    message.ack();
    return "acked";
  } catch {
    await touchQueueJob(deps.db, message.body.operationId, deps.now());
    message.retry();
    return "retried";
  }
}

async function claimQueueJob(
  db: D1Database,
  operationId: string,
  now: string,
): Promise<"claimed" | "busy" | "terminal" | "missing"> {
  const job = await db
    .prepare("SELECT status, updated_at FROM queue_jobs WHERE operation_id = ?1")
    .bind(operationId)
    .first<{ status: string; updated_at: string }>();

  if (!job) return "missing";
  if (["succeeded", "failed", "dead_lettered"].includes(job.status)) return "terminal";

  if (job.status === "processing") {
    const nowMs = Date.parse(now);
    const updatedMs = Date.parse(job.updated_at);
    const leaseFresh =
      Number.isFinite(nowMs) &&
      Number.isFinite(updatedMs) &&
      nowMs - updatedMs < PROCESSING_LEASE_MS;
    if (leaseFresh) return "busy";

    const reclaimed = await db
      .prepare(
        "UPDATE queue_jobs SET status='processing', attempt=attempt+1, updated_at=?2 WHERE operation_id=?1 AND status='processing' AND updated_at=?3",
      )
      .bind(operationId, now, job.updated_at)
      .run();
    return (reclaimed.meta.changes ?? 0) === 1 ? "claimed" : claimQueueJob(db, operationId, now);
  }

  const claimed = await db
    .prepare(
      "UPDATE queue_jobs SET status='processing', attempt=attempt+1, updated_at=?2 WHERE operation_id=?1 AND status='pending'",
    )
    .bind(operationId, now)
    .run();
  if ((claimed.meta.changes ?? 0) === 1) return "claimed";

  const latest = await db
    .prepare("SELECT status FROM queue_jobs WHERE operation_id = ?1")
    .bind(operationId)
    .first<{ status: string }>();
  if (!latest || ["succeeded", "failed", "dead_lettered"].includes(latest.status)) return "terminal";
  return "busy";
}

async function touchQueueJob(db: D1Database, operationId: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE queue_jobs SET updated_at=?2 WHERE operation_id=?1 AND status='processing'")
    .bind(operationId, now)
    .run();
}

export async function processQueueBatch(
  batch: MessageBatch<unknown>,
  deps: QueueConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    await processQueueMessage(message, deps);
  }
}
