import { env } from './test-env';
import { describe, expect, it } from 'vitest';
import { calculateReservation, releaseReservation, reservePoints, settleReservation } from '../src/billing/points';

let telegramId = 700000000;
const nextTelegramId = () => ++telegramId;

async function seedUser(userId: string, dailyPoints = 50, billingDay = '2026-09-28') {
  const now = '2026-09-28T12:00:00.000Z';
  await env.DB.prepare(`INSERT INTO users (id, telegram_user_id, daily_billing_day, daily_points_remaining, bonus_points, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`).bind(userId, nextTelegramId(), billingDay, dailyPoints, now).run();
}

async function seedOperation(operationId: string, userId: string) {
  await env.DB.prepare(`INSERT INTO operations (id, user_id, type, status, points_cost, created_at) VALUES (?1, ?2, 'chat', 'created', 0, '2026-09-28T12:00:00.000Z')`).bind(operationId, userId).run();
}

describe('point allocation', () => {
  it('consumes daily points before bonus points', () => {
    expect(calculateReservation(70, 50, 100)).toEqual({ dailyAmount: 50, bonusAmount: 20 });
  });
  it('uses only daily points when sufficient', () => {
    expect(calculateReservation(30, 50, 100)).toEqual({ dailyAmount: 30, bonusAmount: 0 });
  });
  it('rejects insufficient or invalid reservations', () => {
    expect(calculateReservation(151, 50, 100)).toBeNull();
    expect(calculateReservation(0, 50, 100)).toBeNull();
    expect(calculateReservation(10, -1, 100)).toBeNull();
  });
});

describe('D1 billing lifecycle', () => {
  it('settles exactly once without a second charge', async () => {
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await seedUser(userId);
    await seedOperation(operationId, userId);
    expect(await reservePoints(env.DB, userId, operationId, 30, '2026-09-28T12:00:00.000Z')).toEqual({ ok: true, reservation: { dailyAmount: 30, bonusAmount: 0 }, duplicate: false });
    expect(await settleReservation(env.DB, operationId, '2026-09-28T12:01:00.000Z')).toBe(true);
    expect(await settleReservation(env.DB, operationId, '2026-09-28T12:02:00.000Z')).toBe(true);
    const user = await env.DB.prepare('SELECT daily_points_remaining FROM users WHERE id=?1').bind(userId).first<{ daily_points_remaining: number }>();
    const reservation = await env.DB.prepare('SELECT status FROM point_reservations WHERE operation_id=?1').bind(operationId).first<{ status: string }>();
    const operation = await env.DB.prepare('SELECT status FROM operations WHERE id=?1').bind(operationId).first<{ status: string }>();
    const ledger = await env.DB.prepare('SELECT COUNT(*) AS count FROM point_ledger WHERE operation_id=?1').bind(operationId).first<{ count: number }>();
    expect(user?.daily_points_remaining).toBe(20);
    expect(reservation?.status).toBe('captured');
    expect(operation?.status).toBe('succeeded');
    expect(ledger?.count).toBe(2);
  });

  it('releases exactly once and restores the reserved balance', async () => {
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await seedUser(userId);
    await seedOperation(operationId, userId);
    expect((await reservePoints(env.DB, userId, operationId, 30, '2026-09-28T12:00:00.000Z')).ok).toBe(true);
    expect(await releaseReservation(env.DB, operationId, '2026-09-28T12:01:00.000Z')).toBe(true);
    expect(await releaseReservation(env.DB, operationId, '2026-09-28T12:02:00.000Z')).toBe(true);
    const user = await env.DB.prepare('SELECT daily_points_remaining FROM users WHERE id=?1').bind(userId).first<{ daily_points_remaining: number }>();
    const reservation = await env.DB.prepare('SELECT status FROM point_reservations WHERE operation_id=?1').bind(operationId).first<{ status: string }>();
    const operation = await env.DB.prepare('SELECT status FROM operations WHERE id=?1').bind(operationId).first<{ status: string }>();
    const ledger = await env.DB.prepare('SELECT COUNT(*) AS count FROM point_ledger WHERE operation_id=?1').bind(operationId).first<{ count: number }>();
    expect(user?.daily_points_remaining).toBe(50);
    expect(reservation?.status).toBe('released');
    expect(operation?.status).toBe('failed');
    expect(ledger?.count).toBe(2);
  });

  it('resets at UTC+3 without carrying the previous balance', async () => {
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await seedUser(userId, 0, '2026-09-27');
    await seedOperation(operationId, userId);
    expect((await reservePoints(env.DB, userId, operationId, 20, '2026-09-28T21:30:00.000Z')).ok).toBe(true);
    const user = await env.DB.prepare('SELECT daily_points_remaining, daily_billing_day FROM users WHERE id=?1').bind(userId).first<{ daily_points_remaining: number; daily_billing_day: string }>();
    expect(user?.daily_points_remaining).toBe(30);
    expect(user?.daily_billing_day).toBe('2026-09-29');
  });
});