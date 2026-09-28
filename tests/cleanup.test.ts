import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("scheduled cleanup", () => {
  it("expires subscriptions and removes expired document sessions without touching active state", async () => {
    const expiredUser = crypto.randomUUID();
    const activeUser = crypto.randomUUID();
    const expiredSession = crypto.randomUUID();
    const activeSession = crypto.randomUUID();
    const planId = crypto.randomUUID();

    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,active_document_session_id,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(expiredUser, 980000001, expiredSession),
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,active_document_session_id,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(activeUser, 980000002, activeSession),
      env.DB.prepare("INSERT INTO plans (id,code,name,duration_days,daily_points,retention_hours,price_stars,created_at,updated_at) VALUES (?1,'cleanup-test','Cleanup',1,10,24,1,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(planId),
      env.DB.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active','2026-09-27T00:00:00Z','2026-09-27T23:59:00Z','2026-09-27T00:00:00Z','2026-09-27T00:00:00Z')").bind(crypto.randomUUID(), expiredUser, planId),
      env.DB.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active','2026-09-28T00:00:00Z','2026-09-29T00:00:00Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(crypto.randomUUID(), activeUser, planId),
      env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',5,'2026-09-27T23:00:00Z','2026-09-27T00:00:00Z','2026-09-27T00:00:00Z')").bind(expiredSession, expiredUser),
      env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',5,'2026-09-29T00:00:00Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(activeSession, activeUser),
      env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,'expired','2026-09-27T23:00:00Z')").bind(crypto.randomUUID(), expiredSession),
      env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,'active','2026-09-29T00:00:00Z')").bind(crypto.randomUUID(), activeSession),
    ]);

    await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.parse("2026-09-28T00:00:00Z"), type: "scheduled" } as ScheduledController, env);

    const expiredOwner = await env.DB.prepare("SELECT active_document_session_id FROM users WHERE id=?1").bind(expiredUser).first<{active_document_session_id:string|null}>();
    const activeOwner = await env.DB.prepare("SELECT active_document_session_id FROM users WHERE id=?1").bind(activeUser).first<{active_document_session_id:string|null}>();
    const expiredSubscription = await env.DB.prepare("SELECT status FROM subscriptions WHERE user_id=?1").bind(expiredUser).first<{status:string}>();
    const activeSubscription = await env.DB.prepare("SELECT status FROM subscriptions WHERE user_id=?1").bind(activeUser).first<{status:string}>();
    const activeChunk = await env.DB.prepare("SELECT content FROM document_chunks WHERE session_id=?1").bind(activeSession).first<{content:string}>();
    const expiredSessionRow = await env.DB.prepare("SELECT id FROM document_sessions WHERE id=?1").bind(expiredSession).first<{id:string}>();

    expect(expiredOwner?.active_document_session_id).toBeNull();
    expect(activeOwner?.active_document_session_id).toBe(activeSession);
    expect(expiredSubscription?.status).toBe("expired");
    expect(activeSubscription?.status).toBe("active");
    expect(activeChunk?.content).toBe("active");
    expect(expiredSessionRow).toBeNull();
  });
});
