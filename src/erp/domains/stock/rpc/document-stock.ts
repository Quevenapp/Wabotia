// Lançamento de estoque de documento (pedido de venda, pedido de compra e OS):
// public.erp_document_stock_preview, _post, _reverse_preview e _reverse, com
// as internas do fecho (document_lock, document_preview_data,
// document_reverse_preview_data, document_command_start/_finish, resumos,
// lotes informados nos itens e composição do item). É o caminho do
// erp_document_transition (erp_documents.transition_action, post_stock e
// reverse_stock).
// Fonte: tests/erp/oracle/migrations (versões finais no catálogo do oráculo).
// A mensagem de erro com DETAIL (posição do item: lotes e componente) sai sem
// o DETAIL: o motor devolve só código e mensagem (engine/errors.ts).
import { formatScaled, fromColumn, rescale, toScaled } from "../../../engine/dec.ts";
import { jsonbArg } from "../../../engine/args.ts";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireRpcParts } from "../../../engine/registry.ts";
import { driverContext, originScope, requireOriginOperation, assertOwnEffect } from "../../../engine/module-origin.ts";
import { linkedDocumentGuard } from "../../documents/module-policy.ts";
import { nextIdentity } from "../../../engine/sequence.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { jsonTimestamp, todaySaoPaulo, validDate } from "../../../engine/time.ts";
import * as documents from "../../documents/public.ts";
import { inboundPostedForDocument } from "../../inbound/public.ts";
import { updateDocument } from "../../documents/public.ts";
import * as preferences from "../../preferences/public.ts";
import { guardCom1DirectReverse, requireCom1Posting } from "../../fiscal/comnfe/effect-policy.ts";
import type { Row } from "../document-guards.ts";
import { QTY, QTY_MAX, balanceKept as balanceKeptAt, lotApply, negativeAllowed, requireAccess, sha256 } from "../internal.ts";
import { COMPOSITION_CURRENT, EXACT, invoicePostedForDocument, itemComponentRows, q6to30 } from "../read.ts";
import { post } from "./erp_stock_post.ts";

const DOC = "erp_documents__document";
const MAX_VERSION = 2147483647;
const UUID_LOWER = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOT_QTY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const SCALE_30 = 10n ** 30n;
const t6 = (v: bigint | null) => (v === null ? null : formatScaled(v, QTY));
const abs = (v: bigint) => (v < 0n ? -v : v);
const parse = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? JSON.parse(v) : v);
const byText = (a: string, b: string) => pgCompareText(a, b);

// ---------------------------------------------------------------------------
// Pequenas internas

/** erp_stock.document_access: só admin/estoque (projeção estreita, inclui OS). */
export function documentAccess(db: SqlDriver, user: string, kind: string | null) {
  requireAccess(db, user, true);
  if (kind === null || !["sales_orders", "purchase_orders", "service_orders"].includes(kind)) raise("22023", "erp_document_stock_invalid_kind");
}

/** erp_stock.document_meta(p_day, p_reason) */
export function documentMeta(day: string | null, reason: string | null) {
  if (
    day === null || !validDate(day) || day < "1900-01-01" || day > todaySaoPaulo() ||
    reason === null || pgLength(pgBtrim(reason)) < 3 || pgLength(pgBtrim(reason)) > 500 || pgHasCntrl.test(reason)
  )
    raise("22023", "erp_stock_invalid_command");
}

/** erp_stock.document_eligible(p_kind, p_status) */
export function documentEligible(kind: unknown, status: unknown): boolean {
  if (kind === "sales_orders") return ["open", "verified", "in_progress", "partially_fulfilled", "fulfilled"].includes(String(status));
  if (kind === "purchase_orders") return ["in_progress", "partially_fulfilled", "fulfilled"].includes(String(status));
  if (kind === "service_orders") return ["approved", "in_progress", "waiting_parts", "service_done", "finalized"].includes(String(status));
  return false;
}

/** erp_stock.document_summary(p_id) */
export function documentSummary(db: SqlDriver, id: string) {
  const d = one(db, `SELECT id, kind, number, version, status, body, warehouse_id FROM "${DOC}" WHERE id=?`, id);
  if (!d) return null;
  return {
    id: d.id,
    kind: d.kind,
    number: d.number === null ? null : String(d.number),
    version: d.version,
    status: d.status,
    date: arrow(parse(d.body), "date"),
    warehouse_id: d.warehouse_id,
    eligible: documentEligible(d.kind, d.status),
    active_posting_id: one(db, `SELECT id FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, id)?.id ?? null,
  };
}

/** erp_stock.document_posting_summary(p_id) */
export function documentPostingSummary(db: SqlDriver, id: string) {
  const p = one(db, 'SELECT * FROM "erp_stock__document_posting" WHERE id=?', id);
  if (!p) return null;
  const snapshot = parse(p.snapshot) as Record<string, unknown> | null;
  const length = (v: unknown) => (Array.isArray(v) ? v.length : null);
  return {
    id: p.id,
    document_id: p.document_id,
    source_document_version: p.document_version,
    movement_id: p.movement_id,
    state: p.state,
    version: p.version,
    created_at: jsonTimestamp(p.created_at as number),
    reversal_movement_id: p.reversal_movement_id ?? null,
    reversed_at: p.reversed_at === null || p.reversed_at === undefined ? null : jsonTimestamp(p.reversed_at as number),
    reason: p.reason ?? null,
    occurred_on: arrow(snapshot, "occurred_on"),
    direction: arrow(snapshot, "direction"),
    positions: length(snapshot?.positions),
    ignored_items: length(snapshot?.ignored),
  };
}

/** jsonb_build_object('actor',…,'action',…,'data',…)::text em sha256. */
const requestHash = (actor: string, action: string, data: unknown) => sha256(jsonbText({ actor, action, data }));

/** erp_stock.document_command_start: replay do comando de documento. */
export function documentCommandStart(db: SqlDriver, actor: string, id: string | null, action: string, data: unknown) {
  requireAccess(db, actor, true);
  if (id === null) raise("22023", "erp_document_stock_command_required");
  const c = one(db, 'SELECT actor, request_hash, result FROM "erp_stock__document_command" WHERE id=?', id);
  if (!c) return null;
  if (c.actor !== actor || c.request_hash !== requestHash(actor, action, data)) raise("40001", "erp_document_stock_command_conflict");
  return { ...JSON.parse(String(c.result)), replayed: true };
}

/** erp_stock.document_command_finish */
export function documentCommandFinish(ctx: RpcContext, actor: string, id: string, action: string, data: unknown, result: Record<string, unknown>) {
  const r = { ...result, action, data_mode: "erp_native", replayed: false };
  ctx.db.exec(
    'INSERT INTO "erp_stock__document_command"(id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    requestHash(actor, action, data),
    JSON.stringify(r),
    ctx.clock.next().toString(),
  );
  return r;
}

/** erp_stock.document_lock: o documento na versão esperada. */
export function documentLock(db: SqlDriver, actor: string, kind: string | null, id: string | null, version: number | null): Row {
  const ctx = driverContext(db);
  linkedDocumentGuard(db, id, ctx);
  if (ctx && id) requireOriginOperation(ctx, originScope(ctx)!.operation, id);
  documentAccess(db, actor, kind);
  if (id === null || version === null || version < 1) raise("22023", "erp_document_stock_invalid_version");
  const d = one(db, `SELECT * FROM "${DOC}" WHERE id=? AND kind=?`, id, kind);
  if (!d) raise("P0002", "erp_document_not_found");
  if (d.version !== version || d.version === MAX_VERSION) raise("40001", "erp_document_version_conflict");
  return d;
}

/** erp_documents.require_os_permission(user, kind, 'lancar_estoque') — 239. */
function requireOsPermission(db: SqlDriver, user: string, kind: string | null) {
  if (kind === "service_orders" && !documents.osPermitted(db, user, "lancar_estoque")) raise("42501", "erp_document_permission_denied");
}

/** erp_stock.sales_negative_allowed(): "Permite venda de produtos com estoque negativo". */
const salesNegativeAllowed = (db: SqlDriver) => preferences.get(db, "vendas.estoque_negativo") === true;

// ---------------------------------------------------------------------------
// Lotes informados no item (296)

interface ItemLot {
  lot_id: string;
  quantity: bigint; // escala 6
  ordinal: number;
}

/** erp_stock.document_item_lots(p_data): os lotes de "Informar lotes" do item. */
export function documentItemLots(data: unknown): ItemLot[] {
  const d = parse(data) as Record<string, unknown> | null;
  if (jsonType(d) !== "object" || !("lots" in d!) || d!.lots === null) return [];
  const lots = d!.lots;
  if (!Array.isArray(lots)) raise("22023", "erp_document_stock_lots_invalid");
  const ids = new Set(lots.map((x) => arrow(x, "lot_id")).filter((x): x is string => x !== null).map((x) => pgLower(x)));
  if (lots.length > 50 || lots.some((x) => jsonType(x) !== "object") || ids.size !== lots.length) raise("22023", "erp_document_stock_lots_invalid");
  return lots.map((x: Record<string, unknown>, i) => {
    const q = ["string", "number"].includes(String(jsonType(x.quantity))) ? arrow(x, "quantity") : null;
    if (jsonType(x.lot_id) !== "string" || !UUID_ANY.test(String(x.lot_id)) || q === null || !LOT_QTY.test(q) || toScaled(q, QTY) === 0n)
      raise("22023", "erp_document_stock_lots_invalid");
    return { lot_id: String(x.lot_id).toLowerCase(), quantity: toScaled(q, QTY), ordinal: i + 1 };
  });
}

/** erp_stock.lot_product_problem(p_product) */
export function lotProductProblem(db: SqlDriver, product: string): string | null {
  const p = one(
    db,
    'SELECT p.record_id, p.kind, p.format, d.lot_control FROM "erp_catalog__product" p LEFT JOIN "erp_catalog__product_detail" d ON d.record_id=p.record_id WHERE p.record_id=?',
    product,
  );
  if (!p) return "not_found";
  if (p.kind !== "P") return "not_product";
  if (p.format !== "S") return "not_simple";
  if (!p.lot_control) return "lot_control_off";
  return null;
}

// ---------------------------------------------------------------------------
// Composição do item (222, 280)

interface CompositionLine {
  product_id: string;
  quantity: bigint | null; // escala 6
  per_kit: bigint; // escala 30
  role: "composition" | "component";
}

/** erp_stock.component_problem(p_component) */
export function componentProblem(db: SqlDriver, component: string): string | null {
  const p = one(
    db,
    `SELECT p.record_id, p.kind, p.format, p.unit, r.active,
       EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=p.record_id AND d.deleted_at IS NOT NULL) deleted
     FROM "erp_catalog__product" p LEFT JOIN "erp_catalog__record" r ON r.id=p.record_id WHERE p.record_id=?`,
    component,
  );
  if (!p) return "not_found";
  if (p.kind !== "P") return "not_product";
  if (p.format !== "S") return "not_simple";
  if (p.deleted) return "deleted";
  if (!p.active) return "inactive";
  if (p.unit === null) return "no_unit";
  return null;
}

/** erp_stock.component_quantity(p_quantity, p_per_kit): o produto exato com até 6 casas. */
export function componentQuantity(quantity: bigint | null, perKit: bigint): bigint | null {
  if (quantity === null) return null;
  const v = quantity * perKit; // escala 36
  if (v % SCALE_30 !== 0n || abs(v / SCALE_30) > QTY_MAX) raise("22023", "erp_stock_composition_quantity_precision");
  return v / SCALE_30;
}

function compositionHead(db: SqlDriver, product: string) {
  const c = one(db, 'SELECT post_mode FROM "erp_stock__composition" WHERE product_id=?', product);
  if (!c || !one(db, `SELECT 1 x FROM "erp_catalog__product" WHERE record_id=? AND format='E'`, product))
    raise("22023", "erp_stock_composition_structure_missing");
  return String(c.post_mode);
}

function componentLines(db: SqlDriver, quantity: bigint | null, rows: { component_id: string; quantity: bigint }[]): CompositionLine[] {
  for (const r of rows) {
    const problem = componentProblem(db, r.component_id);
    if (problem !== null) raise("22023", "erp_stock_composition_component_unavailable");
  }
  return rows.map((r) => ({ product_id: r.component_id, quantity: componentQuantity(quantity, r.quantity), per_kit: r.quantity, role: "component" as const }));
}

/** erp_stock.composition_lines(p_product, p_quantity): o kit, os componentes ou os dois. */
export function compositionLines(db: SqlDriver, product: string, quantity: bigint | null): CompositionLine[] {
  const mode = compositionHead(db, product);
  const out: CompositionLine[] = [];
  if (mode === "product" || mode === "both") out.push({ product_id: product, quantity, per_kit: SCALE_30, role: "composition" });
  if (mode === "components" || mode === "both") {
    const rows = db
      .exec(`SELECT component_id, CAST(quantity AS TEXT) q FROM ${COMPOSITION_CURRENT} WHERE product_id=? ORDER BY position`, product)
      .rows.map((r) => ({ component_id: String(r.component_id), quantity: q6to30(fromColumn(r.q)) }));
    if (!rows.length) raise("22023", "erp_stock_composition_structure_missing");
    out.push(...componentLines(db, quantity, rows));
  }
  return out;
}

/** erp_stock.item_composition_lines(p_item, p_product, p_quantity): os componentes editados do item substituem a estrutura (280). */
export function itemCompositionLines(db: SqlDriver, item: string, product: string, quantity: bigint | null): CompositionLine[] {
  if (!one(db, 'SELECT 1 x FROM "erp_stock__item_component" WHERE item_id=? AND product_id=?', item, product)) return compositionLines(db, product, quantity);
  const mode = compositionHead(db, product);
  const out: CompositionLine[] = [];
  if (mode === "product" || mode === "both") out.push({ product_id: product, quantity, per_kit: SCALE_30, role: "composition" });
  if (mode === "components" || mode === "both") out.push(...componentLines(db, quantity, itemComponentRows(db, item, product)));
  return out;
}

// ---------------------------------------------------------------------------
// Conferências

interface Line {
  product_id: string;
  qty: bigint | null;
  source: Record<string, unknown>;
  lots: ItemLot[] | null;
}

const sumOrNull = (values: (bigint | null)[]) => {
  const v = values.filter((x): x is bigint => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0n) : null;
};
const posOf = (s: Record<string, unknown>) => Number(s.position);

/** erp_stock.document_preview_data(d, p_day, p_reason): a conferência do lançamento. */
export function documentPreviewData(ctx: RpcContext, d: Row, day: string | null, reason: string | null) {
  const db = ctx.db;
  documentMeta(day, reason);
  if (!documentEligible(d.kind, d.status)) raise("40001", "erp_document_stock_ineligible_state");
  if (one(db, `SELECT 1 x FROM "erp_stock__document_posting" WHERE document_id=? AND state='active'`, d.id)) raise("40001", "erp_document_stock_already_posted");
  // 259: o pedido cuja nota lançou o estoque não lança de novo.
  if (invoicePostedForDocument(db, String(d.id))) raise("40001", "erp_document_stock_posted_by_invoice");
  // Compra pela nota: o pedido que a nota recebida baixou (lançando o estoque) não lança de novo.
  if (inboundPostedForDocument(db, String(d.id))) raise("40001", "erp_document_stock_posted_by_inbound");
  // As travas do Postgres (catálogo, componentes e lotes, em ordem de id) não
  // existem no SQLite; a dos lotes lê os lotes de todos os itens e recusa os
  // inválidos antes do depósito.
  for (const i of db.exec('SELECT data FROM "erp_documents__item" WHERE document_id=?', d.id).rows) documentItemLots(i.data);
  const w = one(
    db,
    'SELECT r.id, r.name, r.version, r.active FROM "erp_catalog__record" r JOIN "erp_catalog__warehouse" x ON x.record_id=r.id WHERE r.id=? AND r.active=1',
    d.warehouse_id ?? null,
  );
  if (!w) raise("22023", "erp_stock_warehouse_unavailable");
  const ignored: Record<string, unknown>[] = [];
  const lines: Line[] = [];
  const items = db.exec(
    `SELECT i.id, i.position, i.product_id, CAST(i.quantity AS TEXT) q, i.data, r.active, r.version, p.unit, p.kind, p.format
       FROM "erp_documents__item" i LEFT JOIN "erp_catalog__record" r ON r.id=i.product_id LEFT JOIN "erp_catalog__product" p ON p.record_id=i.product_id
      WHERE i.document_id=? ORDER BY i.position`,
    d.id,
  ).rows;
  for (const row of items) {
    const data = parse(row.data) as Record<string, unknown> | null;
    const quantity = row.q === null ? null : fromColumn(row.q);
    const product = (row.product_id as string | null) ?? null;
    // 296: "Informar lotes": produto simples com "Controle de lote", lotes dele, ativos, no máximo a quantidade.
    const lots = documentItemLots(row.data);
    if (lots.length) {
      if (product === null || lotProductProblem(db, product) !== null) raise("22023", "erp_stock_lot_control_off");
      for (const x of lots) {
        const t = one(db, 'SELECT product_id FROM "erp_stock__lot" WHERE id=?', x.lot_id);
        if (!t || t.product_id !== product) raise("P0002", "erp_stock_lot_not_found");
      }
      for (const x of lots) if (!one(db, 'SELECT active FROM "erp_stock__lot" WHERE id=?', x.lot_id)!.active) raise("22023", "erp_stock_lot_inactive");
      if (quantity !== null && lots.reduce((s, x) => s + x.quantity, 0n) > quantity) raise("22023", "erp_document_stock_lots_exceed");
    }
    if (product === null || row.kind === "S") {
      ignored.push({
        id: row.id,
        position: row.position,
        product_id: product,
        description: arrow(data, "description"),
        quantity: t6(quantity),
        unit: arrow(data, "unit"),
        catalog_version: row.version ?? null,
        reason: product === null ? "unlinked_item" : "service",
      });
    } else if (row.kind !== "P" || !row.active || row.unit === null) {
      raise("22023", "erp_stock_product_unavailable");
    } else if (row.format === "V" || (row.format === "E" && d.kind === "purchase_orders")) {
      raise("22023", "erp_document_stock_composition_unsupported");
    } else if (row.unit !== arrow(data, "unit")) {
      raise("22023", "erp_document_stock_unit_mismatch");
    } else if (row.format === "E") {
      // 280: os componentes editados do item substituem a estrutura da composição.
      for (const l of itemCompositionLines(db, String(row.id), product, quantity))
        lines.push({
          product_id: l.product_id,
          qty: l.quantity,
          lots: null,
          source:
            l.role === "composition"
              ? { id: row.id, position: row.position, quantity: t6(quantity) }
              : {
                  id: row.id,
                  position: row.position,
                  quantity: t6(l.quantity),
                  kit_product_id: product,
                  kit_quantity: t6(quantity),
                  component_quantity: t6(rescale(l.per_kit, EXACT, QTY)),
                },
        });
    } else {
      lines.push({ product_id: product, qty: quantity, lots: lots.length ? lots : null, source: { id: row.id, position: row.position, quantity: t6(quantity) } });
    }
  }
  const direction = d.kind === "purchase_orders" ? "receipt" : "issue";
  const signed = (v: bigint | null) => (v === null ? null : direction === "issue" ? -v : v);
  const products = [...new Set(lines.map((l) => l.product_id))].sort(byText);
  const positions: Record<string, unknown>[] = [];
  for (const product of products) {
    const group = lines.filter((l) => l.product_id === product);
    const r = one(
      db,
      'SELECT r.name, r.version, p.unit FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE r.id=?',
      product,
    );
    if (!r) continue;
    const qty = sumOrNull(group.map((l) => l.qty));
    const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', product, w.id);
    const before = b ? fromColumn(b.q) : 0n;
    const delta = signed(qty);
    const position: Record<string, unknown> = {
      product_id: product,
      product_name: r.name,
      catalog_version: r.version,
      warehouse_id: w.id,
      unit: r.unit,
      quantity: t6(delta),
      balance_before: t6(before),
      balance_after: delta === null ? null : t6(before + delta),
      expected_version: b ? b.version : 0,
      sources: group.map((l) => l.source).sort((x, y) => posOf(x) - posOf(y)),
    };
    // 296: os lotes da posição (vários itens do mesmo produto podem informar o mesmo lote).
    const lotLines = group.filter((l) => l.lots !== null);
    const lotIds = [...new Set(lotLines.flatMap((l) => l.lots!.map((x) => x.lot_id)))];
    if (lotIds.length) {
      const lots = lotIds.map((lot) => {
        const parts = lotLines.flatMap((l) => l.lots!.filter((x) => x.lot_id === lot).map((x) => ({ l, x })));
        const k = parts.reduce((s, p) => s + p.x.quantity, 0n);
        const t = one(db, 'SELECT code, expires_on FROM "erp_stock__lot" WHERE id=?', lot)!;
        const lb = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__lot_balance" WHERE lot_id=? AND warehouse_id=?', lot, w.id);
        const lbq = lb ? fromColumn(lb.q) : 0n;
        const dq = direction === "issue" ? -k : k;
        return {
          lot_id: lot,
          code: t.code,
          expires_on: t.expires_on ?? null,
          quantity: t6(dq),
          balance_before: t6(lbq),
          balance_after: t6(lbq + dq),
          sources: parts
            .map((p) => ({ id: String(p.l.source.id), position: posOf(p.l.source), quantity: t6(p.x.quantity) }))
            .sort((a, b2) => a.position - b2.position),
        };
      });
      lots.sort((a, b2) => byText(pgLower(String(a.code)), pgLower(String(b2.code))) || byText(a.lot_id, b2.lot_id));
      position.lots = lots;
    }
    positions.push(position);
  }
  if (positions.length < 1 || positions.length > 100) raise("22023", "erp_document_stock_position_limit");
  // 182: o pedido de venda precisa da política da empresa e de "Permite venda de produtos com estoque negativo".
  const dec = (v: unknown) => (v === null ? null : toScaled(String(v), QTY));
  const negativeOk = negativeAllowed(db) && (d.kind !== "sales_orders" || salesNegativeAllowed(db));
  for (const j of positions) {
    const q = dec(j.quantity),
      after = dec(j.balance_after);
    if (
      (q !== null && after !== null && q < 0n && after < 0n && !negativeOk) ||
      (after !== null && (after > QTY_MAX || after < -QTY_MAX)) ||
      j.expected_version === MAX_VERSION
    )
      raise("22023", "erp_stock_insufficient_or_excess_quantity");
  }
  // 296: o lote nunca fica abaixo de zero, seja qual for a política de estoque negativo (258).
  const lotsOf = (j: Record<string, unknown>) => (j.lots ?? []) as Record<string, unknown>[];
  if (positions.some((j) => lotsOf(j).some((x) => dec(x.balance_after)! < 0n))) raise("22023", "erp_stock_lot_insufficient");
  if (positions.some((j) => lotsOf(j).some((x) => dec(x.balance_after)! > QTY_MAX))) raise("22023", "erp_stock_insufficient_or_excess_quantity");
  const result = {
    action: "post",
    document: documentSummary(db, String(d.id)),
    direction,
    occurred_on: day,
    reason,
    warehouse: { id: w.id, name: w.name, version: w.version, active: !!w.active },
    positions,
    ignored,
  };
  return { ...result, preview_hash: sha256(jsonbText(result)) };
}

/** erp_stock.document_reverse_preview_data(d, p_id, p_version, p_day, p_reason): a conferência do estorno. */
export function documentReversePreviewData(ctx: RpcContext, d: Row, postingId: string | null, version: number | null, day: string | null, reason: string | null) {
  const db = ctx.db;
  documentMeta(day, reason);
  const p = one(db, 'SELECT * FROM "erp_stock__document_posting" WHERE id=? AND document_id=?', postingId, d.id);
  if (!p) raise("P0002", "erp_document_stock_not_found");
  if (version === null || version < 1) raise("22023", "erp_document_stock_invalid_version");
  if (p.version !== version || p.state !== "active" || p.version === MAX_VERSION) raise("40001", "erp_document_stock_version_conflict");
  if (day! < String(one(db, 'SELECT occurred_on FROM "erp_stock__movement" WHERE id=?', p.movement_id)!.occurred_on))
    raise("22023", "erp_stock_reversal_date_invalid");
  const movement = String(p.movement_id);
  const entries = db.exec(
    `SELECT e.product_id, e.warehouse_id, e.unit, CAST(e.quantity AS TEXT) q, CAST(b.quantity AS TEXT) bq, b.version bv, r.name, r.version rv
       FROM "erp_stock__entry" e JOIN "erp_stock__balance" b ON b.product_id=e.product_id AND b.warehouse_id=e.warehouse_id
       JOIN "erp_catalog__record" r ON r.id=e.product_id WHERE e.movement_id=?`,
    movement,
  ).rows;
  entries.sort((a, b) => byText(String(a.product_id), String(b.product_id)) || byText(String(a.warehouse_id), String(b.warehouse_id)));
  const positions = entries.map((e) => {
    const q = fromColumn(e.q),
      bq = fromColumn(e.bq);
    const position: Record<string, unknown> = {
      product_id: e.product_id,
      product_name: e.name,
      catalog_version: e.rv,
      warehouse_id: e.warehouse_id,
      unit: e.unit,
      quantity: t6(-q),
      balance_before: t6(bq),
      balance_after: t6(bq - q),
      expected_version: e.bv,
      sources: [],
    };
    if (balanceKeptAt(db, movement, String(e.product_id), String(e.warehouse_id))) position.balance_kept = true;
    const lots = db.exec(
      `SELECT x.lot_id, t.code, t.expires_on, CAST(x.quantity AS TEXT) q, CAST(lb.quantity AS TEXT) lbq
         FROM "erp_stock__lot_entry" x JOIN "erp_stock__lot" t ON t.id=x.lot_id
         LEFT JOIN "erp_stock__lot_balance" lb ON lb.lot_id=x.lot_id AND lb.warehouse_id=x.warehouse_id
        WHERE x.movement_id=? AND x.product_id=? AND x.warehouse_id=?`,
      movement,
      e.product_id,
      e.warehouse_id,
    ).rows;
    if (lots.length) {
      lots.sort((a, b) => byText(pgLower(String(a.code)), pgLower(String(b.code))) || byText(String(a.lot_id), String(b.lot_id)));
      position.lots = lots.map((x) => {
        const xq = fromColumn(x.q),
          lbq = x.lbq === null ? 0n : fromColumn(x.lbq);
        return { lot_id: x.lot_id, code: x.code, expires_on: x.expires_on ?? null, quantity: t6(-xq), balance_before: t6(lbq), balance_after: t6(lbq - xq) };
      });
    }
    return position;
  });
  const dec = (v: unknown) => toScaled(String(v), QTY);
  if (
    positions.length < 1 || positions.length > 100 ||
    positions.some((j) => {
      const q = dec(j.quantity),
        after = dec(j.balance_after);
      return (q < 0n && after < 0n && !negativeAllowed(db) && !j.balance_kept) || after > QTY_MAX || after < -QTY_MAX || j.expected_version === MAX_VERSION;
    })
  )
    raise("22023", "erp_stock_insufficient_or_excess_quantity");
  // 296: o estorno de uma entrada cujo lote já saiu é recusado (o lote nunca fica abaixo de zero).
  if (positions.some((j) => ((j.lots ?? []) as Record<string, unknown>[]).some((x) => dec(x.balance_after) < 0n))) raise("22023", "erp_stock_lot_insufficient");
  const snapshot = parse(p.snapshot) as Record<string, unknown>;
  const result = {
    action: "reverse",
    document: documentSummary(db, String(d.id)),
    posting: documentPostingSummary(db, String(p.id)),
    direction: "reversal",
    occurred_on: day,
    reason,
    warehouse: snapshot?.warehouse ?? null,
    positions,
    ignored: [],
  };
  return { ...result, preview_hash: sha256(jsonbText(result)) };
}

// ---------------------------------------------------------------------------
// Camada de linha (gatilhos das tabelas tocadas)

/** INSERT em erp_stock.document_posting com os gatilhos BEFORE (ordem do nome) e o AFTER dos lotes. */
export function insertPosting(ctx: RpcContext, row: { document_id: string; document_version: number; movement_id: string; snapshot: Record<string, unknown>; preview_hash: string; actor: string; command_id: string }) {
  requireRpcParts(ctx, "erp_document_stock_post", { p_document_id: row.document_id });
  const db = ctx.db;
  documents.mirrorGuardEffect(db, row.document_id); // aa_mirror_authority (erp_document_mirror.guard_effect)
  documents.guardTrashChild(db, row.document_id); // guard_trash
  // protect_purchase_receipt_legacy (erp_purchase_receipts.guard_legacy)
  if (one(db, 'SELECT 1 x FROM "erp_purchase_receipts__receipt" WHERE document_id=?', row.document_id)) raise("40001", "purchase_receipt_legacy_mixing");
  // protect_reserved_posting (erp_stock.guard_reserved_posting)
  if (one(db, `SELECT 1 x FROM "erp_stock__reservation" WHERE document_id=? AND state='active'`, row.document_id)) raise("40001", "erp_stock_use_reservation_consume");
  const id = crypto.randomUUID();
  db.exec(
    'INSERT INTO "erp_stock__document_posting"(id, document_id, document_version, movement_id, snapshot, preview_hash, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id,
    row.document_id,
    row.document_version,
    row.movement_id,
    JSON.stringify(row.snapshot),
    row.preview_hash,
    row.actor,
    row.command_id,
    ctx.clock.next().toString(),
  );
  // post_stock_document_lots (erp_stock.post_document_lots, AFTER INSERT)
  const positions = ((row.snapshot.positions ?? []) as Record<string, unknown>[]).filter((j) => "lots" in j);
  positions.sort((a, b) => byText(String(a.product_id), String(b.product_id)));
  for (const j of positions) {
    const lots = [...(j.lots as Record<string, unknown>[])].sort((a, b) => byText(String(a.lot_id), String(b.lot_id)));
    for (const x of lots) lotApply(ctx, row.movement_id, String(j.product_id), String(j.warehouse_id), String(x.lot_id), toScaled(String(x.quantity), QTY));
  }
  return id;
}

/** UPDATE de estorno em erp_stock.document_posting (guard_document_posting). */
function reversePosting(ctx: RpcContext, id: string, movement: string, user: string, reason: string) {
  const db = ctx.db;
  const o = one(db, 'SELECT state, movement_id, document_id FROM "erp_stock__document_posting" WHERE id=?', id)!;
  // aa_mirror_authority (guard_effect): OLD e NEW, o mesmo documento.
  documents.mirrorGuardEffect(db, o.document_id);
  // immutable_document_stock_posting: só active → reversed, versão +1, pelo movimento que estorna o lançamento.
  if (o.state !== "active" || !one(db, 'SELECT 1 x FROM "erp_stock__movement" WHERE id=? AND reverses_id=?', movement, o.movement_id))
    raise("40001", "erp_document_stock_immutable");
  db.exec(
    `UPDATE "erp_stock__document_posting" SET state='reversed', version=version+1, reversal_movement_id=?, reversed_at=?, reversed_by=?, reason=? WHERE id=?`,
    movement,
    ctx.clock.next().toString(),
    user,
    pgBtrim(reason),
    id,
  );
}



/**
 * UPDATE erp_documents.document SET version=version+1, updated_by, updated_at,
 * pela camada de linha do Documentos (documents/rows.ts, updateDocument): os
 * gatilhos BEFORE na ordem do nome, o capture e os adiados (comissão e custo,
 * em savepoint).
 */
export function bumpDocumentVersion(ctx: RpcContext, id: string, user: string) {
  const o = one(ctx.db, `SELECT version FROM "${DOC}" WHERE id=?`, id)!;
  updateDocument(ctx, id, { version: Number(o.version) + 1, updated_by: user, updated_at: ctx.clock.next().toString() });
}

/** INSERT nas auditorias do Estoque e do Documentos. */
export function audit(ctx: RpcContext, a: { actor: string; command: string; document: string; posting: string; action: "post" | "reverse"; result: unknown; reason: string | null }) {
  const db = ctx.db;
  // aa_mirror_authority (guard_effect) nas duas auditorias.
  documents.mirrorGuardEffect(db, a.document);
  db.exec(
    'INSERT INTO "erp_stock__document_audit"(id, actor, command_id, document_id, posting_id, action, result, created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_stock__document_audit", "id"),
    a.actor,
    a.command,
    a.document,
    a.posting,
    a.action,
    JSON.stringify(a.result),
    ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_documents__audit"(id, actor, command_id, document_id, action, reason, after_data, created_at) VALUES(?,?,?,?,?,?,?,?)',
    nextIdentity(ctx, "erp_documents__audit", "id"),
    a.actor,
    a.command,
    a.document,
    a.action === "post" ? "stock_post" : "stock_reverse",
    a.reason,
    JSON.stringify(a.result),
    ctx.clock.next().toString(),
  );
}

// ---------------------------------------------------------------------------
// RPCs

const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
const int = (v: unknown) => (v === undefined || v === null ? null : Number(v));

/** public.erp_document_stock_preview */
export function erpDocumentStockPreview(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_stock_preview", a);
  const user = a.p_user_id as string;
  documents.mirrorRequireVisible(ctx.db, user, str(a.p_document_id), true);
  if (!originScope(ctx)) requireOsPermission(ctx.db, user, str(a.p_kind));
  const d = documentLock(ctx.db, user, str(a.p_kind), str(a.p_document_id), int(a.p_expected_version));
  return { preview: documentPreviewData(ctx, d, str(a.p_occurred_on), str(a.p_reason)), data_mode: "erp_native" };
}

/** public.erp_document_stock_post */
export function erpDocumentStockPost(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_stock_post", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = str(a.p_kind),
    id = str(a.p_document_id),
    version = int(a.p_expected_version),
    command = str(a.p_command_id),
    hash = str(a.p_preview_hash),
    day = str(a.p_occurred_on),
    reason = str(a.p_reason);
  const acknowledged = a.p_ignored_item_ids === undefined ? null : jsonbArg(a.p_ignored_item_ids);
  documents.mirrorRequireVisible(db, user, id, true);
  if (!originScope(ctx)) requireOsPermission(db, user, kind);
  const data = { kind, id, version, hash, date: day, reason, ignored: acknowledged };
  const replayed = documentCommandStart(db, user, command, "post", data);
  if (replayed) return replayed;
  requireCom1Posting(ctx, id, "stock");
  const d = documentLock(db, user, kind, id, version);
  const preview = documentPreviewData(ctx, d, day, reason);
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_document_stock_preview_conflict");
  if (
    acknowledged === null || !Array.isArray(acknowledged) || acknowledged.length > 250 ||
    acknowledged.some((j) => typeof j !== "string" || !UUID_LOWER.test(j))
  )
    raise("22023", "erp_document_stock_ignored_ack_required");
  const ack = [...(acknowledged as string[])].sort(byText);
  const wanted = preview.ignored.map((i) => String(i.id)).sort(byText);
  if (jsonbText(ack) !== jsonbText(wanted)) raise("22023", "erp_document_stock_ignored_ack_required");
  if (one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command)) raise("40001", "erp_document_stock_command_conflict");
  const items = [...preview.positions]
    .sort((x, y) => byText(String(x.product_id), String(y.product_id)))
    .map((j) => ({ product_id: j.product_id, warehouse_id: j.warehouse_id, quantity: j.quantity, expected_version: j.expected_version }));
  const movement = post(ctx, {
    user,
    command,
    kind: preview.direction,
    occurredOn: day,
    reason,
    reference: `Documento ${d.kind} ${String(d.number)}`,
    items,
  }) as { movement: { id: string } };
  const { preview_hash: _h, ...snapshot } = preview;
  const pid = insertPosting(ctx, {
    document_id: String(d.id),
    document_version: Number(d.version),
    movement_id: movement.movement.id,
    snapshot,
    preview_hash: hash,
    actor: user,
    command_id: command!,
  });
  bumpDocumentVersion(ctx, String(d.id), user);
  const result = { document_id: d.id, document_version: Number(d.version) + 1, posting: documentPostingSummary(db, pid), movement: movement.movement };
  audit(ctx, { actor: user, command: command!, document: String(d.id), posting: pid, action: "post", result, reason: null });
  return documentCommandFinish(ctx, user, command!, "post", data, result);
}

/** public.erp_document_stock_reverse_preview */
export function erpDocumentStockReversePreview(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_stock_reverse_preview", a);
  const user = a.p_user_id as string;
  documents.mirrorRequireVisible(ctx.db, user, str(a.p_document_id), true);
  if (!originScope(ctx)) requireOsPermission(ctx.db, user, str(a.p_kind));
  if (originScope(ctx)) assertOwnEffect(ctx, "stock_posting", String(a.p_posting_id));
  const d = documentLock(ctx.db, user, str(a.p_kind), str(a.p_document_id), int(a.p_expected_version));
  return {
    preview: documentReversePreviewData(ctx, d, str(a.p_posting_id), int(a.p_posting_version), str(a.p_occurred_on), str(a.p_reason)),
    data_mode: "erp_native",
  };
}

/** public.erp_document_stock_reverse */
export function erpDocumentStockReverse(ctx: RpcContext, a: RpcArgs) {
  requireRpcParts(ctx, "erp_document_stock_reverse", a);
  const db = ctx.db;
  const user = a.p_user_id as string;
  const kind = str(a.p_kind),
    id = str(a.p_document_id),
    version = int(a.p_expected_version),
    postingId = str(a.p_posting_id),
    postingVersion = int(a.p_posting_version),
    command = str(a.p_command_id),
    hash = str(a.p_preview_hash),
    day = str(a.p_occurred_on),
    reason = str(a.p_reason);
  documents.mirrorRequireVisible(db, user, id, true);
  if (!originScope(ctx)) requireOsPermission(db, user, kind);
  if (originScope(ctx)) assertOwnEffect(ctx, "stock_posting", String(a.p_posting_id));
  const data = { kind, id, version, posting: postingId, posting_version: postingVersion, hash, date: day, reason };
  const replayed = documentCommandStart(db, user, command, "reverse", data);
  if (replayed) return replayed;
  guardCom1DirectReverse(ctx, id, "stock");
  const d = documentLock(db, user, kind, id, version);
  const preview = documentReversePreviewData(ctx, d, postingId, postingVersion, day, reason);
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_document_stock_preview_conflict");
  if (one(db, 'SELECT 1 x FROM "erp_stock__command" WHERE id=?', command)) raise("40001", "erp_document_stock_command_conflict");
  const items = [...preview.positions]
    .sort((x, y) => byText(String(x.product_id), String(y.product_id)))
    .map((j) => ({ product_id: j.product_id, warehouse_id: j.warehouse_id, quantity: j.quantity, expected_version: j.expected_version }));
  const movement = post(ctx, {
    user,
    command,
    kind: "reversal",
    occurredOn: day,
    reason,
    reference: `Estorno documento ${d.kind} ${String(d.number)}`,
    items,
    reversesId: String(preview.posting!.movement_id),
  }) as { movement: { id: string } };
  reversePosting(ctx, postingId!, movement.movement.id, user, reason!);
  bumpDocumentVersion(ctx, String(d.id), user);
  const result = { document_id: d.id, document_version: Number(d.version) + 1, posting: documentPostingSummary(db, postingId!), movement: movement.movement };
  audit(ctx, { actor: user, command: command!, document: String(d.id), posting: postingId!, action: "reverse", result, reason: pgBtrim(reason!) });
  return documentCommandFinish(ctx, user, command!, "reverse", data, result);
}

registerRpc("erp_document_stock_preview", erpDocumentStockPreview);
registerRpc("erp_document_stock_post", erpDocumentStockPost);
registerRpc("erp_document_stock_reverse_preview", erpDocumentStockReversePreview);
registerRpc("erp_document_stock_reverse", erpDocumentStockReverse);
