// CNAB, bloco C1: leituras da conferência humana (migração 058).
// public.erp_cnab_human_review_list, _get e _history.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { int, uuid } from "../args.ts";
import { access, humanReviewSafety, parse, txt } from "../core.ts";
import { humanReviewContext, humanReviewDetail, humanReviewHash, humanReviewRevisionDto } from "../human-review.ts";

const invalidPage = (): never => raise("22023", "erp_cnab_review_pagination_invalid");

export function erpCnabHumanReviewGet(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"));
  return humanReviewDetail(ctx.db, uuid(a, "p_event_id"), uuid(a, "p_file_id"), int(a, "p_line"));
}

export function erpCnabHumanReviewList(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const file = uuid(a, "p_file_id");
  const limit = int(a, "p_limit");
  const after = int(a, "p_after");
  access(db, uuid(a, "p_user_id"));
  if (limit === null || limit < 1 || limit > 100 || after === null || after < 1 || after > 10000) invalidPage();
  if (!one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE id=? AND purpose='homologation'`, file)) raise("P0002", "erp_cnab_review_not_found");
  const items = db
    .exec(
      `SELECT o.line, o.file_id, o.duplicate, e.id, e.event_hash, e.payload, h.version, r.event_id revised, r.status, r.context_hash
       FROM "erp_cnab__return_occurrence" o JOIN "erp_cnab__return_event" e ON e.id=o.event_id
       LEFT JOIN "erp_cnab__human_review" h ON h.event_id=e.id
       LEFT JOIN "erp_cnab__human_review_revision" r ON r.event_id=h.event_id AND r.version=h.version
       WHERE o.file_id=? AND o.line>? ORDER BY o.line LIMIT ?`,
      file,
      after,
      limit,
    )
    .rows.map((x) => {
      const p = parse(x.payload);
      return {
        line: Number(x.line),
        event_id: x.id,
        event_hash: x.event_hash,
        duplicate: Number(x.duplicate) === 1,
        kind: txt(p, "kind"),
        control: txt(p, "control"),
        document_number: txt(p, "documentNumber"),
        amount_cents: txt(p, "amountCents"),
        paid_cents: txt(p, "paidCents"),
        review_version: x.version === null ? 0 : Number(x.version),
        review_status: x.status ?? "pending",
        context_changed:
          x.revised === null ? false : x.context_hash !== humanReviewHash(humanReviewContext(db, String(x.id), String(x.file_id), Number(x.line))),
      };
    });
  const last = items.length ? items[items.length - 1].line : null;
  const more = !!one(db, 'SELECT 1 x FROM "erp_cnab__return_occurrence" WHERE file_id=? AND line>?', file, last ?? after);
  return { ...humanReviewSafety(), file_id: file, items, limit, has_more: more, next_cursor: more ? last : null };
}

export function erpCnabHumanReviewHistory(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const event = uuid(a, "p_event_id");
  const limit = int(a, "p_limit");
  const before = int(a, "p_before");
  access(db, uuid(a, "p_user_id"));
  if (limit === null || limit < 1 || limit > 100 || (before !== null && before < 1)) invalidPage();
  if (!one(db, `SELECT 1 x FROM "erp_cnab__return_event" WHERE id=? AND purpose='homologation'`, event)) raise("P0002", "erp_cnab_review_not_found");
  const items = db
    .exec('SELECT version FROM "erp_cnab__human_review_revision" WHERE event_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?', event, before, before, limit)
    .rows.map((r) => humanReviewRevisionDto(db, event, Number(r.version))!);
  const last = items.length ? (items[items.length - 1].version as number) : null;
  const more = !!one(db, 'SELECT 1 x FROM "erp_cnab__human_review_revision" WHERE event_id=? AND version<?', event, last ?? before ?? 2147483647);
  return { ...humanReviewSafety(), event_id: event, items, limit, has_more: more, next_cursor: more ? last : null };
}

registerRpc("erp_cnab_human_review_get", erpCnabHumanReviewGet);
registerRpc("erp_cnab_human_review_list", erpCnabHumanReviewList);
registerRpc("erp_cnab_human_review_history", erpCnabHumanReviewHistory);
