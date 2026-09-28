export type TelegramButton = { text: string; callback_data?: string; web_app?: { url: string } };

export function mainMenuKeyboard(isAdmin = false): Record<string, unknown> {
  const rows: TelegramButton[][] = [
    [{ text: "💬 Чат", callback_data: "menu:chat" }, { text: "🎨 Изображения", callback_data: "menu:image" }],
    [{ text: "📚 Сменить модель", callback_data: "menu:model" }, { text: "📖 Мои диалоги", callback_data: "menu:dialogs" }],
    [{ text: "🧰 Инструменты", callback_data: "menu:tools" }, { text: "👤 Аккаунт", callback_data: "menu:account" }],
    [{ text: "❓ Помощь", callback_data: "menu:help" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠 Admin", callback_data: "menu:admin" }]);
  return { inline_keyboard: rows };
}

export function toolsKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "🔎 Поиск", callback_data: "tool:search" }],
      [{ text: "📄 Documents", callback_data: "tool:documents" }, { text: "🎭 Roles", callback_data: "tool:roles" }],
      [{ text: "💬 Chat", callback_data: "tool:chat" }],
      [{ text: "← В меню", callback_data: "menu:chat" }],
    ],
  };
}

export function accountKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "Подписка и баллы", callback_data: "account:plans" }, { text: "Мои заказы", callback_data: "account:orders" }],
      [{ text: "🌐 Язык", callback_data: "account:language" }, { text: "❓ Помощь", callback_data: "menu:help" }],
      [{ text: "← В чат", callback_data: "menu:chat" }],
    ],
  };
}
