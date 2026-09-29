INSERT OR IGNORE INTO providers (id, name, adapter_type, endpoint, enabled, created_at, updated_at)
VALUES
  ('provider_pollinations', 'Pollinations', 'openai_compatible', 'https://gen.pollinations.ai/v1', 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z'),
  ('provider_xkiro', 'xKiro', 'openai_compatible', 'https://api.xkiro.com/v1', 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z'),
  ('provider_groq', 'Groq', 'openai_compatible', 'https://api.groq.com/openai/v1', 1, '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');
