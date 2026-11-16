// Núcleo do cadastro (erp_catalog.record e as linhas de contato, produto e
// depósito): erp_catalog.mutate, write_fields e os gatilhos dessas tabelas na
// ordem do Postgres (BEFORE por nome, depois AFTER por nome).
// Fora (Origin desligado): o UPDATE de erp_catalog.origin (state
// 'local_modified') no mutate; a tabela não tem linhas sem o Origin.
import { decText, toParam, toScaled } from "../../engine/dec.ts";
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import * as stock from "../stock/public.ts";
import { requireAccess } from "./access.ts";
import { replayCommand, requestHash, storeCommand } from "./command.ts";
import {
  COUNTS,
  CONTACT_COLUMNS,
  MEASURES,
  PRODUCT_TEXT,
  capture,
  data,
  dto,
  fold,
  insertProduct,
  insertRecord,
  validateData,
  validateProductIdentifiers,
} from "./internal.ts";

const MAX_VERSION = 2147483647;

/** erp_catalog.compact: fold sem nada além de [0-9a-z]. */
export const compact = (value: string | null) => fold(value ?? "")!.replace(/[^0-9a-z]/g, "");

// ---------------------------------------------------------------------------
// Gatilhos

/** erp_catalog.guard_deleted_product (BEFORE UPDATE de record, entity='products'). */
function guardDeletedProduct(ctx: RpcContext, id: string) {
  if (ctx.settings.get("erp_catalog.product_lifecycle") === "on") return;
  if (one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', id))
    raise("40001", "erp_catalog_product_deleted");
}

/** erp_catalog.guard_variation_parent (BEFORE UPDATE de product). */
function guardVariationParent(ctx: RpcContext, id: string, oldFormat: unknown, newFormat: unknown) {
  if (oldFormat === "V" && newFormat !== "V" && one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product_variation" WHERE parent_id=?', id))
    raise("40001", "erp_catalog_variation_parent_locked");
  if (newFormat === "V" && one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product_variation" WHERE child_id=?', id))
    raise("22023", "erp_catalog_variation_parent_invalid");
}

/** erp_catalog.items_per_box_follow (AFTER UPDATE OF items_per_box, quando muda). */
function itemsPerBoxFollow(ctx: RpcContext, id: string, items: number | null) {
  if (ctx.settings.get("erp_catalog.items_per_box_detail") === "on") return;
  const value = items === null ? null : toParam(toScaled(String(items), 6));
  if (one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=?', id))
    ctx.db.exec('UPDATE "erp_catalog__product_detail" SET items_per_box=? WHERE record_id=?', value, id);
  else ctx.db.exec('INSERT INTO "erp_catalog__product_detail"(record_id, items_per_box) VALUES(?,?)', id, value);
  capture(ctx, id, "upsert"); // zz_origin_sync de product_detail
}

// ---------------------------------------------------------------------------
// record

/** UPDATE de record com os gatilhos (BEFORE: deleted_product, default_warehouse; AFTER: zz_origin_sync). */
export function updateRecord(
  ctx: RpcContext,
  id: string,
  row: { entity: string; active: boolean },
  set: { name: string; code: string | null; active: boolean },
  user: string,
) {
  // BEFORE UPDATE por nome: erp_catalog_record_deleted_product, protect_stock_default_warehouse.
  if (row.entity === "products") guardDeletedProduct(ctx, id);
  stock.protectDefaultWarehouse(ctx.db, { id, entity: row.entity, active: row.active }, set.active);
  ctx.db.exec(
    `UPDATE "erp_catalog__record" SET name=?, code=?, active=?, version=version+1, human_edited=1, updated_by=?, updated_at=?,
     name__fold=?, code__fold=? WHERE id=?`,
    set.name, set.code, set.active ? 1 : 0, user, ctx.clock.next().toString(), fold(set.name), fold(set.code), id,
  );
  capture(ctx, id, "upsert");
}

// ---------------------------------------------------------------------------
// write_fields

const contactValue = (k: string, v: Record<string, unknown>) =>
  k === "roles" ? JSON.stringify(v.roles ?? null) : (v[k] ?? null);

function writeContact(ctx: RpcContext, id: string, v: Record<string, unknown>) {
  const exists = one(ctx.db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', id);
  const key = compact((v.document as string | null) ?? null);
  if (exists)
    ctx.db.exec(
      `UPDATE "erp_catalog__contact" SET ${CONTACT_COLUMNS.map((k) => `${k}=?`).join(", ")}, erp_catalog_contact_document_key__k0=? WHERE record_id=?`,
      ...CONTACT_COLUMNS.map((k) => contactValue(k, v)), key, id,
    );
  else
    ctx.db.exec(
      `INSERT INTO "erp_catalog__contact"(record_id, ${CONTACT_COLUMNS.join(", ")}, erp_catalog_contact_document_key__k0)
       VALUES(?, ${CONTACT_COLUMNS.map(() => "?").join(", ")}, ?)`,
      id, ...CONTACT_COLUMNS.map((k) => contactValue(k, v)), key,
    );
  capture(ctx, id, "upsert");
}

/** Valor de coluna de produto a partir do jsonb validado. */
function productColumn(k: string, v: Record<string, unknown>): unknown {
  const x = v[k];
  if (x === null || x === undefined) return null;
  if (k === "price") return decText(String(x), 10, false);
  if (MEASURES.includes(k)) return toParam(toScaled(String(x), 6));
  if (COUNTS.includes(k)) return Number(x);
  return x;
}
const PRODUCT_WRITE = [...PRODUCT_TEXT, "price", ...MEASURES, ...COUNTS];

/** UPDATE do produto (o ON CONFLICT DO UPDATE de write_fields com os dados completos). */
export function updateProduct(ctx: RpcContext, id: string, v: Record<string, unknown>) {
  const old = one(ctx.db, 'SELECT format, unit, kind, items_per_box FROM "erp_catalog__product" WHERE record_id=?', id)!;
  const next = (k: string) => (k in v ? v[k] : old[k]) ?? null;
  // BEFORE UPDATE por nome: guard_variation_parent, protect_stock_product_unit.
  guardVariationParent(ctx, id, old.format, next("format"));
  stock.protectProductUnit(ctx.db, { record_id: id, unit: old.unit, kind: old.kind }, { unit: next("unit"), kind: next("kind") });
  ctx.db.exec(
    `UPDATE "erp_catalog__product" SET ${PRODUCT_WRITE.map((k) => `${k}=?`).join(", ")} WHERE record_id=?`,
    ...PRODUCT_WRITE.map((k) => productColumn(k, v)), id,
  );
  const items = v.items_per_box === null || v.items_per_box === undefined ? null : Number(v.items_per_box);
  const before = old.items_per_box === null ? null : Number(old.items_per_box);
  // AFTER por nome: erp_catalog_product_items_per_box_update (quando muda), zz_origin_sync.
  if (items !== before) itemsPerBoxFollow(ctx, id, items);
  capture(ctx, id, "upsert");
}

function writeWarehouse(ctx: RpcContext, id: string, v: Record<string, unknown>) {
  if (one(ctx.db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', id))
    ctx.db.exec('UPDATE "erp_catalog__warehouse" SET description=? WHERE record_id=?', v.description ?? null, id);
  else ctx.db.exec('INSERT INTO "erp_catalog__warehouse"(record_id, description) VALUES(?,?)', id, v.description ?? null);
}

/** erp_catalog.write_fields(p_id, p_entity, p_data) */
export function writeFields(ctx: RpcContext, id: string, entity: string, v: Record<string, unknown>) {
  if (entity === "contacts") writeContact(ctx, id, v);
  else if (entity === "products") {
    if (one(ctx.db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', id)) updateProduct(ctx, id, v);
    else insertProduct(ctx, id, v);
  } else if (entity === "warehouses") writeWarehouse(ctx, id, v);
}

// ---------------------------------------------------------------------------
// mutate

export interface MutateInput {
  user: string | null;
  entity: string | null;
  id: string | null;
  expected: number | null;
  command: string | null;
  data: unknown;
  setActive: boolean;
  active: boolean | null;
}

/** erp_catalog.mutate: criar, alterar (patch) ou ativar/inativar um cadastro. */
export function mutate(ctx: RpcContext, p: MutateInput): Record<string, unknown> {
  const db = ctx.db;
  requireAccess(db, p.user, p.entity, true);
  const entity = p.entity!;
  if (
    p.command === null || p.expected === null || p.expected < 0 ||
    (p.id === null && (p.expected !== 0 || p.setActive)) || (p.id !== null && p.expected < 1) ||
    (p.setActive && p.active === null)
  )
    raise("22023", "erp_catalog_invalid_command");
  let v: Record<string, unknown> = {};
  if (!p.setActive) {
    v = validateData(entity, p.data, false);
    if (Object.keys(v).length === 0) raise("22023", "erp_catalog_empty_patch");
  }
  const hash = requestHash({
    actor: p.user, entity, id: p.id, version: p.expected, data: p.data ?? null, set_active: p.setActive, active: p.active,
  });
  const replayed = replayCommand(ctx, p.command, p.user!, hash);
  if (replayed) return replayed;
  let id: string;
  let before: Record<string, unknown> | null = null;
  let changed: boolean;
  if (p.id === null) {
    if (entity === "products") validateProductIdentifiers(v, null);
    v = validateData(entity, v, true);
    id = insertRecord(ctx, { entity, name: v.name as string, code: (v.code as string | null) ?? null, active: true, actor: p.user!, humanEdited: true });
    writeFields(ctx, id, entity, v);
    changed = true;
  } else {
    const row = one(
      db,
      'SELECT entity, name, code, active, CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity=?',
      p.id, entity,
    );
    if (!row) raise("P0002", "erp_catalog_not_found");
    if (Number(row.version) !== p.expected) raise("40001", "erp_catalog_version_conflict");
    id = p.id;
    before = dto(db, id);
    if (p.setActive) changed = !!Number(row.active) !== p.active;
    else {
      const current = data(db, id);
      if (entity === "products") validateProductIdentifiers(v, current);
      // data(id) || patch: sem a linha da entidade, null || x é null (inválido).
      v = validateData(entity, current === null ? null : { ...current, ...v }, true);
      changed = jsonbText(v) !== jsonbText(current);
    }
    if (changed) {
      if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
      updateRecord(
        ctx, id, { entity, active: !!Number(row.active) },
        p.setActive
          ? { name: String(row.name), code: (row.code as string | null) ?? null, active: p.active! }
          : { name: v.name as string, code: (v.code as string | null) ?? null, active: !!Number(row.active) },
        p.user!,
      );
      if (!p.setActive) writeFields(ctx, id, entity, v);
    }
  }
  const result = { entity, record: dto(db, id), replayed: false, data_mode: "erp_native" };
  if (changed) {
    const action =
      p.id === null ? "create" : p.setActive && p.active ? "restore" : p.setActive ? "archive" : "update";
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      p.user, p.command, entity, id, action, before === null ? null : jsonbText(before), jsonbText(dto(db, id)),
      ctx.clock.next().toString(),
    );
  }
  storeCommand(ctx, p.command, p.user!, hash, result);
  return result;
}
