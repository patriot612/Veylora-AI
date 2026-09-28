const DEFAULT_BUCKET_SECONDS = 60;

export type RateLimitResult = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number };

export async function consumeUserRateLimit(
  db: D1Database,
  userId: string,
  now: string,
  maxRequests: number,
  bucketSeconds = DEFAULT_BUCKET_SECONDS,
): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("invalid_rate_limit");
  if (!Number.isSafeInteger(bucketSeconds) || bucketSeconds < 1) throw new Error("invalid_rate_limit_bucket");

  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("invalid_rate_limit_time");
  const bucketStartMs = Math.floor(nowMs / (bucketSeconds * 1000)) * bucketSeconds * 1000;
  const bucketStart = new Date(bucketStartMs).toISOString();
  const bucketEndMs = bucketStartMs + bucketSeconds * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucketEndMs - nowMs) / 1000));

  const updated = await db
    .prepare(
      "UPDATE rate_limit_buckets SET request_count=request_count+1 WHERE user_id=?1 AND bucket_start=?2 AND request_count < ?3",
    )
    .bind(userId, bucketStart, maxRequests)
    .run();

  if ((updated.meta.changes ?? 0) === 1) {
    const current = await db
      .prepare("SELECT request_count FROM rate_limit_buckets WHERE user_id=?1 AND bucket_start=?2")
      .bind(userId, bucketStart)
      .first<{ request_count: number }>();
    return { allowed: true, remaining: Math.max(0, maxRequests - (current?.request_count ?? maxRequests)) };
  }

  try {
    await db
      .prepare(
        "INSERT INTO rate_limit_buckets (user_id,bucket_start,request_count) VALUES (?1,?2,1)",
      )
      .bind(userId, bucketStart)
      .run();
    return { allowed: true, remaining: maxRequests - 1 };
  } catch {
    const retry = await db
      .prepare(
        "UPDATE rate_limit_buckets SET request_count=request_count+1 WHERE user_id=?1 AND bucket_start=?2 AND request_count < ?3",
      )
      .bind(userId, bucketStart, maxRequests)
      .run();

    if ((retry.meta.changes ?? 0) === 1) {
      const current = await db
        .prepare("SELECT request_count FROM rate_limit_buckets WHERE user_id=?1 AND bucket_start=?2")
        .bind(userId, bucketStart)
        .first<{ request_count: number }>();
      return { allowed: true, remaining: Math.max(0, maxRequests - (current?.request_count ?? maxRequests)) };
    }

    return { allowed: false, retryAfterSeconds };
  }
}

export async function pruneRateLimitBuckets(db: D1Database, olderThan: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM rate_limit_buckets WHERE bucket_start < ?1")
    .bind(olderThan)
    .run();
  return result.meta.changes ?? 0;
}
