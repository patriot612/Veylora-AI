INSERT OR IGNORE INTO system_config (config_key, config_value, updated_at)
VALUES ('limits.telegram_updates_per_minute', '30', CURRENT_TIMESTAMP);
