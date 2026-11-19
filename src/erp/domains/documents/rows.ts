// Camada de linha do Documentos: INSERT e UPDATE em erp_documents.document e INSERT, UPDATE e
// DELETE em erp_documents.item, com os gatilhos do Postgres na ordem do nome. Todo escritor do
// Documentos (e o Estoque, no lugar do bumpDocumentVersion) passa por aqui.
// Linhas na forma do SQLite (SELECT *): json em texto, bool 0/1, decimais escalados.
//
// document
//   BEFORE UPDATE: ab_origin_effects (Sync), guard_trash, protect_document_finance (Financeiro),
//     protect_document_stock, protect_purchase_receipt_document, protect_reserved_document (Estoque).
//   AFTER: document_number_continuity (INSERT, e UPDATE OF kind/number), situation_follow_status
//     (UPDATE OF status), zz_origin_sync.
//   Adiados (ctx.defer, na ordem do nome): commission_operation_capture (venda e OS) e
//     cost_apply_capture (venda), em INSERT e UPDATE.
// item
//   BEFORE: ab_origin_effects, document_native_item_required, guard_trash (guard_trash_child),
//     guard_variation_item (INSERT/UPDATE), protect_document_item_finance, protect_document_item_stock,
//     protect_purchase_receipt_item, protect_reserved_item.
//   AFTER: forget_stock_item_components (DELETE, e UPDATE OF product_id), zz_origin_sync.
// aa_mirror_authority: documents/mirror.ts (o documento espelhado do Origin).
// O "UPDATE OF coluna" do Postgres dispara quando a coluna está na lista do SET, mudando ou não:
// por isso as funções recebem o `set` com as colunas da instrução.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { defer, type RpcContext } from "../../engine/registry.ts";
import { rowJson } from "../../engine/row-json.ts";
import * as finance from "../finance/public.ts";
import * as stock from "../stock/public.ts";
import * as sync from "../sync/public.ts";
import { costApplyCapture } from "./cost-apply.ts";
import { guardDocument, guardItem } from "./mirror.ts";
import { guardTrashChild } from "./public.ts";
import { guardUnavailableFields } from "./save-checks.ts";
import { erpOperationRequirement, erpRequirementMet } from "../../parts-requirements.ts";

export type Row = Record<string, unknown>;
const DOC = "erp_documents__document",
  ITEM = "erp_documents__item";

const toParam = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);

function write(db: SqlDriver, table: string, row: Row) {
  const cols = Object.keys(row);
  db.exec(`INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(", ")}) VALUES(${cols.map(() => "?").join(",")})`, ...cols.map((c) => toParam(row[c])));
}
function change(db: SqlDriver, table: string, id: unknown, set: Row) {
  const cols = Object.keys(set);
  if (cols.length) db.exec(`UPDATE "${table}" SET ${cols.map((c) => `"${c}"=?`).join(", ")} WHERE id=?`, ...cols.map((c) => toParam(set[c])), id);
}

/** Os dois gatilhos adiados do documento, por evento de linha. */
function deferCaptures(ctx: RpcContext, n: Row) {
  const id = String(n.id);
  if (n.kind === "sales_orders" || n.kind === "service_orders") {
    if ((ctx.parts.finance && ctx.parts.sales) || n.status === "cancelled") defer(ctx, () => {
      // Compensação explícita usa a situação final; nenhuma troca de vendedor recalcula comissão suspensa.
      if (ctx.parts.finance && ctx.parts.sales || one(ctx.db, `SELECT 1 FROM "erp_documents__document" d
        JOIN "erp_finance__commission_operation" o ON o.document_id=d.id AND o.state='active' WHERE d.id=? AND d.status='cancelled'`, id))
        finance.commissionOperationCapture(ctx, id);
    });
  }
  if (n.kind === "sales_orders" && erpRequirementMet(ctx.parts, erpOperationRequirement("margin"))) defer(ctx, () => costApplyCapture(ctx, id));
}

/** erp_documents.advance_received_number (document_number_continuity) */
function advanceReceivedNumber(db: SqlDriver, n: Row) {
  if (n.number === null || n.number === undefined) return;
  const v = Number(n.number);
  if (v >= 1 && v <= 9999999999) db.exec('UPDATE "erp_documents__numbering" SET last_number=? WHERE kind=? AND last_number<?', v, n.kind, v);
}

/** erp_documents.guard_trash (BEFORE UPDATE em document) */
function guardTrash(o: Row, n: Row) {
  if (o.deleted_at !== null && n.deleted_at !== null) raise("40001", "erp_document_deleted");
  // Os dois não nulos já pararam acima: "distinct" aqui é um nulo e o outro não.
  if ((o.deleted_at === null) !== (n.deleted_at === null)) {
    const k = ["deleted_at", "deleted_by", "delete_reason", "version", "updated_at", "updated_by"];
    const strip = (r: Row) => {
      const j = rowJson(DOC, r);
      for (const x of k) delete j[x];
      return jsonbText(j);
    };
    if (strip(n) !== strip(o)) raise("40001", "erp_document_deleted");
  }
}

/** INSERT em document com os gatilhos. `row` traz todas as colunas (forma do SQLite). */
export function insertDocument(ctx: RpcContext, row: Row) {
  const db = ctx.db;
  guardDocument(ctx, "INSERT", null, row); // aa_mirror_authority
  if (!ctx.parts.stock || !ctx.parts.finance) guardUnavailableFields(ctx, { ...JSON.parse(String(row.body)), warehouse_id: row.warehouse_id }, null);
  write(db, DOC, row);
  advanceReceivedNumber(db, row); // document_number_continuity
  sync.captureDocument(ctx); // zz_origin_sync
  deferCaptures(ctx, row);
}

/** UPDATE em document com os gatilhos. `set` traz as colunas da instrução (forma do SQLite). */
export function updateDocument(ctx: RpcContext, id: string, set: Row) {
  const db = ctx.db;
  const o = one(db, `SELECT * FROM "${DOC}" WHERE id=?`, id);
  if (!o) return;
  const n: Row = { ...o, ...set };
  // BEFORE, na ordem do nome.
  guardDocument(ctx, "UPDATE", o, n); // aa_mirror_authority
  sync.guardOriginEffectsDocument(ctx, id); // ab_origin_effects
  guardTrash(o, n); // guard_trash
  finance.guardPostedDocument(db, "UPDATE", o, n); // protect_document_finance
  stock.guardPostedDocument(db, "UPDATE", o, n); // protect_document_stock
  stock.guardDocument(db, "UPDATE", o, n); // protect_purchase_receipt_document
  stock.guardReservedDocument(db, "UPDATE", o, n); // protect_reserved_document
  if (!ctx.parts.stock || !ctx.parts.finance)
    guardUnavailableFields(ctx, { ...JSON.parse(String(n.body)), warehouse_id: n.warehouse_id }, { ...JSON.parse(String(o.body)), warehouse_id: o.warehouse_id });
  change(db, DOC, id, set);
  // AFTER, na ordem do nome.
  if ("kind" in set || "number" in set) advanceReceivedNumber(db, n); // document_number_continuity
  if ("status" in set && n.status !== o.status)
    db.exec('DELETE FROM "erp_documents__document_situation" WHERE document_id=? AND base_status<>?', id, n.status); // situation_follow_status
  sync.captureDocument(ctx); // zz_origin_sync
  deferCaptures(ctx, n);
}

/** BEFORE de item, na ordem do nome (sem os de UPDATE OF). */
function itemBefore(ctx: RpcContext, op: "INSERT" | "UPDATE" | "DELETE", o: Row | null, n: Row | null) {
  const db = ctx.db;
  const documentId = String(op === "INSERT" ? n!.document_id : o!.document_id);
  guardItem(ctx, op, o, n); // aa_mirror_authority
  sync.guardOriginEffectsItem(ctx, documentId); // ab_origin_effects
  if (op !== "DELETE") {
    // document_native_item_required
    if (one(db, `SELECT 1 x FROM "${DOC}" WHERE id=? AND origin='brufap'`, n!.document_id) && [n!.quantity, n!.unit_price, n!.discount_percent, n!.total].some((v) => v === null || v === undefined))
      raise("23502", "document_native_item_required");
  }
  guardTrashChild(db, String(op === "DELETE" ? o!.document_id : n!.document_id)); // guard_trash
  if (op !== "DELETE" && n!.product_id !== null && n!.product_id !== undefined && (op === "INSERT" || n!.product_id !== o!.product_id))
    if (one(db, `SELECT 1 x FROM "erp_catalog__product" WHERE record_id=? AND format='V'`, n!.product_id)) raise("22023", "erp_document_variation_parent"); // guard_variation_item
  finance.guardPostedItem(db, op, o, n); // protect_document_item_finance
  stock.guardPostedItem(db, op, o, n); // protect_document_item_stock
  stock.guardItem(db, op, o, n); // protect_purchase_receipt_item
  stock.guardReservedItem(db, op, o, n); // protect_reserved_item
  if (!ctx.parts.stock) {
    const prior = o ?? (n ? one(db, `SELECT * FROM "${ITEM}" WHERE id=? AND document_id=?`, n.id, n.document_id) : null);
    guardUnavailableFields(ctx, { items: n ? [JSON.parse(String(n.data))] : [] }, { items: prior ? [JSON.parse(String(prior.data))] : [] });
  }
}

/** INSERT em item com os gatilhos. */
export function insertItem(ctx: RpcContext, row: Row) {
  itemBefore(ctx, "INSERT", null, row);
  write(ctx.db, ITEM, row);
  sync.captureDocument(ctx); // zz_origin_sync
}

/** UPDATE em item com os gatilhos. */
export function updateItem(ctx: RpcContext, id: string, set: Row) {
  const db = ctx.db;
  const o = one(db, `SELECT * FROM "${ITEM}" WHERE id=?`, id);
  if (!o) return;
  const n: Row = { ...o, ...set };
  itemBefore(ctx, "UPDATE", o, n);
  change(db, ITEM, id, set);
  if ("product_id" in set) stock.forgetItemComponents(db, "UPDATE", o, n); // forget_stock_item_components
  sync.captureDocument(ctx); // zz_origin_sync
}

/** DELETE em item com os gatilhos. */
export function deleteItem(ctx: RpcContext, id: string) {
  const db = ctx.db;
  const o = one(db, `SELECT * FROM "${ITEM}" WHERE id=?`, id);
  if (!o) return;
  itemBefore(ctx, "DELETE", o, null);
  db.exec(`DELETE FROM "${ITEM}" WHERE id=?`, id);
  stock.forgetItemComponents(db, "DELETE", o, null); // forget_stock_item_components
  sync.captureDocument(ctx); // zz_origin_sync
}

/**
 * INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE item.document_id=excluded.document_id:
 * os BEFORE INSERT disparam com a linha proposta; havendo conflito, os BEFORE UPDATE e o
 * UPDATE. Devolve false quando o conflito é com item de outro documento (nada escrito).
 */
export function upsertItem(ctx: RpcContext, row: Row): boolean {
  const db = ctx.db;
  itemBefore(ctx, "INSERT", null, row);
  const o = one(db, `SELECT * FROM "${ITEM}" WHERE id=?`, row.id);
  if (!o) {
    write(db, ITEM, row);
    sync.captureDocument(ctx);
    return true;
  }
  if (o.document_id !== row.document_id) return false;
  const { id: _id, document_id: _d, ...set } = row;
  updateItem(ctx, String(row.id), set);
  return true;
}
