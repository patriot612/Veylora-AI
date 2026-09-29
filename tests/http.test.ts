import { describe, expect, it } from "vitest";
import { hasValidWebhookSecret, isTelegramWebhookPath } from "../src/http";

describe("Telegram webhook boundary", () => {
  it("accepts the exact configured secret", () => {
    const request = new Request("https://example.test/telegram/webhook", {
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    });

    expect(hasValidWebhookSecret(request, "secret")).toBe(true);
  });

  it("rejects missing or different secrets", () => {
    const request = new Request("https://example.test/telegram/webhook");

    expect(hasValidWebhookSecret(request, "secret")).toBe(false);
    expect(hasValidWebhookSecret(request, undefined)).toBe(false);
  });

  it("recognizes only the dedicated webhook route", () => {
    expect(isTelegramWebhookPath("/telegram/webhook")).toBe(true);
    expect(isTelegramWebhookPath("/telegram/webhook/other")).toBe(false);
  });
});
