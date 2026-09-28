import { describe, expect, it } from "vitest";
import { classifyTelegramUpdate } from "../src/telegram/router";

describe("Telegram update router", () => {
  it("classifies commands and preserves server-derived Telegram identity", () => {
    const result = classifyTelegramUpdate({
      update_id: 101,
      message: {
        from: { id: 42, username: "user", first_name: "Test" },
        text: "/start",
      },
    });

    expect(result).toEqual({
      update_id: 101,
      user: { id: 42, username: "user", first_name: "Test" },
      kind: "command",
    });
  });

  it("classifies heavy media inputs independently from text", () => {
    expect(
      classifyTelegramUpdate({
        update_id: 102,
        message: { from: { id: 42 }, document: { file_id: "x" } },
      }).kind,
    ).toBe("document");

    expect(
      classifyTelegramUpdate({
        update_id: 103,
        message: { from: { id: 42 }, voice: { file_id: "x" } },
      }).kind,
    ).toBe("voice");
  });

  it("rejects updates without an integer update_id", () => {
    expect(() => classifyTelegramUpdate({ update_id: "101" })).toThrow("invalid_update_id");
  });
});
