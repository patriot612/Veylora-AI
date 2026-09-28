import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { createAIGateway } from "../src/ai-gateway";
import { listSelectableModels, resolveModel } from "../src/models/registry";
import { decryptCredentialSecret, encryptCredentialSecret } from "../src/security/credentials";
import { ProviderGatewayError, type ProviderAdapter } from "../src/providers/types";

const masterKey = "test-encryption-key";
let tgId = 910000000;

async function seedBase(userId: string, subscribed = false) {
  const suffix = String(++tgId);
  const providerId = "provider_" + suffix;
  const credentialId = "credential_" + suffix;
  const modelId = "model_" + suffix;

  await env.DB.prepare("INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(userId, ++tgId).run();
  await env.DB.prepare("INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'test','https://provider.test/api',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(providerId, "Provider " + suffix).run();

  const encrypted = await encryptCredentialSecret("super-secret", masterKey);
  await env.DB.prepare("INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Test',?3,1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(credentialId, providerId, encrypted).run();

  await env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'vendor-model','Visible Test','chat',4,0,128000,1000,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
    .bind(modelId, providerId, credentialId).run();

  if (subscribed) {
    await env.DB.prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,'plan_month','active','2026-09-28T00:00:00Z','2026-10-28T00:00:00Z','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')")
      .bind(crypto.randomUUID(), userId).run();
  }

  return { providerId, credentialId, modelId };
}

describe("credential crypto", () => {
  it("round-trips and does not store plaintext", async () => {
    const encrypted = await encryptCredentialSecret("top-secret", masterKey);
    expect(encrypted).not.toContain("top-secret");
    expect(await decryptCredentialSecret(encrypted, masterKey)).toBe("top-secret");
    await expect(decryptCredentialSecret(encrypted, "wrong-key")).rejects.toThrow("credential_decryption_failed");
  });
});

describe("model registry", () => {
  it("returns only user-safe model fields", async () => {
    const userId = crypto.randomUUID();
    const ids = await seedBase(userId);
    const models = await listSelectableModels(env.DB, { userId, type: "chat", now: "2026-09-28T12:00:00Z" });
    const model = models.find((item) => item.id === ids.modelId);
    expect(model).toEqual(expect.objectContaining({ id: ids.modelId, familyName: "GPT", displayName: "Visible Test", pointsCost: 4 }));
    expect(JSON.stringify(model)).not.toContain("super-secret");
    expect(JSON.stringify(model)).not.toContain(ids.providerId);
    expect(JSON.stringify(model)).not.toContain(ids.credentialId);
  });

  it("blocks subscription-only models for free users and allows them for subscribers", async () => {
    const freeUser = crypto.randomUUID();
    const freeIds = await seedBase(freeUser);
    await env.DB.prepare("UPDATE models SET subscription_only = 1 WHERE id=?1").bind(freeIds.modelId).run();
    expect((await listSelectableModels(env.DB, { userId: freeUser, type: "chat", now: "2026-09-28T12:00:00Z" })).some((m) => m.id === freeIds.modelId)).toBe(false);

    const subscribedUser = crypto.randomUUID();
    const paidIds = await seedBase(subscribedUser, true);
    await env.DB.prepare("UPDATE models SET subscription_only = 1 WHERE id=?1").bind(paidIds.modelId).run();
    expect((await listSelectableModels(env.DB, { userId: subscribedUser, type: "chat", now: "2026-09-28T12:00:00Z" })).some((m) => m.id === paidIds.modelId)).toBe(true);
  });
});

describe("AI Gateway", () => {
  it("resolves provider credential internally and returns only normalized output", async () => {
    const userId = crypto.randomUUID();
    const ids = await seedBase(userId);
    let seenCredential = "";
    const adapter: ProviderAdapter = {
      type: "test",
      async invoke(request) {
        seenCredential = request.credential;
        return { ok: true, kind: "text", text: "gateway response", providerRequestId: "req-1" };
      },
    };
    const gateway = createAIGateway(env.DB, masterKey, [adapter]);
    const result = await gateway.generateText({
      userId,
      modelId: ids.modelId,
      modelType: "chat",
      messages: [{ role: "user", content: "hello" }],
      now: "2026-09-28T12:00:00Z",
    });
    expect(result).toEqual({ text: "gateway response", providerRequestId: "req-1", modelId: ids.modelId });
    expect(seenCredential).toBe("super-secret");
  });

  it("maps provider failures and timeouts to safe typed errors", async () => {
    const userId = crypto.randomUUID();
    const ids = await seedBase(userId);
    const failing: ProviderAdapter = { type: "test", async invoke() { throw new Error("network"); } };
    const failingGateway = createAIGateway(env.DB, masterKey, [failing]);
    await expect(failingGateway.generateText({
      userId,
      modelId: ids.modelId,
      modelType: "chat",
      messages: [{ role: "user", content: "hello" }],
      now: "2026-09-28T12:00:00Z",
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });

    const slow: ProviderAdapter = {
      type: "test",
      async invoke({ signal }) {
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { ok: true, kind: "text", text: "never" };
      },
    };
    const slowGateway = createAIGateway(env.DB, masterKey, [slow]);
    await expect(slowGateway.generateText({
      userId,
      modelId: ids.modelId,
      modelType: "chat",
      messages: [{ role: "user", content: "hello" }],
      now: "2026-09-28T12:00:00Z",
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    expect(ProviderGatewayError).toBeDefined();
  });
});
