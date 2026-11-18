// Abertura Origin: classificação, prévia e adoção na transação do RPC (100).
import { createHash, randomUUID } from "node:crypto";
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { PG_CNTRL, pgBtrim, pgCompareText, pgLeft, pgLength } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo } from "../../../engine/time.ts";
import { stockObservationId } from "../../sync/public.ts";
import { commandTaken, negativeAllowed, sha256 } from "../internal.ts";
import { post } from "./erp_stock_post.ts";
import { openingSource } from "./opening-source.ts";
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
  return db.exec(`SELECT id,command_id,product_source_id,product_id,warehouse_id,outcome,movement_id,unit,occurred_on,source_hash,created_at,
    CAST(target AS TEXT) target_q,CAST(previous_quantity AS TEXT) previous_q,
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

const PROFILE = "origin-stock-opening-v1";
const validId = (id: unknown): id is string => typeof id === "string" && stockObservationId(id) !== null;
// O $ do JavaScript também casa antes de uma quebra final; o regex SQL não.
const stringMatches = (v: unknown, re: RegExp) => typeof v === "string" && re.exec(v)?.[0] === v;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const pendingStatus = (status: string) => ["positive", "zero", "negative"].includes(status);
const observationStamp = (seen: string) => seen === "9223372036854775807" ? "infinity"
  : seen === "-9223372036854775808" ? "-infinity" : jsonTimestamp(seen);
/** erp_stock.opening_day */
function openingDay(day: string | null) {
  if (day === null || day < "1900-01-01" || day > todaySaoPaulo() || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    raise("22023", "stock_opening_date_invalid");
}
/** erp_stock.opening_binding */
function openingBinding(db: SqlDriver, source: unknown) {
  if (!validId(source)) raise("22023", "stock_opening_query_invalid");
  const b = one(db, 'SELECT source_id,warehouse_id,source,imported_at FROM "erp_warehouse_import__binding" WHERE source_id=?', source);
  if (!b) raise("P0002", "stock_opening_warehouse_not_found");
  return b;
}
/** erp_stock.opening_number */
function openingNumber(source: ReturnType<typeof openingSource>, node: Parameters<typeof source.scalar>[0]) {
  const no = (state: string) => ({ state, value: null });
  if (!node) return no("absent");
  if (node.type === "null") return no("null");
  if (node.type !== "number") return no("invalid");
  const text = source.numeric(node);
  if (text.length > 80 || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) return no("invalid");
  const [integer, fraction = ""] = text.replace(/^-/, "").split(".");
  if (BigInt(integer) > 999999999999n || (BigInt(integer) === 999999999999n &&
    fraction.replace(/0+$/, "").padEnd(6, "0") > "999999")) return no("range");
  if (/[1-9]/.test(fraction.slice(6))) return no("precision");
  return { state: "value", value: formatScaled(toScaled(text, 6), 6) };
}

/** erp_stock.opening_rows, com opening_row_dto na projeção final. */
function openingRows(db: SqlDriver, sourceId: string, warehouse: string, allow: boolean, ids: string[] | null = null) {
  const sources = db.exec(`SELECT DISTINCT source_id FROM "origin_sync__raw_record"
    WHERE entity IN ('products','stock_balances') ORDER BY source_id`).rows.map(r => String(r.source_id))
    .filter(id => validId(id) && (ids === null || ids.includes(id)));
  return sources.map(id => {
    const s = one(db, `SELECT payload,document_links,version_hash,CAST(version AS TEXT) source_version,CAST(last_seen_at AS TEXT) seen
      FROM "origin_sync__raw_record" WHERE entity='stock_balances' AND source_id=?`, id);
    const pr = one(db, `SELECT payload FROM "origin_sync__raw_record" WHERE entity='products' AND source_id=?`, id);
    const p = one(db, `SELECT r.id,r.name,r.code,r.active,p.unit,p.kind,p.format FROM "erp_catalog__origin" o
      JOIN "erp_catalog__record" r ON r.id=o.record_id AND r.entity='products'
      LEFT JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE o.entity='products' AND o.source_id=?`, id);
    const sp = openingSource(s ? String(s.payload) : "null"), pp = openingSource(pr ? String(pr.payload) : "null");
    const productNode = sp.field(sp.root, "produto"), deps = sp.field(sp.root, "depositos");
    const canonical = sp.canonical();
    const obsOk = !!s && sp.root.type === "object" && bytes(canonical) <= 131072 &&
      !["9223372036854775807", "-9223372036854775808"].includes(String(s.seen)) && BigInt(String(s.source_version)) >= 1n &&
      sp.id(sp.field(productNode, "id")) === id && s.version_hash === sha256('{"payload": ' + canonical +
        ', "document_links": ' + openingSource(String(s.document_links)).canonical() + '}');
    const list = obsOk && deps?.type === "array" && deps.children!.length <= 1000 ? deps.children! : null;
    const depIds = list?.map(d => sp.id(sp.field(d, "id")));
    const entry = list?.find(d => sp.id(sp.field(d, "id")) === sourceId);
    const listState = !s ? "missing" : !obsOk ? "invalid" : !deps ? "unavailable" : !list ||
      depIds!.includes(null) || new Set(depIds).size !== list.length ? "invalid" : entry ? "present" : "absent";
    const num = listState === "present" ? openingNumber(sp, sp.field(entry, "saldoFisico")) : null;
    const receipt = p ? one(db, 'SELECT id,command_id,movement_id FROM "erp_stock__opening_receipt" WHERE product_id=? AND warehouse_id=?', p.id, warehouse) : undefined;
    const bal = p ? one(db, 'SELECT CAST(quantity AS TEXT) q,version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', p.id, warehouse) : undefined;
    const hasEntries = p && one(db, 'SELECT 1 x FROM "erp_stock__entry" WHERE product_id=? AND warehouse_id=? LIMIT 1', p.id, warehouse);
    const reversed = receipt && one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE reverses_id=?', receipt.movement_id);
    const status = !p ? "no_native_product" : receipt ? receipt.movement_id === null ? "adopted_zero" : reversed ? "adopted_reversed" : "adopted"
      : hasEntries ? "native_movements" : ["missing", "unavailable", "absent"].includes(listState) ? "no_observation"
      : listState === "invalid" || num?.state !== "value" ? "invalid"
      : p.active !== 1 || p.kind !== "P" || p.unit === null || ["E", "V"].includes(String(p.format)) ? "invalid"
      : toScaled(num.value!, 6) > 0n ? "positive" : toScaled(num.value!, 6) === 0n ? "zero" : allow ? "negative" : "negative_blocked";
    const adopted = ["adopted", "adopted_zero", "adopted_reversed"].includes(status);
    const reason = status === "no_native_product" ? "NATIVE_PRODUCT_MISSING" : adopted ? "ALREADY_ADOPTED"
      : status === "native_movements" ? "NATIVE_MOVEMENTS" : status === "no_observation"
      ? listState === "missing" ? "OBSERVATION_MISSING" : listState === "unavailable" ? "WAREHOUSE_LIST_MISSING" : "WAREHOUSE_ABSENT"
      : status === "invalid" ? listState === "invalid" ? obsOk ? "WAREHOUSE_LIST_INVALID" : "SOURCE_INVALID"
      : num?.state !== "value" ? "PHYSICAL_" + num!.state.toUpperCase() : "PRODUCT_UNAVAILABLE"
      : status === "negative_blocked" ? "NEGATIVE_NOT_ALLOWED" : null;
    const target = pendingStatus(status) || status === "negative_blocked" ? num!.value : null;
    const adjustment = target === null ? null : toScaled(target, 6) - fromColumn(bal?.q ?? 0);
    if (adjustment !== null && (adjustment > 999999999999999999n || adjustment < -999999999999999999n))
      raise("22003", "numeric field overflow");
    const sourceName = pp.field(pp.root, "nome");
    return { product_source_id: id, group: status.startsWith("negative") ? "negative" : adopted ? "adopted" : status, status, reason,
      product: p ? { id: String(p.id), name: openingText(p.name as string | null, 200), code: openingText(p.code as string | null, 100), unit: p.unit as string | null } : null,
      source: { name: openingText(sourceName?.type === "string" ? sourceName.value : null, 200),
        code: openingText(sp.scalar(sp.field(productNode, "codigo")), 100) ?? openingText(pp.scalar(pp.field(pp.root, "codigo")), 100),
        source_hash: s?.version_hash as string ?? null, source_version: s?.source_version as string ?? null,
        last_seen_at: s ? observationStamp(String(s.seen)) : null },
      physical: num?.value ?? null, current: { quantity: bal ? formatScaled(fromColumn(bal.q), 6) : null, version: Number(bal?.version ?? 0) },
      target, adjustment: adjustment === null ? null : formatScaled(adjustment, 6),
      receipt: receipt ? openingCurrent(db, String(receipt.command_id)).find(r => r.id === receipt.id)! : null };
  });
}
type OpeningRow = ReturnType<typeof openingRows>[number];
/** erp_stock.opening_counts */
function openingCounts(rows: OpeningRow[]) {
  return { total: rows.length, ...Object.fromEntries(["positive", "zero", "negative", "no_native_product", "no_observation", "invalid", "adopted", "native_movements"]
    .map(group => [group, rows.filter(r => r.group === group).length])), negative_blocked: rows.filter(r => r.status === "negative_blocked").length,
    pending: rows.filter(r => pendingStatus(r.status)).length };
}
const coreKeys = ["product_source_id", "product_id", "unit", "source_hash", "source_version", "target"];
/** erp_stock.opening_preview_hash */
function openingPreviewHash(actor: string, source: string, warehouse: string, day: string, items: Record<string, unknown>[]) {
  return sha256(jsonbText({ profile: PROFILE, actor, warehouse_source_id: source, warehouse_id: warehouse, occurred_on: day,
    items: [...items].sort((a, b) => pgCompareText(String(a.product_source_id), String(b.product_source_id)))
      .map(j => Object.fromEntries(coreKeys.map(k => [k, arrow(j, k)]))) }));
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

registerRpc("erp_stock_opening_page", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, limit = a.p_limit as number | null,
    after = a.p_after as string | null, group = a.p_group as string | null;
  openingAccess(db, user);
  if (limit === null || limit < 1 || limit > 50 || (after !== null && !validId(after)) ||
    (group !== null && !["positive", "zero", "negative", "no_native_product", "no_observation", "invalid", "adopted", "native_movements"].includes(group)))
    raise("22023", "stock_opening_query_invalid");
  const b = openingBinding(db, a.p_warehouse_source_id);
  const rows = openingRows(db, String(b.source_id), String(b.warehouse_id), negativeAllowed(db));
  const selected = rows.filter(r => (group === null || r.group === group) && (after === null || pgCompareText(r.product_source_id, after) > 0));
  const items = selected.slice(0, limit), more = selected.length > limit;
  return { scope: "stock_opening", profile: PROFILE, warehouse: openingWarehouseDto(db, b), policy: policyDto(db), counts: openingCounts(rows),
    group, items, limit, has_more: more, next_cursor: more ? items.at(-1)!.product_source_id : null,
    unit_source: "native_product", observed_at: jsonTimestamp(ctx.clock.next()), data_mode: "erp_native" };
});

registerRpc("erp_stock_opening_batch", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, limit = a.p_limit as number | null, day = a.p_occurred_on as string;
  openingAccess(db, user);
  if (limit === null || limit < 1 || limit > 100) raise("22023", "stock_opening_query_invalid");
  openingDay(day);
  const b = openingBinding(db, a.p_warehouse_source_id), source = String(b.source_id), warehouse = String(b.warehouse_id);
  const pending = openingRows(db, source, warehouse, negativeAllowed(db)).filter(r => pendingStatus(r.status));
  const items = pending.slice(0, limit), core = items.map(r => ({ product_source_id: r.product_source_id, product_id: r.product!.id,
    unit: r.product!.unit, source_hash: r.source.source_hash, source_version: r.source.source_version, target: r.target }));
  return { scope: "stock_opening_batch", profile: PROFILE, warehouse: openingWarehouseDto(db, b), policy: policyDto(db), occurred_on: day,
    items, pending: pending.length, limit, preview_hash: items.length ? openingPreviewHash(user, source, warehouse, day, core) : null,
    unit_source: "native_product", observed_at: jsonTimestamp(ctx.clock.next()), data_mode: "erp_native" };
});

registerRpc("erp_stock_opening_apply", (ctx, a) => {
  const db = ctx.db, user = a.p_user_id as string, command = a.p_command_id as string | null,
    source = a.p_warehouse_source_id as string, day = a.p_occurred_on as string, preview = a.p_preview_hash as string | null;
  openingAccess(db, user);
  if (command === null || a.p_confirmed !== true || !stringMatches(preview, /^[a-f0-9]{64}$/) || !validId(source))
    raise("22023", "stock_opening_input_invalid");
  openingDay(day);
  const items = jsonbArg(a.p_items) as Record<string, unknown>[] | null;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100 || bytes(jsonbText(items)) > 65536 || items.some(j =>
    jsonType(j) !== "object" || Object.keys(j).some(k => !coreKeys.includes(k)) ||
    typeof j.unit !== "string" || pgLength(j.unit) < 1 || pgLength(j.unit) > 64 || !validId(j.product_source_id) ||
    !stringMatches(j.product_id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) ||
    !stringMatches(j.source_hash, /^[a-f0-9]{64}$/) || !stringMatches(j.source_version, /^[1-9][0-9]{0,17}$/) ||
    !stringMatches(j.target, /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/) || j.target === "-0.000000") ||
    new Set(items.map(j => j.product_source_id)).size !== items.length || new Set(items.map(j => j.product_id)).size !== items.length)
    raise("22023", "stock_opening_items_invalid");
  const hash = sha256(jsonbText({ profile: PROFILE, actor: user, warehouse_source_id: source, occurred_on: day,
    items, preview_hash: preview, confirmed: true }));
  const c = one(db, 'SELECT * FROM "erp_stock__opening_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== user || c.request_hash !== hash) raise("40001", "stock_opening_command_conflict");
    return { ...JSON.parse(String(c.result)), current: openingCurrent(db, command), replayed: true };
  }
  if (commandTaken(db, command)) raise("40001", "stock_opening_command_conflict");
  const b = openingBinding(db, source), warehouse = String(b.warehouse_id);
  if (preview !== openingPreviewHash(user, source, warehouse, day, items)) raise("40001", "stock_opening_preview_conflict");
  const w = one(db, 'SELECT active FROM "erp_catalog__record" WHERE id=?', warehouse);
  if (!w || w.active !== 1) raise("22023", "stock_opening_warehouse_unavailable");
  const allow = negativeAllowed(db);
  // A FK do recibo para o comando é imediata no DDL SQLite. Preparamos os
  // recibos e os inserimos após o comando, ainda na mesma transação atômica.
  const receipts: (() => void)[] = [];
  const results = [...items].sort((x, y) => pgCompareText(String(x.product_source_id), String(y.product_source_id))).map(item => {
    const r = openingRows(db, source, warehouse, allow, [String(item.product_source_id)])[0];
    let outcome = "skipped", mid: string | null = null, rid: string | null = null;
    const why = !r ? "SOURCE_CHANGED" : !r.product ? "NATIVE_PRODUCT_MISSING" : r.product.id !== item.product_id ? "PRODUCT_CHANGED"
      : ["adopted", "adopted_zero", "adopted_reversed"].includes(r.status) ? "ALREADY_ADOPTED"
      : r.status === "native_movements" ? "NATIVE_MOVEMENTS"
      : r.source.source_hash !== item.source_hash || r.source.source_version !== item.source_version ? "SOURCE_CHANGED"
      : !pendingStatus(r.status) ? r.reason ?? "SOURCE_CHANGED" : r.target !== item.target ? "SOURCE_CHANGED"
      : r.product.unit !== item.unit ? "UNIT_CHANGED" : null;
    if (why === null) {
      if (r.status === "zero") outcome = "adopted_zero";
      else {
        // md5(...)::uuid: conserva todos os bits, sem forçar versão/variante UUID.
        const h = createHash("md5").update(`${command}:${r.product!.id}:${warehouse}`, "utf8").digest("hex");
        const derived = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        if (commandTaken(db, derived)) raise("40001", "stock_opening_command_conflict");
        const movement = post(ctx, { user, command: derived, kind: "adjustment", occurredOn: day, reason: "Saldo de abertura (Origin)",
          reference: "Abertura Origin depósito " + source, items: [{ product_id: r.product!.id, warehouse_id: warehouse,
            quantity: r.adjustment, expected_version: r.current.version }] });
        mid = String((movement as { movement: { id: string } }).movement.id); outcome = "adopted";
      }
      rid = randomUUID();
      const seen = one(db, `SELECT CAST(last_seen_at AS TEXT) seen FROM "origin_sync__raw_record" WHERE entity='stock_balances' AND source_id=?`, r.product_source_id)!.seen;
      const createdAt = ctx.clock.next().toString();
      receipts.push(() => db.exec(`INSERT INTO "erp_stock__opening_receipt"(id,product_id,warehouse_id,warehouse_source_id,product_source_id,command_id,
        movement_id,outcome,target,previous_quantity,adjustment,unit,source_hash,source_version,source_seen_at,occurred_on,actor,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, rid, r.product!.id, warehouse, source, r.product_source_id, command, mid, outcome,
        toScaled(r.target!, 6).toString(), toScaled(r.current.quantity ?? "0", 6).toString(), toScaled(r.adjustment!, 6).toString(),
        r.product!.unit, r.source.source_hash, r.source.source_version, seen, day, user, createdAt));
    }
    return { product_source_id: item.product_source_id, product_id: item.product_id, outcome, reason: why, target: item.target,
      adjustment: outcome === "skipped" ? null : r.adjustment, movement_id: mid, receipt_id: rid };
  });
  const receipt = { command_id: command, warehouse_source_id: source, warehouse_id: warehouse, occurred_on: day, preview_hash: preview,
    completed_at: jsonTimestamp(ctx.clock.next()), items: results,
    summary: Object.fromEntries(["adopted", "adopted_zero", "skipped"].map(k => [k, results.filter(r => r.outcome === k).length])) };
  const result = { scope: "stock_opening_command", profile: PROFILE, data_mode: "erp_native", receipt };
  db.exec(`INSERT INTO "erp_stock__opening_command"(id,actor,request_hash,warehouse_source_id,occurred_on,preview_hash,result,created_at)
    VALUES(?,?,?,?,?,?,?,?)`, command, user, hash, source, day, preview, JSON.stringify(result), ctx.clock.next().toString());
  for (const insert of receipts) insert();
  openingAccess(db, user);
  return { ...result, current: openingCurrent(db, command), replayed: false };
});
