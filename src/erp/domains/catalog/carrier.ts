// Transportadora do contato: erp_catalog.contact_carrier_match (papel,
// espelho do Origin, complemento local ou contato sem tipo). O ramo 'origin'
// lê erp_catalog.origin_mirror (regra "Origin fora": leitura do espelho se
// porta como leitura).
import { one, type SqlDriver } from "../../engine/driver.ts";

/** fields->'source_roles' ? 'carrier': elemento texto do array, ou chave do objeto. */
function hasCarrier(fields: unknown): boolean {
  const roles = (fields as { source_roles?: unknown } | null)?.source_roles;
  if (Array.isArray(roles)) return roles.some((r) => r === "carrier");
  if (roles !== null && typeof roles === "object") return Object.hasOwn(roles, "carrier");
  return roles === "carrier";
}

/** erp_catalog.contact_carrier_match(p_id): 'role', 'origin', 'complement', 'untyped' ou null. */
export function contactCarrierMatch(db: SqlDriver, id: string): string | null {
  const c = one(db, 'SELECT roles FROM "erp_catalog__contact" WHERE record_id=?', id);
  const roles: string[] = c ? JSON.parse(String(c.roles)) : [];
  if (c && roles.includes("carrier")) return "role";
  const mirrors = db.exec(`SELECT fields FROM "erp_catalog__origin_mirror" WHERE record_id=? AND entity='contacts'`, id).rows;
  if (mirrors.some((m) => hasCarrier(JSON.parse(String(m.fields))))) return "origin";
  if (one(db, `SELECT 1 x FROM "erp_catalog__contact_role_complement" WHERE record_id=? AND role='carrier'`, id)) return "complement";
  if (c && roles.length === 0) return "untyped";
  return null;
}
