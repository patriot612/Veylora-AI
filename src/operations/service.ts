export type OperationType = "chat" | "search" | "image" | "voice" | "document" | "payment" | "admin";
export type OperationStatus = "created" | "reserved" | "queued" | "processing" | "delivering" | "succeeded" | "failed" | "timeout" | "cancelled";

export type OperationRecord = {
  id: string;
  userId: string;
  type: OperationType;
  status: OperationStatus;
  telegramUpdateId: number | null;
  requestHash: string | null;
  modelId: string | null;
  conversationId: string | null;
  pointsCost: number;
};

const TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  created: ["reserved", "queued", "failed", "cancelled"],
  reserved: ["queued", "processing", "failed", "timeout", "cancelled"],
  queued: ["processing", "failed", "timeout", "cancelled"],
  processing: ["delivering", "failed", "timeout", "cancelled"],
  delivering: ["succeeded", "failed", "timeout", "cancelled"],
  succeeded: [],
  failed: [],
  timeout: [],
  cancelled: [],
};

export async function createOperation(
  db: D1Database,
  input: { userId: string; type: OperationType; telegramUpdateId?: number; requestHash?: string; modelId?: string; conversationId?: string; pointsCost?: number; now: string },
): Promise<{ operation: OperationRecord; duplicate: boolean }> {
  if (input.pointsCost !== undefined && (!Number.isSafeInteger(input.pointsCost) || input.pointsCost < 0)) throw new Error("invalid_points_cost");

  if (input.telegramUpdateId !== undefined) {
    const existing = await db.prepare("SELECT id, user_id, type, status, telegram_update_id, request_hash, model_id, conversation_id, points_cost FROM operations WHERE telegram_update_id = ?1").bind(input.telegramUpdateId).first<OperationRow>();
    if (existing) {
      if (existing.user_id !== input.userId) throw new Error("update_owner_mismatch");
      return { operation: toOperation(existing), duplicate: true };
    }
  }

  const id = crypto.randomUUID();
  try {
    await db.prepare("INSERT INTO operations (id,user_id,telegram_update_id,type,status,model_id,conversation_id,points_cost,created_at,request_hash) VALUES (?1,?2,?3,?4,'created',?5,?6,?7,?8,?9)")
      .bind(id, input.userId, input.telegramUpdateId ?? null, input.type, input.modelId ?? null, input.conversationId ?? null, input.pointsCost ?? 0, input.now, input.requestHash ?? null).run();
  } catch (error) {
    if (input.telegramUpdateId !== undefined) {
      const existing = await db.prepare("SELECT id, user_id, type, status, telegram_update_id, request_hash, model_id, conversation_id, points_cost FROM operations WHERE telegram_update_id = ?1").bind(input.telegramUpdateId).first<OperationRow>();
      if (existing) {
        if (existing.user_id !== input.userId) throw new Error("update_owner_mismatch");
        return { operation: toOperation(existing), duplicate: true };
      }
    }
    throw error;
  }

  return {
    operation: { id, userId: input.userId, type: input.type, status: "created", telegramUpdateId: input.telegramUpdateId ?? null, requestHash: input.requestHash ?? null, modelId: input.modelId ?? null, conversationId: input.conversationId ?? null, pointsCost: input.pointsCost ?? 0 },
    duplicate: false,
  };
}

export async function getOperation(db: D1Database, operationId: string, userId: string): Promise<OperationRecord | null> {
  const row = await db.prepare("SELECT id, user_id, type, status, telegram_update_id, request_hash, model_id, conversation_id, points_cost FROM operations WHERE id = ?1 AND user_id = ?2").bind(operationId, userId).first<OperationRow>();
  return row ? toOperation(row) : null;
}

export async function transitionOperation(db: D1Database, input: { operationId: string; userId: string; to: OperationStatus; now: string; errorCode?: string; providerErrorCode?: string }): Promise<boolean> {
  const current = await getOperation(db, input.operationId, input.userId);
  if (!current) return false;
  if (current.status === input.to) return true;
  if (!TRANSITIONS[current.status].includes(input.to)) return false;

  const result = await db.prepare("UPDATE operations SET status = ?3, error_code = ?4, provider_error_code = ?5, started_at = CASE WHEN ?3 IN ('processing','delivering') AND started_at IS NULL THEN ?6 ELSE started_at END, finished_at = CASE WHEN ?3 IN ('succeeded','failed','timeout','cancelled') THEN ?6 ELSE finished_at END WHERE id = ?1 AND user_id = ?2 AND status = ?7")
    .bind(input.operationId, input.userId, input.to, input.errorCode ?? null, input.providerErrorCode ?? null, input.now, current.status).run();
  return (result.meta.changes ?? 0) === 1;
}

type OperationRow = { id: string; user_id: string; type: OperationType; status: OperationStatus; telegram_update_id: number | null; request_hash: string | null; model_id: string | null; conversation_id: string | null; points_cost: number };

function toOperation(row: OperationRow): OperationRecord {
  return { id: row.id, userId: row.user_id, type: row.type, status: row.status, telegramUpdateId: row.telegram_update_id, requestHash: row.request_hash, modelId: row.model_id, conversationId: row.conversation_id, pointsCost: row.points_cost };
}