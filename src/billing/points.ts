export type PointReservation = { dailyAmount: number; bonusAmount: number };
export type ReserveResult =
  | { ok: true; reservation: PointReservation; duplicate: boolean }
  | { ok: false; reason: 'insufficient_points' | 'invalid_amount' | 'operation_not_reservable' };

export function calculateReservation(amount: number, dailyAvailable: number, bonusAvailable: number): PointReservation | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || dailyAvailable < 0 || bonusAvailable < 0) return null;
  if (dailyAvailable + bonusAvailable < amount) return null;
  const dailyAmount = Math.min(dailyAvailable, amount);
  return { dailyAmount, bonusAmount: amount - dailyAmount };
}

export async function reservePoints(db: D1Database, userId: string, operationId: string, amount: number, now: string): Promise<ReserveResult> {
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, reason: 'invalid_amount' };
  const existing = await db.prepare('SELECT daily_amount, bonus_amount, status FROM point_reservations WHERE operation_id = ?1').bind(operationId).first<{ daily_amount: number; bonus_amount: number; status: string }>();
  if (existing?.status === 'reserved') return { ok: true, reservation: { dailyAmount: existing.daily_amount, bonusAmount: existing.bonus_amount }, duplicate: true };
  if (existing) return { ok: false, reason: 'operation_not_reservable' };
  const day = utcPlusThreeDay(now);
  const subscription = await db.prepare(`SELECT p.daily_points FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?1 AND s.status = 'active' AND s.starts_at <= ?2 AND s.ends_at > ?2 ORDER BY s.ends_at DESC LIMIT 1`).bind(userId, now).first<{ daily_points: number }>();
  const dailyAllowance = subscription?.daily_points ?? 50;
  const user = await db.prepare('SELECT daily_points_remaining, bonus_points, daily_billing_day FROM users WHERE id = ?1').bind(userId).first<{ daily_points_remaining: number; bonus_points: number; daily_billing_day: string }>();
  if (!user) throw new Error('user_not_found');
  const dailyAvailable = user.daily_billing_day === day ? user.daily_points_remaining : dailyAllowance;
  const reservation = calculateReservation(amount, dailyAvailable, user.bonus_points);
  if (!reservation) return { ok: false, reason: 'insufficient_points' };
  const { dailyAmount, bonusAmount } = reservation;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE operations SET status = 'reserved', daily_reserved = ?2, bonus_reserved = ?3, points_cost = ?4 WHERE id = ?1 AND user_id = ?5 AND status = 'created' AND EXISTS (SELECT 1 FROM users WHERE id = ?5 AND (CASE WHEN daily_billing_day = ?6 THEN daily_points_remaining ELSE ?7 END + bonus_points) >= ?4)`).bind(operationId, dailyAmount, bonusAmount, amount, userId, day, dailyAllowance),
    db.prepare(`UPDATE users SET daily_points_remaining = ?2, bonus_points = ?3, daily_billing_day = ?4, updated_at = ?5 WHERE id = ?1 AND daily_points_remaining >= CASE WHEN daily_billing_day = ?4 THEN ?6 ELSE 0 END AND bonus_points >= ?7 AND EXISTS (SELECT 1 FROM operations WHERE id = ?8 AND user_id = ?1 AND status = 'reserved')`).bind(userId, dailyAvailable - dailyAmount, user.bonus_points - bonusAmount, day, now, dailyAmount, bonusAmount, operationId),
    db.prepare(`INSERT INTO point_reservations (id, operation_id, daily_amount, bonus_amount, daily_billing_day, status, created_at) SELECT ?1, ?2, ?3, ?4, ?5, 'reserved', ?6 WHERE EXISTS (SELECT 1 FROM operations WHERE id = ?2 AND user_id = ?7 AND status = 'reserved')`).bind(crypto.randomUUID(), operationId, dailyAmount, bonusAmount, day, now, userId),
  ];
  if (dailyAmount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'daily', 'reserve', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND status = 'reserved')`).bind(crypto.randomUUID(), userId, operationId, dailyAmount, now));
  if (bonusAmount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'bonus', 'reserve', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND status = 'reserved')`).bind(crypto.randomUUID(), userId, operationId, bonusAmount, now));
  try {
    const result = await db.batch(statements);
    if ((result[0].meta.changes ?? 0) !== 1 || (result[1].meta.changes ?? 0) !== 1 || (result[2].meta.changes ?? 0) !== 1) return { ok: false, reason: 'operation_not_reservable' };
    return { ok: true, reservation, duplicate: false };
  } catch (error) {
    const concurrent = await db.prepare('SELECT daily_amount, bonus_amount, status FROM point_reservations WHERE operation_id = ?1').bind(operationId).first<{ daily_amount: number; bonus_amount: number; status: string }>();
    if (concurrent?.status === 'reserved') {
      return { ok: true, reservation: { dailyAmount: concurrent.daily_amount, bonusAmount: concurrent.bonus_amount }, duplicate: true };
    }
    throw error;
  }
}

export async function settleReservation(db: D1Database, operationId: string, now: string): Promise<boolean> {
  const current = await db.prepare('SELECT o.user_id, r.daily_amount, r.bonus_amount, r.status FROM point_reservations r JOIN operations o ON o.id = r.operation_id WHERE r.operation_id = ?1').bind(operationId).first<{ user_id: string; daily_amount: number; bonus_amount: number; status: string }>();
  if (!current) return false;
  if (current.status === 'captured') return true;
  if (current.status !== 'reserved') return false;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE point_reservations SET status = 'captured', settled_at = ?2 WHERE operation_id = ?1 AND status = 'reserved' AND EXISTS (SELECT 1 FROM operations WHERE id = ?1 AND status IN ('reserved', 'processing', 'delivering'))`).bind(operationId, now),
    db.prepare(`UPDATE operations SET status = 'succeeded', finished_at = ?2 WHERE id = ?1 AND status IN ('reserved', 'processing', 'delivering') AND EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?1 AND status = 'captured')`).bind(operationId, now),
  ];
  if (current.daily_amount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'daily', 'capture', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND status = 'captured') AND EXISTS (SELECT 1 FROM operations WHERE id = ?3 AND status = 'succeeded') AND NOT EXISTS (SELECT 1 FROM point_ledger WHERE operation_id = ?3 AND source = 'daily' AND entry_type = 'capture')`).bind(crypto.randomUUID(), current.user_id, operationId, current.daily_amount, now));
  if (current.bonus_amount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'bonus', 'capture', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND status = 'captured') AND EXISTS (SELECT 1 FROM operations WHERE id = ?3 AND status = 'succeeded') AND NOT EXISTS (SELECT 1 FROM point_ledger WHERE operation_id = ?3 AND source = 'bonus' AND entry_type = 'capture')`).bind(crypto.randomUUID(), current.user_id, operationId, current.bonus_amount, now));
  const result = await db.batch(statements);
  if ((result[0].meta.changes ?? 0) === 1 && (result[1].meta.changes ?? 0) === 1) return true;
  const settled = await db.prepare("SELECT r.status AS reservation_status, o.status AS operation_status FROM point_reservations r JOIN operations o ON o.id=r.operation_id WHERE r.operation_id=?1").bind(operationId).first<{reservation_status:string;operation_status:string}>();
  return settled?.reservation_status === "captured" && settled.operation_status === "succeeded";
}

export async function releaseReservation(db: D1Database, operationId: string, now: string, terminalStatus: 'failed' | 'timeout' = 'failed', errorCode?: string): Promise<boolean> {
  const current = await db.prepare('SELECT o.user_id, u.daily_billing_day AS current_billing_day, r.daily_billing_day AS reservation_billing_day, r.daily_amount, r.bonus_amount, r.status FROM point_reservations r JOIN operations o ON o.id = r.operation_id JOIN users u ON u.id = o.user_id WHERE r.operation_id = ?1').bind(operationId).first<{ user_id: string; current_billing_day: string; reservation_billing_day: string | null; daily_amount: number; bonus_amount: number; status: string }>();
  if (!current) return false;
  if (current.status === 'released') return true;
  if (current.status !== 'reserved') return false;
  const restoreDaily = current.reservation_billing_day !== null && current.reservation_billing_day === current.current_billing_day;
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE point_reservations SET status = 'released', settled_at = ?2 WHERE operation_id = ?1 AND status = 'reserved' AND EXISTS (SELECT 1 FROM operations WHERE id = ?1 AND status IN ('reserved', 'processing', 'delivering', 'queued'))`).bind(operationId, now),
    db.prepare(`UPDATE users SET daily_points_remaining = daily_points_remaining + CASE WHEN ?6 THEN ?2 ELSE 0 END, bonus_points = bonus_points + ?3, updated_at = ?4 WHERE id = ?1 AND EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?5 AND status = 'released') AND EXISTS (SELECT 1 FROM operations WHERE id = ?5 AND status IN ('reserved','processing','delivering','queued'))`).bind(current.user_id, current.daily_amount, current.bonus_amount, now, operationId, restoreDaily ? 1 : 0),
    db.prepare(`UPDATE operations SET status = ?2, error_code = ?4, finished_at = ?3 WHERE id = ?1 AND status IN ('reserved', 'processing', 'delivering', 'queued') AND EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?1 AND status = 'released')`).bind(operationId, terminalStatus, now, errorCode ?? null),
  ];
  if (current.daily_amount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'daily', 'release', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND status = 'released') AND NOT EXISTS (SELECT 1 FROM point_ledger WHERE operation_id = ?3 AND source = 'daily' AND entry_type = 'release')`).bind(crypto.randomUUID(), current.user_id, operationId, current.daily_amount, now));
  if (current.bonus_amount > 0) statements.push(db.prepare(`INSERT INTO point_ledger (id, user_id, operation_id, source, entry_type, amount, created_at) SELECT ?1, ?2, ?3, 'bonus', 'release', ?4, ?5 WHERE EXISTS (SELECT 1 FROM point_reservations WHERE operation_id = ?3 AND source = 'bonus' AND entry_type = 'release') AND NOT EXISTS (SELECT 1 FROM point_ledger WHERE operation_id = ?3 AND source = 'bonus' AND entry_type = 'release')`).bind(crypto.randomUUID(), current.user_id, operationId, current.bonus_amount, now));
  const result = await db.batch(statements);
  if ((result[0].meta.changes ?? 0) === 1 && (result[1].meta.changes ?? 0) === 1 && (result[2].meta.changes ?? 0) === 1) return true;
  const released = await db.prepare("SELECT r.status AS reservation_status, o.status AS operation_status FROM point_reservations r JOIN operations o ON o.id=r.operation_id WHERE r.operation_id=?1").bind(operationId).first<{reservation_status:string;operation_status:string}>();
  return released?.reservation_status === "released" && ["failed","timeout"].includes(released.operation_status);
}

function utcPlusThreeDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error('invalid_timestamp');
  date.setUTCHours(date.getUTCHours() + 3);
  return date.toISOString().slice(0, 10);
}
