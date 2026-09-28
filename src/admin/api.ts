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

async function users(env: Env) {
  const rows = await env.DB.prepare("SELECT id,telegram_user_id,username,first_name,status,active_mode,daily_points_remaining,bonus_points,created_at,updated_at FROM users ORDER BY created_at DESC LIMIT 200").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function models(env: Env) {
  const rows = await env.DB.prepare("SELECT m.id,m.display_name,m.type,m.points_cost,m.subscription_only,m.enabled,m.provider_model_id,f.name AS family_name,p.name AS provider_name,c.name AS credential_name FROM models m JOIN families f ON f.id=m.family_id JOIN providers p ON p.id=m.provider_id JOIN credentials c ON c.id=m.credential_id ORDER BY m.type,m.display_name").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function providers(env: Env) {
  const rows = await env.DB.prepare("SELECT id,name,adapter_type,endpoint,enabled,created_at,updated_at FROM providers ORDER BY name").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function roles(env: Env) {
  const rows = await env.DB.prepare("SELECT id,name,description,enabled,created_at,updated_at FROM ai_roles ORDER BY name").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function templates(env: Env) {
  const rows = await env.DB.prepare("SELECT id,name,description,extra_points_cost,enabled,created_at,updated_at FROM image_templates ORDER BY name").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function plans(env: Env) {
  const rows = await env.DB.prepare("SELECT id,code,name,duration_days,daily_points,retention_hours,voice_enabled,price_stars,enabled,created_at,updated_at FROM plans ORDER BY duration_days").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
}
async function payments(env: Env) {
  const rows = await env.DB.prepare("SELECT o.id,o.user_id,o.plan_id,o.status,o.amount,o.currency,o.provider,o.telegram_payment_charge_id,o.created_at,o.paid_at,o.refunded_at FROM orders o ORDER BY o.created_at DESC LIMIT 200").all();
  return Response.json({ ok: true, rows: rows.results ?? [] }, { headers: noStore() });
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
