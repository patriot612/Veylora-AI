import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { completeDocumentQuestionDelivery, enqueueDocumentUpload, processDocumentUploadJob, answerDocumentQuestion, enterDocumentsMode, releaseDocumentQuestionDelivery } from "../src/documents/service";
import { encryptCredentialSecret } from "../src/security/credentials";
import { createAIGateway } from "../src/ai-gateway";
import type { ProviderAdapter } from "../src/providers/types";

let tg = 970000000;
let seq = 0;
const key = "document-service-test-key";

async function seedUser() {
  const userId = crypto.randomUUID();
  const providerId = "document_provider_" + (++seq);
  const credentialId = "document_credential_" + seq;
  const modelId = "document_model_" + seq;
  await env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,active_mode,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'documents','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(userId, ++tg).run();
  await env.DB.prepare("INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'document_test','https://document.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(providerId, "Document Provider " + seq).run();
  await env.DB.prepare("INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Document',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(credentialId, providerId, await encryptCredentialSecret("secret", key)).run();
  await env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'document-chat','Document Chat','chat',3,0,8000,1000,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(modelId, providerId, credentialId).run();
  return { userId, modelId };
}

function queueMock() {
  const sent: unknown[] = [];
  return { queue: { send: async (body: unknown) => { sent.push(body); } } as unknown as Queue, sent };
}

function gateway() {
  const adapter: ProviderAdapter = {
    type: "document_test",
    async invoke() { return { ok: true, kind: "text", text: "Answer from document" }; },
  };
  return createAIGateway(env.DB, key, [adapter]);
}

describe("document service", () => {
  it("queues an upload as a reference-only message and charges once", async () => {
    const { userId } = await seedUser();
    await enterDocumentsMode(env.DB, userId, "2026-09-28T12:00:00Z");
    const { queue, sent } = queueMock();
    const result = await enqueueDocumentUpload({
      db: env.DB, queue, userId, fileId: "file-1", fileName: "report.txt",
      mimeType: "text/plain", chatId: 123, now: "2026-09-28T12:00:00Z",
    });
    expect(result).toHaveProperty("operationId");
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain("file-1");
    expect(JSON.stringify(sent[0])).not.toContain("base64");
    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    expect(user?.daily_points_remaining).toBe(48);
  });

  it("extracts and persists a document session, then retries only Telegram delivery", async () => {
    const { userId } = await seedUser();
    const { queue } = queueMock();
    const op = await enqueueDocumentUpload({
      db: env.DB, queue, userId, fileId: "file-2", fileName: "report.txt",
      mimeType: "text/plain", chatId: 123, now: "2026-09-28T12:00:00Z",
    });
    if (!("operationId" in op)) throw new Error("missing operation");

    let sendCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "docs/report.txt" } }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/file/bot")) return new Response(new TextEncoder().encode("hello cloudflare queue telegram"), { status: 200, headers: { "content-type": "text/plain" } });
      if (url.includes("/sendMessage")) { sendCalls += 1; return new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), { status: 200, headers: { "content-type": "application/json" } }); }
      throw new Error("unexpected " + url);
    };

    const first = await processDocumentUploadJob(
      { operationId: op.operationId, userId, metadata: { fileId: "file-2", fileType: "txt", chatId: 123 } },
      { db: env.DB, botToken: "bot", now: () => "2026-09-28T12:01:00Z", fetchImpl },
    );
    expect(first).toEqual({ ok: true });
    expect(sendCalls).toBe(1);

    const session = await env.DB.prepare("SELECT id FROM document_sessions WHERE user_id=?1").bind(userId).first<{id:string}>();
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE session_id=?1").bind(session?.id).first<{count:number}>();
    const opRow = await env.DB.prepare("SELECT status,telegram_delivery_status,temporary_result_ref FROM operations WHERE id=?1").bind(op.operationId).first<{status:string;telegram_delivery_status:string;temporary_result_ref:string|null}>();

    expect(session?.id).toBeTruthy();
    expect(chunks?.count).toBeGreaterThan(0);
    expect(opRow?.status).toBe("delivering");
    expect(opRow?.telegram_delivery_status).toBe("sent");
    expect(opRow?.temporary_result_ref).toBe(session?.id);

    const second = await processDocumentUploadJob(
      { operationId: op.operationId, userId, metadata: { fileId: "file-2", fileType: "txt", chatId: 123 } },
      { db: env.DB, botToken: "bot", now: () => "2026-09-28T12:02:00Z", fetchImpl },
    );
    expect(second).toEqual({ ok: true });
    expect(sendCalls).toBe(1);
  });

  it("answers document questions from top-ranked excerpts and settles the question charge", async () => {
    const { userId, modelId } = await seedUser();
    const sessionId = crypto.randomUUID();
    const expires = "2026-09-28T14:00:00Z";
    await env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',80,?3,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
      .bind(sessionId, userId, expires).run();
    await env.DB.prepare("UPDATE users SET active_document_session_id=?2, active_mode='documents' WHERE id=?1")
      .bind(userId, sessionId).run();
    await env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,?3,?4)")
      .bind(crypto.randomUUID(), sessionId, "cloudflare queue telegram evidence", expires).run();

    const result = await answerDocumentQuestion({
      db: env.DB,
      gateway: gateway(),
      userId,
      question: "What uses the queue?",
      now: "2026-09-28T12:05:00Z",
      modelId,
      encryptionKey: key,
    });

    expect(result).toHaveProperty("answer", "Answer from document");
    if ("operationId" in result) {
      const opBefore = await env.DB.prepare("SELECT status,telegram_delivery_status FROM operations WHERE id=?1").bind(result.operationId).first<{status:string;telegram_delivery_status:string}>();
      const reservationBefore = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(result.operationId).first<{status:string}>();
      expect(opBefore?.status).toBe("delivering");
      expect(opBefore?.telegram_delivery_status).toBe("pending");
      expect(reservationBefore?.status).toBe("reserved");

      const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
      expect(user?.daily_points_remaining).toBe(47);

      expect(await completeDocumentQuestionDelivery(env.DB, userId, result.operationId, "2026-09-28T12:06:00Z")).toBe(true);
      expect(await completeDocumentQuestionDelivery(env.DB, userId, result.operationId, "2026-09-28T12:07:00Z")).toBe(true);

      const opAfter = await env.DB.prepare("SELECT status,telegram_delivery_status FROM operations WHERE id=?1").bind(result.operationId).first<{status:string;telegram_delivery_status:string}>();
      const reservationAfter = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(result.operationId).first<{status:string}>();
      expect(opAfter?.status).toBe("succeeded");
      expect(opAfter?.telegram_delivery_status).toBe("sent");
      expect(reservationAfter?.status).toBe("captured");
    }
  });

  it("releases the document question reservation when Telegram delivery fails", async () => {
    const { userId, modelId } = await seedUser();
    const sessionId = crypto.randomUUID();
    const expires = "2026-09-28T14:00:00Z";
    await env.DB.prepare("INSERT INTO document_sessions (id,user_id,file_type,extracted_chars,expires_at,created_at,last_activity_at) VALUES (?1,?2,'txt',80,?3,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
      .bind(sessionId, userId, expires).run();
    await env.DB.prepare("UPDATE users SET active_document_session_id=?2, active_mode='documents' WHERE id=?1").bind(userId, sessionId).run();
    await env.DB.prepare("INSERT INTO document_chunks (id,session_id,chunk_index,content,expires_at) VALUES (?1,?2,0,?3,?4)")
      .bind(crypto.randomUUID(), sessionId, "document delivery failure context", expires).run();

    const result = await answerDocumentQuestion({
      db: env.DB,
      gateway: gateway(),
      userId,
      question: "What uses the document?",
      now: "2026-09-28T12:05:00Z",
      modelId,
      encryptionKey: key,
    });

    if (!("operationId" in result)) throw new Error("missing operation");
    expect(await releaseDocumentQuestionDelivery(env.DB, result.operationId, "2026-09-28T12:06:00Z", "telegram_429")).toBe(true);

    const user = await env.DB.prepare("SELECT daily_points_remaining FROM users WHERE id=?1").bind(userId).first<{daily_points_remaining:number}>();
    const reservation = await env.DB.prepare("SELECT status FROM point_reservations WHERE operation_id=?1").bind(result.operationId).first<{status:string}>();
    const operation = await env.DB.prepare("SELECT status,error_code FROM operations WHERE id=?1").bind(result.operationId).first<{status:string;error_code:string|null}>();
    expect(user?.daily_points_remaining).toBe(50);
    expect(reservation?.status).toBe("released");
    expect(operation?.status).toBe("failed");
    expect(operation?.error_code).toBe("telegram_429");
  });

});
