// Variações do produto: erp_catalog.variation_dto (leitura). A inclusão
// (erp_catalog_product_variation_add) é da fase 2, sobre o núcleo do
// erp_catalog_save.
import { one, type SqlDriver } from "../../engine/driver.ts";

/** erp_catalog.variation_dto(p_parent): null quando o pai não é produto (o jsonb || null do Postgres). */
export function variationDto(db: SqlDriver, parent: string): Record<string, unknown> | null {
  const p = one(
    db,
    `SELECT r.id, r.name, r.code, p.format FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?`,
    parent,
  );
  if (!p) return null;
  const children = db
    .exec(
      `SELECT c.id, c.name, c.code, c.active, cp.gtin, cp.price, v.attributes FROM "erp_catalog__product_variation" v
       JOIN "erp_catalog__record" c ON c.id=v.child_id JOIN "erp_catalog__product" cp ON cp.record_id=c.id
       WHERE v.parent_id=? ORDER BY v.position`,
      parent,
    )
    .rows.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code ?? null,
      active: Number(c.active) === 1,
      gtin: c.gtin ?? null,
      price: c.price ?? null,
      attributes: c.attributes === null ? null : JSON.parse(String(c.attributes)),
    }));
  return { parent: { id: p.id, name: p.name, code: p.code ?? null, format: p.format ?? null }, children };
}
