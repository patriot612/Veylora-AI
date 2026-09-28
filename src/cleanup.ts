import { settleReservation } from "./billing/points";
export type CleanupResult = {
  documentSessions: number;
  documentChunks: number;
  subscriptions: number;
  settledDeliveries: number;
  rateLimitBuckets: number;
};

/**
 * Removes short-lived document state, expired rate-limit buckets and
 * subscriptions whose end time has passed. All predicates are server-side.
 */
export async function runScheduledCleanup(db: D1Database, now: string): Promise<CleanupResult> {
  let settledDeliveries = 0;
  const recoverable = await db.prepare(
    "SELECT o.id FROM operations o JOIN point_reservations r ON r.operation_id=o.id WHERE o.status='delivering' AND o.telegram_delivery_status='sent' AND r.status='reserved' ORDER BY o.created_at ASC LIMIT 200",
  ).all<{ id: string }>();
  for (const row of recoverable.results ?? []) {
    if (await settleReservation(db, row.id, now)) settledDeliveries += 1;
  }

  const expiredSessions = await db.prepare("SELECT COUNT(*) AS count FROM document_sessions WHERE expires_at <= ?1").bind(now).first<{ count: number }>();

  await db.prepare("UPDATE users SET active_document_session_id=NULL, updated_at=?1 WHERE active_document_session_id IN (SELECT id FROM document_sessions WHERE expires_at <= ?1)").bind(now).run();

  const deletedChunks = await db.prepare("DELETE FROM document_chunks WHERE session_id IN (SELECT id FROM document_sessions WHERE expires_at <= ?1)").bind(now).run();
  await db.prepare("DELETE FROM document_sessions WHERE expires_at <= ?1").bind(now).run();
  const rateLimitDelete = await db.prepare("DELETE FROM rate_limit_buckets WHERE bucket_start < datetime(?1, '-2 minutes')").bind(now).run();
  const rateLimitBuckets = rateLimitDelete.meta.changes ?? 0;

  const expiredSubscriptions = await db.prepare("UPDATE subscriptions SET status='expired', updated_at=?1 WHERE status='active' AND ends_at <= ?1").bind(now).run();
  return {
    documentSessions: expiredSessions?.count ?? 0,
    documentChunks: deletedChunks.meta.changes ?? 0,
    subscriptions: expiredSubscriptions.meta.changes ?? 0,
    settledDeliveries,
    rateLimitBuckets,
  };
}
