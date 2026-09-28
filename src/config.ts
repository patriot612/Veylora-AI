export async function getSystemConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT config_value FROM system_config WHERE config_key = ?1")
    .bind(key)
    .first<{ config_value: string }>();
  return row?.config_value ?? null;
}

export async function getSystemConfigInt(db: D1Database, key: string, fallback: number): Promise<number> {
  const value = await getSystemConfig(db, key);
  const parsed = value === null ? NaN : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
