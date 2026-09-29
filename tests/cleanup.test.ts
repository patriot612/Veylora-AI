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
      env.DB.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active','2026-09-28T00:00:00Z','2026-09-30T00:00:00Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(crypto.randomUUID(), activeUser, planId),
      env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',5,'2026-09-27T23:00:00Z','2026-09-27T00:00:00Z','2026-09-27T00:00:00Z')").bind(expiredSession, expiredUser),
      env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',5,'2026-09-30T00:00:00Z','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(activeSession, activeUser),
      env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,'expired','2026-09-27T23:00:00Z')").bind(crypto.randomUUID(), expiredSession),
      env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,'active','2026-09-30T00:00:00Z')").bind(crypto.randomUUID(), activeSession),
    ]);

    await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.parse("2026-09-28T00:00:00Z"), type: "scheduled", noRetry: () => undefined } as ScheduledController, env);

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

  it("settles a delivered operation left pending by a worker crash", async () => {
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,created_at,updated_at) VALUES (?1,?2,'2026-09-28',40,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(userId, 980000003),
      env.DB.prepare("INSERT INTO operations (id,user_id,type,status,points_cost,telegram_delivery_status,created_at) VALUES (?1,?2,'search','delivering',10,'sent','2026-09-28T12:00:00Z')").bind(operationId, userId),
      env.DB.prepare("INSERT INTO point_reservations (id,operation_id,daily_amount,bonus_amount,status,created_at) VALUES (?1,?2,10,0,'reserved','2026-09-28T12:00:00Z')").bind(crypto.randomUUID(), operationId),
    ]);
    const result = await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.parse("2026-09-28T01:00:00Z"), type: "scheduled", noRetry: () => undefined } as ScheduledController, env);
    expect(result).toBeUndefined();
    const operation = await env.DB.prepare("SELECT status FROM operations WHERE id=?1").bind(operationId).first<{status:string}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(operationId).first<{status:string}>();
    const ledger = await env.DB.prepare("SELECT source,entry_type,amount FROM point_ledger WHERE operation_id=?1 AND entry_type='capture'").bind(operationId).all<{source:string;entry_type:string;amount:number}>();
    expect(operation?.status).toBe("succeeded");
    expect(reservation?.status).toBe("captured");
    expect(ledger.results).toHaveLength(1);
  });

  it("deletes conversation history after retention expires", async () => {
    const userId = crypto.randomUUID();
    const modelId = "cleanup_model_" + crypto.randomUUID();
    const providerId = "cleanup_provider_" + crypto.randomUUID();
    const credentialId = "cleanup_credential_" + crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,'Cleanup Provider','test','https://provider.test/v1',1,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(providerId),
      env.DB.prepare("INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Cleanup Credential','test',1,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(credentialId, providerId),
      env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'cleanup','Cleanup Test','chat',1,0,8000,1000,'{}',1,'{}','2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(modelId, providerId, credentialId),
      env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,active_conversation_id,active_chat_model_id,created_at,updated_at) VALUES (?1,?2,'2026-09-28',?3,?4,'2026-09-28T00:00:00Z','2026-09-28T00:00:00Z')").bind(userId, 980000004, conversationId, modelId),
      env.DB.prepare("INSERT INTO conversations (id,user_id,title,model_id,created_at,updated_at,expires_at) VALUES (?1,?2,'Expired dialog',?3,'2026-09-27T00:00:00Z','2026-09-27T01:00:00Z','2026-09-27T23:59:00Z')").bind(conversationId, userId, modelId),
      env.DB.prepare("INSERT INTO conversation_turns (id,conversation_id,user_text,assistant_text,model_id,created_at,updated_at) VALUES (?1,?2,'hello','world',?3,'2026-09-27T01:00:00Z','2026-09-27T01:00:00Z')").bind(crypto.randomUUID(), conversationId, modelId),
    ]);
    await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.parse("2026-09-28T00:00:00Z"), type: "scheduled", noRetry: () => undefined } as ScheduledController, env);
    const conversation = await env.DB.prepare("SELECT id FROM conversations WHERE id=?1").bind(conversationId).first<{id:string}>();
    const turns = await env.DB.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE conversation_id=?1").bind(conversationId).first<{count:number}>();
    const user = await env.DB.prepare("SELECT active_conversation_id FROM users WHERE id=?1").bind(userId).first<{active_conversation_id:string|null}>();
    expect(conversation).toBeNull();
    expect(turns?.count).toBe(0);
    expect(user?.active_conversation_id).toBeNull();
  });
});
