import { describe, expect, it } from "vitest";
import { validateMiniAppInitData } from "../src/admin/auth";
import { env } from "./test-env";

async function hmacHex(keyText: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(sig, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function buildInitData(botToken: string, authDate: number, user: Record<string, unknown>) {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", "AA-test");
  params.set("user", JSON.stringify(user));

  const sorted = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheck = sorted.map(([key, value]) => key + "=" + value).join("\n");
  const secretBytesKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretBytesKey, new TextEncoder().encode(botToken));
  const second = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hashBytes = new Uint8Array(await crypto.subtle.sign("HMAC", second, new TextEncoder().encode(dataCheck)));
  params.set("hash", Array.from(hashBytes, (value) => value.toString(16).padStart(2, "0")).join(""));
  return params.toString();
}

describe("Telegram Mini App initData", () => {
  it("accepts valid initData and returns server-trusted identity", async () => {
    const now = 1_790_000_000;
    const initData = await buildInitData("test-bot-token", now - 30, {
      id: 123456789,
      username: "owner",
      first_name: "Owner",
    });
    const identity = await validateMiniAppInitData(initData, "test-bot-token", now);
    expect(identity.id).toBe(123456789);
    expect(identity.username).toBe("owner");
    expect(identity.firstName).toBe("Owner");
  });

  it("rejects tampered hashes, expired auth, and missing user", async () => {
    const now = 1_790_000_000;
    const valid = await buildInitData("test-bot-token", now - 30, { id: 123456789 });
    const tampered = valid.replace("query_id=AA-test", "query_id=AA-tampered");
    await expect(validateMiniAppInitData(tampered, "test-bot-token", now)).rejects.toThrow("admin_init_data_invalid");

    const expired = await buildInitData("test-bot-token", now - 90_000, { id: 123456789 });
    await expect(validateMiniAppInitData(expired, "test-bot-token", now)).rejects.toThrow("admin_init_data_expired");

    const params = new URLSearchParams(valid);
    params.delete("user");
    await expect(validateMiniAppInitData(params.toString(), "test-bot-token", now)).rejects.toThrow("admin_user_missing");
  });
});

describe("Admin API identity isolation", () => {
  it("does not expose role from client data and requires a server-known role", async () => {
    const user = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(user, 555000001).run();

    const { loadAdminSession } = await import("../src/admin/rbac");
    const none = await loadAdminSession(env.DB, {
      id: 555000001,
      rawUser: { id: 555000001, role: "owner" },
      authDate: 1_790_000_000,
    });
    expect(none).toBeNull();

    await env.DB.prepare(
      "INSERT INTO admin_roles(user_id,role,created_at,updated_at) VALUES (?1,'support','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
    ).bind(user).run();
    const support = await loadAdminSession(env.DB, {
      id: 555000001,
      rawUser: { id: 555000001, role: "owner" },
      authDate: 1_790_000_000,
    });
    expect(support?.role).toBe("support");
  });
});
