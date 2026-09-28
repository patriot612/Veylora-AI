import { sendTelegramInvoice, answerPreCheckoutQuery } from "../telegram/api";

type OrderRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  amount: number;
  currency: string;
};

export function buildInvoicePayload(orderId: string): string {
  return "veylora:order:" + orderId;
}

export function parseInvoiceOrderId(payload: string): string | null {
  const prefix = "veylora:order:";
  return payload.startsWith(prefix) && payload.length > prefix.length ? payload.slice(prefix.length) : null;
}

export async function createPlanInvoice(input: {
  db: D1Database;
  botToken: string;
  userId: string;
  chatId: number;
  planId: string;
  now: string;
  fetchImpl?: typeof fetch;
}): Promise<{ orderId: string; messageId: number } | { error: string }> {
  const plan = await input.db
    .prepare("SELECT id, name, price_stars, enabled, duration_days FROM plans WHERE id=?1")
    .bind(input.planId)
    .first<{ id: string; name: string; price_stars: number; enabled: number; duration_days: number }>();

  if (!plan || plan.enabled !== 1) return { error: "plan_unavailable" };
  if (!Number.isSafeInteger(plan.price_stars) || plan.price_stars <= 0) return { error: "plan_price_not_configured" };

  const orderId = crypto.randomUUID();
  const payload = buildInvoicePayload(orderId);
  await input.db
    .prepare(
      "INSERT INTO orders (id,user_id,plan_id,status,amount,currency,provider,created_at) VALUES (?1,?2,?3,'pending',?4,'XTR','telegram_stars',?5)",
    )
    .bind(orderId, input.userId, input.planId, plan.price_stars, input.now)
    .run();

  try {
    const invoice = await sendTelegramInvoice(
      input.botToken,
      input.chatId,
      {
        title: plan.name,
        description: plan.name + " — подписка Veylora AI",
        payload,
        currency: "XTR",
        amount: plan.price_stars,
        startParameter: "plan-" + plan.id,
      },
      input.fetchImpl ?? fetch,
    );
    return { orderId, messageId: invoice.message_id };
  } catch (error) {
    await input.db
      .prepare("UPDATE orders SET status='failed' WHERE id=?1 AND status='pending'")
      .bind(orderId)
      .run()
      .catch(() => undefined);
    return { error: error instanceof Error ? error.message : "invoice_send_failed" };
  }
}

export async function validatePreCheckout(input: {
  db: D1Database;
  botToken: string;
  preCheckoutQueryId: string;
  telegramUserId: number;
  currency: string;
  totalAmount: number;
  invoicePayload: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const orderId = parseInvoiceOrderId(input.invoicePayload);
  if (!orderId) {
    await answerPreCheckoutQuery(input.botToken, input.preCheckoutQueryId, false, "Invalid invoice payload.", input.fetchImpl);
    return false;
  }

  const order = await input.db
    .prepare(
      "SELECT o.id,o.user_id,o.plan_id,o.status,o.amount,o.currency FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?1 AND u.telegram_user_id=?2",
    )
    .bind(orderId, input.telegramUserId)
    .first<OrderRow>();

  const valid =
    !!order &&
    order.status === "pending" &&
    order.currency === "XTR" &&
    input.currency === "XTR" &&
    order.amount === input.totalAmount;

  if (!valid) {
    await answerPreCheckoutQuery(
      input.botToken,
      input.preCheckoutQueryId,
      false,
      "Invoice validation failed. Please create a new invoice.",
      input.fetchImpl,
    );
    return false;
  }

  await answerPreCheckoutQuery(input.botToken, input.preCheckoutQueryId, true, undefined, input.fetchImpl);
  return true;
}

export async function settleSuccessfulPayment(input: {
  db: D1Database;
  userId: string;
  telegramUserId: number;
  currency: string;
  totalAmount: number;
  invoicePayload: string;
  telegramPaymentChargeId: string;
  now: string;
}): Promise<{ orderId: string; subscriptionId: string; duplicate: boolean } | { error: string }> {
  const orderId = parseInvoiceOrderId(input.invoicePayload);
  if (!orderId) return { error: "invalid_invoice_payload" };

  const order = await input.db
    .prepare(
      "SELECT o.id,o.user_id,o.plan_id,o.status,o.amount,o.currency FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?1 AND u.telegram_user_id=?2",
    )
    .bind(orderId, input.telegramUserId)
    .first<OrderRow>();

  if (!order) return { error: "order_not_found" };
  if (order.status === "paid") {
    const existing = await input.db
      .prepare("SELECT id FROM subscriptions WHERE user_id=?1 AND plan_id=?2 AND status='active' ORDER BY created_at DESC LIMIT 1")
      .bind(order.user_id, order.plan_id)
      .first<{ id: string }>();
    return existing
      ? { orderId, subscriptionId: existing.id, duplicate: true }
      : { error: "paid_order_subscription_missing" };
  }

  if (order.status !== "pending" || order.amount !== input.totalAmount || order.currency !== input.currency || input.currency !== "XTR") {
    return { error: "payment_validation_failed" };
  }

  const duplicatePayment = await input.db
    .prepare("SELECT order_id FROM payments WHERE provider='telegram_stars' AND external_payment_id=?1")
    .bind(input.telegramPaymentChargeId)
    .first<{ order_id: string }>();

  if (duplicatePayment) {
    const existing = await input.db
      .prepare("SELECT id FROM subscriptions WHERE user_id=?1 ORDER BY created_at DESC LIMIT 1")
      .bind(order.user_id)
      .first<{ id: string }>();
    return existing
      ? { orderId, subscriptionId: existing.id, duplicate: true }
      : { error: "duplicate_payment_subscription_missing" };
  }

  const plan = await input.db
    .prepare("SELECT duration_days FROM plans WHERE id=?1 AND enabled=1")
    .bind(order.plan_id)
    .first<{ duration_days: number }>();
  if (!plan) return { error: "plan_unavailable" };

  const subscriptionId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const startsAt = input.now;
  const days = Math.max(1, plan.duration_days);
  const endsAt = new Date(Date.parse(startsAt) + days * 86_400_000).toISOString();

  try {
    const result = await input.db.batch([
      input.db
        .prepare("UPDATE orders SET status='paid',telegram_payment_charge_id=?2,paid_at=?3 WHERE id=?1 AND status='pending'")
        .bind(orderId, input.telegramPaymentChargeId, input.now),
      input.db
        .prepare("INSERT INTO payments (id,order_id,provider,external_payment_id,status,raw_safe_metadata,created_at) VALUES (?1,?2,'telegram_stars',?3,'paid',?4,?5)")
        .bind(paymentId, orderId, input.telegramPaymentChargeId, JSON.stringify({ currency: input.currency, amount: input.totalAmount }), input.now),
      input.db
        .prepare("UPDATE subscriptions SET status='expired',updated_at=?2 WHERE user_id=?1 AND status='active'")
        .bind(order.user_id, input.now),
      input.db
        .prepare("INSERT INTO subscriptions (id,user_id,plan_id,status,starts_at,ends_at,created_at,updated_at) VALUES (?1,?2,?3,'active',?4,?5,?4,?4)")
        .bind(subscriptionId, order.user_id, order.plan_id, startsAt, endsAt),
    ]);
    if ((result[0].meta.changes ?? 0) !== 1) throw new Error("payment_order_already_settled");
    await input.db.prepare(
      "INSERT INTO audit_log (id,actor_user_id,event_type,target_type,target_id,safe_metadata,created_at) VALUES (?1,?2,'payment.success','order',?3,?4,?5)",
    ).bind(
      crypto.randomUUID(),
      order.user_id,
      orderId,
      JSON.stringify({ provider: "telegram_stars", amount: input.totalAmount, currency: input.currency }),
      input.now,
    ).run();
    return { orderId, subscriptionId, duplicate: false };
  } catch (error) {
    const settled = await input.db
      .prepare("SELECT status FROM orders WHERE id=?1 AND user_id=?2")
      .bind(orderId, order.user_id)
      .first<{ status: string }>();
    if (settled?.status === "paid") {
      const existing = await input.db
        .prepare("SELECT id FROM subscriptions WHERE user_id=?1 AND plan_id=?2 AND status='active' ORDER BY created_at DESC LIMIT 1")
        .bind(order.user_id, order.plan_id)
        .first<{ id: string }>();
      if (existing) return { orderId, subscriptionId: existing.id, duplicate: true };
    }
    throw error;
  }
}
