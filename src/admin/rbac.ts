import type { AdminRole, AdminSession, MiniAppIdentity } from "./auth";

export type AdminPermission =
  | "dashboard.read"
  | "users.read"
  | "users.write"
  | "models.read"
  | "models.write"
  | "providers.read"
  | "providers.write"
  | "credentials.write"
  | "roles.write"
  | "templates.write"
  | "plans.write"
  | "payments.read"
  | "payments.refund"
  | "search.read"
  | "search.write"
  | "statistics.read"
  | "queue.read"
  | "system.write"
  | "audit.read";

const PERMISSIONS: Record<AdminRole, ReadonlySet<AdminPermission>> = {
  owner: new Set([
    "dashboard.read","users.read","users.write","models.read","models.write",
    "providers.read","providers.write","credentials.write","roles.write",
    "templates.write","plans.write","payments.read","payments.refund",
    "search.read","search.write","statistics.read","queue.read","system.write","audit.read",
  ]),
  admin: new Set([
    "dashboard.read","users.read","users.write","models.read","models.write",
    "providers.read","providers.write","roles.write","templates.write",
    "plans.write","payments.read","payments.refund","search.read","search.write","statistics.read","queue.read",
  ]),
  support: new Set(["dashboard.read","users.read","payments.read","search.read","statistics.read","queue.read","audit.read"]),
};

export function hasPermission(session: AdminSession, permission: AdminPermission): boolean {
  return PERMISSIONS[session.role].has(permission);
}

export function assertPermission(session: AdminSession, permission: AdminPermission): void {
  if (!hasPermission(session, permission)) throw new Error("admin_forbidden");
}

export async function loadAdminSession(
  db: D1Database,
  identity: MiniAppIdentity,
  bootstrapOwnerTelegramId?: number,
): Promise<AdminSession | null> {
  const row = await db.prepare(
    "SELECT role FROM admin_roles WHERE user_id=(SELECT id FROM users WHERE telegram_user_id=?1) LIMIT 1",
  ).bind(identity.id).first<{ role: AdminRole }>();
  if (row?.role) return { identity, role: row.role };

  if (bootstrapOwnerTelegramId && bootstrapOwnerTelegramId === identity.id) {
    return { identity, role: "owner" };
  }

  return null;
}

export async function ensureAdminUser(
  db: D1Database,
  identity: MiniAppIdentity,
  role: AdminRole,
  now: string,
): Promise<void> {
  const user = await db.prepare(
    "SELECT id FROM users WHERE telegram_user_id=?1",
  ).bind(identity.id).first<{ id: string }>();
  if (!user) throw new Error("admin_user_not_found");
  await db.prepare(
    "INSERT INTO admin_roles (user_id,role,created_at,updated_at) VALUES (?1,?2,?3,?3) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at",
  ).bind(user.id, role, now).run();
}
