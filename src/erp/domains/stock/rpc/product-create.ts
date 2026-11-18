// Produto e saldo inicial compartilham a transação do RPC e comandos derivados.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { erpCatalogProductSave } from "../../catalog/public.ts";
import { commandTaken, requireAccess, sha256, supplyPart } from "../internal.ts";
import { erpStockLaunch } from "./launch.ts";

registerRpc("erp_stock_product_create", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string | null,
    warehouse = a.p_warehouse_id as string | null, quantity = a.p_quantity as string | null,
    note = a.p_note as string | null, unitPrice = a.p_unit_price as string | null, unitCost = a.p_unit_cost as string | null,
    data = jsonbArg(a.p_data), acknowledged = jsonbArg(a.p_acknowledged);
  requireAccess(db, user, true);
  if (command === null || data == null || jsonType(data) !== "object" || warehouse === null || quantity === null ||
    !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(quantity) || toScaled(quantity, 6) === 0n ||
    (note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note)))) raise("22023", "erp_stock_initial_balance_invalid");
  const hash = sha256(jsonbText({ profile: "stock-initial-balance-183", actor: user, data, acknowledged, warehouse,
    quantity, unit_price: unitPrice, unit_cost: unitCost, note }));
  const c = one(db, 'SELECT * FROM "erp_stock__supply_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "initial_balance" || c.request_hash !== hash) raise("40001", "erp_stock_initial_balance_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command) || one(db, 'SELECT 1 x FROM "erp_catalog__command" WHERE command_id=?', command))
    raise("40001", "erp_stock_initial_balance_conflict");
  const product = erpCatalogProductSave(ctx, { p_user_id: user, p_id: null, p_expected_version: 0,
    p_command_id: supplyPart(command, "product"), p_data: data, p_acknowledged: acknowledged });
  if (product.replayed !== false) raise("40001", "erp_stock_initial_balance_conflict");
  const id = String((product.record as { id: string }).id);
  const launch = erpStockLaunch(ctx, { p_user_id: user, p_command_id: supplyPart(command, "balance"), p_kind: "receipt",
    p_product_id: id, p_warehouse_id: warehouse, p_quantity: quantity, p_expected_version: 0, p_unit_price: unitPrice,
    p_unit_cost: unitCost, p_note: pgBtrim(note ?? "") || "Saldo inicial", p_destination_id: null, p_destination_version: null });
  const { replayed: _, ...saved } = product;
  const result = { ...saved, initial_balance: { command_id: command, warehouse_id: warehouse,
    warehouse_name: one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', warehouse)?.name ?? null,
    quantity: formatScaled(toScaled(quantity, 6), 6), movement_id: launch.movement.id, occurred_on: launch.occurred_on,
    unit_price: launch.detail.unit_price, unit_cost: launch.detail.unit_cost, note: launch.detail.note } };
  db.exec('INSERT INTO "erp_stock__supply_command"(id,actor,action,request_hash,result,created_at) VALUES(?,?,?,?,?,?)',
    command, user, "initial_balance", hash, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
});
