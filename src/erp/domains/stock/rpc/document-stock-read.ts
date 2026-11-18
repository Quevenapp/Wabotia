// Definições finais do oráculo: leituras e lançamento com depósito escolhido.
import { jsonbArg } from "../../../engine/args.ts";
import { formatScaled, fromColumn } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { arrow, jsonbText } from "../../../engine/json.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { pgBtrim, pgCompareText, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import * as documents from "../../documents/public.ts";
import {
  audit,
  bumpDocumentVersion,
  documentAccess,
  documentCommandFinish,
  documentCommandStart,
  documentEligible,
  documentLock,
  documentPostingSummary,
  documentPreviewData,
  documentSummary,
  insertPosting,
} from "./document-stock.ts";
import { post } from "./erp_stock_post.ts";

registerRpc("erp_document_stock_get", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    id = a.p_document_id as string,
    kind = a.p_kind as string,
    limit = a.p_limit as number;
  documents.mirrorRequireVisible(db, user, id, false);
  documentAccess(db, user, kind);
  if (limit === null || limit < 1 || limit > 100) raise("22023", "erp_document_stock_invalid_query");
  if (!one(db, "SELECT 1 FROM erp_documents__document WHERE id=? AND kind=?", id, kind)) raise("P0002", "erp_document_not_found");
  const page = db.exec(
    "SELECT id FROM erp_stock__document_posting WHERE document_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?",
    id,
    a.p_after,
    a.p_after,
    limit + 1,
  ).rows;
  const shown = page.slice(0, limit),
    active = one(db, "SELECT id FROM erp_stock__document_posting WHERE document_id=? AND state='active'", id);
  return {
    document: documentSummary(db, id),
    items: db
      .exec("SELECT id, position, product_id, data, CAST(quantity AS TEXT) q FROM erp_documents__item WHERE document_id=? ORDER BY position", id)
      .rows.map((i) => ({
        id: i.id,
        position: i.position,
        product_id: i.product_id,
        description: arrow(JSON.parse(String(i.data)), "description"),
        code: arrow(JSON.parse(String(i.data)), "code"),
        unit: arrow(JSON.parse(String(i.data)), "unit"),
        quantity: i.q === null ? null : formatScaled(fromColumn(i.q), 6),
      })),
    active_posting: active ? documentPostingSummary(db, String(active.id)) : null,
    postings: shown.map((x) => documentPostingSummary(db, String(x.id))),
    limit,
    has_more: page.length > limit,
    next_cursor: page.length > limit ? shown.at(-1)!.id : null,
    data_mode: "erp_native",
  };
});

registerRpc("erp_document_stock_list", (ctx, a) => {
  const db = ctx.db,
    kind = a.p_kind as string,
    limit = a.p_limit as number,
    query = a.p_query as string | null;
  documentAccess(db, a.p_user_id as string, kind);
  if (limit === null || limit < 1 || limit > 100 || (query !== null && (pgLength(query) > 100 || pgHasCntrl.test(query))))
    raise("22023", "erp_document_stock_invalid_query");
  const page = db
    .exec(
      "SELECT d.id, d.kind, d.status, CAST(d.number AS TEXT) number, EXISTS(SELECT 1 FROM erp_stock__document_posting p WHERE p.document_id=d.id) posted FROM erp_documents__document d WHERE d.authority='brufap' AND d.kind=? AND (? IS NULL OR d.id>?) ORDER BY d.id",
      kind,
      a.p_after,
      a.p_after,
    )
    .rows.filter((d) => (documentEligible(d.kind, d.status) || d.posted) && (query === null || String(d.number).includes(pgBtrim(query))))
    .slice(0, limit + 1);
  return {
    kind,
    items: page.slice(0, limit).map((d) => documentSummary(db, String(d.id))),
    limit,
    has_more: page.length > limit,
    next_cursor: page.length > limit ? page[limit - 1].id : null,
    data_mode: "erp_native",
  };
});

registerRpc("erp_stock_document_warehouse_preview", (ctx, a) => {
  documents.mirrorRequireVisible(ctx.db, a.p_user_id as string, a.p_document_id as string, true);
  if (a.p_warehouse_id === null) raise("22023", "erp_document_stock_warehouse_required");
  const d = documentLock(ctx.db, a.p_user_id as string, a.p_kind as string, a.p_document_id as string, a.p_expected_version as number);
  return {
    preview: documentPreviewData(ctx, { ...d, warehouse_id: a.p_warehouse_id }, a.p_occurred_on as string, a.p_reason as string),
    data_mode: "erp_native",
  };
});

registerRpc("erp_stock_document_warehouse_post", (ctx, a) => {
  const db = ctx.db,
    user = a.p_user_id as string,
    command = a.p_command_id as string,
    kind = a.p_kind as string,
    id = a.p_document_id as string,
    version = a.p_expected_version as number,
    hash = a.p_preview_hash as string,
    day = a.p_occurred_on as string,
    reason = a.p_reason as string,
    warehouse = a.p_warehouse_id as string,
    ignored = jsonbArg(a.p_ignored_item_ids);
  documents.mirrorRequireVisible(db, user, id, true);
  const data = { kind, id, version, warehouse_id: warehouse, hash, date: day, reason, ignored };
  const replay = documentCommandStart(db, user, command, "post", data);
  if (replay) return replay;
  if (warehouse === null) raise("22023", "erp_document_stock_warehouse_required");
  const d: Record<string, unknown> = { ...documentLock(db, user, kind, id, version), warehouse_id: warehouse };
  const preview = documentPreviewData(ctx, d, day, reason);
  if (hash === null || !/^[a-f0-9]{64}$/.test(hash) || hash !== preview.preview_hash) raise("40001", "erp_document_stock_preview_conflict");
  if (
    !Array.isArray(ignored) ||
    ignored.length > 250 ||
    ignored.some((x) => typeof x !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)) ||
    jsonbText([...ignored].sort(pgCompareText)) !== jsonbText(preview.ignored.map((x) => String(x.id)).sort(pgCompareText))
  )
    raise("22023", "erp_document_stock_ignored_ack_required");
  if (one(db, "SELECT 1 FROM erp_stock__command WHERE id=?", command)) raise("40001", "erp_document_stock_command_conflict");
  const items = [...preview.positions]
    .sort((x, y) => pgCompareText(String(x.product_id), String(y.product_id)))
    .map((j) => ({ product_id: j.product_id, warehouse_id: j.warehouse_id, quantity: j.quantity, expected_version: j.expected_version }));
  const movement = post(ctx, { user, command, kind: preview.direction, occurredOn: day, reason, reference: `Documento ${d.kind} ${d.number}`, items }) as {
    movement: { id: string };
  };
  const { preview_hash: _, ...snapshot } = preview;
  const pid = insertPosting(ctx, {
    document_id: id,
    document_version: version,
    movement_id: movement.movement.id,
    snapshot,
    preview_hash: hash,
    actor: user,
    command_id: command,
  });
  bumpDocumentVersion(ctx, id, user);
  const result = {
    document_id: id,
    document_version: version + 1,
    posting: documentPostingSummary(db, pid),
    movement: movement.movement,
    warehouse_id: warehouse,
  };
  audit(ctx, { actor: user, command, document: id, posting: pid, action: "post", result, reason: null });
  return documentCommandFinish(ctx, user, command, "post", data, result);
});
