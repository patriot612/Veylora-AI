import { resolveModel } from "../models/registry";
import type { ModelType } from "../models/types";
import { ProviderGatewayError, type GatewayMessage, type ProviderAdapter } from "../providers/types";

export type GatewayTextRequest = {
  userId: string;
  modelId: string;
  modelType: Extract<ModelType, "chat" | "search">;
  messages: GatewayMessage[];
  now: string;
  timeoutMs?: number;
};

export type GatewayTextResult = {
  text: string;
  providerRequestId?: string;
  modelId: string;
};

export class AIGateway {
  constructor(
    private readonly db: D1Database,
    private readonly encryptionKey: string,
    private readonly adapters: Map<string, ProviderAdapter>,
  ) {}

  async generateText(input: GatewayTextRequest): Promise<GatewayTextResult> {
    const model = await resolveModel(this.db, {
      userId: input.userId,
      modelId: input.modelId,
      expectedType: input.modelType,
      now: input.now,
      credentialEncryptionKey: this.encryptionKey,
    });

    const adapter = this.adapters.get(model.providerAdapterType);
    if (!adapter) throw new ProviderGatewayError("provider_unsupported", "Provider adapter is not configured", false);

    const controller = new AbortController();
    const timeout = input.timeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort("provider_timeout"), timeout);

    try {
      const response = await adapter.invoke({
        operationType: model.type,
        providerModelId: model.providerModelId,
        endpoint: model.endpoint,
        credential: model.credentialSecret,
        messages: input.messages,
        maxOutputTokens: model.maxOutputTokens ?? undefined,
        config: model.config,
        signal: controller.signal,
      });

      if (response.kind !== "text") throw new ProviderGatewayError("provider_invalid_response", "Provider returned an unsupported response", true);
      return { text: response.text, providerRequestId: response.providerRequestId, modelId: model.id };
    } catch (error) {
      if (error instanceof ProviderGatewayError) throw error;
      if (controller.signal.aborted) throw new ProviderGatewayError("provider_timeout", "Provider request timed out", true, { cause: error });
      throw new ProviderGatewayError("provider_unavailable", "Provider request failed", true, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createAIGateway(db: D1Database, encryptionKey: string, adapters: ProviderAdapter[]): AIGateway {
  return new AIGateway(db, encryptionKey, new Map(adapters.map((adapter) => [adapter.type, adapter])));
}