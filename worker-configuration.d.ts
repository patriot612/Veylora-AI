interface Env {
  DB: D1Database;
  AI_JOBS: Queue;
  ENVIRONMENT: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}
