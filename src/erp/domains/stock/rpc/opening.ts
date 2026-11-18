// Leituras de depósitos vinculados e recibos de abertura já existentes.
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { policyDto } from "./policy.ts";

/** erp_stock.opening_access */
function openingAccess(db: SqlDriver, actor: string) {
  if (!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, actor))
    raise("42501", "stock_opening_access_denied");
}
/** erp_stock.opening_text */
function openingText(value: string | null, max: number) {
  return value === null ? null : pgLeft(pgBtrim(value.replace(new RegExp(PG_CNTRL, "gu"), " ")), max) || null;
}
/** erp_stock.opening_warehouse_dto */
function openingWarehouseDto(db: SqlDriver, b: Record<string, unknown>) {
  const r = one(db, 'SELECT name,active FROM "erp_catalog__record" WHERE id=?', b.warehouse_id);
  return r ? { source_id: b.source_id, warehouse_id: b.warehouse_id, name: r.name, active: r.active === 1,
    source_name: openingText(arrow(JSON.parse(String(b.source)), "name"), 200), imported_at: jsonTimestamp(b.imported_at as number) } : null;
}
/** erp_stock.opening_receipt_dto / opening_current */
function openingCurrent(db: SqlDriver, command: string) {
  return db.exec(`SELECT *,CAST(target AS TEXT) target_q,CAST(previous_quantity AS TEXT) previous_q,
    CAST(adjustment AS TEXT) adjustment_q,CAST(source_version AS TEXT) source_v FROM "erp_stock__opening_receipt"
    WHERE command_id=? ORDER BY product_source_id`, command).rows.map(r => {
    const reversal = one(db, 'SELECT id FROM "erp_stock__movement" WHERE reverses_id=?', r.movement_id);
    return { id: r.id, command_id: r.command_id, product_source_id: r.product_source_id, product_id: r.product_id,
      warehouse_id: r.warehouse_id, outcome: r.outcome, state: r.movement_id === null ? "adopted_zero" : reversal ? "reversed" : "adopted",
      target: formatScaled(fromColumn(r.target_q), 6), previous_quantity: formatScaled(fromColumn(r.previous_q), 6),
      adjustment: formatScaled(fromColumn(r.adjustment_q), 6), unit: r.unit, movement_id: r.movement_id,
      reversal_movement_id: reversal?.id ?? null, occurred_on: r.occurred_on, source_hash: r.source_hash,
      source_version: r.source_v, created_at: jsonTimestamp(r.created_at as number) };
  });
}

registerRpc("erp_stock_opening_warehouses", (ctx, a) => {
  openingAccess(ctx.db, a.p_user_id as string);
  const rows = ctx.db.exec('SELECT * FROM "erp_warehouse_import__binding" ORDER BY source_id LIMIT 100').rows;
  return { scope: "stock_opening_warehouses", profile: "origin-stock-opening-v1", items: rows.map(b => openingWarehouseDto(ctx.db, b)),
    has_more: Number(one(ctx.db, 'SELECT count(*) n FROM "erp_warehouse_import__binding"')!.n) > 100,
    policy: policyDto(ctx.db), data_mode: "erp_native" };
});
registerRpc("erp_stock_opening_command", (ctx, a) => {
  const user = a.p_user_id as string, command = a.p_command_id as string | null;
  openingAccess(ctx.db, user);
  if (command === null) raise("22023", "stock_opening_query_invalid");
  const c = one(ctx.db, 'SELECT * FROM "erp_stock__opening_command" WHERE id=?', command);
  if (!c) raise("P0002", "stock_opening_command_not_found");
  if (c.actor !== user) raise("42501", "stock_opening_access_denied");
  return { ...JSON.parse(String(c.result)), current: openingCurrent(ctx.db, command), replayed: true };
});
