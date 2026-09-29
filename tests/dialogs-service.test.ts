import { env } from "../tests/test-env";
import { describe, expect, it } from "vitest";
import {
  archiveConversation,
  continueConversation,
  createNewConversation,
  deleteArchivedConversation,
  getConversationHistory,
  listActiveConversations,
  listArchivedConversations,
  listEnabledRoles,
  renameConversation,
  restoreConversation,
  setChatModel,
  setConversationRole,
} from "../src/dialogs/service";

let tgId = 930000000;
let seq = 0;

async function seedUser() {
  const userId = crypto.randomUUID();
  const modelId = "dialog_model_" + (++seq);
  const providerId = "dialog_provider_" + seq;
  const credentialId = "dialog_credential_" + seq;

  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at,active_chat_model_id) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z',?3)",
  ).bind(userId, ++tgId, modelId).run();

  await env.DB.prepare(
    "INSERT INTO providers (id,name,adapter_type,endpoint,enabled,created_at,updated_at) VALUES (?1,?2,'test','https://provider.test/v1',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(providerId, "Dialog Provider " + seq).run();

  await env.DB.prepare(
    "INSERT INTO credentials (id,provider_id,name,encrypted_secret,enabled,created_at,updated_at) VALUES (?1,?2,'Dialog','cipher',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(credentialId, providerId).run();

  await env.DB.prepare(
    "INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) VALUES (?1,'family_gpt',?2,?3,'dialog-model','Dialog Model','chat',4,0,8000,1000,'{}',1,'{}','2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(modelId, providerId, credentialId).run();

  await env.DB.prepare(
    "INSERT INTO ai_roles (id,name,description,system_prompt,enabled,created_at,updated_at) VALUES (?1,?2,'Test','You are helpful',1,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind("role_" + seq, "Role Test " + seq).run();

  return { userId, modelId, roleId: "role_" + seq };
}

describe("dialogs and roles", () => {
  it("creates a new dialog from the user's selected Chat model with no role", async () => {
    const { userId, modelId } = await seedUser();
    const dialog = await createNewConversation(env.DB, { userId, now: "2026-09-28T12:00:00Z", expiresAt: "2026-09-29T12:00:00Z" });
    expect(dialog).toMatchObject({ modelId, roleId: null, archivedAt: null });
    const user = await env.DB.prepare("SELECT active_conversation_id, active_role_id FROM users WHERE id=?1").bind(userId).first<{active_conversation_id:string|null;active_role_id:string|null}>();
    expect(user?.active_conversation_id).toBe(dialog.id);
    expect(user?.active_role_id).toBeNull();
  });

  it("continues a dialog using its persisted model and role", async () => {
    const { userId, modelId, roleId } = await seedUser();
    const dialog = await createNewConversation(env.DB, { userId, now: "2026-09-28T12:00:00Z", expiresAt: "2026-09-29T12:00:00Z" });
    await setConversationRole(env.DB, userId, dialog.id, roleId, "2026-09-28T12:00:01Z");
    const continued = await continueConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:02Z");
    expect(continued.modelId).toBe(modelId);
    expect(continued.roleId).toBe(roleId);
  });

  it("archives, restores, confirms and permanently deletes only owned archived dialogs", async () => {
    const { userId, modelId } = await seedUser();
    const dialog = await createNewConversation(env.DB, { userId, now: "2026-09-28T12:00:00Z", expiresAt: "2026-09-29T12:00:00Z" });

    await env.DB.prepare("INSERT INTO conversation_turns (id,conversation_id,user_text,assistant_text,model_id,role_id,created_at,updated_at) VALUES (?1,?2,'q','a',?3,NULL,'2026-09-28T12:00:01Z','2026-09-28T12:00:01Z')").bind(crypto.randomUUID(), dialog.id, modelId).run();
    expect(await renameConversation(env.DB, userId, dialog.id, "Переименованный", "2026-09-28T12:00:01Z")).toBe(true);
    expect(await archiveConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:02Z")).toBe(true);
    expect((await listActiveConversations(env.DB, userId)).some((item) => item.id === dialog.id)).toBe(false);
    expect((await listArchivedConversations(env.DB, userId)).find((item) => item.id === dialog.id)?.title).toBe("Переименованный");

    await expect(continueConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:03Z")).rejects.toThrow("conversation_archived");
    expect(await restoreConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:04Z")).toBe(true);
    expect((await listActiveConversations(env.DB, userId)).some((item) => item.id === dialog.id)).toBe(true);
    await expect(deleteArchivedConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:05Z")).rejects.toThrow("dialog_delete_confirmation_required");

    await archiveConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:06Z");
    await expect(deleteArchivedConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:07Z")).rejects.toThrow("dialog_delete_confirmation_required");
    expect(await deleteArchivedConversation(env.DB, userId, dialog.id, "2026-09-28T12:00:08Z")).toBe(true);
    expect(await listArchivedConversations(env.DB, userId)).toEqual([]);
    expect(await listActiveConversations(env.DB, userId)).toEqual([]);
    expect(await getConversationHistory(env.DB, userId, dialog.id)).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM conversations WHERE id=?1").bind(dialog.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM conversation_turns WHERE conversation_id=?1").bind(dialog.id).first()).toBeNull();
  });

  it("prevents cross-user access to every dialog mutation", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const dialog = await createNewConversation(env.DB, { userId: owner.userId, now: "2026-09-28T12:00:00Z", expiresAt: "2026-09-29T12:00:00Z" });
    expect(await renameConversation(env.DB, attacker.userId, dialog.id, "hacked", "2026-09-28T12:00:01Z")).toBe(false);
    expect(await archiveConversation(env.DB, attacker.userId, dialog.id, "2026-09-28T12:00:02Z")).toBe(false);
    expect(await restoreConversation(env.DB, attacker.userId, dialog.id, "2026-09-28T12:00:03Z")).toBe(false);
    expect(await deleteArchivedConversation(env.DB, attacker.userId, dialog.id, "2026-09-28T12:00:04Z")).toBe(false);
    await expect(continueConversation(env.DB, attacker.userId, dialog.id, "2026-09-28T12:00:05Z")).rejects.toThrow("conversation_not_found");
  });

  it("resets user role when the selected Chat model changes", async () => {
    const { userId, roleId } = await seedUser();
    await env.DB.prepare("UPDATE users SET active_role_id=?2 WHERE id=?1").bind(userId, roleId).run();
    const secondModel = "dialog_second_model_" + (++seq);
    const current = await env.DB.prepare("SELECT active_chat_model_id FROM users WHERE id=?1").bind(userId).first<{active_chat_model_id:string}>();
    await env.DB.prepare("INSERT INTO models (id,family_id,provider_id,credential_id,provider_model_id,display_name,type,points_cost,subscription_only,context_window,max_output_tokens,capabilities,enabled,config,created_at,updated_at) SELECT ?1,family_id,provider_id,credential_id,'dialog-second','Dialog Second','chat',4,0,8000,1000,'{}',1,'{}',created_at,updated_at FROM models WHERE id=?2").bind(secondModel, current?.active_chat_model_id).run();
    expect(await setChatModel(env.DB, userId, secondModel, "2026-09-28T12:01:00Z")).toBe(true);
    const user = await env.DB.prepare("SELECT active_chat_model_id, active_role_id FROM users WHERE id=?1").bind(userId).first<{active_chat_model_id:string|null;active_role_id:string|null}>();
    expect(user?.active_chat_model_id).toBe(secondModel);
    expect(user?.active_role_id).toBeNull();
  });

  it("lists enabled roles and rejects disabled roles", async () => {
    const { userId, roleId } = await seedUser();
    const roles = await listEnabledRoles(env.DB);
    expect(roles.some((role) => role.id === roleId)).toBe(true);
    await env.DB.prepare("UPDATE ai_roles SET enabled=0 WHERE id=?1").bind(roleId).run();
    expect(await setConversationRole(env.DB, userId, "missing", roleId, "2026-09-28T12:02:00Z")).toBe(false);
  });

  it("returns full history with ownership enforced", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const dialog = await createNewConversation(env.DB, { userId: owner.userId, now: "2026-09-28T12:00:00Z", expiresAt: "2026-09-29T12:00:00Z" });
    await env.DB.prepare("INSERT INTO conversation_turns (id,conversation_id,user_text,assistant_text,model_id,role_id,created_at,updated_at) VALUES (?1,?2,'q','a',?3,NULL,'2026-09-28T12:01:00Z','2026-09-28T12:01:00Z')").bind(crypto.randomUUID(), dialog.id, owner.modelId).run();
    expect((await getConversationHistory(env.DB, owner.userId, dialog.id)).length).toBe(1);
    expect(await getConversationHistory(env.DB, attacker.userId, dialog.id)).toEqual([]);
  });
});
