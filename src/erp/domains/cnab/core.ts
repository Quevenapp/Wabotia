// Cobrança bancária (erp_cnab): ajudantes do domínio. Portado das funções
// internas das migrações 014, 024, 042, 043, 058, 066, 067 e 213 (versões
// finais no oráculo): acesso, DTOs, segurança, estado operacional e da
// codificação Itaú 109, conferência humana e as listas.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { permitted } from "../access/public.ts";
import { requireAccess } from "../finance/public.ts";

export type Json = Record<string, unknown>;
export const parse = (v: unknown): unknown => (v === null || v === undefined ? null : JSON.parse(String(v)));
export const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));
export const sha256 = (v: unknown) => createHash("sha256").update(jsonbText(v), "utf8").digest("hex");

/** jsonb -> 'k' (null quando falta) */
export function get(o: unknown, ...keys: string[]): unknown {
  let v = o;
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Json)[k];
  }
  return v === undefined ? null : v;
}
/** jsonb ->> 'k' */
export function txt(o: unknown, ...keys: string[]): string | null {
  const v = get(o, ...keys);
  return v === null ? null : typeof v === "string" ? v : jsonbText(v);
}
/** jsonb ? 'k' (chave de objeto, elemento texto de array ou o próprio texto) */
export function has(o: unknown, key: string): boolean {
  if (o === null || o === undefined) return false;
  if (Array.isArray(o)) return o.some((x) => x === key);
  if (typeof o === "object") return key in (o as Json);
  return o === key;
}

// Lógica de três valores do SQL (null = desconhecido).
export type B3 = boolean | null;
export const eq3 = (a: unknown, b: unknown): B3 => (a === null || a === undefined || b === null || b === undefined ? null : a === b);
export const and3 = (...xs: B3[]): B3 => (xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true);
export const or3 = (...xs: B3[]): B3 => (xs.some((x) => x === true) ? true : xs.some((x) => x === null) ? null : false);
export const not3 = (x: B3): B3 => (x === null ? null : !x);

/** erp_cnab.access(actor, write, admin): o papel do Financeiro; configurar pede administrador. */
export function access(db: SqlDriver, actor: string | null, write = false, admin = false): string {
  const r = requireAccess(db, actor as string, write);
  if (admin && r !== "admin") raise("42501", "erp_cnab_admin_required");
  return r;
}

export const SAFETY_HOMOLOGATION = { purpose: "homologation", productionReady: false, financialMutationPerformed: false };
/**
 * erp_finance.require_permission(user, key), como as listas da 213 a chamam:
 * erp_access.permitted (público no Acesso) e o erro do Financeiro.
 */
export function financePermission(db: SqlDriver, user: string | null, key: string) {
  if (user === null || !permitted(db, user, key)) raise("42501", "erp_finance_permission_denied");
}
/** erp_cnab.operational_safety() */
export const operationalSafety = () => ({ purpose: "operational", productionReady: false, bankTransmissionPerformed: false, financialMutationPerformed: false, originAuthenticated: false });
/** erp_cnab.encoding_safety() */
export const encodingSafety = () => ({ ...operationalSafety(), contract: "itau109-operational-v2" });
/** erp_cnab.human_review_safety() */
export const humanReviewSafety = () => ({ purpose: "homologation", productionReady: false, canSettle: false, financialMutationPerformed: false, originAuthenticated: false });

export interface Profile {
  id: string;
  account_id: string;
  identity: Json;
  settings: Json;
  account_scope: string;
  next_sequence: string;
  version: number;
}
export function profileRow(db: SqlDriver, id: unknown): Profile | null {
  const p = id === null || id === undefined ? undefined : one(db, 'SELECT id, account_id, identity, settings, account_scope, CAST(next_sequence AS TEXT) next_sequence, version FROM "erp_cnab__profile" WHERE id=?', id);
  return p
    ? {
        id: String(p.id),
        account_id: String(p.account_id),
        identity: parse(p.identity) as Json,
        settings: parse(p.settings) as Json,
        account_scope: String(p.account_scope),
        next_sequence: String(p.next_sequence),
        version: Number(p.version),
      }
    : null;
}

/** erp_cnab.profile_dto(id) */
export function profileDto(db: SqlDriver, id: string) {
  const p = profileRow(db, id);
  const a = p ? one(db, 'SELECT name FROM "erp_finance__account" WHERE id=?', p.account_id) : undefined;
  if (!p || !a) return null;
  const account = txt(p.identity, "account");
  return {
    id: p.id,
    account_id: p.account_id,
    account_name: a.name,
    bank: txt(p.identity, "bank"),
    wallet: txt(p.identity, "wallet"),
    account_mask: account === null ? null : "***" + [...account].slice(-3).join(""),
    company_name: txt(p.settings, "companyName"),
    version: p.version,
    contract_verified: get(p.settings, "contractVerified"),
    policy_verified: get(p.settings, "simpleCollectionPolicyVerified"),
    next_sequence: p.next_sequence,
    purpose: "homologation",
    productionReady: false,
  };
}
export const withoutKeys = (o: Json | null, keys: string[]) => (o === null ? null : Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))));

/** erp_cnab.core_profile(id): identity || settings || {accountId} */
export function coreProfile(db: SqlDriver, id: unknown): Json | null {
  const p = profileRow(db, id);
  return p ? { ...p.identity, ...p.settings, accountId: p.account_id } : null;
}

/** erp_cnab.bank_label(code) */
export const bankLabel = (code: string | null) => (code === "341" ? "Itaú" : code === "077" ? "Inter" : (code ?? ""));
/** erp_cnab.remittance_filename(r) */
export const remittanceFilename = (snapshot: unknown, sequence: string) =>
  (txt(snapshot, "profile", "bank") === "077" ? "CI400_001_" : "ITAU_COBRANCA_") + lpad(sequence, 7) + ".REM";
/** lpad(x, n, '0') do Postgres: completa à esquerda ou corta à direita. */
export const lpad = (s: string, n: number) => ([...s].length >= n ? [...s].slice(0, n).join("") : s.padStart(n, "0"));
/** erp_cnab.return_group(kind) */
export const returnGroup = (kind: string | null) =>
  kind === "REGISTERED" ? "entries" : kind !== null && ["PAID", "PARTIAL_PAYMENT", "NOTARY_PAYMENT", "CLOSED_AFTER_PAYMENT"].includes(kind) ? "settlements" : "others";
/** erp_cnab.return_number(file) */
export const returnNumber = (evidence: unknown) => {
  const s = txt(evidence, "fileSequence");
  return s !== null && /^[0-9]{1,7}$/.test(s) ? s : null;
};
/** erp_cnab.return_applied(file) */
export const returnApplied = (db: SqlDriver, file: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_cnab__return_occurrence" o WHERE o.file_id=? AND (
       EXISTS(SELECT 1 FROM "erp_cnab__operational_binding" b WHERE b.event_id=o.event_id)
       OR EXISTS(SELECT 1 FROM "erp_cnab__operational_settlement" s WHERE s.event_id=o.event_id)
       OR EXISTS(SELECT 1 FROM "erp_cnab__human_review" h WHERE h.event_id=o.event_id))`,
    file,
  );

/** erp_cnab.operational_config_hash(profile) */
export function operationalConfigHash(db: SqlDriver, id: string): string | null {
  const p = profileRow(db, id);
  return p ? sha256({ identity: p.identity, settings: p.settings, account_id: p.account_id }) : null;
}

const companyIdentity = (db: SqlDriver) => {
  const c = one(db, 'SELECT version, data FROM "erp_company__identity" WHERE singleton=1');
  return c ? { version: Number(c.version), data: parse(c.data) as Json } : null;
};

/** erp_cnab.operational_status_base_067(profile) */
export function operationalStatusBase(db: SqlDriver, id: string) {
  const p = profileRow(db, id);
  if (!p) raise("P0002", "erp_cnab_not_found");
  const a = one(
    db,
    `SELECT r.* FROM "erp_cnab__operational_approval" h JOIN "erp_cnab__operational_approval_revision" r ON r.profile_id=h.profile_id AND r.version=h.version WHERE h.profile_id=?`,
    id,
  );
  const c = companyIdentity(db);
  const bank = one(db, 'SELECT active, kind FROM "erp_finance__account" WHERE id=?', p!.account_id);
  const issues: string[] = [];
  if (!a) issues.push("OPERATIONAL_APPROVAL_MISSING");
  else if (Number(a.enabled) !== 1) issues.push("OPERATIONAL_APPROVAL_DISABLED");
  if (!c) issues.push("COMPANY_IDENTITY_MISSING");
  else if (txt(c.data, "cnpj") !== txt(p!.identity, "cnpj")) issues.push("BENEFICIARY_CNPJ_MISMATCH");
  if (!bank || Number(bank.active) !== 1 || bank.kind !== "bank") issues.push("BANK_ACCOUNT_INACTIVE");
  if (
    get(p!.settings, "contractVerified") !== true ||
    get(p!.settings, "simpleCollectionPolicyVerified") !== true ||
    (txt(p!.identity, "bank") === "077" && txt(p!.identity, "wallet") === "110" && get(p!.settings, "reservedRange", "verified") !== true)
  )
    issues.push("BANK_CONTRACT_OR_POLICY_PENDING");
  if (
    a &&
    (a.profile_config_hash !== operationalConfigHash(db, id) ||
      (a.identity_version === null ? null : Number(a.identity_version)) !== (c ? c.version : null) ||
      a.company_cnpj !== (c ? txt(c.data, "cnpj") : null))
  )
    issues.push("OPERATIONAL_APPROVAL_STALE");
  return {
    profile_id: p!.id,
    approval_version: a ? Number(a.version) : 0,
    enabled: a ? Number(a.enabled) === 1 : false,
    effective_enabled: issues.length === 0,
    profile_version: p!.version,
    identity_version: c ? c.version : null,
    reference: a ? a.reference : null,
    confirmed_on: a ? a.confirmed_on : null,
    reviewed_at: a ? ts(a.created_at) : null,
    issues: issues as unknown[],
  };
}

const ENCODINGS = ["itau109-no-charges-v1", "itau109-origin-observed-v1"];
const encodingRevision = (db: SqlDriver, id: string, approval: number) => {
  const r = one(db, 'SELECT * FROM "erp_cnab__operational_encoding_revision" WHERE profile_id=? AND approval_version=?', id, approval);
  return r
    ? {
        allowed: parse(r.allowed_encoding_profiles) as string[],
        policy_hash: String(r.policy_hash),
        compatibility_confirmed: Number(r.compatibility_confirmed) === 1,
        permanent_instructions_acknowledged: Number(r.permanent_instructions_acknowledged) === 1,
      }
    : null;
};

/** erp_cnab.encoding_status(profile, encoding) */
export function encodingStatus(db: SqlDriver, id: string, encoding: string | null) {
  if (encoding === null || !ENCODINGS.includes(encoding)) raise("22023", "erp_cnab_encoding_invalid");
  const s = operationalStatusBase(db, id);
  const p = profileRow(db, id)!;
  const r = encodingRevision(db, id, s.approval_version);
  let issues = s.issues;
  if (encoding === "itau109-origin-observed-v1" && get(p.settings, "contractVerified") === true && txt(p.identity, "bank") === "341" && txt(p.identity, "wallet") === "109")
    issues = issues.filter((x) => x !== "BANK_CONTRACT_OR_POLICY_PENDING");
  if ((!r && encoding !== "itau109-no-charges-v1") || (r && !r.allowed.includes(encoding!)))
    if (!issues.includes("BANK_CONTRACT_OR_POLICY_PENDING")) issues = [...issues, "BANK_CONTRACT_OR_POLICY_PENDING"];
  return { ...s, issues, effective_enabled: issues.length === 0 };
}
/** erp_cnab.operational_status(profile) */
export const operationalStatus = (db: SqlDriver, id: string) => encodingStatus(db, id, "itau109-no-charges-v1");

/** erp_cnab.encoding_approval(profile) */
export function encodingApproval(db: SqlDriver, id: string) {
  const base = operationalStatusBase(db, id);
  const r = encodingRevision(db, id, base.approval_version);
  const allowed = r ? r.allowed : ["itau109-no-charges-v1"];
  const s = encodingStatus(db, id, allowed.includes("itau109-origin-observed-v1") ? "itau109-origin-observed-v1" : "itau109-no-charges-v1");
  return {
    ...s,
    allowed_encoding_profiles: allowed,
    encoding_policy: r
      ? { policy_hash: r.policy_hash, compatibility_confirmed: r.compatibility_confirmed, permanent_instructions_acknowledged: r.permanent_instructions_acknowledged }
      : null,
  };
}

/** erp_cnab.require_operational(profile, expected) */
export function requireOperational(db: SqlDriver, id: string, expected: number | null) {
  const s = operationalStatus(db, id);
  if (s.effective_enabled !== true || (expected !== null && s.approval_version !== expected)) raise("40001", "erp_cnab_operational_approval_required");
  return s;
}
/** erp_cnab.require_operational_for_encoding(profile, expected, encoding) */
export function requireOperationalForEncoding(db: SqlDriver, id: string, expected: number | null, encoding: string | null) {
  const s = encodingStatus(db, id, encoding);
  if (s.effective_enabled !== true || (expected !== null && s.approval_version !== expected)) raise("40001", "erp_cnab_operational_approval_required");
  return s;
}

export interface Remittance {
  id: string;
  profile_id: string;
  sequence: string;
  generated_on: string;
  state: string;
  snapshot: Json;
  object_path: string | null;
  file_hash: string | null;
  byte_size: number | null;
  created_at: string;
  purpose: string;
}
export const REMITTANCE_COLUMNS =
  'id, profile_id, CAST(sequence AS TEXT) sequence, generated_on, state, snapshot, object_path, file_hash, byte_size, CAST(created_at AS TEXT) created_at, purpose';
export const toRemittance = (r: Json): Remittance => ({
  id: String(r.id),
  profile_id: String(r.profile_id),
  sequence: String(r.sequence),
  generated_on: String(r.generated_on),
  state: String(r.state),
  snapshot: parse(r.snapshot) as Json,
  object_path: (r.object_path as string | null) ?? null,
  file_hash: (r.file_hash as string | null) ?? null,
  byte_size: r.byte_size === null ? null : Number(r.byte_size),
  created_at: String(r.created_at),
  purpose: String(r.purpose),
});

/** erp_cnab.operational_snapshot_check(remittance) */
export function operationalSnapshotCheck(db: SqlDriver, id: string) {
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational'`, id);
  const r = row ? toRemittance(row) : null;
  const c = companyIdentity(db);
  if (
    !r ||
    txt(r.snapshot, "purpose") !== "operational" ||
    txt(r.snapshot, "operational_authorization", "profile_config_hash") !== operationalConfigHash(db, r.profile_id) ||
    txt(r.snapshot, "operational_authorization", "identity_version") !== (c ? String(c.version) : null)
  )
    raise("40001", "erp_cnab_operational_snapshot_stale");
}

/** erp_cnab.encoding_authorization(profile, approval version) */
export function encodingAuthorization(db: SqlDriver, id: string, version: number | null) {
  const a = version === null ? undefined : one(db, 'SELECT * FROM "erp_cnab__operational_approval_revision" WHERE profile_id=? AND version=?', id, version);
  if (!a) raise("40001", "erp_cnab_operational_approval_required");
  const r = encodingRevision(db, id, Number(a!.version));
  return {
    approval_version: Number(a!.version),
    policy_hash: r ? r.policy_hash : sha256({ legacy_approval: a!.profile_id, version: Number(a!.version), config: a!.profile_config_hash }),
    reference: a!.reference,
    confirmed_on: a!.confirmed_on,
    compatibility_confirmed: r ? r.compatibility_confirmed : false,
    permanent_instructions_acknowledged: r ? r.permanent_instructions_acknowledged : false,
  };
}

/** erp_cnab.encoding_terms(amount, due, zero) */
export function encodingTerms(amount: bigint | null, due: string | null, zero: boolean | null) {
  if (amount === null || amount < 1n || amount > 9999999999999n || due === null || due < "2000-01-01" || due > "2099-12-30" || zero === null)
    raise("22023", "erp_cnab_encoding_terms_invalid");
  const daily = (amount! + 1500n) / 3000n;
  if (daily > 0n && zero) raise("22023", "erp_cnab_zero_confirmation_not_applicable");
  const next = new Date(Date.parse(`${due}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    profile: "itau109-origin-observed-v1",
    version: 1,
    dailyInterestCents: daily.toString(),
    interestDateField: due,
    penaltyPercentHundredths: "200",
    penaltyDateField: next,
    zeroDailyInterestConfirmed: zero,
  };
}

/** erp_cnab.encoding_snapshot_check(remittance) */
export function encodingSnapshotCheck(db: SqlDriver, id: string) {
  operationalSnapshotCheck(db, id);
  const r = toRemittance(one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=?`, id)!);
  const invalid = (): never => raise("40001", "erp_cnab_encoding_snapshot_invalid");
  const e = txt(r.snapshot, "encoding_profile");
  const titles = get(r.snapshot, "titles");
  if (
    e === null ||
    !ENCODINGS.includes(e) ||
    jsonType(titles) !== "array" ||
    (titles as unknown[]).length < 1 ||
    (titles as unknown[]).length > 30 ||
    jsonbText(get(r.snapshot, "profile")) !== jsonbText(coreProfile(db, r.profile_id)) ||
    txt(r.snapshot, "generatedOn") !== r.generated_on ||
    txt(r.snapshot, "remittanceSequence") !== r.sequence
  )
    invalid();
  const v = Number(txt(r.snapshot, "operational_authorization", "approval_version"));
  const a = encodingAuthorization(db, r.profile_id, v);
  const rev = encodingRevision(db, r.profile_id, v);
  const allowed = rev ? rev.allowed : ["itau109-no-charges-v1"];
  const count = Number(one(db, 'SELECT count(*) n FROM "erp_cnab__billing_title" WHERE remittance_id=?', r.id)!.n);
  if (
    jsonbText(get(r.snapshot, "encoding_authorization")) !== jsonbText(a) ||
    !allowed.includes(e!) ||
    (e === "itau109-origin-observed-v1" && (a.compatibility_confirmed !== true || a.permanent_instructions_acknowledged !== true)) ||
    count !== (titles as unknown[]).length
  )
    invalid();
  for (const t of titles as Json[]) {
    const b = one(db, 'SELECT snapshot FROM "erp_cnab__billing_title" WHERE id=? AND remittance_id=?', txt(t, "id"), r.id);
    if (!b || jsonbText(get(parse(b.snapshot), "title")) !== jsonbText(t)) invalid();
    if (e === "itau109-origin-observed-v1") {
      const amount = txt(t, "amountCents");
      const zero = get(t, "encodingTerms", "zeroDailyInterestConfirmed");
      const expected = encodingTerms(amount === null ? null : BigInt(amount), txt(t, "dueOn"), typeof zero === "boolean" ? zero : null);
      if (
        jsonbText(get(t, "encodingTerms")) !== jsonbText(expected) ||
        (txt(t, "encodingTerms", "dailyInterestCents") === "0" && get(t, "encodingTerms", "zeroDailyInterestConfirmed") !== true)
      )
        raise("40001", "erp_cnab_encoding_terms_mismatch");
    } else if (has(t, "encodingTerms") || has(t, "collectionTerms")) raise("40001", "erp_cnab_encoding_terms_mismatch");
  }
}
