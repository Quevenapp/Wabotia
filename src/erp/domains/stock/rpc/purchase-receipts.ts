// Recebimento de compra por item (erp_purchase_receipts): public.
// erp_purchase_receipts_preview, _receive, _reverse_preview, _reverse, _get e
// _command, com access, lock_document, preview, apply_warehouse, received,
// record, document, current e chain_hash.
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn, toScaled } from "../../../engine/dec.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { deferForeignKeys } from "../../../engine/fk.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim, pgCompareText } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import * as documents from "../../documents/public.ts";
import type { Row } from "../document-guards.ts";
import { QTY, QTY_MAX, balanceKept, negativeAllowed, reservedQuantity, sha256 } from "../internal.ts";
import { invoicePostedForDocument, reservationPositionHash } from "../read.ts";
import { bumpDocumentVersion, documentEligible, documentMeta } from "./document-stock.ts";
import { post } from "./erp_stock_post.ts";

const t6 = (v: bigint) => formatScaled(v, QTY);
const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));
const UUID_LOWER = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ITEM_QTY = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const MAX_VERSION = 2147483647;
const DOC = "erp_documents__document";

/** erp_purchase_receipts.access(p_actor, p_lock): admin ou estoque ativo. */
export function access(db: SqlDriver, actor: string | null) {
  if (actor === null || !one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role IN ('admin','estoque')`, actor))
    raise("42501", "purchase_receipt_access_denied");
}

/** erp_purchase_receipts.received(p_document, p_item): o recebido do item, sem os estornados. */
export function received(db: SqlDriver, document: string, item: string): bigint {
  let total = 0n;
  for (const r of db.exec(
    `SELECT r.snapshot FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`,
    document,
  ).rows) {
    const items = ((parse(r.snapshot) as Record<string, unknown>)?.items ?? []) as Record<string, unknown>[];
    for (const i of items) if (i.item_id === item) total += toScaled(String(i.quantity), QTY);
  }
  return total;
}

/** erp_purchase_receipts.chain_hash(p_document): a cadeia de recebimentos e estornos do pedido. */
function chainHash(db: SqlDriver, document: string): string {
  const rows = db.exec(
    `SELECT r.id, r.command_id, r.preview_hash, r.document_version, x.id xid, x.command_id xcommand, x.preview_hash xhash, x.document_version xversion
       FROM "erp_purchase_receipts__receipt" r LEFT JOIN "erp_purchase_receipts__reversal" x ON x.receipt_id=r.id WHERE r.document_id=?`,
    document,
  ).rows;
  rows.sort((a, b) => pgCompareText(String(a.id), String(b.id)));
  return sha256(
    jsonbText(rows.map((r) => [r.id, r.command_id, r.preview_hash, r.document_version, r.xid ?? null, r.xcommand ?? null, r.xhash ?? null, r.xversion ?? null])),
  );
}

/** erp_purchase_receipts.document(p_id): o pedido de compra (null fora dele). */
function documentDto(db: SqlDriver, id: string) {
  const d = one(db, `SELECT id, kind, number, version, status, body, warehouse_id FROM "${DOC}" WHERE id=? AND kind='purchase_orders'`, id);
  if (!d) return null;
  const posted = !!one(db, 'SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=?', id);
  const anyReceipt = !!one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" WHERE document_id=?', id);
  const body = parse(d.body) as Record<string, unknown> | null;
  const date = body?.date;
  return {
    id: d.id,
    kind: d.kind,
    number: String(d.number),
    version: d.version,
    status: d.status,
    date: date === undefined || date === null ? null : typeof date === "string" ? date : jsonbText(date),
    warehouse_id: d.warehouse_id ?? null,
    eligible: documentEligible(d.kind, d.status) && !posted,
    mode: posted ? "legacy_full" : anyReceipt ? "item_receipts" : "available",
    chain_hash: chainHash(db, id),
    active_receipts: Number(
      one(db, `SELECT count(*) n FROM "erp_purchase_receipts__receipt" r WHERE r.document_id=? AND NOT EXISTS(SELECT 1 FROM "erp_purchase_receipts__reversal" x WHERE x.receipt_id=r.id)`, id)!.n,
    ),
  };
}

/** erp_purchase_receipts.current(p_id): o pedido e os itens com o recebido e o que falta. */
export function current(db: SqlDriver, id: string) {
  const posted = !!one(db, 'SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=?', id);
  const items = posted
    ? []
    : db
        .exec(
          `SELECT i.id, i.position, i.product_id, i.data, CAST(i.quantity AS TEXT) q, r.version, r.active, p.kind, p.format, p.unit
             FROM "erp_documents__item" i LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
            WHERE i.document_id=? ORDER BY i.position`,
          id,
        )
        .rows.map((i) => {
          const data = parse(i.data) as Record<string, unknown> | null;
          const qty = i.q === null ? null : fromColumn(i.q);
          const got = received(db, id, String(i.id));
          const unit = data?.unit === undefined || data?.unit === null ? null : typeof data.unit === "string" ? data.unit : jsonbText(data.unit);
          return {
            item_id: i.id,
            position: i.position,
            product_id: i.product_id ?? null,
            description: data?.description === undefined || data?.description === null ? null : typeof data.description === "string" ? data.description : jsonbText(data.description),
            unit,
            ordered_quantity: qty === null ? null : t6(qty),
            received_quantity: t6(got),
            remaining_quantity: qty === null ? null : t6(qty - got),
            catalog_version: i.version ?? null,
            eligibility:
              i.product_id === null ? "unlinked_item"
              : i.kind === "S" ? "service"
              : !i.active ? "inactive_product"
              : i.kind !== "P" || i.format === "E" || i.format === "V" || i.unit === null ? "unsupported_product"
              : i.unit !== unit ? "unit_mismatch"
              : "eligible",
          };
        });
  return { document: documentDto(db, id), items };
}

/** erp_purchase_receipts.record(p_id, p_reverse, p_full): o recebimento (ou o estorno), como to_jsonb da linha. */
function record(db: SqlDriver, id: string, reverse = false, full = true) {
  const r = one(db, `SELECT * FROM "${reverse ? "erp_purchase_receipts__reversal" : "erp_purchase_receipts__receipt"}" WHERE id=?`, id);
  if (!r) return null;
  const s = (parse(r.snapshot) ?? {}) as Record<string, any>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : null);
  return {
    id: r.id,
    document_id: r.document_id,
    source_document_version: r.source_document_version,
    document_version: r.document_version,
    command_id: r.command_id,
    movement_id: r.movement_id,
    occurred_on: s.occurred_on ?? null,
    reason: s.reason ?? null,
    created_at: jsonTimestamp(r.created_at as number),
    warehouse_id: s.warehouse?.id ?? null,
    item_count: len(s.items),
    position_count: len(s.positions),
    preview_hash: r.preview_hash,
    ...(full ? { items: s.items ?? null, positions: s.positions ?? null } : {}),
    ...(reverse ? { receipt_id: r.receipt_id } : {}),
  };
}

/** erp_purchase_receipts.lock_document: o pedido de compra na versão esperada. */
export function lockDocument(db: SqlDriver, actor: string, document: string | null, version: number | null): Row {
  access(db, actor);
  if (document === null || version === null || version < 1 || version > 2147483646) raise("22023", "purchase_receipt_input_invalid");
  const d = one(db, `SELECT * FROM "${DOC}" WHERE id=? AND kind='purchase_orders'`, document);
  access(db, actor);
  if (!d) raise("P0002", "purchase_receipt_document_not_found");
  if (d.version !== version) raise("40001", "purchase_receipt_document_changed");
  return d;
}

/** erp_purchase_receipts.preview(p_actor, d, p_action, p_day, p_reason, p_items, p_receipt) */
export function preview(ctx: RpcContext, actor: string, d: Row, action: string | null, day: string | null, reason: string | null, items: unknown, receipt: string | null) {
  const db = ctx.db;
  // 277: o recebimento leva a data da preferência (hoje, ou a prevista/a do pedido); outra data é recusada.
  if (action === "receive") {
    const launch = documents.stockLaunchDate(db, String(d.id));
    day = day ?? launch;
    if (day !== launch) raise("22023", "purchase_receipt_launch_date_mismatch");
  }
  documentMeta(day, reason);
  if (action === null || !["receive", "reverse"].includes(action)) raise("22023", "purchase_receipt_input_invalid");
  if (one(db, 'SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=?', d.id)) raise("40001", "purchase_receipt_legacy_mode");
  let selection: { item_id: unknown; quantity: unknown }[];
  let r: Row | undefined;
  if (action === "receive") {
    if (!documentEligible(d.kind, d.status)) raise("40001", "purchase_receipt_ineligible_state");
    if (!Array.isArray(items) || items.length < 1 || items.length > 250 || new TextEncoder().encode(jsonbText(items)).length > 131072)
      raise("22023", "purchase_receipt_items_invalid");
    for (const j of items as Record<string, unknown>[])
      if (
        jsonType(j) !== "object" || jsonType(j.item_id) !== "string" || !UUID_LOWER.test(String(j.item_id)) ||
        jsonType(j.quantity) !== "string" || !ITEM_QTY.test(String(j.quantity)) || Object.keys(j).some((k) => k !== "item_id" && k !== "quantity")
      )
        raise("22023", "purchase_receipt_items_invalid");
    const list = items as { item_id: string; quantity: string }[];
    if (
      list.some((j) => toScaled(j.quantity, QTY) <= 0n) ||
      new Set(list.map((j) => j.item_id)).size !== list.length ||
      list.some((j) => !one(db, 'SELECT 1 x FROM "erp_documents__item" WHERE id=? AND document_id=?', j.item_id, d.id))
    )
      raise("22023", "purchase_receipt_items_invalid");
    selection = list;
  } else {
    r = one(db, 'SELECT * FROM "erp_purchase_receipts__receipt" WHERE id=? AND document_id=?', receipt, d.id);
    if (!r) raise("P0002", "purchase_receipt_not_found");
    if (one(db, 'SELECT 1 x FROM "erp_purchase_receipts__reversal" WHERE receipt_id=?', r.id)) raise("40001", "purchase_receipt_already_reversed");
    const snap = parse(r.snapshot) as Record<string, any>;
    if (day! < String(snap.occurred_on)) raise("22023", "purchase_receipt_reversal_date_invalid");
    selection = ((snap.items ?? []) as Record<string, unknown>[]).map((j) => ({ item_id: j.item_id, quantity: j.quantity }));
  }
  access(db, actor);
  // 259: o pedido cuja nota de entrada lançou o estoque não é recebido de novo.
  if (action === "receive" && invoicePostedForDocument(db, String(d.id))) raise("40001", "purchase_receipt_posted_by_invoice");
  const w = one(db, 'SELECT c.id, c.name, c.version, c.active FROM "erp_catalog__record" c JOIN "erp_catalog__warehouse" x ON x.record_id=c.id WHERE c.id=?', d.warehouse_id ?? null);
  if (!w || (action === "receive" && !w.active)) raise("22023", "purchase_receipt_warehouse_unavailable");
  const wanted = new Map(selection.map((j) => [String(j.item_id), String(j.quantity)]));
  const rows = db
    .exec(
      `SELECT i.id, i.position, i.product_id, i.data, CAST(i.quantity AS TEXT) q, c.active, c.version catalog_version, p.unit product_unit, p.kind product_kind, p.format
         FROM "erp_documents__item" i LEFT JOIN "erp_catalog__record" c ON c.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
        WHERE i.document_id=? ORDER BY i.position`,
      d.id,
    )
    .rows.filter((i) => wanted.has(String(i.id)));
  const lines: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.product_id === null || row.product_kind !== "P" || row.product_unit === null || (action === "receive" && (!row.active || row.format === "E" || row.format === "V")))
      raise("22023", "purchase_receipt_product_unavailable");
    const data = parse(row.data) as Record<string, unknown> | null;
    const unit = data?.unit === undefined || data?.unit === null ? null : typeof data.unit === "string" ? data.unit : jsonbText(data.unit);
    if (row.product_unit !== unit) raise("22023", "purchase_receipt_unit_mismatch");
    const qty = toScaled(wanted.get(String(row.id))!, QTY) * (action === "receive" ? 1n : -1n);
    const net = received(db, String(d.id), String(row.id));
    const ordered = row.q === null ? null : fromColumn(row.q);
    if (net + qty < 0n || (ordered !== null && net + qty > ordered)) raise("40001", "purchase_receipt_quantity_exceeded");
    lines.push({
      item_id: row.id,
      position: row.position,
      product_id: row.product_id,
      unit: row.product_unit,
      ordered_quantity: ordered === null ? null : t6(ordered),
      quantity: t6(qty),
      received_before: t6(net),
      received_after: t6(net + qty),
      remaining_after: ordered === null ? null : t6(ordered - net - qty),
    });
  }
  if (lines.length !== selection.length) raise("40001", "purchase_receipt_items_changed");
  const movement = r ? String(r.movement_id) : null;
  const kept = (product: string) => action === "reverse" && movement !== null && balanceKept(db, movement, product, String(w.id));
  const groups = new Map<string, bigint>();
  for (const l of lines) groups.set(String(l.product_id), (groups.get(String(l.product_id)) ?? 0n) + toScaled(String(l.quantity), QTY));
  const balance = (product: string) => one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, w.id);
  for (const [product, qty] of groups) {
    const b = balance(product);
    const before = b ? fromColumn(b.q) : 0n;
    const reserved = reservedQuantity(db, product, String(w.id));
    const bad =
      (qty < 0n && before + qty < 0n && !negativeAllowed(db)) || before + qty > QTY_MAX || before + qty < -QTY_MAX || (qty < 0n && reserved > 0n && before + qty - reserved < 0n);
    if ((bad && !kept(product)) || b?.version === MAX_VERSION) raise("40001", "purchase_receipt_balance_unavailable");
  }
  const positions = [...groups.entries()]
    .sort((x, y) => pgCompareText(x[0], y[0]))
    .map(([product, qty]) => {
      const c = one(db, 'SELECT r.name, r.version, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?', product);
      if (!c) return null;
      const b = balance(product);
      const before = b ? fromColumn(b.q) : 0n;
      const reserved = reservedQuantity(db, product, String(w.id));
      return {
        product_id: product,
        product_name: c.name,
        warehouse_id: w.id,
        unit: c.unit,
        quantity: t6(qty),
        catalog_version: c.version,
        physical_version: b ? b.version : 0,
        reservation_hash: reservationPositionHash(db, product, String(w.id)),
        physical_before: t6(before),
        reserved_before: t6(reserved),
        available_before: t6(before - reserved),
        physical_after: t6(before + qty),
        available_after: t6(before + qty - reserved),
        ...(kept(product) ? { balance_kept: true } : {}),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (positions.length < 1 || positions.length > 100) raise("22023", "purchase_receipt_position_limit");
  for (const j of positions) {
    const q = toScaled(j.quantity, QTY),
      after = toScaled(j.physical_after, QTY),
      reserved = toScaled(j.reserved_before, QTY),
      available = toScaled(j.available_after, QTY);
    const bad = (q < 0n && after < 0n && !negativeAllowed(db)) || after > QTY_MAX || after < -QTY_MAX || (q < 0n && reserved > 0n && available < 0n);
    if ((bad && !kept(j.product_id)) || j.physical_version === MAX_VERSION) raise("40001", "purchase_receipt_balance_unavailable");
  }
  const result = {
    action,
    document: documentDto(db, String(d.id)),
    receipt_id: receipt,
    occurred_on: day,
    reason: pgBtrim(reason!),
    warehouse: { id: w.id, name: w.name, version: w.version, active: !!w.active },
    items: lines,
    positions,
  };
  return { ...result, preview_hash: sha256(jsonbText(result)) };
}

/**
 * erp_purchase_receipts.apply_warehouse: receber ou estornar (184: o depósito
 * escolhido, só quando o pedido não tem ou é o mesmo; no estorno, o do recebimento).
 */
export function applyWarehouse(
  ctx: RpcContext,
  actor: string,
  document: string | null,
  version: number | null,
  action: string | null,
  day: string | null,
  reason: string | null,
  items: unknown,
  receipt: string | null,
  command: string | null,
  hash: string | null,
  confirm: boolean | null,
  warehouse: string | null,
) {
  const db = ctx.db;
  access(db, actor);
  if (command === null || confirm !== true || hash === null || !/^[a-f0-9]{64}$/.test(hash) || action === null || !["receive", "reverse"].includes(action))
    raise("22023", "purchase_receipt_input_invalid");
  const requestHash = sha256(
    jsonbText({
      actor, document_id: document, version, action, occurred_on: day, reason, items: items ?? null, receipt_id: receipt, preview_hash: hash, confirm,
      ...(warehouse === null ? {} : { warehouse_id: warehouse }),
    }),
  );
  access(db, actor);
  const c = one(db, 'SELECT actor, request_hash, result, document_id FROM "erp_purchase_receipts__command" WHERE id=?', command);
  if (c) {
    access(db, actor);
    if (c.actor !== actor || c.request_hash !== requestHash) raise("40001", "purchase_receipt_command_conflict");
    return { scope: "purchase_receipts", data_mode: "erp_native", receipt: parse(c.result), current: current(db, String(c.document_id)), replayed: true };
  }
  const d = { ...lockDocument(db, actor, document, version) };
  if (action === "receive" && warehouse !== null) {
    if (d.warehouse_id !== null && d.warehouse_id !== undefined && d.warehouse_id !== warehouse) raise("22023", "purchase_receipt_warehouse_conflict");
    d.warehouse_id = warehouse;
  } else if (action === "reverse") {
    const r = one(db, 'SELECT snapshot FROM "erp_purchase_receipts__receipt" WHERE id=? AND document_id=?', receipt, d.id);
    const w = r ? (parse(r.snapshot) as Record<string, any>)?.warehouse?.id : undefined;
    if (w !== undefined && w !== null) d.warehouse_id = String(w).toLowerCase();
  }
  const p = preview(ctx, actor, d, action, day, reason, items, receipt);
  if (hash !== p.preview_hash) raise("40001", "purchase_receipt_preview_changed");
  if (
    one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command) ||
    one(db, 'SELECT 1 x FROM "erp_stock__document_command" WHERE id=?', command) ||
    one(db, 'SELECT 1 x FROM "erp_stock__reservation_command" WHERE id=?', command)
  )
    raise("40001", "purchase_receipt_command_conflict");
  const lines = [...p.positions]
    .sort((x, y) => pgCompareText(x.product_id, y.product_id))
    .map((j) => ({ product_id: j.product_id, warehouse_id: j.warehouse_id, quantity: j.quantity, expected_version: j.physical_version }));
  const original = action === "reverse" ? String(one(db, 'SELECT movement_id FROM "erp_purchase_receipts__receipt" WHERE id=?', receipt)!.movement_id) : null;
  const movement = post(ctx, {
    user: actor,
    command,
    kind: action === "receive" ? "receipt" : "reversal",
    occurredOn: day,
    reason,
    reference: `Recebimento compra ${String(d.number)}`,
    items: lines,
    reversesId: original,
  }) as { movement: { id: string } };
  const { preview_hash: _h, ...snapshot } = p;
  const id = crypto.randomUUID();
  // command_id → erp_purchase_receipts.command, gravado no fim (FK adiada no Postgres).
  deferForeignKeys(ctx, action === "receive" ? "erp_purchase_receipts__receipt" : "erp_purchase_receipts__reversal");
  // aa_mirror_authority (guard_effect) no recebimento/estorno, e pelo mesmo
  // documento na auditoria do Documentos e no recibo do comando, logo depois.
  documents.mirrorGuardEffect(db, d.id);
  if (action === "receive")
    db.exec(
      'INSERT INTO "erp_purchase_receipts__receipt"(id, document_id, source_document_version, document_version, command_id, movement_id, actor, snapshot, preview_hash, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, d.id, d.version, Number(d.version) + 1, command, movement.movement.id, actor, JSON.stringify(snapshot), hash, ctx.clock.next().toString(),
    );
  else
    db.exec(
      'INSERT INTO "erp_purchase_receipts__reversal"(id, receipt_id, document_id, source_document_version, document_version, command_id, movement_id, actor, snapshot, preview_hash, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, receipt, d.id, d.version, Number(d.version) + 1, command, movement.movement.id, actor, JSON.stringify(snapshot), hash, ctx.clock.next().toString(),
    );
  bumpDocumentVersion(ctx, String(d.id), actor);
  const result = {
    command_id: command,
    action,
    document_id: d.id,
    document_version: Number(d.version) + 1,
    receipt: record(db, action === "receive" ? id : receipt!),
    reversal: action === "reverse" ? record(db, id, true) : null,
  };
  db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, after_data, created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"), actor, command, d.id, `purchase_${action}`, pgBtrim(reason!), JSON.stringify(result), ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_purchase_receipts__command"(id, actor, document_id, action, request_hash, result, created_at) VALUES(?,?,?,?,?,?,?)',
    command, actor, d.id, action, requestHash, JSON.stringify(result), ctx.clock.next().toString(),
  );
  access(db, actor);
  return { scope: "purchase_receipts", data_mode: "erp_native", receipt: result, current: current(db, String(d.id)), replayed: false };
}

// ---------------------------------------------------------------------------
// RPCs

const itemsArg = (v: unknown) => (v === undefined || v === null ? null : jsonbArg(v));
const bool = (v: unknown) => (v === undefined || v === null ? null : v === true || v === "true");

registerRpc("erp_purchase_receipts_preview", (ctx: RpcContext, a: RpcArgs) => {
  const user = a.p_user_id as string;
  documents.mirrorRequireVisible(ctx.db, user, str(a.p_document_id), true);
  const d = lockDocument(ctx.db, user, str(a.p_document_id), int(a.p_expected_version));
  return {
    scope: "purchase_receipts",
    data_mode: "erp_native",
    preview: preview(ctx, user, d, "receive", str(a.p_occurred_on), str(a.p_reason), itemsArg(a.p_items), null),
  };
});

registerRpc("erp_purchase_receipts_reverse_preview", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const receipt = str(a.p_receipt_id);
  documents.mirrorRequireVisible(db, user, str(a.p_document_id), true);
  const d = { ...lockDocument(db, user, str(a.p_document_id), int(a.p_expected_version)) };
  // 184: o depósito do próprio recebimento.
  const r = one(db, 'SELECT snapshot FROM "erp_purchase_receipts__receipt" WHERE id=? AND document_id=?', receipt, d.id);
  const w = r ? (parse(r.snapshot) as Record<string, any>)?.warehouse?.id : undefined;
  if (w !== undefined && w !== null) d.warehouse_id = String(w).toLowerCase();
  return { scope: "purchase_receipts", data_mode: "erp_native", preview: preview(ctx, user, d, "reverse", str(a.p_occurred_on), str(a.p_reason), null, receipt) };
});

registerRpc("erp_purchase_receipts_receive", (ctx: RpcContext, a: RpcArgs) => {
  const user = a.p_user_id as string;
  documents.mirrorRequireVisible(ctx.db, user, str(a.p_document_id), true);
  return applyWarehouse(
    ctx, user, str(a.p_document_id), int(a.p_expected_version), "receive", str(a.p_occurred_on), str(a.p_reason), itemsArg(a.p_items),
    null, str(a.p_command_id), str(a.p_preview_hash), bool(a.p_confirm), null,
  );
});

registerRpc("erp_purchase_receipts_reverse", (ctx: RpcContext, a: RpcArgs) => {
  const user = a.p_user_id as string;
  documents.mirrorRequireVisible(ctx.db, user, str(a.p_document_id), true);
  return applyWarehouse(
    ctx, user, str(a.p_document_id), int(a.p_expected_version), "reverse", str(a.p_occurred_on), str(a.p_reason), null,
    str(a.p_receipt_id), str(a.p_command_id), str(a.p_preview_hash), bool(a.p_confirm), null,
  );
});

registerRpc("erp_purchase_receipts_command", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  access(db, user);
  const c = one(db, 'SELECT document_id, result FROM "erp_purchase_receipts__command" WHERE id=? AND actor=?', str(a.p_command_id), user);
  if (!c) raise("P0002", "purchase_receipt_command_not_found");
  return { scope: "purchase_receipts", data_mode: "erp_native", receipt: parse(c.result), current: current(db, String(c.document_id)), replayed: true };
});

registerRpc("erp_purchase_receipts_get", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = a.p_user_id as string;
  const document = str(a.p_document_id),
    limit = int(a.p_limit),
    after = str(a.p_after),
    selectedId = str(a.p_receipt_id);
  documents.mirrorRequireVisible(db, user, document, false);
  access(db, user);
  if (document === null || limit === null || limit < 1 || limit > 25) raise("22023", "purchase_receipt_input_invalid");
  if (documentDto(db, document) === null) raise("P0002", "purchase_receipt_document_not_found");
  const reversalOf = (receipt: string, full: boolean) => {
    const x = one(db, 'SELECT id FROM "erp_purchase_receipts__reversal" WHERE receipt_id=?', receipt);
    return x ? record(db, String(x.id), true, full) : null;
  };
  let selected: unknown = null;
  if (selectedId !== null) {
    if (!one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" WHERE id=? AND document_id=?', selectedId, document)) raise("P0002", "purchase_receipt_not_found");
    selected = { receipt: record(db, selectedId), reversal: reversalOf(selectedId, true) };
  }
  const candidates = db
    .exec('SELECT id FROM "erp_purchase_receipts__receipt" WHERE document_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?', document, after, after?.toLowerCase() ?? null, limit + 1)
    .rows.map((r) => String(r.id));
  const shown = candidates.slice(0, limit);
  const more = candidates.length > limit;
  return {
    scope: "purchase_receipts",
    data_mode: "erp_native",
    current: current(db, document),
    items: shown.map((id) => ({ receipt: record(db, id, false, false), reversal: reversalOf(id, false) })),
    selected,
    limit,
    has_more: more,
    next_cursor: more ? shown[shown.length - 1] : null,
  };
});
