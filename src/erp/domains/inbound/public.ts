// Compra pela nota recebida: o que outros domínios leem da entrada da nota
// (sem conferir acesso: quem chama confere o dele). Só leitura e só do motor
// (as tabelas são da versão 17, fora do oráculo).
// - O Estoque soma ao "recebido" do pedido de compra o que a nota baixou
//   (orderAttended) e não lança de novo o pedido cuja nota já lançou o estoque
//   (inboundPostedForDocument).
// - O check-in e os relatórios de notas de entrada leem as notas que deram
//   entrada (enteredNotes).
import { one, type SqlDriver } from "../../engine/driver.ts";

const ENTRY = "erp_purchase_inbound__entry";
const NOTE = "erp_purchase_inbound__note";
const parse = (v: unknown): any => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const SCALE6 = 1_000_000n;
/** Texto decimal com até 6 casas → escala 6. */
const q6 = (v: unknown): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(v ?? "").trim());
  if (!m) return 0n;
  const value = BigInt(m[2]) * SCALE6 + BigInt((m[3] ?? "").padEnd(6, "0") || "0");
  return m[1] ? -value : value;
};

/**
 * Quanto cada item do pedido de compra foi atendido pelas notas com entrada
 * ativa (escala 6, na unidade do produto). Só conta a entrada que lançou o
 * estoque: a baixa do pedido é a mercadoria que chegou pela nota.
 */
export function orderAttended(db: SqlDriver, document: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of db.exec(`SELECT result FROM "${ENTRY}" WHERE order_id=? AND state='active' AND stock_status='done'`, document).rows) {
    const order = parse(r.result)?.order;
    if (!order || order.id !== document || !Array.isArray(order.items)) continue;
    for (const i of order.items) if (typeof i?.order_item_id === "string") out.set(i.order_item_id, (out.get(i.order_item_id) ?? 0n) + q6(i.quantity));
  }
  return out;
}

/** A nota ligada ao pedido já lançou o estoque (a entrada ativa baixou o pedido). */
export const inboundPostedForDocument = (db: SqlDriver, document: string) =>
  !!one(db, `SELECT 1 x FROM "${ENTRY}" WHERE order_id=? AND state='active' AND stock_status='done'`, document);

export interface EnteredNote {
  note_id: string; entry_id: string; access_key: string; number: number | null; series: number | null; issued_on: string | null;
  emitter_name: string | null; emitter_document: string | null; nature: string | null; total_cents: number | null; created_at: bigint;
  stock_status: string; finance_status: string; order_id: string | null;
  lines: { position: number; product_id: string | null; quantity: bigint | null; goods_cents: number | null }[];
}

/**
 * Notas recebidas com entrada ativa (as "notas de entrada" da compra pela
 * nota), emitidas no período quando ele vem. Fica de fora a nota cuja chave
 * também está numa nota de entrada antiga (erp_fiscal_invoices), para não
 * contar a mesma nota duas vezes.
 */
export function enteredNotes(db: SqlDriver, from: string | null = null, to: string | null = null): EnteredNote[] {
  return db
    .exec(
      `SELECT n.id note_id, n.access_key, n.number, n.series, n.issued_on, n.emitter_name, n.emitter_document, n.nature, n.total_cents,
         CAST(e.created_at AS TEXT) created_at, e.id entry_id, e.stock_status, e.finance_status, e.order_id, e.snapshot
       FROM "${NOTE}" n JOIN "${ENTRY}" e ON e.note_id=n.id AND e.state='active'
       WHERE (? IS NULL OR n.issued_on>=?) AND (? IS NULL OR n.issued_on<=?)
         AND NOT EXISTS(SELECT 1 FROM "erp_fiscal_invoices__invoice" v WHERE v.access_key=n.access_key AND v.direction='0' AND v.deleted_at IS NULL)
       ORDER BY e.created_at DESC, n.id`,
      from, from, to, to,
    )
    .rows.map((r) => {
      const snapshot = parse(r.snapshot) ?? {};
      return {
        note_id: String(r.note_id), entry_id: String(r.entry_id), access_key: String(r.access_key),
        number: r.number === null ? null : Number(r.number), series: r.series === null ? null : Number(r.series), issued_on: (r.issued_on as string | null) ?? null,
        emitter_name: (r.emitter_name as string | null) ?? null, emitter_document: (r.emitter_document as string | null) ?? null, nature: (r.nature as string | null) ?? null,
        total_cents: r.total_cents === null ? null : Number(r.total_cents), created_at: BigInt(String(r.created_at)),
        stock_status: String(r.stock_status), finance_status: String(r.finance_status), order_id: (r.order_id as string | null) ?? null,
        lines: (Array.isArray(snapshot.lines) ? snapshot.lines : []).map((l: any) => ({
          position: Number(l.position), product_id: typeof l.product_id === "string" ? l.product_id : null,
          quantity: typeof l.stock_quantity === "string" ? q6(l.stock_quantity) : null,
          goods_cents: Number.isSafeInteger(l.cost?.goods_cents) ? Number(l.cost.goods_cents) : null,
        })),
      };
    });
}

/** Quantidade da escala 6 para o texto com 6 casas (como o Estoque devolve). */
export const quantityText = (v: bigint) => {
  const neg = v < 0n, a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / SCALE6}.${(a % SCALE6).toString().padStart(6, "0")}`;
};
