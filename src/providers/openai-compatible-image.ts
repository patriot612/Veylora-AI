import { ProviderGatewayError, type GatewayRequest, type GatewayResponse, type ProviderAdapter } from "./types";

type ImageGenerationResponse = {
  data?: Array<{ url?: unknown; b64_json?: unknown }>;
};

export function createOpenAICompatibleImageAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "openai_compatible_image",
    async invoke(request: GatewayRequest): Promise<GatewayResponse> {
      if (request.operationType !== "image") {
        throw new ProviderGatewayError("provider_unsupported", "Image adapter only supports image operations", false);
      }

      const endpoint = new URL(request.endpoint);
      if (endpoint.protocol !== "https:") {
        throw new ProviderGatewayError("provider_unsupported", "Provider endpoint must use HTTPS", false);
      }
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/images/generations";

      const config = request.config ?? {};
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + request.credential,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.providerModelId,
          prompt: request.prompt ?? "",
          ...(typeof config.size === "string" ? { size: config.size } : {}),
          ...(typeof config.quality === "string" ? { quality: config.quality } : {}),
          ...(typeof config.format === "string" ? { output_format: config.format } : {}),
        }),
        signal: request.signal,
      });

      if (response.status === 429) {
        throw new ProviderGatewayError("provider_rate_limited", "Provider rate limit reached", true, {
          retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
        });
      }
      if (response.status >= 500) {
        throw new ProviderGatewayError("provider_unavailable", "Provider returned a server error", true);
      }
      if (!response.ok) {
        throw new ProviderGatewayError("provider_rejected", "Provider rejected the image request", false);
      }

      let body: ImageGenerationResponse;
      try {
        body = await response.json() as ImageGenerationResponse;
      } catch (error) {
        throw new ProviderGatewayError("provider_invalid_response", "Provider returned invalid image JSON", false, { cause: error });
      }

      const first = body.data?.[0];
      if (!first) throw new ProviderGatewayError("provider_invalid_response", "Provider returned no image", false);

      if (typeof first.url === "string" && first.url.startsWith("https://")) {
        return { ok: true, kind: "image", url: first.url, providerRequestId: response.headers.get("x-request-id") ?? undefined };
      }

      if (typeof first.b64_json === "string") {
        const bytes = Uint8Array.from(atob(first.b64_json), (char) => char.charCodeAt(0));
        return {
          ok: true,
          kind: "image",
          bytes,
          contentType: "image/png",
          providerRequestId: response.headers.get("x-request-id") ?? undefined,
        };
      }

      throw new ProviderGatewayError("provider_invalid_response", "Provider returned unsupported image payload", false);
    },
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
