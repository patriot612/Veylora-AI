export type CleanupResult = {
  documentSessions: number;
  documentChunks: number;
  subscriptions: number;
};

/**
 * Removes short-lived document state and normalizes subscriptions whose end
 * time has passed. All predicates are server-side and scoped to lifecycle
 * timestamps; no client-provided identity is involved.
 */
export async function runScheduledCleanup(db: D1Database, now: string): Promise<CleanupResult> {
  const expiredSessions = await db
    .prepare("SELECT COUNT(*) AS count FROM document_sessions WHERE expires_at <= ?1")
    .bind(now)
    .first<{ count: number }>();

  await db
    .prepare("UPDATE users SET active_document_session_id=NULL, updated_at=?1 WHERE active_document_session_id IN (SELECT id FROM document_sessions WHERE expires_at <= ?1)")
    .bind(now)
    .run();

  const deletedChunks = await db
    .prepare("DELETE FROM document_chunks WHERE session_id IN (SELECT id FROM document_sessions WHERE expires_at <= ?1)")
    .bind(now)
    .run();

  await db
    .prepare("DELETE FROM document_sessions WHERE expires_at <= ?1")
    .bind(now)
    .run();

  const expiredSubscriptions = await db
    .prepare("UPDATE subscriptions SET status='expired', updated_at=?1 WHERE status='active' AND ends_at <= ?1")
    .bind(now)
    .run();

  return {
    documentSessions: expiredSessions?.count ?? 0,
    documentChunks: deletedChunks.meta.changes ?? 0,
    subscriptions: expiredSubscriptions.meta.changes ?? 0,
  };
}
