ALTER TABLE users ADD COLUMN active_document_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_active_document_session ON users(active_document_session_id);

INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at)
VALUES
  ('cost.document_upload', '2', '2026-09-28T00:00:00Z'),
  ('cost.document_question', '3', '2026-09-28T00:00:00Z'),
  ('limits.document_chunk_size', '2000', '2026-09-28T00:00:00Z'),
  ('limits.document_chunk_overlap', '200', '2026-09-28T00:00:00Z'),
  ('limits.document_top_chunks', '6', '2026-09-28T00:00:00Z'),
  ('limits.document_session_idle_seconds', '7200', '2026-09-28T00:00:00Z');
