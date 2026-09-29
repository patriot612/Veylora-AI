export type ModelType = "chat" | "search" | "image" | "voice";

export type UserSelectableModel = {
  id: string;
  familyId: string;
  familyName: string;
  displayName: string;
  type: ModelType;
  pointsCost: number;
  subscriptionOnly: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: Record<string, unknown>;
};

export type ResolvedModel = UserSelectableModel & {
  providerId: string;
  providerAdapterType: string;
  endpoint: string;
  credentialId: string;
  credentialSecret: string;
  providerModelId: string;
  config: Record<string, unknown>;
};