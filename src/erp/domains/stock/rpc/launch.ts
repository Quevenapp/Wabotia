// Lançamento manual de estoque (tela Estoque › Lançamentos): public.
// erp_stock_launch (entrada, saída, balanço e transferência, 105) e
// erp_stock_reverse (estorno de um movimento manual, com os ajustes de
// compensação do balanço, 145/182/224).
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import * as preferences from "../../preferences/public.ts";
import { QTY, QTY_MAX, commandTaken, derivedCommand, requireAccess, reservationWriteAccess, sha256 } from "../internal.ts";
import { entryDecimals, priceText } from "../ledger.ts";
import { post } from "./erp_stock_post.ts";

const PRICE = 10;
const PRICE_RE = /^(0|[1-9][0-9]{0,13})(\.[0-9]{1,10})?$/;
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const t6 = (v: bigint) => formatScaled(v, QTY);

/** erp_stock.price_105(p): preço em texto (até 14 inteiros e 10 casas) → valor exato. */
function price105(p: string | null): bigint | null {
  if (p === null) return null;
  if (!PRICE_RE.test(p)) raise("22023", "erp_stock_price_invalid");
  return toScaled(p, PRICE);
}

/** erp_stock.entry_price_check(p): o preço de entrada não passa das casas da preferência (277). */
function entryPriceCheck(db: SqlDriver, p: string | null) {
  if (p === null || !PRICE_RE.test(p)) return;
  const n = entryDecimals(db);
  const v = toScaled(p, PRICE);
  if (v % 10n ** BigInt(PRICE - n) !== 0n) raise("22023", "erp_stock_price_decimals_exceeded");
}

/** public.erp_stock_launch */
export function erpStockLaunch(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    kind = str(a.p_kind),
    product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id),
    quantity = str(a.p_quantity),
    version = int(a.p_expected_version),
    unitPrice = str(a.p_unit_price),
    unitCost = str(a.p_unit_cost),
    note = str(a.p_note),
    destination = str(a.p_destination_id),
    destinationVersion = int(a.p_destination_version);
  requireAccess(db, user, true);
  const qtyRe = kind === "balance" ? /^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/ : /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
  if (
    command === null || kind === null || !["receipt", "issue", "balance", "transfer"].includes(kind) || product === null || warehouse === null ||
    version === null || version < 0 || version > 2147483646 || quantity === null || !qtyRe.test(quantity) || /^-0(\.0+)?$/.test(quantity) ||
    (kind !== "balance" && toScaled(quantity, QTY) === 0n) ||
    (kind === "transfer") !== (destination !== null) || (destination === null) !== (destinationVersion === null) ||
    (destinationVersion !== null && (destinationVersion < 0 || destinationVersion > 2147483646)) ||
    (destination !== null && destination === warehouse) ||
    (kind === "issue" && unitCost !== null) || (note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note)))
  )
    raise("22023", "erp_stock_launch_invalid");
  const price = price105(unitPrice),
    cost = price105(unitCost);
  const qty = toScaled(quantity, QTY);
  const fallback = kind === "transfer" ? "Transferência" : "Lançamento manual";
  const trimmed = note === null ? "" : pgBtrim(note);
  const finalNote = trimmed === "" ? fallback : trimmed;
  const reason = pgLength(finalNote) >= 3 ? finalNote : fallback;
  const hash = sha256(
    jsonbText({
      profile: "stock-launch-105", actor: user, kind, product_id: product, warehouse_id: warehouse, quantity, expected_version: version,
      unit_price: unitPrice, unit_cost: unitCost, note, destination_id: destination, destination_version: destinationVersion,
    }),
  );
  requireAccess(db, user, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__ledger_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "launch" || c.request_hash !== hash) raise("40001", "erp_stock_launch_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_launch_conflict");
  if (kind === "receipt" || kind === "balance") {
    entryPriceCheck(db, unitPrice);
    entryPriceCheck(db, unitCost);
  }
  requireAccess(db, user, true);
  // 260: composição Físico com "Lançar estoque" Componentes ou Produto e componente: entrada e saída diretas pela tela da composição.
  if (
    (kind === "receipt" || kind === "issue") &&
    one(
      db,
      `SELECT 1 x FROM "erp_stock__composition" k JOIN "erp_catalog__product" x ON x.record_id=k.product_id WHERE k.product_id=? AND x.format='E' AND k.post_mode IN ('components','both')`,
      product,
    )
  )
    raise("22023", "erp_stock_composition_launch_required");
  const day = todaySaoPaulo();
  let current = 0n;
  let items: Record<string, unknown>[];
  if (kind === "balance") {
    const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
    current = b ? fromColumn(b.q) : 0n;
    if ((b ? Number(b.version) : 0) !== version) raise("40001", "erp_stock_version_conflict");
    const delta = qty - current;
    if (delta === 0n) raise("22023", "erp_stock_balance_unchanged");
    if ((delta < 0n ? -delta : delta) > QTY_MAX) raise("22023", "erp_stock_insufficient_or_excess_quantity");
    items = [{ product_id: product, warehouse_id: warehouse, quantity: t6(delta), expected_version: version }];
  } else if (kind === "transfer")
    items = [
      { product_id: product, warehouse_id: warehouse, quantity: "-" + quantity, expected_version: version },
      { product_id: product, warehouse_id: destination, quantity, expected_version: destinationVersion },
    ];
  else items = [{ product_id: product, warehouse_id: warehouse, quantity: kind === "issue" ? "-" + quantity : quantity, expected_version: version }];
  const posted = post(ctx, { user, command, kind: kind === "balance" ? "adjustment" : kind, occurredOn: day, reason, reference: null, items }) as {
    movement: { id: string };
    replayed?: boolean;
  };
  if (posted.replayed !== false) raise("40001", "erp_stock_launch_conflict");
  const movement = posted.movement.id;
  const result = {
    scope: "stock_launch",
    data_mode: "erp_native",
    kind,
    occurred_on: day,
    movement: posted.movement,
    detail: { revision: 1, unit_price: priceText(price), unit_cost: priceText(cost), note: finalNote },
    balance: kind === "balance" ? { counted: t6(qty), previous: t6(current), warehouse_id: warehouse, source: "launch" } : null,
  };
  db.exec(
    'INSERT INTO "erp_stock__ledger_command"(id, actor, action, movement_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, user, "launch", movement, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_stock__movement_detail"(movement_id, product_id, revision, unit_price, unit_cost, note, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    movement, product!.toLowerCase(), 1, unitPrice, unitCost, finalNote, user, command, ctx.clock.next().toString(),
  );
  if (kind === "balance") {
    // guard_balance_count: ajuste de um só lançamento, com a diferença contada.
    const e = db.exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q, CAST(balance_after AS TEXT) after FROM "erp_stock__entry" WHERE movement_id=?', movement).rows;
    if (e.length !== 1 || fromColumn(e[0].q) !== qty - current || fromColumn(e[0].after) !== qty) raise("22023", "erp_stock_balance_count_invalid");
    db.exec(
      'INSERT INTO "erp_stock__balance_count"(movement_id, product_id, warehouse_id, counted, previous, source, created_at) VALUES(?,?,?,?,?,?,?)',
      movement, product!.toLowerCase(), warehouse!.toLowerCase(), qty.toString(), current.toString(), "launch", ctx.clock.next().toString(),
    );
  }
  reservationWriteAccess(db, user);
  return { ...result, replayed: false };
}

const COMPENSATION_REASON = "Estorno anterior ao balanço: saldo atual mantido";
const COMPENSATION_SETTING = "erp_stock.reversal_compensation";

/** public.erp_stock_reverse */
export function erpStockReverse(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const movement = str(a.p_movement_id),
    command = str(a.p_command_id),
    day = str(a.p_occurred_on),
    reason = str(a.p_reason);
  const versions = a.p_versions === undefined || a.p_versions === null ? null : typeof a.p_versions === "string" ? JSON.parse(a.p_versions) : a.p_versions;
  requireAccess(db, user, true);
  if (one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" WHERE movement_id=?', movement) || one(db, 'SELECT 1 x FROM "erp_purchase_receipts__reversal" WHERE movement_id=?', movement))
    raise("40001", "purchase_receipt_reverse_via_receipt");
  if (one(db, 'SELECT 1 x FROM "erp_stock__document_posting" WHERE movement_id=? OR reversal_movement_id=?', movement, movement)) raise("40001", "erp_stock_reverse_via_document");
  if (one(db, 'SELECT 1 x FROM "erp_stock__invoice_posting" WHERE movement_id=? OR reversal_movement_id=?', movement, movement)) raise("40001", "erp_stock_reverse_via_invoice");
  if (
    !Array.isArray(versions) || versions.length < 1 || versions.length > 100 ||
    versions.some((j) => jsonType(j) !== "object" || Object.keys(j).some((k) => !["product_id", "warehouse_id", "expected_version"].includes(k)))
  )
    raise("22023", "erp_stock_invalid_versions");
  const entries = db.exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__entry" WHERE movement_id=? ORDER BY ordinal', movement).rows;
  if (entries.length === 0) raise("P0002", "erp_stock_movement_not_found");
  let items: Record<string, unknown>[] = [];
  for (const e of entries)
    for (const v of versions as Record<string, unknown>[])
      if (arrow(v, "product_id") === e.product_id && arrow(v, "warehouse_id") === e.warehouse_id)
        items.push({ product_id: e.product_id, warehouse_id: e.warehouse_id, quantity: t6(-fromColumn(e.q)), expected_version: v.expected_version });
  if (versions.length !== entries.length || items.length !== entries.length) raise("22023", "erp_stock_invalid_versions");
  const pre = derivedCommand(command!, "before"),
    postId = derivedCommand(command!, "after");
  const bump = (i: Record<string, unknown>) => ({ ...i, expected_version: Number(BigInt(arrow(i, "expected_version") ?? "") + 1n) });
  const adjustments = () =>
    db.exec('SELECT result FROM "erp_stock__command" WHERE id IN (?,?) ORDER BY created_at, id', pre, postId).rows.map((r) => JSON.parse(String(r.result)).movement);
  const same = (x: unknown, y: unknown) => jsonbText(x ?? null) === jsonbText(y ?? null);
  // Comando repetido: o que a primeira execução gravou (as posições compensadas antes foram lançadas uma versão depois).
  const repeated = !!one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command);
  if (repeated) {
    const preCmd = one(db, 'SELECT result FROM "erp_stock__command" WHERE id=?', pre);
    const preItems = preCmd ? ((JSON.parse(String(preCmd.result)).movement?.items ?? []) as Record<string, unknown>[]) : [];
    items = items.map((i) => (preItems.some((b) => arrow(b, "product_id") === arrow(i, "product_id") && arrow(b, "warehouse_id") === arrow(i, "warehouse_id")) ? bump(i) : i));
  }
  const reversal = () => post(ctx, { user, command, kind: "reversal", occurredOn: day, reason, reference: null, items, reversesId: movement }) as Record<string, unknown>;
  const pref = preferences.get(db, "estoque.estorno_balanco");
  if (repeated || pref !== false || one(db, `SELECT 1 x FROM "erp_stock__movement" WHERE id=? AND kind='reversal'`, movement))
    return { ...reversal(), balance_adjustments: adjustments() };
  // Posições do lançamento com um balanço registrado depois dele (182: balanço estornado não conta).
  const absorbed = items.filter((i) =>
    one(
      db,
      `SELECT 1 x FROM "erp_stock__balance_count" c JOIN "erp_stock__movement" b ON b.id=c.movement_id JOIN "erp_stock__movement" o ON o.id=?
        WHERE c.product_id=? AND c.warehouse_id=? AND b.created_at>o.created_at AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" x WHERE x.reverses_id=b.id)`,
      movement,
      String(i.product_id).toLowerCase(),
      String(i.warehouse_id).toLowerCase(),
    ),
  );
  if (absorbed.length === 0) return { ...reversal(), balance_adjustments: [] };
  const quantity = (i: Record<string, unknown>) => arrow(i, "quantity") ?? "";
  const before = absorbed
    .filter((i) => quantity(i).startsWith("-"))
    .map((i) => ({ product_id: i.product_id, warehouse_id: i.warehouse_id, quantity: quantity(i).replace(/^-+/, ""), expected_version: i.expected_version }));
  items = items.map((i) => (before.some((b) => same(b.product_id, i.product_id) && same(b.warehouse_id, i.warehouse_id)) ? bump(i) : i));
  const after = absorbed
    .filter((i) => !quantity(i).startsWith("-"))
    .map((i) => ({ product_id: i.product_id, warehouse_id: i.warehouse_id, quantity: "-" + quantity(i), expected_version: bump(i).expected_version }));
  if (before.length) {
    ctx.settings.set(COMPENSATION_SETTING, pre);
    post(ctx, { user, command: pre, kind: "adjustment", occurredOn: day, reason: COMPENSATION_REASON, reference: null, items: before });
    ctx.settings.set(COMPENSATION_SETTING, "");
  }
  const result = reversal();
  if (after.length) {
    ctx.settings.set(COMPENSATION_SETTING, postId);
    post(ctx, { user, command: postId, kind: "adjustment", occurredOn: day, reason: COMPENSATION_REASON, reference: null, items: after });
    ctx.settings.set(COMPENSATION_SETTING, "");
  }
  return { ...result, balance_adjustments: adjustments() };
}

registerRpc("erp_stock_launch", erpStockLaunch);
registerRpc("erp_stock_reverse", erpStockReverse);
