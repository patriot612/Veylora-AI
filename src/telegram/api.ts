export type TelegramApiResult<T> = {
  ok: true;
  result: T;
};

export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TelegramApiError";
  }
}

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
};

export async function telegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!botToken) throw new TelegramApiError("telegram_bot_token_missing", method, false);

  const response = await fetchImpl(
    "https://api.telegram.org/bot" + botToken + "/" + method,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  let body: TelegramResponse<T> | null = null;
  try {
    body = await response.json() as TelegramResponse<T>;
  } catch (error) {
    throw new TelegramApiError("telegram_invalid_response", method, response.status >= 500, undefined, { cause: error });
  }

  if (response.status === 429) {
    throw new TelegramApiError(
      body?.description ?? "telegram_rate_limited",
      method,
      true,
      body?.parameters?.retry_after,
    );
  }

  if (response.status >= 500) {
    throw new TelegramApiError(body?.description ?? "telegram_server_error", method, true);
  }

  if (!response.ok || body?.ok !== true) {
    throw new TelegramApiError(body?.description ?? "telegram_request_failed", method, false);
  }

  return body.result as T;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ message_id: number }> {
  return telegramApi<{ message_id: number }>(
    botToken,
    "sendMessage",
    { chat_id: chatId, text, ...extra },
    fetchImpl,
  );
}

export async function editTelegramMessage(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ message_id: number; text?: string }> {
  return telegramApi<{ message_id: number; text?: string }>(
    botToken,
    "editMessageText",
    { chat_id: chatId, message_id: messageId, text, ...extra },
    fetchImpl,
  );
}

export async function sendTelegramPhoto(
  botToken: string,
  chatId: number,
  source: { url?: string; bytes?: Uint8Array; contentType?: string },
  extra: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ message_id: number }> {
  if (source.url) {
    return telegramApi<{ message_id: number }>(
      botToken,
      "sendPhoto",
      { chat_id: chatId, photo: source.url, ...extra },
      fetchImpl,
    );
  }

  if (!source.bytes) {
    throw new TelegramApiError("telegram_photo_source_missing", "sendPhoto", false);
  }

  const form = new FormData();
  form.set("chat_id", String(chatId));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const type = source.contentType ?? "image/png";
  form.set("photo", new File([source.bytes], "image." + (type === "image/jpeg" ? "jpg" : "png"), { type }));

  const response = await fetchImpl(
    "https://api.telegram.org/bot" + botToken + "/sendPhoto",
    { method: "POST", body: form },
  );

  let body: TelegramResponse<{ message_id: number }> | null = null;
  try {
    body = await response.json() as TelegramResponse<{ message_id: number }>;
  } catch (error) {
    throw new TelegramApiError("telegram_invalid_response", "sendPhoto", response.status >= 500, undefined, { cause: error });
  }

  if (response.status === 429) {
    throw new TelegramApiError(
      body?.description ?? "telegram_rate_limited",
      "sendPhoto",
      true,
      body?.parameters?.retry_after,
    );
  }
  if (response.status >= 500) {
    throw new TelegramApiError(body?.description ?? "telegram_server_error", "sendPhoto", true);
  }
  if (!response.ok || body?.ok !== true || !body.result) {
    throw new TelegramApiError(body?.description ?? "telegram_request_failed", "sendPhoto", false);
  }
  return body.result;
}
