import type { ModelType } from "../models/types";

export type GatewayMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GatewayRequest = {
  operationType: ModelType;
  providerModelId: string;
  endpoint: string;
  credential: string;
  messages?: GatewayMessage[];
  prompt?: string;
  maxOutputTokens?: number;
  input?: ArrayBuffer;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type GatewayResponse =
  | { ok: true; kind: "text"; text: string; providerRequestId?: string; raw?: unknown }
  | { ok: true; kind: "binary"; bytes: Uint8Array; contentType: string; providerRequestId?: string };

export type ProviderGatewayErrorCode =
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_invalid_response"
  | "provider_rate_limited"
  | "provider_unsupported";

export class ProviderGatewayError extends Error {
  constructor(
    public readonly code: ProviderGatewayErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "ProviderGatewayError";
    this.retryAfterMs = options?.retryAfterMs;
  }

  readonly retryAfterMs?: number;
}

export interface ProviderAdapter {
  readonly type: string;
  invoke(request: GatewayRequest): Promise<GatewayResponse>;
};