import { describe, expect, it } from "vitest";
import { sendTelegramMessage, TelegramApiError } from "../src/telegram/api";

describe("Telegram API delivery errors", () => {
  it("marks 429 as retryable and preserves retry_after", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    await expect(sendTelegramMessage("bot", 123, "test", {}, fetchImpl)).rejects.toMatchObject({
      retryable: true,
      retryAfterSeconds: 3,
      method: "sendMessage",
    });
  });

  it("marks Telegram 5xx as retryable", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ ok: false, description: "Bad Gateway" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
    await expect(sendTelegramMessage("bot", 123, "test", {}, fetchImpl)).rejects.toMatchObject({
      retryable: true,
      method: "sendMessage",
    });
  });

  it("keeps Telegram 4xx business errors non-retryable", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({ ok: false, description: "Forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    try {
      await sendTelegramMessage("bot", 123, "test", {}, fetchImpl);
      throw new Error("expected TelegramApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramApiError);
      expect((error as TelegramApiError).retryable).toBe(false);
    }
  });
});
