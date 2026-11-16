// TEMPORÁRIO (não vai para commit): erp_catalog.require_access, allowed,
// detail_uuid (da P) e erp_access.resources_for_role (da N) até os donos
// publicarem. Sai quando os stubs forem substituídos.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { permitted } from "../../access/public.ts";

export function resourcesForRole(role: string | null): string[] {
  switch (role) {
    case "admin":
    case "consulta":
      return ["contacts", "products", "sales_orders", "purchase_orders", "sales_proposals", "receivables", "payables", "nfe", "nfce"];
    case "vendas":
      return ["contacts", "products", "sales_orders", "sales_proposals"];
    case "financeiro":
      return ["contacts", "receivables", "payables"];
    case "estoque":
      return ["contacts", "products", "purchase_orders"];
    case "fiscal":
      return ["contacts", "products", "sales_orders", "purchase_orders", "nfe", "nfce"];
    default:
      return [];
  }
}

export function allowed(role: string | null, entity: string | null, write: boolean | null): boolean {
  if (write)
    return entity === "contacts"
      ? ["admin", "vendas", "financeiro"].includes(role ?? "")
      : entity === "products" || entity === "warehouses"
        ? ["admin", "estoque"].includes(role ?? "")
        : false;
  if (entity === "warehouses") return ["admin", "consulta", "estoque"].includes(role ?? "");
  if (entity === "contacts" || entity === "products") return resourcesForRole(role).includes(entity);
  return false;
}

export function requireAccess(db: SqlDriver, user: string | null, entity: string, write: boolean): string {
  const row = user ? one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user) : null;
  if (!row || !allowed(String(row.role), entity, write)) raise("42501", "erp_catalog_access_denied");
  const key = { contacts: "cadastros.clientes_fornecedores.ie", products: "cadastros.produtos.ie", warehouses: "suprimentos.depositos.ie" }[
    entity
  ];
  if (write && key && !permitted(db, user!, key)) raise("42501", "erp_catalog_access_denied");
  return String(row.role);
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function detailUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (jsonType(value) !== "string" || !UUID.test(value as string)) raise("22023", "erp_catalog_invalid_reference");
  return (value as string).toLowerCase();
}
