// Extrato do Estoque: erp_stock.ledger_origin, ledger_origin_deleted,
// ledger_origin_type, ledger_row, ledger_row_105, ledger_document_price,
// price_text, invoice_screen, last_purchase, default_supplier e
// entry_decimals. Preço e custo em escala 10 (numeric(24,10)).
import { formatScaled, fromColumn, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { jsonTimestamp, saoPauloStamp } from "../../engine/time.ts";
import { allowed as documentsAllowed } from "../documents/public.ts";
import * as preferences from "../preferences/public.ts";
import { invoiceUnitPrice, PRICE } from "./costs.ts";
import { QTY } from "./internal.ts";

const q6 = (v: unknown) => formatScaled(fromColumn(v), QTY);
const price = (v: unknown) => (v === null || v === undefined ? null : toScaled(String(v), PRICE));
/** erp_stock.price_text(p): numeric(24,10)::text */
export const priceText = (p: bigint | null) => (p === null ? null : formatScaled(p, PRICE));
/** erp_stock.invoice_screen(model, direction) */
export const invoiceScreen = (model: unknown, direction: unknown) => (model === "65" ? "nfce" : direction === "0" ? "nfe_entrada" : "nfe_saida");

export interface LedgerOrigin {
  type: string;
  document_id: string | null;
  document_kind: string | null;
  document_number: string | null;
  via: string | null;
}

/** erp_stock.ledger_origin(p_movement_id): de onde veio o lançamento. */
export function ledgerOrigin(db: SqlDriver, movement: string): LedgerOrigin {
  const doc = one(
    db,
    `SELECT id, kind, number, via FROM (
       SELECT d.id, d.kind, d.number, 'document_stock' via, 1 rank FROM "erp_stock__document_posting" p JOIN "erp_documents__document" d ON d.id=p.document_id WHERE p.movement_id=?
       UNION ALL SELECT d.id, d.kind, d.number, 'document_stock', 1 FROM "erp_stock__document_posting" p JOIN "erp_documents__document" d ON d.id=p.document_id WHERE p.reversal_movement_id=?
       UNION ALL SELECT d.id, d.kind, d.number, 'purchase_receipt', 2 FROM "erp_purchase_receipts__receipt" r JOIN "erp_documents__document" d ON d.id=r.document_id WHERE r.movement_id=?
       UNION ALL SELECT d.id, d.kind, d.number, 'purchase_receipt', 2 FROM "erp_purchase_receipts__reversal" r JOIN "erp_documents__document" d ON d.id=r.document_id WHERE r.movement_id=?
     ) WHERE kind IN ('sales_orders','purchase_orders','service_orders') ORDER BY rank LIMIT 1`,
    movement, movement, movement, movement,
  );
  if (doc)
    return {
      type: doc.kind === "sales_orders" ? "sales" : doc.kind === "purchase_orders" ? "purchases" : "services",
      document_id: String(doc.id),
      document_kind: String(doc.kind),
      document_number: doc.number === null ? null : String(doc.number),
      via: String(doc.via),
    };
  const inv = one(
    db,
    `SELECT v.id, v.number, v.model, v.direction FROM "erp_stock__invoice_posting" p JOIN "erp_fiscal_invoices__invoice" v ON v.id=p.invoice_id
     WHERE p.movement_id=? OR p.reversal_movement_id=? LIMIT 1`,
    movement, movement,
  );
  if (inv)
    return {
      type: "invoices",
      document_id: String(inv.id),
      document_kind: invoiceScreen(inv.model, inv.direction),
      document_number: inv.number === null ? null : String(inv.number),
      via: "invoice_stock",
    };
  const transfer = one(
    db,
    `SELECT 1 x FROM "erp_stock__movement" m LEFT JOIN "erp_stock__movement" o ON o.id=m.reverses_id WHERE m.id=? AND (m.kind='transfer' OR (m.kind='reversal' AND o.kind='transfer'))`,
    movement,
  );
  return { type: transfer ? "transfers" : "none", document_id: null, document_kind: null, document_number: null, via: null };
}

/** erp_stock.ledger_origin_deleted(origem): o documento ou a nota da origem foi excluído. */
export function ledgerOriginDeleted(db: SqlDriver, o: LedgerOrigin): boolean {
  if (o.document_id === null) return false;
  if (o.type === "invoices") return !!one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice" WHERE id=? AND deleted_at IS NOT NULL', o.document_id);
  if (["sales", "purchases", "services"].includes(o.type))
    return !!one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND deleted_at IS NOT NULL', o.document_id);
  return false;
}

/** erp_stock.ledger_origin_type(p_movement_id) */
export function ledgerOriginType(db: SqlDriver, movement: string): string {
  const o = ledgerOrigin(db, movement);
  return ledgerOriginDeleted(db, o) ? "deleted" : o.type;
}

/** erp_stock.ledger_row(p_movement_id, p_product_id) */
export function ledgerRow(db: SqlDriver, movement: string, product: string) {
  const m = one(db, 'SELECT id, kind, occurred_on, reason, reference, created_at, reverses_id FROM "erp_stock__movement" WHERE id=?', movement);
  if (!m) return null;
  const items = db
    .exec(
      'SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q, unit, CAST(balance_after AS TEXT) a, balance_version FROM "erp_stock__entry" WHERE movement_id=? AND product_id=? ORDER BY ordinal',
      movement, product,
    )
    .rows.map((e) => ({
      product_id: e.product_id,
      warehouse_id: e.warehouse_id,
      quantity: q6(e.q),
      unit: e.unit,
      balance_after: q6(e.a),
      balance_version: Number(e.balance_version),
    }));
  return {
    id: m.id,
    kind: m.kind,
    occurred_on: m.occurred_on,
    reason: m.reason,
    reference: m.reference,
    created_at: jsonTimestamp(m.created_at as number),
    recorded_at_local: saoPauloStamp(m.created_at as number),
    reverses_id: m.reverses_id,
    reversed_by: (one(db, 'SELECT id FROM "erp_stock__movement" WHERE reverses_id=?', movement)?.id as string | undefined) ?? null,
    items: items.length ? items : null,
    other_items: Number(one(db, 'SELECT count(*) n FROM "erp_stock__entry" WHERE movement_id=? AND product_id<>?', movement, product)!.n),
    origin: ledgerOrigin(db, movement) as LedgerOrigin,
  };
}

/**
 * erp_stock.ledger_document_price(p_movement, p_product): o preço único do
 * produto no pedido/recebimento ou na nota do lançamento (null se não há ou
 * se há mais de um; os nulos contam como um valor, como no union do Postgres).
 */
export function ledgerDocumentPrice(db: SqlDriver, movement: string, product: string): bigint | null {
  const document =
    (one(db, 'SELECT document_id FROM "erp_stock__document_posting" WHERE movement_id=? OR reversal_movement_id=? LIMIT 1', movement, movement)?.document_id as string | undefined) ??
    (one(db, 'SELECT document_id FROM "erp_purchase_receipts__receipt" WHERE movement_id=?', movement)?.document_id as string | undefined) ??
    (one(db, 'SELECT document_id FROM "erp_purchase_receipts__reversal" WHERE movement_id=?', movement)?.document_id as string | undefined) ??
    null;
  const values = new Set<string>();
  if (document !== null)
    for (const r of db.exec('SELECT unit_price FROM "erp_documents__item" WHERE document_id=? AND product_id=?', document, product).rows)
      values.add(r.unit_price === null ? "null" : String(price(r.unit_price)));
  const inv = one(db, 'SELECT invoice_id, snapshot FROM "erp_stock__invoice_posting" WHERE movement_id=? OR reversal_movement_id=? LIMIT 1', movement, movement);
  if (inv) {
    const snapshot = inv.snapshot === null ? null : JSON.parse(String(inv.snapshot));
    for (const r of db.exec('SELECT unit_price, position FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? AND product_id=?', inv.invoice_id, product).rows)
      values.add(r.unit_price === null ? "null" : String(invoiceUnitPrice(price(r.unit_price)!, snapshot, Number(r.position), product)));
  }
  if (values.size !== 1) return null;
  const only = [...values][0];
  return only === "null" ? null : BigInt(only);
}

/** erp_stock.ledger_row_105(p_movement_id, p_product_id, p_role): a linha com preço, custo e balanço. */
export function ledgerRow105(db: SqlDriver, movement: string, product: string, role: string | null) {
  const row = ledgerRow(db, movement, product)!;
  const kind = row.origin.document_kind;
  if (ledgerOriginDeleted(db, row.origin)) row.origin = { ...row.origin, type: "deleted" };
  const hidden =
    kind !== null && (["nfe_saida", "nfe_entrada", "nfce"].includes(kind) ? role !== "admin" && role !== "fiscal" : !documentsAllowed(role, kind, false));
  const d = one(
    db,
    'SELECT revision, unit_price, unit_cost, note FROM "erp_stock__movement_detail" WHERE movement_id=? AND product_id=? ORDER BY revision DESC LIMIT 1',
    movement, product,
  );
  let unitPrice: bigint | null = null,
    unitCost: bigint | null = null,
    source: string | null = null;
  if (d) {
    source = "detail";
    if (!hidden) {
      unitPrice = price(d.unit_price);
      unitCost = price(d.unit_cost);
    }
  } else if (!hidden) {
    unitPrice = ledgerDocumentPrice(db, movement, product);
    source = unitPrice !== null ? "document" : null;
  }
  const c = one(
    db,
    'SELECT CAST(counted AS TEXT) counted, CAST(previous AS TEXT) previous, warehouse_id, source FROM "erp_stock__balance_count" WHERE movement_id=? AND product_id=?',
    movement, product,
  );
  return {
    ...row,
    revision: d ? Number(d.revision) : 0,
    note: d ? d.note : null,
    unit_price: priceText(unitPrice),
    unit_cost: priceText(unitCost),
    price_source: source,
    balance: c
      ? { counted: c.counted === null ? null : q6(c.counted), previous: c.previous === null ? null : q6(c.previous), warehouse_id: c.warehouse_id, source: c.source }
      : null,
  };
}

/** erp_stock.last_purchase(p_product, p_balances): o último preço de compra (ou de balanço). */
export function lastPurchase(db: SqlDriver, product: string, balances: boolean) {
  const rows = db.exec(
    `SELECT m.id, m.occurred_on, m.created_at, (SELECT 1 FROM "erp_stock__balance_count" c WHERE c.movement_id=m.id LIMIT 1) balance
     FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
     WHERE e.product_id=? AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" r WHERE r.reverses_id=m.id)
      AND ((m.kind='receipt' AND e.quantity>0) OR (? AND EXISTS(SELECT 1 FROM "erp_stock__balance_count" c WHERE c.movement_id=m.id)))
     ORDER BY m.occurred_on DESC, m.created_at DESC, m.id DESC`,
    product, balances ? 1 : 0,
  ).rows;
  for (const r of rows) {
    const d = one(db, 'SELECT unit_price, unit_cost FROM "erp_stock__movement_detail" WHERE movement_id=? AND product_id=? ORDER BY revision DESC LIMIT 1', r.id, product);
    const unitPrice = d ? price(d.unit_price) : ledgerDocumentPrice(db, String(r.id), product);
    if (unitPrice === null) continue;
    const origin = r.balance ? null : ledgerOrigin(db, String(r.id));
    return {
      unit_price: unitPrice,
      unit_cost: d ? price(d.unit_cost) : null,
      occurred_on: r.occurred_on as string,
      movement_id: String(r.id),
      source: r.balance ? "balance" : origin!.type === "purchases" ? "purchase_order" : "manual",
    };
  }
  return null;
}

/** erp_stock.default_supplier(p_product) */
export function defaultSupplier(db: SqlDriver, product: string) {
  const s = one(
    db,
    `SELECT s.supplier_id, r.name, s.code, s.purchase_price, s.cost_price FROM "erp_catalog__product_supplier" s JOIN "erp_catalog__record" r ON r.id=s.supplier_id WHERE s.record_id=? AND s.is_default=1`,
    product,
  );
  return s ? { supplier_id: s.supplier_id, supplier_name: s.name, code: s.code, purchase_price: price(s.purchase_price), cost_price: price(s.cost_price) } : null;
}

/** erp_stock.entry_decimals(): casas do preço de entrada (Preferências › Empresa › Geral), 0 a 10. */
export function entryDecimals(db: SqlDriver): number {
  const v = preferences.get(db, "empresa.decimais_preco_entrada");
  return typeof v === "number" && /^([0-9]|10)$/.test(String(v)) ? v : 10;
}
