import { releaseReservation } from "../billing/points";
import type { QueueJobMessage } from "./types";
import { isQueueJobMessage } from "./types";

export async function processDeadLetterBatch(
  batch: MessageBatch<unknown>,
  db: D1Database,
  now: () => string,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isQueueJobMessage(message.body)) {
      message.ack();
      continue;
    }

    const job = await db
      .prepare("SELECT status FROM queue_jobs WHERE operation_id = ?1")
      .bind(message.body.operationId)
      .first<{ status: string }>();

    if (job?.status === "succeeded" || job?.status === "failed" || job?.status === "dead_lettered") {
      message.ack();
      continue;
    }

    await releaseReservation(db, message.body.operationId, now(), "failed", "queue_dead_lettered");
    await db
      .prepare("UPDATE queue_jobs SET status='dead_lettered', updated_at=?2 WHERE operation_id=?1")
      .bind(message.body.operationId, now())
      .run();
    message.ack();
  }
}

export type { QueueJobMessage };
