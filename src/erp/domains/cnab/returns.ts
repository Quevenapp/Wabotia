// Retornos do CNAB (migrações 014, 042, 043 e 067, versões finais no
// oráculo): o gatilho occurrence_purpose_check, o estado operacional pelo
// título do retorno (return_encoding_status, require_return_operational) e o
// contexto de um evento operacional (operational_event_context), que a
// prévia, o vínculo do nosso número (C4) e a baixa (C5) conferem pelo hash.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { ErpError, raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import type { RpcContext } from "../../engine/registry.ts";
import {
  and3,
  encodingApproval,
  encodingStatus,
  eq3,
  get,
  has,
  not3,
  operationalStatus,
  or3,
  parse,
  profileRow,
  sha256,
  txt,
  type B3,
  type Json,
} from "./core.ts";

/** (x)::integer do Postgres sobre texto: espaços nas pontas e sinal valem; o resto é 22P02. */
export function pgInt(v: string | null): number | null {
  if (v === null) return null;
  if (!/^\s*[+-]?[0-9]+\s*$/.test(v)) throw new ErpError("22P02", `invalid input syntax for type integer: "${v}"`);
  const n = Number(v.trim());
  if (n < -2147483648 || n > 2147483647) throw new ErpError("22003", `value "${v}" is out of range for type integer`);
  return n;
}

/** Gatilho occurrence_purpose_check (BEFORE INSERT de return_occurrence): arquivo e evento do mesmo perfil e propósito. */
export function occurrencePurposeCheck(db: SqlDriver, file: string, event: string) {
  if (
    !one(
      db,
      'SELECT 1 x FROM "erp_cnab__return_file" f JOIN "erp_cnab__return_event" e ON e.id=? WHERE f.id=? AND f.profile_id=e.profile_id AND f.purpose=e.purpose',
      event,
      file,
    )
  )
    raise("40001", "erp_cnab_purpose_mismatch");
}

/** insert into erp_cnab.return_occurrence, com o gatilho de propósito. */
export function insertOccurrence(db: SqlDriver, file: string, line: number, event: string, lineHash: string | null, duplicate: boolean) {
  occurrencePurposeCheck(db, file, event);
  db.exec('INSERT INTO "erp_cnab__return_occurrence"(file_id, line, event_id, line_hash, duplicate) VALUES(?,?,?,?,?)', file, line, event, lineHash, duplicate ? 1 : 0);
}

/** erp_cnab.return_encoding_status(profile, billing) */
export function returnEncodingStatus(db: SqlDriver, id: string, billing: string | null): Json {
  if (billing !== null) {
    const r = one(
      db,
      `SELECT r.snapshot FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id WHERE b.id=? AND b.profile_id=? AND r.purpose='operational'`,
      billing,
      id,
    );
    if (!r) return operationalStatus(db, id) as unknown as Json;
    return encodingStatus(db, id, txt(parse(r.snapshot), "encoding_profile") ?? "itau109-no-charges-v1") as unknown as Json;
  }
  const { allowed_encoding_profiles: _a, encoding_policy: _p, ...rest } = encodingApproval(db, id);
  return rest as unknown as Json;
}

/** erp_cnab.require_return_operational(profile, expected, billing) */
export function requireReturnOperational(db: SqlDriver, id: string, expected: number | null, billing: string | null = null) {
  const s = returnEncodingStatus(db, id, billing);
  if (s.effective_enabled !== true || (expected !== null && s.approval_version !== expected)) raise("40001", "erp_cnab_operational_approval_required");
  return s;
}

/** a IS DISTINCT FROM b (null é NULL). */
const distinct = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);
/** (texto)::date: a data ou null; o leitor do arquivo só manda AAAA-MM-DD. */
const day = (v: string | null) => v;
/** a < b entre datas (texto AAAA-MM-DD), com o nulo do SQL. */
const lt = (a: string | null, b: string | null): B3 => (a === null || b === null ? null : a < b);
const gt = (a: string | null, b: string | null): B3 => (a === null || b === null ? null : a > b);
const when = (x: B3) => x === true;

/** erp_cnab.operational_event_context(event, file, line) */
export function operationalEventContext(ctx: RpcContext, eventId: string | null, fileId: string | null, line: number | null): Json {
  const db = ctx.db;
  const e = one(db, `SELECT id, profile_id, event_hash, payload, billing_title_id FROM "erp_cnab__return_event" WHERE id=? AND purpose='operational'`, eventId);
  const o = one(db, 'SELECT file_id, line, event_id, line_hash, duplicate FROM "erp_cnab__return_occurrence" WHERE file_id=? AND line=? AND event_id=?', fileId, line, eventId);
  const f = e
    ? one(db, `SELECT id, profile_id, file_hash, generated_on, warnings, evidence FROM "erp_cnab__return_file" WHERE id=? AND purpose='operational' AND profile_id=?`, fileId, e.profile_id)
    : undefined;
  if (!e || !o || !f) raise("P0002", "erp_cnab_operational_event_not_found");
  const payload = parse(e!.payload) as Json;
  const p = profileRow(db, e!.profile_id)!;
  const a = one(db, 'SELECT id, version, name, active, kind FROM "erp_finance__account" WHERE id=?', p.account_id);
  const b = e!.billing_title_id === null
    ? undefined
    : one(db, 'SELECT id, title_id, remittance_id, our_number, control, document_number, snapshot FROM "erp_cnab__billing_title" WHERE id=? AND profile_id=?', e!.billing_title_id, p.id);
  const t = b
    ? one(
        db,
        `SELECT id, version, kind, description, CAST(amount_cents AS TEXT) amount, CAST(settled_cents AS TEXT) settled, issued_on, due_on, cancelled FROM "erp_finance__title" WHERE id=?`,
        b.title_id,
      )
    : undefined;
  const auth = returnEncodingStatus(db, p.id, b ? String(b.id) : null);
  const openingRow = a ? one(db, `SELECT posted_on FROM "erp_finance__movement" WHERE account_id=? AND kind='opening'`, a.id) : undefined;
  const opening = openingRow ? String(openingRow.posted_on) : null;
  const evidence = parse(f!.evidence);
  const warnings = parse(f!.warnings);
  const reference = txt(evidence, "referenceId");
  const declared =
    and3(
      eq3(txt(evidence, "source"), "authenticated-bank-download"),
      eq3(txt(evidence, "fileHash"), f!.file_hash),
      eq3(txt(evidence, "accountId"), a ? a.id : null),
      reference === null ? null : /^[a-zA-Z0-9_-]{1,80}$/.test(reference),
    ) ?? false;
  const today = todaySaoPaulo();
  const p_ = (k: string) => txt(payload, k);
  const issues: string[] = [];
  if (auth.effective_enabled !== true) issues.push("OPERATIONAL_APPROVAL_REQUIRED");
  if (!declared) issues.push("BANK_ORIGIN_DECLARATION_REQUIRED");
  const bs = b ? parse(b.snapshot) : null;
  if (!b || !t) issues.push("EXACT_TITLE_LINK_REQUIRED");
  else {
    if (!one(db, `SELECT 1 x FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational' AND state='ready'`, b.remittance_id)) issues.push("OPERATIONAL_REMITTANCE_REQUIRED");
    if (distinct(b.control, p_("control")) || distinct(b.document_number, p_("documentNumber"))) issues.push("TITLE_REFERENCE_CHANGED");
    if (
      distinct(txt(bs, "title", "amountCents"), p_("amountCents")) ||
      distinct(txt(bs, "title", "dueOn"), p_("dueDate")) ||
      distinct(txt(bs, "title", "control"), p_("control")) ||
      distinct(txt(bs, "title", "documentNumber"), p_("documentNumber")) ||
      distinct(txt(bs, "title", "issuedOn"), String(t.issued_on))
    )
      issues.push("REMITTANCE_SNAPSHOT_DIFFERS");
    if (distinct(String(t.amount), p_("amountCents")) || distinct(String(t.due_on), p_("dueDate"))) issues.push("TITLE_AMOUNT_OR_DUE_CHANGED");
    if (t.kind !== "receivable" || Number(t.cancelled) === 1 || BigInt(String(t.settled)) !== 0n) issues.push("TITLE_NOT_FULLY_OPEN");
    if (one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE title_id=?', t.id)) issues.push("PRIOR_SETTLEMENT_HISTORY");
    if (one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=?', t.id)) issues.push("LEGACY_BANK_BINDING_REQUIRED");
  }
  if (!a || Number(a.active) !== 1 || a.kind !== "bank") issues.push("BANK_ACCOUNT_UNAVAILABLE");
  const occurred = day(p_("occurrenceDate"));
  if (occurred === null || when(gt(occurred, today)) || (t && when(lt(occurred, String(t.issued_on))))) issues.push("OCCURRENCE_DATE_INVALID");
  const bind = [...issues];
  const settle = [...issues];
  const ne = (k: string, v: string) => not3(eq3(p_(k), v));
  if (when(or3(ne("bank", "077"), ne("wallet", "112"), ne("occurrence", "02"), ne("kind", "REGISTERED")))) bind.push("INTER112_REGISTRATION_REQUIRED");
  if (!/^[0-9]{11}$/.test(p_("ourNumber") ?? "") || p_("ourNumber") === "00000000000") bind.push("BANK_NUMBER_INVALID");
  if (distinct(p_("paidCents"), "0")) bind.push("REGISTRATION_HAS_PAYMENT");
  if ((b && b.our_number !== null) || one(db, 'SELECT 1 x FROM "erp_cnab__operational_binding" WHERE event_id=? OR billing_title_id=?', e!.id, b ? b.id : null))
    bind.push("BANK_NUMBER_ALREADY_BOUND");
  if (b && p_("ourNumber") !== null && one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE profile_id=? AND id<>? AND our_number=?', p.id, b.id, p_("ourNumber")))
    bind.push("BANK_NUMBER_ALREADY_USED");
  if (when(or3(ne("occurrence", "06"), ne("kind", "PAID")))) settle.push("EXACT_PAYMENT_06_REQUIRED");
  if (!b || b.our_number === null || distinct(b.our_number, p_("ourNumber"))) settle.push("BANK_NUMBER_NOT_MATCHED");
  if (!t || distinct(p_("paidCents"), String(t.amount))) settle.push("PAYMENT_AMOUNT_DIFFERS");
  const adjustments = hasKeyOf(payload, "adjustments") ? payload.adjustments : undefined;
  const bank = p_("bank");
  const itauBad =
    bank === "341" &&
    (jsonType(adjustments) !== "object" ||
      Object.keys(adjustments as Json).length !== 6 ||
      Object.values(adjustments as Json).some((v) => v !== null && (typeof v === "string" ? v : jsonbText(v)) !== "0"));
  // e.payload->'adjustments' IS DISTINCT FROM 'null'::jsonb: chave ausente também é distinta.
  const interBad = bank === "077" && adjustments !== null;
  if (itauBad || interBad) settle.push("PAYMENT_ADJUSTMENTS_UNSUPPORTED");
  if (has(warnings, "INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION")) settle.push("TRAILER_AGGREGATE_AMBIGUOUS");
  const credited = day(p_("creditDate"));
  if (
    credited === null ||
    when(or3(gt(credited, today), lt(credited, occurred), t ? lt(credited, String(t.issued_on)) : false, opening !== null ? lt(credited, opening) : false))
  )
    settle.push("CREDIT_DATE_INVALID");
  const applied = one(
    db,
    'SELECT command_id FROM "erp_cnab__operational_settlement" WHERE event_id=? OR billing_title_id=? OR title_id=? LIMIT 1',
    e!.id,
    b ? b.id : null,
    t ? t.id : null,
  );
  if (applied) settle.push("OPERATIONAL_PAYMENT_ALREADY_APPLIED");
  const raw = (k: string) => (hasKeyOf(payload, k) ? payload[k] : null);
  return {
    version: 1,
    as_of: today,
    event: {
      id: e!.id,
      hash: e!.event_hash,
      bank: raw("bank"),
      wallet: raw("wallet"),
      control: raw("control"),
      document_number: raw("documentNumber"),
      our_number: raw("ourNumber"),
      occurrence: raw("occurrence"),
      kind: raw("kind"),
      amount_cents: raw("amountCents"),
      paid_cents: raw("paidCents"),
      due_on: raw("dueDate"),
      occurred_on: raw("occurrenceDate"),
      credited_on: raw("creditDate"),
      adjustments: raw("adjustments"),
      warnings: raw("warnings"),
    },
    file: {
      id: f!.id,
      hash: f!.file_hash,
      line: Number(o!.line),
      line_hash: o!.line_hash,
      duplicate: Number(o!.duplicate) === 1,
      generated_on: f!.generated_on,
      declared_bank_origin: declared,
      reference_id: declared ? reference : null,
      warnings,
    },
    profile: { id: p.id, version: p.version, approval_version: auth.approval_version ?? null, effective_enabled: auth.effective_enabled ?? null, account_id: p.account_id },
    account: {
      id: a ? a.id : null,
      version: a ? Number(a.version) : null,
      name: a ? a.name : null,
      active: a ? Number(a.active) === 1 : null,
      kind: a ? a.kind : null,
      opening_on: opening,
    },
    billing: b ? { id: b.id, remittance_id: b.remittance_id, our_number: b.our_number, control: b.control, document_number: b.document_number } : null,
    title: t
      ? {
          id: t.id,
          version: Number(t.version),
          kind: t.kind,
          description: t.description,
          amount_cents: String(t.amount),
          settled_cents: String(t.settled),
          balance_cents: (BigInt(String(t.amount)) - BigInt(String(t.settled))).toString(),
          issued_on: t.issued_on,
          due_on: t.due_on,
          cancelled: Number(t.cancelled) === 1,
        }
      : null,
    binding: { allowed: bind.length === 0, issues: bind },
    settlement: { allowed: settle.length === 0, issues: settle },
    applied_command_id: applied ? applied.command_id : null,
  };
}

const hasKeyOf = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** erp_cnab.operational_context_hash(context) */
export const operationalContextHash = (context: Json) => sha256(context);

export { get };
