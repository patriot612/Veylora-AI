import { env as runtimeEnv } from "cloudflare:workers";
import type { applyD1Migrations } from "cloudflare:test";

export type TestEnv = {
  DB: D1Database;
  AI_JOBS: Queue;
  ENVIRONMENT: string;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
};

export const env = runtimeEnv as unknown as TestEnv;
