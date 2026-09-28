import { createOpenAICompatibleAdapter } from "./openai-compatible";
import { createOpenAICompatibleImageAdapter } from "./openai-compatible-image";
import { createOpenAICompatibleVoiceAdapter } from "./openai-compatible-voice";
import type { ProviderAdapter } from "./types";

export function createDefaultProviderAdapters(): ProviderAdapter[] {
  return [createOpenAICompatibleAdapter(), createOpenAICompatibleImageAdapter(), createOpenAICompatibleVoiceAdapter()];
}
