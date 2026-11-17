// Leituras do Estoque sobre a nota fiscal (sem escrita): erp_stock.
// invoice_access, invoice_reference e invoice_flag (a nota lançou o estoque,
// "S", ou ele veio do pedido ou do recebimento, "R").
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { pgCompareText } from "../../engine/text.ts";
import { requireAccess } from "./internal.ts";

const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);

/** erp_stock.invoice_access(p_actor, p_write): o papel; fiscal só lê. */
export function invoiceAccess(db: SqlDriver, actor: string | null, write: boolean): string {
  const role = actor === null ? null : ((one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor)?.role as string | undefined) ?? null);
  if (role === null || (write && !["admin", "estoque"].includes(role)) || (!write && !["admin", "estoque", "fiscal"].includes(role)))
    raise("42501", "erp_invoice_stock_access_denied");
  if (write) requireAccess(db, actor!, true);
  return role;
}

/** erp_stock.invoice_reference(p_invoice): o pedido da nota cujo estoque foi lançado pelo pedido ou recebido. */
export function invoiceReference(db: SqlDriver, invoice: string) {
  const byNumber = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    Number(a.number) - Number(b.number) || pgCompareText(String(a.id), String(b.id));
  const posted = db
    .exec(
      `SELECT d.id, d.kind, d.number, p.snapshot FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id
         JOIN "erp_stock__document_posting" p ON p.document_id=d.id AND p.state='active' WHERE o.invoice_id=?`,
      invoice,
    )
    .rows.sort(byNumber)[0];
  const shape = (d: Record<string, unknown>, via: string) => {
    const s = parse(d.snapshot) as Record<string, any> | null;
    const w = s?.warehouse ?? null;
    return {
      document_id: d.id,
      kind: d.kind,
      number: String(d.number),
      via,
      warehouse: { id: w?.id === undefined || w?.id === null ? null : String(w.id).toLowerCase(), name: w?.name === undefined || w?.name === null ? null : String(w.name) },
    };
  };
  if (posted) return shape(posted, "document_stock");
  const received = db
    .exec(
      `SELECT d.id, d.kind, d.number, r.snapshot, r.created_at FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id
         JOIN "erp_purchase_receipts__receipt" r ON r.document_id=d.id
        WHERE o.invoice_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`,
      invoice,
    )
    .rows.sort((a, b) => byNumber(a, b) || Number(a.created_at) - Number(b.created_at))[0];
  return received ? shape(received, "purchase_receipt") : null;
}

/** erp_stock.invoice_flag(p_invoice): "S" (a nota lançou), "R" (o pedido ou o recebimento lançou) ou nada. */
export function invoiceFlag(db: SqlDriver, invoice: string) {
  const p = one(db, `SELECT id, warehouse_id, version, source FROM "erp_stock__invoice_posting" WHERE invoice_id=? AND state='active'`, invoice);
  const ref = invoiceReference(db, invoice);
  if (p)
    return {
      flag: "S",
      warehouse: { id: p.warehouse_id, name: (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', p.warehouse_id)?.name as string | undefined) ?? null },
      posting_id: p.id,
      posting_version: p.version,
      source: p.source,
      reference: null,
    };
  if (ref !== null) {
    const { warehouse, ...rest } = ref;
    return { flag: "R", warehouse, posting_id: null, posting_version: null, source: null, reference: rest };
  }
  return { flag: null, warehouse: null, posting_id: null, posting_version: null, source: null, reference: null };
}
