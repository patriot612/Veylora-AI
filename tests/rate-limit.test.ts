import { describe, expect, it } from "vitest";
import { env } from "./test-env";
import { consumeUserRateLimit, pruneRateLimitBuckets } from "../src/security/rate-limit";

let sequence = 0;

async function seedUser() {
  sequence += 1;
  const userId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, 970000000 + sequence).run();
  return userId;
}

describe("per-user Telegram rate limit", () => {
  it("allows up to the configured bucket limit and then rejects", async () => {
    const userId = await seedUser();
    const now = "2026-09-28T12:00:10Z";

    expect(await consumeUserRateLimit(env.DB, userId, now, 3)).toEqual({ allowed: true, remaining: 2 });
    expect(await consumeUserRateLimit(env.DB, userId, now, 3)).toEqual({ allowed: true, remaining: 1 });
    expect(await consumeUserRateLimit(env.DB, userId, now, 3)).toEqual({ allowed: true, remaining: 0 });

    const blocked = await consumeUserRateLimit(env.DB, userId, now, 3);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets the counter at the next bucket", async () => {
    const userId = await seedUser();
    expect((await consumeUserRateLimit(env.DB, userId, "2026-09-28T12:00:59Z", 1)).allowed).toBe(true);
    expect((await consumeUserRateLimit(env.DB, userId, "2026-09-28T12:00:59Z", 1)).allowed).toBe(false);
    expect((await consumeUserRateLimit(env.DB, userId, "2026-09-28T12:01:00Z", 1)).allowed).toBe(true);
  });

  it("prunes old buckets without touching the current bucket", async () => {
    const userId = await seedUser();
    await consumeUserRateLimit(env.DB, userId, "2026-09-28T11:00:00Z", 3);
    await consumeUserRateLimit(env.DB, userId, "2026-09-28T12:00:00Z", 3);

    const deleted = await pruneRateLimitBuckets(env.DB, "2026-09-28T11:30:00Z");
    expect(deleted).toBe(1);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets WHERE user_id=?1").bind(userId).first<{count:number}>();
    expect(rows?.count).toBe(1);
  });
});
