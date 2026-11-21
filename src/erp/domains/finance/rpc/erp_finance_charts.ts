// Relatórios em gráfico do Financeiro (Wabotia, sem função no oráculo):
// erp_finance_chart com p_args.report
// - cash_flow: fluxo de caixa previsto (contas pelo vencimento) e realizado
//   (movimentos das contas financeiras, fora transferências e saldo inicial)
//   por dia, semana ou mês, com o saldo realizado acumulado;
// - due: contas a receber e a pagar em aberto por faixa de vencimento.
// Uma consulta por fonte, com limite.
import { type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo, validDate } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { jsonArg, requireAccess, uuidArg } from "../internal.ts";

export const CHART_SOURCE_LIMIT = 100000;
const DAY = 86400000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
const invalid = (): never => raise("22023", "erp_finance_invalid_query");
const dateArg = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "1900-01-01" || v > "2100-12-31") invalid();
  return v as string;
};
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

export type ChartGroup = "day" | "week" | "month";
/** Faixas do período: dia, semana (de segunda a domingo) ou mês, cortadas nas pontas. */
export function chartBuckets(from: string, to: string, group: ChartGroup) {
  const out: { start_on: string; end_on: string }[] = [];
  const clip = (s: string, e: string) => out.push({ start_on: s < from ? from : s, end_on: e > to ? to : e });
  if (group === "day") for (let d = from; d <= to; d = addDays(d, 1)) clip(d, d);
  else if (group === "week") {
    const weekday = (new Date(ms(from)).getUTCDay() + 6) % 7;
    for (let d = addDays(from, -weekday); d <= to; d = addDays(d, 7)) clip(d, addDays(d, 6));
  } else {
    const f = new Date(ms(from));
    for (let y = f.getUTCFullYear(), m = f.getUTCMonth(); ; m++) {
      const s = iso(Date.UTC(y, m, 1));
      if (s > to) break;
      clip(s, iso(Date.UTC(y, m + 1, 0)));
    }
  }
  return out;
}
export function chartPeriod(o: Record<string, unknown>, maxBuckets = 400) {
  const from = dateArg(o.from), to = dateArg(o.to);
  const group = (o.group ?? "month") as ChartGroup;
  if (from > to || !["day", "week", "month"].includes(group) || (ms(to) - ms(from)) / DAY > 1100) invalid();
  const buckets = chartBuckets(from, to, group);
  if (buckets.length > maxBuckets) invalid();
  return { from, to, group, buckets };
}
const tooMany = <T,>(rows: T[]) => { if (rows.length > CHART_SOURCE_LIMIT) raise("54000", "erp_finance_chart_limit"); return rows; };

function cashFlow(db: SqlDriver, o: Record<string, unknown>) {
  const { from, to, group, buckets } = chartPeriod(o);
  const titles = tooMany(db.exec(
    `SELECT kind, due_on, amount_cents FROM "erp_finance__title" WHERE cancelled=0 AND deleted_at IS NULL AND due_on>=? AND due_on<=? LIMIT ${CHART_SOURCE_LIMIT + 1}`,
    from, to,
  ).rows);
  const moves = tooMany(db.exec(
    `SELECT m.posted_on, m.delta_cents FROM "erp_finance__movement" m JOIN "erp_finance__account" a ON a.id=m.account_id AND a.deleted_at IS NULL
     WHERE m.posted_on>=? AND m.posted_on<=? AND m.kind<>'opening' AND m.transfer_id IS NULL LIMIT ${CHART_SOURCE_LIMIT + 1}`,
    from, to,
  ).rows);
  // Saldo de abertura: todo o razão antes do período e os saldos iniciais lançados dentro dele.
  const opening = Number(db.exec(
    `SELECT coalesce(sum(m.delta_cents),0) b FROM "erp_finance__movement" m JOIN "erp_finance__account" a ON a.id=m.account_id AND a.deleted_at IS NULL
     WHERE m.posted_on<? OR (m.kind='opening' AND m.posted_on<=?)`,
    from, to,
  ).rows[0]?.b ?? 0);
  let running = opening;
  const items = buckets.map((b) => {
    const inside = <T extends { [k: string]: unknown }>(rows: T[], key: string) => rows.filter((r) => String(r[key]) >= b.start_on && String(r[key]) <= b.end_on);
    const t = inside(titles, "due_on"), m = inside(moves, "posted_on");
    const realizedIn = sum(m.map((x) => Number(x.delta_cents)).filter((v) => v > 0)), realizedOut = -sum(m.map((x) => Number(x.delta_cents)).filter((v) => v < 0));
    running += realizedIn - realizedOut;
    return {
      ...b,
      forecast_in_cents: String(sum(t.filter((x) => x.kind === "receivable").map((x) => Number(x.amount_cents)))),
      forecast_out_cents: String(sum(t.filter((x) => x.kind === "payable").map((x) => Number(x.amount_cents)))),
      realized_in_cents: String(realizedIn), realized_out_cents: String(realizedOut), balance_cents: String(running),
    };
  });
  const total = (k: string) => String(sum(items.map((i) => Number((i as Record<string, unknown>)[k]))));
  return {
    report: "cash_flow", from, to, group, opening_cents: String(opening), items,
    totals: { forecast_in_cents: total("forecast_in_cents"), forecast_out_cents: total("forecast_out_cents"), realized_in_cents: total("realized_in_cents"), realized_out_cents: total("realized_out_cents"), closing_cents: String(running) },
  };
}

/** Faixas de vencimento das contas em aberto, a partir de hoje. */
export const DUE_BANDS = [
  { key: "overdue_31", min: null, max: -31 }, { key: "overdue_30", min: -30, max: -1 }, { key: "today", min: 0, max: 0 },
  { key: "next_7", min: 1, max: 7 }, { key: "next_30", min: 8, max: 30 }, { key: "next_60", min: 31, max: 60 },
  { key: "next_90", min: 61, max: 90 }, { key: "later", min: 91, max: null },
] as const;
function due(db: SqlDriver) {
  const today = todaySaoPaulo();
  const rows = tooMany(db.exec(
    `SELECT kind, due_on, amount_cents - settled_cents balance FROM "erp_finance__title" WHERE cancelled=0 AND deleted_at IS NULL AND settled_cents<amount_cents LIMIT ${CHART_SOURCE_LIMIT + 1}`,
  ).rows);
  const items = DUE_BANDS.map((band) => {
    const inside = rows.filter((r) => {
      const days = Math.round((ms(String(r.due_on)) - ms(today)) / DAY);
      return (band.min === null || days >= band.min) && (band.max === null || days <= band.max);
    });
    const side = (kind: string) => inside.filter((r) => r.kind === kind);
    return {
      key: band.key, from_on: band.min === null ? null : addDays(today, band.min), to_on: band.max === null ? null : addDays(today, band.max),
      receivable_count: side("receivable").length, receivable_cents: String(sum(side("receivable").map((r) => Number(r.balance)))),
      payable_count: side("payable").length, payable_cents: String(sum(side("payable").map((r) => Number(r.balance)))),
    };
  });
  return {
    report: "due", today, items,
    totals: { receivable_cents: String(sum(items.map((i) => Number(i.receivable_cents)))), payable_cents: String(sum(items.map((i) => Number(i.payable_cents)))) },
  };
}

export function erpFinanceChart(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const role = requireAccess(db, user, false);
  const o = jsonArg(a.p_args ?? {});
  if (jsonType(o) !== "object" || Object.keys(o).some((k) => !["report", "from", "to", "group"].includes(k))) invalid();
  const report = (o as Record<string, unknown>).report;
  if (report === "cash_flow") {
    if (!permitted(db, user, "financas.caixas_bancos.fluxo")) raise("42501", "erp_finance_permission_denied");
    return { scope: "finance_chart", data_mode: "erp_native", role, ...cashFlow(db, o) };
  }
  if (report === "due") return { scope: "finance_chart", data_mode: "erp_native", role, ...due(db) };
  return invalid();
}

registerRpc("erp_finance_chart", erpFinanceChart);
