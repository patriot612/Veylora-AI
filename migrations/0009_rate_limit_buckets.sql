CREATE TABLE rate_limit_buckets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_start TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, bucket_start)
);

CREATE INDEX idx_rate_limit_buckets_bucket_start ON rate_limit_buckets(bucket_start);
