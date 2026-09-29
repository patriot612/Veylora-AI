CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('received','processing','processed','ignored','failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT
);

CREATE INDEX idx_telegram_updates_user_received ON telegram_updates(user_id, received_at DESC);
