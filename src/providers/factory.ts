import { createOpenAICompatibleAdapter } from "./openai-compatible";
import type { ProviderAdapter } from "./types";

export function createDefaultProviderAdapters(): ProviderAdapter[] {
  return [createOpenAICompatibleAdapter()];
}
