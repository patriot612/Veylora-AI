        const command = extractMessageText(update);
        if (typeof command === "string" && command.startsWith("/buy ")) {
          const planId = command.slice("/buy ".length).trim();
          if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
          const invoice = await createPlanInvoice({ db: env.DB, botToken: env.TELEGRAM_BOT_TOKEN, userId: user.id, chatId: envelope.chat_id, planId, now });
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "error" in invoice ? "Не удалось создать счёт: " + invoice.error : "Счёт на оплату создан.");
        }
        if (typeof command === "string" && command === "/admin") {
          if (!env.TELEGRAM_BOT_TOKEN) throw new Error("telegram_bot_token_missing");
          const bootstrapOwner = env.ADMIN_OWNER_TELEGRAM_ID ? Number(env.ADMIN_OWNER_TELEGRAM_ID) : undefined;
          const role = await loadAdminSession(env.DB, { id: user.telegram_user_id, username: user.username, firstName: user.first_name, rawUser: { id: user.telegram_user_id }, authDate: Math.floor(Date.now() / 1000) }, Number.isSafeInteger(bootstrapOwner) ? bootstrapOwner : undefined);
          if (!role) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Доступ к Admin Mini App запрещён.");
          else await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Admin Mini App", { reply_markup: { inline_keyboard: [[{ text: "Открыть Admin", web_app: { url: env.ADMIN_WEBAPP_URL || (new URL(request.url).origin + "/admin") } }]] } });
        }
        if (typeof command === "string" && command === "/documents") {
          await enterDocumentsMode(env.DB, user.id, now);
          if (env.TELEGRAM_BOT_TOKEN) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, envelope.chat_id, "Documents mode включён. Отправьте PDF/DOCX/TXT до 10 МБ.");
        }
        if (typeof command === "string" && command === "/voice") {