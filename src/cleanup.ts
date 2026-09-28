export type CleanupResult = {
  documentSessions: number;
  documentChunks: number;
  subscriptions: number;
};

/**
 * Removes short-lived document state and normalizes subscriptions whose end
 * time has passed. All predicates are server-side and scoped to explicit
 * lifecycle timestamps; no client-provided identity is involved.
 */
export async function runScheduledCleanup(db: D1Database, now: string): Promise<CleanupResult> {
  const expiredSessions = await db
    .prepare("SELECT id FROM document_sessions WHERE expires_at <= ?1")
    .bind(now)
    .all<{ id: string }>();

  let documentChunks = 0;
  if (expiredSessions.results.length > 0) {
    const ids = expiredSessions.results.map((row) => row.id);
    const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");

    await db
      .prepare("UPDATE users SET active_document_session_id=NULL, updated_at=?1 WHERE active_document_session_id IN (" + placeholders + ")")
      .bind(now, ...ids)
      .run();

    const deletedChunks = await db
      .prepare(`DELETE FROM document_chunks WHERE session_id IN (${ids.map((_, index) => `?${index + 1}`).join(",")})`)
      .bind(...ids)
      .run();
    documentChunks = deletedChunks.meta.changes ?? 0;

    await db
      .prepare(`DELETE FROM document_sessions WHERE id IN (${ids.map((_, index) => `?${index + 1}`).join(",")})`)
      .bind(...ids)
      .run();
  }

  const deletedSubscriptions = await db
    .prepare("UPDATE subscriptions SET status='expired', updated_at=?1 WHERE status='active' AND ends_at <= ?1")
    .bind(now)
    .run();

  return {
    documentSessions: expiredSessions.results.length,
    documentChunks,
    subscriptions: deletedSubscriptions.meta.changes ?? 0,
  };
}
