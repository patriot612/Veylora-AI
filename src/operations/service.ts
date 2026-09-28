export type OperationType = "chat" | "search" | "image" | "voice" | "document" | "payment" | "admin";

export type OperationRecord = {
  id: string;
  userId: string;
  type: OperationType;
  status: "created";
  telegramUpdateId: number | null;
  requestHash: string | null;
};

export async function createOperation(
  db: D1Database,
  input: {
    userId: string;
    type: OperationType;
    telegramUpdateId?: number;
    requestHash?: string;
    modelId?: string;
    conversationId?: string;
    now: string;
  },
): Promise<OperationRecord> {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO operations (id,user_id,telegram_update_id,type,status,model_id,conversation_id,request_hash,created_at) VALUES (?1,?2,?3,?4,'created',?5,?6,?7,?8)`).bind(id,input.userId,input.telegramUpdateId??null,input.type,input.modelId??null,input.conversationId??null,input.requestHash??null,input.now).run();
  return { id, userId: input.userId, type: input.type, status: "created", telegramUpdateId: input.telegramUpdateId??null, requestHash: input.requestHash??null };
}
