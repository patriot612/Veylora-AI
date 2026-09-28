interface Env {
  DB: D1Database;
  AI_JOBS: Queue;
  ENVIRONMENT: string;
  TEST_MIGRATIONS: D1Migration[];
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  SEARXNG_URL?: string;
}
