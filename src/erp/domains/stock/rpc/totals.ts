// public.erp_stock_totals: quantidade, valor de venda e valor de custo do
// estoque (de um depósito, ou de todos os considerados), e o seletor de
// depósitos do extrato.
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { averageCosts, costVisible, PRICE } from "../costs.ts";
import { ignoredWarehouse } from "../home.ts";
import { QTY, requireAccess } from "../internal.ts";
import { settingsDto } from "../read.ts";

registerRpc("erp_stock_totals", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string,
    warehouse = a.p_warehouse_id as string | null;
  requireAccess(db, user, false);
  const cost = costVisible(db, user);
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  const scoped = db
    .exec(
      `SELECT b.product_id, b.warehouse_id, CAST(b.quantity AS TEXT) q, p.price FROM "erp_stock__balance" b JOIN "erp_catalog__product" p ON p.record_id=b.product_id
       WHERE b.warehouse_id=? OR ? IS NULL`,
      warehouse,
      warehouse,
    )
    .rows.filter((r) => warehouse !== null || !ignoredWarehouse(db, String(r.warehouse_id)))
    .map((r) => ({ product: String(r.product_id), q: fromColumn(r.q), price: r.price === null ? null : toScaled(String(r.price), PRICE) }));
  const costs = cost ? averageCosts(db, [...new Set(scoped.map((s) => s.product))]) : new Map<string, bigint | null>();
  const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, 0n);
  // quantidade (escala 6) × preço/custo (escala 10) = escala 16; round(…, 2).
  const money = (v: bigint) => formatScaled(rescale(v, QTY + PRICE, 2), 2);
  const priced = scoped.filter((s) => s.price !== null);
  const costed = scoped.filter((s) => (costs.get(s.product) ?? null) !== null);
  const def = (one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1')?.warehouse_id as string | null) ?? null;
  return {
    warehouse_id: warehouse,
    quantity: formatScaled(sum(scoped.map((s) => s.q)), QTY),
    sale_value: priced.length ? money(sum(priced.map((s) => s.q * s.price!))) : "0.00",
    unpriced_products: new Set(scoped.filter((s) => s.price === null && s.q !== 0n).map((s) => s.product)).size,
    cost_visible: cost,
    cost_value: cost ? (costed.length ? money(sum(costed.map((s) => s.q * costs.get(s.product)!))) : "0.00") : null,
    uncosted_products: cost ? new Set(scoped.filter((s) => (costs.get(s.product) ?? null) === null && s.q !== 0n).map((s) => s.product)).size : null,
    cost_basis: settingsDto(db).average_cost_base,
    ignored_warehouses: Number(one(db, 'SELECT count(*) n FROM "erp_stock__warehouse_setting" WHERE ignore_balance=1')!.n),
    warehouses: db
      .exec(
        `SELECT r.id, r.name, r.active FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" w ON w.record_id=r.id ORDER BY r.name__fold, r.id`,
      )
      .rows.map((r) => ({ id: r.id, name: r.name, active: r.active === 1, is_default: def === r.id, ignore_balance: ignoredWarehouse(db, String(r.id)) })),
    scope: "stock_totals",
    data_mode: "erp_native",
  };
});
