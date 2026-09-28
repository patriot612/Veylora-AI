export type ConversationSummary = {
  id: string;
  title: string;
  modelId: string;
  roleId: string | null;
  updatedAt: string;
  archivedAt: string | null;
  expiresAt: string | null;
};

export type ConversationTurn = {
  id: string;
  userText: string;
  assistantText: string;
  modelId: string;
  roleId: string | null;
  createdAt: string;
};

export async function listActiveConversations(db: D1Database, userId: string): Promise<ConversationSummary[]> {
  const result = await db.prepare(
    "SELECT id,title,model_id,role_id,updated_at,archived_at,expires_at FROM conversations WHERE user_id=?1 AND archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC",
  ).bind(userId).all<ConversationRow>();
  return (result.results ?? []).map(toSummary);
}

export async function listArchivedConversations(db: D1Database, userId: string): Promise<ConversationSummary[]> {
  const result = await db.prepare(
    "SELECT id,title,model_id,role_id,updated_at,archived_at,expires_at FROM conversations WHERE user_id=?1 AND archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC",
  ).bind(userId).all<ConversationRow>();
  return (result.results ?? []).map(toSummary);
}

export async function getConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const row = await db.prepare(
    "SELECT id,title,model_id,role_id,updated_at,archived_at,expires_at FROM conversations WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL",
  ).bind(conversationId, userId).first<ConversationRow>();
  return row ? toSummary(row) : null;
}

export async function getConversationHistory(
  db: D1Database,
  userId: string,
  conversationId: string,
): Promise<ConversationTurn[]> {
  const result = await db.prepare(
    "SELECT id,user_text,assistant_text,model_id,role_id,created_at FROM conversation_turns WHERE conversation_id=?1 AND EXISTS (SELECT 1 FROM conversations WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL) ORDER BY created_at ASC",
  ).bind(conversationId, userId).all<TurnRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    userText: row.user_text,
    assistantText: row.assistant_text,
    modelId: row.model_id,
    roleId: row.role_id,
    createdAt: row.created_at,
  }));
}

export async function createNewConversation(
  db: D1Database,
  input: { userId: string; title?: string; now: string; expiresAt: string },
): Promise<ConversationSummary> {
  const user = await db.prepare(
    "SELECT active_chat_model_id FROM users WHERE id=?1",
  ).bind(input.userId).first<{ active_chat_model_id: string | null }>();

  if (!user) throw new Error("user_not_found");
  if (!user.active_chat_model_id) throw new Error("chat_model_not_selected");

  const model = await db.prepare(
    "SELECT id FROM models WHERE id=?1 AND type='chat' AND enabled=1",
  ).bind(user.active_chat_model_id).first<{ id: string }>();
  if (!model) throw new Error("chat_model_unavailable");

  const id = crypto.randomUUID();
  const title = (input.title ?? "Новый диалог").trim().slice(0, 120) || "Новый диалог";

  await db.batch([
    db.prepare(
      "INSERT INTO conversations (id,user_id,title,model_id,role_id,created_at,updated_at,expires_at) VALUES (?1,?2,?3,?4,NULL,?5,?5,?6)",
    ).bind(id, input.userId, title, model.id, input.now, input.expiresAt),
    db.prepare(
      "UPDATE users SET active_conversation_id=?2, updated_at=?3 WHERE id=?1",
    ).bind(input.userId, id, input.now),
  ]);

  return {
    id,
    title,
    modelId: model.id,
    roleId: null,
    updatedAt: input.now,
    archivedAt: null,
    expiresAt: input.expiresAt,
  };
}

export async function continueConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  now: string,
): Promise<ConversationSummary> {
  const row = await db.prepare(
    "SELECT id,title,model_id,role_id,updated_at,archived_at,expires_at FROM conversations WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL",
  ).bind(conversationId, userId).first<ConversationRow>();

  if (!row) throw new Error("conversation_not_found");
  if (row.archived_at) throw new Error("conversation_archived");
  if (row.expires_at && row.expires_at <= now) throw new Error("conversation_expired");

  await db.prepare(
    "UPDATE users SET active_conversation_id=?2, active_chat_model_id=?3, active_role_id=?4, updated_at=?5 WHERE id=?1",
  ).bind(userId, row.id, row.model_id, row.role_id, now).run();

  return toSummary(row);
}

export async function renameConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  title: string,
  now: string,
): Promise<boolean> {
  const safeTitle = title.trim().slice(0, 120);
  if (!safeTitle) return false;
  const result = await db.prepare(
    "UPDATE conversations SET title=?3,updated_at=?4 WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL",
  ).bind(conversationId, userId, safeTitle, now).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function archiveConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  now: string,
): Promise<boolean> {
  const result = await db.batch([
    db.prepare(
      "UPDATE conversations SET archived_at=?3,updated_at=?3 WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL AND archived_at IS NULL",
    ).bind(conversationId, userId, now),
    db.prepare(
      "UPDATE users SET active_conversation_id=NULL, active_role_id=NULL, updated_at=?2 WHERE id=?1 AND active_conversation_id=?3",
    ).bind(userId, now, conversationId),
  ]);
  return (result[0].meta.changes ?? 0) === 1;
}

export async function restoreConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  now: string,
): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE conversations SET archived_at=NULL,updated_at=?3 WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL AND archived_at IS NOT NULL",
  ).bind(conversationId, userId, now).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function deleteArchivedConversation(
  db: D1Database,
  userId: string,
  conversationId: string,
  now: string,
): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE conversations SET deleted_at=?3,updated_at=?3 WHERE id=?1 AND user_id=?2 AND deleted_at IS NULL AND archived_at IS NOT NULL",
  ).bind(conversationId, userId, now).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function setChatModel(
  db: D1Database,
  userId: string,
  modelId: string,
  now: string,
): Promise<boolean> {
  const model = await db.prepare(
    "SELECT id FROM models WHERE id=?1 AND type='chat' AND enabled=1",
  ).bind(modelId).first<{ id: string }>();
  if (!model) return false;

  const result = await db.batch([
    db.prepare(
      "UPDATE users SET active_chat_model_id=?2,active_role_id=NULL,updated_at=?3 WHERE id=?1",
    ).bind(userId, modelId, now),
    db.prepare(
      "UPDATE conversations SET role_id=NULL,updated_at=?2 WHERE id=(SELECT active_conversation_id FROM users WHERE id=?1) AND user_id=?1 AND archived_at IS NULL AND deleted_at IS NULL",
    ).bind(userId, now),
  ]);

  return (result[0].meta.changes ?? 0) === 1;
}

export async function setConversationRole(
  db: D1Database,
  userId: string,
  conversationId: string,
  roleId: string | null,
  now: string,
): Promise<boolean> {
  if (roleId) {
    const role = await db.prepare(
      "SELECT id FROM ai_roles WHERE id=?1 AND enabled=1",
    ).bind(roleId).first<{ id: string }>();
    if (!role) return false;
  }

  const result = await db.prepare(
    "UPDATE conversations SET role_id=?3,updated_at=?4 WHERE id=?1 AND user_id=?2 AND archived_at IS NULL AND deleted_at IS NULL",
  ).bind(conversationId, userId, roleId, now).run();

  if ((result.meta.changes ?? 0) !== 1) return false;

  await db.prepare(
    "UPDATE users SET active_role_id=?3,updated_at=?4 WHERE id=?1 AND active_conversation_id=?2",
  ).bind(userId, conversationId, roleId, now).run();

  return true;
}

export async function listEnabledRoles(db: D1Database): Promise<Array<{ id: string; name: string; description: string }>> {
  const result = await db.prepare(
    "SELECT id,name,description FROM ai_roles WHERE enabled=1 ORDER BY name ASC",
  ).all<{ id: string; name: string; description: string }>();
  return result.results ?? [];
}

type ConversationRow = {
  id: string;
  title: string;
  model_id: string;
  role_id: string | null;
  updated_at: string;
  archived_at: string | null;
  expires_at: string | null;
};

type TurnRow = {
  id: string;
  user_text: string;
  assistant_text: string;
  model_id: string;
  role_id: string | null;
  created_at: string;
};

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    roleId: row.role_id,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
  };
}
