export type ActivePlan = {
  id: string;
  code: string;
  name: string;
  durationDays: number;
  dailyPoints: number;
  retentionHours: number;
  voiceEnabled: boolean;
};

export async function getActivePlan(db: D1Database, userId: string, now: string): Promise<ActivePlan | null> {
  const row = await db.prepare("SELECT p.id, p.code, p.name, p.duration_days, p.daily_points, p.retention_hours, p.voice_enabled FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?1 AND s.status = 'active' AND s.starts_at <= ?2 AND s.ends_at > ?2 ORDER BY s.ends_at DESC LIMIT 1")
    .bind(userId, now).first<{ id: string; code: string; name: string; duration_days: number; daily_points: number; retention_hours: number; voice_enabled: number }>();
  if (!row) return null;
  return { id: row.id, code: row.code, name: row.name, durationDays: row.duration_days, dailyPoints: row.daily_points, retentionHours: row.retention_hours, voiceEnabled: row.voice_enabled === 1 };
}

export async function activateSubscription(db: D1Database, input: { userId: string; planId: string; startsAt: string; endsAt: string; now: string }): Promise<string> {
  if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) throw new Error("invalid_subscription_window");
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare("UPDATE subscriptions SET status = 'expired', updated_at = ?2 WHERE user_id = ?1 AND status = 'active'").bind(input.userId, input.now),
    db.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active',?4,?5,?6,?6)").bind(id, input.userId, input.planId, input.startsAt, input.endsAt, input.now),
  ]);
  return id;
}

export async function grantBonusPoints(db: D1Database, userId: string, amount: number, now: string): Promise<boolean> {
  if (!Number.isSafeInteger(amount) || amount <= 0) return false;
  const result = await db.batch([
    db.prepare("UPDATE users SET bonus_points = bonus_points + ?2, updated_at = ?3 WHERE id = ?1").bind(userId, amount, now),
    db.prepare("INSERT INTO point_ledger (id,user_id,source,entry_type,amount,created_at) SELECT ?1,?2,'bonus','grant',?3,?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)").bind(crypto.randomUUID(), userId, amount, now),
  ]);
  return (result[0].meta.changes ?? 0) === 1 && (result[1].meta.changes ?? 0) === 1;
}