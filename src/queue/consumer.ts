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

export async function processQueueMessage(
  message: Message<unknown>,
  deps: QueueConsumerDeps,
): Promise<"acked" | "retried"> {
  if (!isQueueJobMessage(message.body)) {
    message.ack();
    return "acked";
  }

  const job = await deps.db
    .prepare("SELECT id, status, attempt FROM queue_jobs WHERE operation_id = ?1")
    .bind(message.body.operationId)
    .first<{ id: string; status: string; attempt: number }>();

  if (!job) {
    message.ack();
    return "acked";
  }

  if (["succeeded", "failed", "dead_lettered"].includes(job.status)) {
    message.ack();
    return "acked";
  }

  await deps.db
    .prepare("UPDATE queue_jobs SET status='processing', attempt=attempt+1, updated_at=?2 WHERE operation_id=?1")
    .bind(message.body.operationId, deps.now())
    .run();

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
    message.retry();
    return "retried";
  }
}

export async function processQueueBatch(
  batch: MessageBatch<unknown>,
  deps: QueueConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    await processQueueMessage(message, deps);
  }
}
