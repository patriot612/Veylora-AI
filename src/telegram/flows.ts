import { createNewConversation, continueConversation, archiveConversation, restoreConversation, deleteArchivedConversation, getConversationHistory, listActiveConversations, listArchivedConversations, renameConversation, setChatModel, setConversationRole, listEnabledRoles } from "../dialogs/service";
import { getActivePlan } from "../subscriptions";
import { listSelectableModels } from "../models/registry";
import { createPlanInvoice } from "../payments/service";
import { handleImageRequest } from "../image/service";
import { enterDocumentsMode } from "../documents/service";
import { enterVoiceMode } from "../voice/service";
import { answerTelegramCallbackQuery, deleteTelegramMessage, editTelegramMessage, sendTelegramMessage } from "./api";
import { accountKeyboard, mainMenuKeyboard, toolsKeyboard } from "./ui";
import { getUserLocale, normalizeLocale, t } from "../i18n";
import { getSystemConfigInt } from "../config";
import { completeSearchDelivery, executeSearch, releaseSearchDelivery, type SearchOutcome } from "../search/service";
import { createAIGateway } from "../ai-gateway";
import { handleChatMessage } from "../chat/service";
import { createDefaultProviderAdapters } from "../providers/factory";

type UserPrefs = Record<string, unknown>;

function uniqueFamilies(models: Array<{ familyId: string; familyName: string }>): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const families: Array<{ id: string; name: string }> = [];
  for (const model of models) {
    if (seen.has(model.familyId)) continue;
    seen.add(model.familyId);
    families.push({ id: model.familyId, name: model.familyName });
  }
  return families;
}

export async function handleStartCommand(
  env: Env,
  requestUrl: string,
  userId: string,
  telegramUserId: number,
  chatId: number,
  command: string,
  now: string,
): Promise<boolean> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("telegram_bot_token_missing");
  const locale = await getUserLocale(env.DB, userId);

  if (command === "/start") {
    const defaultModel = await env.DB.prepare("SELECT config_value FROM system_config WHERE config_key='default_chat_model_id'")
      .first<{ config_value: string }>();
    if (defaultModel?.config_value) {
      await env.DB.prepare(
        "UPDATE users SET active_chat_model_id=COALESCE(active_chat_model_id,?2),active_mode='chat',updated_at=?3 WHERE id=?1",
      ).bind(userId, defaultModel.config_value, now).run();
    }
    await sendTelegramMessage(botToken, chatId, t(locale, "start.greeting"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const mainMenu = await sendTelegramMessage(botToken, chatId, "", { reply_markup: mainMenuKeyboard(false, locale) });
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.mainMenuMessageId = mainMenu.message_id;
    await setUiPreferences(env.DB, userId, prefs);
    return true;
  }

  if (command === "/admin") {
    const allowed = await isAdminTelegramUser(env, telegramUserId);
    if (!allowed) {
      await sendTelegramMessage(botToken, chatId, t(locale, "admin.denied"));
      return true;
    }
    const adminUrl = new URL("/admin", requestUrl).toString();
    await sendTelegramMessage(botToken, chatId, t(locale, "admin.open"), {
      reply_markup: { inline_keyboard: [[{ text: t(locale, "admin.button"), web_app: { url: adminUrl } }]] },
    });
    return true;
  }

  if (command === "/paysupport") {
    await sendTelegramMessage(botToken, chatId, "Поддержка платежей Veylora AI: отправьте номер заказа и кратко опишите проблему.");
    return true;
  }

  return false;
}

export async function handleTelegramCallback(
  env: Env,
  requestUrl: string,
  userId: string,
  telegramUserId: number,
  chatId: number,
  callbackId: string | undefined,
  data: string,
  now: string,
  callbackMessageId?: number,
): Promise<boolean> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("telegram_bot_token_missing");
  const locale = await getUserLocale(env.DB, userId);
  if (callbackId) await answerTelegramCallbackQuery(botToken, callbackId).catch(() => false);

  if (data === "chat_retry") {
    const prefs = await getUiPreferences(env.DB, userId);
    const text = typeof prefs.lastChatText === "string" ? prefs.lastChatText : "";
    if (!text) {
      await sendTelegramMessage(botToken, chatId, t(locale, "chat.failed"), { reply_markup: mainMenuKeyboard(false, locale) });
      return true;
    }
    const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY ?? "", createDefaultProviderAdapters());
    await handleChatMessage({
      db: env.DB,
      gateway,
      userId,
      text,
      chatId,
      messageId: callbackMessageId ?? 0,
      now,
      credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY ?? "",
      send: (message, options) => sendTelegramMessage(botToken, chatId, message, options),
      edit: (messageId, message, options) => editTelegramMessage(botToken, chatId, messageId, message, options),
    });
    return true;
  }

  if (data === "search_retry") {
    const prefs = await getUiPreferences(env.DB, userId);
    const query = typeof prefs.lastSearchQuery === "string" ? prefs.lastSearchQuery : "";
    if (!query) {
      await sendTelegramMessage(botToken, chatId, t(locale, "search.failed"));
      return true;
    }
    await handleSearchText(env, userId, chatId, query, now);
    return true;
  }

  if (data.startsWith("plan_buy:")) {
    const planId = data.slice("plan_buy:".length);
    const invoice = await createPlanInvoice({ db: env.DB, botToken, userId, chatId, planId, now });
    await sendTelegramMessage(botToken, chatId, "error" in invoice ? "Не удалось создать счёт: " + invoice.error : "Счёт на оплату создан.");
    return true;
  }

  if (data === "menu:chat") {
    await setMode(env.DB, userId, "chat", now);
    if (callbackMessageId) await deleteTelegramMessage(botToken, chatId, callbackMessageId).catch(() => false);
    await sendTelegramMessage(botToken, chatId, "💬 Chat активен. Просто отправьте сообщение.", { reply_markup: mainMenuKeyboard(false, locale) });
    return true;
  }

  if (data === "menu:image") {
    await setMode(env.DB, userId, "image", now);
    const models = await listSelectableModels(env.DB, { userId, type: "image", now });
    const templates = await env.DB.prepare("SELECT id,name,extra_points_cost FROM image_templates WHERE enabled=1 ORDER BY name LIMIT 12").all<{id:string;name:string;extra_points_cost:number}>();
    await sendTelegramMessage(botToken, chatId, t(locale, "image.screen"), {
      reply_markup: {
        inline_keyboard: [
          ...models.slice(0, 8).map((model) => [{ text: (model.subscriptionOnly ? "🔒 " : "") + model.displayName + " · " + model.pointsCost + " б.", callback_data: "image_model:" + model.id }]),
          [{ text: "Размер 1024×1024", callback_data: "image_size:1024x1024" }, { text: "1536×1024", callback_data: "image_size:1536x1024" }],
          [{ text: "Standard", callback_data: "image_quality:standard" }, { text: "HD", callback_data: "image_quality:hd" }],
          [{ text: "PNG", callback_data: "image_format:png" }, { text: "WEBP", callback_data: "image_format:webp" }, { text: "JPG", callback_data: "image_format:jpg" }],
          ...(templates.results ?? []).slice(0, 6).map((template: { id: string; name: string; extra_points_cost: number }) => [{ text: "📐 " + template.name + " +" + template.extra_points_cost + " б.", callback_data: "image_template:" + template.id }]),
          [{ text: "← В меню", callback_data: "menu:chat" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("image_template:")) {
    const templateId = data.slice("image_template:".length);
    const template = await env.DB.prepare("SELECT id,name,description,extra_points_cost FROM image_templates WHERE id=?1 AND enabled=1").bind(templateId).first<{id:string;name:string;description:string;extra_points_cost:number}>();
    if (!template) throw new Error("image_template_unavailable");
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageTemplateId = templateId;
    await setUiPreferences(env.DB, userId, prefs);
    await sendTelegramMessage(botToken, chatId, "Шаблон: " + template.name + "\n" + template.description + "\nДоплата: " + template.extra_points_cost + " б.", {
      reply_markup: { inline_keyboard: [[{ text: "Использовать", callback_data: "image_template_use:" + templateId }],[{ text: "← Назад", callback_data: "menu:image" }]] },
    });
    return true;
  }

  if (data.startsWith("image_template_use:")) {
    const templateId = data.slice("image_template_use:".length);
    const template = await env.DB.prepare("SELECT id,name FROM image_templates WHERE id=?1 AND enabled=1").bind(templateId).first<{id:string;name:string}>();
    if (!template) throw new Error("image_template_unavailable");
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageTemplateId = templateId;
    await setUiPreferences(env.DB, userId, prefs);
    await setMode(env.DB, userId, "image", now);
    await sendTelegramMessage(botToken, chatId, "Шаблон \"" + template.name + "\" выбран. Отправьте описание изображения.");
    return true;
  }

  if (data.startsWith("image_model:")) {
    const modelId = data.slice("image_model:".length);
    const model = await env.DB.prepare("SELECT display_name,points_cost,subscription_only FROM models WHERE id=?1 AND type='image' AND enabled=1").bind(modelId).first<{ display_name:string; points_cost:number; subscription_only:number }>();
    if (!model) throw new Error("image_model_unavailable");
    if (model.subscription_only === 1 && !(await getActivePlan(env.DB, userId, now))) {
      await sendTelegramMessage(botToken, chatId, t(locale, "subscription.required"));
      return true;
    }
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageModelId = modelId;
    await setUiPreferences(env.DB, userId, prefs);
    await setMode(env.DB, userId, "image", now);
    const templateId = typeof prefs.imageTemplateId === "string" ? prefs.imageTemplateId : "";
    const template = templateId ? await env.DB.prepare("SELECT extra_points_cost FROM image_templates WHERE id=?1 AND enabled=1").bind(templateId).first<{extra_points_cost:number}>() : null;
    const total = model.points_cost + (template?.extra_points_cost ?? 0);
    await sendTelegramMessage(botToken, chatId, model.display_name + " · " + total + " б.\nОтправьте описание изображения.");
    return true;
  }

  if (data.startsWith("image_size:")) {
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageSize = data.slice("image_size:".length);
    await setUiPreferences(env.DB, userId, prefs);
    await sendTelegramMessage(botToken, chatId, "Размер сохранён.");
    return true;
  }

  if (data.startsWith("image_quality:")) {
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageQuality = data.slice("image_quality:".length);
    await setUiPreferences(env.DB, userId, prefs);
    await sendTelegramMessage(botToken, chatId, "Качество сохранено.");
    return true;
  }

  if (data.startsWith("image_format:")) {
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.imageFormat = data.slice("image_format:".length);
    await setUiPreferences(env.DB, userId, prefs);
    await sendTelegramMessage(botToken, chatId, t(locale, "image.formatSaved"));
    return true;
  }

  if (data === "menu:model") {
    const models = await listSelectableModels(env.DB, { userId, type: "chat", now });
    const families = uniqueFamilies(models);
    await sendTelegramMessage(botToken, chatId, t(locale, "models.selectFamily"), {
      reply_markup: {
        inline_keyboard: [
          ...families.map((family) => [{ text: family.name, callback_data: "model_family:" + family.id }]),
          [{ text: t(locale, "common.toChat"), callback_data: "menu:chat" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("model_family:")) {
    const familyId = data.slice("model_family:".length);
    const models = (await listSelectableModels(env.DB, { userId, type: "chat", now })).filter((model) => model.familyId === familyId);
    await sendTelegramMessage(botToken, chatId, models.length ? "📚 " + models[0].familyName : t(locale, "models.selectFamily"), {
      reply_markup: {
        inline_keyboard: [
          ...models.map((model) => [{ text: (model.subscriptionOnly ? "🔒 " : "") + model.displayName + " · " + model.pointsCost + " б.", callback_data: "model:" + model.id }]),
          [{ text: t(locale, "models.backToFamilies"), callback_data: "menu:model" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("model:")) {
    const modelId = data.slice("model:".length);
    const model = await env.DB.prepare("SELECT subscription_only FROM models WHERE id=?1 AND type='chat' AND enabled=1").bind(modelId).first<{ subscription_only:number }>();
    if (!model) throw new Error("model_unavailable");
    if (model.subscription_only === 1 && !(await getActivePlan(env.DB, userId, now))) {
      await sendTelegramMessage(botToken, chatId, "Эта модель доступна по подписке.\n\n[Тарифы]");
      return true;
    }
    const ok = await setChatModel(env.DB, userId, modelId, now);
    await sendTelegramMessage(botToken, chatId, ok ? "Модель Chat изменена." : "Модель недоступна.", { reply_markup: mainMenuKeyboard(false, locale) });
    return true;
  }

  if (data === "menu:dialogs") {
    const dialogs = await listActiveConversations(env.DB, userId);
    await sendTelegramMessage(botToken, chatId, "📖 Мои диалоги", {
      reply_markup: {
        inline_keyboard: [
          ...dialogs.slice(0, 10).map((dialog) => [{ text: dialog.title.slice(0, 45), callback_data: "dialog:" + dialog.id }, { text: "🗄", callback_data: "dialog:archive:" + dialog.id }]),
          [{ text: "＋ Новый диалог", callback_data: "dialog:new" }],
          [{ text: "Архив", callback_data: "dialogs:archive" }],
          [{ text: "← В меню", callback_data: "menu:chat" }],
        ],
      },
    });
    return true;
  }

  if (data === "dialogs:archive") {
    const dialogs = await listArchivedConversations(env.DB, userId);
    await sendTelegramMessage(botToken, chatId, "🗄 Архив", {
      reply_markup: {
        inline_keyboard: [
          ...dialogs.slice(0, 10).map((dialog) => [{ text: dialog.title.slice(0, 40), callback_data: "dialog:restore:" + dialog.id }, { text: "🗑", callback_data: "dialog:delete:" + dialog.id }]),
          [{ text: "← Диалоги", callback_data: "menu:dialogs" }],
        ],
      },
    });
    return true;
  }

  if (data === "dialog:new") {
    const plan = await getActivePlan(env.DB, userId, now);
    const expiresAt = new Date(Date.parse(now) + (plan?.retentionHours ?? 24) * 3_600_000).toISOString();
    try {
      await createNewConversation(env.DB, { userId, title: "Новый диалог", now, expiresAt });
      await setMode(env.DB, userId, "chat", now);
      await sendTelegramMessage(botToken, chatId, "Новый диалог создан. Отправьте сообщение.", { reply_markup: mainMenuKeyboard(false, locale) });
    } catch {
      await sendTelegramMessage(botToken, chatId, "Сначала выберите доступную модель Chat.", { reply_markup: mainMenuKeyboard(false, locale) });
    }
    return true;
  }

  if (data.startsWith("dialog:archive:")) {
    await archiveConversation(env.DB, userId, data.slice("dialog:archive:".length), now);
    await sendTelegramMessage(botToken, chatId, "Диалог отправлен в архив.");
    return true;
  }

  if (data.startsWith("dialog:restore:")) {
    await restoreConversation(env.DB, userId, data.slice("dialog:restore:".length), now);
    await sendTelegramMessage(botToken, chatId, "Диалог восстановлен.");
    return true;
  }

  if (data.startsWith("dialog:delete:")) {
    await deleteArchivedConversation(env.DB, userId, data.slice("dialog:delete:".length), now);
    await sendTelegramMessage(botToken, chatId, "Диалог удалён.");
    return true;
  }

  if (data.startsWith("dialog:rename:")) {
    const conversationId = data.slice("dialog:rename:".length);
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.renameConversationId = conversationId;
    await setUiPreferences(env.DB, userId, prefs);
    await setMode(env.DB, userId, "dialog_rename", now);
    await sendTelegramMessage(botToken, chatId, "Введите новое название диалога.");
    return true;
  }

  if (data.startsWith("dialog:") && !data.startsWith("dialog:messages:") && !data.startsWith("dialog:history:")) {
    const conversationId = data.slice("dialog:".length);
    try {
      const dialog = await getConversationHistory(env.DB, userId, conversationId);
      const recent = dialog.slice(-6);
      const summary = recent.length
        ? recent.map((turn) => "👤 " + turn.userText + "\n🤖 " + turn.assistantText).join("\n\n")
        : "Сообщений пока нет.";
      await sendTelegramMessage(botToken, chatId, summary, {
        reply_markup: {
          inline_keyboard: [
            [{ text: t(locale, "dialogs.continue"), callback_data: "dialog_continue:" + conversationId }],
            [{ text: t(locale, "dialogs.messages"), callback_data: "dialog:messages:" + conversationId }, { text: t(locale, "dialogs.history"), callback_data: "dialog:history:" + conversationId }],
            [{ text: t(locale, "dialogs.rename"), callback_data: "dialog:rename:" + conversationId }, { text: t(locale, "dialogs.archive"), callback_data: "dialog:archive:" + conversationId }],
            [{ text: t(locale, "common.back"), callback_data: "menu:dialogs" }],
          ],
        },
      });
    } catch {
      await sendTelegramMessage(botToken, chatId, "Не удалось открыть этот диалог.");
    }
    return true;
  }

  if (data.startsWith("dialog:messages:")) {
    const conversationId = data.slice("dialog:messages:".length);
    const history = await getConversationHistory(env.DB, userId, conversationId);
    const recent = history.slice(-6);
    const summary = recent.length
      ? recent.map((turn) => "👤 " + turn.userText + "\n🤖 " + turn.assistantText).join("\n\n")
      : "Сообщений пока нет.";
    await sendTelegramMessage(botToken, chatId, summary, {
      reply_markup: { inline_keyboard: [[{ text: t(locale, "dialogs.continue"), callback_data: "dialog_continue:" + conversationId }], [{ text: t(locale, "common.back"), callback_data: "dialog:" + conversationId }]] },
    });
    return true;
  }

  if (data.startsWith("dialog:history:")) {
    const conversationId = data.slice("dialog:history:".length);
    const history = await getConversationHistory(env.DB, userId, conversationId);
    const full = history.map((turn) => "👤 " + turn.userText + "\n🤖 " + turn.assistantText).join("\n\n") || "Сообщений пока нет.";
    const chunks: string[] = [];
    for (let offset = 0; offset < full.length; offset += 3500) chunks.push(full.slice(offset, offset + 3500));
    for (const chunk of chunks.slice(0, 10)) await sendTelegramMessage(botToken, chatId, chunk);
    await sendTelegramMessage(botToken, chatId, t(locale, "dialogs.history"), { reply_markup: { inline_keyboard: [[{ text: t(locale, "common.back"), callback_data: "dialog:" + conversationId }]] } });
    return true;
  }

  if (data.startsWith("dialog_continue:")) {
    const conversationId = data.slice("dialog_continue:".length);
    try {
      await continueConversation(env.DB, userId, conversationId, now);
      await setMode(env.DB, userId, "chat", now);
      await sendTelegramMessage(botToken, chatId, "Диалог продолжен. Отправьте сообщение.", { reply_markup: mainMenuKeyboard(false, locale) });
    } catch {
      await sendTelegramMessage(botToken, chatId, "Не удалось открыть этот диалог.");
    }
    return true;
  }

  if (data === "menu:tools") {
    await sendTelegramMessage(botToken, chatId, "🧰 Инструменты", { reply_markup: toolsKeyboard(locale) });
    return true;
  }

  if (data === "tool:search") {
    await setMode(env.DB, userId, "search", now);
    const models = await listSelectableModels(env.DB, { userId, type: "search", now });
    const families = uniqueFamilies(models);
    await sendTelegramMessage(botToken, chatId, "🔎 Search Mode\n" + t(locale, "models.selectFamily"), {
      reply_markup: {
        inline_keyboard: [
          ...families.map((family) => [{ text: family.name, callback_data: "search_family:" + family.id }]),
          [{ text: t(locale, "common.toChat"), callback_data: "menu:chat" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("search_family:")) {
    const familyId = data.slice("search_family:".length);
    const models = (await listSelectableModels(env.DB, { userId, type: "search", now })).filter((model) => model.familyId === familyId);
    await sendTelegramMessage(botToken, chatId, "🔎 " + (models[0]?.familyName ?? t(locale, "models.selectFamily")), {
      reply_markup: {
        inline_keyboard: [
          ...models.map((model) => [{ text: (model.subscriptionOnly ? "🔒 " : "") + model.displayName + " · " + model.pointsCost + " б.", callback_data: "search_model:" + model.id }]),
          [{ text: t(locale, "models.backToFamilies"), callback_data: "tool:search" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("search_model:")) {
    const modelId = data.slice("search_model:".length);
    const models = await listSelectableModels(env.DB, { userId, type: "search", now });
    const model = models.find((item) => item.id === modelId);
    if (!model) throw new Error("search_model_unavailable");
    if (model.subscriptionOnly && !(await getActivePlan(env.DB, userId, now))) {
      await sendTelegramMessage(botToken, chatId, "Эта модель доступна по подписке.\n\n[Тарифы]");
      return true;
    }
    const prefs = await getUiPreferences(env.DB, userId);
    prefs.searchModelId = modelId;
    await setUiPreferences(env.DB, userId, prefs);
    await setMode(env.DB, userId, "search", now);
    await sendTelegramMessage(botToken, chatId, "Search-модель выбрана. Отправьте запрос.");
    return true;
  }

  if (data === "tool:documents") {
    await enterDocumentsMode(env.DB, userId, now);
    const uploadCost = await getSystemConfigInt(env.DB, "cost.document_upload", 2);
    const questionCost = await getSystemConfigInt(env.DB, "cost.document_question", 3);
    const maxBytes = await getSystemConfigInt(env.DB, "limits.document_bytes", 10 * 1024 * 1024);
    const maxPages = await getSystemConfigInt(env.DB, "limits.document_pdf_pages", 50);
    const maxChars = await getSystemConfigInt(env.DB, "limits.document_extracted_chars", 25000);
    await sendTelegramMessage(botToken, chatId, t(locale, "documents.screen", {
      uploadCost,
      questionCost,
      sizeMb: Math.round(maxBytes / (1024 * 1024)),
      pages: maxPages,
      chars: maxChars,
    }));
    return true;
  }

  if (data === "tool:voice") {
    const mode = await enterVoiceMode(env.DB, userId, now);
    if (!mode.ok) {
      await sendTelegramMessage(botToken, chatId, t(locale, "voice.required"));
      return true;
    }
    const models = await listSelectableModels(env.DB, { userId, type: "voice", now });
    const model = models[0];
    await sendTelegramMessage(botToken, chatId, model ? t(locale, "voice.screen", { model: model.displayName, cost: model.pointsCost }) : t(locale, "voice.enabled"));
    return true;
  }

  if (data === "tool:roles") {
    const roles = await listEnabledRoles(env.DB);
    await sendTelegramMessage(botToken, chatId, "🎭 Roles", {
      reply_markup: {
        inline_keyboard: [
          ...roles.slice(0, 10).map((role) => [{ text: role.name, callback_data: "role:" + role.id }]),
          [{ text: "← В меню", callback_data: "menu:chat" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("role:")) {
    const current = await env.DB.prepare("SELECT active_conversation_id FROM users WHERE id=?1").bind(userId).first<{ active_conversation_id: string | null }>();
    if (!current?.active_conversation_id) {
      await sendTelegramMessage(botToken, chatId, "Сначала создайте или откройте диалог.");
      return true;
    }
    const ok = await setConversationRole(env.DB, userId, current.active_conversation_id, data.slice("role:".length), now);
    await sendTelegramMessage(botToken, chatId, ok ? "Роль применена." : "Роль недоступна.");
    return true;
  }

  if (data === "tool:chat") {
    await setMode(env.DB, userId, "chat", now);
    await sendTelegramMessage(botToken, chatId, "💬 Chat активен. Отправьте сообщение.", { reply_markup: mainMenuKeyboard(false, locale) });
    return true;
  }

  if (data === "menu:account") {
    await sendTelegramMessage(botToken, chatId, await accountSummary(env.DB, userId, now), { reply_markup: accountKeyboard(locale) });
    return true;
  }

  if (data === "account:plans") {
    const plans = await env.DB.prepare("SELECT id,name,price_stars,daily_points,retention_hours,voice_enabled,duration_days FROM plans WHERE enabled=1 ORDER BY duration_days").all<{id:string;name:string;price_stars:number;daily_points:number;retention_hours:number;voice_enabled:number;duration_days:number}>();
    await sendTelegramMessage(botToken, chatId, t(locale, "plans.title"), {
      reply_markup: {
        inline_keyboard: [
          ...(plans.results ?? []).map((plan) => [{ text: plan.name + " · " + plan.price_stars + " ⭐", callback_data: "plan:view:" + plan.id }]),
          [{ text: t(locale, "common.toAccount"), callback_data: "menu:account" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("plan:view:")) {
    const planId = data.slice("plan:view:".length);
    const plan = await env.DB.prepare("SELECT id,name,price_stars,daily_points,retention_hours,voice_enabled,duration_days FROM plans WHERE id=?1 AND enabled=1").bind(planId).first<{id:string;name:string;price_stars:number;daily_points:number;retention_hours:number;voice_enabled:number;duration_days:number}>();
    if (!plan) throw new Error("plan_unavailable");
    const details = t(locale, "plans.details", { days: plan.duration_days, points: plan.daily_points, retention: plan.retention_hours, voice: plan.voice_enabled === 1 ? "on" : "off" });
    await sendTelegramMessage(botToken, chatId, plan.name + " · " + plan.price_stars + " ⭐\n\n" + details, {
      reply_markup: { inline_keyboard: [[{ text: t(locale, "plans.pay"), callback_data: "plan_buy:" + plan.id }],[{ text: t(locale, "common.toAccount"), callback_data: "menu:account" }]] },
    });
    return true;
  }

  if (data === "account:orders") {
    const orders = await env.DB.prepare("SELECT id,plan_id,status,amount,currency,created_at,paid_at,refunded_at FROM orders WHERE user_id=?1 ORDER BY created_at DESC LIMIT 10").bind(userId).all<{id:string;plan_id:string;status:string;amount:number;currency:string;created_at:string;paid_at:string|null;refunded_at:string|null}>();
    await sendTelegramMessage(botToken, chatId, "Мои заказы\n\n" + ((orders.results ?? []).length ? (orders.results ?? []).map((order) => "#" + order.id.slice(0, 8) + " · " + order.plan_id + " · " + order.status + " · " + order.amount + " " + order.currency).join("\n") : t(locale, "orders.none")), {
      reply_markup: { inline_keyboard: [...(orders.results ?? []).slice(0, 10).map((order) => [{ text: "#" + order.id.slice(0, 8) + " · " + order.status, callback_data: "order:view:" + order.id }]), [ { text: t(locale, "common.toAccount"), callback_data: "menu:account" } ]] },
    });
    return true;
  }

  if (data.startsWith("order:view:")) {
    const orderId = data.slice("order:view:".length);
    const order = await env.DB.prepare("SELECT o.id,o.plan_id,o.status,o.amount,o.currency,o.created_at,o.paid_at,o.refunded_at,p.name AS plan_name FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?1 AND o.user_id=?2").bind(orderId, userId).first<{id:string;plan_id:string;status:string;amount:number;currency:string;created_at:string;paid_at:string|null;refunded_at:string|null;plan_name:string}>();
    if (!order) throw new Error("order_not_found");
    await sendTelegramMessage(botToken, chatId, "#" + order.id.slice(0, 8) + "\n" + order.plan_name + "\n" + order.amount + " " + order.currency + "\n" + order.status + "\n" + (order.paid_at ?? order.created_at), { reply_markup: { inline_keyboard: [[{ text: t(locale, "common.toAccount"), callback_data: "account:orders" }]] } });
    return true;
  }

  if (data === "account:language") {
    await sendTelegramMessage(botToken, chatId, t(locale, "language.title"), {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Русский", callback_data: "lang:ru" }, { text: "English", callback_data: "lang:en" }],
          [{ text: "O'zbek", callback_data: "lang:uz" }, { text: "Français", callback_data: "lang:fr" }],
          [{ text: "Deutsch", callback_data: "lang:de" }],
          [{ text: "← Аккаунт", callback_data: "menu:account" }],
        ],
      },
    });
    return true;
  }

  if (data.startsWith("lang:")) {
    const language = data.slice("lang:".length);
    if (!["ru", "en", "uz", "fr", "de"].includes(language)) throw new Error("invalid_language");
    await env.DB.prepare("UPDATE users SET language=?2,updated_at=?3 WHERE id=?1").bind(userId, language, now).run();
    const nextLocale = normalizeLocale(language);
    await sendTelegramMessage(botToken, chatId, t(nextLocale, "common.saved"), { reply_markup: accountKeyboard(nextLocale) });
    return true;
  }

  if (data === "menu:help") {
    await sendTelegramMessage(botToken, chatId, t(locale, "help.text"), { reply_markup: mainMenuKeyboard(false, locale) });
    return true;
  }

  if (data === "menu:admin") {
    if (await isAdminTelegramUser(env, telegramUserId)) {
      const adminUrl = new URL("/admin", requestUrl).toString();
      await sendTelegramMessage(botToken, chatId, "Открыть Veylora Admin:", { reply_markup: { inline_keyboard: [[{ text: "🛠 Open Admin Mini App", web_app: { url: adminUrl } }]] } });
    } else {
      await sendTelegramMessage(botToken, chatId, "Недостаточно прав.");
    }
    return true;
  }

  return false;
}

export async function handleDialogRenameText(
  env: Env,
  userId: string,
  chatId: number,
  text: string,
  now: string,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
  const locale = await getUserLocale(env.DB, userId);
  const prefs = await getUiPreferences(env.DB, userId);
  const conversationId = typeof prefs.renameConversationId === "string" ? prefs.renameConversationId : "";
  if (!conversationId) {
    await setMode(env.DB, userId, "chat", now);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Не удалось определить диалог.", { reply_markup: mainMenuKeyboard(false, locale) });
    return true;
  }
  const ok = await renameConversation(env.DB, userId, conversationId, text, now);
  delete prefs.renameConversationId;
  await setUiPreferences(env.DB, userId, prefs);
  await setMode(env.DB, userId, "chat", now);
  await sendTelegramMessage(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    ok ? "Диалог переименован." : "Не удалось переименовать диалог.",
    { reply_markup: mainMenuKeyboard(false, locale) },
  );
  return true;
}

export async function handleImageText(
  env: Env,
  userId: string,
  chatId: number,
  telegramUpdateId: number,
  text: string,
  now: string,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("image_runtime_secrets_missing");
  const prefs = await getUiPreferences(env.DB, userId);
  const result = await handleImageRequest({
    db: env.DB,
    queue: env.AI_JOBS,
    userId,
    prompt: text,
    modelId: typeof prefs.imageModelId === "string" ? prefs.imageModelId : undefined,
    size: typeof prefs.imageSize === "string" ? prefs.imageSize : undefined,
    quality: typeof prefs.imageQuality === "string" ? prefs.imageQuality : undefined,
    format: typeof prefs.imageFormat === "string" ? prefs.imageFormat : undefined,
    templateId: typeof prefs.imageTemplateId === "string" ? prefs.imageTemplateId : undefined,
    telegramUpdateId,
    chatId,
    now,
    encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
  });
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "error" in result ? t(await getUserLocale(env.DB, userId), "image.failed", { reason: result.error }) : t(await getUserLocale(env.DB, userId), "image.started"));
  return true;
}

export async function handleSearchText(
  env: Env,
  userId: string,
  chatId: number,
  telegramUpdateIdOrText: number | string,
  textOrNow: string,
  maybeNow?: string,
): Promise<boolean> {
  const telegramUpdateId = typeof telegramUpdateIdOrText === "number" ? telegramUpdateIdOrText : undefined;
  const text = typeof telegramUpdateIdOrText === "number" ? textOrNow : telegramUpdateIdOrText;
  const now = typeof telegramUpdateIdOrText === "number" ? maybeNow as string : textOrNow;
  if (!env.TELEGRAM_BOT_TOKEN || !env.CREDENTIAL_ENCRYPTION_KEY || !env.SEARXNG_URL) throw new Error("search_runtime_secrets_missing");
  const prefs = await getUiPreferences(env.DB, userId);
  prefs.lastSearchQuery = text.slice(0, 1000);
  await setUiPreferences(env.DB, userId, prefs);
  const gateway = createAIGateway(env.DB, env.CREDENTIAL_ENCRYPTION_KEY, createDefaultProviderAdapters());
  const status = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, t(await getUserLocale(env.DB, userId), "search.processing")).catch(() => null);
  const outcome = await executeSearch({
    db: env.DB,
    gateway,
    userId,
    query: text,
    modelId: typeof prefs.searchModelId === "string" ? prefs.searchModelId : undefined,
    telegramUpdateId,
    now,
    searxngUrl: env.SEARXNG_URL,
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
  });
  await deliverSearchOutcome(env, userId, chatId, outcome, status?.message_id);
  return true;
}

async function deliverSearchOutcome(env: Env, userId: string, chatId: number, outcome: SearchOutcome, statusMessageId?: number): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
  const locale = await getUserLocale(env.DB, userId);
  if (outcome.kind === "answered") {
    let telegramDelivered = false;
    try {
      if (statusMessageId) {
        await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, statusMessageId, outcome.text);
      } else {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, outcome.text);
      }
      telegramDelivered = true;
      if (!(await completeSearchDelivery(env.DB, userId, outcome.operationId, new Date().toISOString()))) throw new Error("search_delivery_settlement_failed");\n      const prefs = await getUiPreferences(env.DB, userId); delete prefs.lastSearchQuery; await setUiPreferences(env.DB, userId, prefs);
    } catch (error) {
      if (!telegramDelivered) {
        await releaseSearchDelivery(env.DB, outcome.operationId, new Date().toISOString(), error instanceof Error ? error.message : "telegram_delivery_failed").catch(() => false);
        if (statusMessageId) {
          await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, statusMessageId, t(locale, "search.deliveryFailed")).catch(() => false);
        } else {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, t(locale, "search.deliveryFailed")).catch(() => false);
        }
      }
    }
    return;
  }
  const message = outcome.kind === "no_result" ? t(locale, "search.noResult") : outcome.kind === "insufficient_points" ? t(locale, "billing.insufficient") : t(locale, "search.failed");
  const retryMarkup = { reply_markup: { inline_keyboard: [[{ text: t(locale, "common.retry"), callback_data: "search_retry" }]] } };
  if (statusMessageId) await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, statusMessageId, message, retryMarkup).catch(() => false);
  else await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message, retryMarkup);
}

async function isAdminTelegramUser(env: Env, telegramUserId: number): Promise<boolean> {
  const configuredOwnerId = Number(env.ADMIN_OWNER_TELEGRAM_ID);
  if (Number.isSafeInteger(configuredOwnerId) && configuredOwnerId > 0 && telegramUserId === configuredOwnerId) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM users u JOIN admin_roles r ON r.user_id=u.id WHERE u.telegram_user_id=?1").bind(telegramUserId).first<{ ok: number }>();
  return row?.ok === 1;
}

async function setMode(db: D1Database, userId: string, mode: string, now: string): Promise<void> {
  await db.prepare("UPDATE users SET active_mode=?2,updated_at=?3 WHERE id=?1").bind(userId, mode, now).run();
}

async function getUiPreferences(db: D1Database, userId: string): Promise<UserPrefs> {
  const row = await db.prepare("SELECT ui_preferences FROM user_settings WHERE user_id=?1").bind(userId).first<{ ui_preferences: string }>();
  try {
    const parsed = JSON.parse(row?.ui_preferences ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UserPrefs : {};
  } catch {
    return {};
  }
}

async function setUiPreferences(db: D1Database, userId: string, prefs: UserPrefs): Promise<void> {
  await db.prepare("UPDATE user_settings SET ui_preferences=?2 WHERE user_id=?1").bind(userId, JSON.stringify(prefs)).run();
}

async function accountSummary(db: D1Database, userId: string, now: string): Promise<string> {
  const user = await db.prepare("SELECT daily_points_remaining,bonus_points,language FROM users WHERE id=?1").bind(userId).first<{ daily_points_remaining: number; bonus_points: number; language: string }>();
  const plan = await getActivePlan(db, userId, now);
  const dailyLimit = plan?.dailyPoints ?? 50;
  const local = new Date(Date.parse(now) + 3 * 60 * 60 * 1000);
  local.setUTCHours(24, 0, 0, 0);
  const reset = new Date(local.getTime() - 3 * 60 * 60 * 1000).toISOString();
  const locale = user?.language ?? "ru";
  return t(locale, "account.balance", {
    daily: user?.daily_points_remaining ?? dailyLimit,
    limit: dailyLimit,
    reset,
    purchased: 0,
    bonus: user?.bonus_points ?? 0,
  }) + "\n\nПодписка: " + (plan?.name ?? "Free");
}