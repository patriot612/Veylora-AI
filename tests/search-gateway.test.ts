import { describe, expect, it } from "vitest";
import { getSearchProviderConfig, searchViaGateway } from "../src/search/gateway";

describe("Search Gateway", () => {
  it("prefers the configured primary and forwards the authentication header", async () => {
    const calls: Array<{host:string;token:string;language:string;categories:string;timeRange:string;safeSearch:string}> = [];
    const payload = { results: [{ title: "Primary", url: "https://example.com/primary", content: "primary" }] };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      const headers = (init?.headers as Record<string,string>) ?? {};
      calls.push({ host: url.hostname, token: String(headers["x-veylora-search-token"] ?? ""), language: url.searchParams.get("language") ?? "", categories: url.searchParams.get("categories") ?? "", timeRange: url.searchParams.get("time_range") ?? "", safeSearch: url.searchParams.get("safesearch") ?? "" });
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await searchViaGateway({ primaryUrl: "https://primary.example", fallbackUrl: "https://fallback.example", enabled: true, maxQueryChars: 1000, language: "ru", categories: "general", timeRange: "week", safeSearch: 2, authToken: "secret" }, "hello", fetchImpl, 1000);
    expect(result).toEqual(payload);
    expect(calls).toEqual([{ host: "primary.example", token: "secret", language: "ru", categories: "general", timeRange: "week", safeSearch: "2" }]);
  });

  it("falls back to the secondary provider after a primary failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const host = new URL(input.toString()).hostname;
      calls.push(host);
      if (host === "primary.example") throw new Error("primary_down");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const result = await searchViaGateway({ primaryUrl: "https://primary.example", fallbackUrl: "https://fallback.example", enabled: true, maxQueryChars: 1000, language: "all", categories: "general", timeRange: "", safeSearch: 0 }, "hello", fetchImpl, 1000);
    expect(result).toEqual({ results: [] });
    expect(calls).toEqual(["primary.example", "fallback.example"]);
  });

  it("builds config with env primary fallback when D1 config is absent", async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind() {
            return {
              async first<T>() {
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


it("never reads the Search auth token from D1 configuration", async () => {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>() {
              if (sql.includes("search.auth_token")) return "should-not-be-read" as T;
              return undefined as T | undefined;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const config = await getSearchProviderConfig(db, "https://env.example", "server-secret");
  expect(config.authToken).toBe("server-secret");
});
