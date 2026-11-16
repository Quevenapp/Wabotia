// public.erp_stock_ledger (extrato do produto), erp_stock_launch_context
// (preço e custo sugeridos no lançamento) e erp_stock_suppliers.
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { fold } from "../../catalog/public.ts";
import { averageCosts, PRICE } from "../costs.ts";
import { ignoredWarehouse } from "../home.ts";
import { QTY, requireAccess } from "../internal.ts";
import { defaultSupplier, entryDecimals, lastPurchase, ledgerOriginType, ledgerRow105, priceText } from "../ledger.ts";
import { settingsDto } from "../read.ts";

const KINDS = ["receipt", "issue", "adjustment", "transfer", "reversal"];
const ORIGINS = ["sales", "purchases", "services", "transfers", "none", "invoices", "deleted"];
const DIRECTIONS = ["entry", "exit", "balance"];
const inRange = (d: string | null) => d === null || (d >= "1900-01-01" && d <= "2100-12-31");

registerRpc("erp_stock_ledger", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, false);
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
  const product = a.p_product_id as string | null,
    warehouse = a.p_warehouse_id as string | null,
    limit = a.p_limit as number | null,
    offset = a.p_offset as number | null,
    kind = a.p_kind as string | null,
    origin = a.p_origin as string | null,
    direction = a.p_direction as string | null,
    from = a.p_date_from as string | null,
    to = a.p_date_to as string | null;
  if (
    product === null || limit === null || limit < 1 || limit > 100 || offset === null || offset < 0 || offset > 100000 ||
    (kind !== null && !KINDS.includes(kind)) || (origin !== null && !ORIGINS.includes(origin)) || (direction !== null && !DIRECTIONS.includes(direction)) ||
    !inRange(from) || !inRange(to) || (from !== null && to !== null && from > to)
  )
    raise("22023", "erp_stock_invalid_query");
  const p = one(db, 'SELECT unit FROM "erp_catalog__product" WHERE record_id=?', product);
  if (!p) raise("P0002", "erp_stock_product_not_found");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  const entries = (movement: string) =>
    db.exec(
      'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__entry" WHERE movement_id=? AND product_id=? AND (? IS NULL OR warehouse_id=?)',
      movement, product, warehouse, warehouse,
    ).rows.map((e) => fromColumn(e.q));
  const filtered = db
    .exec(
      `SELECT m.id, m.occurred_on, m.created_at, EXISTS(SELECT 1 FROM "erp_stock__balance_count" c WHERE c.movement_id=m.id) is_balance
       FROM (SELECT DISTINCT e.movement_id FROM "erp_stock__entry" e WHERE e.product_id=? AND (? IS NULL OR e.warehouse_id=?)) x
       JOIN "erp_stock__movement" m ON m.id=x.movement_id
       WHERE (? IS NULL OR m.kind=?) AND (? IS NULL OR m.occurred_on>=?) AND (? IS NULL OR m.occurred_on<=?)
       ORDER BY m.occurred_on DESC, m.created_at DESC, m.id DESC`,
      product, warehouse, warehouse, kind, kind, from, from, to, to,
    )
    .rows.filter((s) => {
      if (origin !== null && ledgerOriginType(db, String(s.id)) !== origin) return false;
      if (direction === null) return true;
      if (direction === "balance") return s.is_balance === 1;
      return s.is_balance !== 1 && entries(String(s.id)).some((q) => (direction === "entry" ? q > 0n : q < 0n));
    });
  let ins = 0n,
    outs = 0n;
  for (const s of filtered)
    if (s.is_balance !== 1)
      for (const q of entries(String(s.id))) {
        if (q > 0n) ins += q;
        if (q < 0n) outs += -q;
      }
  const current = db
    .exec('SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product)
    .rows.filter((b) => (warehouse !== null ? b.warehouse_id === warehouse : !ignoredWarehouse(db, String(b.warehouse_id))))
    .reduce((t, b) => t + fromColumn(b.q), 0n);
  const total = filtered.length;
  return {
    product_id: product,
    items: filtered.slice(offset, offset + limit).map((s) => ledgerRow105(db, String(s.id), product, role)),
    limit,
    offset,
    total,
    has_more: total > offset + limit,
    next_offset: total > offset + limit ? offset + limit : null,
    filters: { warehouse_id: warehouse, kind, origin, date_from: from, date_to: to, direction },
    totals: { entries: formatScaled(ins, QTY), exits: formatScaled(outs, QTY), current_balance: formatScaled(current, QTY), unit: p.unit },
    data_mode: "erp_native",
  };
});

registerRpc("erp_stock_launch_context", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, true);
  const product = a.p_product_id as string | null;
  if (product === null) raise("22023", "erp_stock_invalid_query");
  const p = one(db, 'SELECT price FROM "erp_catalog__product" WHERE record_id=?', product);
  if (!p) raise("P0002", "erp_stock_product_not_found");
  const s = settingsDto(db);
  const last = s.price_type === "ultima_compra" ? lastPurchase(db, product, s.consider_balances) : null;
  const avg = averageCosts(db, [product]).get(product) ?? null;
  const supplier = defaultSupplier(db, product);
  return {
    scope: "stock_launch_context",
    data_mode: "erp_native",
    product_id: product,
    settings: { show_unit_price: s.show_unit_price, price_type: s.price_type, consider_balances: s.consider_balances, average_cost_base: s.average_cost_base },
    last_purchase: last
      ? { unit_price: priceText(last.unit_price), unit_cost: priceText(last.unit_cost), occurred_on: last.occurred_on, movement_id: last.movement_id, source: last.source }
      : null,
    average_cost: priceText(avg),
    sale_price: priceText(p.price === null ? null : toScaled(String(p.price), PRICE)),
    price_decimals: { entry: entryDecimals(db) },
    default_supplier: supplier
      ? {
          supplier_id: supplier.supplier_id,
          supplier_name: supplier.supplier_name,
          code: supplier.code,
          purchase_price: priceText(supplier.purchase_price),
          cost_price: priceText(supplier.cost_price),
        }
      : null,
  };
});

registerRpc("erp_stock_suppliers", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const query = a.p_query as string | null;
  if (query !== null && (pgLength(query) > 120 || pgHasCntrl.test(query))) raise("22023", "erp_stock_invalid_query");
  const folded = query === null ? null : fold(pgBtrim(query));
  const q = folded === "" ? null : folded;
  const where = `FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id
    WHERE ((r.active=1 AND EXISTS(SELECT 1 FROM json_each(c.roles) WHERE value='supplier')) OR EXISTS(SELECT 1 FROM "erp_catalog__product_supplier" s WHERE s.supplier_id=r.id))
     AND (? IS NULL OR instr(r.name__fold, ?)>0 OR instr(coalesce(r.code__fold, ''), ?)>0)`;
  const rows = db
    .exec(
      `SELECT r.id, r.name, r.code, r.active, (SELECT count(*) FROM "erp_catalog__product_supplier" s WHERE s.supplier_id=r.id) products ${where} ORDER BY r.name__fold, r.id LIMIT 50`,
      q, q, q,
    )
    .rows;
  return {
    scope: "stock_suppliers",
    data_mode: "erp_native",
    query,
    total: Number(one(db, `SELECT count(*) n ${where}`, q, q, q)!.n),
    items: rows.map((r) => ({ id: r.id, name: r.name, code: r.code, active: r.active === 1, products: Number(r.products) })),
  };
});
