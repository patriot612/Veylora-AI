import { applyD1Migrations } from "cloudflare:test";
import { env } from "./test-env";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
