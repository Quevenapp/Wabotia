// Notas fiscais no Financeiro (SQL 247): os ajudantes de leitura da nota
// (contato, total, efeito ativo, pedidos já lançados, motivo de bloqueio) e
// os efeitos financeiros de uma venda (sale_effect, invoice_effect,
// effect_titles), compartilhados com o faturamento agrupado.
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { fromSqlite } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { requireRpcParts, rpcPartsRequirement } from "../../engine/parts-gate.ts";
import { erpRequirement, erpRequirementMet } from "../../parts.ts";
import * as preferences from "../preferences/public.ts";
import { jsonbText } from "../../engine/json.ts";
import { jsonTimestamp as jsonTs } from "../../engine/time.ts";
import { bool } from "./internal.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const textField = (json: unknown, key: string) => {
  const o = parse(json);
  const v = o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[key] : undefined;
  return v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v);
};

/** erp_finance.invoice_contact(recipient) */
export function invoiceContact(recipient: unknown): string | null {
  const text = textField(recipient, "contact_id");
  return text !== null && UUID.test(text) ? text.toLowerCase() : null;
}

/** erp_finance.invoice_total_cents(totals) */
export function invoiceTotalCents(totals: unknown): number | null {
  const text = textField(totals, "total");
  if (text === null || !/^[0-9]{1,13}(\.[0-9]{1,2})?$/.test(text)) return null;
  const [i, f = ""] = text.split(".");
  return Number(i) * 100 + Number(f.padEnd(2, "0"));
}

/** erp_finance.invoice_kind(direction) */
export const invoiceKind = (direction: unknown) => (direction === "0" ? "payable" : "receivable");

/** erp_finance.invoice_effect_active */
export const invoiceEffectActive = (db: SqlDriver, invoice: string) =>
  !!one(db, `SELECT 1 x FROM "erp_finance__invoice_posting" WHERE invoice_id=? AND state='active' LIMIT 1`, invoice) ||
  !!one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_invoice" WHERE invoice_id=? AND active=1 LIMIT 1', invoice);

/** erp_finance.invoice_orders_posted(invoice) */
export function invoiceOrdersPosted(db: SqlDriver, invoice: string) {
  return db
    .exec(
      `SELECT d.id, d.kind, d.number FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id WHERE o.invoice_id=?
         AND (EXISTS(SELECT 1 FROM "erp_finance__document_posting" p WHERE p.document_id=d.id AND p.state='active')
           OR EXISTS(SELECT 1 FROM "erp_finance__grouped_billing_document" g WHERE g.document_id=d.id AND g.active=1))`,
      invoice,
    )
    .rows.sort((x, y) => (x.number === null ? (y.number === null ? 0 : 1) : y.number === null ? -1 : Number(x.number) - Number(y.number)))
    .map((d) => ({ document_id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number) }));
}

/** erp_finance.invoice_blocked_reason(nota) */
export function invoiceBlockedReason(db: SqlDriver, v: Row): string | null {
  if (one(db, `SELECT 1 x FROM "erp_finance__invoice_posting" WHERE invoice_id=? AND state='active' LIMIT 1`, v.id)) return "erp_finance_invoice_already_posted";
  if (one(db, 'SELECT 1 x FROM "erp_finance__grouped_billing_invoice" WHERE invoice_id=? AND active=1 LIMIT 1', v.id)) return "erp_finance_invoice_grouped";
  if (v.deleted_at !== null) return "erp_finance_invoice_deleted";
  if ([3, 10].includes(Number(v.status))) return "erp_finance_invoice_ineligible_state";
  if (invoiceOrdersPosted(db, String(v.id)).length > 0) return "erp_finance_invoice_order_posted";
  if (invoiceContact(v.recipient) === null) return "erp_finance_invalid_contact";
  if ((invoiceTotalCents(v.totals) ?? 0) <= 0) return "erp_finance_invoice_zero_total";
  return null;
}

/** erp_finance.effect_titles(tipo, id) */
export function effectTitles(db: SqlDriver, kind: "document" | "grouped" | "invoice", id: string) {
  const link =
    kind === "document"
      ? 'SELECT title_id, position FROM "erp_finance__document_title" WHERE posting_id=?'
      : kind === "grouped"
        ? 'SELECT title_id, position FROM "erp_finance__grouped_billing_title" WHERE billing_id=?'
        : 'SELECT title_id, position FROM "erp_finance__invoice_title" WHERE posting_id=?';
  return db
    .exec(link, id)
    .rows.map((x) => ({ position: Number(x.position), t: one(db, 'SELECT * FROM "erp_finance__title" WHERE id=? AND deleted_at IS NULL', x.title_id) }))
    .filter((x) => x.t)
    .sort((x, y) => x.position - y.position)
    .map(({ position, t }) => ({
      id: t!.id, position, due_on: t!.due_on, amount_cents: String(t!.amount_cents), settled_cents: String(t!.settled_cents), cancelled: bool(t!.cancelled), account_id: t!.account_id,
    }));
}

/** erp_finance.sale_effect(documento) */
export function saleEffect(db: SqlDriver, document: string): Record<string, unknown> | null {
  const p = one(db, `SELECT id FROM "erp_finance__document_posting" WHERE document_id=? AND state='active' LIMIT 1`, document);
  if (p) return { owner: "document", id: p.id, titles: effectTitles(db, "document", String(p.id)) };
  const b = one(
    db,
    `SELECT b.id FROM "erp_finance__grouped_billing_document" g JOIN "erp_finance__grouped_billing" b ON b.id=g.billing_id AND b.state='active' WHERE g.document_id=? AND g.active=1 LIMIT 1`,
    document,
  );
  if (b) return { owner: "grouped", id: b.id, titles: effectTitles(db, "grouped", String(b.id)) };
  const i = db
    .exec(
      `SELECT p.id, p.invoice_id, p.created_at FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_finance__invoice_posting" p ON p.invoice_id=o.invoice_id AND p.state='active' WHERE o.document_id=?`,
      document,
    )
    .rows.sort((x, y) => Number(x.created_at) - Number(y.created_at))[0];
  if (i) return { owner: "invoice", id: i.id, invoice_id: i.invoice_id, titles: effectTitles(db, "invoice", String(i.id)) };
  return null;
}

/** erp_finance.invoice_effect(nota) */
export function invoiceEffect(db: SqlDriver, invoice: string): Record<string, unknown> | null {
  const p = one(db, `SELECT id FROM "erp_finance__invoice_posting" WHERE invoice_id=? AND state='active' LIMIT 1`, invoice);
  if (p) return { owner: "invoice", id: p.id, titles: effectTitles(db, "invoice", String(p.id)) };
  const orders = db
    .exec('SELECT d.id, d.kind, d.number FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_documents__document" d ON d.id=o.document_id WHERE o.invoice_id=?', invoice)
    .rows.map((d) => ({ d, effect: saleEffect(db, String(d.id)) }))
    .filter((x) => x.effect !== null && ["document", "grouped"].includes(String(x.effect.owner)))
    .sort((x, y) => (x.d.number === null ? (y.d.number === null ? 0 : 1) : y.d.number === null ? -1 : Number(x.d.number) - Number(y.d.number)))
    .map(({ d, effect }) => ({ document_id: d.id, kind: d.kind, number: d.number === null ? null : String(d.number), effect }));
  return orders.length ? { owner: "orders", orders } : null;
}

/** erp_finance.invoice_posting_summary */
export function invoicePostingSummary(db: SqlDriver, id: string) {
  const p = one(db, 'SELECT * FROM "erp_finance__invoice_posting" WHERE id=?', id);
  if (!p) return null;
  const snap = parse(p.snapshot) as Record<string, unknown>;
  const text = (k: string) => (snap[k] === undefined || snap[k] === null ? null : typeof snap[k] === "string" ? snap[k] : jsonbText(snap[k]));
  return {
    id: p.id, invoice_id: p.invoice_id, source_invoice_version: p.invoice_version, group_id: p.group_id, state: p.state, version: p.version, origin: p.origin,
    direction: text("direction"), model: text("model"), number: text("number"), total_cents: text("total_cents"),
    installments: Array.isArray(snap.installments) ? snap.installments.length : null, category_id: text("category_id"),
    created_at: p.created_at === null ? null : jsonTs(String(p.created_at)), reversed_at: p.reversed_at === null ? null : jsonTs(String(p.reversed_at)), reason: p.reason,
  };
}

/** erp_finance.invoice_title_rows */
export function invoiceTitleRows(db: SqlDriver, posting: string) {
  return db
    .exec('SELECT t.*, l.position FROM "erp_finance__invoice_title" l JOIN "erp_finance__title" t ON t.id=l.title_id WHERE l.posting_id=?', posting)
    .rows.sort((x, y) => Number(x.position) - Number(y.position))
    .map((t) => ({
      id: t.id, position: t.position, version: t.version, due_on: t.due_on, amount_cents: String(t.amount_cents), settled_cents: String(t.settled_cents),
      balance_cents: String(Number(t.amount_cents) - Number(t.settled_cents)), cancelled: bool(t.cancelled), category_id: t.category_id, account_id: t.account_id,
      payment_method_id: t.payment_method_id, description: t.description,
      cnab_linked: !!one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE title_id=? LIMIT 1', t.id),
    }));
}

// ---------------------------------------------------------------------------
// Comissão das contas lançadas por uma nota (248): commission_invoice e o
// gatilho commission_capture_invoice (AFTER INSERT em invoice_title), em
// aritmética exata (BigInt): alíquotas com 4 casas, round do numeric (meio
// para longe do zero).

/** round(n/d) do numeric, com sinal */
const roundDiv = (n: bigint, d: bigint) => {
  if (d < 0n) (n = -n), (d = -d);
  return n >= 0n ? (2n * n + d) / (2n * d) : -((2n * -n + d) / (2n * d));
};
/** texto decimal → inteiro escalado (scale casas), sem arredondar casas a mais */
const scaled = (text: string, scale: number) => {
  const neg = text.startsWith("-");
  const [i, f = ""] = (neg ? text.slice(1) : text).split(".");
  const v = BigInt(i || "0") * 10n ** BigInt(scale) + BigInt((f + "0".repeat(scale)).slice(0, scale) || "0");
  return neg ? -v : v;
};

/** erp_finance.invoice_label(modelo, número) */
export const invoiceLabel = (model: unknown, number: unknown) => `${model === "65" ? "NFC-e" : "Nota fiscal"} nº ${number === null || number === undefined ? "(sem número)" : String(number)}`;

/** erp_finance.commission_invoice(nota, vendedor): base, soma dos itens, soma ponderada (escala 4) e regra. */
function commissionInvoice(db: SqlDriver, invoice: string, seller: string) {
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', invoice)!;
  const s = one(db, 'SELECT * FROM "erp_catalog__seller" WHERE id=?', seller)!;
  const bands = (s.commission_bands === null ? [] : (JSON.parse(String(s.commission_bands)) as Record<string, unknown>[]))
    .map((b) => ({ upTo: scaled(String(b.discount_up_to), 4), rate: scaled(String(b.rate), 4) }))
    .sort((x, y) => (x.upTo < y.upTo ? -1 : x.upTo > y.upTo ? 1 : 0));
  const fixed = s.commission_rate === null ? 0n : BigInt(String(s.commission_rate));
  let items = 0n,
    weighted = 0n;
  for (const i of db.exec('SELECT total, discount FROM "erp_fiscal_invoices__invoice_item" WHERE invoice_id=?', invoice).rows) {
    if (i.total === null) continue;
    const total = BigInt(String(i.total)); // centavos (numeric com 2 casas)
    items += total;
    let rate: bigint;
    if (s.commission_mode === "fixa") rate = fixed;
    else {
      // round(discount/total*100, 2) em centésimos de ponto: comparado com discount_up_to (escala 4).
      const pct = total > 0n ? roundDiv(BigInt(String(i.discount ?? 0)) * 10000n, total) * 100n : 0n;
      rate = bands.find((b) => pct <= b.upTo)?.rate ?? 0n;
    }
    weighted += total * rate;
  }
  const extra = preferences.get(db, "vendas.base_comissao") ?? [];
  let base: bigint;
  if (preferences.get(db, "nfe.base_comissao_total") === true) base = BigInt(invoiceTotalCents(v.totals) ?? 0);
  else {
    base = items;
    const has = (k: string) => Array.isArray(extra) && extra.includes(k);
    const totals = typeof v.totals === "string" ? JSON.parse(v.totals) : v.totals;
    const money = (k: string) => {
      const x = totals && typeof totals === "object" ? totals[k] : undefined;
      const text = x === undefined || x === null ? null : typeof x === "string" ? x : jsonbText(x);
      return text !== null && /^-?[0-9]{1,13}(\.[0-9]{1,2})?$/.test(text) ? scaled(text, 2) : null;
    };
    if (has("desconto")) base -= BigInt(String(v.discount ?? 0));
    if (has("frete")) base += BigInt(String(v.freight ?? 0));
    if (has("icms_st") && money("st") !== null) base += money("st")!;
    if (has("ipi") && money("ipi") !== null) base += money("ipi")!;
  }
  return { base: base > 0n ? base : 0n, items, weighted, rule: s.commission_rule };
}

/** erp_finance.commission_capture_invoice_title: a comissão de uma parcela da nota (null quando não cabe). */
function captureInvoiceTitle(ctx: RpcContext, title: string) {
  if (!erpRequirementMet(ctx.parts, erpRequirement("erp-financeiro", "erp-fiscal"))) return;
  const db = ctx.db;
  const l = one(db, 'SELECT * FROM "erp_finance__invoice_title" WHERE title_id=?', title);
  const p = l ? one(db, 'SELECT * FROM "erp_finance__invoice_posting" WHERE id=?', l.posting_id) : undefined;
  const snap = p ? (JSON.parse(String(p.snapshot)) as Record<string, unknown>) : null;
  if (!p || p.state !== "active" || snap?.direction !== "receivable") return;
  if (one(db, 'SELECT 1 x FROM "erp_finance__commission" WHERE title_id=? LIMIT 1', title)) return;
  const v = one(db, 'SELECT * FROM "erp_fiscal_invoices__invoice" WHERE id=?', p.invoice_id)!;
  const requirement = rpcPartsRequirement(ctx, "erp_finance_invoice_finance_post", { p_invoice_id: v.id });
  if (!requirement || requirement === "externo" || !erpRequirementMet(ctx.parts, requirement)) return;
  const seller = v.seller_id === null ? undefined : (one(db, 'SELECT id FROM "erp_catalog__seller" WHERE id=?', v.seller_id)?.id as string | undefined);
  if (seller === undefined) return;
  const calc = commissionInvoice(db, String(v.id), seller);
  if (calc.items <= 0n || calc.weighted <= 0n) return;
  const total = snap.total_cents === null || snap.total_cents === undefined ? null : BigInt(String(snap.total_cents));
  if (total === null || total <= 0n) return;
  const parts = (snap.installments as Record<string, unknown>[]) ?? [];
  const position = Number(l!.position);
  let before = 0n,
    upto = 0n;
  for (const x of parts) {
    const amount = BigInt(String(x.amount_cents));
    if (Number(x.position) < position) before += amount;
    if (Number(x.position) <= position) upto += amount;
  }
  // round(base*weighted/(items*100)): weighted está na escala 4.
  const commission = roundDiv(calc.base * calc.weighted, calc.items * 1000000n);
  const t = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', title)!;
  const label = `${invoiceLabel(v.model, v.number)} · parcela ${position}/${parts.length}`;
  try {
    db.exec(
      `INSERT INTO "erp_finance__commission"(id, seller_id, origin, invoice_posting_id, title_id, invoice_id, position, positions, rule, parcel_cents, base_cents, rate, commission_cents,
         due_on, description, version, actor, command_id, created_at) VALUES(?,?,'invoice',?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      crypto.randomUUID(), seller, p.id, t.id, v.id, position, parts.length, calc.rule, Number(t.amount_cents),
      Number(roundDiv(calc.base * upto, total) - roundDiv(calc.base * before, total)),
      Number(roundDiv(calc.weighted * 100n, calc.items)),
      Number(roundDiv(commission * upto, total) - roundDiv(commission * before, total)),
      t.due_on, [...label].slice(0, 240).join(""), p.actor, p.command_id, ctx.clock.next().toString(),
    );
  } catch (e) {
    // exception when data_exception or check_violation then null
    const err = fromSqlite(e);
    if (!(err.code.startsWith("22") || err.code === "23514")) throw err;
  }
}

/** INSERT em invoice_title, com o gatilho commission_capture_invoice. */
export function insertInvoiceTitle(ctx: RpcContext, title: string, posting: string, position: number) {
  const p = one(ctx.db, 'SELECT invoice_id FROM "erp_finance__invoice_posting" WHERE id=?', posting);
  requireRpcParts(ctx, "erp_finance_invoice_finance_post", { p_invoice_id: p?.invoice_id });
  ctx.db.exec('INSERT INTO "erp_finance__invoice_title"(title_id, posting_id, position) VALUES(?,?,?)', title, posting, position);
  try {
    captureInvoiceTitle(ctx, title);
  } catch (e) {
    const err = fromSqlite(e);
    if (!(err.code.startsWith("22") || err.code === "23514")) throw err;
  }
}
