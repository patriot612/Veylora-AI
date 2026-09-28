import type { TelegramUser } from "../telegram/router";
import { getSystemConfigInt } from "../config";

export type UpsertedUser = {
  id: string;
  telegramUserId: number;
  telegram_user_id: number;
  username?: string;
  first_name?: string;
};

export type UpdateClaim =
  | { duplicate: true; rateLimited: boolean }
  | { duplicate: false; rateLimited: false };

export async function upsertTelegramUser(db: D1Database, telegramUser: TelegramUser, now: string): Promise<UpsertedUser> {
  const existing = await db.prepare("SELECT id FROM users WHERE telegram_user_id = ?1").bind(telegramUser.id).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const billingDay = utcPlusThreeDay(now);
  await db.prepare(`INSERT INTO users (id, telegram_user_id, username, first_name, daily_billing_day, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, updated_at = excluded.updated_at`).bind(id, telegramUser.id, telegramUser.username ?? null, telegramUser.first_name ?? null, billingDay, now).run();
  await db.prepare(`INSERT INTO user_settings (user_id) VALUES (?1) ON CONFLICT(user_id) DO NOTHING`).bind(id).run();
  return { id, telegramUserId: telegramUser.id, telegram_user_id: telegramUser.id, ...(telegramUser.username ? { username: telegramUser.username } : {}), ...(telegramUser.first_name ? { first_name: telegramUser.first_name } : {}) };
}

export async function claimTelegramUpdate(db: D1Database, updateId: number, userId: string | null, now: string): Promise<UpdateClaim> {
  const result = await db.prepare(`INSERT INTO telegram_updates (update_id, user_id, status, received_at) VALUES (?1, ?2, 'received', ?3) ON CONFLICT(update_id) DO NOTHING`).bind(updateId, userId, now).run();
  if (result.meta.changes === 0) return { duplicate: true, rateLimited: false };
  if (!userId) return { duplicate: false, rateLimited: false };

  const limit = Math.max(1, Math.min(1000, await getSystemConfigInt(db, "limits.telegram_updates_per_minute", 30)));
  const bucketStart = minuteBucket(now);
  const allowed = await db.prepare(`INSERT INTO rate_limit_buckets (user_id, bucket_start, request_count) VALUES (?1, ?2, 1) ON CONFLICT(user_id, bucket_start) DO UPDATE SET request_count = request_count + 1 WHERE request_count < ?3 RETURNING request_count`).bind(userId, bucketStart, limit).first<{ request_count: number }>();
  if (allowed) return { duplicate: false, rateLimited: false };

  await db.prepare("UPDATE telegram_updates SET status='ignored', processed_at=?2, error_code='rate_limited' WHERE update_id=?1").bind(updateId, now).run();
  return { duplicate: true, rateLimited: true };
}

export async function markTelegramUpdate(db: D1Database, updateId: number, status: "processing" | "processed" | "ignored" | "failed", now: string, errorCode?: string): Promise<void> {
  await db.prepare(`UPDATE telegram_updates SET status = ?2, processed_at = CASE WHEN ?2 IN ('processed', 'ignored', 'failed') THEN ?3 ELSE processed_at END, error_code = ?4 WHERE update_id = ?1`).bind(updateId, status, now, errorCode ?? null).run();
}

function minuteBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_timestamp");
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function utcPlusThreeDay(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_timestamp");
  date.setUTCHours(date.getUTCHours() + 3);
  return date.toISOString().slice(0, 10);
}
