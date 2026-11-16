// Acesso (erp_access): papel do membro e permissões finas. Portado de
// erp_access.member_role, erp_access.permitted e erp_access.permission_parent.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { PERMISSION_KEYS } from "./permission-keys.generated.ts";

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
