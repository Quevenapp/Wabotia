// Relatórios do Estoque: public.erp_stock_report_below_min, _balances_at,
// _transfers, _top, _product, _idle, _movements, _financial e _entry_notes;
// erp_stock.report_page, report_period, report_warehouse, report_balance,
// report_lines e report_product. Somas em BigInt (a sum() do SQLite estoura
// o i64 onde o numeric do Postgres não estoura).
import { exact, formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText } from "../../../engine/text.ts";
import { fold } from "../../catalog/public.ts";
import { averageCosts, costVisible, PRICE } from "../costs.ts";
import { QTY, requireAccess } from "../internal.ts";
import { priceText } from "../ledger.ts";
import { settingsDto } from "../read.ts";

const q6 = (v: bigint) => formatScaled(v, QTY);
const money = (v16: bigint) => rescale(v16, QTY + PRICE, 2);

/** erp_stock.report_page */
function reportPage(offset: number | null, limit: number | null) {
  if (offset === null || offset < 0 || offset > 100000 || limit === null || limit < 1 || limit > 500) raise("22023", "erp_stock_invalid_query");
}
/** erp_stock.report_warehouse */
function reportWarehouse(db: SqlDriver, warehouse: string | null) {
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
}
const days = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
/** erp_stock.report_period: até 3660 dias, entre 1900 e 2100. */
function reportPeriod(from: string | null, to: string | null) {
  if (from === null || to === null || from > to || from < "1900-01-01" || to > "2100-12-31" || days(to) - days(from) > 3660)
    raise("22023", "erp_stock_invalid_query");
}
const dayBefore = (d: string) => new Date((days(d) - 1) * 86400000).toISOString().slice(0, 10);

const IGNORED = `EXISTS(SELECT 1 FROM "erp_stock__warehouse_setting" s WHERE s.warehouse_id=b.warehouse_id AND s.ignore_balance=1)`;
/** Saldo por produto no depósito, ou nos considerados (soma ≠ 0 quando nonzero). */
function stockByProduct(db: SqlDriver, warehouse: string | null, nonzero: boolean): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of db.exec(
    `SELECT b.product_id, CAST(b.quantity AS TEXT) q FROM "erp_stock__balance" b WHERE b.warehouse_id=? OR (? IS NULL AND NOT ${IGNORED})`,
    warehouse,
    warehouse,
  ).rows)
    out.set(String(b.product_id), (out.get(String(b.product_id)) ?? 0n) + fromColumn(b.q));
  if (nonzero) for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}

interface Line {
  movement: string;
  product: string;
  on: string;
  quantity: bigint;
  balance: boolean;
}
/** erp_stock.report_lines(p_warehouse, p_from, p_to, p_product): por lançamento e produto, soma ≠ 0. */
function reportLines(db: SqlDriver, warehouse: string | null, from: string | null, to: string | null, product: string | null = null): Line[] {
  const rows = db.exec(
    `SELECT e.movement_id, e.product_id, m.occurred_on, CAST(e.quantity AS TEXT) q,
       EXISTS(SELECT 1 FROM "erp_stock__balance_count" c WHERE c.movement_id=e.movement_id) bal
     FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
     WHERE ((? IS NULL AND NOT EXISTS(SELECT 1 FROM "erp_stock__warehouse_setting" s WHERE s.warehouse_id=e.warehouse_id AND s.ignore_balance=1)) OR e.warehouse_id=?)
      AND (? IS NULL OR m.occurred_on>=?) AND (? IS NULL OR m.occurred_on<=?) AND (? IS NULL OR e.product_id=?)`,
    warehouse, warehouse, from, from, to, to, product, product,
  ).rows;
  const groups = new Map<string, Line>();
  for (const r of rows) {
    const key = r.movement_id + "|" + r.product_id;
    const g = groups.get(key);
    if (g) g.quantity += fromColumn(r.q);
    else groups.set(key, { movement: String(r.movement_id), product: String(r.product_id), on: String(r.occurred_on), quantity: fromColumn(r.q), balance: r.bal === 1 });
  }
  return [...groups.values()].filter((l) => l.quantity !== 0n);
}

/** Nome, código e unidade dos produtos (com o fold do nome para a ordem). */
function products(db: SqlDriver, ids: Iterable<string>) {
  const out = new Map<string, { code: unknown; name: string; unit: unknown; fold: string; kind: unknown; active: boolean; stock_min: bigint | null; stock_max: bigint | null; price: bigint | null }>();
  for (const id of ids) {
    const r = one(
      db,
      `SELECT r.code, r.name, r.name__fold f, r.active, p.unit, p.kind, CAST(p.stock_min AS TEXT) smin, CAST(p.stock_max AS TEXT) smax, p.price
       FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?`,
      id,
    );
    if (r)
      out.set(id, {
        code: r.code, name: String(r.name), unit: r.unit, fold: String(r.f ?? fold(String(r.name))), kind: r.kind, active: r.active === 1,
        stock_min: r.smin === null ? null : fromColumn(r.smin), stock_max: r.smax === null ? null : fromColumn(r.smax),
        price: r.price === null ? null : toScaled(String(r.price), PRICE),
      });
  }
  return out;
}
const byName = <T extends { fold: string; product_id: string }>(a: T, b: T) => pgCompareText(a.fold, b.fold) || pgCompareText(a.product_id, b.product_id);
/** erp_stock.report_product(p_id) */
const reportProduct = (id: string, p: { code: unknown; name: string; unit: unknown } | undefined) =>
  p ? { product_id: id, code: p.code, name: p.name, unit: p.unit } : null;
const page = <T>(rows: T[], offset: number, limit: number) => rows.slice(offset, offset + limit);
const args = (a: RpcArgs) => ({
  user: a.p_user_id as string,
  warehouse: (a.p_warehouse_id as string | null) ?? null,
  offset: a.p_offset as number | null,
  limit: a.p_limit as number | null,
});

registerRpc("erp_stock_report_below_min", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a);
  requireAccess(db, user, false);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  const ids = db
    .exec(`SELECT r.id FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE p.kind='P' AND r.active=1 AND p.stock_min IS NOT NULL`)
    .rows.map((r) => String(r.id));
  const info = products(db, ids);
  const balance = (id: string) =>
    db
      .exec(`SELECT CAST(b.quantity AS TEXT) q FROM "erp_stock__balance" b WHERE b.product_id=? AND (b.warehouse_id=? OR (? IS NULL AND NOT ${IGNORED}))`, id, warehouse, warehouse)
      .rows.reduce((t, b) => t + fromColumn(b.q), 0n);
  const below = ids
    .map((id) => ({ product_id: id, ...info.get(id)!, quantity: balance(id) }))
    .filter((r) => r.quantity < r.stock_min!)
    .sort(byName);
  return {
    scope: "stock_report_below_min", data_mode: "erp_native", filters: { warehouse_id: warehouse }, offset, limit, total: below.length,
    items: page(below, offset!, limit!).map((r) => ({
      product_id: r.product_id, code: r.code, name: r.name, unit: r.unit, stock_min: q6(r.stock_min!), stock_max: r.stock_max === null ? null : q6(r.stock_max),
      quantity: q6(r.quantity), missing: q6(r.stock_min! - r.quantity),
    })),
  };
});

registerRpc("erp_stock_report_balances_at", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a),
    date = a.p_date as string | null;
  requireAccess(db, user, false);
  reportPeriod(date, date);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  const sums = new Map<string, bigint>();
  for (const l of reportLines(db, warehouse, null, date)) sums.set(l.product, (sums.get(l.product) ?? 0n) + l.quantity);
  const info = products(db, sums.keys());
  const rows = [...sums].filter(([id, q]) => q !== 0n && info.has(id)).map(([id, q]) => ({ product_id: id, ...info.get(id)!, quantity: q })).sort(byName);
  return {
    scope: "stock_report_balances_at", data_mode: "erp_native", filters: { date, warehouse_id: warehouse }, offset, limit, total: rows.length,
    items: page(rows, offset!, limit!).map((r) => ({ product_id: r.product_id, code: r.code, name: r.name, unit: r.unit, quantity: q6(r.quantity) })),
    totals: { quantity: q6(rows.reduce((t, r) => t + r.quantity, 0n)) },
  };
});

registerRpc("erp_stock_report_transfers", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a),
    from = a.p_date_from as string | null,
    to = a.p_date_to as string | null;
  requireAccess(db, user, false);
  reportPeriod(from, to);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  const rows = db.exec(
    `SELECT m.id, m.occurred_on, m.created_at, m.reason, o.product_id, CAST(-o.quantity AS TEXT) q, o.warehouse_id source_id, i.warehouse_id destination_id,
       EXISTS(SELECT 1 FROM "erp_stock__movement" x WHERE x.reverses_id=m.id) reversed
     FROM "erp_stock__movement" m JOIN "erp_stock__entry" o ON o.movement_id=m.id AND o.quantity<0
     JOIN "erp_stock__entry" i ON i.movement_id=m.id AND i.quantity>0 AND i.product_id=o.product_id
     WHERE m.kind='transfer' AND m.occurred_on BETWEEN ? AND ? AND (? IS NULL OR ? IN (o.warehouse_id, i.warehouse_id))
     ORDER BY m.occurred_on DESC, m.created_at DESC, m.id`,
    from, to, warehouse, warehouse,
  ).rows;
  const info = products(db, new Set(rows.map((r) => String(r.product_id))));
  const name = (id: unknown) => (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name as string | undefined) ?? null;
  return {
    scope: "stock_report_transfers", data_mode: "erp_native", filters: { date_from: from, date_to: to, warehouse_id: warehouse }, offset, limit, total: rows.length,
    items: page(rows, offset!, limit!).map((p) => ({
      ...reportProduct(String(p.product_id), info.get(String(p.product_id))),
      movement_id: p.id, occurred_on: p.occurred_on, quantity: q6(fromColumn(p.q)), source_id: p.source_id, source_name: name(p.source_id),
      destination_id: p.destination_id, destination_name: name(p.destination_id),
      note: (one(db, 'SELECT note FROM "erp_stock__movement_detail" WHERE movement_id=? AND product_id=? ORDER BY revision DESC LIMIT 1', p.id, p.product_id)?.note as string | undefined) ?? p.reason,
      reversed: p.reversed === 1,
    })),
  };
});

registerRpc("erp_stock_report_top", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, limit } = args(a),
    from = a.p_date_from as string | null,
    to = a.p_date_to as string | null;
  requireAccess(db, user, false);
  reportPeriod(from, to);
  reportPage(0, limit);
  reportWarehouse(db, warehouse);
  const agg = new Map<string, { entries: bigint; exits: bigint; moved: bigint; launches: number }>();
  for (const l of reportLines(db, warehouse, from, to).filter((l) => !l.balance)) {
    const g = agg.get(l.product) ?? { entries: 0n, exits: 0n, moved: 0n, launches: 0 };
    if (l.quantity > 0n) g.entries += l.quantity;
    else g.exits += -l.quantity;
    g.moved += l.quantity < 0n ? -l.quantity : l.quantity;
    g.launches++;
    agg.set(l.product, g);
  }
  const info = products(db, agg.keys());
  const rows = [...agg]
    .filter(([id]) => info.has(id))
    .map(([id, g]) => ({ product_id: id, ...info.get(id)!, ...g }))
    .sort((x, y) => (x.moved === y.moved ? byName(x, y) : x.moved > y.moved ? -1 : 1));
  return {
    scope: "stock_report_top", data_mode: "erp_native", filters: { date_from: from, date_to: to, warehouse_id: warehouse }, limit, total: agg.size,
    items: rows.slice(0, limit!).map((p) => ({ ...reportProduct(p.product_id, p), entries: q6(p.entries), exits: q6(p.exits), moved: q6(p.moved), launches: p.launches })),
  };
});

registerRpc("erp_stock_report_product", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse } = args(a),
    product = a.p_product_id as string | null,
    from = a.p_date_from as string | null,
    to = a.p_date_to as string | null;
  requireAccess(db, user, false);
  reportPeriod(from, to);
  reportWarehouse(db, warehouse);
  if (product === null || !one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', product)) raise("P0002", "erp_stock_product_not_found");
  const opening = reportLines(db, warehouse, null, dayBefore(from!), product).reduce((t, l) => t + l.quantity, 0n);
  const byDay = new Map<string, { entries: bigint; exits: bigint; net: bigint }>();
  for (const l of reportLines(db, warehouse, from, to, product)) {
    const d = byDay.get(l.on) ?? { entries: 0n, exits: 0n, net: 0n };
    if (l.quantity > 0n) d.entries += l.quantity;
    else d.exits += -l.quantity;
    d.net += l.quantity;
    byDay.set(l.on, d);
  }
  let balance = opening;
  const daysOut = [...byDay].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([on, d]) => {
    balance += d.net;
    return { date: on, entries: q6(d.entries), exits: q6(d.exits), balance: q6(balance) };
  });
  const sum = (k: "entries" | "exits" | "net") => [...byDay.values()].reduce((t, d) => t + d[k], 0n);
  return {
    scope: "stock_report_product", data_mode: "erp_native", product: reportProduct(product!, products(db, [product!]).get(product!)),
    filters: { product_id: product, date_from: from, date_to: to, warehouse_id: warehouse },
    opening: q6(opening), days: daysOut, closing: q6(opening + sum("net")), totals: { entries: q6(sum("entries")), exits: q6(sum("exits")) },
  };
});

registerRpc("erp_stock_report_idle", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a),
    since = a.p_since as string | null;
  requireAccess(db, user, false);
  reportPeriod(since, since);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  const stock = stockByProduct(db, warehouse, true);
  const last = new Map<string, string>();
  for (const l of reportLines(db, warehouse, null, null)) if (stock.has(l.product) && (!last.has(l.product) || l.on > last.get(l.product)!)) last.set(l.product, l.on);
  const info = products(db, stock.keys());
  const rows = [...stock]
    .filter(([id]) => info.get(id)?.kind === "P" && (!last.has(id) || last.get(id)! < since!))
    .map(([id, q]) => ({ product_id: id, ...info.get(id)!, quantity: q, last_movement: last.get(id) ?? null }))
    .sort((x, y) => (x.last_movement === y.last_movement ? byName(x, y) : x.last_movement === null ? -1 : y.last_movement === null ? 1 : x.last_movement < y.last_movement ? -1 : 1));
  return {
    scope: "stock_report_idle", data_mode: "erp_native", filters: { since, warehouse_id: warehouse }, offset, limit, total: rows.length,
    items: page(rows, offset!, limit!).map((r) => ({ product_id: r.product_id, code: r.code, name: r.name, unit: r.unit, quantity: q6(r.quantity), last_movement: r.last_movement })),
  };
});

registerRpc("erp_stock_report_movements", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a),
    product = a.p_product_id as string | null,
    from = a.p_date_from as string | null,
    to = a.p_date_to as string | null;
  requireAccess(db, user, false);
  reportPeriod(from, to);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  if (product !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', product)) raise("P0002", "erp_stock_product_not_found");
  const agg = new Map<string, { entries: bigint; exits: bigint; balances: bigint; launches: number }>();
  for (const l of reportLines(db, warehouse, from, to, product)) {
    const g = agg.get(l.product) ?? { entries: 0n, exits: 0n, balances: 0n, launches: 0 };
    if (l.balance) g.balances += l.quantity;
    else if (l.quantity > 0n) g.entries += l.quantity;
    else g.exits += -l.quantity;
    g.launches++;
    agg.set(l.product, g);
  }
  const info = products(db, agg.keys());
  const rows = [...agg].filter(([id]) => info.has(id)).map(([id, g]) => ({ product_id: id, ...info.get(id)!, ...g })).sort(byName);
  const total = (k: "entries" | "exits" | "balances") => rows.reduce((t, r) => t + r[k], 0n);
  return {
    scope: "stock_report_movements", data_mode: "erp_native", filters: { date_from: from, date_to: to, warehouse_id: warehouse, product_id: product },
    offset, limit, total: rows.length,
    items: page(rows, offset!, limit!).map((r) => ({
      product_id: r.product_id, code: r.code, name: r.name, unit: r.unit, entries: q6(r.entries), exits: q6(r.exits), balances: q6(r.balances),
      net: q6(r.entries - r.exits + r.balances), launches: r.launches,
    })),
    totals: { entries: q6(total("entries")), exits: q6(total("exits")), balances: q6(total("balances")), net: q6(total("entries") - total("exits") + total("balances")) },
  };
});

registerRpc("erp_stock_report_financial", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db,
    { user, warehouse, offset, limit } = args(a);
  requireAccess(db, user, false);
  reportPage(offset, limit);
  reportWarehouse(db, warehouse);
  if (!costVisible(db, user)) raise("42501", "erp_stock_access_denied");
  const stock = stockByProduct(db, warehouse, true);
  const costs = averageCosts(db, [...stock.keys()]);
  const info = products(db, stock.keys());
  const rows = [...stock]
    .filter(([id]) => info.get(id)?.kind === "P")
    .map(([id, q]) => {
      const p = info.get(id)!,
        avg = costs.get(id) ?? null;
      return {
        product_id: id, ...p, quantity: q, average_cost: avg,
        cost_value: avg === null ? null : money(q * avg),
        sale_value: p.price === null ? null : money(q * p.price),
      };
    })
    .sort(byName);
  const c2 = (v: bigint | null) => (v === null ? null : formatScaled(v, 2));
  const both = rows.filter((r) => r.cost_value !== null && r.sale_value !== null);
  return {
    scope: "stock_report_financial", data_mode: "erp_native", filters: { warehouse_id: warehouse }, cost_basis: settingsDto(db).average_cost_base,
    offset, limit, total: rows.length,
    items: page(rows, offset!, limit!).map((r) => ({
      product_id: r.product_id, code: r.code, name: r.name, unit: r.unit, quantity: q6(r.quantity), average_cost: priceText(r.average_cost),
      cost_value: c2(r.cost_value), sale_price: priceText(r.price), sale_value: c2(r.sale_value),
      margin: r.cost_value !== null && r.sale_value !== null ? c2(r.sale_value - r.cost_value) : null,
    })),
    totals: {
      quantity: q6(rows.reduce((t, r) => t + r.quantity, 0n)),
      cost_value: c2(rows.reduce((t, r) => t + (r.cost_value ?? 0n), 0n)),
      sale_value: c2(rows.reduce((t, r) => t + (r.sale_value ?? 0n), 0n)),
      margin: c2(both.reduce((t, r) => t + r.sale_value! - r.cost_value!, 0n)),
      uncosted: rows.filter((r) => r.cost_value === null).length,
      unpriced: rows.filter((r) => r.sale_value === null).length,
    },
  };
});

registerRpc("erp_stock_report_entry_notes", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', a.p_user_id)?.role as string | undefined) ?? null;
  if (role === null || !["admin", "fiscal"].includes(role)) raise("42501", "erp_stock_access_denied");
  const from = a.p_date_from as string | null,
    to = a.p_date_to as string | null,
    group = a.p_group as string | null;
  reportPeriod(from, to);
  if (group === null || !["nature", "supplier", "product", "month"].includes(group)) raise("22023", "erp_stock_invalid_query");
  const notes = db
    .exec(
      `SELECT id, nature_description, recipient, issue_date, totals FROM "erp_fiscal_invoices__invoice"
       WHERE direction='0' AND deleted_at IS NULL AND status NOT IN (3,10) AND issue_date BETWEEN ? AND ?`,
      from, to,
    )
    .rows.map((n) => {
      const recipient = n.recipient === null ? null : (JSON.parse(String(n.recipient)) as Record<string, unknown> | null);
      const totals = n.totals === null ? null : (JSON.parse(String(n.totals)) as Record<string, unknown> | null);
      const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
      const t = text(totals?.total);
      return { id: String(n.id), nature: n.nature_description as string | null, supplier: text(recipient?.name), document: text(recipient?.document), issue: String(n.issue_date), total: t === null ? null : exact(t) };
    });
  // Valores exatos (escala 30): soma; saída arredondada (numeric(38,2) / (38,4)).
  type Row = { key: string | null; label: string | null; code: string | null; notes: number; quantity: bigint | null; value: bigint | null };
  const sumOf = (xs: (bigint | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<bigint>((t, x) => t + (x ?? 0n), 0n) : null);
  const groupBy = <T>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, { key: string | null; items: T[] }>();
    for (const x of xs) {
      const k = key(x);
      const id = k === null ? "\u0000null" : "v" + k;
      (m.get(id) ?? m.set(id, { key: k, items: [] }).get(id)!).items.push(x);
    }
    return [...m.values()];
  };
  const minText = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null).sort(pgCompareText)[0] ?? null;
  let rows: Row[] = [];
  if (group === "nature")
    rows = groupBy(notes, (n) => n.nature).map((g) => ({ key: g.key, label: g.key, code: null, notes: g.items.length, quantity: null, value: sumOf(g.items.map((n) => n.total)) }));
  if (group === "supplier")
    rows = groupBy(notes, (n) => n.document ?? (n.supplier !== null ? "nome:" + n.supplier : "sem-fornecedor")).map((g) => ({
      key: g.key, label: minText(g.items.map((n) => n.supplier)) ?? "Sem fornecedor", code: minText(g.items.map((n) => n.document)),
      notes: g.items.length, quantity: null, value: sumOf(g.items.map((n) => n.total)),
    }));
  if (group === "product") {
    const ids = new Set(notes.map((n) => n.id));
    const items = notes.length
      ? db
          .exec(
            `SELECT i.invoice_id, i.product_id, i.data, CAST(i.quantity AS TEXT) q, CAST(i.total AS TEXT) t, r.name, r.code
             FROM "erp_fiscal_invoices__invoice_item" i LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id WHERE i.invoice_id IN (SELECT value FROM json_each(?))`,
            JSON.stringify([...ids]),
          )
          .rows.map((i) => {
            const data = i.data === null ? null : (JSON.parse(String(i.data)) as Record<string, unknown> | null);
            const desc = data?.description === undefined || data?.description === null ? null : String(data.description);
            const trimmed = desc === null ? null : pgBtrim(desc);
            return {
              key: i.product_id !== null ? String(i.product_id) : "item:" + (desc ?? ""),
              label: (i.name as string | null) ?? (trimmed === "" ? null : trimmed) ?? "Item sem descrição",
              code: i.code as string | null, invoice: String(i.invoice_id),
              quantity: i.q === null ? null : rescale(fromColumn(i.q), 4, 30), total: i.t === null ? null : rescale(fromColumn(i.t), 2, 30),
            };
          })
      : [];
    rows = groupBy(items, (i) => i.key).map((g) => ({
      key: g.key, label: minText(g.items.map((i) => i.label)), code: minText(g.items.map((i) => i.code)),
      notes: new Set(g.items.map((i) => i.invoice)).size, quantity: sumOf(g.items.map((i) => i.quantity)), value: sumOf(g.items.map((i) => i.total)),
    }));
  }
  if (group === "month")
    rows = groupBy(notes, (n) => n.issue.slice(0, 7)).map((g) => ({
      key: g.key, label: `${g.key!.slice(5, 7)}/${g.key!.slice(0, 4)}`, code: null, notes: g.items.length, quantity: null, value: sumOf(g.items.map((n) => n.total)),
    }));
  const order = (x: Row, y: Row) => {
    if (group === "month") {
      const c = pgCompareText(x.key, y.key);
      if (c) return c;
    }
    // value desc: nulos primeiro (DESC do Postgres põe NULL na frente).
    if (x.value !== y.value) {
      if (x.value === null) return -1;
      if (y.value === null) return 1;
      return x.value > y.value ? -1 : 1;
    }
    return pgCompareText(x.label === null ? null : fold(x.label), y.label === null ? null : fold(y.label)) || pgCompareText(x.key, y.key);
  };
  rows.sort(order);
  const totalValue = notes.reduce((t, n) => t + (n.total ?? 0n), 0n);
  return {
    scope: "stock_report_entry_notes", data_mode: "erp_native", filters: { date_from: from, date_to: to, group }, total: rows.length,
    items: rows.slice(0, 2000).map((r) => ({
      key: r.key, label: r.label, code: r.code, notes: r.notes,
      quantity: r.quantity === null ? null : formatScaled(rescale(r.quantity, 30, 4), 4),
      value: r.value === null ? null : formatScaled(rescale(r.value, 30, 2), 2),
    })),
    totals: { notes: notes.length, value: formatScaled(rescale(totalValue, 30, 2), 2) },
  };
});
