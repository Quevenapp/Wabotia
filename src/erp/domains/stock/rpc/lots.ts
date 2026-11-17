// Lotes (Estoque › Lotes, 258): public.erp_stock_lots, erp_stock_lot_get,
// erp_stock_lot_save e erp_stock_lot_status, com lot_settings, lot_check,
// lot_dto, lot_expiry_state e a guarda guard_lot.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp, saoPauloParts, saoPauloStamp, todaySaoPaulo, validDate } from "../../../engine/time.ts";
import { fold } from "../../catalog/public.ts";
import * as preferences from "../../preferences/public.ts";
import { ignoredWarehouse, lotQuantity } from "../home.ts";
import { QTY, commandTaken, requireAccess, sha256 } from "../internal.ts";
import { ledgerOrigin } from "../ledger.ts";
import { lotProductProblem } from "./document-stock.ts";

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const t6 = (v: bigint) => formatScaled(v, QTY);
const MAX_VERSION = 2147483646;
type Row = Record<string, unknown>;

/** erp_stock.lot_settings(): validade e fabricação obrigatórias e os dias de aviso. */
export function lotSettings(db: SqlDriver) {
  const d = preferences.get(db, "lotes.dias_aviso_validade");
  return {
    require_expiry: preferences.get(db, "lotes.validade_obrigatoria") === true,
    require_manufacture: preferences.get(db, "lotes.fabricacao_obrigatoria") === true,
    warning_days: typeof d === "number" && /^[0-9]{1,4}$/.test(jsonbText(d)) ? d : 0,
  };
}

/** erp_stock.lot_expiry_state(ativo, validade, quantidade, hoje, dias) */
export function lotExpiryState(active: boolean, expires: string | null, quantity: bigint, today: string, days: number): string | null {
  if (!active || expires === null || quantity <= 0n) return null;
  if (expires < today) return "expired";
  const limit = new Date(Date.parse(today + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
  return expires <= limit ? "expiring" : null;
}

/** (data)::date dentro de 1900–2100, como o lot_check aceita. */
const inRange = (d: string | null) => d === null || (d >= "1900-01-01" && d <= "2100-12-31");

/** erp_stock.lot_check(p_code, p_manufactured, p_expires, p_note) */
export function lotCheck(db: SqlDriver, code: string | null, manufactured: string | null, expires: string | null, note: string | null) {
  const s = lotSettings(db);
  if (
    code === null || pgLength(pgBtrim(code)) < 1 || pgLength(pgBtrim(code)) > 60 || pgHasCntrl.test(code) ||
    (note !== null && (pgLength(note) > 500 || pgHasCntrl.test(note))) ||
    !inRange(manufactured) || !inRange(expires) || (manufactured !== null && expires !== null && manufactured > expires)
  )
    raise("22023", "erp_stock_lot_invalid");
  if (s.require_expiry && expires === null) raise("22023", "erp_stock_lot_expiry_required");
  if (s.require_manufacture && manufactured === null) raise("22023", "erp_stock_lot_manufacture_required");
}

const createdOn = (micros: unknown) => saoPauloParts(BigInt(micros as number)).date;

/** erp_stock.lot_dto(p_lot, p_warehouse) */
export function lotDto(db: SqlDriver, id: string, warehouse: string | null = null) {
  const l = one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=?', id);
  if (!l) return null;
  const qty = lotQuantity(db, id, warehouse);
  const s = lotSettings(db);
  return {
    id: l.id,
    product_id: l.product_id,
    code: l.code,
    manufactured_on: l.manufactured_on ?? null,
    expires_on: l.expires_on ?? null,
    note: l.note ?? null,
    active: !!l.active,
    version: l.version,
    created_on: createdOn(l.created_at),
    quantity: t6(qty),
    expiry_state: lotExpiryState(!!l.active, (l.expires_on as string | null) ?? null, qty, todaySaoPaulo(), s.warning_days),
  };
}

/** erp_stock.guard_lot (BEFORE INSERT/UPDATE de lot): só a versão seguinte, sem trocar produto, código, criação nem comando. */
function guardLot(o: Row | null, n: Row) {
  if (
    (o === null && n.version !== 1) ||
    (o !== null &&
      (n.product_id !== o.product_id || n.code !== o.code || n.created_by !== o.created_by || n.version !== Number(o.version) + 1 || n.command_id === o.command_id))
  )
    raise("40001", "erp_stock_lot_immutable");
}

/** Ordem da lista: ativos primeiro, validade (nula por último), lower(código), id. */
const lotOrder = (x: Row, y: Row) =>
  Number(y.active) - Number(x.active) ||
  (x.expires_on === y.expires_on ? 0 : x.expires_on === null ? 1 : y.expires_on === null ? -1 : String(x.expires_on) < String(y.expires_on) ? -1 : 1) ||
  pgCompareText(pgLower(String(x.code)), pgLower(String(y.code))) ||
  pgCompareText(String(x.id), String(y.id));

registerRpc("erp_stock_lots", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id),
    status = str(a.p_status),
    offset = int(a.p_offset),
    limit = int(a.p_limit);
  requireAccess(db, user, false);
  if (product === null || status === null || !["all", "active", "inactive"].includes(status) || offset === null || offset < 0 || offset > 100000 || limit === null || limit < 1 || limit > 100)
    raise("22023", "erp_stock_invalid_query");
  const p = one(
    db,
    'SELECT r.id, r.name, r.code, p.unit, p.kind, p.format, r.active, d.lot_control FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE r.id=?',
    product,
  );
  if (!p) raise("P0002", "erp_stock_product_not_found");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  const today = todaySaoPaulo(),
    s = lotSettings(db);
  const all = db.exec('SELECT * FROM "erp_stock__lot" WHERE product_id=?', product).rows;
  const lots: (Row & { qty: bigint })[] = all
    .filter((l) => status === "all" || !!l.active === (status === "active"))
    .map((l) => ({ ...(l as Row), qty: lotQuantity(db, String(l.id), warehouse) }));
  lots.sort(lotOrder);
  let stock = 0n;
  for (const b of db.exec('SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product).rows)
    if (b.warehouse_id === warehouse || (warehouse === null && !ignoredWarehouse(db, String(b.warehouse_id)))) stock += fromColumn(b.q);
  const assigned = all.reduce((t, l) => t + lotQuantity(db, String(l.id), warehouse), 0n);
  return {
    scope: "stock_lots",
    data_mode: "erp_native",
    product: { id: p.id, name: p.name, code: p.code ?? null, unit: p.unit ?? null, kind: p.kind, format: p.format, active: !!p.active, lot_control: !!p.lot_control },
    warehouse_id: warehouse,
    status,
    offset,
    limit,
    total: lots.length,
    today,
    settings: s,
    items: lots.slice(offset, offset + limit).map((x) => ({
      id: x.id,
      code: x.code,
      manufactured_on: x.manufactured_on ?? null,
      expires_on: x.expires_on ?? null,
      note: x.note ?? null,
      active: !!x.active,
      version: x.version,
      created_on: createdOn(x.created_at),
      quantity: t6(x.qty),
      expiry_state: lotExpiryState(!!x.active, (x.expires_on as string | null) ?? null, x.qty, today, s.warning_days),
    })),
    stock: t6(stock),
    assigned: t6(assigned),
    unassigned: t6(stock - assigned),
  };
});

registerRpc("erp_stock_lot_get", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const id = str(a.p_lot_id),
    limit = int(a.p_limit);
  requireAccess(db, user, false);
  if (id === null || limit === null || limit < 1 || limit > 100) raise("22023", "erp_stock_invalid_query");
  const l = one(db, 'SELECT id, product_id FROM "erp_stock__lot" WHERE id=?', id);
  if (!l) raise("P0002", "erp_stock_lot_not_found");
  const moves = db.exec(
    `SELECT x.movement_id, x.warehouse_id, CAST(x.quantity AS TEXT) q, CAST(x.balance_after AS TEXT) after, m.kind, m.occurred_on, m.created_at, m.reason
       FROM "erp_stock__lot_entry" x JOIN "erp_stock__movement" m ON m.id=x.movement_id WHERE x.lot_id=?`,
    l.id,
  ).rows;
  moves.sort(
    (x, y) =>
      (String(x.occurred_on) < String(y.occurred_on) ? 1 : String(x.occurred_on) > String(y.occurred_on) ? -1 : 0) ||
      Number(y.created_at) - Number(x.created_at) ||
      -pgCompareText(String(x.movement_id), String(y.movement_id)) ||
      pgCompareText(String(x.warehouse_id), String(y.warehouse_id)),
  );
  const p = one(
    db,
    'SELECT r.id, r.name, r.code, p.unit, d.lot_control FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=r.id WHERE r.id=?',
    l.product_id,
  );
  const warehouses = db
    .exec(
      'SELECT b.warehouse_id, r.name, r.active, CAST(b.quantity AS TEXT) q, b.version FROM "erp_stock__lot_balance" b JOIN "erp_catalog__record" r ON r.id=b.warehouse_id WHERE b.lot_id=?',
      l.id,
    )
    .rows.sort((x, y) => pgCompareText(fold(String(x.name)), fold(String(y.name))) || pgCompareText(String(x.warehouse_id), String(y.warehouse_id)))
    .map((b) => ({
      warehouse_id: b.warehouse_id,
      name: b.name,
      active: !!b.active,
      ignored: ignoredWarehouse(db, String(b.warehouse_id)),
      quantity: t6(fromColumn(b.q)),
      version: b.version,
    }));
  return {
    scope: "stock_lot",
    data_mode: "erp_native",
    lot: lotDto(db, String(l.id)),
    settings: lotSettings(db),
    product: p ? { id: p.id, name: p.name, code: p.code ?? null, unit: p.unit ?? null, lot_control: !!p.lot_control } : null,
    warehouses,
    movements: {
      total: moves.length,
      limit,
      items: moves.slice(0, limit).map((x) => ({
        movement_id: x.movement_id,
        warehouse_id: x.warehouse_id,
        quantity: t6(fromColumn(x.q)),
        balance_after: t6(fromColumn(x.after)),
        kind: x.kind,
        occurred_on: x.occurred_on,
        created_at: jsonTimestamp(x.created_at as number),
        recorded_at_local: saoPauloStamp(x.created_at as number),
        reason: x.reason,
        origin: ledgerOrigin(db, String(x.movement_id)),
      })),
    },
  };
});

/** (texto)::date de argumento já preparado (engine/args.ts). */
const day = (v: unknown) => {
  const s = str(v);
  if (s !== null && !validDate(s)) raise("22007", `invalid input syntax for type date: "${s}"`);
  return s;
};

registerRpc("erp_stock_lot_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    product = str(a.p_product_id),
    lotId = str(a.p_lot_id),
    version = int(a.p_expected_version),
    code = str(a.p_code),
    manufactured = day(a.p_manufactured_on),
    expires = day(a.p_expires_on),
    note = str(a.p_note);
  requireAccess(db, user, true);
  if (command === null || product === null || version === null || version < 0 || version > MAX_VERSION || (lotId === null) !== (version === 0))
    raise("22023", "erp_stock_lot_invalid");
  const trimmedNote = note === null || pgBtrim(note) === "" ? null : pgBtrim(note);
  const hash = sha256(
    jsonbText({
      profile: "stock-lot-save-258", actor: user, product_id: product, lot_id: lotId, expected_version: version, code, manufactured_on: manufactured, expires_on: expires, note,
    }),
  );
  requireAccess(db, user, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__lot_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "save" || c.request_hash !== hash) raise("40001", "erp_stock_lot_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_lot_conflict");
  requireAccess(db, user, true);
  const problem = lotProductProblem(db, product);
  if (problem === "not_found") raise("P0002", "erp_stock_product_not_found");
  // Lote novo precisa do "Controle de lote" ligado; os que já existem continuam editáveis.
  if (problem !== null && lotId === null) raise("22023", "erp_stock_lot_control_off");
  lotCheck(db, code, manufactured, expires, trimmedNote);
  let id: string;
  const at = ctx.clock.next().toString();
  if (lotId === null) {
    // lower(code) = lower(btrim(p_code)): code__fold é lower(code) (o índice do Fagoo).
    if (one(db, 'SELECT 1 x FROM "erp_stock__lot" WHERE product_id=? AND code__fold=?', product, pgLower(pgBtrim(code!)))) raise("22023", "erp_stock_lot_code_taken");
    id = crypto.randomUUID();
    const n = { product_id: product, code: pgBtrim(code!), version: 1, created_by: user, command_id: command };
    guardLot(null, n);
    db.exec(
      'INSERT INTO "erp_stock__lot"(id, product_id, code, code__fold, manufactured_on, expires_on, note, version, created_at, created_by, updated_at, updated_by, command_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, product.toLowerCase(), n.code, pgLower(n.code), manufactured, expires, trimmedNote, 1, at, user, at, user, command,
    );
  } else {
    const l = one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=? AND product_id=?', lotId, product);
    if (!l) raise("P0002", "erp_stock_lot_not_found");
    if (l.version !== version) raise("40001", "erp_stock_lot_version_conflict");
    if (l.code !== pgBtrim(code!)) raise("22023", "erp_stock_lot_code_immutable");
    if ((l.manufactured_on ?? null) === manufactured && (l.expires_on ?? null) === expires && (l.note ?? null) === trimmedNote) raise("22023", "erp_stock_lot_unchanged");
    guardLot(l, { ...l, version: Number(l.version) + 1, command_id: command });
    db.exec(
      'UPDATE "erp_stock__lot" SET manufactured_on=?, expires_on=?, note=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE id=?',
      manufactured, expires, trimmedNote, at, user, command, l.id,
    );
    id = String(l.id);
  }
  const result = { scope: "stock_lot_save", data_mode: "erp_native", created: lotId === null, lot: lotDto(db, id), settings: lotSettings(db) };
  db.exec(
    'INSERT INTO "erp_stock__lot_command"(id, actor, action, product_id, lot_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?,?)',
    command, user, "save", product.toLowerCase(), id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
});

registerRpc("erp_stock_lot_status", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    lotId = str(a.p_lot_id),
    version = int(a.p_expected_version),
    active = a.p_active === undefined || a.p_active === null ? null : (a.p_active as boolean);
  requireAccess(db, user, true);
  if (command === null || lotId === null || version === null || version < 1 || version > MAX_VERSION || active === null) raise("22023", "erp_stock_lot_invalid");
  const hash = sha256(jsonbText({ profile: "stock-lot-status-258", actor: user, lot_id: lotId, expected_version: version, active }));
  requireAccess(db, user, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__lot_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "status" || c.request_hash !== hash) raise("40001", "erp_stock_lot_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_lot_conflict");
  requireAccess(db, user, true);
  const l = one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=?', lotId);
  if (!l) raise("P0002", "erp_stock_lot_not_found");
  if (l.version !== version) raise("40001", "erp_stock_lot_version_conflict");
  if (!!l.active === active) raise("22023", "erp_stock_lot_unchanged");
  if (!active && one(db, 'SELECT 1 x FROM "erp_stock__lot_balance" WHERE lot_id=? AND quantity<>0', l.id)) raise("22023", "erp_stock_lot_has_stock");
  guardLot(l, { ...l, version: Number(l.version) + 1, command_id: command });
  db.exec('UPDATE "erp_stock__lot" SET active=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE id=?', active ? 1 : 0, ctx.clock.next().toString(), user, command, l.id);
  const result = { scope: "stock_lot_status", data_mode: "erp_native", lot: lotDto(db, String(l.id)) };
  db.exec(
    'INSERT INTO "erp_stock__lot_command"(id, actor, action, product_id, lot_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?,?)',
    command, user, "status", l.product_id, l.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
});
