import { describe, expect, it } from "vitest";
import { getSearchProviderConfig, searchViaGateway } from "../src/search/gateway";

describe("Search Gateway", () => {
  it("prefers the configured primary and forwards the authentication header", async () => {
    const calls: string[] = [];
    const payload = { results: [{ title: "Primary", url: "https://example.com/primary", content: "primary" }] };
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(new URL(input.toString()).hostname + ":" + String((init?.headers as Record<string,string>)?.["x-veylora-search-token"] ?? ""));
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await searchViaGateway({ primaryUrl: "https://primary.example", fallbackUrl: "https://fallback.example", enabled: true, maxQueryChars: 1000, authToken: "secret" }, "hello", fetchImpl, 1000);
    expect(result).toEqual(payload);
    expect(calls).toEqual(["primary.example:secret"]);
  });

  it("falls back to the secondary provider after a primary failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const host = new URL(input.toString()).hostname;
      calls.push(host);
      if (host === "primary.example") throw new Error("primary_down");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const result = await searchViaGateway({ primaryUrl: "https://primary.example", fallbackUrl: "https://fallback.example", enabled: true, maxQueryChars: 1000 }, "hello", fetchImpl, 1000);
    expect(result).toEqual({ results: [] });
    expect(calls).toEqual(["primary.example", "fallback.example"]);
  });

  it("builds config with env primary fallback when D1 config is absent", async () => {
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first<T>() {
                const key = sql.match(/config_key=\?1/) ? "" : "";
                return undefined as T | undefined;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const config = await getSearchProviderConfig(db, "https://env.example");
    expect(config.primaryUrl).toBe("https://env.example");
    expect(config.enabled).toBe(true);
    expect(config.maxQueryChars).toBe(1000);
  });
});
