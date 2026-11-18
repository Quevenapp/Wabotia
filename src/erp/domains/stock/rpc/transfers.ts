import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { averageCosts } from "../costs.ts";
import { ignoredWarehouse } from "../home.ts";
import { commandTaken, lotApply, requireAccess, reservedQuantity, sha256, supplyPart } from "../internal.ts";
import { defaultSupplier, lastPurchase, priceText } from "../ledger.ts";
import { settingsDto } from "../read.ts";
import { erpStockLaunch } from "./launch.ts";
import { lotProductProblem } from "./document-stock.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const q6 = (v: unknown) => formatScaled(fromColumn(v ?? 0), 6);

/** erp_stock.entry_suggestions: preferência, fornecedor e custo médio. */
export function entrySuggestions(db: SqlDriver, products: string[]) {
  const settings = settingsDto(db), averages = averageCosts(db, products);
  return new Map(products.map(id => {
    const supplier = defaultSupplier(db, id);
    const last = settings.price_type === "ultima_compra" ? lastPurchase(db, id, settings.consider_balances) : null;
    return [id, {
      unit_price: settings.price_type === "ultima_compra" ? last?.unit_price ?? null :
        settings.price_type === "compra_fornecedor" ? supplier?.purchase_price ?? null : supplier?.cost_price ?? null,
      unit_cost: averages.get(id) ?? (settings.price_type === "ultima_compra" ? last?.unit_cost ?? last?.unit_price ?? null :
        supplier?.cost_price ?? supplier?.purchase_price ?? null),
    }];
  }));
}

registerRpc("erp_stock_transfer_positions", (ctx, a) => {
  const db = ctx.db, source = a.p_source_id as string | null, destination = a.p_destination_id as string | null;
  requireAccess(db, a.p_user_id as string, true);
  const ids = jsonbArg(a.p_product_ids);
  if (source === null || source === destination || !Array.isArray(ids) || ids.length < 1 || ids.length > 50 ||
    ids.some(x => typeof x !== "string" || !UUID.test(x)) || new Set(ids).size !== ids.length) raise("22023", "erp_stock_invalid_query");
  const products = ids as string[];
  for (const id of [source, destination]) if (id !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', id))
    raise("P0002", "erp_stock_warehouse_not_found");
  const rows = db.exec(`SELECT r.id,r.name,r.code,r.active,p.unit,p.kind,p.format FROM "erp_catalog__record" r
    JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id IN (SELECT value FROM json_each(?)) ORDER BY r.name__fold,r.id`, JSON.stringify(products)).rows;
  if (rows.length !== products.length) raise("P0002", "erp_stock_product_not_found");
  const suggestions = entrySuggestions(db, products);
  const warehouse = (id: string | null) => {
    if (id === null) return null;
    const r = one(db, 'SELECT id,name,active FROM "erp_catalog__record" WHERE id=?', id);
    return r ? { id: r.id, name: r.name, active: r.active === 1, ignore_balance: ignoredWarehouse(db, id) } : null;
  };
  return { scope: "stock_transfer_positions", data_mode: "erp_native", source: warehouse(source), destination: warehouse(destination),
    show_unit_price: settingsDto(db).show_unit_price, items: rows.map(r => {
      const id = String(r.id), b = one(db, 'SELECT CAST(quantity AS TEXT) q,version,unit FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', id, source),
        d = one(db, 'SELECT CAST(quantity AS TEXT) q,version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', id, destination), s = suggestions.get(id)!;
      return { product_id: id, name: r.name, code: r.code, unit: r.unit, kind: r.kind, format: r.format, active: r.active === 1,
        eligibility: r.kind !== "P" ? "not_product" : r.active !== 1 ? "inactive" : ["E", "V"].includes(String(r.format)) ? "composition" :
          r.unit === null ? "no_unit" : b?.unit != null && b.unit !== r.unit ? "unit_mismatch" : "eligible",
        source: { quantity: q6(b?.q), version: Number(b?.version ?? 0), reserved: formatScaled(reservedQuantity(db, id, source), 6) },
        destination: destination === null ? null : { quantity: q6(d?.q), version: Number(d?.version ?? 0) },
        suggested_price: priceText(s.unit_price), suggested_cost: priceText(s.unit_cost),
        lot_control: lotProductProblem(db, id) === null,
        lots: lotProductProblem(db, id) !== null ? [] : db.exec(`SELECT l.id,l.code,l.expires_on,CAST(lb.quantity AS TEXT) q
          FROM "erp_stock__lot" l JOIN "erp_stock__lot_balance" lb ON lb.lot_id=l.id AND lb.warehouse_id=?
          WHERE l.product_id=? AND l.active=1 AND lb.quantity>0`, source, id).rows
          .sort((a, b) => (a.expires_on === null ? b.expires_on === null ? 0 : 1 : b.expires_on === null ? -1 :
            pgCompareText(String(a.expires_on), String(b.expires_on))) || pgCompareText(pgLower(String(a.code)), pgLower(String(b.code))) || pgCompareText(String(a.id), String(b.id)))
          .slice(0, 50).map(l => ({ id: l.id, code: l.code, expires_on: l.expires_on, quantity: q6(l.q) })) };
    }) };
});

registerRpc("erp_stock_transfer_batch", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string | null,
    source = a.p_source_id as string | null, destination = a.p_destination_id as string | null, note = a.p_note as string | null;
  requireAccess(db, user, true);
  const items = jsonbArg(a.p_items) as Record<string, unknown>[] | null;
  const version = (v: unknown) => typeof v === "number" && /^[0-9]{1,10}$/.test(String(v)) && v <= 2147483646;
  if (command === null || source === null || destination === null || source === destination ||
    (note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note))) || !Array.isArray(items) || items.length < 1 || items.length > 50 ||
    new TextEncoder().encode(jsonbText(items)).length > 32768 || items.some(j => jsonType(j) !== "object" ||
      Object.keys(j).some(k => !["product_id", "quantity", "source_version", "destination_version", "unit_price", "unit_cost", "lot_id"].includes(k)) ||
      typeof j.product_id !== "string" || !UUID.test(j.product_id) || typeof j.quantity !== "string" ||
      !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(j.quantity) || toScaled(j.quantity, 6) === 0n ||
      !version(j.source_version) || !version(j.destination_version) ||
      ["unit_price", "unit_cost"].some(k => k in j && j[k] !== null && typeof j[k] !== "string") ||
      ("lot_id" in j && (typeof j.lot_id !== "string" || !UUID.test(j.lot_id)))) ||
    new Set(items.map(j => j.product_id)).size !== items.length) raise("22023", "erp_stock_transfer_batch_invalid");
  const hash = sha256(jsonbText({ profile: "stock-transfer-batch-183", actor: user, source, destination, note, items }));
  const c = one(db, 'SELECT * FROM "erp_stock__supply_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "transfer_batch" || c.request_hash !== hash) raise("40001", "erp_stock_transfer_batch_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_transfer_batch_conflict");
  let day: string | null = null, finalNote: string | null = null;
  const lines = [...items].sort((a, b) => String(a.product_id).localeCompare(String(b.product_id))).map(line => {
    let lot = null;
    if ("lot_id" in line) {
      if (lotProductProblem(db, String(line.product_id)) !== null) raise("22023", "erp_stock_lot_control_off");
      lot = one(db, 'SELECT id,product_id,active,code FROM "erp_stock__lot" WHERE id=?', line.lot_id);
      if (!lot || lot.product_id !== line.product_id) raise("P0002", "erp_stock_lot_not_found");
      if (lot.active !== 1) raise("22023", "erp_stock_lot_inactive");
      const b = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__lot_balance" WHERE lot_id=? AND warehouse_id=?', lot.id, source);
      if (fromColumn(b?.q ?? 0) < toScaled(String(line.quantity), 6)) raise("22023", "erp_stock_lot_insufficient");
    }
    const launch = erpStockLaunch(ctx, { p_user_id: user, p_command_id: supplyPart(command, "transfer:" + line.product_id),
      p_kind: "transfer", p_product_id: line.product_id, p_warehouse_id: source, p_quantity: line.quantity,
      p_expected_version: line.source_version, p_unit_price: line.unit_price ?? null, p_unit_cost: line.unit_cost ?? null,
      p_note: note, p_destination_id: destination, p_destination_version: line.destination_version });
    day = launch.occurred_on; finalNote = launch.detail.note;
    if (lot) {
      const quantity = toScaled(String(line.quantity), 6);
      lotApply(ctx, launch.movement.id, String(line.product_id), source, String(lot.id), -quantity);
      lotApply(ctx, launch.movement.id, String(line.product_id), destination, String(lot.id), quantity);
    }
    const r = one(db, 'SELECT r.name,r.code,p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', line.product_id)!;
    const entries = (launch.movement as { id: string; items: { warehouse_id: string; balance_after: unknown }[] }).items;
    return { product_id: line.product_id, name: r.name, code: r.code, unit: r.unit,
      quantity: formatScaled(toScaled(String(line.quantity), 6), 6), movement_id: launch.movement.id,
      source_balance_after: entries.find(e => e.warehouse_id === source)?.balance_after ?? null,
      destination_balance_after: entries.find(e => e.warehouse_id === destination)?.balance_after ?? null,
      unit_price: launch.detail.unit_price, unit_cost: launch.detail.unit_cost, ...(lot ? { lot_id: lot.id, lot_code: lot.code } : {}) };
  });
  const warehouse = (id: string) => one(db, 'SELECT id,name FROM "erp_catalog__record" WHERE id=?', id);
  const result = { scope: "stock_transfer_batch", data_mode: "erp_native", receipt: { command_id: command,
    source: warehouse(source), destination: warehouse(destination), note: finalNote, occurred_on: day, items: lines, saved_at: jsonTimestamp(ctx.clock.next()) } };
  db.exec('INSERT INTO "erp_stock__supply_command"(id,actor,action,request_hash,result,created_at) VALUES(?,?,?,?,?,?)',
    command, user, "transfer_batch", hash, JSON.stringify(result), ctx.clock.next().toString());
  return { ...result, replayed: false };
});
