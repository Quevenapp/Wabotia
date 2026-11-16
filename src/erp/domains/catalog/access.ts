// Acesso do catálogo: erp_catalog.allowed, erp_catalog.require_access e
// erp_catalog.detail_uuid. allowed usa erp_access.resources_for_role (Acesso,
// N): enquanto ele for stub, a leitura de contatos e produtos lança 0A000.
import type { SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonType } from "../../engine/json.ts";
import { activeRole, permitted, resourcesForRole } from "../access/public.ts";

/** erp_catalog.allowed(p_role, p_entity, p_write) */
export function allowed(role: string | null, entity: string | null, write: boolean | null): boolean {
  if (write === true) {
    if (entity === "contacts") return role !== null && ["admin", "vendas", "financeiro"].includes(role);
    if (entity === "products" || entity === "warehouses") return role !== null && ["admin", "estoque"].includes(role);
    return false;
  }
  if (entity === "warehouses") return role !== null && ["admin", "consulta", "estoque"].includes(role);
  if (entity === "contacts" || entity === "products")
    return (resourcesForRole(role) as readonly string[]).includes(entity);
  return false;
}

const KEYED: Record<string, string> = {
  contacts: "cadastros.clientes_fornecedores.ie",
  products: "cadastros.produtos.ie",
  warehouses: "suprimentos.depositos.ie",
};

/** erp_catalog.require_access(p_user_id, p_entity, p_write): o papel. */
export function requireAccess(db: SqlDriver, user: string | null, entity: string | null, write: boolean | null): string {
  const role = user === null ? null : activeRole(db, user);
  if (role === null || !allowed(role, entity, write)) raise("42501", "erp_catalog_access_denied");
  // Leva H: incluir e editar exigem o .ie do cartão.
  if (write === true && entity !== null && KEYED[entity] && !permitted(db, user!, KEYED[entity]))
    raise("42501", "erp_catalog_access_denied");
  return role;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** erp_catalog.detail_uuid(p_value jsonb): uuid em minúsculas ou null. */
export function detailUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "string" || !UUID.test(value as string)) raise("22023", "erp_catalog_invalid_reference");
  return (value as string).toLowerCase();
}
