// Escrita da taxonomia: erp_catalog.category_custom_fields_set, a trilha
// (taxonomy_audit) e os desvínculos do excluir (taxonomy_detach de produtos e
// taxonomy_detach_contacts). O desvínculo de notas (taxonomy_detach_invoices)
// usa invoiceTagIds/invoiceTagBump do catalog/invoice-tags.ts da B (bloco C):
// até ele sair, excluir etiqueta de nota devolve 0A000.
// O UPDATE de erp_catalog.origin ('local_modified') vai no updateRecord (record.ts).
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { contactTagBump, contactTagIds } from "./contact-tags.ts";
import { customFieldItem } from "./custom-fields.ts";
import { capture, productFull } from "./internal.ts";
import { updateRecord } from "./record.ts";

const MAX_VERSION = 2147483647;
const json = (v: unknown) => (v === null || v === undefined ? null : jsonbText(v));

export function taxonomyAudit(
  ctx: RpcContext, user: string, command: string, kind: string, item: string, action: string, before: unknown, after: unknown,
) {
  ctx.db.exec(
    `INSERT INTO "erp_catalog__taxonomy_audit"(actor, command_id, kind, item_id, action, before_data, after_data, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    user, command, kind, item, action, json(before), json(after), ctx.clock.next().toString(),
  );
}

/** erp_catalog.category_custom_fields_set(p_user_id, p_command_id, p_category_id, p_field_ids): campos que mudaram. */
export function categoryCustomFieldsSet(ctx: RpcContext, user: string, command: string, category: string, fields: string[]): number {
  const db = ctx.db;
  for (const f of fields)
    if (!one(db, `SELECT 1 x FROM "erp_catalog__custom_field" WHERE id=? AND module='products'`, f)) raise("22023", "erp_catalog_invalid_reference");
  const candidates = db
    .exec(
      `SELECT f.id FROM "erp_catalog__custom_field" f WHERE f.module='products' AND (f.id IN (SELECT value FROM json_each(?))
       OR EXISTS(SELECT 1 FROM "erp_catalog__custom_field_category" c WHERE c.field_id=f.id AND c.category_id=?)) ORDER BY f.id`,
      JSON.stringify(fields), category,
    )
    .rows.map((r) => String(r.id));
  let count = 0;
  for (const field of candidates) {
    const member = !!one(db, 'SELECT 1 x FROM "erp_catalog__custom_field_category" WHERE field_id=? AND category_id=?', field, category);
    const wanted = fields.includes(field);
    const f = one(db, 'SELECT grouped, CAST(version AS TEXT) version FROM "erp_catalog__custom_field" WHERE id=?', field)!;
    if (member === wanted && (!wanted || !!Number(f.grouped))) continue;
    if (Number(f.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    const before = customFieldItem(db, field);
    if (wanted)
      db.exec(
        `INSERT OR IGNORE INTO "erp_catalog__custom_field_category"(field_id, category_id, category_kind) VALUES(?,?,'categories')`,
        field, category,
      );
    else db.exec('DELETE FROM "erp_catalog__custom_field_category" WHERE field_id=? AND category_id=?', field, category);
    db.exec(
      `UPDATE "erp_catalog__custom_field" SET grouped=(grouped OR ?), version=version+1, updated_by=?, updated_at=? WHERE id=?`,
      wanted ? 1 : 0, user, ctx.clock.next().toString(), field,
    );
    db.exec(
      `INSERT INTO "erp_catalog__custom_field_audit"(actor, command_id, field_id, action, before_data, after_data, created_at)
       VALUES(?,?,?,'categories',?,?,?)`,
      user, command, field, json(before), json(customFieldItem(db, field)), ctx.clock.next().toString(),
    );
    count++;
  }
  return count;
}

/** erp_catalog.taxonomy_detach(p_user_id, p_command_id, p_item): produtos sem a categoria ou a etiqueta. */
export function taxonomyDetach(ctx: RpcContext, user: string, command: string, item: { id: string; kind: string }): number {
  const db = ctx.db;
  const ids = db
    .exec(
      item.kind === "categories"
        ? `SELECT r.id FROM "erp_catalog__record" r WHERE r.entity='products' AND EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND d.category_id=?) ORDER BY r.id`
        : `SELECT r.id FROM "erp_catalog__record" r WHERE r.entity='products' AND EXISTS(SELECT 1 FROM "erp_catalog__product_tag" x WHERE x.record_id=r.id AND x.tag_id=?) ORDER BY r.id`,
      item.id,
    )
    .rows.map((r) => String(r.id));
  let count = 0;
  for (const id of ids) {
    const rec = one(db, 'SELECT name, code, active, CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=?', id)!;
    if (Number(rec.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    const before = productFull(db, id);
    ctx.settings.set("erp_catalog.product_lifecycle", "on");
    let changed: number;
    if (item.kind === "categories") {
      changed = db.exec('UPDATE "erp_catalog__product_detail" SET category_id=NULL WHERE record_id=? AND category_id=?', id, item.id).rowsWritten;
      if (changed > 0) capture(ctx, id, "upsert"); // zz_origin_sync de product_detail
    } else changed = db.exec('DELETE FROM "erp_catalog__product_tag" WHERE record_id=? AND tag_id=?', id, item.id).rowsWritten;
    if (changed === 0) {
      ctx.settings.set("erp_catalog.product_lifecycle", "");
      continue;
    }
    updateRecord(
      ctx, id, { entity: "products", active: !!Number(rec.active) },
      { name: String(rec.name), code: (rec.code as string | null) ?? null, active: !!Number(rec.active) }, user,
    );
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,'products',?,?,?,?,?)`,
      user, command, id, item.kind === "categories" ? "category_removed" : "tag_removed", json(before), json(productFull(db, id)),
      ctx.clock.next().toString(),
    );
    ctx.settings.set("erp_catalog.product_lifecycle", "");
    count++;
  }
  return count;
}

/** erp_catalog.taxonomy_detach_contacts(p_user_id, p_command_id, p_tag_id) */
export function taxonomyDetachContacts(ctx: RpcContext, user: string, command: string, tag: string): number {
  const db = ctx.db;
  let count = 0;
  for (const id of db
    .exec('SELECT record_id FROM "erp_catalog__contact_tag" WHERE tag_id=? ORDER BY record_id', tag)
    .rows.map((r) => String(r.record_id))) {
    const before = contactTagIds(db, id);
    if (db.exec('DELETE FROM "erp_catalog__contact_tag" WHERE record_id=? AND tag_id=?', id, tag).rowsWritten === 0) continue;
    contactTagBump(ctx, user, id);
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,'contacts',?,'tag_removed',?,?,?)`,
      user, command, id, json({ tag_ids: before }), json({ tag_ids: contactTagIds(db, id) }), ctx.clock.next().toString(),
    );
    count++;
  }
  return count;
}

/** erp_catalog.taxonomy_detach_invoices: espera invoiceTagIds/invoiceTagBump (catalog/invoice-tags.ts, B). */
export function taxonomyDetachInvoices(_ctx: RpcContext, _user: string, _command: string, _tag: string): number {
  raise("0A000", "rpc_not_ported:erp_catalog.taxonomy_detach_invoices");
}
