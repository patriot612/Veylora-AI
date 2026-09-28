import { getActivePlan } from "../subscriptions";
import type { ModelType, ResolvedModel, UserSelectableModel } from "./types";
import { decryptCredentialSecret } from "../security/credentials";

type ListRow = {
  id: string;
  family_id: string;
  family_name: string;
  display_name: string;
  type: ModelType;
  points_cost: number;
  subscription_only: number;
  context_window: number | null;
  max_output_tokens: number | null;
  capabilities: string;
};

type ResolveRow = ListRow & {
  provider_id: string;
  provider_enabled: number;
  provider_adapter_type: string;
  endpoint: string;
  provider_model_id: string;
  credential_id: string;
  credential_enabled: number;
  encrypted_secret: string;
  config: string;
};

export async function listSelectableModels(
  db: D1Database,
  input: { userId: string; type: ModelType; now: string },
): Promise<UserSelectableModel[]> {
  const plan = await getActivePlan(db, input.userId, input.now);
  const result = await db.prepare(
    "SELECT m.id, m.family_id, f.name AS family_name, m.display_name, m.type, m.points_cost, m.subscription_only, m.context_window, m.max_output_tokens, m.capabilities FROM models m JOIN families f ON f.id = m.family_id WHERE m.type = ?1 AND m.enabled = 1 AND f.enabled = 1 ORDER BY f.sort_order ASC, m.display_name ASC",
  ).bind(input.type).all<ListRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    familyId: row.family_id,
    familyName: row.family_name,
    displayName: row.display_name,
    type: row.type,
    pointsCost: row.points_cost,
    subscriptionOnly: row.subscription_only === 1,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    capabilities: parseJsonObject(row.capabilities),
  })).filter((model) => !model.subscriptionOnly || plan !== null);
}

export async function resolveModel(
  db: D1Database,
  input: { userId: string; modelId: string; expectedType: ModelType; now: string; credentialEncryptionKey: string },
): Promise<ResolvedModel> {
  const row = await db.prepare(
    "SELECT m.id, m.family_id, f.name AS family_name, m.display_name, m.type, m.points_cost, m.subscription_only, m.context_window, m.max_output_tokens, m.capabilities, p.id AS provider_id, p.enabled AS provider_enabled, p.adapter_type AS provider_adapter_type, p.endpoint, m.provider_model_id, c.id AS credential_id, c.enabled AS credential_enabled, c.encrypted_secret, m.config FROM models m JOIN families f ON f.id = m.family_id JOIN providers p ON p.id = m.provider_id JOIN credentials c ON c.id = m.credential_id AND c.provider_id = p.id WHERE m.id = ?1 AND m.type = ?2 LIMIT 1",
  ).bind(input.modelId, input.expectedType).first<ResolveRow>();

  if (!row) throw new Error("model_not_found");
  if (row.provider_enabled !== 1 || row.credential_enabled !== 1 || !row.endpoint) throw new Error("model_unavailable");
  const plan = await getActivePlan(db, input.userId, input.now);
  if (row.subscription_only === 1 && !plan) throw new Error("subscription_required");
  const credentialSecret = await decryptCredentialSecret(row.encrypted_secret, input.credentialEncryptionKey);

  return {
    id: row.id,
    familyId: row.family_id,
    familyName: row.family_name,
    displayName: row.display_name,
    type: row.type,
    pointsCost: row.points_cost,
    subscriptionOnly: row.subscription_only === 1,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    capabilities: parseJsonObject(row.capabilities),
    providerId: row.provider_id,
    providerAdapterType: row.provider_adapter_type,
    endpoint: row.endpoint,
    credentialId: row.credential_id,
    credentialSecret,
    providerModelId: row.provider_model_id,
    config: parseJsonObject(row.config),
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}