// Reservas de estoque do pedido de venda: public.erp_stock_reservation_get,
// _command, _preview e erp_stock_product_reservations, com reservation_dto,
// reservation_current, reservation_lock e reservation_preview.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { deferForeignKeys } from "../../../engine/fk.ts";
import { arrow, jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireRpcParts } from "../../../engine/parts-gate.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim, pgCompareText } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import * as documents from "../../documents/public.ts";
import type { Row } from "../document-guards.ts";
import { ignoredWarehouse } from "../home.ts";
import { QTY, requireAccess, reservationWriteAccess, sha256 } from "../internal.ts";
import { EXACT, reserveSituationIds, settingsDto, situationReservations } from "../read.ts";
import { availability } from "./balances.ts";
import { bumpDocumentVersion, documentLock, documentMeta, documentPreviewData, documentSummary, erpDocumentStockPost } from "./document-stock.ts";

const t6 = (v: bigint) => formatScaled(v, QTY);
const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(v as number));
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const dec6 = (v: unknown) => toScaled(String(v), QTY);
const abs = (v: bigint) => (v < 0n ? -v : v);

/** erp_stock.reservation_dto(p_id) */
export function reservationDto(db: SqlDriver, id: string) {
  const r = one(db, 'SELECT * FROM "erp_stock__reservation" WHERE id=?', id);
  if (!r) return null;
  const snapshot = parse(r.snapshot) as Record<string, any> | null;
  const consumed = (r.consumed_command_id as string | null) ?? null;
  return {
    id: r.id,
    document_id: r.document_id,
    source_document_version: r.source_document_version,
    version: r.version,
    state: r.state,
    created_at: ts(r.created_at),
    occurred_on: arrow(snapshot, "occurred_on"),
    reason: arrow(snapshot, "reason"),
    warehouse_id: snapshot?.document?.warehouse_id ?? null,
    positions: snapshot?.positions ?? null,
    ignored: snapshot?.ignored ?? null,
    closed_at: ts(r.closed_at),
    close_reason: r.close_reason ?? null,
    movement_id: consumed === null ? null : one(db, 'SELECT id FROM "erp_stock__movement" WHERE command_id=?', consumed)?.id ?? null,
    posting_id: consumed === null ? null : one(db, 'SELECT id FROM "erp_stock__document_posting" WHERE command_id=?', consumed)?.id ?? null,
  };
}

/** erp_stock.reservation_current(p_document): o pedido de venda e a reserva ativa. */
export function reservationCurrent(db: SqlDriver, document: string) {
  if (!one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, document)) return null;
  const active = one(db, `SELECT id FROM "erp_stock__reservation" WHERE document_id=? AND state='active'`, document);
  return { document: documentSummary(db, document), active_reservation: active ? reservationDto(db, String(active.id)) : null };
}

/** erp_stock.reservation_lock: o pedido na versão esperada e a reserva ativa na versão esperada. */
export function reservationLock(db: SqlDriver, actor: string, document: string | null, version: number | null, reservation: string | null, reservationVersion: number | null): Row {
  const d = documentLock(db, actor, "sales_orders", document, version);
  if (reservation !== null) {
    const r = one(db, 'SELECT version, state FROM "erp_stock__reservation" WHERE id=? AND document_id=?', reservation, d.id);
    if (!r) raise("P0002", "erp_stock_reservation_not_found");
    if (reservationVersion === null || reservationVersion !== r.version || r.state !== "active") raise("40001", "erp_stock_reservation_conflict");
  }
  requireAccess(db, actor, true);
  return d;
}

/** erp_stock.reservation_preview(d, p_action, p_day, p_reason, p_id): a conferência de reservar, liberar ou baixar. */
export function reservationPreview(ctx: RpcContext, d: Row, action: string | null, day: string | null, reason: string | null, id: string | null, applying = false) {
  requireRpcParts(ctx, applying ? "erp_stock_reservation_apply" : "erp_stock_reservation_preview", {
    p_document_id: d.id, p_action: action, p_reservation_id: id,
  });
  const db = ctx.db;
  documentMeta(day, reason);
  if (action === null || !["reserve", "release", "consume"].includes(action) || (action === "reserve") !== (id === null))
    raise("22023", "erp_stock_reservation_invalid_action");
  let base: Record<string, any> | null;
  let r: Row | undefined;
  let ignored: unknown;
  if (action === "reserve") {
    if (!["verified", "in_progress"].includes(String(d.status)) || one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active'`, d.id))
      raise("40001", "erp_stock_reservation_ineligible");
    base = documentPreviewData(ctx, d, day, reason);
    ignored = base.ignored;
  } else if (action === "consume") {
    r = one(db, `SELECT * FROM "erp_stock__reservation" WHERE id=? AND document_id=? AND state='active'`, id, d.id);
    base = documentPreviewData(ctx, d, day, reason);
    ignored = base.ignored;
    const snapIgnored = r ? (parse(r.snapshot) as Record<string, unknown> | null)?.ignored : undefined;
    const items = db.exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q, unit FROM "erp_stock__reservation_item" WHERE reservation_id=?', id).rows;
    const positions = base.positions as Record<string, unknown>[];
    const key = (p: unknown, w: unknown) => `${String(p).toLowerCase()}|${String(w).toLowerCase()}`;
    const byKey = new Map(items.map((i) => [key(i.product_id, i.warehouse_id), i]));
    const seen = new Set<string>();
    let changed = snapIgnored === undefined || jsonbText(ignored ?? null) !== jsonbText(snapIgnored ?? null);
    for (const j of positions) {
      const k = key(j.product_id, j.warehouse_id);
      seen.add(k);
      const i = byKey.get(k);
      if (!i || fromColumn(i.q) !== -dec6(j.quantity) || i.unit !== j.unit) changed = true;
    }
    if ([...byKey.keys()].some((k) => !seen.has(k))) changed = true;
    if (changed) raise("40001", "erp_stock_reservation_content_changed");
  } else {
    r = one(db, `SELECT * FROM "erp_stock__reservation" WHERE id=? AND document_id=? AND state='active'`, id, d.id);
    base = r ? (parse(r.snapshot) as Record<string, any>) : null;
    ignored = base?.ignored ?? null;
  }
  if (action !== "reserve" && (!r || day! < String((parse(r.snapshot) as Record<string, unknown>).occurred_on)))
    raise("22023", "erp_stock_reservation_invalid_date");
  const positions: Record<string, unknown>[] = [];
  for (const row of (base?.positions ?? []) as Record<string, unknown>[]) {
    const qty = abs(dec6(row.quantity));
    const a = availability(db, String(row.product_id).toLowerCase(), String(d.warehouse_id));
    if (a.state !== "recorded") raise("40001", "erp_stock_position_unavailable");
    const physical = dec6(a.physical_quantity),
      reserved = dec6(a.reserved_quantity),
      available = physical - reserved;
    if ((action === "reserve" && qty > available) || (action !== "reserve" && qty > reserved)) raise("40001", "erp_stock_available_quantity_insufficient");
    positions.push({
      product_id: row.product_id,
      product_name: row.product_name,
      warehouse_id: d.warehouse_id,
      unit: row.unit,
      quantity: t6(qty),
      sources: row.sources,
      catalog_version: one(db, 'SELECT version FROM "erp_catalog__record" WHERE id=?', String(row.product_id).toLowerCase())?.version ?? null,
      physical_version: a.physical_version,
      reservation_hash: a.reservation_hash,
      physical_before: t6(physical),
      reserved_before: t6(reserved),
      available_before: t6(available),
      physical_after: t6(physical - (action === "consume" ? qty : 0n)),
      reserved_after: t6(reserved + (action === "reserve" ? qty : -qty)),
      available_after: t6(available + (action === "reserve" ? -qty : action === "release" ? qty : 0n)),
    });
  }
  const out = {
    action,
    document: documentSummary(db, String(d.id)),
    reservation_id: id,
    reservation_version: id !== null ? (r?.version ?? null) : null,
    occurred_on: day,
    reason,
    positions,
    ignored: ignored ?? null,
  };
  return { ...out, preview_hash: sha256(jsonbText(out)) };
}

/** erp_stock.reservation_command_start: replay do comando de reserva (ou null). */
function reservationCommandStart(db: SqlDriver, actor: string, command: string | null, data: unknown) {
  requireAccess(db, actor, true);
  if (command === null) raise("22023", "erp_stock_command_required");
  requireAccess(db, actor, true);
  const hash = sha256(jsonbText({ actor, data }));
  const c = one(db, 'SELECT actor, request_hash, result FROM "erp_stock__reservation_command" WHERE id=?', command);
  if (c) {
    if (c.actor !== actor || c.request_hash !== hash) raise("40001", "erp_stock_command_conflict");
    return parse(c.result);
  }
  if (one(db, 'SELECT 1 x FROM "erp_stock__document_command" WHERE id=?', command) || one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command))
    raise("40001", "erp_stock_command_conflict");
  return null;
}

/** public.erp_stock_reservation_apply: reservar, liberar ou baixar (a baixa lança o estoque do pedido). */
export function erpStockReservationApply(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_stock_reservation_apply", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const document = str(a.p_document_id),
    version = int(a.p_expected_version),
    command = str(a.p_command_id),
    action = str(a.p_action),
    hash = str(a.p_preview_hash),
    day = str(a.p_occurred_on),
    reason = str(a.p_reason),
    reservation = str(a.p_reservation_id),
    reservationVersion = int(a.p_reservation_version);
  const acknowledged = a.p_ignored_item_ids === undefined || a.p_ignored_item_ids === null ? null : jsonbArg(a.p_ignored_item_ids);
  documents.mirrorRequireVisible(db, user, document, true);
  if (action === null || !["reserve", "release", "consume"].includes(action)) raise("22023", "erp_stock_reservation_invalid_action");
  const data = {
    document_id: document, version, action, preview_hash: hash, occurred_on: day, reason, ignored: acknowledged,
    reservation_id: reservation, reservation_version: reservationVersion,
  };
  const replayed = reservationCommandStart(db, user, command, data);
  if (replayed !== null)
    return { receipt: replayed, current: reservationCurrent(db, document!), replayed: true, data_mode: "erp_native", scope: "stock_reservations" };
  if ((action === "reserve") !== (reservation === null) || (reservation === null && reservationVersion !== null))
    raise("22023", "erp_stock_reservation_invalid_action");
  const d = reservationLock(db, user, document, version, reservation, reservationVersion);
  // Um lançamento manual pode ter gravado o mesmo comando enquanto este esperava.
  if (one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command) || one(db, 'SELECT 1 x FROM "erp_stock__document_command" WHERE id=?', command))
    raise("40001", "erp_stock_command_conflict");
  const preview = reservationPreview(ctx, d, action, day, reason, reservation, true);
  reservationWriteAccess(db, user);
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_stock_reservation_preview_conflict");
  let rid: string;
  if (action === "reserve") {
    if (acknowledged === null || !Array.isArray(acknowledged) || acknowledged.length > 250) raise("22023", "erp_stock_ignored_ack_required");
    // jsonb_agg(value order by value): ordem do jsonb (texto em bytes; os ids do aceite são texto).
    const ack = jsonbText([...(acknowledged as unknown[])].sort((x, y) => compareJsonb(x, y)));
    const wanted = jsonbText(((preview.ignored ?? []) as Record<string, unknown>[]).map((i) => i.id).sort((x, y) => compareJsonb(x, y)));
    if (ack !== wanted) raise("22023", "erp_stock_ignored_ack_required");
    documents.mirrorGuardEffect(db, d.id); // aa_mirror_authority (guard_effect)
    documents.guardTrashChild(db, String(d.id)); // guard_trash
    rid = crypto.randomUUID();
    const { preview_hash: _h, ...snapshot } = preview;
    db.exec(
      'INSERT INTO "erp_stock__reservation"(id, document_id, source_document_version, snapshot, preview_hash, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?)',
      rid,
      d.id,
      d.version,
      JSON.stringify(snapshot),
      hash,
      user,
      command,
      ctx.clock.next().toString(),
    );
    for (const j of preview.positions)
      db.exec(
        'INSERT INTO "erp_stock__reservation_item"(reservation_id, product_id, warehouse_id, unit, quantity) VALUES(?,?,?,?,?)',
        rid,
        String(j.product_id).toLowerCase(),
        String(j.warehouse_id).toLowerCase(),
        j.unit,
        toScaled(String(j.quantity), QTY).toString(),
      );
  } else {
    if (a.p_ignored_item_ids !== undefined && a.p_ignored_item_ids !== null) raise("22023", "erp_stock_reservation_invalid_ack");
    rid = reservation!;
    // A baixa aponta consumed_command_id para o movimento que o lançamento cria logo
    // depois (FK adiada no Postgres): FK adiada até o fim, conferida antes do COMMIT.
    if (action === "consume") deferForeignKeys(ctx, "erp_stock__reservation");
    const old = one(db, 'SELECT state, document_id FROM "erp_stock__reservation" WHERE id=?', rid);
    // aa_mirror_authority (guard_effect): OLD e NEW, o mesmo documento.
    if (old) documents.mirrorGuardEffect(db, old.document_id);
    // immutable_reservation (guard_reservation): só active → released/consumed, versão 2.
    if (!old || old.state !== "active") raise("40001", "erp_stock_reservation_immutable");
    db.exec(
      `UPDATE "erp_stock__reservation" SET state=?, version=2, closed_by=?, closed_at=?, close_reason=?, close_command_id=?, consumed_command_id=? WHERE id=?`,
      action === "consume" ? "consumed" : "released",
      user,
      ctx.clock.next().toString(),
      pgBtrim(reason!),
      command,
      action === "consume" ? command : null,
      rid,
    );
  }
  if (action === "consume") {
    const physical = documentPreviewData(ctx, d, day, reason);
    const wanted = physical.ignored.map((i) => i.id).sort((x, y) => compareJsonb(x, y));
    erpDocumentStockPost(ctx, {
      p_user_id: user, p_kind: "sales_orders", p_document_id: d.id, p_expected_version: d.version, p_command_id: command,
      p_preview_hash: physical.preview_hash, p_occurred_on: day, p_reason: reason, p_ignored_item_ids: wanted,
    });
  } else bumpDocumentVersion(ctx, String(d.id), user);
  const receipt = { command_id: command, action, document_id: d.id, document_version: Number(d.version) + 1, reservation: reservationDto(db, rid) };
  // aa_mirror_authority (guard_effect) no recibo e na auditoria do Documentos.
  documents.mirrorGuardEffect(db, d.id);
  db.exec(
    'INSERT INTO "erp_stock__reservation_command"(id, actor, document_id, request_hash, result, created_at) VALUES(?,?,?,?,?,?)',
    command,
    user,
    d.id,
    sha256(jsonbText({ actor: user, data })),
    JSON.stringify(receipt),
    ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, after_data, created_at) VALUES(?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"),
    user,
    command,
    d.id,
    `stock_reservation_${action}`,
    JSON.stringify(receipt),
    ctx.clock.next().toString(),
  );
  return { receipt, current: reservationCurrent(db, String(d.id)), replayed: false, data_mode: "erp_native", scope: "stock_reservations" };
}

/** Ordem do jsonb para os valores do aceite (ids em texto; outro tipo só ordena por tipo e texto). */
function compareJsonb(x: unknown, y: unknown): number {
  const tx = typeof x,
    ty = typeof y;
  if (tx !== ty) return tx < ty ? -1 : 1;
  if (tx === "string") return pgCompareText(x as string, y as string);
  return jsonbText(x) < jsonbText(y) ? -1 : jsonbText(x) > jsonbText(y) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// RPCs

registerRpc("erp_stock_reservation_apply", erpStockReservationApply);

registerRpc("erp_stock_reservation_get", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const document = str(a.p_document_id),
    limit = int(a.p_limit),
    after = str(a.p_after);
  documents.mirrorRequireVisible(db, user, document, false);
  requireAccess(db, user, false);
  if (document === null || !one(db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, document)) raise("P0002", "erp_document_not_found");
  if (limit === null || limit < 1 || limit > 25) raise("22023", "erp_stock_invalid_query");
  const page = db
    .exec('SELECT id FROM "erp_stock__reservation" WHERE document_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?', document, after, after?.toLowerCase() ?? null, limit + 1)
    .rows.map((r) => String(r.id));
  const shown = page.slice(0, limit);
  const items = shown.map((id) => {
    const { positions, ignored, ...rest } = reservationDto(db, id)!;
    return { ...rest, positions_count: Array.isArray(positions) ? positions.length : null, ignored_count: Array.isArray(ignored) ? ignored.length : null };
  });
  const more = page.length > limit;
  return {
    current: reservationCurrent(db, document),
    items,
    limit,
    has_more: more,
    next_cursor: more ? shown[shown.length - 1] : null,
    data_mode: "erp_native",
    scope: "stock_reservations",
  };
});

registerRpc("erp_stock_reservation_command", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  requireAccess(db, user, false);
  const c = one(db, 'SELECT document_id, result FROM "erp_stock__reservation_command" WHERE id=? AND actor=?', str(a.p_command_id), user);
  if (!c) raise("P0002", "erp_stock_command_not_found");
  return { receipt: parse(c.result), current: reservationCurrent(db, String(c.document_id)), replayed: true, data_mode: "erp_native", scope: "stock_reservations" };
});

registerRpc("erp_stock_reservation_preview", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const action = str(a.p_action),
    reservation = str(a.p_reservation_id),
    reservationVersion = int(a.p_reservation_version);
  documents.mirrorRequireVisible(db, user, str(a.p_document_id), true);
  if (
    action === null || !["reserve", "release", "consume"].includes(action) || (action === "reserve") !== (reservation === null) ||
    (reservation === null && reservationVersion !== null)
  )
    raise("22023", "erp_stock_reservation_invalid_action");
  const d = reservationLock(db, user, str(a.p_document_id), int(a.p_expected_version), reservation, reservationVersion);
  const preview = reservationPreview(ctx, d, action, str(a.p_occurred_on), str(a.p_reason), reservation);
  reservationWriteAccess(db, user);
  return { preview, data_mode: "erp_native", scope: "stock_reservations" };
});

registerRpc("erp_stock_product_reservations", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const product = str(a.p_product_id),
    warehouse = str(a.p_warehouse_id);
  requireAccess(db, user, false);
  if (product === null) raise("22023", "erp_stock_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__product" WHERE record_id=?', product)) raise("P0002", "erp_stock_product_not_found");
  if (warehouse !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__warehouse" WHERE record_id=?', warehouse)) raise("P0002", "erp_stock_warehouse_not_found");
  interface Line {
    id: string | null;
    source: "reservation" | "situation";
    document_id: string;
    number: number;
    status: string;
    contact_name: string | null;
    warehouse_id: string | null;
    quantity: bigint; // escala 30
    unit: string | null;
    created_at: unknown;
  }
  const rows: Line[] = db
    .exec(
      `SELECT r.id, d.id document_id, d.number, d.status, d.contact_snapshot, i.warehouse_id, CAST(i.quantity AS TEXT) q, i.unit, r.created_at
         FROM "erp_stock__reservation" r JOIN "erp_stock__reservation_item" i ON i.reservation_id=r.id JOIN "erp_documents__document" d ON d.id=r.document_id
        WHERE r.state='active' AND i.product_id=? AND (? IS NULL OR i.warehouse_id=?)`,
      product,
      warehouse,
      warehouse,
    )
    .rows.map((r) => ({
      id: String(r.id),
      source: "reservation" as const,
      document_id: String(r.document_id),
      number: Number(r.number),
      status: String(r.status),
      contact_name: arrow(parse(r.contact_snapshot), "name"),
      warehouse_id: (r.warehouse_id as string | null) ?? null,
      quantity: rescale(fromColumn(r.q), QTY, EXACT),
      unit: (r.unit as string | null) ?? null,
      created_at: r.created_at,
    }));
  for (const x of situationReservations(db, product))
    if (warehouse === null || x.warehouse_id === warehouse || x.warehouse_id === null)
      rows.push({
        id: null,
        source: "situation",
        document_id: x.document_id,
        number: Number(x.number),
        status: x.status,
        contact_name: x.contact_name,
        warehouse_id: x.warehouse_id,
        quantity: x.quantity,
        unit: x.unit,
        created_at: null,
      });
  // order by number desc, source, id (id nulo por último)
  rows.sort(
    (x, y) =>
      y.number - x.number || pgCompareText(x.source, y.source) || (x.id === y.id ? 0 : x.id === null ? 1 : y.id === null ? -1 : pgCompareText(x.id, y.id)),
  );
  const q6 = (v: bigint) => t6(rescale(v, EXACT, QTY));
  const items = rows.slice(0, 100).map((r) => {
    const situation =
      r.source === "situation"
        ? one(
            db,
            'SELECT x.id, x.name FROM "erp_documents__document_situation" ds JOIN "erp_preferences__situation" x ON x.id=ds.situation_id WHERE ds.document_id=?',
            r.document_id,
          )
        : undefined;
    return {
      reservation_id: r.id,
      source: r.source,
      document_id: r.document_id,
      document_number: String(r.number),
      status: r.status,
      contact_name: r.contact_name,
      warehouse_id: r.warehouse_id,
      warehouse_ignored: r.warehouse_id !== null ? ignoredWarehouse(db, r.warehouse_id) : false,
      quantity: q6(r.quantity),
      unit: r.unit,
      reserved_at: ts(r.created_at),
      situation_id: situation?.id ?? null,
      situation_name: situation?.name ?? null,
    };
  });
  const s = settingsDto(db);
  return {
    product_id: product,
    warehouse_id: warehouse,
    items,
    total: rows.length,
    quantity: q6(rows.reduce((t, r) => t + r.quantity, 0n)),
    reservation: { by_situation: s.reserve_by_situation, by_warehouse: s.reserve_by_warehouse, statuses: s.reserve_statuses, situation_ids: reserveSituationIds(db) },
    scope: "stock_product_reservations",
    data_mode: "erp_native",
  };
});
