// Guardas do Estoque e dos recebimentos sobre documentos e itens (gatilhos do
// Postgres que o Documentos chama na escrita, como camada de tabela):
// erp_stock.guard_posted_document/_item, guard_reserved_document/_item,
// erp_purchase_receipts.guard_document/_item e active; os efeitos permitidos
// (effect_document_allowed, effect_item_allowed, effect_transition_allowed,
// effect_edit_allowed) e forget_item_components.
// Linhas: o objeto da linha do SQLite (SELECT *), antigo e novo. A comparação
// "to_jsonb(n) - chaves = to_jsonb(o) - chaves" usa o rowJson do motor (o
// to_jsonb da linha) e o texto canônico do jsonb.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import { rowJson } from "../../engine/row-json.ts";
import { guardEffect as mirrorGuardEffect } from "../documents/mirror.ts";
import { operationalChangeAllowed } from "../documents/module-policy.ts";
import type { RpcContext } from "../../engine/registry.ts";

export type Row = Record<string, unknown>;
type Op = "INSERT" | "UPDATE" | "DELETE";
const DOC = "erp_documents__document",
  ITEM = "erp_documents__item";

/** to_jsonb(linha) - chaves, em texto canônico do jsonb. */
function without(table: string, row: Row, keys: string[]): string {
  const json = rowJson(table, row);
  for (const k of keys) delete json[k];
  return jsonbText(json);
}
const body = (row: Row) => (row.body === null || row.body === undefined ? null : typeof row.body === "string" ? JSON.parse(row.body) : row.body) as Record<string, unknown> | null;
const sameJson = (a: unknown, b: unknown) => jsonbText(a === undefined ? null : a) === jsonbText(b === undefined ? null : b);

/**
 * erp_documents.effects_transition_allowed (dono: Documentos, sessão O).
 * Cópia local até o Documentos portar a dele (função pura).
 */
function effectsTransitionAllowed(kind: string, from: string, to: string): boolean {
  if (from === to) return true;
  if (kind === "sales_orders")
    return (
      (from === "verified" && to === "in_progress") || (from === "in_progress" && ["partially_fulfilled", "fulfilled"].includes(to)) ||
      (from === "partially_fulfilled" && ["fulfilled", "partially_invoiced"].includes(to)) || (from === "partially_invoiced" && to === "partially_fulfilled") ||
      (from === "open" && to === "checkout_partial") || (from === "checkout_partial" && ["open", "verified"].includes(to))
    );
  if (kind === "purchase_orders") return (from === "in_progress" && ["partially_fulfilled", "fulfilled"].includes(to)) || (from === "partially_fulfilled" && to === "fulfilled");
  if (kind === "service_orders")
    return (
      (from === "approved" && to === "in_progress") || (from === "in_progress" && ["waiting_parts", "service_done"].includes(to)) ||
      (from === "waiting_parts" && to === "in_progress") || (from === "service_done" && to === "finalized")
    );
  return false;
}

/** erp_stock.effect_transition_allowed(kind, from, to) */
export const effectTransitionAllowed = (kind: string, from: string, to: string) =>
  effectsTransitionAllowed(kind, from, to) || (kind === "sales_orders" && from === "open" && ["verified", "in_progress", "fulfilled"].includes(to));

/** erp_stock.effect_edit_allowed(o, n): o que um documento com efeito ainda pode mudar. */
export function effectEditAllowed(o: Row, n: Row): boolean {
  const meta = ["status", "version", "updated_at", "updated_by", "body", "total"];
  if (without(DOC, n, meta) !== without(DOC, o, meta)) return false;
  const ob = body(o),
    nb = body(n);
  if (o.kind === "purchase_orders") return sameJson(nb?.contact_id, ob?.contact_id) && sameJson(nb?.warehouse_id, ob?.warehouse_id);
  // n.total = o.total e o body sem as observações: NULL = NULL é NULL no Postgres (coalesce → false).
  const nt = rowJson(DOC, n).total,
    ot = rowJson(DOC, o).total;
  if (nt === null || ot === null || nb === null || ob === null) return false;
  const rest = (b: Record<string, unknown>) => {
    const { notes: _n, internal_notes: _i, ...r } = b;
    return r;
  };
  return sameJson(nt, ot) && sameJson(rest(nb), rest(ob));
}

/** erp_stock.effect_document_allowed(o, n) */
export function effectDocumentAllowed(o: Row, n: Row): boolean {
  if (o.status !== n.status) {
    const meta = ["status", "version", "updated_at", "updated_by"];
    return effectTransitionAllowed(String(o.kind), String(o.status), String(n.status)) && without(DOC, n, meta) === without(DOC, o, meta);
  }
  return effectEditAllowed(o, n);
}

/** erp_stock.effect_item_allowed(op, o, n): só a regravação idêntica do item pelo save. */
export function effectItemAllowed(db: SqlDriver, op: Op, o: Row | null, n: Row | null): boolean {
  if (op === "INSERT") return !!one(db, `SELECT 1 x FROM "${ITEM}" WHERE id=? AND document_id=?`, n!.id, n!.document_id);
  if (op === "UPDATE") return without(ITEM, n!, []) === without(ITEM, o!, []);
  return false;
}

/** erp_purchase_receipts.active(p_document): recebimento de compra sem estorno. */
export const active = (db: SqlDriver, document: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`,
    document,
  );

const posted = (db: SqlDriver, ids: unknown[]) =>
  ids.some((d) => d !== undefined && d !== null && !!one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, d));
const reserved = (db: SqlDriver, ids: unknown[]) =>
  ids.some((d) => d !== undefined && d !== null && !!one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active'`, d));

/** erp_stock.guard_posted_document (BEFORE UPDATE/DELETE de document) */
export function guardPostedDocument(db: SqlDriver, op: "UPDATE" | "DELETE", o: Row, n: Row | null, ctx?: RpcContext) {
  if (op === "UPDATE" && n && operationalChangeAllowed(ctx, o, n)) return;
  if (posted(db, [o.id]) && (op === "DELETE" || !effectDocumentAllowed(o, n!))) raise("40001", "erp_document_active_stock");
}
/** erp_stock.guard_reserved_document (BEFORE UPDATE/DELETE de document) */
export function guardReservedDocument(db: SqlDriver, op: "UPDATE" | "DELETE", o: Row, n: Row | null) {
  if (reserved(db, [o.id]) && (op === "DELETE" || !effectDocumentAllowed(o, n!))) raise("40001", "erp_document_active_reservation");
}
/** erp_purchase_receipts.guard_document (BEFORE UPDATE/DELETE de document) */
export function guardDocument(db: SqlDriver, op: "UPDATE" | "DELETE", o: Row, n: Row | null) {
  if (active(db, String(o.id)) && (op === "DELETE" || !effectDocumentAllowed(o, n!))) raise("40001", "purchase_receipt_active");
}

const itemDocs = (op: Op, o: Row | null, n: Row | null) => (op === "INSERT" ? [n!.document_id] : op === "UPDATE" ? [o!.document_id, n!.document_id] : [o!.document_id]);
/** erp_stock.guard_posted_item (BEFORE INSERT/UPDATE/DELETE de item) */
export function guardPostedItem(db: SqlDriver, op: Op, o: Row | null, n: Row | null) {
  if (posted(db, itemDocs(op, o, n)) && !effectItemAllowed(db, op, o, n)) raise("40001", "erp_document_active_stock");
}
/** erp_stock.guard_reserved_item (BEFORE INSERT/UPDATE/DELETE de item) */
export function guardReservedItem(db: SqlDriver, op: Op, o: Row | null, n: Row | null) {
  if (reserved(db, itemDocs(op, o, n)) && !effectItemAllowed(db, op, o, n)) raise("40001", "erp_document_active_reservation");
}
/** erp_purchase_receipts.guard_item (BEFORE INSERT/UPDATE/DELETE de item) */
export function guardItem(db: SqlDriver, op: Op, o: Row | null, n: Row | null) {
  const docs = [...(op !== "INSERT" ? [o!.document_id] : []), ...(op !== "DELETE" ? [n!.document_id] : [])];
  if (docs.some((d) => active(db, String(d))) && !effectItemAllowed(db, op, o, n)) raise("40001", "purchase_receipt_active");
}

/** erp_stock.forget_item_components (AFTER DELETE/UPDATE de item): troca de produto esquece os componentes editados. */
export function forgetItemComponents(db: SqlDriver, op: "UPDATE" | "DELETE", o: Row, n: Row | null) {
  if (op !== "DELETE" && (n!.product_id ?? null) === (o.product_id ?? null)) return;
  // aa_mirror_authority (guard_effect, OLD de cada linha apagada).
  mirrorGuardEffect(db, ...db.exec('SELECT DISTINCT document_id FROM "erp_stock__item_component" WHERE item_id=?', o.id).rows.map((r) => r.document_id));
  db.exec('DELETE FROM "erp_stock__item_component" WHERE item_id=?', o.id);
}
