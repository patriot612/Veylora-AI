import { env } from "./test-env";
import { describe, expect, it } from "vitest";
import { createPlanInvoice, parseInvoiceOrderId, settleSuccessfulPayment, validatePreCheckout } from "../src/payments/service";

let tg = 980000000;

async function seedPaymentUser() {
  const userId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id,telegram_user_id,daily_billing_day,daily_points_remaining,bonus_points,created_at,updated_at) VALUES (?1,?2,'2026-09-28',50,0,'2026-09-28T12:00:00Z','2026-09-28T12:00:00Z')",
  ).bind(userId, ++tg).run();
  return { userId, telegramUserId: tg };
}

function fakeTelegram(calls: Array<{ url: string; payload?: Record<string, unknown> }>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, payload: body });
    if (url.includes("/sendInvoice")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/answerPreCheckoutQuery")) {
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("Telegram Stars payments", () => {
  it("creates an invoice from the server-side plan price only", async () => {
    const { userId } = await seedPaymentUser();
    await env.DB.prepare("UPDATE plans SET price_stars=123 WHERE id='plan_month'").run();
    const calls: Array<{url:string;payload?:Record<string,unknown>}> = [];
    const result = await createPlanInvoice({
      db: env.DB,
      botToken: "bot",
      userId,
      chatId: 123,
      planId: "plan_month",
      now: "2026-09-28T12:00:00Z",
      fetchImpl: fakeTelegram(calls),
    });
    expect(result).toHaveProperty("orderId");
    expect(result).toHaveProperty("messageId", 500);
    const invoice = calls.find((call) => call.url.includes("/sendInvoice"))?.payload;
    expect(invoice?.currency).toBe("XTR");
    expect(invoice?.prices).toEqual([{ label: expect.any(String), amount: 123 }]);
    expect(invoice?.provider_token).toBe("");
  });

  it("accepts precheckout only when amount/currency/user/order match", async () => {
    const { userId, telegramUserId } = await seedPaymentUser();
    const orderId = crypto.randomUUID();
    const payload = "veylora:order:" + orderId;
    await env.DB.prepare(
      "INSERT INTO orders (id,user_id,plan_id,status,amount,currency,provider,created_at) VALUES (?1,?2,'plan_month','pending',77,'XTR','telegram_stars','2026-09-28T12:00:00Z')",
    ).bind(orderId, userId).run();

    const calls: Array<{url:string;payload?:Record<string,unknown>}> = [];
    const valid = await validatePreCheckout({
      db: env.DB,
      botToken: "bot",
      preCheckoutQueryId: "pre-1",
      telegramUserId,
      currency: "XTR",
      totalAmount: 77,
      invoicePayload: payload,
      fetchImpl: fakeTelegram(calls),
    });
    expect(valid).toBe(true);
    expect(calls.at(-1)?.payload).toMatchObject({ pre_checkout_query_id: "pre-1", ok: true });

    const invalid = await validatePreCheckout({
      db: env.DB,
      botToken: "bot",
      preCheckoutQueryId: "pre-2",
      telegramUserId,
      currency: "XTR",
      totalAmount: 78,
      invoicePayload: payload,
      fetchImpl: fakeTelegram(calls),
    });
    expect(invalid).toBe(false);
    expect(calls.at(-1)?.payload).toMatchObject({ pre_checkout_query_id: "pre-2", ok: false });
  });

  it("settles successful payment once and activates one subscription", async () => {
    const { userId, telegramUserId } = await seedPaymentUser();
    const orderId = crypto.randomUUID();
    const payload = "veylora:order:" + orderId;
    await env.DB.prepare(
      "INSERT INTO orders (id,user_id,plan_id,status,amount,currency,provider,created_at) VALUES (?1,?2,'plan_month','pending',90,'XTR','telegram_stars','2026-09-28T12:00:00Z')",
    ).bind(orderId, userId).run();

    const first = await settleSuccessfulPayment({
      db: env.DB,
      userId,
      telegramUserId,
      currency: "XTR",
      totalAmount: 90,
      invoicePayload: payload,
      telegramPaymentChargeId: "charge-1",
      now: "2026-09-28T12:00:00Z",
    });
    expect(first).toHaveProperty("duplicate", false);
    if (!("subscriptionId" in first)) throw new Error("missing subscription");
    expect(parseInvoiceOrderId(payload)).toBe(orderId);

    const second = await settleSuccessfulPayment({
      db: env.DB,
      userId,
      telegramUserId,
      currency: "XTR",
      totalAmount: 90,
      invoicePayload: payload,
      telegramPaymentChargeId: "charge-1",
      now: "2026-09-28T12:01:00Z",
    });
    expect(second).toEqual({ orderId, subscriptionId: first.subscriptionId, duplicate: true });

    const orders = await env.DB.prepare("SELECT COUNT(*) AS count FROM orders WHERE id=?1 AND status='paid'").bind(orderId).first<{count:number}>();
    const payments = await env.DB.prepare("SELECT COUNT(*) AS count FROM payments WHERE order_id=?1").bind(orderId).first<{count:number}>();
    const subscriptions = await env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE user_id=?1 AND status='active'").bind(userId).first<{count:number}>();
    expect(orders?.count).toBe(1);
    expect(payments?.count).toBe(1);
    expect(subscriptions?.count).toBe(1);
  });
});
