// Saldos e posições: public.erp_stock_balances, erp_stock_positions,
// erp_stock_availability e erp_stock_movements; erp_stock.availability.
// A busca de texto do erp_stock_positions usa lower() do Postgres (pgLower):
// o lower() do SQLite só conhece ASCII, então o filtro é em TS.
import { fromColumn, formatScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { ignoredWarehouse } from "../home.ts";
import { QTY, movementDto, requireAccess, reservedQuantity } from "../internal.ts";
import {
  COMPOSITION_CURRENT, q6to30, reservationPositionHash, settingsDto, situationReservations, text6, virtualQuantity,
} from "../read.ts";

const q6 = (v: bigint) => formatScaled(v, QTY);

registerRpc("erp_stock_balances", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const product = a.p_product_id as string | null,
    warehouse = a.p_warehouse_id as string | null;
  const p = product === null ? null : one(db, 'SELECT unit, format FROM "erp_catalog__product" WHERE record_id=?', product);
  if (!p) raise("P0002", "erp_stock_product_not_found");
  const s = settingsDto(db);
  const virtual =
    !!one(db, `SELECT 1 x FROM "erp_stock__composition" c WHERE c.product_id=? AND c.stock_type='virtual'`, product) &&
    p.format === "E" &&
    !!one(db, `SELECT 1 x FROM ${COMPOSITION_CURRENT} WHERE product_id=?`, product);
  const situation = situationReservations(db, product);
  const inWarehouse = (w: string | null) => situation.filter((x) => x.warehouse_id === w).reduce((t, x) => t + x.quantity, 0n);
  const def = (one(db, 'SELECT warehouse_id FROM "erp_stock__warehouse_default" WHERE singleton=1')?.warehouse_id as string | null) ?? null;
  const warehouses = db.exec(
    `SELECT w.record_id id, r.name, r.active, CAST(b.quantity AS TEXT) q, b.version FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id
     LEFT JOIN "erp_stock__balance" b ON b.product_id=? AND b.warehouse_id=w.record_id WHERE ? IS NULL OR w.record_id=? ORDER BY w.record_id`,
    product, warehouse, warehouse,
  ).rows;
  return {
    product_id: product,
    items: warehouses.map((w) => {
      const id = String(w.id);
      const sit = inWarehouse(id);
      const quantity = virtual ? q6to30((virtualQuantity(db, product!, id) ?? 0n) * 10n ** BigInt(QTY)) : q6to30(fromColumn(w.q ?? 0));
      return {
        warehouse_id: id,
        warehouse_name: w.name,
        warehouse_active: w.active === 1,
        quantity: text6(quantity),
        version: virtual ? 0 : w.version === null ? 0 : Number(w.version),
        unit: p.unit,
        warehouse_default: def === id,
        warehouse_ignored: ignoredWarehouse(db, id),
        reserved_quantity: text6(q6to30(reservedQuantity(db, product!, id)) + sit),
        situation_reserved_quantity: text6(sit),
        ...(virtual ? { virtual: true } : {}),
      };
    }),
    reservation: {
      by_situation: s.reserve_by_situation,
      by_warehouse: s.reserve_by_warehouse,
      statuses: s.reserve_statuses,
      unassigned_quantity: text6(inWarehouse(null)),
    },
    data_mode: "erp_native",
  };
});

/** erp_stock.availability(p_product, p_warehouse) */
export function availability(db: SqlDriver, product: string, warehouse: string) {
  const p = one(db, 'SELECT unit, kind FROM "erp_catalog__product" WHERE record_id=?', product);
  if (!p) raise("P0002", "erp_stock_product_not_found");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version, unit FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
  const last = one(
    db,
    'SELECT movement_id, balance_version, CAST(balance_after AS TEXT) after, unit FROM "erp_stock__entry" WHERE product_id=? AND warehouse_id=? ORDER BY balance_version DESC LIMIT 1',
    product,
    warehouse,
  );
  const q = reservedQuantity(db, product, warehouse);
  const qty = b ? fromColumn(b.q) : null;
  const state =
    !b && !last && q === 0n
      ? "no_movements"
      : b && Number(b.version) > 0 && p.kind === "P" && p.unit !== null && b.unit === p.unit && last &&
          Number(last.balance_version) === Number(b.version) && fromColumn(last.after) === qty && last.unit === b.unit && (q === 0n || qty! >= q)
        ? "recorded"
        : "review_required";
  return {
    product_id: product,
    warehouse_id: warehouse,
    unit: p.unit,
    state,
    physical_version: b ? Number(b.version) : 0,
    physical_quantity: state === "recorded" ? q6(qty!) : null,
    reserved_quantity: q6(q),
    available_quantity: state === "recorded" ? q6(qty! - q) : null,
    reservation_hash: reservationPositionHash(db, product, warehouse),
  };
}

registerRpc("erp_stock_availability", (ctx: RpcContext, a: RpcArgs) => {
  requireAccess(ctx.db, a.p_user_id as string, false);
  const product = a.p_product_id as string | null,
    warehouse = a.p_warehouse_id as string | null;
  if (product === null || warehouse === null) raise("22023", "erp_stock_invalid_query");
  return { position: availability(ctx.db, product, warehouse), data_mode: "erp_native", scope: "stock_availability" };
});

registerRpc("erp_stock_movements", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const product = a.p_product_id as string | null,
    limit = a.p_limit as number | null,
    after = a.p_after as string | null;
  if (product === null || limit === null || limit < 1 || limit > 100) raise("22023", "erp_stock_invalid_query");
  const ids = db.exec(
    `SELECT DISTINCT m.id FROM "erp_stock__movement" m JOIN "erp_stock__entry" e ON e.movement_id=m.id WHERE e.product_id=? AND (? IS NULL OR m.id>?) ORDER BY m.id LIMIT ?`,
    product, after, after, limit + 1,
  ).rows;
  const page = ids.slice(0, limit);
  const more = ids.length > limit;
  return {
    items: page.map((r) => movementDto(db, String(r.id))),
    limit,
    has_more: more,
    next_cursor: more ? page[page.length - 1].id : null,
    data_mode: "erp_native",
  };
});

const STOCK_STATES = ["recorded", "no_movements", "review_required"];
const LIMIT_STATES = ["below_min", "within", "above_max", "not_configured", "no_movements", "review_required"];
const bad = (t: string | null, max: number) => t !== null && (pgLength(t) > max || pgHasCntrl.test(t));
/** strpos(lower(campo), lower(btrim(termo)))>0 */
const contains = (field: unknown, term: string) => pgLower(String(field ?? "")).includes(pgLower(pgBtrim(term)));

registerRpc("erp_stock_positions", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  requireAccess(db, a.p_user_id as string, false);
  const limit = a.p_limit as number | null,
    after = a.p_after as string | null,
    active = a.p_active as boolean | null,
    query = a.p_query as string | null,
    brand = a.p_brand as string | null,
    location = a.p_location as string | null,
    warehouseId = a.p_warehouse_id as string | null,
    stockState = a.p_stock_state as string | null,
    limitState = a.p_limit_state as string | null;
  if (
    limit === null || limit < 1 || limit > 100 || bad(query, 120) || bad(brand, 100) || bad(location, 100) ||
    (stockState !== null && !STOCK_STATES.includes(stockState)) || (limitState !== null && !LIMIT_STATES.includes(limitState))
  )
    raise("22023", "erp_stock_invalid_query");
  let warehouse: Record<string, unknown> | null = null;
  if (warehouseId !== null) {
    const w = one(db, `SELECT r.id, r.name, r.active FROM "erp_catalog__warehouse" w JOIN "erp_catalog__record" r ON r.id=w.record_id WHERE w.record_id=?`, warehouseId);
    if (!w) raise("P0002", "erp_stock_warehouse_not_found");
    warehouse = { id: w.id, name: w.name, active: w.active === 1 };
  }
  const has = (t: string | null) => t !== null && pgBtrim(t) !== "";
  const candidates = db
    .exec(
      `SELECT r.id, r.version, r.name, r.code, r.active, p.unit, p.kind, p.format, p.gtin, p.brand, p.location,
        CAST(p.stock_min AS TEXT) stock_min, CAST(p.stock_max AS TEXT) stock_max
       FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id
       WHERE (p.kind='P' OR EXISTS(SELECT 1 FROM "erp_stock__balance" b WHERE b.product_id=r.id) OR EXISTS(SELECT 1 FROM "erp_stock__entry" e WHERE e.product_id=r.id))
        AND (? IS NULL OR r.id>?) AND (? IS NULL OR r.active=?) ORDER BY r.id`,
      after, after, active === null ? null : active ? 1 : 0, active === null ? null : active ? 1 : 0,
    )
    .rows.filter(
      (c) =>
        (!has(query) || contains(c.name, query!) || contains(c.code, query!) || contains(c.gtin, query!)) &&
        (!has(brand) || contains(c.brand, brand!)) &&
        (!has(location) || contains(c.location, location!)),
    );
  const out: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const id = String(c.id);
    const balances = new Map(
      db.exec('SELECT warehouse_id, CAST(quantity AS TEXT) q, version, unit FROM "erp_stock__balance" WHERE product_id=?', id).rows.map((b) => [String(b.warehouse_id), b]),
    );
    const ledger = new Map(
      db.exec(
        `SELECT warehouse_id, count(*) n, CAST(sum(quantity) AS TEXT) q, max(balance_version) v, min(CASE WHEN unit IS ? THEN 1 ELSE 0 END) units_match FROM "erp_stock__entry" WHERE product_id=? GROUP BY warehouse_id`,
        c.unit, id,
      ).rows.map((l) => [String(l.warehouse_id), l]),
    );
    const positions = [...new Set([...balances.keys(), ...ledger.keys()])].map((w) => {
      const b = balances.get(w),
        l = ledger.get(w);
      const review =
        !b || !l || c.unit === null || c.kind !== "P" || b.unit !== c.unit || Number(l.units_match) !== 1 ||
        Number(b.version) !== Number(l.n) || Number(b.version) !== Number(l.v) || fromColumn(b.q) !== fromColumn(l.q);
      return { warehouse_id: w, quantity: b ? fromColumn(b.q) : null, version: b ? Number(b.version) : null, entry_count: l ? Number(l.n) : 0, state: review ? "review_required" : "recorded" };
    });
    const needsReview = positions.length ? positions.some((s) => s.state === "review_required") : null;
    const total = positions.filter((s) => s.quantity !== null && !ignoredWarehouse(db, s.warehouse_id)).reduce((t, s) => t + s.quantity!, 0n);
    const globalState = needsReview ? "review_required" : positions.length === 0 ? "no_movements" : "recorded";
    const globalQuantity = !needsReview && positions.length > 0 ? total : null;
    const sel = warehouseId === null ? undefined : positions.find((s) => s.warehouse_id === warehouseId);
    const selectedState = sel ? sel.state : "no_movements";
    const min = c.stock_min === null ? null : fromColumn(c.stock_min),
      max = c.stock_max === null ? null : fromColumn(c.stock_max);
    const limitStateOf =
      globalState !== "recorded"
        ? globalState
        : min === null && max === null
          ? "not_configured"
          : min !== null && globalQuantity! < min
            ? "below_min"
            : max !== null && globalQuantity! > max
              ? "above_max"
              : "within";
    if (stockState !== null && (warehouseId === null ? globalState : selectedState) !== stockState) continue;
    if (limitState !== null && limitStateOf !== limitState) continue;
    out.push({
      product: {
        id, version: Number(c.version), name: c.name, code: c.code, active: c.active === 1, unit: c.unit, kind: c.kind, format: c.format,
        gtin: c.gtin, brand: c.brand, location: c.location,
        stock_min: min === null ? null : q6(min), stock_max: max === null ? null : q6(max),
      },
      global: {
        state: globalState,
        quantity: globalQuantity === null ? null : q6(globalQuantity),
        recorded_warehouse_count: String(positions.filter((s) => s.entry_count > 0).length),
        scope: "all_recorded_warehouses",
      },
      selected_position:
        warehouseId === null
          ? null
          : {
              warehouse_id: warehouseId,
              state: selectedState,
              quantity: sel && sel.state === "recorded" ? q6(sel.quantity!) : null,
              version: sel?.version ?? 0,
            },
      limit_state: limitStateOf,
    });
    if (out.length > limit) break;
  }
  const page = out.slice(0, limit);
  const more = out.length > limit;
  return {
    items: page,
    warehouse,
    limit,
    has_more: more,
    next_cursor: more ? (page[page.length - 1].product as { id: string }).id : null,
    data_mode: "erp_native",
    scope: "stock_positions",
  };
});

