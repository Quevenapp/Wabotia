// Relatórios em gráfico de Vendas (Vinki, sem função no oráculo):
// erp_report_sales_chart com p_args.report
// - period: pedidos de venda e valor por dia, semana ou mês;
// - seller: valor e pedidos por vendedor (o do pedido; o do Bling pelo nome);
// - product: os produtos que mais venderam no período (valor e quantidade).
// Pedidos de venda do ERP pela data do pedido, sem os cancelados (ou nas
// situações pedidas). O vendedor com carteira restrita vê só os pedidos dele.
// Uma consulta por fonte, com limite.
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgCompareText, pgLeft, pgLower } from "../../../engine/text.ts";
import { activeRole, permitted } from "../../access/public.ts";
import { contactScope } from "../../catalog/public.ts";
import { allowed as documentsAllowed } from "../../documents/public.ts";
import { chartPeriod } from "../../finance/rpc/erp_finance_charts.ts";

export const SALES_CHART_LIMIT = 50000;
const STATUSES = ["draft", "open", "verified", "in_progress", "partially_fulfilled", "fulfilled", "cancelled"];
const invalid = (): never => raise("22023", "erp_preferences_invalid_query");
const jp = (v: unknown, ...path: string[]) => {
  let x = typeof v === "string" ? JSON.parse(v) : v;
  for (const k of path) x = x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined;
  return x;
};
const tooMany = <T,>(rows: T[]) => { if (rows.length > SALES_CHART_LIMIT) raise("54000", "erp_report_chart_limit"); return rows; };

export function erpReportSalesChart(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const role = activeRole(db, user);
  if (!documentsAllowed(role, "sales_orders", false) || !permitted(db, user, "vendas.relatorios_vendas.vendas")) raise("42501", "erp_report_access_denied");
  const o = typeof a.p_args === "string" ? JSON.parse(a.p_args) : a.p_args ?? {};
  if (jsonType(o) !== "object" || Object.keys(o).some((k) => !["report", "from", "to", "group", "statuses", "limit"].includes(k))) invalid();
  const { from, to, group, buckets } = chartPeriod(o);
  const report = o.report;
  if (!["period", "seller", "product"].includes(report)) invalid();
  const statuses: string[] = o.statuses === undefined || o.statuses === null ? STATUSES.filter((s) => s !== "cancelled" && s !== "draft") : o.statuses;
  if (!Array.isArray(statuses) || !statuses.length || statuses.some((s) => !STATUSES.includes(s)) || new Set(statuses).size !== statuses.length) invalid();
  const limit = o.limit === undefined ? 20 : o.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
  const scope = contactScope(db, user);
  const where = `d.authority='brufap' AND d.kind='sales_orders' AND d.deleted_at IS NULL AND (d.body ->> 'date')>=? AND (d.body ->> 'date')<=?
    AND d.status IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (d.body ->> 'seller_id')=?)`;
  const params = [from, to, JSON.stringify(statuses), scope, scope];
  const base = { scope: "sales_chart", data_mode: "erp_native", role, report, from, to, group, statuses, seller_scope: scope !== null };
  if (report === "product") {
    const rows = db.exec(
      `SELECT i.product_id, max(r.name) name, max(r.code) code, max(p.unit) unit, CAST(sum(i.quantity) AS TEXT) q, CAST(sum(i.total) AS TEXT) t, count(DISTINCT d.id) orders
       FROM "erp_documents__item" i JOIN "erp_documents__document" d ON d.id=i.document_id LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id
         LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
       WHERE ${where} GROUP BY i.product_id ORDER BY sum(i.total) DESC, i.product_id LIMIT ?`,
      ...params, limit,
    ).rows;
    const totals = db.exec(`SELECT CAST(coalesce(sum(i.total),0) AS TEXT) t, count(DISTINCT i.product_id) n FROM "erp_documents__item" i JOIN "erp_documents__document" d ON d.id=i.document_id WHERE ${where}`, ...params).rows[0];
    return {
      ...base, product_count: Number(totals?.n ?? 0), total_cents: String(totals?.t ?? "0"),
      items: rows.map((r) => ({
        product_id: (r.product_id as string | null) ?? null, name: r.product_id === null ? "Itens sem cadastro de produto" : String(r.name ?? "Produto"), code: (r.code as string | null) ?? null,
        unit: (r.unit as string | null) ?? null, quantity: formatScaled(fromColumn(r.q ?? "0"), 6), amount_cents: String(r.t ?? "0"), orders: Number(r.orders),
      })),
    };
  }
  const orders = tooMany(db.exec(
    `SELECT d.id, d.body ->> 'date' day, d.body ->> 'seller_id' seller, d.body ->> '$.commercial.seller_reference.label' seller_label, CAST(coalesce(d.total,0) AS TEXT) total
     FROM "erp_documents__document" d WHERE ${where} LIMIT ${SALES_CHART_LIMIT + 1}`,
    ...params,
  ).rows).map((r) => ({ day: String(r.day), seller: typeof r.seller === "string" ? r.seller.toLowerCase() : null, label: (r.seller_label as string | null) ?? null, total: BigInt(String(r.total)) }));
  const totalCents = orders.reduce((t, x) => t + x.total, 0n);
  if (report === "period") {
    return {
      ...base, total_cents: String(totalCents), order_count: orders.length,
      items: buckets.map((b) => {
        const inside = orders.filter((x) => x.day >= b.start_on && x.day <= b.end_on);
        return { ...b, orders: inside.length, amount_cents: String(inside.reduce((t, x) => t + x.total, 0n)) };
      }),
    };
  }
  const names = new Map(db.exec(`SELECT s.id, r.name FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id`).rows.map((r) => [String(r.id), String(r.name)]));
  const acc = new Map<string, { seller_id: string | null; name: string; orders: number; total: bigint }>();
  for (const x of orders) {
    const known = x.seller !== null && names.has(x.seller);
    const key = known ? x.seller! : x.label ? `label:${pgLower(x.label)}` : "none";
    const g = acc.get(key) ?? { seller_id: known ? x.seller : null, name: known ? names.get(x.seller!)! : x.label ? pgLeft(x.label, 80) : "Sem vendedor", orders: 0, total: 0n };
    g.orders++;
    g.total += x.total;
    acc.set(key, g);
  }
  const all = [...acc.values()].sort((x, y) => (y.total > x.total ? 1 : y.total < x.total ? -1 : pgCompareText(pgLower(x.name), pgLower(y.name))));
  return {
    ...base, total_cents: String(totalCents), order_count: orders.length, seller_count: all.length,
    items: all.slice(0, limit).map((g) => ({ seller_id: g.seller_id, name: g.name, orders: g.orders, amount_cents: String(g.total) })),
  };
}

registerRpc("erp_report_sales_chart", erpReportSalesChart);
