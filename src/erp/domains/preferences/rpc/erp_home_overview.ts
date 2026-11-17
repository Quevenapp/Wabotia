// Início: public.erp_home_summary, _overview e _top_products. Valores em
// centavos exatos (as colunas dec_i64 de escala 2 já são centavos).
// erp_document_mirror.report_coverage é a constante sem espelho (documents/reads-g.ts).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbKeys } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { PG_CNTRL, pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo, validDate } from "../../../engine/time.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { allowed as catalogAllowed } from "../../catalog/public.ts";
import { allowed as documentsAllowed, reportCoverage, transitions } from "../../documents/public.ts";
import { ignoredWarehouse } from "../../stock/public.ts";
import { text, uuid } from "../args.ts";
import { compareText } from "../order.ts";
import { saoPauloMidnight } from "../time.ts";

const DAY = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
/** date_trunc('month', d) - interval 'n months' */
function monthsBack(date: string, n: number) {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
const sum = (rows: Record<string, unknown>[], col: string) => rows.reduce((s, r) => s + (r[col] === null ? 0n : fromColumn(r[col])), 0n);

function memberRole(db: SqlDriver, user: string | null): string {
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r) raise("42501", "erp_home_access_denied");
  return String(r.role);
}

/** O período da página inicial (hoje, 7d, 30d, 3m, 6m, 12m ou customizado), validado como no Fagoo. */
function homePeriod(today: string, period: string | null, from: string | null, to: string | null): { from: string; to: string } {
  const invalid = (): never => raise("22023", "erp_home_period_invalid");
  if (period === null || !["hoje", "7d", "30d", "3m", "6m", "12m", "customizado"].includes(period) || (period !== "customizado" && (from !== null || to !== null)))
    invalid();
  let f: string, t: string;
  if (period === "hoje") [f, t] = [today, today];
  else if (period === "7d") [f, t] = [addDays(today, -6), today];
  else if (period === "30d") [f, t] = [addDays(today, -29), today];
  else if (period === "3m") [f, t] = [monthsBack(today, 2), today];
  else if (period === "6m") [f, t] = [monthsBack(today, 5), today];
  else if (period === "12m") [f, t] = [monthsBack(today, 11), today];
  else {
    const re = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
    if (from === null || to === null || !re.test(from) || !re.test(to) || from < "1900-01-01" || to > "2100-12-31") invalid();
    if (!validDate(from!) || !validDate(to!)) invalid();
    [f, t] = [from!, to!];
  }
  if (t < f || dayDiff(f, t) > 365) invalid();
  return { from: f, to: t };
}

const DOC_KINDS = ["sales_proposals", "sales_orders", "purchase_orders", "service_orders"];

/** public.erp_home_summary */
export function erpHomeSummary(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const db = ctx.db;
  const role = memberRole(db, user);
  const today = todaySaoPaulo();
  const catalog = ["contacts", "products", "warehouses"]
    .filter((e) => catalogAllowed(role, e, false))
    .map((e) => {
      const r = one(db, 'SELECT sum(active=1) a, sum(active=0) b FROM "erp_catalog__record" WHERE entity=?', e)!;
      return { entity: e, active: Number(r.a ?? 0), archived: Number(r.b ?? 0) };
    });
  const documents = DOC_KINDS.filter((k) => documentsAllowed(role, k, false))
    .sort(compareText)
    .map((k) => {
      const counts = new Map(
        db
          .exec(`SELECT status, count(*) n FROM "erp_documents__document" WHERE authority='brufap' AND kind=? GROUP BY status`, k)
          .rows.map((r) => [String(r.status), Number(r.n)]),
      );
      return {
        kind: k,
        count: [...counts.values()].reduce((s, n) => s + n, 0),
        statuses: jsonbKeys(transitions()[k] ?? {})
          .sort(compareText)
          .map((s) => ({ status: s, count: counts.get(s) ?? 0 })),
      };
    });
  let stock = null;
  if (["admin", "consulta", "estoque", "vendas", "fiscal"].includes(role)) {
    const rows = db
      .exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) quantity FROM "erp_stock__balance"')
      .rows.filter((r) => !ignoredWarehouse(db, String(r.warehouse_id)));
    stock = {
      positions: rows.length,
      positive_positions: rows.filter((r) => fromColumn(r.quantity) > 0n).length,
      zero_positions: rows.filter((r) => fromColumn(r.quantity) === 0n).length,
      products: new Set(rows.map((r) => r.product_id)).size,
      warehouses: new Set(rows.map((r) => r.warehouse_id)).size,
    };
  }
  let finance = null;
  if (["admin", "financeiro", "consulta"].includes(role)) {
    const titles = ["payable", "receivable"].map((k) => {
      const open = db
        .exec(
          `SELECT due_on, CAST(amount_cents AS TEXT) a, CAST(settled_cents AS TEXT) s FROM "erp_finance__title" WHERE kind=? AND cancelled=0 AND amount_cents>settled_cents`,
          k,
        )
        .rows.map((t) => ({ due: String(t.due_on), balance: fromColumn(t.a) - fromColumn(t.s) }));
      const week = addDays(today, 7);
      const bucket = (name: string, test: (d: string) => boolean) => {
        const hit = open.filter((t) => test(t.due));
        return { bucket: name, count: hit.length, balance_cents: hit.reduce((s, t) => s + t.balance, 0n).toString() };
      };
      return {
        kind: k,
        buckets: [
          bucket("overdue", (d) => d < today),
          bucket("today", (d) => d === today),
          bucket("next_7_days", (d) => d > today && d <= week),
          bucket("later", (d) => d > week),
        ],
      };
    });
    const acc = one(
      db,
      'SELECT sum(active=1) a, sum(active=0) b, sum(active=1 AND opening_recorded=0) p FROM "erp_finance__account"',
    )!;
    finance = {
      titles,
      accounts: {
        active: Number(acc.a ?? 0),
        archived: Number(acc.b ?? 0),
        opening_pending: Number(acc.p ?? 0),
        recorded_balance_cents: sum(db.exec('SELECT CAST(delta_cents AS TEXT) d FROM "erp_finance__movement"').rows, "d").toString(),
      },
    };
  }
  return {
    data_mode: "erp_native",
    as_of: jsonTimestamp((BigInt(Date.now()) * 1000n).toString()),
    business_date: today,
    timezone: "America/Sao_Paulo",
    role,
    catalog,
    documents,
    stock,
    finance,
    ...reportCoverage(),
  };
}

const docDate = (body: unknown) => {
  const v = (JSON.parse(String(body)) as Record<string, unknown>).date;
  return v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v);
};

export function erpHomeOverview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const base = erpHomeSummary(ctx, a);
  const role = base.role;
  const today = base.business_date;
  const { from, to } = homePeriod(today, text(a, "p_period"), text(a, "p_from"), text(a, "p_to"));
  const days = dayDiff(from, to) + 1;
  const grain = days > 62 ? "month" : "day";
  const inRange = (d: string | null) => d !== null && d >= from && d <= to;
  let sales = null;
  if (documentsAllowed(role, "sales_orders", false)) {
    const orders = db
      .exec(`SELECT status, body, CAST(total AS TEXT) total FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`)
      .rows.filter((d) => inRange(docDate(d.body)));
    sales = {
      count: orders.length,
      statuses: jsonbKeys(transitions().sales_orders)
        .sort(compareText)
        .map((s) => {
          const hit = orders.filter((o) => o.status === s);
          return { status: s, count: hit.length, total_cents: sum(hit, "total").toString() };
        }),
    };
  }
  let receivable = null;
  let payable = null;
  const titles =
    FIN_ROLES.includes(role)
      ? db
          .exec(
            `SELECT id, kind, due_on, CAST(amount_cents AS TEXT) a, CAST(settled_cents AS TEXT) s FROM "erp_finance__title" WHERE cancelled=0 AND due_on>=? AND due_on<=?`,
            from,
            to,
          )
          .rows
      : [];
  if (FIN_ROLES.includes(role)) {
    const rec = titles.filter((t) => t.kind === "receivable");
    const pay = titles.filter((t) => t.kind === "payable");
    const ids = new Set(rec.map((t) => t.id));
    const fee = db
      .exec('SELECT title_id, kind, CAST(fee_cents AS TEXT) fee FROM "erp_finance__settlement"')
      .rows.filter((s) => ids.has(s.title_id))
      .reduce((acc, s) => acc + (s.kind === "payment" ? fromColumn(s.fee) : -fromColumn(s.fee)), 0n);
    receivable = {
      count: rec.length,
      total_cents: sum(rec, "a").toString(),
      open_cents: (sum(rec, "a") - sum(rec, "s")).toString(),
      fee_cents: fee.toString(),
    };
    payable = { count: pay.length, total_cents: sum(pay, "a").toString(), open_cents: (sum(pay, "a") - sum(pay, "s")).toString() };
  }
  let invoices = null;
  if (["admin", "fiscal"].includes(role)) {
    const start = saoPauloMidnight(from);
    const end = saoPauloMidnight(addDays(to, 1));
    const drafts = db
      .exec(`SELECT snapshot, CAST(created_at AS TEXT) created_at FROM "erp_fiscal_drafts__draft" WHERE model='55' AND status='draft'`)
      .rows.filter((d) => BigInt(String(d.created_at)) >= start && BigInt(String(d.created_at)) < end);
    let cents = 0n;
    for (const d of drafts) {
      const totals = (JSON.parse(String(d.snapshot)) as { totals?: { total?: unknown } }).totals;
      const v = totals && typeof totals === "object" && !Array.isArray(totals) ? totals.total : undefined;
      if (v === undefined || v === null) continue;
      cents += toScaled(typeof v === "string" ? v : JSON.stringify(v), 2);
    }
    invoices = { count: drafts.length, total_cents: cents.toString() };
  }
  // Pontos do gráfico: por dia até 62 dias, senão por mês (meses das pontas podem ser parciais).
  const buckets: string[] = [];
  if (grain === "day") for (let d = from; d <= to; d = addDays(d, 1)) buckets.push(d);
  else for (let m = `${from.slice(0, 7)}-01`; m <= to; m = monthsBack(m, -1)) buckets.push(m.slice(0, 7));
  const key = (d: string) => (grain === "day" ? d : d.slice(0, 7));
  const salesBy = new Map<string, bigint>();
  if (sales !== null)
    for (const d of db.exec(`SELECT body, status, CAST(total AS TEXT) total FROM "erp_documents__document" WHERE kind='sales_orders' AND status<>'cancelled'`).rows) {
      const date = docDate(d.body);
      if (!inRange(date)) continue;
      const k = grain === "day" ? date! : [...date!].slice(0, 7).join("");
      salesBy.set(k, (salesBy.get(k) ?? 0n) + fromColumn(d.total));
    }
  const recBy = new Map<string, bigint>();
  const payBy = new Map<string, bigint>();
  if (receivable !== null)
    for (const t of titles) {
      const m = t.kind === "receivable" ? recBy : t.kind === "payable" ? payBy : null;
      if (m) m.set(key(String(t.due_on)), (m.get(key(String(t.due_on))) ?? 0n) + fromColumn(t.a));
    }
  const points = buckets.map((b) => ({
    bucket: b,
    sales_cents: sales === null ? null : (salesBy.get(b) ?? 0n).toString(),
    receivable_cents: receivable === null ? null : (recBy.get(b) ?? 0n).toString(),
    payable_cents: payable === null ? null : (payBy.get(b) ?? 0n).toString(),
  }));
  return {
    ...base,
    period: { key: text(a, "p_period"), from, to, day_count: days, grain, points, sales, receivable, payable, invoices },
    ...reportCoverage(),
  };
}

const FIN_ROLES = ["admin", "financeiro", "consulta"];
const CNTRL_ALL = new RegExp(PG_CNTRL, "gu");

export function erpHomeTopProducts(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const db = ctx.db;
  const role = memberRole(db, user);
  if (!(documentsAllowed(role, "sales_orders", false) && catalogAllowed(role, "products", false))) raise("42501", "erp_home_access_denied");
  const { from, to } = homePeriod(todaySaoPaulo(), text(a, "p_period"), text(a, "p_from"), text(a, "p_to"));
  const groups = new Map<string, { id: string; code: string | null; name: string; units: bigint; total: bigint }>();
  for (const r of db.exec(
    `SELECT d.body, i.product_id, CAST(i.quantity AS TEXT) quantity, CAST(i.total AS TEXT) total, r.code, r.name
     FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id JOIN "erp_catalog__record" r ON r.id=i.product_id
     WHERE d.authority='brufap' AND d.kind='sales_orders' AND d.status<>'cancelled'`,
  ).rows) {
    const date = docDate(r.body);
    if (date === null || date < from || date > to) continue;
    const id = String(r.product_id);
    const g = groups.get(id) ?? { id, code: (r.code as string | null) ?? null, name: String(r.name), units: 0n, total: 0n };
    g.units += fromColumn(r.quantity);
    g.total += fromColumn(r.total);
    groups.set(id, g);
  }
  const order = (name: (g: { name: string }) => string) => (x: { units: bigint; total: bigint; name: string; id: string }, y: typeof x) =>
    (x.units > y.units ? -1 : x.units < y.units ? 1 : 0) || (x.total > y.total ? -1 : x.total < y.total ? 1 : 0) || compareText(name(x), name(y)) || compareText(x.id, y.id);
  const items = [...groups.values()]
    .sort(order((g) => g.name))
    .slice(0, 5)
    .map((g) => ({ ...g, clean: pgLeft(g.name.replace(CNTRL_ALL, " "), 200) }))
    .sort(order((g) => (g as unknown as { clean: string }).clean))
    .map((g) => ({
      product_id: g.id,
      code: g.code === null ? null : pgLeft(g.code, 60),
      name: g.clean,
      units: formatScaled(g.units, 6),
      total_cents: g.total.toString(),
    }));
  return { scope: "home_top_products", data_mode: "erp_native", key: text(a, "p_period"), from, to, items, ...reportCoverage() };
}

registerRpc("erp_home_summary", erpHomeSummary);
registerRpc("erp_home_overview", erpHomeOverview);
registerRpc("erp_home_top_products", erpHomeTopProducts);
