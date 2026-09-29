INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_free', 'free', 'Free', 0, 50, 24, 0, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_week', 'week', 'Week', 7, 100, 24, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_month', 'month', 'Month', 30, 100, 48, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_3_months', '3_months', '3 months', 90, 100, 48, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_6_months', '6_months', '6 months', 180, 100, 48, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_1_year', '1_year', '1 year', 365, 100, 48, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO plans (id, code, name, duration_days, daily_points, retention_hours, voice_enabled, price_stars, enabled, created_at, updated_at)
VALUES ('plan_2_years', '2_years', '2 years', 730, 200, 48, 1, 0, 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');

INSERT INTO system_config (config_key, config_value, updated_at)
VALUES
  ('daily_points.free', '50', '2026-09-28T00:00:00Z'),
  ('daily_points.reset_timezone', 'UTC+3', '2026-09-28T00:00:00Z'),
  ('limits.chat_chars', '4096', '2026-09-28T00:00:00Z'),
  ('limits.image_bytes', '10485760', '2026-09-28T00:00:00Z'),
  ('limits.document_bytes', '10485760', '2026-09-28T00:00:00Z'),
  ('limits.document_pdf_pages', '50', '2026-09-28T00:00:00Z'),
  ('limits.document_extracted_chars', '25000', '2026-09-28T00:00:00Z'),
  ('limits.search_timeout_seconds', '300', '2026-09-28T00:00:00Z'),
  ('limits.image_timeout_seconds', '300', '2026-09-28T00:00:00Z'),
  ('limits.voice_timeout_seconds', '300', '2026-09-28T00:00:00Z'),
  ('limits.document_session_idle_seconds', '7200', '2026-09-28T00:00:00Z'),
  ('limits.active_chat_operations', '1', '2026-09-28T00:00:00Z'),
  ('limits.request_cooldown_seconds', '2', '2026-09-28T00:00:00Z');

INSERT INTO families (id, name, enabled, sort_order)
VALUES
  ('family_gpt', 'GPT', 1, 10),
  ('family_claude', 'Claude', 1, 20),
  ('family_gemini', 'Gemini', 1, 30),
  ('family_deepseek', 'DeepSeek', 1, 40),
  ('family_grok', 'Grok', 1, 50);
