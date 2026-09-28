import type { HeavyJobType, QueueJobMessage } from "./types";
import { releaseReservation, reservePoints } from "../billing/points";

export type EnqueueHeavyJobInput = {
  db: D1Database;
  queue: Queue;
  operationId: string;
  userId: string;
  jobType: HeavyJobType;
  pointsCost: number;
  now: string;
  metadata?: Record<string, unknown>;
};

export async function enqueueHeavyJob(input: EnqueueHeavyJobInput): Promise<void> {
  const operation = await input.db
    .prepare("SELECT status, user_id, points_cost FROM operations WHERE id = ?1 AND user_id = ?2")
    .bind(input.operationId, input.userId)
    .first<{ status: string; user_id: string; points_cost: number }>();

  if (!operation) throw new Error("operation_not_found");
  if (operation.status === "queued" || operation.status === "processing") return;
  if (operation.status !== "created") throw new Error("operation_not_enqueueable");

  const reservation = await reservePoints(
    input.db,
    input.userId,
    input.operationId,
    input.pointsCost,
    input.now,
  );
  if (!reservation.ok) throw new Error(reservation.reason);

  const message: QueueJobMessage = {
    version: 1,
    operationId: input.operationId,
    userId: input.userId,
    jobType: input.jobType,
    metadata: input.metadata,
    enqueuedAt: input.now,
  };

  try {
    await input.db.batch([
      input.db
        .prepare(
          "INSERT INTO queue_jobs (id,operation_id,queue_type,status,attempt,created_at,updated_at) VALUES (?1,?2,?3,'pending',0,?4,?4)",
        )
        .bind(crypto.randomUUID(), input.operationId, input.jobType, input.now),
      input.db
        .prepare(
          "UPDATE operations SET status='queued', telegram_delivery_status='pending' WHERE id=?1 AND user_id=?2 AND status='reserved'",
        )
        .bind(input.operationId, input.userId),
    ]);
    await input.queue.send(message);
  } catch (error) {
    await input.db
      .prepare("DELETE FROM queue_jobs WHERE operation_id = ?1")
      .bind(input.operationId)
      .run()
      .catch(() => undefined);
    await releaseReservation(input.db, input.operationId, input.now);
    throw error;
  }
}
