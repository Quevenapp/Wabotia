// Relatórios em gráfico do Estoque e o alerta de lotes vencendo (Wabotia, sem
// função no oráculo):
// - erp_stock_chart, p_args.report "warehouses": produtos com saldo e
//   quantidade por depósito; "turnover": giro dos produtos no período (saídas
//   ÷ saldo médio) e a cobertura em dias;
// - erp_stock_lots_expiring: lotes com saldo que vencem nos próximos N dias
//   e os já vencidos, à parte, por depósito. N vem do pedido, ou da
//   preferência "Número de dias antes da data de validade" dos lotes quando a
//   empresa a gravou, ou 30.
// Uma consulta por fonte, com limite.
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgCompareText, pgLower } from "../../../engine/text.ts";
import { todaySaoPaulo, validDate } from "../../../engine/time.ts";
import { QTY, requireAccess } from "../internal.ts";

export const STOCK_CHART_LIMIT = 100000;
/** Padrão do alerta de lotes quando a empresa não gravou a preferência. */
export const LOT_ALERT_DEFAULT_DAYS = 30;
const DAY = 86400000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (n: number) => new Date(n).toISOString().slice(0, 10);
const invalid = (): never => raise("22023", "erp_stock_invalid_query");
const q6 = (v: bigint) => formatScaled(v, QTY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateArg = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !validDate(v) || v < "1900-01-01" || v > "2100-12-31") invalid();
  return v as string;
};
function argsOf(raw: unknown, allowed: readonly string[]) {
  const a = typeof raw === "string" ? JSON.parse(raw) : raw ?? {};
  if (jsonType(a) !== "object" || Object.keys(a).some((k) => !allowed.includes(k))) invalid();
  return a as Record<string, unknown>;
}
function warehouseArg(db: SqlDriver, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !UUID.test(v)) invalid();
  const id = (v as string).toLowerCase();
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', id)) raise("P0002", "erp_stock_warehouse_not_found");
  return id;
}
const tooMany = <T,>(rows: T[]) => { if (rows.length > STOCK_CHART_LIMIT) raise("54000", "erp_stock_chart_limit"); return rows; };
/** Depósitos (nome e se o saldo é desconsiderado), numa consulta. */
function warehouses(db: SqlDriver) {
  return db.exec(
    `SELECT w.record_id id, r.name, r.active, coalesce(s.ignore_balance,0) ignored FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id
     LEFT JOIN "erp_stock__warehouse_setting" s ON s.warehouse_id=w.record_id ORDER BY r.name, w.record_id LIMIT 500`,
  ).rows.map((w) => ({ id: String(w.id), name: String(w.name), active: Number(w.active) === 1, ignored: Number(w.ignored) === 1 }));
}

function byWarehouse(db: SqlDriver) {
  const list = warehouses(db);
  const rows = tooMany(db.exec(`SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" LIMIT ${STOCK_CHART_LIMIT + 1}`).rows);
  const acc = new Map<string, { products: number; negative: number; quantity: bigint }>();
  for (const r of rows) {
    const q = fromColumn(r.q), a = acc.get(String(r.warehouse_id)) ?? { products: 0, negative: 0, quantity: 0n };
    if (q > 0n) { a.products++; a.quantity += q; } else if (q < 0n) a.negative++;
    acc.set(String(r.warehouse_id), a);
  }
  return {
    report: "warehouses",
    items: list.map((w) => ({ warehouse_id: w.id, name: w.name, active: w.active, ignored: w.ignored, products: acc.get(w.id)?.products ?? 0, negative_positions: acc.get(w.id)?.negative ?? 0, quantity: q6(acc.get(w.id)?.quantity ?? 0n) })),
  };
}

/** Giro: saídas (lançamentos de saída) no período ÷ saldo médio (média do saldo no início e no fim); cobertura em dias pelo ritmo de saída. */
function turnover(db: SqlDriver, o: Record<string, unknown>) {
  const from = dateArg(o.from), to = dateArg(o.to), today = todaySaoPaulo();
  if (from > to || to > today || (ms(to) - ms(from)) / DAY > 366) invalid();
  const warehouse = warehouseArg(db, o.warehouse_id);
  const limit = o.limit === undefined ? 20 : o.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const scope = `((? IS NULL AND NOT EXISTS(SELECT 1 FROM "erp_stock__warehouse_setting" s WHERE s.warehouse_id=X.warehouse_id AND s.ignore_balance=1)) OR X.warehouse_id=?)`;
  const current = new Map<string, bigint>();
  for (const b of tooMany(db.exec(`SELECT product_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" X WHERE ${scope} LIMIT ${STOCK_CHART_LIMIT + 1}`, warehouse, warehouse).rows))
    current.set(String(b.product_id), (current.get(String(b.product_id)) ?? 0n) + fromColumn(b.q));
  // Lançamentos desde o início do período: os do período (saídas e saldo) e os depois dele (para voltar o saldo ao fim do período).
  const moves = tooMany(db.exec(
    `SELECT X.product_id, m.occurred_on, m.kind, CAST(X.quantity AS TEXT) q FROM "erp_stock__entry" X JOIN "erp_stock__movement" m ON m.id=X.movement_id
     WHERE m.occurred_on>=? AND ${scope} LIMIT ${STOCK_CHART_LIMIT + 1}`,
    from, warehouse, warehouse,
  ).rows);
  const acc = new Map<string, { out: bigint; inPeriod: bigint; after: bigint }>();
  for (const m of moves) {
    const a = acc.get(String(m.product_id)) ?? { out: 0n, inPeriod: 0n, after: 0n }, q = fromColumn(m.q);
    if (String(m.occurred_on) > to) a.after += q;
    else { a.inPeriod += q; if (m.kind === "issue" && q < 0n) a.out -= q; }
    acc.set(String(m.product_id), a);
  }
  const days = BigInt(Math.round((ms(to) - ms(from)) / DAY) + 1);
  const rows = [...acc.entries()].filter(([, a]) => a.out > 0n).map(([product, a]) => {
    const end = (current.get(product) ?? 0n) - a.after, start = end - a.inPeriod, average = (start + end) / 2n;
    // Giro com 2 casas e cobertura em dias inteiros (null sem saldo médio positivo ou sem saída).
    const ratio = average > 0n ? (a.out * 100n + average / 2n) / average : null;
    const cover = a.out > 0n && end > 0n ? (end * days) / a.out : null;
    return { product, out: a.out, start, end, average, ratio, cover };
  }).sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : pgCompareText(x.product, y.product)));
  const top = rows.slice(0, limit as number);
  const names = new Map(top.length ? db.exec(
    `SELECT r.id, r.name, r.code, p.unit FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(top.map((r) => r.product)),
  ).rows.map((r) => [String(r.id), r]) : []);
  return {
    report: "turnover", from, to, warehouse_id: warehouse, total: rows.length,
    items: top.map((r) => ({
      product_id: r.product, name: String(names.get(r.product)?.name ?? "Produto"), code: (names.get(r.product)?.code as string | null) ?? null, unit: (names.get(r.product)?.unit as string | null) ?? null,
      out_quantity: q6(r.out), start_quantity: q6(r.start), end_quantity: q6(r.end), average_quantity: q6(r.average),
      turnover: r.ratio === null ? null : formatScaled(r.ratio, 2), cover_days: r.cover === null ? null : Number(r.cover),
    })),
    warehouses: warehouses(db).map(({ id, name, active, ignored }) => ({ id, name, active, ignored })),
  };
}

export function erpStockChart(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const o = argsOf(a.p_args, ["report", "from", "to", "warehouse_id", "limit"]);
  if (o.report === "warehouses") return { scope: "stock_chart", data_mode: "erp_native", ...byWarehouse(db) };
  if (o.report === "turnover") return { scope: "stock_chart", data_mode: "erp_native", ...turnover(db, o) };
  return invalid();
}

/** N do alerta: a preferência dos lotes gravada pela empresa, ou 30. */
export function lotAlertDays(db: SqlDriver): { days: number; source: "preference" | "default" } {
  const row = one(db, `SELECT value FROM "erp_preferences__company_value" WHERE key='lotes.dias_aviso_validade'`);
  const v = row ? JSON.parse(String(row.value)) : null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 9999 ? { days: v, source: "preference" } : { days: LOT_ALERT_DEFAULT_DAYS, source: "default" };
}

export function erpStockLotsExpiring(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const o = argsOf(a.p_args, ["days", "warehouse_id", "limit"]);
  const preference = lotAlertDays(db);
  const days = o.days === undefined || o.days === null ? preference.days : o.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 3650) invalid();
  const limit = o.limit === undefined ? 100 : o.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) invalid();
  const warehouse = warehouseArg(db, o.warehouse_id);
  const today = todaySaoPaulo(), until = iso(ms(today) + (days as number) * DAY);
  // Lotes ativos de produtos ativos e não excluídos, com validade até o limite e saldo no depósito (os desconsiderados ficam fora sem filtro).
  const rows = tooMany(db.exec(
    `SELECT l.id, l.code, l.expires_on, l.product_id, r.name product_name, r.code product_code, p.unit, b.warehouse_id, wr.name warehouse_name, CAST(b.quantity AS TEXT) q
     FROM "erp_stock__lot_balance" b JOIN "erp_stock__lot" l ON l.id=b.lot_id JOIN "erp_catalog__record" r ON r.id=l.product_id
       LEFT JOIN "erp_catalog__product" p ON p.record_id=l.product_id JOIN "erp_catalog__record" wr ON wr.id=b.warehouse_id
     WHERE l.active=1 AND r.active=1 AND l.expires_on IS NOT NULL AND l.expires_on<=? AND b.quantity>0
       AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=l.product_id AND d.deleted_at IS NOT NULL)
       AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM "erp_stock__warehouse_setting" s WHERE s.warehouse_id=b.warehouse_id AND s.ignore_balance=1)) OR b.warehouse_id=?)
     LIMIT ${STOCK_CHART_LIMIT + 1}`,
    until, warehouse, warehouse,
  ).rows);
  const view = (r: (typeof rows)[number]) => ({
    lot_id: String(r.id), code: String(r.code), expires_on: String(r.expires_on), days_left: Math.round((ms(String(r.expires_on)) - ms(today)) / DAY),
    product_id: String(r.product_id), product_name: String(r.product_name), product_code: (r.product_code as string | null) ?? null, unit: (r.unit as string | null) ?? null,
    warehouse_id: String(r.warehouse_id), warehouse_name: String(r.warehouse_name), quantity: q6(fromColumn(r.q)),
  });
  const order = (x: ReturnType<typeof view>, y: ReturnType<typeof view>) =>
    pgCompareText(x.expires_on, y.expires_on) || pgCompareText(pgLower(x.product_name), pgLower(y.product_name)) || pgCompareText(x.code, y.code) || pgCompareText(x.warehouse_name, y.warehouse_name);
  const all = rows.map(view).sort(order);
  const expired = all.filter((x) => x.expires_on < today), expiring = all.filter((x) => x.expires_on >= today);
  return {
    scope: "stock_lots_expiring", data_mode: "erp_native", today, until, days, days_source: o.days === undefined || o.days === null ? preference.source : "request",
    preference_days: preference.days, warehouse_id: warehouse, limit,
    expiring: { total: expiring.length, lots: new Set(expiring.map((x) => x.lot_id)).size, items: expiring.slice(0, limit as number) },
    expired: { total: expired.length, lots: new Set(expired.map((x) => x.lot_id)).size, items: expired.slice(0, limit as number) },
    warehouses: warehouses(db).filter((w) => w.active).map(({ id, name, ignored }) => ({ id, name, ignored })),
  };
}

registerRpc("erp_stock_chart", erpStockChart);
registerRpc("erp_stock_lots_expiring", erpStockLotsExpiring);
