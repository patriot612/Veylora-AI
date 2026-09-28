export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function hasValidWebhookSecret(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === expected;
}

export function isTelegramWebhookPath(pathname: string): boolean {
  return pathname === "/telegram/webhook";
}
