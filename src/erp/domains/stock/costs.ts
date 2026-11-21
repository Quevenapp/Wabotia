// Custo médio do Estoque: erp_stock.average_costs, cost_visible e
// invoice_unit_price. O custo de uma entrada (receipt ou adjustment com
// quantidade positiva) vem do detalhe do lançamento (movement_detail, última
// revisão) ou, sem detalhe, do preço único do item no pedido/recebimento ou
// na nota que lançou o estoque. A média é ponderada pela quantidade e
// arredondada em 10 casas a cada entrada, como o laço do Postgres.
import { fromColumn, toScaled } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { allowed as documentsAllowed } from "../documents/public.ts";
import { settingsDto } from "./read.ts";

export const PRICE = 10;
const price = (v: unknown) => (v === null || v === undefined ? null : toScaled(String(v), PRICE));

/** erp_stock.cost_visible(p_actor): quem lê pedidos de compra vê custo. */
export function costVisible(db: SqlDriver, actor: string): boolean {
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', actor)?.role as string | undefined) ?? null;
  return documentsAllowed(role, "purchase_orders", false);
}

/** round(a/b, 10) com a e b na mesma escala: metade para longe do zero. */
function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const a = n < 0n ? -n : n,
    b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return neg ? -q : q;
}

/**
 * erp_stock.invoice_unit_price(p_price, p_snapshot, p_position, p_product):
 * o preço da nota por unidade do produto quando o item foi convertido.
 */
export function invoiceUnitPrice(unitPrice: bigint, snapshot: unknown, position: number, product: string): bigint {
  const positions = ((snapshot as { positions?: unknown[] } | null)?.positions ?? []) as Record<string, unknown>[];
  for (const j of positions) {
    if (String(j.product_id) !== product) continue;
    for (const s of ((j.sources ?? []) as Record<string, unknown>[])) {
      if (Number(s.position) !== position || !("invoice_quantity" in s)) continue;
      const qty = toScaled(String(s.quantity), 30);
      if (qty <= 0n) continue;
      const inv = toScaled(String(s.invoice_quantity), 30);
      // round(price*inv/qty, 10): price escala 10 × inv escala 30 / qty escala 30 → escala 10.
      return roundDiv(unitPrice * inv, qty);
    }
  }
  return unitPrice;
}

/**
 * erp_stock.average_costs(p_products): custo médio (escala 10) por produto,
 * na ordem do produto; null quando nenhuma entrada trouxe custo.
 */
export function averageCosts(db: SqlDriver, products: string[] | null, until: string | null = null): Map<string, bigint | null> {
  const base = settingsDto(db).average_cost_base;
  // until (só do motor, inventário valorizado numa data): só os lançamentos com data até ela.
  const rows = db.exec(
    `SELECT e.product_id p, CAST(e.quantity AS TEXT) q, m.kind, m.id movement, m.created_at, e.ordinal
     FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
     WHERE (? IS NULL OR e.product_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR m.occurred_on<=?)
     ORDER BY e.product_id, m.created_at, m.id, e.ordinal`,
    products === null ? null : 1,
    JSON.stringify(products ?? []),
    until,
    until,
  ).rows;
  const costCache = new Map<string, (bigint | null)[]>();
  /** Custos de uma entrada (normalmente um; dois se pedido e nota apontam o mesmo lançamento). */
  const costsOf = (movement: string, product: string): (bigint | null)[] => {
    const key = movement + "|" + product;
    const hit = costCache.get(key);
    if (hit) return hit;
    let out: (bigint | null)[];
    const detail = one(
      db,
      'SELECT unit_price, unit_cost FROM "erp_stock__movement_detail" WHERE movement_id=? AND product_id=? ORDER BY revision DESC LIMIT 1',
      movement,
      product,
    );
    if (detail) out = [base === "custo_lancamento" ? price(detail.unit_cost) ?? price(detail.unit_price) : price(detail.unit_price)];
    else {
      out = [];
      const document =
        (one(db, 'SELECT document_id FROM "erp_stock__document_posting" WHERE movement_id=? LIMIT 1', movement)?.document_id as string | undefined) ??
        (one(db, 'SELECT document_id FROM "erp_purchase_receipts__receipt" WHERE movement_id=?', movement)?.document_id as string | undefined) ??
        null;
      if (document !== null) {
        const prices = db.exec('SELECT unit_price FROM "erp_documents__item" WHERE document_id=? AND product_id=?', document, product).rows.map((r) => price(r.unit_price));
        if (prices.length) out.push(uniquePrice(prices));
      }
      const posting = one(db, 'SELECT invoice_id, snapshot FROM "erp_stock__invoice_posting" WHERE movement_id=?', movement);
      if (posting) {
        const snapshot = posting.snapshot === null ? null : JSON.parse(String(posting.snapshot));
        const prices = db
          .exec('SELECT unit_price, position FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=? AND product_id=?', posting.invoice_id, product)
          .rows.map((r) => (r.unit_price === null ? null : invoiceUnitPrice(price(r.unit_price)!, snapshot, Number(r.position), product)));
        if (prices.length) out.push(uniquePrice(prices));
      }
      if (!out.length) out = [null];
    }
    costCache.set(key, out);
    return out;
  };
  const result = new Map<string, bigint | null>();
  let current: string | null = null,
    qty = 0n,
    avg: bigint | null = null;
  for (const r of rows) {
    const p = String(r.p);
    if (p !== current) {
      if (current !== null) result.set(current, avg);
      current = p;
      qty = 0n;
      avg = null;
    }
    const q = fromColumn(r.q);
    const costed = q > 0n && (r.kind === "receipt" || r.kind === "adjustment");
    for (const cost of costed ? costsOf(String(r.movement), p) : [null]) {
      if (cost !== null) {
        if (avg === null || qty <= 0n) avg = cost;
        // round((qty*avg + q*cost)/(qty+q), 10): numerador na escala 16, denominador na 6.
        else avg = roundDiv(qty * avg + q * cost, qty + q);
      }
      qty += q;
    }
  }
  if (current !== null) result.set(current, avg);
  return result;
}

/** Preço único entre os itens (count(distinct)=1), senão null; nulos não contam. */
function uniquePrice(prices: (bigint | null)[]): bigint | null {
  const distinct = new Set(prices.filter((p): p is bigint => p !== null).map(String));
  return distinct.size === 1 ? BigInt([...distinct][0]) : null;
}

