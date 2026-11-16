// Comissões (SQL 171 e o relatório da 370): visibilidade do vendedor, a visão
// e a contagem dos lançamentos, as linhas do razão (commission_rows), a visão
// do vendedor, a da operação comercial e a formatação das alíquotas.
import { fromColumn } from "../../engine/dec.ts";
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { saoPauloParts } from "../../engine/time.ts";
import { contactScope, contactSituation, contactSourceSituation } from "../catalog/public.ts";
import { bool, cmpText, ts } from "./internal.ts";
import { left } from "./titles.ts";

/** round(n/d) do numeric (meio para longe do zero), para n ≥ 0 e d > 0 */
export const roundDiv = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);

/** to_char(rate,'FM990.00') de um valor com `scale` casas guardado como inteiro escalado */
export function rate2(scaled: bigint, scale: number) {
  const v = scale >= 2 ? roundDiv(scaled, 10n ** BigInt(scale - 2)) : scaled * 10n ** BigInt(2 - scale);
  return `${v / 100n}.${String(v % 100n).padStart(2, "0")}`;
}
/** rate::numeric(10,4)::text de um valor com 6 casas */
export function rate4(scaled6: bigint) {
  const v = roundDiv(scaled6, 100n);
  return `${v / 10000n}.${String(v % 10000n).padStart(4, "0")}`;
}

/** erp_finance.commission_seller_visible */
export function sellerVisible(db: SqlDriver, user: string, seller: string | null) {
  const scope = contactScope(db, user);
  if (seller === null || !one(db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE id=?', seller)) raise("P0002", "erp_finance_not_found");
  if (scope !== null && scope !== seller) raise("P0002", "erp_finance_not_found");
}

/** erp_finance.commission_entry_counts */
export function entryCounts(db: SqlDriver, e: Row) {
  return (
    e.deleted_at === null &&
    (e.kind !== "payment" ||
      !!one(db, 'SELECT 1 x FROM "erp_finance__cash_entry" WHERE id=? AND deleted_at IS NULL', e.cash_entry_id) ||
      !!one(db, 'SELECT 1 x FROM "erp_finance__title" WHERE id=? AND cancelled=0 AND deleted_at IS NULL', e.title_id))
  );
}

/** erp_finance.commission_entry_view */
export function entryView(db: SqlDriver, id: string) {
  const e = one(db, 'SELECT e.*, a.name account_name FROM "erp_finance__commission_entry" e LEFT JOIN "erp_finance__account" a ON a.id=e.account_id WHERE e.id=?', id);
  if (!e) return null;
  return {
    id: e.id,
    seller_id: e.seller_id,
    kind: e.kind,
    month: e.month,
    posted_on: e.posted_on,
    amount_cents: String(e.amount_cents),
    description: e.description,
    category_id: e.category_id,
    account_id: e.account_id,
    account_name: e.account_name === null || e.account_name === undefined ? null : left(String(e.account_name), 200),
    source: e.cash_entry_id !== null ? "cash" : e.title_id !== null ? "payable" : null,
    title_id: e.title_id,
    counts: entryCounts(db, e),
    deleted: e.deleted_at !== null,
    version: e.version,
    created_at: ts(e.created_at),
  };
}

const spDate = (micros: unknown) => saoPauloParts(BigInt(String(micros))).date;

export interface CommissionRow {
  id: string;
  seller_id: string;
  origin: string;
  rule: string;
  parcel_cents: number;
  base_cents: number;
  rate: bigint;
  commission_cents: number;
  due_on: string;
  description: string;
  created_on: string | null;
  released_on: string | null;
  /** true, false ou null (null fica fora do "not void", como no Postgres) */
  void: boolean | null;
  document_id: string | null;
  document_kind: string | null;
  document_number: number | null;
  title_id: string | null;
  version: number;
}

/** erp_finance.commission_rows(vendedor) */
export function commissionRows(db: SqlDriver, seller: string | null): CommissionRow[] {
  const c = db
    .exec(`SELECT * FROM "erp_finance__commission" WHERE (? IS NULL OR seller_id=?) AND deleted_at IS NULL`, seller, seller)
    .rows;
  // done: os títulos dos lançamentos (documento e nota), com a data de quitação.
  const paidOn = (t: Row) => {
    if (bool(t.cancelled) || t.deleted_at !== null || Number(t.settled_cents) !== Number(t.amount_cents)) return null;
    const s = one(
      db,
      `SELECT max(s.posted_on) d FROM "erp_finance__settlement" s WHERE s.title_id=? AND s.kind='payment'
         AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" r WHERE r.reverses_id=s.id)`,
      t.id,
    );
    return (s?.d as string | null) ?? null;
  };
  const done: { posting_id: string; position: number; title_id: string; gone: boolean; paid_on: string | null }[] = [];
  for (const [links, col] of [["erp_finance__document_title", "posting_id"], ["erp_finance__invoice_title", "invoice_posting_id"]] as const) {
    const postings = [...new Set(c.filter((x) => x[col] !== null).map((x) => String(x[col])))];
    for (const p of postings)
      for (const l of db.exec(`SELECT l.posting_id, l.position, t.* FROM "${links}" l JOIN "erp_finance__title" t ON t.id=l.title_id WHERE l.posting_id=?`, p).rows)
        done.push({ posting_id: String(l.posting_id), position: Number(l.position), title_id: String(l.id), gone: bool(l.cancelled) || l.deleted_at !== null, paid_on: paidOn(l) });
  }
  const effect = (x: Row) => {
    if (x.posting_id !== null) return one(db, 'SELECT id, created_at, state FROM "erp_finance__document_posting" WHERE id=?', x.posting_id);
    if (x.invoice_posting_id !== null) return one(db, 'SELECT id, created_at, state FROM "erp_finance__invoice_posting" WHERE id=?', x.invoice_posting_id);
    return null;
  };
  return c.map((x) => {
    const effectId = (x.posting_id ?? x.invoice_posting_id) as string | null;
    const p = effect(x);
    const postedOn = p ? spDate(p.created_at) : null;
    const manual = x.origin === "manual";
    let released: string | null;
    if (manual) released = (x.credit_on as string | null) ?? null;
    else if (x.rule === "faturamento") released = postedOn;
    else if (x.rule === "parcial") released = done.find((d) => d.title_id === x.title_id)?.paid_on ?? null;
    else if (x.rule === "primeira_parcela") released = done.find((d) => d.posting_id === effectId && d.position === 1)?.paid_on ?? null;
    else {
      const live = done.filter((d) => d.posting_id === effectId && !d.gone);
      released = live.length && live.every((d) => d.paid_on !== null) ? live.map((d) => d.paid_on!).sort(cmpText).at(-1)! : null;
    }
    let isVoid: boolean | null = false;
    if (x.origin === "document" || x.origin === "invoice") {
      const gone = done.find((d) => d.title_id === x.title_id)?.gone ?? true;
      isVoid = gone ? true : p ? p.state !== "active" : null;
    }
    const d = x.document_id === null ? null : one(db, 'SELECT kind, number FROM "erp_documents__document" WHERE id=?', x.document_id);
    const i = x.invoice_id === null ? null : one(db, 'SELECT number FROM "erp_fiscal_invoices__invoice" WHERE id=?', x.invoice_id);
    const number = (d?.number ?? i?.number ?? null) as number | null;
    return {
      id: String(x.id),
      seller_id: String(x.seller_id),
      origin: String(x.origin),
      rule: String(x.rule),
      parcel_cents: Number(x.parcel_cents),
      base_cents: Number(x.base_cents),
      rate: fromColumn(x.rate),
      commission_cents: Number(x.commission_cents),
      due_on: String(x.due_on),
      description: String(x.description),
      created_on: manual ? ((x.credit_on as string | null) ?? null) : postedOn,
      released_on: released,
      void: isVoid,
      document_id: (x.document_id ?? x.invoice_id ?? null) as string | null,
      document_kind: x.origin === "invoice" ? "fiscal_invoices" : ((d?.kind as string | undefined) ?? null),
      document_number: number === null ? null : Number(number),
      title_id: (x.title_id as string | null) ?? null,
      version: Number(x.version),
    };
  });
}

/** Situação do contato do vendedor: contact_situation(r.active, coalesce(cp.situation, contact_source_situation(r.id))) */
export function sellerSituation(db: SqlDriver, r: Row) {
  return contactSituation(bool(r.active), (r.profile_situation as string | null) ?? contactSourceSituation(db, String(r.record_id)));
}

/** Vendedores com o nome, o código e a situação do contato. */
export function sellers(db: SqlDriver) {
  return db
    .exec(
      `SELECT s.id, s.contact_id, s.commission_rule, s.commission_mode, s.commission_rate, r.id record_id, r.name, r.code, r.active, cp.situation profile_situation
         FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=s.contact_id`,
    )
    .rows.map((r) => Object.assign({}, r, { situation: sellerSituation(db, r) }) as Row & { situation: string });
}

/** erp_finance.commission_seller_view */
export function sellerView(db: SqlDriver, id: string) {
  const s = sellers(db).find((x) => x.id === id);
  if (!s) return null;
  return {
    id: s.id,
    contact_id: s.contact_id,
    name: s.name,
    code: s.code,
    situation: s.situation,
    rule: s.commission_rule,
    mode: s.commission_mode,
    rate: s.commission_rate === null ? null : rateText(fromColumn(s.commission_rate), 4),
  };
}
/** numeric::text com as casas da coluna */
const rateText = (v: bigint, scale: number) => `${v / 10n ** BigInt(scale)}.${String(v % 10n ** BigInt(scale)).padStart(scale, "0")}`;

/** erp_finance.commission_operation_titles(documento) */
function operationTitles(db: SqlDriver, document: string) {
  return [
    ...db.exec(
      `SELECT l.title_id, l.position FROM "erp_finance__document_posting" p JOIN "erp_finance__document_title" l ON l.posting_id=p.id WHERE p.document_id=? AND p.state='active'`,
      document,
    ).rows,
    ...db.exec(
      `SELECT l.title_id, l.position FROM "erp_fiscal_invoices__invoice_order" o JOIN "erp_finance__invoice_posting" p ON p.invoice_id=o.invoice_id AND p.state='active'
         JOIN "erp_finance__invoice_title" l ON l.posting_id=p.id WHERE o.document_id=?`,
      document,
    ).rows,
    ...db.exec(
      `SELECT l.title_id, l.position FROM "erp_finance__grouped_billing_document" g JOIN "erp_finance__grouped_billing" b ON b.id=g.billing_id AND b.state='active'
         JOIN "erp_finance__grouped_billing_title" l ON l.billing_id=b.id WHERE g.document_id=? AND g.active=1`,
      document,
    ).rows,
  ];
}

/** erp_finance.commission_operation_view */
export function operationView(db: SqlDriver, id: string) {
  const o = one(db, 'SELECT * FROM "erp_finance__commission_operation" WHERE id=?', id);
  if (!o) return null;
  const adjustments = db
    .exec('SELECT * FROM "erp_finance__commission_adjustment" WHERE operation_id=?', id)
    .rows.sort((x, y) => Number(x.created_at) - Number(y.created_at) || cmpText(String(x.id), String(y.id)));
  const adjusted = adjustments.reduce((t, a) => t + Number(a.amount_cents), 0);
  const titles = operationTitles(db, String(o.document_id))
    .map((x) => ({ position: Number(x.position), t: one(db, 'SELECT * FROM "erp_finance__title" WHERE id=? AND deleted_at IS NULL', x.title_id) }))
    .filter((x) => x.t);
  const received = titles.reduce((t, x) => t + Number(x.t!.settled_cents), 0);
  const live = titles.filter((x) => !bool(x.t!.cancelled));
  const allPaid = live.length > 0 && live.every((x) => Number(x.t!.settled_cents) === Number(x.t!.amount_cents));
  const firstPaid = titles.some((x) => x.position === 1 && Number(x.t!.settled_cents) === Number(x.t!.amount_cents) && !bool(x.t!.cancelled));
  const estimated = Number(o.estimated_cents);
  const total = Number(o.total_cents);
  const net = Math.max(estimated + adjusted, 0);
  let eligible: number;
  if (o.state === "superseded") eligible = 0;
  else if (o.rule === "parcial") eligible = Math.min(net, total === 0 ? 0 : Number(roundDiv(BigInt(estimated) * BigInt(received), BigInt(total))));
  else if (o.rule === "faturamento") eligible = titles.length > 0 ? net : 0;
  else if (o.rule === "primeira_parcela") eligible = firstPaid ? net : 0;
  else eligible = titles.length > 0 && allPaid ? net : 0;
  const text = (v: unknown) => String(v);
  return {
    id: o.id,
    document_id: o.document_id,
    kind: o.kind,
    seller_id: o.seller_id,
    state: o.state,
    rule: o.rule,
    policy: JSON.parse(String(o.policy)),
    items_cents: text(o.items_cents),
    discount_cents: text(o.discount_cents),
    freight_cents: text(o.freight_cents),
    ipi_cents: text(o.ipi_cents),
    icms_st_cents: text(o.icms_st_cents),
    fee_cents: text(o.fee_cents),
    base_cents: text(o.base_cents),
    rate: rate4(fromColumn(o.rate)),
    estimated_cents: text(estimated),
    adjusted_cents: text(adjusted),
    net_cents: text(net),
    total_cents: text(total),
    received_cents: text(received),
    titles: titles.length,
    eligible_cents: text(eligible),
    adjustments: adjustments.map((a) => ({ kind: a.kind, amount_cents: String(a.amount_cents), occurred_on: a.occurred_on, note: a.note })),
    confirmed_status: o.confirmed_status,
    confirmed_on: o.confirmed_on,
    ended_at: ts(o.ended_at),
    ended_reason: o.ended_reason,
    version: o.version,
  };
}
