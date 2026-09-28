import { grantBonusPoints } from "../subscriptions";
import { refundTelegramStarPayment } from "../telegram/api";
import { assertPermission, type AdminPermission } from "./rbac";
import type { AdminSession } from "./auth";

export async function handleAdminApi(
  request: Request,
  env: Env,
  session: AdminSession,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;

  if (path === "session" && method === "GET") {
    return Response.json({ ok: true, user: session.identity, role: session.role }, { headers: noStore() });
  }

  const parts = path.split("/").filter(Boolean);
  const prefix = parts[0] ?? "";
  const routes: Array<{ prefix: string; permission: AdminPermission; handler: () => Promise<Response> }> = [
    { prefix: "dashboard", permission: "dashboard.read", handler: () => dashboard(env, session) },
    { prefix: "users", permission: "users.read", handler: () => users(env, request, session, parts.slice(1)) },
    { prefix: "models", permission: "models.read", handler: () => models(env, request, session, parts.slice(1)) },
    { prefix: "providers", permission: "providers.read", handler: () => providers(env) },
    { prefix: "roles", permission: "roles.write", handler: () => roles(env, request, session, parts.slice(1)) },
    { prefix: "templates", permission: "templates.write", handler: () => templates(env, request, session, parts.slice(1)) },
    { prefix: "plans", permission: "plans.write", handler: () => plans(env, request, session, parts.slice(1)) },
    { prefix: "payments", permission: "payments.read", handler: () => payments(env, request, session, parts.slice(1)) },
    { prefix: "search", permission: "search.read", handler: () => search(env) },
    { prefix: "statistics", permission: "statistics.read", handler: () => statistics(env) },
    { prefix: "queue", permission: "queue.read", handler: () => queue(env) },
    { prefix: "audit", permission: "audit.read", handler: () => audit(env) },
    { prefix: "config", permission: "system.write", handler: () => config(env, request, session) },
  ];

  const route = routes.find((candidate) => prefix === candidate.prefix);
  if (!route) return Response.json({ error: "not_found" }, { status: 404, headers: noStore() });
  assertPermission(session, route.permission);
  return route.handler();
}

async function dashboard(env: Env, session: AdminSession) {
  const [users, operations, queueJobs, subscriptions, payments] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status!='deleted'").first<{count:number}>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM operations WHERE created_at >= datetime('now','-1 day')").first<{count:number}>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM queue_jobs WHERE status IN ('pending','processing')").first<{count:number}>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE status='active'").first<{count:number}>(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS stars FROM orders WHERE status='paid' AND created_at >= datetime('now','-1 day')").first<{stars:number}>(),
  ]);
  return Response.json({ ok: true, role: session.role, users: users?.count ?? 0, operations24h: operations?.count ?? 0, queuePending: queueJobs?.count ?? 0, activeSubscriptions: subscriptions?.count ?? 0, stars24h: payments?.stars ?? 0 }, { headers: noStore() });
}

async function users(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    if (segments[0]) {
      const telegramUserId = Number(segments[0]);
      if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return Response.json({ error: "invalid_telegram_user_id" }, { status: 400, headers: noStore() });
      const user = await env.DB.prepare("SELECT id,telegram_user_id,username,first_name,status,active_mode,daily_points_remaining,bonus_points,created_at,updated_at FROM users WHERE telegram_user_id=?1").bind(telegramUserId).first();
      if (!user) return Response.json({ error: "user_not_found" }, { status: 404, headers: noStore() });
      const userId = (user as { id: string }).id;
      const [subscription, activity] = await Promise.all([
        env.DB.prepare("SELECT s.id,s.plan_id,p.name AS plan_name,s.status,s.starts_at,s.ends_at FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=?1 ORDER BY s.created_at DESC LIMIT 5").bind(userId).all(),
        env.DB.prepare("SELECT type,status,points_cost,created_at,finished_at,error_code FROM operations WHERE user_id=?1 ORDER BY created_at DESC LIMIT 50").bind(userId).all(),
      ]);
      return Response.json({ ok: true, user, subscription: subscription.results ?? [], activity: activity.results ?? [] }, { headers: noStore() });
    }
    const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const rows = q
      ? await env.DB.prepare("SELECT id,telegram_user_id,username,first_name,status,active_mode,daily_points_remaining,bonus_points,created_at,updated_at FROM users WHERE username LIKE ?1 OR first_name LIKE ?1 OR CAST(telegram_user_id AS TEXT)=?2 ORDER BY created_at DESC LIMIT 200").bind("%" + q + "%", q).all()
      : await env.DB.prepare("SELECT id,telegram_user_id,username,first_name,status,active_mode,daily_points_remaining,bonus_points,created_at,updated_at FROM users ORDER BY created_at DESC LIMIT 200").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }

  if (request.method === "POST" && segments.length === 2 && segments[1] === "bonus") {
    assertPermission(session, "users.write");
    const telegramUserId = Number(segments[0]);
    const body = await request.json<{ amount?: unknown }>();
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0 || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) {
      return Response.json({ error: "invalid_bonus_amount" }, { status: 400, headers: noStore() });
    }
    const user = await env.DB.prepare("SELECT id FROM users WHERE telegram_user_id=?1").bind(telegramUserId).first<{id:string}>();
    if (!user) return Response.json({ error: "user_not_found" }, { status: 404, headers: noStore() });
    if (!(await grantBonusPoints(env.DB, user.id, amount, new Date().toISOString()))) {
      return Response.json({ error: "bonus_grant_failed" }, { status: 409, headers: noStore() });
    }
    await writeAudit(env.DB, user.id, "bonus.grant", "user", user.id, session.role);
    return Response.json({ ok: true, amount }, { headers: noStore() });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
}

async function models(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT m.id,m.display_name,m.type,m.points_cost,m.subscription_only,m.enabled,m.provider_model_id,f.name AS family_name,p.name AS provider_name,c.name AS credential_name FROM models m JOIN families f ON f.id=m.family_id JOIN providers p ON p.id=m.provider_id JOIN credentials c ON c.id=m.credential_id ORDER BY m.type,m.display_name").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  assertPermission(session, "models.write");
  const modelId = segments[0] ?? "";
  if (!modelId) return Response.json({ error: "model_id_required" }, { status: 400, headers: noStore() });
  if (request.method !== "PUT") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  const body = await request.json<Record<string, unknown>>();
  const updates: string[] = [];
  const bindings: unknown[] = [];
  const assign = (column: string, value: unknown) => { updates.push(column + "=?"+(bindings.length + 1)); bindings.push(value); };
  if ("pointsCost" in body) {
    const value = Number(body.pointsCost);
    if (!Number.isSafeInteger(value) || value < 0) return Response.json({ error: "invalid_points_cost" }, { status: 400, headers: noStore() });
    assign("points_cost", value);
  }
  if ("subscriptionOnly" in body) {
    const value = body.subscriptionOnly === true ? 1 : body.subscriptionOnly === false ? 0 : Number(body.subscriptionOnly);
    if (value !== 0 && value !== 1) return Response.json({ error: "invalid_subscription_only" }, { status: 400, headers: noStore() });
    assign("subscription_only", value);
  }
  if ("enabled" in body) {
    const value = body.enabled === true ? 1 : body.enabled === false ? 0 : Number(body.enabled);
    if (value !== 0 && value !== 1) return Response.json({ error: "invalid_enabled" }, { status: 400, headers: noStore() });
    assign("enabled", value);
  }
  if ("displayName" in body) {
    if (typeof body.displayName !== "string" || body.displayName.trim().length === 0 || body.displayName.length > 200) return Response.json({ error: "invalid_display_name" }, { status: 400, headers: noStore() });
    assign("display_name", body.displayName.trim());
  }
  if ("contextWindow" in body) {
    const value = Number(body.contextWindow);
    if (!Number.isSafeInteger(value) || value <= 0) return Response.json({ error: "invalid_context_window" }, { status: 400, headers: noStore() });
    assign("context_window", value);
  }
  if ("maxOutputTokens" in body) {
    const value = Number(body.maxOutputTokens);
    if (!Number.isSafeInteger(value) || value <= 0) return Response.json({ error: "invalid_max_output_tokens" }, { status: 400, headers: noStore() });
    assign("max_output_tokens", value);
  }
  if (!updates.length) return Response.json({ error: "no_changes" }, { status: 400, headers: noStore() });
  updates.push("updated_at=?"+(bindings.length + 1));
  bindings.push(new Date().toISOString());
  const result = await env.DB.prepare("UPDATE models SET " + updates.join(",") + " WHERE id=?"+(bindings.length + 1)).bind(...bindings, modelId).run();
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "model_not_found" }, { status: 404, headers: noStore() });
  await writeAudit(env.DB, null, "model.update", "model", modelId, session.role);
  return Response.json({ ok: true }, { headers: noStore() });
}

async function providers(env: Env) {
  const rows = await env.DB.prepare("SELECT id,name,adapter_type,endpoint,enabled,created_at,updated_at FROM providers ORDER BY name").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function roles(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,name,description,enabled,created_at,updated_at FROM ai_roles ORDER BY name").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  assertPermission(session, "roles.write");
  const id = segments[0] || crypto.randomUUID();
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM ai_roles WHERE id=?1").bind(id).run();
    if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "role_not_found" }, { status: 404, headers: noStore() });
    await writeAudit(env.DB, null, "role.delete", "role", id, session.role);
    return Response.json({ ok: true }, { headers: noStore() });
  }
  if (request.method !== "PUT" && request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  const body = await request.json<{name?:unknown;description?:unknown;systemPrompt?:unknown;enabled?:unknown}>();
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 120) return Response.json({ error: "invalid_role_name" }, { status: 400, headers: noStore() });
  if (typeof body.description !== "string" || body.description.length > 1000) return Response.json({ error: "invalid_role_description" }, { status: 400, headers: noStore() });
  if (typeof body.systemPrompt !== "string" || body.systemPrompt.length === 0 || body.systemPrompt.length > 20_000) return Response.json({ error: "invalid_system_prompt" }, { status: 400, headers: noStore() });
  const enabled = body.enabled === false ? 0 : 1;
  const result = await env.DB.prepare("INSERT INTO ai_roles(id,name,description,system_prompt,enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,system_prompt=excluded.system_prompt,enabled=excluded.enabled,updated_at=excluded.updated_at").bind(id, body.name.trim(), body.description, body.systemPrompt, enabled, new Date().toISOString()).run();
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "role_write_failed" }, { status: 409, headers: noStore() });
  await writeAudit(env.DB, null, "role.write", "role", id, session.role);
  return Response.json({ ok: true, id }, { headers: noStore() });
}

async function templates(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,name,description,extra_points_cost,enabled,created_at,updated_at FROM image_templates ORDER BY name").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  assertPermission(session, "templates.write");
  const id = segments[0] || crypto.randomUUID();
  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM image_templates WHERE id=?1").bind(id).run();
    if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "template_not_found" }, { status: 404, headers: noStore() });
    await writeAudit(env.DB, null, "template.delete", "template", id, session.role);
    return Response.json({ ok: true }, { headers: noStore() });
  }
  if (request.method !== "PUT" && request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  const body = await request.json<{name?:unknown;description?:unknown;promptTemplate?:unknown;extraPointsCost?:unknown;enabled?:unknown}>();
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 120) return Response.json({ error: "invalid_template_name" }, { status: 400, headers: noStore() });
  if (typeof body.description !== "string" || body.description.length > 1000) return Response.json({ error: "invalid_template_description" }, { status: 400, headers: noStore() });
  if (typeof body.promptTemplate !== "string" || body.promptTemplate.length === 0 || body.promptTemplate.length > 20_000) return Response.json({ error: "invalid_prompt_template" }, { status: 400, headers: noStore() });
  const extra = Number(body.extraPointsCost);
  if (!Number.isSafeInteger(extra) || extra < 0) return Response.json({ error: "invalid_extra_points_cost" }, { status: 400, headers: noStore() });
  const enabled = body.enabled === false ? 0 : 1;
  await env.DB.prepare("INSERT INTO image_templates(id,name,description,prompt_template,extra_points_cost,enabled,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,prompt_template=excluded.prompt_template,extra_points_cost=excluded.extra_points_cost,enabled=excluded.enabled,updated_at=excluded.updated_at").bind(id, body.name.trim(), body.description, body.promptTemplate, extra, enabled, new Date().toISOString()).run();
  await writeAudit(env.DB, null, "template.write", "template", id, session.role);
  return Response.json({ ok: true, id }, { headers: noStore() });
}

async function plans(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,code,name,duration_days,daily_points,retention_hours,voice_enabled,price_stars,enabled,created_at,updated_at FROM plans ORDER BY duration_days").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  assertPermission(session, "plans.write");
  const id = segments[0] ?? "";
  if (!id || request.method !== "PUT") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  const body = await request.json<Record<string, unknown>>();
  const updates: string[] = [];
  const bindings: unknown[] = [];
  const assign = (column: string, value: unknown) => { updates.push(column + "=?"+(bindings.length + 1)); bindings.push(value); };
  if ("priceStars" in body) { const value = Number(body.priceStars); if (!Number.isSafeInteger(value) || value < 0) return Response.json({ error: "invalid_price_stars" }, { status: 400, headers: noStore() }); assign("price_stars", value); }
  if ("dailyPoints" in body) { const value = Number(body.dailyPoints); if (!Number.isSafeInteger(value) || value < 0) return Response.json({ error: "invalid_daily_points" }, { status: 400, headers: noStore() }); assign("daily_points", value); }
  if ("retentionHours" in body) { const value = Number(body.retentionHours); if (!Number.isSafeInteger(value) || value <= 0) return Response.json({ error: "invalid_retention_hours" }, { status: 400, headers: noStore() }); assign("retention_hours", value); }
  if ("voiceEnabled" in body) { const value = body.voiceEnabled === true ? 1 : body.voiceEnabled === false ? 0 : Number(body.voiceEnabled); if (value !== 0 && value !== 1) return Response.json({ error: "invalid_voice_enabled" }, { status: 400, headers: noStore() }); assign("voice_enabled", value); }
  if ("enabled" in body) { const value = body.enabled === true ? 1 : body.enabled === false ? 0 : Number(body.enabled); if (value !== 0 && value !== 1) return Response.json({ error: "invalid_enabled" }, { status: 400, headers: noStore() }); assign("enabled", value); }
  if (!updates.length) return Response.json({ error: "no_changes" }, { status: 400, headers: noStore() });
  updates.push("updated_at=?"+(bindings.length + 1));
  bindings.push(new Date().toISOString());
  const result = await env.DB.prepare("UPDATE plans SET " + updates.join(",") + " WHERE id=?"+(bindings.length + 1)).bind(...bindings, id).run();
  if ((result.meta.changes ?? 0) !== 1) return Response.json({ error: "plan_not_found" }, { status: 404, headers: noStore() });
  await writeAudit(env.DB, null, "plan.update", "plan", id, session.role);
  return Response.json({ ok: true }, { headers: noStore() });
}

async function payments(env: Env, request: Request, session: AdminSession, segments: string[]) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT o.id,o.user_id,u.telegram_user_id,o.plan_id,o.status,o.amount,o.currency,o.provider,o.telegram_payment_charge_id,o.created_at,o.paid_at,o.refunded_at FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 200").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  if (request.method !== "POST" || segments.length !== 2 || segments[1] !== "refund") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  assertPermission(session, "payments.refund");
  const orderId = segments[0];
  const order = await env.DB.prepare("SELECT o.id,o.user_id,u.telegram_user_id,o.plan_id,o.status,o.telegram_payment_charge_id FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?1").bind(orderId).first<{id:string;user_id:string;telegram_user_id:number;plan_id:string;status:string;telegram_payment_charge_id:string|null}>();
  if (!order) return Response.json({ error: "order_not_found" }, { status: 404, headers: noStore() });
  if (order.status === "refunded") return Response.json({ ok: true, duplicate: true }, { headers: noStore() });
  if (order.status !== "paid" || !order.telegram_payment_charge_id) return Response.json({ error: "order_not_refundable" }, { status: 409, headers: noStore() });
  if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ error: "telegram_not_configured" }, { status: 503, headers: noStore() });
  try {
    await refundTelegramStarPayment(env.TELEGRAM_BOT_TOKEN, order.telegram_user_id, order.telegram_payment_charge_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "refund_failed";
    if (!/already refunded|already_refunded|CHARGE_ALREADY_REFUNDED/i.test(message)) return Response.json({ error: "telegram_refund_failed" }, { status: 502, headers: noStore() });
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status='refunded',refunded_at=?2 WHERE id=?1 AND status='paid'").bind(orderId, now),
    env.DB.prepare("UPDATE payments SET status='refunded' WHERE order_id=?1 AND status='paid'").bind(orderId),
    env.DB.prepare("UPDATE subscriptions SET status='refunded',updated_at=?2 WHERE user_id=?1 AND plan_id=?3 AND status='active'").bind(order.user_id, now, order.plan_id),
  ]);
  await writeAudit(env.DB, order.user_id, "payment.refund", "order", orderId, session.role);
  return Response.json({ ok: true }, { headers: noStore() });
}
async function search(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT o.id,o.user_id,u.telegram_user_id,o.model_id,m.display_name AS model_name,o.status,o.telegram_delivery_status,o.points_cost,o.error_code,o.created_at,o.finished_at FROM operations o JOIN users u ON u.id=o.user_id LEFT JOIN models m ON m.id=o.model_id WHERE o.type='search' ORDER BY o.created_at DESC LIMIT 200",
  ).all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}

async function statistics(env: Env) {
  const [daily, weekly, points] = await Promise.all([
    env.DB.prepare(
      "SELECT type,status,COUNT(*) AS count FROM operations WHERE created_at >= datetime('now','-1 day') GROUP BY type,status ORDER BY type,status",
    ).all(),
    env.DB.prepare(
      "SELECT type,status,COUNT(*) AS count FROM operations WHERE created_at >= datetime('now','-7 day') GROUP BY type,status ORDER BY type,status",
    ).all(),
    env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN entry_type='capture' THEN amount ELSE 0 END),0) AS captured_points, COALESCE(SUM(CASE WHEN entry_type='release' THEN amount ELSE 0 END),0) AS released_points FROM point_ledger WHERE created_at >= datetime('now','-7 day')",
    ).first<{ captured_points: number; released_points: number }>(),
  ]);
  return Response.json({
    ok: true,
    daily: daily.results ?? [],
    weekly: weekly.results ?? [],
    points: {
      captured: points?.captured_points ?? 0,
      released: points?.released_points ?? 0,
    },
  }, { headers: noStore() });
}

async function queue(env: Env) {
  const rows = await env.DB.prepare("SELECT queue_type,status,COUNT(*) AS count FROM queue_jobs GROUP BY queue_type,status ORDER BY queue_type,status").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function audit(env: Env) {
  const rows = await env.DB.prepare("SELECT id,actor_user_id,event_type,target_type,target_id,safe_metadata,created_at FROM audit_log ORDER BY created_at DESC LIMIT 300").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}

async function config(env: Env, request: Request, session: AdminSession) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT config_key,config_value,updated_by_user_id,updated_at FROM system_config ORDER BY config_key").all();
    return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
  }
  if (request.method !== "PUT") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: noStore() });
  assertPermission(session, "system.write");
  const body = await request.json<{ key?: unknown; value?: unknown }>();
  if (typeof body.key !== "string" || body.key.length < 1 || body.key.length > 200) return Response.json({ error: "invalid_key" }, { status: 400, headers: noStore() });
  const value = typeof body.value === "string" ? body.value : JSON.stringify(body.value);
  if (value.length > 10_000) return Response.json({ error: "value_too_large" }, { status: 413, headers: noStore() });
  const actor = await env.DB.prepare("SELECT id FROM users WHERE telegram_user_id=?1").bind(session.identity.id).first<{id:string}>();
  await env.DB.prepare("INSERT INTO system_config(config_key,config_value,updated_by_user_id,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(config_key) DO UPDATE SET config_value=excluded.config_value, updated_by_user_id=excluded.updated_by_user_id, updated_at=excluded.updated_at").bind(body.key, value, actor?.id ?? null, new Date().toISOString()).run();
  await writeAudit(env.DB, actor?.id ?? null, "config.update", "system_config", body.key, session.role);
  return Response.json({ ok: true }, { headers: noStore() });
}

async function writeAudit(db: D1Database, actorUserId: string | null, eventType: string, targetType: string, targetId: string, role: string) {
  await db.prepare("INSERT INTO audit_log(id,actor_user_id,event_type,target_type,target_id,safe_metadata,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(crypto.randomUUID(), actorUserId, eventType, targetType, targetId, JSON.stringify({ role }), new Date().toISOString()).run();
}
function noStore(): HeadersInit { return { "cache-control": "no-store" }; }
