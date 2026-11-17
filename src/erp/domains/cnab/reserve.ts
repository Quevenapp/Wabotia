// erp_cnab.reserve_for_purpose (migração 042, versão final no oráculo): a
// reserva da remessa de homologação (erp_cnab_reserve, C2) e da operacional
// v1 (erp_cnab_operational_reserve, C3). Com p_preview, só a prévia: nada é
// gravado e o recibo não é aberto.
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText, jsonType } from "../../engine/json.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { expected, keys, txt as financeTxt, uuidValue } from "../finance/public.ts";
import { finishCommand, operationalFinish, startCommand } from "./commands.ts";
import {
  access,
  coreProfile,
  encodingAuthorization,
  encodingSafety,
  encodingTerms,
  get,
  operationalConfigHash,
  profileRow,
  requireOperational,
  requireOperationalForEncoding,
  sha256,
  txt,
  type Json,
} from "./core.ts";

const hasKey = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);
const bytes = (v: unknown) => new TextEncoder().encode(jsonbText(v)).length;
/** substr(replace(gen_random_uuid()::text,'-',''),1,25) em maiúsculas. */
const newControl = () => crypto.randomUUID().replace(/-/g, "").slice(0, 25).toUpperCase();

/** guard_origin_import_billing (BEFORE INSERT de erp_cnab.billing_title): título importado do Origin não vai para remessa. */
export function guardOriginImportBilling(ctx: RpcContext, title: string) {
  if (one(ctx.db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=?', title)) raise("40001", "erp_origin_import_bank_mapping_pending");
}

export interface ReserveInput {
  user: string | null;
  command: string | null;
  profile: string | null;
  expectedVersion: number | null;
  generatedOn: string | null;
  titles: unknown;
  preview: boolean | null;
  purpose: string | null;
  expectedApproval: number | null;
  previewHash?: string | null;
  /**
   * Remessa operacional v2 (erp_cnab_operational_reserve_v2, migração 067):
   * o perfil de codificação e os títulos com juros diários zero confirmados.
   * Ausente na homologação e na v1.
   */
  encoding?: { profile: string; zeroIds: string[] };
}

/** erp_cnab.encoding_access(actor, admin): administrador ou financeiro ativo. */
export function encodingAccess(ctx: RpcContext, actor: string | null, admin = false) {
  const r = actor === null ? undefined : one(ctx.db, 'SELECT role, active FROM "erp_access__membership" WHERE user_id=?', actor);
  if (!r || Number(r.active) !== 1 || !["admin", "financeiro"].includes(String(r.role)) || (admin && r.role !== "admin")) raise("42501", "erp_cnab_access_denied");
}

export function reserveForPurpose(ctx: RpcContext, i: ReserveInput) {
  const db = ctx.db;
  access(db, i.user, true);
  const user = i.user!;
  if (i.purpose === null || !["homologation", "operational"].includes(i.purpose)) raise("22023", "erp_cnab_invalid_purpose");
  if (i.preview === null) raise("22023", "erp_cnab_preview_required");
  const operational = i.purpose === "operational";
  let command: Json = { profile_id: i.profile, version: i.expectedVersion, generated_on: i.generatedOn, titles: i.titles };
  const v2 = i.encoding ?? null;
  if (operational) command = { ...command, purpose: i.purpose, approval_version: i.expectedApproval, preview_hash: i.previewHash ?? null };
  if (operational && v2) command = { ...command, encoding_profile: v2.profile, zero_daily_title_ids: v2.zeroIds };
  const action = operational ? (v2 ? "operational_reserve_v2" : "operational_reserve") : "reserve";
  let replay: Json | null = null;
  if (!i.preview) {
    replay = startCommand(ctx, user, i.command, action, command);
    if (replay !== null && !operational) return replay;
  }
  const today = todaySaoPaulo();
  const titles = i.titles;
  if (
    jsonType(titles) !== "array" ||
    (titles as unknown[]).length < 1 ||
    (titles as unknown[]).length > 30 ||
    bytes(titles) > 65536 ||
    i.generatedOn === null ||
    i.generatedOn < "2000-01-01" ||
    i.generatedOn > today
  )
    raise("22023", "erp_cnab_invalid_reservation");
  const list = titles as unknown[];
  if (new Set(list.map((row) => uuidValue(get(row, "title_id")))).size !== list.length) raise("22023", "erp_cnab_duplicate_title");
  const p = profileRow(db, i.profile);
  if (!p) raise("P0002", "erp_cnab_not_found");
  let approval: Json | null = null;
  let authorization: Json | null = null;
  if (operational) {
    if (v2) {
      encodingAccess(ctx, user);
      approval = requireOperationalForEncoding(db, p!.id, i.expectedApproval, v2.profile) as unknown as Json;
      authorization = encodingAuthorization(db, p!.id, i.expectedApproval) as unknown as Json;
    } else approval = requireOperational(db, p!.id, i.expectedApproval) as unknown as Json;
    if (replay !== null) return replay;
    if (i.generatedOn !== today) raise("22023", "erp_cnab_operational_generation_date");
  }
  const bank = txt(p!.identity, "bank");
  const wallet = txt(p!.identity, "wallet");
  if (v2) {
    if (bank !== "341" || wallet !== "109") raise("22023", "erp_cnab_encoding_profile_unsupported");
    // y->>'title_id' = x::text: o texto do pedido contra o uuid canônico.
    if (v2.zeroIds.some((x) => !list.some((y) => txt(y, "title_id") === x))) raise("22023", "erp_cnab_zero_confirmation_invalid");
  }
  if (p!.version !== i.expectedVersion) raise("40001", "erp_cnab_version_conflict");
  if (
    get(p!.settings, "contractVerified") !== true ||
    ((!v2 || v2.profile === "itau109-no-charges-v1") && get(p!.settings, "simpleCollectionPolicyVerified") !== true) ||
    (bank === "077" && wallet === "110" && get(p!.settings, "reservedRange", "verified") !== true)
  )
    raise("40001", "erp_cnab_profile_unconfirmed");
  const sequence = BigInt(p!.next_sequence);
  if (sequence > 9999999n) raise("40001", "erp_cnab_sequence_exhausted");
  const rid = crypto.randomUUID();
  const now = () => ctx.clock.next().toString();
  if (!i.preview)
    db.exec(
      `INSERT INTO "erp_cnab__remittance"(id, profile_id, sequence, generated_on, snapshot, actor, purpose, created_at) VALUES(?,?,?,?,'{}',?,?,?)`,
      rid,
      p!.id,
      sequence.toString(),
      i.generatedOn,
      user,
      i.purpose,
      now(),
    );
  if (!one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, p!.account_id)) raise("40001", "erp_cnab_bank_account_required");
  if (v2) encodingAccess(ctx, user);
  const pending: Json[] = [];
  const row0 = one(db, 'SELECT next_our_number FROM "erp_cnab__profile" WHERE id=?', p!.id)!;
  let nextOurNumber: bigint | null = row0.next_our_number === null ? null : BigInt(String(row0.next_our_number));
  const results: Json[] = [];
  const proofs: Json[] = [];
  for (const row of list) {
    keys(row, ["title_id", "expected_version", "document_number", "payment_limit_days"]);
    const t = one(
      db,
      `SELECT id, version, kind, cancelled, CAST(settled_cents AS TEXT) settled, CAST(amount_cents AS TEXT) amount, issued_on, due_on, contact_id FROM "erp_finance__title" WHERE id=?`,
      uuidValue(get(row, "title_id")),
    );
    if (!t) raise("P0002", "erp_cnab_title_not_found");
    if (operational && one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=?', t!.id)) raise("40001", "erp_cnab_legacy_binding_required");
    const amount = BigInt(String(t!.amount));
    const version = expected(get(row, "expected_version"));
    if (
      Number(t!.version) !== version ||
      t!.kind !== "receivable" ||
      Number(t!.cancelled) === 1 ||
      BigInt(String(t!.settled)) !== 0n ||
      String(t!.issued_on) > i.generatedOn! ||
      String(t!.due_on) < i.generatedOn! ||
      amount > 9999999999999n ||
      (bank === "077" && amount < 250n) ||
      one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE title_id=?', t!.id)
    )
      raise("40001", "erp_cnab_title_not_eligible");
    const c = one(
      db,
      `SELECT r.name, r.version, r.active, x.person_type, x.document, x.street, x.number, x.complement, x.district, x.city, x.state, x.postal_code
       FROM "erp_catalog__record" r JOIN "erp_catalog__contact" x ON x.record_id=r.id WHERE r.id=?`,
      t!.contact_id,
    );
    // not c.active or c.person_type not in ('F','J'): tipo nulo dá nulo e não recusa (como no Postgres).
    if (!c || Number(c.active) !== 1 || (c.person_type !== null && !["F", "J"].includes(String(c.person_type)))) raise("22023", "erp_cnab_payer_required");
    const doc = financeTxt(row, "document_number", 10, true)!;
    if (!/^[A-Z0-9 .&/-]{1,10}$/.test(doc) || doc !== doc.replace(/^ +| +$/g, "")) raise("22023", "erp_cnab_document_number_invalid");
    const control = newControl();
    const bid = crypto.randomUUID();
    let base: string | null = null;
    if (nextOurNumber !== null) {
      const limit = bank === "341" ? 99999999n : BigInt(String(txt(p!.settings, "reservedRange", "end")));
      if (nextOurNumber > limit) raise("40001", "erp_cnab_number_range_exhausted");
      base = nextOurNumber.toString().padStart(bank === "341" ? 8 : 10, "0");
      nextOurNumber += 1n;
    }
    const nonEmpty = (v: unknown) => (v === null || v === "" ? null : String(v));
    const payer = {
      type: c!.person_type === "F" ? "01" : "02",
      document: c!.document ?? null,
      name: c!.name,
      address: [nonEmpty(c!.street), nonEmpty(c!.number), nonEmpty(c!.complement)].filter((x) => x !== null).join(" "),
      neighborhood: c!.district ?? "",
      city: c!.city ?? "",
      state: c!.state ?? null,
      postalCode: c!.postal_code ?? null,
    };
    let input: Json = { id: bid, control, documentNumber: doc, amountCents: amount.toString(), issuedOn: t!.issued_on, dueOn: t!.due_on, payer };
    if (base !== null) input = { ...input, ourNumber: base };
    if (bank === "077") {
      const days = expected(get(row, "payment_limit_days"));
      if (days > 60) raise("22023", "erp_cnab_payment_limit_invalid");
      input = { ...input, paymentLimitDays: days };
    } else if (hasKey(row, "payment_limit_days")) raise("22023", "erp_cnab_payment_limit_not_applicable");
    if (v2?.profile === "itau109-origin-observed-v1") {
      const zero = v2.zeroIds.includes(String(t!.id));
      const terms = encodingTerms(amount, String(t!.due_on), zero);
      input = { ...input, encodingTerms: terms };
      if (terms.dailyInterestCents === "0" && !zero) pending.push({ code: "ZERO_DAILY_FIELD_UNCONFIRMED", title_id: t!.id });
    }
    const snap = { title: input, finance_title_version: Number(t!.version), contact_version: Number(c!.version), finance_title_id: t!.id };
    const { id: _id, control: _control, ...proofTitle } = input;
    proofs.push({ ...snap, contact_id: t!.contact_id, title: proofTitle });
    if (one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE profile_id=? AND document_number=?', p!.id, doc)) raise("40001", "erp_cnab_document_number_used");
    if (!i.preview) {
      guardOriginImportBilling(ctx, String(t!.id));
      db.exec(
        `INSERT INTO "erp_cnab__billing_title"(id, title_id, profile_id, remittance_id, control, document_number, our_number_base, snapshot) VALUES(?,?,?,?,?,?,?,?)`,
        bid,
        t!.id,
        p!.id,
        rid,
        control,
        doc,
        base,
        JSON.stringify(snap),
      );
    }
    results.push(input);
  }
  let snap: Json = { profile: coreProfile(db, p!.id), titles: results, generatedOn: i.generatedOn, remittanceSequence: sequence.toString(), purpose: i.purpose };
  if (v2) snap = { ...snap, encoding_profile: v2.profile, encoding_authorization: authorization };
  let previewHash: string | null = null;
  if (operational) {
    snap = {
      ...snap,
      operational_authorization: {
        approval_version: i.expectedApproval,
        profile_config_hash: operationalConfigHash(db, p!.id),
        identity_version: approval!.identity_version ?? null,
      },
    };
    previewHash = sha256({
      profile_id: p!.id,
      profile_version: p!.version,
      profile: snap.profile,
      sequence: sequence.toString(),
      generated_on: i.generatedOn,
      approval: snap.operational_authorization,
      ...(v2 ? { encoding_profile: v2.profile, encoding_authorization: authorization } : {}),
      titles: proofs,
    });
    if (!i.preview && previewHash !== (i.previewHash ?? null)) raise("40001", "erp_cnab_operational_preview_changed");
    snap = { ...snap, preview_hash: previewHash };
  }
  if (v2 && !i.preview && pending.length > 0) raise("22023", "erp_cnab_zero_confirmation_required");
  if (i.preview) {
    const preview = { snapshot: snap, profile_id: p!.id, profile_version: p!.version, preview: true, preview_hash: previewHash, preview_items: proofs };
    return v2 ? { ...encodingSafety(), ...preview, encoding_profile: v2.profile, can_reserve: pending.length === 0, pending } : preview;
  }
  db.exec('UPDATE "erp_cnab__remittance" SET snapshot=? WHERE id=?', JSON.stringify(snap), rid);
  db.exec(
    'UPDATE "erp_cnab__profile" SET next_sequence=?, next_our_number=?, version=version+1, updated_at=? WHERE id=?',
    (sequence + 1n).toString(),
    nextOurNumber === null ? null : nextOurNumber.toString(),
    now(),
    p!.id,
  );
  let result: Json = { id: rid, profile_id: p!.id, sequence: sequence.toString(), state: "reserved" };
  if (v2) result = { ...encodingSafety(), ...result, encoding_profile: v2.profile, approval_version: i.expectedApproval };
  return operational ? operationalFinish(ctx, user, i.command!, action, command, rid, result) : finishCommand(ctx, user, i.command!, action, command, rid, result);
}
