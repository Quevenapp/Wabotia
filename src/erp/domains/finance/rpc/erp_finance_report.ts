// Relatórios do Financeiro: public.erp_finance_report (fluxo realizado,
// previsto, resumo por categoria e por contato), erp_finance_due_report
// (vencimentos por dia), erp_finance_contact_ledger e _page (ficha financeira
// do contato), erp_finance_contact_open_titles e erp_finance_title_page (a
// lista v1 de contas).
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import { activeRole, permitted } from "../../access/public.ts";
import { contactScope } from "../../catalog/public.ts";
import { get as preference } from "../../preferences/public.ts";
import { btrim, charLength, cmpText, CNTRL, cnabPlanForSettlement, pgLower, requireAccess, uuidArg } from "../internal.ts";
import { dto, left, titleOrigin } from "../titles.ts";

const DAY = 86400000;
const toDate = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fmt(toDate(d) + n * DAY);
const span = (from: string, to: string) => Math.round((toDate(to) - toDate(from)) / DAY);
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const requirePermission = (db: SqlDriver, user: string, key: string) => {
  if (!permitted(db, user, key)) raise("42501", "erp_finance_permission_denied");
};

/** erp_finance.report_buckets(de, até, dia|mês) */
function buckets(from: string, to: string, group: string) {
  const out: { start_on: string; end_on: string }[] = [];
  if (group === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ start_on: d, end_on: d });
    return out;
  }
  const f = new Date(toDate(from));
  for (let y = f.getUTCFullYear(), m = f.getUTCMonth(); ; m++) {
    const start = fmt(Date.UTC(y, m, 1));
    if (start > to) break;
    const end = fmt(Date.UTC(y, m + 1, 0));
    out.push({ start_on: start < from ? from : start, end_on: end > to ? to : end });
  }
  return out;
}

/** erp_finance.report_settlement_parts(contas, de, até): categoria, contato, tipo e valor de cada parte da baixa. */
function settlementParts(db: SqlDriver, accounts: Set<string>, from: string, to: string) {
  const out: { category_id: string | null; amount: number }[] = [];
  const rows = db
    .exec(
      `SELECT s.*, t.kind tkind, t.contact_id, t.category_id title_category FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id
        WHERE s.posted_on>=? AND s.posted_on<=?`,
      from,
      to,
    )
    .rows.filter((s) => accounts.has(String(s.account_id)));
  for (const p of rows) {
    const baseId = String(p.reverses_id ?? p.id);
    const sign = p.kind === "reversal" ? -1 : 1;
    const item = one(
      db,
      'SELECT i.category_id item_category, b.category_id bordero_category FROM "erp_finance__bordero_item" i LEFT JOIN "erp_finance__bordero" b ON b.id=i.bordero_id WHERE i.settlement_id=?',
      baseId,
    );
    const principalCategory = (item?.item_category ?? item?.bordero_category ?? p.title_category ?? null) as string | null;
    const c = one(db, 'SELECT * FROM "erp_finance__settlement_category" WHERE settlement_id=?', baseId);
    const receivable = p.tkind === "receivable";
    const value = (k: string) => Number(p[k]);
    out.push({ category_id: principalCategory, amount: sign * (receivable ? value("principal_cents") : -value("principal_cents")) });
    if (value("interest_cents") > 0) out.push({ category_id: (c?.interest_category_id as string | null) ?? principalCategory, amount: sign * (receivable ? value("interest_cents") : -value("interest_cents")) });
    if (value("penalty_cents") > 0) out.push({ category_id: (c?.penalty_category_id as string | null) ?? principalCategory, amount: sign * (receivable ? value("penalty_cents") : -value("penalty_cents")) });
    if (value("discount_cents") > 0) out.push({ category_id: (c?.discount_category_id as string | null) ?? principalCategory, amount: sign * (receivable ? -value("discount_cents") : value("discount_cents")) });
    if (value("fee_cents") > 0) {
      const plan = cnabPlanForSettlement(db, baseId) as Row | null;
      out.push({ category_id: (c?.fee_category_id as string | null) ?? ((plan?.category_id as string | null) ?? null) ?? principalCategory, amount: -sign * value("fee_cents") });
    }
  }
  return out;
}

/** erp_finance.report_entry_parts(contas, de, até) */
function entryParts(db: SqlDriver, accounts: Set<string>, from: string, to: string) {
  return db
    .exec('SELECT * FROM "erp_finance__cash_entry" WHERE deleted_at IS NULL AND posted_on>=? AND posted_on<=?', from, to)
    .rows.filter((e) => accounts.has(String(e.account_id)))
    .map((e) => ({
      category_id: (one(
        db,
        `SELECT m.category_id FROM "erp_finance__movement" m WHERE m.entry_id=? AND m.kind='entry'
           AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" c WHERE c.compensates_id=m.id) ORDER BY m.created_at DESC LIMIT 1`,
        e.id,
      )?.category_id ?? null) as string | null,
      amount: e.kind === "in" ? Number(e.amount_cents) : -Number(e.amount_cents),
    }));
}

export function erpFinanceReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const report = (a.p_report as string | null) ?? null;
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const account = uuidArg(a.p_account);
  const group = (a.p_group as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const today = todaySaoPaulo();
  requireAccess(db, user, false);
  if (
    report === null || !["cash_flow", "forecast", "categories", "contacts"].includes(report) || from === null || to === null ||
    from < "1900-01-01" || to > "2100-12-31" || from > to || group === null || !["day", "month"].includes(group) ||
    (group === "day" && span(from, to) > 366) || span(from, to) > 3660 || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100
  )
    raise("22023", "erp_finance_invalid_query");
  // 246: Fluxo, Resumo por categoria e Resumo por cliente (Sistema > Usuários > Permissões).
  requirePermission(
    db,
    user,
    report === "categories" ? "financas.caixas_bancos.resumo_categoria" : report === "contacts" ? "financas.caixas_bancos.resumo_cliente" : "financas.caixas_bancos.fluxo",
  );
  if (account !== null && !one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL', account)) raise("P0002", "erp_finance_not_found");
  const accounts = new Set(
    db.exec('SELECT id FROM "erp_finance__account" WHERE deleted_at IS NULL AND (? IS NULL OR id=?)', account, account).rows.map((r) => String(r.id)),
  );
  const movements = db
    .exec('SELECT account_id, posted_on, delta_cents, kind, transfer_id FROM "erp_finance__movement"')
    .rows.filter((m) => accounts.has(String(m.account_id)))
    .map((m) => ({ posted_on: String(m.posted_on), delta: Number(m.delta_cents), kind: String(m.kind), transfer: m.transfer_id }));
  const ledger = (pred: (m: (typeof movements)[number]) => boolean) => sum(movements.filter(pred).map((m) => m.delta));
  let items: unknown[];
  let total: number;
  let summary: Record<string, unknown>;
  if (report === "cash_flow") {
    // Realizado: com todas as contas, transferências entre elas ficam fora de Entradas/Saídas; o saldo é o razão inteiro até o dia.
    const m = movements.filter((x) => x.posted_on >= from && x.posted_on <= to && x.kind !== "opening" && (account !== null || x.transfer === null));
    const rows = buckets(from, to, group).map((b) => {
      const inside = m.filter((x) => x.posted_on >= b.start_on && x.posted_on <= b.end_on);
      const inCents = sum(inside.filter((x) => x.delta > 0).map((x) => x.delta));
      const outCents = sum(inside.filter((x) => x.delta < 0).map((x) => -x.delta));
      return { ...b, in: inCents, out: outCents, balance: ledger((x) => x.posted_on <= b.end_on) };
    });
    items = rows.map((r) => ({ start_on: r.start_on, end_on: r.end_on, in_cents: String(r.in), out_cents: String(r.out), net_cents: String(r.in - r.out), balance_cents: String(r.balance) }));
    total = rows.length;
    summary = {
      previous_cents: String(ledger((x) => x.posted_on < from) + ledger((x) => x.kind === "opening" && x.posted_on >= from && x.posted_on <= to)),
      in_cents: String(sum(rows.map((r) => r.in))),
      out_cents: String(sum(rows.map((r) => r.out))),
      net_cents: String(sum(rows.map((r) => r.in - r.out))),
      closing_cents: String(ledger((x) => x.posted_on <= to)),
    };
  } else if (report === "forecast") {
    // Previsto: contas em aberto por vencimento sobre o saldo atual; Atrasadas (antes de hoje) à parte.
    const start = ledger(() => true);
    const limitDay = to > today ? to : today;
    const open = db
      .exec('SELECT kind, due_on, amount_cents, settled_cents, account_id FROM "erp_finance__title" WHERE cancelled=0 AND deleted_at IS NULL AND settled_cents<amount_cents AND due_on<=?', limitDay)
      .rows.filter((t) => account === null || t.account_id === account)
      .map((t) => ({ kind: String(t.kind), due_on: String(t.due_on), balance: Number(t.amount_cents) - Number(t.settled_cents) }));
    let running = start;
    const rows = buckets(from, to, group).map((b) => {
      const inside = open.filter((o) => o.due_on >= b.start_on && o.due_on <= b.end_on);
      const receivable = sum(inside.filter((o) => o.kind === "receivable").map((o) => o.balance));
      const payable = sum(inside.filter((o) => o.kind === "payable").map((o) => o.balance));
      running += receivable - payable;
      return { ...b, receivable, payable, balance: running };
    });
    items = rows.map((r) => ({
      start_on: r.start_on, end_on: r.end_on, receivable_cents: String(r.receivable), payable_cents: String(r.payable), net_cents: String(r.receivable - r.payable), balance_cents: String(r.balance),
    }));
    total = rows.length;
    const net = sum(rows.map((r) => r.receivable - r.payable));
    summary = {
      current_cents: String(start),
      receivable_cents: String(sum(rows.map((r) => r.receivable))),
      payable_cents: String(sum(rows.map((r) => r.payable))),
      net_cents: String(net),
      projected_cents: String(start + net),
      overdue_receivable_cents: String(sum(open.filter((o) => o.kind === "receivable" && o.due_on < today).map((o) => o.balance))),
      overdue_payable_cents: String(sum(open.filter((o) => o.kind === "payable" && o.due_on < today).map((o) => o.balance))),
      today,
    };
  } else if (report === "categories") {
    const parts = [...settlementParts(db, accounts, from, to), ...entryParts(db, accounts, from, to)];
    const g = new Map<string | null, number>();
    for (const p of parts) g.set(p.category_id, (g.get(p.category_id) ?? 0) + p.amount);
    const n = [...g.entries()].map(([category_id, amount]) => {
      const c = category_id === null ? null : one(db, 'SELECT name, kind, parent_id, deleted_at FROM "erp_finance__category" WHERE id=?', category_id);
      const parent = c?.parent_id ? ((one(db, 'SELECT name FROM "erp_finance__category" WHERE id=?', c.parent_id)?.name as string | undefined) ?? null) : null;
      return { category_id, amount, name: (c?.name as string | undefined) ?? null, kind: (c?.kind as string | undefined) ?? null, parent_name: parent, deleted: c ? c.deleted_at !== null : null };
    });
    const kindOrder = (k: string | null) => (k === "receivable" ? 0 : k === "payable" ? 1 : 2);
    n.sort(
      (x, y) =>
        kindOrder(x.kind) - kindOrder(y.kind) ||
        cmpText(pgLower(x.parent_name ?? x.name ?? ""), pgLower(y.parent_name ?? y.name ?? "")) ||
        Number(x.parent_name !== null) - Number(y.parent_name !== null) ||
        cmpText(pgLower(x.name ?? ""), pgLower(y.name ?? "")) ||
        (x.category_id === null ? (y.category_id === null ? 0 : 1) : y.category_id === null ? -1 : cmpText(x.category_id, y.category_id)),
    );
    total = n.length;
    items = n.slice((page - 1) * limit, (page - 1) * limit + limit).map((x) => ({
      category_id: x.category_id, name: x.name === null ? null : left(x.name, 200), parent_name: x.parent_name === null ? null : left(x.parent_name, 200),
      kind: x.kind, deleted: x.deleted ?? false, amount_cents: String(x.amount),
    }));
    const amounts = [...g.values()];
    summary = { in_cents: String(sum(amounts.filter((v) => v > 0))), out_cents: String(sum(amounts.filter((v) => v < 0).map((v) => -v))), net_cents: String(sum(amounts)) };
  } else {
    // Por cliente/fornecedor: o caixa das baixas (e estornos) das contas e dos lançamentos de caixa com o contato.
    const flows = [
      ...db
        .exec(`SELECT s.kind, s.net_cash_cents, s.account_id, t.contact_id, t.kind tkind FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id WHERE s.posted_on>=? AND s.posted_on<=?`, from, to)
        .rows.filter((s) => accounts.has(String(s.account_id)))
        .map((s) => ({ contact: String(s.contact_id), kind: String(s.tkind), amount: (s.kind === "reversal" ? -1 : 1) * Number(s.net_cash_cents) })),
      ...db
        .exec('SELECT contact_id, kind, amount_cents, account_id FROM "erp_finance__cash_entry" WHERE contact_id IS NOT NULL AND deleted_at IS NULL AND posted_on>=? AND posted_on<=?', from, to)
        .rows.filter((e) => accounts.has(String(e.account_id)))
        .map((e) => ({ contact: String(e.contact_id), kind: e.kind === "in" ? "receivable" : "payable", amount: Number(e.amount_cents) })),
    ];
    const g = new Map<string, { received: number; paid: number }>();
    for (const f of flows) {
      const x = g.get(f.contact) ?? { received: 0, paid: 0 };
      if (f.kind === "receivable") x.received += f.amount;
      else x.paid += f.amount;
      g.set(f.contact, x);
    }
    const n = [...g.entries()]
      .map(([contact_id, v]) => ({ contact_id, ...v, name: one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', contact_id)?.name as string | undefined }))
      .filter((x) => x.name !== undefined)
      .sort((x, y) => cmpText(pgLower(x.name!), pgLower(y.name!)) || cmpText(x.contact_id, y.contact_id));
    total = n.length;
    items = n.slice((page - 1) * limit, (page - 1) * limit + limit).map((x) => ({
      contact_id: x.contact_id, name: left(x.name!, 200), received_cents: String(x.received), paid_cents: String(x.paid), net_cents: String(x.received - x.paid),
    }));
    const all = [...g.values()];
    summary = {
      received_cents: String(sum(all.map((x) => x.received))),
      paid_cents: String(sum(all.map((x) => x.paid))),
      net_cents: String(sum(all.map((x) => x.received - x.paid))),
    };
  }
  return {
    entity: "finance_report", report, from, to, account_id: account, group, page: ["categories", "contacts"].includes(report) ? page : 1, limit, total, items, summary,
    data_mode: "erp_native",
  };
}

export function erpFinanceDueReport(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const pFrom = (a.p_from as string | null) ?? null;
  const pTo = (a.p_to as string | null) ?? null;
  const today = todaySaoPaulo();
  const role = requireAccess(db, user, false);
  let from: string;
  let to: string;
  const bad = () => raise("22023", "erp_finance_invalid_report_period");
  if (pFrom === null && pTo === null) {
    from = today;
    to = addDays(today, 29);
  } else {
    if (pFrom === null || pTo === null || charLength(pFrom) !== 10 || charLength(pTo) !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pFrom) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pTo) || pFrom < "1900-01-01" || pTo > "2100-12-31")
      bad();
    const valid = (d: string) => !Number.isNaN(toDate(d)) && fmt(toDate(d)) === d;
    if (!valid(pFrom!) || !valid(pTo!)) bad();
    from = pFrom!;
    to = pTo!;
  }
  if (from < "1900-01-01" || to > "2100-12-31" || to < from || span(from, to) > 365) bad();
  const titles = db
    .exec('SELECT kind, due_on, amount_cents, settled_cents FROM "erp_finance__title" WHERE due_on>=? AND due_on<=? AND cancelled=0 AND settled_cents<amount_cents', from, to)
    .rows;
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const mine = titles.filter((t) => t.due_on === d);
    const r = mine.filter((t) => t.kind === "receivable");
    const p = mine.filter((t) => t.kind === "payable");
    const bal = (xs: Row[]) => sum(xs.map((t) => Number(t.amount_cents) - Number(t.settled_cents)));
    days.push({ day: d, rc: r.length, rv: bal(r), pc: p.length, pv: bal(p) });
  }
  return {
    scope: "due_report", data_mode: "erp_native", role, timezone: "America/Sao_Paulo", business_date: today, as_of: jsonTimestamp(ctx.clock.next()),
    from, to, day_count: span(from, to) + 1, basis: "outstanding_principal",
    days: days.map((x) => ({
      day: x.day, receivable_count: String(x.rc), receivable_cents: String(x.rv), payable_count: String(x.pc), payable_cents: String(x.pv), difference_cents: String(x.rv - x.pv),
    })),
    totals: {
      receivable_count: String(sum(days.map((x) => x.rc))), receivable_cents: String(sum(days.map((x) => x.rv))),
      payable_count: String(sum(days.map((x) => x.pc))), payable_cents: String(sum(days.map((x) => x.pv))),
      difference_cents: String(sum(days.map((x) => x.rv)) - sum(days.map((x) => x.pv))),
    },
  };
}

interface LedgerLine {
  day: string;
  at: number;
  line_kind: string;
  ref_id: string;
  kind: string;
  note: unknown;
  due_on: unknown;
  side: string;
  amount: number;
  situation: string | null;
  origin: unknown;
  version: unknown;
  method: string | null;
}

/** As linhas da ficha financeira (contas, baixas e lançamentos de caixa do contato). */
function ledgerLines(db: SqlDriver, contact: string, scope: string, from: string, to: string, withInvoices: boolean): LedgerLine[] {
  const today = todaySaoPaulo();
  const method = (id: unknown) =>
    id === null ? null : (((one(db, 'SELECT description FROM "erp_catalog__payment_method" WHERE id=?', id)?.description as string | undefined) ?? null) as string | null);
  const note = (t: Row) => (Number(t.installments) > 1 ? `${t.description} ${t.installment}/${t.installments}` : t.description);
  const out: LedgerLine[] = [];
  for (const t of db.exec('SELECT * FROM "erp_finance__title" WHERE contact_id=? AND deleted_at IS NULL AND issued_on>=? AND issued_on<=?', contact, from, to).rows) {
    if (scope !== "all" && t.kind !== scope) continue;
    const settled = Number(t.settled_cents), amount = Number(t.amount_cents);
    const situation = t.cancelled === 1 ? "cancelled" : settled === amount ? "paid" : settled > 0 ? "partial" : t.due_on === today ? "due_today" : String(t.due_on) < today ? "overdue" : "open";
    const doc = one(
      db,
      `SELECT d.kind, CAST(d.number AS TEXT) number FROM "erp_finance__document_title" l JOIN "erp_finance__document_posting" dp ON dp.id=l.posting_id
         JOIN "erp_documents__document" d ON d.id=dp.document_id WHERE l.title_id=? LIMIT 1`,
      t.id,
    );
    let origin: unknown = doc ? { kind: doc.kind, number: doc.number } : null;
    if (origin === null && withInvoices) {
      const inv = one(
        db,
        `SELECT CAST(i.number AS TEXT) number FROM "erp_finance__invoice_title" l JOIN "erp_finance__invoice_posting" ip ON ip.id=l.posting_id
           JOIN "erp_fiscal_invoices__invoice" i ON i.id=ip.invoice_id WHERE l.title_id=? AND i.number IS NOT NULL LIMIT 1`,
        t.id,
      );
      if (inv) origin = { kind: "fiscal_invoices", number: inv.number };
    }
    const m = method(t.payment_method_id);
    out.push({
      day: String(t.issued_on), at: Number(t.created_at), line_kind: "title", ref_id: String(t.id), kind: String(t.kind), note: note(t), due_on: t.due_on,
      side: t.kind === "receivable" ? "debit" : "credit", amount, situation, origin, version: null, method: m === null ? null : left(m, 100),
    });
  }
  for (const s of db
    .exec(`SELECT s.*, t.kind tkind, t.description, t.due_on, t.payment_method_id FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id WHERE t.contact_id=? AND s.posted_on>=? AND s.posted_on<=?`, contact, from, to)
    .rows) {
    if (scope !== "all" && s.tkind !== scope) continue;
    const m = method(s.payment_method_id);
    out.push({
      day: String(s.posted_on), at: Number(s.created_at), line_kind: s.kind === "payment" ? "payment" : "reversal", ref_id: String(s.id), kind: String(s.tkind),
      note: s.note ?? s.description, due_on: s.due_on, side: (s.tkind === "receivable") === (s.kind === "payment") ? "credit" : "debit",
      amount: Number(s.principal_cents) + Number(s.interest_cents) + Number(s.penalty_cents) - Number(s.discount_cents), situation: null, origin: null, version: null,
      method: m === null ? null : left(m, 100),
    });
  }
  for (const e of db.exec('SELECT * FROM "erp_finance__cash_entry" WHERE contact_id=? AND deleted_at IS NULL AND posted_on>=? AND posted_on<=?', contact, from, to).rows) {
    if (!(scope === "all" || (scope === "receivable" && e.kind === "in") || (scope === "payable" && e.kind === "out"))) continue;
    out.push({
      day: String(e.posted_on), at: Number(e.created_at), line_kind: "entry", ref_id: String(e.id), kind: e.kind === "in" ? "receivable" : "payable", note: e.note, due_on: null,
      side: e.kind === "in" ? "credit" : "debit", amount: Number(e.amount_cents), situation: null, origin: null, version: e.version, method: null,
    });
  }
  return out.sort((x, y) => cmpText(x.day, y.day) || x.at - y.at || cmpText(x.ref_id, y.ref_id));
}

function ledgerArgs(a: RpcArgs) {
  return {
    contact: uuidArg(a.p_contact),
    scope: (a.p_scope as string | null) ?? null,
    from: (a.p_from as string | null) ?? null,
    to: (a.p_to as string | null) ?? null,
  };
}
const ledgerInvalid = (x: ReturnType<typeof ledgerArgs>) =>
  x.contact === null || x.scope === null || !["all", "receivable", "payable"].includes(x.scope) || x.from === null || x.to === null || x.from > x.to ||
  x.from < "1900-01-01" || x.to > "2100-12-31" || span(x.from, x.to) > 3660;
const lineJson = (l: LedgerLine, withMethod: boolean) => ({
  day: l.day, line_kind: l.line_kind, ref_id: l.ref_id, kind: l.kind, note: l.note, due_on: l.due_on, side: l.side, amount_cents: String(l.amount),
  situation: l.situation, origin: l.origin, version: l.version, ...(withMethod ? { payment_method: l.method } : {}),
});
const ledgerTotals = (lines: LedgerLine[]) => {
  const debit = sum(lines.filter((l) => l.side === "debit" && l.situation !== "cancelled").map((l) => l.amount));
  const credit = sum(lines.filter((l) => l.side === "credit" && l.situation !== "cancelled").map((l) => l.amount));
  return { debit_cents: String(debit), credit_cents: String(credit), balance_cents: String(credit - debit) };
};
const contactName = (db: SqlDriver, id: string) => (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name as string | undefined) ?? null;

export function erpFinanceContactLedger(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const x = ledgerArgs(a);
  requireAccess(db, user, false);
  if (ledgerInvalid(x)) raise("22023", "erp_finance_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', x.contact)) raise("P0002", "erp_finance_not_found");
  const lines = ledgerLines(db, x.contact!, x.scope!, x.from!, x.to!, false);
  if (lines.length > 5000) raise("54000", "erp_finance_ledger_limit");
  return {
    entity: "contact_ledger", contact_id: x.contact, contact_name: contactName(db, x.contact!), scope: x.scope, from: x.from, to: x.to,
    items: lines.map((l) => lineJson(l, false)), totals: ledgerTotals(lines), data_mode: "erp_native",
  };
}

export function erpFinanceContactLedgerPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const x = ledgerArgs(a);
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  requireAccess(db, user, false);
  requirePermission(db, user, "financas.ficha");
  if (ledgerInvalid(x) || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100) raise("22023", "erp_finance_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', x.contact)) raise("P0002", "erp_finance_not_found");
  const lines = ledgerLines(db, x.contact!, x.scope!, x.from!, x.to!, true);
  return {
    entity: "contact_ledger", contact_id: x.contact, contact_name: contactName(db, x.contact!), scope: x.scope, from: x.from, to: x.to, page, limit, total: lines.length,
    items: lines.slice((page! - 1) * limit!, (page! - 1) * limit! + limit!).map((l) => lineJson(l, true)), totals: ledgerTotals(lines), data_mode: "erp_native",
  };
}

export function erpFinanceContactOpenTitles(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const kind = (a.p_kind as string | null) ?? null;
  const contact = uuidArg(a.p_contact);
  const today = todaySaoPaulo();
  const role = activeRole(db, user);
  if (kind === null || !["receivable", "payable"].includes(kind) || contact === null) raise("22023", "erp_finance_invalid_query");
  const on = (key: string) => (preference(db, key) ?? false) === true;
  if (
    role === null ||
    !(
      ["admin", "financeiro", "consulta"].includes(role) ||
      (kind === "receivable" && ["vendas", "estoque", "fiscal"].includes(role) && on("vendas.ver_contas_receber")) ||
      (kind === "payable" && ["estoque", "fiscal"].includes(role) && on("compras.ver_contas_pagar"))
    )
  )
    raise("42501", "erp_finance_access_denied");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', contact)) raise("P0002", "erp_finance_not_found");
  const scope = contactScope(db, user);
  if (scope !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?', contact, scope)) raise("P0002", "erp_finance_not_found");
  const open = db
    .exec('SELECT * FROM "erp_finance__title" WHERE contact_id=? AND kind=? AND cancelled=0 AND deleted_at IS NULL AND settled_cents<amount_cents', contact, kind)
    .rows.sort((x, y) => cmpText(String(x.due_on), String(y.due_on)) || cmpText(String(x.id), String(y.id)));
  const bal = (t: Row) => Number(t.amount_cents) - Number(t.settled_cents);
  const overdue = open.filter((t) => String(t.due_on) < today);
  return {
    entity: "contact_open_titles", contact_id: contact, kind, total: open.length, balance_cents: String(sum(open.map(bal))), overdue: overdue.length,
    overdue_cents: String(sum(overdue.map(bal))),
    items: open.slice(0, 50).map((t) => ({
      id: t.id, description: Number(t.installments) > 1 ? `${t.description} ${t.installment}/${t.installments}` : t.description, due_on: t.due_on,
      amount_cents: String(t.amount_cents), balance_cents: String(bal(t)), overdue: String(t.due_on) < today,
    })),
    data_mode: "erp_native",
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["open", "partial", "paid", "cancelled", "overdue"];

export function erpFinanceTitlePage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const kind = (a.p_kind as string | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  const order = (a.p_order as string | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const statuses = (a.p_statuses as (string | null)[] | null) ?? null;
  const dateField = (a.p_date_field as string | null) ?? null;
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const category = (a.p_category as string | null) ?? null;
  const min = (a.p_min_cents as number | null) ?? null;
  const max = (a.p_max_cents as number | null) ?? null;
  const documentQuery = (a.p_document as string | null) ?? null;
  const today = todaySaoPaulo();
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  const docNeedle = documentQuery === null || btrim(documentQuery) === "" ? null : pgLower(btrim(documentQuery));
  const none = category === "none";
  requireAccess(db, user, false);
  const range = (v: number | null) => v === null || (v >= 0 && v <= 999999999999999);
  if (
    kind === null || !["receivable", "payable"].includes(kind) || page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 ||
    order === null || !["due_asc", "due_desc"].includes(order) || (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (documentQuery !== null && (charLength(documentQuery) > 60 || CNTRL.test(documentQuery))) || dateField === null || !["due", "issued", "settled"].includes(dateField) ||
    (statuses !== null && (statuses.length < 1 || statuses.length > 5 || statuses.includes(null) || statuses.some((s) => !STATUSES.includes(s!)) || new Set(statuses).size !== statuses.length)) ||
    (from !== null && (from < "1900-01-01" || from > "2100-12-31")) || (to !== null && (to < "1900-01-01" || to > "2100-12-31")) || (from !== null && to !== null && from > to) ||
    (category !== null && !none && !UUID.test(category)) || !range(min) || !range(max) || (min !== null && max !== null && min > max)
  )
    raise("22023", "erp_finance_invalid_query");
  const categoryId = category !== null && !none ? category.toLowerCase() : null;
  let digits: string | null = null;
  if (needle !== null && /^[0-9 ./-]+$/.test(needle)) {
    digits = needle.replace(/[^0-9]/g, "");
    if (digits.length < 3) digits = null;
  }
  const lo = from ?? "1900-01-01", hi = to ?? "2100-12-31";
  const rows = db
    .exec(
      `SELECT t.*, r.name contact_name, c.trade_name, c.email, c.document contact_document, CAST(d.number AS TEXT) document_number
         FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id LEFT JOIN "erp_catalog__contact" c ON c.record_id=t.contact_id
         LEFT JOIN "erp_finance__document_title" l ON l.title_id=t.id LEFT JOIN "erp_finance__document_posting" dp ON dp.id=l.posting_id
         LEFT JOIN "erp_documents__document" d ON d.id=dp.document_id WHERE t.kind=?`,
      kind,
    )
    .rows.filter((t) => {
      const cancelled = t.cancelled === 1, settled = Number(t.settled_cents), amount = Number(t.amount_cents), due = String(t.due_on);
      if (
        statuses !== null &&
        !(
          (statuses.includes("open") && !cancelled && settled === 0) ||
          (statuses.includes("partial") && !cancelled && settled > 0 && settled < amount) ||
          (statuses.includes("paid") && !cancelled && settled === amount) ||
          (statuses.includes("cancelled") && cancelled) ||
          (statuses.includes("overdue") && !cancelled && settled < amount && due < today)
        )
      )
        return false;
      if (from !== null || to !== null) {
        const ok =
          (dateField === "due" && due >= lo && due <= hi) ||
          (dateField === "issued" && String(t.issued_on) >= lo && String(t.issued_on) <= hi) ||
          (dateField === "settled" &&
            !!one(
              db,
              `SELECT 1 x FROM "erp_finance__settlement" s WHERE s.title_id=? AND s.kind='payment' AND s.posted_on>=? AND s.posted_on<=?
                 AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=s.id) LIMIT 1`,
              t.id, lo, hi,
            ));
        if (!ok) return false;
      }
      if (category !== null && !((none && t.category_id === null) || t.category_id === categoryId)) return false;
      if (min !== null && amount < min) return false;
      if (max !== null && amount > max) return false;
      const join = (...xs: unknown[]) => xs.filter((x) => x !== null && x !== undefined).map(String).join(" ");
      if (docNeedle !== null && !pgLower(join(t.source_reference, t.document_number)).includes(docNeedle)) return false;
      if (
        needle !== null &&
        !pgLower(join(t.contact_name, t.trade_name, t.email, t.contact_document, t.description, t.source_reference, t.document_number)).includes(needle) &&
        !(digits !== null && String(t.contact_document ?? "").replace(/[^0-9]/g, "").includes(digits))
      )
        return false;
      return true;
    });
  const asc = order === "due_asc";
  rows.sort((x, y) => (asc ? 1 : -1) * (cmpText(String(x.due_on), String(y.due_on)) || cmpText(String(x.id), String(y.id))));
  const amountSum = sum(rows.map((t) => Number(t.amount_cents)));
  const balance = sum(rows.map((t) => (t.cancelled === 1 ? 0 : Number(t.amount_cents) - Number(t.settled_cents))));
  return {
    entity: "titles", kind,
    items: rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((t) => ({
      ...dto(db, "titles", String(t.id)),
      overdue: t.cancelled !== 1 && Number(t.settled_cents) < Number(t.amount_cents) && String(t.due_on) < today,
      origin: titleOrigin(db, String(t.id)),
    })),
    page, limit, order, total: rows.length, totals: { count: rows.length, amount_cents: String(amountSum), balance_cents: String(balance) },
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_report", erpFinanceReport);
registerRpc("erp_finance_due_report", erpFinanceDueReport);
registerRpc("erp_finance_contact_ledger", erpFinanceContactLedger);
registerRpc("erp_finance_contact_ledger_page", erpFinanceContactLedgerPage);
registerRpc("erp_finance_contact_open_titles", erpFinanceContactOpenTitles);
registerRpc("erp_finance_title_page", erpFinanceTitlePage);
