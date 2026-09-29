import { ProviderGatewayError, type GatewayRequest, type GatewayResponse, type ProviderAdapter } from "./types";

export function createOpenAICompatibleVoiceAdapter(fetchImpl: typeof fetch = fetch): ProviderAdapter {
  return {
    type: "openai_compatible_voice",
    async invoke(request: GatewayRequest): Promise<GatewayResponse> {
      if (request.operationType !== "voice" || request.voiceMode !== "reply" || !request.input) {
        throw new ProviderGatewayError("provider_unsupported", "Voice adapter requires a reply audio input", false);
      }

      const config = request.config ?? {};
      const path = typeof config.voice_reply_path === "string" ? config.voice_reply_path : "/audio/replies";
      const endpoint = new URL(path, request.endpoint.endsWith("/") ? request.endpoint : request.endpoint + "/");
      if (endpoint.protocol !== "https:") {
        throw new ProviderGatewayError("provider_unsupported", "Provider endpoint must use HTTPS", false);
      }

      const form = new FormData();
      const contentType = request.inputContentType ?? "audio/ogg";
      const buffer = request.input.slice(0);
      form.set("file", new File([buffer], fileNameFor(contentType), { type: contentType }));
      form.set("model", request.providerModelId);
      if (typeof config.response_format === "string") form.set("response_format", config.response_format);
      if (typeof config.voice === "string") form.set("voice", config.voice);
      if (typeof config.instructions === "string") form.set("instructions", config.instructions);

      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + request.credential },
        body: form,
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
        throw new ProviderGatewayError("provider_rejected", "Provider rejected the voice request", false);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new ProviderGatewayError("provider_invalid_response", "Provider returned empty voice audio", false);
      }

      return {
        ok: true,
        kind: "binary",
        bytes,
        contentType: response.headers.get("content-type")?.split(";")[0] ?? "audio/ogg",
        providerRequestId: response.headers.get("x-request-id") ?? undefined,
      };
    },
  };
}

function fileNameFor(contentType: string): string {
  if (contentType.includes("mpeg")) return "voice.mp3";
  if (contentType.includes("wav")) return "voice.wav";
  if (contentType.includes("webm")) return "voice.webm";
  return "voice.ogg";
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
