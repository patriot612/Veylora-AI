import { ProviderGatewayError, type GatewayRequest, type GatewayResponse, type ProviderAdapter } from "./types";

type ChatCompletion = {
  id?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
};

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new ProviderGatewayError("provider_unsupported", "Provider endpoint must use HTTPS", false);
  return endpoint.replace(/\/+$/, "");
}

function readTextContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .filter((item): item is { type?: unknown; text?: unknown } => item !== null && typeof item === "object")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean);
  return parts.length > 0 ? parts.join("") : null;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

export function createOpenAICompatibleAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "openai_compatible",
    async invoke(request: GatewayRequest): Promise<GatewayResponse> {
      if (request.operationType !== "chat" && request.operationType !== "search") {
        throw new ProviderGatewayError("provider_unsupported", "OpenAI-compatible adapter currently supports text operations only", false);
      }

      const endpoint = normalizeEndpoint(request.endpoint);
      const response = await fetchImpl(endpoint + "/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + request.credential,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.providerModelId,
          messages: request.messages ?? [],
          max_tokens: request.maxOutputTokens,
          ...(request.config ?? {}),
        }),
        signal: request.signal,
      });

      if (response.status === 429) {
        throw new ProviderGatewayError(
          "provider_rate_limited",
          "Provider rate limit reached",
          true,
          { retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")) },
        );
      }

      if (response.status >= 500) {
        throw new ProviderGatewayError("provider_unavailable", "Provider returned a server error", true);
      }

      if (!response.ok) {
        throw new ProviderGatewayError("provider_rejected", "Provider rejected the request", false);
      }

      let payload: ChatCompletion;
      try {
        payload = await response.json() as ChatCompletion;
      } catch (error) {
        throw new ProviderGatewayError("provider_invalid_response", "Provider returned invalid JSON", false, { cause: error });
      }

      const text = readTextContent(payload.choices?.[0]?.message?.content);
      if (!text) throw new ProviderGatewayError("provider_invalid_response", "Provider response did not contain text content", false);

      return { ok: true, kind: "text", text, providerRequestId: payload.id };
    },
  };
}
