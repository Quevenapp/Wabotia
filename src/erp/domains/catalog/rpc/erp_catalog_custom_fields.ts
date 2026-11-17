// public.erp_catalog_custom_fields: as definições de campos customizados de
// produtos, em ordem de nome (fold, collation C) e id.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import type { SqlDriver } from "../../../engine/driver.ts";
import { requireAccess } from "../access.ts";
import { customFieldItem } from "../custom-fields.ts";
import { compareText } from "../fields.ts";
import { fold } from "../internal.ts";

export function customFields(db: SqlDriver, user: string | null, module: string | null) {
  requireAccess(db, user, "products", false);
  if (module !== "products") raise("22023", "erp_catalog_invalid_query");
  const items = db
    .exec('SELECT id, name FROM "erp_catalog__custom_field" WHERE module=?', module)
    .rows.map((f) => ({ id: String(f.id), key: fold(String(f.name))! }))
    .sort((a, b) => compareText(a.key, b.key) || compareText(a.id, b.id))
    .map((f) => customFieldItem(db, f.id));
  return { module, data_mode: "erp_native", items };
}

export function erpCatalogCustomFields(ctx: RpcContext, a: RpcArgs) {
  return customFields(ctx.db, (a.p_user_id ?? null) as string | null, (a.p_module ?? null) as string | null);
}

registerRpc("erp_catalog_custom_fields", erpCatalogCustomFields);
