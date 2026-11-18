// Taxonomia do catálogo (erp_catalog.taxonomy: categorias, grupos de produto,
// etiquetas e grupos de etiquetas): o item devolvido às telas e o gatilho que
// guarda o tipo da etiqueta. Base do taxonomy_list/save/delete da sessão P.
// Escrito pela sessão B (custom_field_save); dona do domínio: sessão P.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonTimestamp } from "../../engine/time.ts";

const count = (db: SqlDriver, sql: string, id: string) => Number(one(db, `SELECT CAST(count(*) AS TEXT) n FROM ${sql}`, id)!.n);

/** erp_catalog.taxonomy_item(p_id): o item, quantos filhos e quantos produtos, contatos e notas o usam. */
export function taxonomyItem(db: SqlDriver, id: string): Record<string, unknown> | null {
  const t = one(
    db,
    `SELECT id, kind, parent_id, name, CAST(version AS TEXT) version, CAST(created_at AS TEXT) created_at,
     CAST(updated_at AS TEXT) updated_at, tag_type FROM "erp_catalog__taxonomy" WHERE id=?`,
    id,
  );
  if (!t) return null;
  const kind = String(t.kind);
  const products =
    kind === "categories"
      ? count(db, '"erp_catalog__product_detail" WHERE category_id=?', id)
      : kind === "product_groups"
        ? count(db, '"erp_catalog__product_detail" WHERE product_group_id=?', id)
        : kind === "tags"
          ? count(db, '"erp_catalog__product_tag" WHERE tag_id=?', id)
          : 0;
  const item: Record<string, unknown> = {
    id: t.id,
    kind,
    parent_id: t.parent_id,
    name: t.name,
    version: Number(t.version),
    created_at: jsonTimestamp(String(t.created_at)),
    updated_at: jsonTimestamp(String(t.updated_at)),
    tag_type: t.tag_type,
    children: count(db, '"erp_catalog__taxonomy" WHERE parent_id=?', id),
    products,
    contacts: kind === "tags" ? count(db, '"erp_catalog__contact_tag" WHERE tag_id=?', id) : 0,
  };
  if (t.tag_type === "invoices") item.invoices = kind === "tags" ? count(db, '"erp_catalog__invoice_tag" WHERE tag_id=?', id) : 0;
  return item;
}

/**
 * Gatilho erp_catalog_taxonomy_type_guard (BEFORE INSERT OR UPDATE em
 * erp_catalog.taxonomy): o tipo da etiqueta não muda, e a etiqueta de um
 * grupo tem o tipo do grupo. Quem grava na taxonomia chama antes de gravar;
 * `before` é a linha antiga (null no INSERT).
 */
export function taxonomyTypeGuard(
  db: SqlDriver,
  before: { tag_type: string | null } | null,
  row: { kind: string; parent_id: string | null; tag_type: string | null },
) {
  if (before !== null && row.tag_type !== before.tag_type) raise("22023", "erp_catalog_taxonomy_type_fixed");
  if (row.kind === "tags" && row.parent_id !== null) {
    const parent = one(db, 'SELECT tag_type FROM "erp_catalog__taxonomy" WHERE id=?', row.parent_id);
    if (((parent?.tag_type as string | null | undefined) ?? null) !== row.tag_type) raise("22023", "erp_catalog_taxonomy_parent_invalid");
  }
}
