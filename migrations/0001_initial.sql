PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  language TEXT NOT NULL DEFAULT 'ru',
  active_mode TEXT NOT NULL DEFAULT 'chat',
  active_conversation_id TEXT,
  active_chat_model_id TEXT,
  active_role_id TEXT,
  daily_points_remaining INTEGER NOT NULL DEFAULT 50 CHECK (daily_points_remaining >= 0),
  daily_billing_day TEXT NOT NULL,
  bonus_points INTEGER NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  active_operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0,1)),
  ui_preferences TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  daily_points INTEGER NOT NULL CHECK (daily_points >= 0),
  retention_hours INTEGER NOT NULL CHECK (retention_hours > 0),
  voice_enabled INTEGER NOT NULL DEFAULT 0 CHECK (voice_enabled IN (0,1)),
  price_stars INTEGER NOT NULL CHECK (price_stars >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('pending','active','expired','cancelled','refunded')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','refunded','cancelled','failed')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'XTR',
  provider TEXT NOT NULL DEFAULT 'telegram_stars',
  telegram_payment_charge_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  refunded_at TEXT
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','refunded','failed')),
  raw_safe_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(provider, external_payment_id)
);

CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  adapter_type TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('chat','search','image','voice')),
  points_cost INTEGER NOT NULL CHECK (points_cost >= 0),
  subscription_only INTEGER NOT NULL DEFAULT 0 CHECK (subscription_only IN (0,1)),
  context_window INTEGER,
  max_output_tokens INTEGER,
  capabilities TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE image_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL,
  extra_points_cost INTEGER NOT NULL DEFAULT 0 CHECK (extra_points_cost >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id),
  role_id TEXT REFERENCES ai_roles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  expires_at TEXT
);

CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id),
  role_id TEXT REFERENCES ai_roles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_update_id INTEGER UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('chat','search','image','voice','document','payment','admin')),
  status TEXT NOT NULL CHECK (status IN ('created','reserved','queued','processing','delivering','succeeded','failed','timeout','cancelled')),
  model_id TEXT REFERENCES models(id),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  points_cost INTEGER NOT NULL DEFAULT 0 CHECK (points_cost >= 0),
  daily_reserved INTEGER NOT NULL DEFAULT 0 CHECK (daily_reserved >= 0),
  bonus_reserved INTEGER NOT NULL DEFAULT 0 CHECK (bonus_reserved >= 0),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  request_hash TEXT,
  error_code TEXT,
  provider_error_code TEXT,
  telegram_delivery_status TEXT NOT NULL DEFAULT 'not_started' CHECK (telegram_delivery_status IN ('not_started','pending','sent','failed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE point_reservations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  daily_amount INTEGER NOT NULL DEFAULT 0 CHECK (daily_amount >= 0),
  bonus_amount INTEGER NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','captured','released')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE point_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('daily','bonus','purchased')),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('reserve','release','capture','grant','adjustment')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE document_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf','docx','txt')),
  extracted_chars INTEGER NOT NULL CHECK (extracted_chars >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES document_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(session_id, chunk_index)
);

CREATE TABLE queue_jobs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  queue_type TEXT NOT NULL CHECK (queue_type IN ('image','voice','document','search','other')),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','succeeded','failed','dead_lettered')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_roles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','support')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE system_config (
  config_key TEXT PRIMARY KEY,
  config_value TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  admin_id TEXT,
  event_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  safe_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admin_roles(user_id) ON DELETE SET NULL
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE INDEX idx_conversations_user_archived ON conversations(user_id, archived_at);
CREATE INDEX idx_conversation_turns_conversation_created ON conversation_turns(conversation_id, created_at DESC);
CREATE INDEX idx_operations_user_created ON operations(user_id, created_at DESC);
CREATE INDEX idx_operations_request_hash ON operations(user_id, request_hash);
CREATE INDEX idx_operations_status_created ON operations(status, created_at);
CREATE INDEX idx_subscriptions_user_ends ON subscriptions(user_id, ends_at);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_models_type_enabled_subscription ON models(type, enabled, subscription_only);
CREATE INDEX idx_queue_jobs_status_created ON queue_jobs(status, created_at);
CREATE INDEX idx_document_sessions_user_expires ON document_sessions(user_id, expires_at);
CREATE INDEX idx_document_chunks_session_index ON document_chunks(session_id, chunk_index);
CREATE INDEX idx_point_ledger_user_created ON point_ledger(user_id, created_at DESC);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_target ON audit_log(target_type, target_id);
CREATE INDEX idx_admin_roles_role ON admin_roles(role);

CREATE UNIQUE INDEX idx_active_subscription_per_user
  ON subscriptions(user_id)
  WHERE status = 'active';
