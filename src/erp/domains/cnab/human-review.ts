// Conferência humana dos retornos de homologação (migração 058, versões finais
// no oráculo): erp_cnab.human_review_context, _hash, _revision_dto e _detail.
// A gravação da conferência (C3) usa o mesmo contexto e o mesmo hash.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { and3, eq3, get, has, humanReviewSafety, not3, or3, parse, profileRow, sha256, ts, txt, type B3, type Json } from "./core.ts";

const right3 = (s: string | null) => (s === null ? null : [...s].slice(-3).join(""));
/** CASE WHEN x: só verdadeiro entra (nulo segue para o próximo ramo). */
const when = (x: B3) => x === true;

/** erp_cnab.human_review_context(event, file, line) */
export function humanReviewContext(db: SqlDriver, eventId: string | null, fileId: string | null, line: number | null): Json {
  const e = one(db, `SELECT id, profile_id, event_hash, payload, billing_title_id, proposed_action, reason FROM "erp_cnab__return_event" WHERE id=? AND purpose='homologation'`, eventId);
  const o = one(db, 'SELECT file_id, line, event_id, line_hash, duplicate FROM "erp_cnab__return_occurrence" WHERE file_id=? AND line=? AND event_id=?', fileId, line, eventId);
  if (!e || !o) raise("P0002", "erp_cnab_review_not_found");
  const payload = parse(e!.payload);
  const f = one(
    db,
    `SELECT id, file_hash, generated_on, warnings, evidence FROM "erp_cnab__return_file" WHERE id=? AND profile_id=? AND purpose='homologation'`,
    o!.file_id,
    e!.profile_id,
  );
  const p = profileRow(db, e!.profile_id);
  const a = p ? one(db, 'SELECT id, name, version, active FROM "erp_finance__account" WHERE id=?', p.account_id) : undefined;
  if (!f || !p || !a) raise("40001", "erp_cnab_review_context_invalid");
  const evidence = parse(f!.evidence);
  const warnings = parse(f!.warnings);
  const reference = txt(evidence, "referenceId");
  const declared =
    and3(
      eq3(txt(evidence, "source"), "authenticated-bank-download"),
      eq3(txt(evidence, "fileHash"), f!.file_hash),
      eq3(txt(evidence, "accountId"), p!.account_id),
      reference === null ? null : /^[a-zA-Z0-9_-]{1,80}$/.test(reference),
    ) ?? false;
  const b = e!.billing_title_id === null ? undefined : one(
    db,
    'SELECT id, remittance_id, title_id, control, document_number, our_number FROM "erp_cnab__billing_title" WHERE id=? AND profile_id=?',
    e!.billing_title_id,
    p!.id,
  );
  const t = b
    ? one(
        db,
        `SELECT id, version, kind, description, issued_on, due_on, CAST(amount_cents AS TEXT) amount_cents, CAST(settled_cents AS TEXT) settled_cents, cancelled
         FROM "erp_finance__title" WHERE id=?`,
        b.title_id,
      )
    : undefined;
  const link = !!b && !!t;
  const adjustments = get(payload, "adjustments");
  const adjust =
    jsonType(adjustments) === "object" &&
    Object.values(adjustments as Json).some((v) => v !== null && (typeof v === "string" ? v : jsonbText(v)) !== "0");
  let billing: Json | null = null;
  let title: Json | null = null;
  let refMatch: B3 = null;
  let numberMatch: B3 = null;
  let amountMatch: B3 = null;
  let dueMatch: B3 = null;
  let open: B3 = null;
  let paidMatch: B3 = null;
  if (link) {
    const amount = BigInt(String(t!.amount_cents));
    const settled = BigInt(String(t!.settled_cents));
    const cancelled = Number(t!.cancelled) === 1;
    billing = {
      id: b!.id,
      remittance_id: b!.remittance_id,
      remittance_state: one(db, 'SELECT state FROM "erp_cnab__remittance" WHERE id=?', b!.remittance_id)?.state ?? null,
      control: b!.control,
      document_number: b!.document_number,
      our_number: b!.our_number,
    };
    title = {
      id: t!.id,
      version: Number(t!.version),
      kind: t!.kind,
      description: t!.description,
      issued_on: t!.issued_on,
      due_on: t!.due_on,
      amount_cents: amount.toString(),
      settled_cents: settled.toString(),
      balance_cents: (amount - settled).toString(),
      cancelled,
    };
    refMatch = and3(eq3(b!.control, txt(payload, "control")), eq3(b!.document_number, txt(payload, "documentNumber")));
    numberMatch = eq3(b!.our_number, txt(payload, "ourNumber")) ?? false;
    amountMatch = eq3(amount.toString(), txt(payload, "amountCents"));
    dueMatch = eq3(String(t!.due_on), txt(payload, "dueDate"));
    open = !cancelled && settled === 0n;
    paidMatch = eq3((amount - settled).toString(), txt(payload, "paidCents"));
  }
  const kind = txt(payload, "kind");
  const reason = !link
    ? "UNLINKED_EVENT"
    : when(not3(refMatch))
      ? "REFERENCE_CHANGED"
      : b!.our_number === null
        ? "BANK_NUMBER_UNBOUND"
        : when(not3(numberMatch))
          ? "BANK_NUMBER_CHANGED"
          : when(or3(not3(amountMatch), not3(dueMatch)))
            ? "TITLE_AMOUNT_OR_DUE_DATE_CHANGED"
            : when(kind === null ? null : kind !== "PAID")
              ? "NON_PAYMENT_EVENT"
              : when(not3(open))
                ? "TITLE_NOT_FULLY_OPEN"
                : txt(payload, "creditDate") === null || txt(payload, "occurrenceDate") === null
                  ? "PAYMENT_DATES_MISSING"
                  : when(or3(not3(paidMatch), adjust))
                    ? "PAYMENT_AMOUNTS_REQUIRE_REVIEW"
                    : has(warnings, "INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION")
                      ? "TRAILER_AGGREGATE_REQUIRES_REVIEW"
                      : !declared
                        ? "BANK_ORIGIN_DECLARATION_MISSING"
                        : when(billing!.remittance_state === null ? null : billing!.remittance_state !== "ready")
                          ? "REMITTANCE_NOT_READY"
                          : Number(a!.active) !== 1
                            ? "ACCOUNT_INACTIVE"
                            : "EXACT_MATCH_HOMOLOGATION_ONLY";
  return {
    version: 1,
    event: {
      id: e!.id,
      hash: e!.event_hash,
      bank: txt(payload, "bank"),
      wallet: txt(payload, "wallet"),
      control: txt(payload, "control"),
      document_number: txt(payload, "documentNumber"),
      our_number: get(payload, "ourNumber"),
      occurrence: txt(payload, "occurrence"),
      kind,
      due_on: get(payload, "dueDate"),
      occurred_on: get(payload, "occurrenceDate"),
      credited_on: get(payload, "creditDate"),
      amount_cents: txt(payload, "amountCents"),
      paid_cents: txt(payload, "paidCents"),
      adjustments,
      warnings: get(payload, "warnings"),
    },
    occurrence: {
      file_id: f!.id,
      file_hash: f!.file_hash,
      line: Number(o!.line),
      line_hash: o!.line_hash,
      duplicate: Number(o!.duplicate) === 1,
      generated_on: f!.generated_on,
      declared_bank_origin: declared,
      reference_id: declared ? reference : null,
      warnings,
    },
    profile: {
      id: p!.id,
      version: p!.version,
      bank: txt(p!.identity, "bank"),
      wallet: txt(p!.identity, "wallet"),
      account_id: a!.id,
      account_name: a!.name,
      account_mask: ((r) => (r === null ? null : "***" + r))(right3(txt(p!.identity, "account"))),
      account_version: Number(a!.version),
      account_active: Number(a!.active) === 1,
      contract_verified: get(p!.settings, "contractVerified"),
      policy_verified: get(p!.settings, "simpleCollectionPolicyVerified"),
    },
    billing,
    title,
    proposal: { action: e!.proposed_action, reason: e!.reason },
    comparison: {
      source_linked: link,
      reference_matches: refMatch,
      bank_number_matches: numberMatch,
      amount_matches: amountMatch,
      due_matches: dueMatch,
      fully_open: open,
      paid_matches_balance: paidMatch,
      has_adjustments: adjust,
      reason,
    },
  };
}

/** erp_cnab.human_review_hash(context): sha256 do texto do jsonb. */
export const humanReviewHash = (context: Json) => sha256(context);

/** erp_cnab.human_review_revision_dto(event, version) */
export function humanReviewRevisionDto(db: SqlDriver, eventId: string | null, version: number | null): Json | null {
  const r =
    version === null
      ? undefined
      : one(
          db,
          'SELECT event_id, version, status, reason, context_hash, context, CAST(reviewed_at AS TEXT) reviewed_at FROM "erp_cnab__human_review_revision" WHERE event_id=? AND version=?',
          eventId,
          version,
        );
  return r
    ? {
        event_id: r.event_id,
        version: Number(r.version),
        status: r.status,
        reason: r.reason,
        context_hash: r.context_hash,
        context: parse(r.context),
        reviewed_at: ts(r.reviewed_at),
      }
    : null;
}

/** erp_cnab.human_review_detail(event, file, line) */
export function humanReviewDetail(db: SqlDriver, eventId: string | null, fileId: string | null, line: number | null) {
  const context = humanReviewContext(db, eventId, fileId, line);
  const hash = humanReviewHash(context);
  const v = one(db, 'SELECT version FROM "erp_cnab__human_review" WHERE event_id=?', eventId);
  const version = v ? Number(v.version) : null;
  const r = humanReviewRevisionDto(db, eventId, version);
  return {
    ...humanReviewSafety(),
    event_id: eventId,
    context,
    context_hash: hash,
    review_version: version ?? 0,
    review: r === null ? null : { ...r, context_changed: r.context_hash === null ? null : r.context_hash !== hash },
    bytes_verified: false,
  };
}
