// Acesso (erp_access): papel do membro e permissões finas. Portado de
// erp_access.member_role, erp_access.permitted e erp_access.permission_parent.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { saoPauloMidnight } from "../../engine/time.ts";
import { PERMISSION_KEYS } from "./permission-keys.generated.ts";

export * from "./stubs.generated.ts";
export { ROLE_RESOURCES, resourcesForRole } from "../../role-resources.ts";
// Reexportada pela P (Catálogo) para erp_catalog.seller_access_allowed, com o
// combinado da orquestração; nada muda no Acesso.
export { windowOpen } from "./internal.ts";

const KEYS = new Set(PERMISSION_KEYS);

/** Papel ativo do membro (null sem vínculo ativo). */
export function activeRole(db: SqlDriver, user: string): string | null {
  const row = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  return row ? String(row.role) : null;
}

/** erp_access.member_role: exige membro ativo (42501). */
export function memberRole(db: SqlDriver, user: string | null): string {
  const role = user ? activeRole(db, user) : null;
  if (!user || !role) raise("42501", "erp_access_member_required");
  return role;
}

/** erp_access.permission_parent: "a.b.c" → "a.b"; menos de 3 partes → null. */
export function permissionParent(key: string) {
  const parts = key.split(".");
  return parts.length > 2 ? `${parts[0]}.${parts[1]}` : null;
}

/** erp_access.permission_keys(): a lista constante (permission-keys.generated.ts). */
export const permissionKeys = (): string[] => [...PERMISSION_KEYS];

/** erp_access.mfa_policy_on */
export const mfaPolicyOn = (db: SqlDriver) =>
  !!one(db, 'SELECT mfa_required FROM "erp_access__security_policy" WHERE singleton=1')?.mfa_required;

/** erp_access.gate_required: horário de acesso (controle ou vendedor) ou MFA obrigatório. */
export function gateRequired(db: SqlDriver, user: string): boolean {
  if (one(db, 'SELECT 1 x FROM "erp_access__user_control" WHERE user_id=? AND schedule_enabled=1', user)) return true;
  if (
    one(
      db,
      `SELECT 1 x FROM "erp_catalog__seller" WHERE user_id=? AND access_hours_enabled=1 AND json_array_length(access_windows)>0`,
      user,
    )
  )
    return true;
  return mfaPolicyOn(db);
}

/** Administrador ativo, senão 42501 com a mensagem dada. */
function adminOnly(db: SqlDriver, actor: string | null, message: string) {
  if (!actor || !one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, actor))
    raise("42501", message);
}
/** erp_access.read_admin */
export const readAdmin = (db: SqlDriver, actor: string | null) => adminOnly(db, actor, "erp_access_users_access_denied");
/** erp_access.require_admin(p_actor, p_lock): a trava do Postgres não existe no escritor único. */
export const accessRequireAdmin = (db: SqlDriver, actor: string | null, _lock = false) =>
  adminOnly(db, actor, "erp_access_users_access_denied");
/** erp_activity.require_admin */
export const activityRequireAdmin = (db: SqlDriver, actor: string | null) =>
  adminOnly(db, actor, "erp_activity_access_denied");

/** erp_access.require_history_role: admin, consulta ou fiscal. */
export function requireHistoryRole(db: SqlDriver, user: string | null): string {
  const role = user ? activeRole(db, user) : null;
  if (!role || !["admin", "consulta", "fiscal"].includes(role)) raise("42501", "erp_access_denied");
  return role;
}

/** erp_access.require_permission */
export function requirePermission(db: SqlDriver, user: string, key: string) {
  if (!permitted(db, user, key)) raise("42501", "erp_access_permission_denied");
}

/** erp_access.scalar_text(jsonb, p_max default 200): texto de string, número ou booleano; senão null. */
export function scalarText(value: unknown, max: number | null = 200): string | null {
  const t = jsonType(value);
  if (t !== "string" && t !== "number" && t !== "boolean") return null;
  if (max === null) return null;
  const text = t === "string" ? (value as string) : jsonbText(value);
  return [...text].slice(0, Math.max(max, 0)).join("");
}

/** erp_activity.clean: controles viram espaço, corta em p_max caracteres. */
export const clean = (text: string | null, max: number) =>
  text === null ? null : [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, max).join("");

/**
 * erp_activity.period(p_from, p_to): intervalo [início, fim) em µs, dias de
 * São Paulo; até 365 dias, entre 2020 e 2100.
 */
export function period(from: string | null, to: string | null): { from: bigint; to: bigint } {
  if (from === null || to === null || to < from || from < "2020-01-01" || to > "2100-12-31") raise("22023", "erp_activity_input_invalid");
  const days = (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400_000;
  if (days > 365) raise("22023", "erp_activity_input_invalid");
  const next = new Date(Date.parse(to + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
  return { from: saoPauloMidnight(from), to: saoPauloMidnight(next) };
}

/**
 * erp_activity.actor_label: nome do perfil, senão o e-mail do auth.users.
 * No Wabotia não há auth.users no objeto: o nome vem de erp_access.profile
 * (o sincronismo com Pessoas da fase 3 o mantém); sem perfil, "Usuário xxxxxxxx".
 */
export function actorLabel(db: SqlDriver, actor: string): string {
  const p = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', actor);
  const label = (p?.name as string | null) ?? `Usuário ${actor.slice(0, 8)}`;
  return [...label].slice(0, 200).join("");
}

/** erp_access.permitted */
export function permitted(db: SqlDriver, user: string, key: string): boolean {
  if (!KEYS.has(key)) return false;
  const admin = one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (admin?.role === "admin") return true;
  const control = one(db, 'SELECT permissions FROM "erp_access__user_control" WHERE user_id=?', user);
  if (!control) return true;
  if (control.permissions === null) return true;
  const granted: string[] = JSON.parse(String(control.permissions));
  const parent = permissionParent(key);
  return granted.includes(key) && (parent === null || granted.includes(parent));
}
