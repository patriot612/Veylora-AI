ALTER TABLE users ADD COLUMN last_request_at TEXT;

INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at) VALUES
  ('search.enabled', '1', '2026-09-28T00:00:00Z'),
  ('search.fallback_url', '', '2026-09-28T00:00:00Z'),
  ('search.max_query_chars', '1000', '2026-09-28T00:00:00Z'),
  ('limits.request_cooldown_seconds', '2', '2026-09-28T00:00:00Z');


INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at) VALUES
  ('search.language', 'all', '2026-09-28T00:00:00Z'),
  ('search.categories', 'general', '2026-09-28T00:00:00Z'),
  ('search.time_range', '', '2026-09-28T00:00:00Z'),
  ('search.safe_search', '0', '2026-09-28T00:00:00Z'),
  ('search.primary_url', '', '2026-09-28T00:00:00Z'),
  ('search.fallback_url', '', '2026-09-28T00:00:00Z');

INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at) VALUES
  ('system.maintenance_mode', '0', '2026-09-28T00:00:00Z');
