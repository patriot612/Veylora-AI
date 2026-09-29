import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { acquireActiveChatOperation, releaseActiveChatOperation } from "../src/operations/locks";
import { createOperation, getOperation, transitionOperation } from "../src/operations/service";
import { activateSubscription, getActivePlan, grantBonusPoints } from "../src/subscriptions";

let telegramId = 600000000;
const nextTelegramId = () => ++telegramId;

async function seedUser(userId: string) {
  await env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(userId, nextTelegramId()).run();
}

describe("operation idempotency and state machine", () => {
  it("returns the existing operation for a duplicate Telegram update", async () => {
    const userId = crypto.randomUUID();
    await seedUser(userId);
    const first = await createOperation(env.DB, { userId, type: "chat", telegramUpdateId: nextTelegramId(), now: "2026-09-28T12:00:00Z" });
    const second = await createOperation(env.DB, { userId, type: "chat", telegramUpdateId: first.operation.telegramUpdateId!, now: "2026-09-28T12:00:01Z" });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
  });

  it("rejects a cross-user reuse of a Telegram update id", async () => {
    const owner = crypto.randomUUID();
    const attacker = crypto.randomUUID();
    await seedUser(owner);
    await seedUser(attacker);
    const updateId = nextTelegramId();
    await createOperation(env.DB, { userId: owner, type: "chat", telegramUpdateId: updateId, now: "2026-09-28T12:00:00Z" });
    await expect(createOperation(env.DB, { userId: attacker, type: "chat", telegramUpdateId: updateId, now: "2026-09-28T12:00:01Z" })).rejects.toThrow("update_owner_mismatch");
    expect(await getOperation(env.DB, "missing", attacker)).toBeNull();
  });

  it("allows only declared forward transitions and closes terminal states", async () => {
    const userId = crypto.randomUUID();
    await seedUser(userId);
    const op = await createOperation(env.DB, { userId, type: "chat", now: "2026-09-28T12:00:00Z" });
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "processing", now: "2026-09-28T12:00:01Z" })).toBe(false);
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "reserved", now: "2026-09-28T12:00:02Z" })).toBe(true);
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "processing", now: "2026-09-28T12:00:03Z" })).toBe(true);
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "delivering", now: "2026-09-28T12:00:04Z" })).toBe(true);
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "succeeded", now: "2026-09-28T12:00:05Z" })).toBe(true);
    expect(await transitionOperation(env.DB, { operationId: op.operation.id, userId, to: "failed", now: "2026-09-28T12:00:06Z" })).toBe(false);
    expect((await getOperation(env.DB, op.operation.id, userId))?.status).toBe("succeeded");
  });
});

describe("active operation lock", () => {
  it("allows one active chat operation and prevents a second owner-matching lock", async () => {
    const userId = crypto.randomUUID();
    await seedUser(userId);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect(await acquireActiveChatOperation(env.DB, userId, first)).toBe(true);
    expect(await acquireActiveChatOperation(env.DB, userId, second)).toBe(false);
    expect(await releaseActiveChatOperation(env.DB, userId, second)).toBe(false);
    expect(await releaseActiveChatOperation(env.DB, userId, first)).toBe(true);
    expect(await acquireActiveChatOperation(env.DB, userId, second)).toBe(true);
  });
});

describe("subscriptions and bonus points", () => {
  it("activates a plan and expires the previous active subscription", async () => {
    const userId = crypto.randomUUID();
    await seedUser(userId);
    const first = await activateSubscription(env.DB, { userId, planId: "plan_month", startsAt: "2026-09-28T00:00:00Z", endsAt: "2026-10-28T00:00:00Z", now: "2026-09-28T12:00:00Z" });
    const second = await activateSubscription(env.DB, { userId, planId: "plan_3_months", startsAt: "2026-09-28T12:00:00Z", endsAt: "2026-12-27T12:00:00Z", now: "2026-09-28T12:00:01Z" });
    expect(first).not.toBe(second);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?1 AND status='active'").bind(userId).first<{count:number}>())?.count).toBe(1);
    expect((await getActivePlan(env.DB, userId, "2026-10-01T00:00:00Z"))?.code).toBe("3_months");
  });

  it("grants bonus points atomically and records the ledger entry", async () => {
    const userId = crypto.randomUUID();
    await seedUser(userId);
    expect(await grantBonusPoints(env.DB, userId, 25, "2026-09-28T12:00:00Z")).toBe(true);
    expect(await grantBonusPoints(env.DB, userId, 0, "2026-09-28T12:00:01Z")).toBe(false);
    const user = await env.DB.prepare("SELECT bonus_points FROM users WHERE id=?1").bind(userId).first<{bonus_points:number}>();
    const ledger = await env.DB.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE user_id=?1 AND source='bonus' AND entry_type='grant'").bind(userId).first<{count:number}>();
    expect(user?.bonus_points).toBe(25);
    expect(ledger?.count).toBe(1);
  });
});