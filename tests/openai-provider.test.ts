import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../src/providers/openai-compatible";
import { ProviderGatewayError } from "../src/providers/types";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("OpenAI-compatible provider adapter", () => {
  it("normalizes successful chat completion responses", async () => {
    const adapter = createOpenAICompatibleAdapter(async (input, init) => {
      expect(String(input)).toBe("https://provider.test/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      const payload = JSON.parse(String(init?.body)) as { model: string };
      expect(payload.model).toBe("vendor/model");
      return response(200, {
        id: "req-1",
        choices: [{ message: { content: "hello" } }],
      });
    });

    const result = await adapter.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "https://provider.test/v1",
      credential: "secret",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({ ok: true, kind: "text", text: "hello", providerRequestId: "req-1" });
  });

  it("marks 429 as retryable and preserves retry-after", async () => {
    const adapter = createOpenAICompatibleAdapter(async () => response(429, { error: "rate_limited" }, { "retry-after": "2" }));
    await expect(adapter.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "https://provider.test/v1",
      credential: "secret",
    })).rejects.toMatchObject({ code: "provider_rate_limited", retryable: true, retryAfterMs: 2000 });
  });

  it("marks 5xx transient and 4xx permanent", async () => {
    const unavailable = createOpenAICompatibleAdapter(async () => response(503, { error: "down" }));
    await expect(unavailable.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "https://provider.test/v1",
      credential: "secret",
    })).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });

    const rejected = createOpenAICompatibleAdapter(async () => response(400, { error: "bad" }));
    await expect(rejected.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "https://provider.test/v1",
      credential: "secret",
    })).rejects.toMatchObject({ code: "provider_rejected", retryable: false });
  });

  it("refuses non-HTTPS endpoints and invalid provider payloads", async () => {
    const adapter = createOpenAICompatibleAdapter(async () => response(200, { choices: [{ message: {} }] }));
    await expect(adapter.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "http://provider.test/v1",
      credential: "secret",
    })).rejects.toMatchObject({ code: "provider_unsupported", retryable: false });

    await expect(adapter.invoke({
      operationType: "chat",
      providerModelId: "vendor/model",
      endpoint: "https://provider.test/v1",
      credential: "secret",
    })).rejects.toMatchObject({ code: "provider_invalid_response", retryable: false });

    expect(ProviderGatewayError).toBeDefined();
  });
});
