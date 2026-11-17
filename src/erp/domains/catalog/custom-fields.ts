// Campos customizados de produtos (erp_catalog.custom_field, migração 156 do
// Fagoo): permissão do cartão "Campos customizados" e o item da definição.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { permitted } from "../access/public.ts";
import { compareText } from "./fields.ts";

/**
 * erp_catalog.custom_field_permitted(p_user_id, p_action): view, ie ou ex
 * no cartão de campos customizados de produtos.
 */
export function customFieldPermitted(db: SqlDriver, user: string | null, action: string | null): boolean {
  if (user === null || action === null || !["view", "ie", "ex"].includes(action)) return false;
  return (
    permitted(db, user, "preferencias.campos_customizados") &&
    permitted(db, user, "preferencias.campos_customizados.produtos") &&
    (action === "view" || permitted(db, user, `preferencias.campos_customizados.${action}`))
  );
}

/** erp_catalog.require_custom_field_permission: 42501 erp_access_permission_denied. */
export function requireCustomFieldPermission(db: SqlDriver, user: string | null, action: string) {
  if (!customFieldPermitted(db, user, action)) raise("42501", "erp_access_permission_denied");
}

/** erp_catalog.custom_field_item(p_id): a definição, as opções, as categorias e quantos produtos usam. */
export function customFieldItem(db: SqlDriver, id: string): Record<string, unknown> | null {
  const f = one(
    db,
    `SELECT id, module, field_type, name, hint, info, required, min_length, max_length, width, grouped, active,
     CAST(version AS TEXT) version, CAST(created_at AS TEXT) created_at, CAST(updated_at AS TEXT) updated_at
     FROM "erp_catalog__custom_field" WHERE id=?`,
    id,
  );
  if (!f) return null;
  const options = db
    .exec('SELECT id, label FROM "erp_catalog__custom_field_option" WHERE field_id=? ORDER BY position', id)
    .rows.map((o) => ({ id: o.id, label: o.label }));
  const categories = db
    .exec('SELECT category_id FROM "erp_catalog__custom_field_category" WHERE field_id=?', id)
    .rows.map((c) => String(c.category_id))
    .sort(compareText);
  const products = one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__product_custom_value" WHERE field_id=?', id)!;
  const int = (v: unknown) => (v === null ? null : Number(v));
  return {
    id: f.id,
    module: f.module,
    field_type: f.field_type,
    name: f.name,
    hint: f.hint,
    info: f.info,
    required: !!Number(f.required),
    min_length: int(f.min_length),
    max_length: int(f.max_length),
    width: f.width,
    grouped: !!Number(f.grouped),
    active: !!Number(f.active),
    version: Number(f.version),
    created_at: jsonTimestamp(String(f.created_at)),
    updated_at: jsonTimestamp(String(f.updated_at)),
    options,
    category_ids: categories,
    products: Number(products.n),
  };
}
