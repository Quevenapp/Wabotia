// Saldo de faturamento do pedido de venda (Resumo de faturamento, nota
// parcial): erp_fiscal_invoices.counts_for_balance, sales_full_invoice,
// sales_item_invoiced, sales_balance (202610210391) e quantity_text (275).
// Leitura pura; quem chama confere o acesso (erp_document_invoice_balance, O).
import { formatScaled, fromColumn } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";

/** quantity_text(p): to_char(trunc(p,4),'FM99999999990.0000'); `scale` é a da coluna. */
export function quantityText(value: unknown, scale = 4): string | null {
  if (value === null || value === undefined) return null;
  let v = fromColumn(value);
  if (scale > 4) v /= 10n ** BigInt(scale - 4); // trunc: divisão inteira corta em direção ao zero
  else if (scale < 4) v *= 10n ** BigInt(4 - scale);
  // to_char com 11 dígitos inteiros: além disso, a máscara vira '#'.
  if ((v < 0n ? -v : v) >= 10n ** 15n) return (v < 0n ? "-" : "") + "###########.####";
  return formatScaled(v, 4);
}

/** Nota de saída que vale para o saldo: não excluída, nem cancelada (3) nem denegada (10). */
export function countsForBalance(db: SqlDriver, invoice: string): boolean {
  return (
    one(db, `SELECT 1 x FROM "erp_fiscal_invoices__invoice" WHERE id=? AND deleted_at IS NULL AND direction='1' AND status NOT IN (3, 10)`, invoice) !== null
  );
}

/** A nota cheia do pedido: de saída, não excluída, ligada ao pedido sem vínculo por item (a mais antiga). */
export function salesFullInvoice(db: SqlDriver, document: string): string | null {
  const r = one(
    db,
    `SELECT o.invoice_id FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id
      WHERE o.document_id=? AND n.deleted_at IS NULL AND n.direction='1'
        AND NOT EXISTS (SELECT 1 FROM "erp_fiscal_invoices__invoice_order_item" x WHERE x.invoice_id=o.invoice_id AND x.document_id=o.document_id)
      ORDER BY n.created_at LIMIT 1`,
    document,
  );
  return r ? String(r.invoice_id) : null;
}

/** Faturado por item do pedido (escala 4) pelas notas parciais que valem. */
export function salesItemInvoiced(db: SqlDriver, document: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const rows = db.exec(
    `SELECT x.document_item_id, x.quantity, x.invoice_id FROM "erp_fiscal_invoices__invoice_order_item" x WHERE x.document_id=?`,
    document,
  ).rows;
  const counts = new Map<string, boolean>();
  for (const r of rows) {
    const inv = String(r.invoice_id);
    if (!counts.has(inv)) counts.set(inv, countsForBalance(db, inv));
    if (!counts.get(inv)) continue;
    const id = String(r.document_item_id);
    out.set(id, (out.get(id) ?? 0n) + fromColumn(r.quantity));
  }
  return out;
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** sales_balance(p_document): pedido, faturado e a faturar por item, e as notas de saída do pedido. */
export function salesBalance(db: SqlDriver, document: string): Record<string, unknown> {
  const full = salesFullInvoice(db, document);
  const invoiced = salesItemInvoiced(db, document);
  const items = db
    .exec(
      `SELECT i.id, i.position, i.product_id, coalesce(i.data ->> '$.description', i.product_snapshot ->> '$.name') description,
              i.data ->> '$.unit' unit, i.quantity
         FROM "erp_documents__item" i WHERE i.document_id=? ORDER BY i.position`,
      document,
    )
    .rows.map((i) => {
      const q = i.quantity === null || i.quantity === undefined ? null : fromColumn(i.quantity); // escala 6
      const v = invoiced.get(String(i.id)) ?? 0n; // escala 4
      const remaining = q === null ? 0n : q - v * 100n > 0n ? q - v * 100n : 0n; // greatest(NULL, 0) = 0
      return {
        document_item_id: String(i.id),
        position: Number(i.position),
        product_id: text(i.product_id),
        description: text(i.description),
        unit: text(i.unit),
        ordered: quantityText(q, 6),
        invoiced: full !== null ? quantityText(q, 6) : quantityText(v, 4),
        remaining: full !== null ? quantityText(0n, 4) : quantityText(remaining, 6),
      };
    });
  const invoices = db
    .exec(
      `SELECT n.id, n.number, n.series, n.model, n.status,
              EXISTS (SELECT 1 FROM "erp_fiscal_invoices__invoice_order_item" x WHERE x.invoice_id=n.id AND x.document_id=o.document_id) partial
         FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_fiscal_invoices__invoice" n ON n.id=o.invoice_id
        WHERE o.document_id=? AND n.deleted_at IS NULL AND n.direction='1' ORDER BY n.created_at, n.id`,
      document,
    )
    .rows.map((n) => ({
      id: String(n.id),
      number: n.number === null ? null : Number(n.number),
      series: n.series === null ? null : Number(n.series),
      model: text(n.model),
      status: Number(n.status),
      partial: Number(n.partial) === 1,
      counts: countsForBalance(db, String(n.id)),
    }));
  return { document_id: document, full_invoice_id: full, items, invoices };
}
