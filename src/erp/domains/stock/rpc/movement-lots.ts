// Lotes nos lançamentos (258, 278): public.erp_stock_lot_launch (lançamento
// com lote), erp_stock_movement_lots e _movement_lots_assign (informar os
// lotes de uma linha já lançada) e erp_stock_source_lots (as linhas do
// pedido ou da nota), com movement_lot_line, movement_lots_dto,
// movement_lot_candidates, unassigned_quantity e lot_origin_access.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireErpParts } from "../../../engine/parts-gate.ts";
import { erpEntityRequirement } from "../../../parts-requirements.ts";
import { pgBtrim, pgCompareText, pgLower } from "../../../engine/text.ts";
import { validDate } from "../../../engine/time.ts";
import * as documents from "../../documents/public.ts";
import { linkedDocumentGuard } from "../../documents/module-policy.ts";
import { QTY, QTY_MAX, commandTaken, lotApply, requireAccess, sha256 } from "../internal.ts";
import { invoiceAccess, invoiceFlag, invoiceReference } from "../invoice-read.ts";
import { ledgerOrigin } from "../ledger.ts";
import { lotProductProblem } from "./document-stock.ts";
import { erpStockLaunch } from "./launch.ts";
import { lotCheck, lotSettings } from "./lots.ts";

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const t6 = (v: bigint) => formatScaled(v, QTY);
const abs = (v: bigint) => (v < 0n ? -v : v);
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QTY_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const json = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? JSON.parse(v) : v);
type Row = Record<string, unknown>;

/** Ordem dos lotes: validade (nula por último), lower(código), id. */
const lotOrder = (x: Row, y: Row) =>
  (x.expires_on === y.expires_on ? 0 : x.expires_on === null ? 1 : y.expires_on === null ? -1 : String(x.expires_on) < String(y.expires_on) ? -1 : 1) ||
  pgCompareText(pgLower(String(x.code)), pgLower(String(y.code))) ||
  pgCompareText(String(x.id ?? x.lot_id), String(y.id ?? y.lot_id));

/** erp_stock.unassigned_quantity(p_product, p_warehouse): o saldo "Sem lote" da posição. */
export function unassignedQuantity(db: SqlDriver, product: string, warehouse: string): bigint {
  const b = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
  const lots = one(
    db,
    'SELECT CAST(coalesce(sum(b.quantity),0) AS TEXT) q FROM "erp_stock__lot_balance" b JOIN "erp_stock__lot" l ON l.id=b.lot_id WHERE l.product_id=? AND b.warehouse_id=?',
    product,
    warehouse,
  )!;
  return (b ? fromColumn(b.q) : 0n) - fromColumn(lots.q);
}

/** erp_stock.lot_origin_access(p_user, p_origin): lote de pedido ou OS só para quem lê o documento. */
function lotOriginAccess(ctx: RpcContext, user: string, origin: { type: string; document_kind: string | null }, operational = false) {
  const db = ctx.db;
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
  if (["sales", "purchases", "services"].includes(origin.type) && !documents.allowed(role, origin.document_kind, false)) raise("42501", "erp_stock_lot_origin_denied");
  // A linha do movimento continua rastreável e mantida pelo Estoque. Abrir a
  // rotina da origem, porém, exige sua parte; a referência histórica não some.
  if (operational) requireErpParts(ctx, erpEntityRequirement(origin.type === "invoices" ? "nfe" : origin.document_kind));
}

/** erp_stock.movement_lot_line(p_movement, p_product, p_warehouse): a linha do lançamento e os lotes dela. */
function movementLotLine(db: SqlDriver, movement: string, product: string, warehouse: string) {
  const e = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__entry" WHERE movement_id=? AND product_id=? AND warehouse_id=?', movement, product, warehouse);
  if (!e) return null;
  const m = one(db, 'SELECT id, kind, occurred_on, reason FROM "erp_stock__movement" WHERE id=?', movement)!;
  const lots = db.exec(
    `SELECT l.id lot_id, l.code, l.manufactured_on, l.expires_on, CAST(x.quantity AS TEXT) q FROM "erp_stock__lot_entry" x JOIN "erp_stock__lot" l ON l.id=x.lot_id
      WHERE x.movement_id=? AND x.product_id=? AND x.warehouse_id=?`,
    movement,
    product,
    warehouse,
  ).rows;
  const assigned = lots.reduce((t, x) => t + abs(fromColumn(x.q)), 0n);
  const qty = fromColumn(e.q);
  const reason =
    m.kind !== "receipt" && m.kind !== "issue" ? "kind"
    : one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE reverses_id=?', movement) ? "reversed"
    : lotProductProblem(db, product) !== null ? "lot_control_off"
    : abs(qty) - assigned <= 0n ? "assigned"
    : null;
  return {
    movement_id: m.id,
    product_id: product,
    warehouse_id: warehouse,
    warehouse_name: (one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', warehouse)?.name as string | undefined) ?? null,
    kind: m.kind,
    direction: qty > 0n ? "receipt" : "issue",
    occurred_on: m.occurred_on,
    reason: m.reason,
    quantity: t6(abs(qty)),
    assigned: t6(assigned),
    unassigned: t6(abs(qty) - assigned),
    lots_version: lots.length,
    assignable: reason === null,
    reason_code: reason,
    origin: ledgerOrigin(db, movement),
    lots: [...lots]
      .sort(lotOrder)
      .map((x) => ({ lot_id: x.lot_id, code: x.code, manufactured_on: x.manufactured_on ?? null, expires_on: x.expires_on ?? null, quantity: t6(abs(fromColumn(x.q))) })),
  };
}
type Line = NonNullable<ReturnType<typeof movementLotLine>>;

/** erp_stock.movement_lot_candidates(p_product, p_warehouse, p_direction): os lotes que cabem na linha (100). */
function movementLotCandidates(db: SqlDriver, product: string, warehouse: string, direction: string) {
  const rows = db
    .exec(
      `SELECT l.id, l.code, l.manufactured_on, l.expires_on, CAST(coalesce(b.quantity,0) AS TEXT) q FROM "erp_stock__lot" l
         LEFT JOIN "erp_stock__lot_balance" b ON b.lot_id=l.id AND b.warehouse_id=? WHERE l.product_id=? AND l.active=1`,
      warehouse,
      product,
    )
    .rows.filter((l) => direction === "receipt" || fromColumn(l.q) > 0n);
  return rows
    .sort(lotOrder)
    .slice(0, 100)
    .map((x) => ({ id: x.id, code: x.code, manufactured_on: x.manufactured_on ?? null, expires_on: x.expires_on ?? null, quantity: t6(fromColumn(x.q)) }));
}

/** erp_stock.movement_lots_dto(p_user, p_line) */
function movementLotsDto(db: SqlDriver, user: string, line: Line) {
  const p = one(db, 'SELECT r.id, r.name, r.code, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', line.product_id);
  const unassigned = toScaled(line.unassigned, QTY);
  const room = !line.assignable
    ? "0.000000"
    : line.direction === "receipt"
      ? t6((() => {
          const free = unassignedQuantity(db, line.product_id, line.warehouse_id);
          const least = unassigned < free ? unassigned : free;
          return least > 0n ? least : 0n;
        })())
      : t6(unassigned);
  return {
    line,
    product: p ? { id: p.id, name: p.name, code: p.code ?? null, unit: p.unit ?? null, lot_control: lotProductProblem(db, String(p.id)) === null } : null,
    room,
    candidates: line.assignable ? movementLotCandidates(db, line.product_id, line.warehouse_id, line.direction) : [],
    settings: lotSettings(db),
    can_write: !!one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role IN ('admin','estoque')`, user),
  };
}

/** INSERT de um lote novo (lançamento ou informe), com a guarda guard_lot. */
function insertLot(ctx: RpcContext, product: string, code: string, made: string | null, expires: string | null, user: string, command: string): Row {
  const db = ctx.db;
  if (one(db, 'SELECT 1 x FROM "erp_stock__lot" WHERE product_id=? AND code__fold=?', product, pgLower(pgBtrim(code)))) raise("22023", "erp_stock_lot_code_taken");
  const id = crypto.randomUUID();
  const at = ctx.clock.next().toString();
  db.exec(
    'INSERT INTO "erp_stock__lot"(id, product_id, code, code__fold, manufactured_on, expires_on, note, version, created_at, created_by, updated_at, updated_by, command_id) VALUES(?,?,?,?,?,?,NULL,1,?,?,?,?,?)',
    id, product, pgBtrim(code), pgLower(pgBtrim(code)), made, expires, at, user, at, user, command,
  );
  return one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=?', id)!;
}

/** Datas do lote novo: "AAAA-MM-DD" (o formato já conferido); data inexistente recusa com o erro do RPC. */
function lotDates(lot: Row, error: string) {
  const d = (k: string) => {
    const v = lot[k];
    if (v === undefined || v === null) return null;
    if (!validDate(String(v))) raise("22023", error);
    return String(v);
  };
  return { made: d("manufactured_on"), expires: d("expires_on") };
}

registerRpc("erp_stock_lot_launch", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    kind = str(a.p_kind),
    product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id),
    quantity = str(a.p_quantity),
    version = int(a.p_expected_version),
    destination = str(a.p_destination_id);
  const lot = json(a.p_lot) as Row | null;
  requireAccess(db, user, true);
  const has = (k: string) => lot !== null && jsonType(lot) === "object" && k in lot;
  if (
    command === null || kind === null || !["receipt", "issue", "balance", "transfer"].includes(kind) || product === null || warehouse === null ||
    quantity === null || !QTY_RE.test(quantity) || (kind !== "balance" && toScaled(quantity, QTY) === 0n) || version === null || version < 0 || version > 2147483646 ||
    lot === null || jsonType(lot) !== "object" || Object.keys(lot).some((k) => !["lot_id", "code", "manufactured_on", "expires_on"].includes(k)) ||
    has("lot_id") === has("code") ||
    (has("lot_id") && (jsonType(lot.lot_id) !== "string" || !UUID_LOWER.test(String(lot.lot_id)) || has("manufactured_on") || has("expires_on"))) ||
    (has("code") &&
      (!["receipt", "balance"].includes(kind) || jsonType(lot.code) !== "string" ||
        Object.entries(lot).some(([k, v]) => k !== "code" && v !== null && (jsonType(v) !== "string" || !DAY_RE.test(String(v))))))
  )
    raise("22023", "erp_stock_lot_launch_invalid");
  let made: string | null = null,
    expires: string | null = null;
  if (has("code")) ({ made, expires } = lotDates(lot, "erp_stock_lot_launch_invalid"));
  const hash = sha256(
    jsonbText({
      profile: "stock-lot-launch-258", actor: user, kind, product_id: product, warehouse_id: warehouse, quantity, expected_version: version,
      unit_price: str(a.p_unit_price), unit_cost: str(a.p_unit_cost), note: str(a.p_note), destination_id: destination, destination_version: int(a.p_destination_version), lot,
    }),
  );
  requireAccess(db, user, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__lot_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "launch" || c.request_hash !== hash) raise("40001", "erp_stock_launch_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_launch_conflict");
  requireAccess(db, user, true);
  const problem = lotProductProblem(db, product);
  if (problem === "not_found") raise("P0002", "erp_stock_product_not_found");
  if (problem !== null) raise("22023", "erp_stock_lot_control_off");
  let l: Row;
  let created = false;
  if (has("lot_id")) {
    const found = one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=?', String(lot.lot_id));
    if (!found || found.product_id !== product.toLowerCase()) raise("P0002", "erp_stock_lot_not_found");
    if (!found.active) raise("22023", "erp_stock_lot_inactive");
    l = found;
  } else {
    lotCheck(db, String(lot.code), made, expires, null);
    l = insertLot(ctx, product.toLowerCase(), String(lot.code), made, expires, user, command);
    created = true;
  }
  const lb = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__lot_balance" WHERE lot_id=? AND warehouse_id=?', l.id, warehouse);
  const current = lb ? fromColumn(lb.q) : 0n;
  const qty = toScaled(quantity, QTY);
  let target: string;
  let delta = 0n;
  if (kind === "balance") {
    delta = qty - current;
    if (delta === 0n) raise("22023", "erp_stock_balance_unchanged");
    const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, warehouse);
    if ((b ? Number(b.version) : 0) !== version) raise("40001", "erp_stock_version_conflict");
    const next = (b ? fromColumn(b.q) : 0n) + delta;
    if (abs(next) > QTY_MAX) raise("22023", "erp_stock_insufficient_or_excess_quantity");
    target = t6(next);
  } else {
    if ((kind === "issue" || kind === "transfer") && current < qty) raise("22023", "erp_stock_lot_insufficient");
    target = quantity;
  }
  const launched = erpStockLaunch(ctx, { ...a, p_quantity: target }) as Record<string, any>;
  if (launched.replayed !== false) raise("40001", "erp_stock_launch_conflict");
  const movement = String(launched.movement.id);
  const entries = [
    lotApply(ctx, movement, product.toLowerCase(), warehouse.toLowerCase(), String(l.id), kind === "receipt" ? qty : kind === "balance" ? delta : -qty),
  ];
  if (kind === "transfer") entries.push(lotApply(ctx, movement, product.toLowerCase(), destination!.toLowerCase(), String(l.id), qty));
  const { replayed: _r, ...rest } = launched;
  const result = {
    ...rest,
    lot: {
      id: l.id,
      code: l.code,
      manufactured_on: l.manufactured_on ?? null,
      expires_on: l.expires_on ?? null,
      created,
      entries,
      balance: kind === "balance" ? { counted: t6(qty), previous: t6(current) } : null,
    },
  };
  db.exec(
    'INSERT INTO "erp_stock__lot_command"(id, actor, action, product_id, lot_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?,?)',
    command, user, "launch", product.toLowerCase(), l.id, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
});

registerRpc("erp_stock_movement_lots", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const movement = str(a.p_movement_id),
    product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id);
  requireAccess(db, user, false);
  if (movement === null || product === null || warehouse === null) raise("22023", "erp_stock_invalid_query");
  const line = movementLotLine(db, movement, product.toLowerCase(), warehouse.toLowerCase());
  if (line === null) raise("P0002", "erp_stock_movement_not_found");
  lotOriginAccess(ctx, user, line.origin);
  return { scope: "stock_movement_lots", data_mode: "erp_native", ...movementLotsDto(db, user, line) };
});

registerRpc("erp_stock_movement_lots_assign", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const command = str(a.p_command_id),
    movement = str(a.p_movement_id),
    product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id),
    expected = int(a.p_expected_lots);
  const lots = json(a.p_lots) as Row[] | null;
  requireAccess(db, user, true);
  const has = (j: Row, k: string) => k in j;
  const ids = Array.isArray(lots) ? lots.filter((j) => jsonType(j) === "object" && has(j, "lot_id")).map((j) => (j.lot_id === null ? null : String(j.lot_id))) : [];
  const codes = Array.isArray(lots) ? lots.filter((j) => jsonType(j) === "object" && has(j, "code")).map((j) => (j.code === null ? null : pgLower(pgBtrim(String(j.code))))) : [];
  const distinct = (list: (string | null)[]) => new Set(list.filter((x) => x !== null)).size;
  if (
    command === null || movement === null || product === null || warehouse === null || expected === null || expected < 0 || expected > 100000 ||
    !Array.isArray(lots) || lots.length < 1 || lots.length > 50 || new TextEncoder().encode(jsonbText(lots)).length > 32768 ||
    lots.some(
      (j) =>
        jsonType(j) !== "object" ||
        Object.keys(j).some((k) => !["lot_id", "code", "manufactured_on", "expires_on", "quantity"].includes(k)) ||
        has(j, "lot_id") === has(j, "code") ||
        jsonType(j.quantity) !== "string" || !QTY_RE.test(String(j.quantity ?? "")) || toScaled(String(j.quantity), QTY) === 0n ||
        (has(j, "lot_id") && (jsonType(j.lot_id) !== "string" || !UUID_LOWER.test(String(j.lot_id)) || has(j, "manufactured_on") || has(j, "expires_on"))) ||
        (has(j, "code") &&
          (jsonType(j.code) !== "string" ||
            Object.entries(j).some(([k, v]) => k !== "code" && k !== "quantity" && v !== null && (jsonType(v) !== "string" || !DAY_RE.test(String(v)))))),
    ) ||
    distinct(ids) !== ids.length ||
    distinct(codes) !== codes.length
  )
    raise("22023", "erp_stock_lot_assign_invalid");
  const hash = sha256(
    jsonbText({ profile: "stock-movement-lots-278", actor: user, movement_id: movement, product_id: product, warehouse_id: warehouse, expected_lots: expected, lots }),
  );
  requireAccess(db, user, true);
  const c = one(db, 'SELECT actor, action, request_hash, result FROM "erp_stock__lot_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.action !== "assign" || c.request_hash !== hash) raise("40001", "erp_stock_lot_conflict");
    return { ...JSON.parse(String(c.result)), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "erp_stock_lot_conflict");
  requireAccess(db, user, true);
  const p = product.toLowerCase(),
    w = warehouse.toLowerCase();
  const line = movementLotLine(db, movement, p, w);
  if (line === null) raise("P0002", "erp_stock_movement_not_found");
  if (line.origin.via === "document_stock") linkedDocumentGuard(db, line.origin.document_id);
  lotOriginAccess(ctx, user, line.origin);
  if (line.lots_version !== expected) raise("40001", "erp_stock_lot_version_conflict");
  if (!line.assignable) raise("22023", "erp_stock_lot_assign_unavailable");
  const sum = lots.reduce((t, j) => t + toScaled(String(j.quantity), QTY), 0n);
  if (sum > toScaled(line.unassigned, QTY)) raise("22023", "erp_stock_lot_assign_exceeded");
  if (line.direction === "issue" && lots.some((j) => has(j, "code"))) raise("22023", "erp_stock_lot_assign_invalid");
  const sign = line.direction === "receipt" ? 1n : -1n;
  // Os lotes existentes em ordem de uuid, depois os novos pelo código.
  const ordered = [...lots].sort(
    (x, y) =>
      Number(has(x, "code")) - Number(has(y, "code")) ||
      (has(x, "code") ? pgCompareText(pgLower(pgBtrim(String(x.code))), pgLower(pgBtrim(String(y.code)))) : pgCompareText(String(x.lot_id), String(y.lot_id))),
  );
  const entries: Record<string, unknown>[] = [];
  let first: string | null = null;
  for (const r of ordered) {
    let l: Row;
    if (has(r, "code")) {
      const { made, expires } = lotDates(r, "erp_stock_lot_assign_invalid");
      lotCheck(db, String(r.code), made, expires, null);
      l = insertLot(ctx, p, String(r.code), made, expires, user, command);
    } else {
      const found = one(db, 'SELECT * FROM "erp_stock__lot" WHERE id=?', String(r.lot_id));
      if (!found || found.product_id !== p) raise("P0002", "erp_stock_lot_not_found");
      if (!found.active) raise("22023", "erp_stock_lot_inactive");
      if (one(db, 'SELECT 1 x FROM "erp_stock__lot_entry" WHERE movement_id=? AND product_id=? AND warehouse_id=? AND lot_id=?', movement, p, w, found.id))
        raise("22023", "erp_stock_lot_assign_duplicate");
      l = found;
    }
    first ??= String(l.id);
    const entry = lotApply(ctx, movement, p, w, String(l.id), sign * toScaled(String(r.quantity), QTY));
    entries.push({ ...entry, lot_id: l.id, code: l.code, created: has(r, "code") });
  }
  // Uma entrada põe em lotes unidades "Sem lote": os lotes do depósito nunca passam do saldo.
  if (sign > 0n && unassignedQuantity(db, p, w) < 0n) raise("22023", "erp_stock_lot_exceeds_unassigned");
  const result = { scope: "stock_movement_lots_assign", data_mode: "erp_native", entries, ...movementLotsDto(db, user, movementLotLine(db, movement, p, w)!) };
  db.exec(
    'INSERT INTO "erp_stock__lot_command"(id, actor, action, product_id, lot_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?,?)',
    command, user, "assign", p, first, hash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  return { ...result, replayed: false };
});

registerRpc("erp_stock_source_lots", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const source = str(a.p_source),
    sourceId = str(a.p_source_id),
    product = str(a.p_product_id);
  requireAccess(db, user, false);
  if (source === null || !["document", "invoice"].includes(source) || sourceId === null || product === null) raise("22023", "erp_stock_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', product)) raise("P0002", "erp_stock_product_not_found");
  const role = (one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user)?.role as string | undefined) ?? null;
  let doc: string | null = null;
  let flag: string | null = null;
  let reference: Record<string, unknown> | null = null;
  if (source === "document") {
    documents.mirrorRequireVisible(db, user, sourceId, false);
    const d = one(db, `SELECT id, kind, contact_id FROM "erp_documents__document" WHERE id=? AND kind IN ('sales_orders','purchase_orders','service_orders')`, sourceId);
    if (!d) raise("P0002", "erp_document_not_found");
    lotOriginAccess(ctx, user, { type: d.kind === "purchase_orders" ? "purchases" : d.kind === "service_orders" ? "services" : "sales", document_kind: String(d.kind) }, true);
    if (!documents.allowed(role, String(d.kind), false)) raise("42501", "erp_stock_lot_origin_denied");
    // 238: documento de um contato que a pessoa não vê não é encontrado.
    if (!documents.contactUsable(db, user, (d.contact_id as string | null) ?? null)) raise("P0002", "erp_document_not_found");
    doc = String(d.id);
  } else {
    invoiceAccess(db, user, false);
    lotOriginAccess(ctx, user, { type: "invoices", document_kind: null }, true);
    if (!one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice" WHERE id=?', sourceId)) raise("P0002", "erp_invoice_not_found");
    flag = invoiceFlag(db, sourceId).flag;
    if (flag === "R") {
      const { warehouse: _w, ...ref } = invoiceReference(db, sourceId)!;
      reference = ref;
      doc = String(ref.document_id);
    }
  }
  const movements = [
    ...(doc === null ? [] : db.exec(`SELECT movement_id id, created_at FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, doc).rows),
    ...(doc === null
      ? []
      : db.exec(
          `SELECT r.movement_id id, r.created_at FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`,
          doc,
        ).rows),
    ...(source === "invoice" && flag === "S"
      ? db.exec(`SELECT movement_id id, created_at FROM "erp_stock__invoice_posting" WHERE invoice_id=? AND state='active'`, sourceId).rows
      : []),
  ]
    .sort((x, y) => Number(x.created_at) - Number(y.created_at) || pgCompareText(String(x.id), String(y.id)))
    .slice(0, 50)
    .map((x) => String(x.id));
  const lines = db
    .exec(`SELECT movement_id, product_id, warehouse_id FROM "erp_stock__entry" WHERE product_id=? AND movement_id IN (SELECT value FROM json_each(?))`, product.toLowerCase(), JSON.stringify(movements))
    .rows.sort((x, y) => movements.indexOf(String(x.movement_id)) - movements.indexOf(String(y.movement_id)) || pgCompareText(String(x.warehouse_id), String(y.warehouse_id)))
    .map((e) => movementLotLine(db, String(e.movement_id), String(e.product_id), String(e.warehouse_id)));
  const p = one(db, 'SELECT r.id, r.name, r.code, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', product);
  return {
    scope: "stock_source_lots",
    data_mode: "erp_native",
    source,
    source_id: sourceId,
    posted: movements.length > 0,
    reference,
    product: p ? { id: p.id, name: p.name, code: p.code ?? null, unit: p.unit ?? null, lot_control: lotProductProblem(db, String(p.id)) === null } : null,
    lines,
    settings: lotSettings(db),
    can_write:
      (role === "admin" || role === "estoque") && !(doc !== null && one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND authority='origin'`, doc)),
  };
});
