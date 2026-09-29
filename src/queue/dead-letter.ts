import { releaseReservation, settleReservation } from "../billing/points";
import { cleanupDocumentUploadSession } from "../documents/service";
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
    const operation = await db
      .prepare("SELECT status, type, model_id, temporary_result_ref, telegram_delivery_status FROM operations WHERE id = ?1 AND user_id = ?2")
      .bind(message.body.operationId, message.body.userId)
      .first<{ status: string; type: string; model_id: string | null; temporary_result_ref: string | null; telegram_delivery_status: string }>();

    if (job?.status === "succeeded" || job?.status === "failed" || job?.status === "dead_lettered") {
      message.ack();
      continue;
    }

    if (operation?.status === "delivering" && operation.telegram_delivery_status === "sent") {
      await settleReservation(db, message.body.operationId, now());
    } else {
      if (operation?.type === "document" && operation.model_id === null && operation.temporary_result_ref) {
        await cleanupDocumentUploadSession(db, message.body.userId, operation.temporary_result_ref);
      }
      await releaseReservation(db, message.body.operationId, now(), "failed", "queue_dead_lettered");
    }
    await db
      .prepare("UPDATE queue_jobs SET status='dead_lettered', updated_at=?2 WHERE operation_id=?1")
      .bind(message.body.operationId, now())
      .run();
    message.ack();
  }
}

export type { QueueJobMessage };
