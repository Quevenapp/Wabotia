// Ajuste acrescenta uma revisão; movimento e entradas permanecem imutáveis.
import { toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { allowed } from "../../documents/public.ts";
import { linkedDocumentGuard } from "../../documents/module-policy.ts";
import { commandTaken, requireAccess, reservationWriteAccess, sha256 } from "../internal.ts";
import { ledgerDocumentPrice, ledgerOrigin, priceText } from "../ledger.ts";
import { entryPriceCheck, price105 } from "./launch.ts";

registerRpc("erp_stock_movement_amend", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string | null,
    movement = a.p_movement_id as string | null, product = a.p_product_id as string | null,
    revision = a.p_expected_revision as number | null, note = a.p_note as string | null,
    unitPrice = a.p_unit_price as string | null, unitCost = a.p_unit_cost as string | null;
  requireAccess(db, user, true);
  if (command === null || movement === null || product === null || revision === null || revision < 0 || revision > 2147483646 ||
    note === null || pgLength(note) > 500 || pgHasCntrl.test(note)) raise("22023", "erp_stock_amend_invalid");
  const price = price105(unitPrice), cost = price105(unitCost), trimmed = pgBtrim(note);
  const hash = sha256(jsonbText({ profile: "stock-amend-105", actor: user, movement_id: movement, product_id: product,
    expected_revision: revision, unit_price: unitPrice, unit_cost: unitCost, note }));
  const c = one(db, 'SELECT * FROM "erp_stock__ledger_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "amend" || c.request_hash !== hash) raise("40001", "erp_stock_amend_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_amend_conflict");
  if (!one(db, 'SELECT 1 x FROM "erp_stock__entry" WHERE movement_id=? AND product_id=?', movement, product))
    raise("P0002", "erp_stock_movement_not_found");
  const origin = ledgerOrigin(db, movement), kind = origin.document_kind;
  if (origin.via === "document_stock") linkedDocumentGuard(db, origin.document_id);
  if (kind !== null && !allowed(String(one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role), kind, false))
    raise("42501", "erp_stock_amend_access_denied");
  const d = one(db, 'SELECT * FROM "erp_stock__movement_detail" WHERE movement_id=? AND product_id=? ORDER BY revision DESC LIMIT 1', movement, product);
  if (Number(d?.revision ?? 0) !== revision || Number(d?.revision ?? 0) === 2147483647) raise("40001", "erp_stock_amend_version_conflict");
  const decimal = (v: unknown) => v == null ? null : toScaled(String(v), 10);
  const wasPrice = d ? decimal(d.unit_price) : ledgerDocumentPrice(db, movement, product), wasCost = decimal(d?.unit_cost);
  const wasNote = d ? d.note : one(db, 'SELECT reason FROM "erp_stock__movement" WHERE id=?', movement)!.reason;
  if (price === wasPrice && cost === wasCost && trimmed === wasNote) raise("22023", "erp_stock_amend_unchanged");
  if (one(db, `SELECT 1 x FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
    WHERE e.movement_id=? AND e.product_id=? AND e.quantity>0 AND m.kind IN ('receipt','adjustment')`, movement, product)) {
    if (price !== wasPrice) entryPriceCheck(db, unitPrice);
    if (cost !== wasCost) entryPriceCheck(db, unitCost);
  }
  const result = { scope: "stock_amend", data_mode: "erp_native", movement_id: movement, product_id: product,
    from: { revision, unit_price: priceText(wasPrice), unit_cost: priceText(wasCost), note: wasNote },
    detail: { revision: revision + 1, unit_price: priceText(price), unit_cost: priceText(cost), note: trimmed },
    amended_at: jsonTimestamp(ctx.clock.next()) };
  db.exec('INSERT INTO "erp_stock__ledger_command"(id,actor,action,movement_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "amend", movement, hash, JSON.stringify(result), ctx.clock.next().toString());
  db.exec('INSERT INTO "erp_stock__movement_detail"(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    movement, product, revision + 1, unitPrice, unitCost, trimmed, user, command, ctx.clock.next().toString());
  reservationWriteAccess(db, user);
  return { ...result, replayed: false };
});
