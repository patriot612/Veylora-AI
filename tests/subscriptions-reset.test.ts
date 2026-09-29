import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { getActivePlan } from "../src/subscriptions";

describe("daily point reset", () => {
  it("refreshes stale daily points before account/plan reads", async () => {
    const userId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',0,7,'2026-09-28T23:00:00Z','2026-09-28T23:00:00Z')").bind(userId, 990000001),
      env.DB.prepare("INSERT INTO plans (id,code,name,duration_days,daily_points,retention_hours,price_stars,created_at,updated_at) VALUES (?1,?2,'Reset Test',30,80,24,1,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(planId, "reset-test-" + userId),
      env.DB.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active','2026-09-28T00:00:00Z','2026-10-28T00:00:00Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(subscriptionId, userId, planId),
    ]);
    const plan = await getActivePlan(env.DB, userId, "2026-09-29T01:00:00Z");
    const user = await env.DB.prepare("SELECT daily_points_remaining,daily_billing_day,bonus_points FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number;daily_billing_day:string;bonus_points:number}>();
    expect(plan?.dailyPoints).toBe(80);
    expect(user?.daily_points_remaining).toBe(80);
    expect(user?.daily_billing_day).toBe("2026-09-29");
    expect(user?.bonus_points).toBe(7);
  });
});
