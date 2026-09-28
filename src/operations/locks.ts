export async function acquireActiveChatOperation(db: D1Database, userId: string, operationId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE users SET active_operation_id = ?2, updated_at = ?3 WHERE id = ?1 AND active_operation_id IS NULL")
    .bind(userId, operationId, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseActiveChatOperation(db: D1Database, userId: string, operationId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE users SET active_operation_id = NULL, updated_at = ?3 WHERE id = ?1 AND active_operation_id = ?2")
    .bind(userId, operationId, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) === 1;
}
