import { env as runtimeEnv } from "cloudflare:workers";

export type TestEnv = {
  DB: D1Database;
  AI_JOBS: Queue;
  ENVIRONMENT: string;
  TEST_MIGRATIONS: D1Migration[];
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

export const env = runtimeEnv as unknown as TestEnv;
