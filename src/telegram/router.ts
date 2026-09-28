export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

export type TelegramUpdateKind =
  | "command"
  | "text"
  | "callback"
  | "document"
  | "photo"
  | "voice"
  | "pre_checkout"
  | "payment"
  | "unknown";

export type TelegramUpdateEnvelope = {
  update_id: number;
  user?: TelegramUser;
  kind: TelegramUpdateKind;
  chat_id?: number;
  message_id?: number;
  text?: string;
};

export function classifyTelegramUpdate(update: Record<string, unknown>): TelegramUpdateEnvelope {
  const updateId = update.update_id;
  if (typeof updateId !== "number" || !Number.isInteger(updateId)) {
    throw new Error("invalid_update_id");
  }

  if (isRecord(update.message)) {
    const message = update.message;
    const user = asTelegramUser(message.from);
    const text = typeof message.text === "string" ? message.text : undefined;
    const chatId = isRecord(message.chat) && typeof message.chat.id === "number" ? message.chat.id : undefined;
    const messageId = typeof message.message_id === "number" && Number.isInteger(message.message_id) ? message.message_id : undefined;
    const meta = { ...(chatId !== undefined ? { chat_id: chatId } : {}), ...(messageId !== undefined ? { message_id: messageId } : {}) };
    if (text?.startsWith("/")) return { update_id: updateId, user, kind: "command", ...meta };
    if (text) return { update_id: updateId, user, kind: "text", ...meta, text };
    if (isRecord(message.document)) return { update_id: updateId, user, kind: "document", ...meta };
    if (Array.isArray(message.photo)) return { update_id: updateId, user, kind: "photo", ...meta };
    if (isRecord(message.voice)) return { update_id: updateId, user, kind: "voice", ...meta };
    if (isRecord(message.successful_payment)) return { update_id: updateId, user, kind: "payment", ...meta };
    return { update_id: updateId, user, kind: "unknown", chat_id: chatId, message_id: messageId };
  }

  if (isRecord(update.callback_query)) {
    return { update_id: updateId, user: asTelegramUser(update.callback_query.from), kind: "callback" };
  }

  if (isRecord(update.pre_checkout_query)) {
    return { update_id: updateId, user: asTelegramUser(update.pre_checkout_query.from), kind: "pre_checkout" };
  }

  if (isRecord(update.my_chat_member)) {
    return { update_id: updateId, user: asTelegramUser(update.my_chat_member.from), kind: "unknown" };
  }

  return { update_id: updateId, kind: "unknown" };
}

function asTelegramUser(value: unknown): TelegramUser | undefined {
  if (!isRecord(value) || typeof value.id !== "number" || !Number.isInteger(value.id)) return undefined;
  return {
    id: value.id,
    ...(typeof value.username === "string" ? { username: value.username } : {}),
    ...(typeof value.first_name === "string" ? { first_name: value.first_name } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
