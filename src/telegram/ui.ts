import { t, type Locale } from "../i18n";

export type TelegramButton = { text: string; callback_data?: string; web_app?: { url: string } };

export function mainMenuKeyboard(isAdmin = false, locale: Locale = "ru"): Record<string, unknown> {
  const rows: TelegramButton[][] = [
    [{ text: t(locale, "menu.chat"), callback_data: "menu:chat" }, { text: t(locale, "menu.image"), callback_data: "menu:image" }],
    [{ text: t(locale, "menu.model"), callback_data: "menu:model" }, { text: t(locale, "menu.dialogs"), callback_data: "menu:dialogs" }],
    [{ text: t(locale, "menu.tools"), callback_data: "menu:tools" }, { text: t(locale, "menu.account"), callback_data: "menu:account" }],
    [{ text: t(locale, "common.help"), callback_data: "menu:help" }],
  ];
  if (isAdmin) rows.push([{ text: t(locale, "admin.button"), callback_data: "menu:admin" }]);
  return { inline_keyboard: rows };
}

export function toolsKeyboard(locale: Locale = "ru"): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: t(locale, "menu.search"), callback_data: "tool:search" }],
      [{ text: t(locale, "menu.documents"), callback_data: "tool:documents" }, { text: t(locale, "menu.roles"), callback_data: "tool:roles" }],
      [{ text: t(locale, "menu.chat"), callback_data: "tool:chat" }],
      [{ text: t(locale, "common.back"), callback_data: "menu:chat" }],
    ],
  };
}

export function accountKeyboard(locale: Locale = "ru"): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: t(locale, "account.plans"), callback_data: "account:plans" }, { text: t(locale, "account.orders"), callback_data: "account:orders" }],
      [{ text: t(locale, "language.account", { name: t(locale, "language.self") }), callback_data: "account:language" }, { text: t(locale, "common.help"), callback_data: "menu:help" }],
      [{ text: t(locale, "common.toChat"), callback_data: "menu:chat" }],
    ],
  };
}
