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
  const photoBuffer = source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength) as ArrayBuffer;
  form.set("photo", new File([photoBuffer], "image." + (type === "image/jpeg" ? "jpg" : "png"), { type }));

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

export async function getTelegramFile(
  botToken: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ file_path: string }> {
  return telegramApi<{ file_path: string }>(botToken, "getFile", { file_id: fileId }, fetchImpl);
}

export async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  maxBytes = 20 * 1024 * 1024,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const response = await fetchImpl("https://api.telegram.org/file/bot" + botToken + "/" + filePath);
  if (!response.ok) throw new TelegramApiError("telegram_file_download_failed", "getFile", response.status >= 500);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new TelegramApiError("telegram_file_too_large", "getFile", false);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new TelegramApiError("telegram_file_too_large", "getFile", false);
  return {
    bytes,
    contentType: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
  };
}

export async function sendTelegramVoice(
  botToken: string,
  chatId: number,
  source: { url?: string; bytes?: Uint8Array; contentType?: string },
  extra: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ message_id: number }> {
  if (source.url) {
    return telegramApi<{ message_id: number }>(
      botToken,
      "sendVoice",
      { chat_id: chatId, voice: source.url, ...extra },
      fetchImpl,
    );
  }
  if (!source.bytes) throw new TelegramApiError("telegram_voice_source_missing", "sendVoice", false);

  const form = new FormData();
  form.set("chat_id", String(chatId));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const type = source.contentType ?? "audio/ogg";
  const buffer = source.bytes.buffer.slice(source.bytes.byteOffset, source.bytes.byteOffset + source.bytes.byteLength) as ArrayBuffer;
  const ext = type.includes("mpeg") ? "mp3" : type.includes("mp4") || type.includes("m4a") ? "m4a" : "ogg";
  form.set("voice", new File([buffer], "voice." + ext, { type }));

  const response = await fetchImpl(
    "https://api.telegram.org/bot" + botToken + "/sendVoice",
    { method: "POST", body: form },
  );
  let body: TelegramResponse<{ message_id: number }> | null = null;
  try {
    body = await response.json() as TelegramResponse<{ message_id: number }>;
  } catch (error) {
    throw new TelegramApiError("telegram_invalid_response", "sendVoice", response.status >= 500, undefined, { cause: error });
  }
  if (response.status === 429) {
    throw new TelegramApiError(body?.description ?? "telegram_rate_limited", "sendVoice", true, body?.parameters?.retry_after);
  }
  if (response.status >= 500) throw new TelegramApiError(body?.description ?? "telegram_server_error", "sendVoice", true);
  if (!response.ok || body?.ok !== true || !body.result) throw new TelegramApiError(body?.description ?? "telegram_request_failed", "sendVoice", false);
  return body.result;
}

export async function sendTelegramInvoice(
  botToken: string,
  chatId: number,
  invoice: {
    title: string;
    description: string;
    payload: string;
    currency: "XTR";
    amount: number;
    startParameter?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ message_id: number }> {
  return telegramApi<{ message_id: number }>(
    botToken,
    "sendInvoice",
    {
      chat_id: chatId,
      title: invoice.title,
      description: invoice.description,
      payload: invoice.payload,
      currency: invoice.currency,
      prices: [{ label: invoice.title, amount: invoice.amount }],
      ...(invoice.startParameter ? { start_parameter: invoice.startParameter } : {}),
      provider_token: "",
    },
    fetchImpl,
  );
}

export async function answerPreCheckoutQuery(
  botToken: string,
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  await telegramApi(
    botToken,
    "answerPreCheckoutQuery",
    {
      pre_checkout_query_id: preCheckoutQueryId,
      ok,
      ...(ok ? {} : { error_message: errorMessage ?? "Payment validation failed." }),
    },
    fetchImpl,
  );
  return true;
}

export async function refundTelegramStarPayment(
  botToken: string,
  userTelegramId: number,
  telegramPaymentChargeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  await telegramApi(
    botToken,
    "refundStarPayment",
    {
      user_id: userTelegramId,
      telegram_payment_charge_id: telegramPaymentChargeId,
    },
    fetchImpl,
  );
  return true;
}
