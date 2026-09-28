ALTER TABLE users ADD COLUMN last_request_at TEXT;

INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at) VALUES
  ('search.enabled', '1', '2026-09-28T00:00:00Z'),
  ('search.fallback_url', '', '2026-09-28T00:00:00Z'),
  ('search.max_query_chars', '1000', '2026-09-28T00:00:00Z'),
  ('limits.request_cooldown_seconds', '2', '2026-09-28T00:00:00Z');
