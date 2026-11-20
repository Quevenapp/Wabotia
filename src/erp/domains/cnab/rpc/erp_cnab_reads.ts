// CNAB, bloco C1: leituras de homologação e do operacional (migrações 014,
// 042, 043 e 067). public.erp_cnab_access, _profiles, _profile_context,
// _review, _reservation, _files, _return_context, _operational_profiles(_v2),
// _operational_reservation(_v2), _operational_files(_v2), _operational_events
// e _operational_settlement_get.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { dto } from "../../finance/public.ts";
import { int, text, textArray, uuid } from "../args.ts";
import {
  access,
  coreProfile,
  encodingApproval,
  encodingSafety,
  encodingSnapshotCheck,
  get,
  has,
  lpad,
  operationalSafety,
  operationalSnapshotCheck,
  operationalStatus,
  parse,
  profileDto,
  profileRow,
  REMITTANCE_COLUMNS,
  requireOperational,
  requireOperationalForEncoding,
  SAFETY_HOMOLOGATION,
  toRemittance,
  ts,
  txt,
  withoutKeys,
  type Json,
} from "../core.ts";

const titleCount = (snapshot: unknown) => {
  const t = get(snapshot, "titles");
  return jsonType(t) === "array" ? (t as unknown[]).length : null;
};
const invalidQuery = (): never => raise("22023", "erp_cnab_invalid_query");

export function erpCnabAccess(ctx: RpcContext, a: RpcArgs) {
  const r = access(ctx.db, uuid(a, "p_user_id"));
  return { read: true, write: ["admin", "financeiro"].includes(r), configure: r === "admin", purpose: "homologation", productionReady: false, financialMutationPerformed: false };
}

/** Página por id (uuid) das remessas ou dos retornos de um propósito: items, has_more e next_cursor. */
function filePage(db: SqlDriver, purpose: string, kind: string | null, limit: number, after: string | null, remittanceName: (bank: string | null) => string) {
  const rows: { id: string; value: Json }[] = [];
  if (kind === "remittance")
    for (const r of db.exec(
      `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE purpose=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
      purpose,
      after,
      after,
      limit + 1,
    ).rows) {
      const x = toRemittance(r);
      rows.push({
        id: x.id,
        value: {
          id: x.id,
          profile_id: x.profile_id,
          kind: "remittance",
          state: x.state,
          sequence: x.sequence,
          generated_on: x.generated_on,
          created_at: ts(x.created_at),
          file_hash: x.file_hash,
          byte_size: x.byte_size,
          titles: titleCount(x.snapshot),
          filename: remittanceName(txt(x.snapshot, "profile", "bank")) + lpad(x.sequence, 7) + ".REM",
        },
      });
    }
  else if (kind === "return")
    for (const r of db.exec(
      `SELECT id, profile_id, generated_on, CAST(created_at AS TEXT) created_at, file_hash, byte_size, record_count FROM "erp_cnab__return_file"
       WHERE purpose=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
      purpose,
      after,
      after,
      limit + 1,
    ).rows)
      rows.push({
        id: String(r.id),
        value: {
          id: r.id,
          profile_id: r.profile_id,
          kind: "return",
          state: "ready",
          sequence: null,
          generated_on: r.generated_on,
          created_at: ts(r.created_at),
          file_hash: r.file_hash,
          byte_size: r.byte_size === null ? null : Number(r.byte_size),
          titles: Number(r.record_count) - 2,
          filename: `RETORNO_${r.id}.RET`,
        },
      });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: page.map((r) => r.value), limit, has_more: more, next_cursor: more ? page[page.length - 1].id : null };
}

export function erpCnabFiles(ctx: RpcContext, a: RpcArgs) {
  const kind = text(a, "p_kind");
  const limit = int(a, "p_limit");
  access(ctx.db, uuid(a, "p_user_id"));
  if ((kind !== null && !["remittance", "return"].includes(kind)) || limit === null || limit < 1 || limit > 100) invalidQuery();
  return {
    ...filePage(ctx.db, "homologation", kind, limit!, uuid(a, "p_after"), (bank) => (bank === "077" ? "CI400_001_" : "ITAU_TESTE_")),
    ...SAFETY_HOMOLOGATION,
  };
}

export function erpCnabOperationalFiles(ctx: RpcContext, a: RpcArgs) {
  const kind = text(a, "p_kind");
  const limit = int(a, "p_limit");
  access(ctx.db, uuid(a, "p_user_id"));
  if ((kind !== null && !["remittance", "return"].includes(kind)) || limit === null || limit < 1 || limit > 100) invalidQuery();
  return { ...operationalSafety(), ...filePage(ctx.db, "operational", kind, limit!, uuid(a, "p_after"), (bank) => (bank === "077" ? "CI400_001_" : "ITAU_COBRANCA_")) };
}

export function erpCnabOperationalFilesV2(ctx: RpcContext, a: RpcArgs) {
  const limit = int(a, "p_limit");
  const after = uuid(a, "p_after");
  access(ctx.db, uuid(a, "p_user_id"));
  if (limit === null || limit < 1 || limit > 100) invalidQuery();
  const rows = ctx.db
    // Migração 067: selecionar o banco/carteira antes do LIMIT. A página
    // traz no máximo limit+1 snapshots; o cursor usa o índice primário.
    .exec(`SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance"
      WHERE purpose='operational' AND json_extract(snapshot,'$.profile.bank')='341'
        AND json_extract(snapshot,'$.profile.wallet')='109' ${after === null ? "" : "AND id>?"}
      ORDER BY id LIMIT ?`, ...(after === null ? [] : [after]), limit! + 1)
    .rows.map(toRemittance);
  const more = rows.length > limit!;
  const page = rows.slice(0, limit!);
  return {
    ...encodingSafety(),
    items: page.map((r) => ({
      id: r.id,
      profile_id: r.profile_id,
      kind: "remittance",
      state: r.state,
      sequence: r.sequence,
      generated_on: r.generated_on,
      created_at: ts(r.created_at),
      file_hash: r.file_hash,
      byte_size: r.byte_size,
      titles: titleCount(r.snapshot),
      filename: "ITAU_COBRANCA_" + lpad(r.sequence, 7) + ".REM",
      encoding_profile: get(r.snapshot, "encoding_profile"),
    })),
    limit,
    has_more: more,
    next_cursor: more ? page[page.length - 1].id : null,
  };
}

const profileIds = (db: SqlDriver) => db.exec('SELECT id FROM "erp_cnab__profile" ORDER BY id').rows.map((r) => String(r.id));

export function erpCnabProfiles(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"));
  return { items: profileIds(ctx.db).map((id) => profileDto(ctx.db, id)), ...SAFETY_HOMOLOGATION };
}

export function erpCnabProfileContext(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"), true);
  const result = coreProfile(ctx.db, uuid(a, "p_profile_id"));
  if (result === null) raise("P0002", "erp_cnab_not_found");
  return result;
}

export function erpCnabOperationalProfiles(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"));
  return {
    ...operationalSafety(),
    items: profileIds(ctx.db).map((id) => ({
      profile: withoutKeys(profileDto(ctx.db, id), ["purpose", "productionReady"]),
      approval: operationalStatus(ctx.db, id),
    })),
  };
}

export function erpCnabOperationalProfilesV2(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"));
  return {
    ...encodingSafety(),
    items: profileIds(ctx.db)
      .filter((id) => {
        const p = profileRow(ctx.db, id)!;
        return txt(p.identity, "bank") === "341" && txt(p.identity, "wallet") === "109";
      })
      .map((id) => ({ profile: withoutKeys(profileDto(ctx.db, id), ["purpose", "productionReady"]), approval: encodingApproval(ctx.db, id) })),
  };
}

const reservationView = (r: ReturnType<typeof toRemittance>) => ({
  id: r.id,
  profile_id: r.profile_id,
  state: r.state,
  snapshot: r.snapshot,
  file_hash: r.file_hash,
  object_path: r.object_path,
  byte_size: r.byte_size,
});

export function erpCnabReservation(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"), true);
  const r = one(ctx.db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=? AND purpose='homologation'`, uuid(a, "p_id"));
  if (!r) raise("P0002", "erp_cnab_not_found");
  return { ...reservationView(toRemittance(r!)), ...SAFETY_HOMOLOGATION };
}

export function erpCnabOperationalReservation(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"), true);
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational'`, uuid(a, "p_id"));
  const r = row ? toRemittance(row) : null;
  if (!r || has(r.snapshot, "encoding_profile")) raise("P0002", "erp_cnab_not_found");
  const expected = int(a, "p_expected_approval");
  if (expected === null || expected < 1) raise("22023", "erp_cnab_operational_approval_required");
  const s = requireOperational(db, r!.profile_id, expected);
  operationalSnapshotCheck(db, r!.id);
  return { ...operationalSafety(), ...reservationView(r!), approval_version: s.approval_version };
}

export function erpCnabOperationalReservationV2(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"), true);
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational'`, uuid(a, "p_id"));
  const r = row ? toRemittance(row) : null;
  if (!r || !has(r.snapshot, "encoding_profile")) raise("P0002", "erp_cnab_not_found");
  const expected = int(a, "p_expected_approval");
  if (expected === null || expected < 1) raise("22023", "erp_cnab_operational_approval_required");
  const s = requireOperationalForEncoding(db, r!.profile_id, expected, txt(r!.snapshot, "encoding_profile"));
  encodingSnapshotCheck(db, r!.id);
  return { ...encodingSafety(), ...reservationView(r!), approval_version: s.approval_version, encoding_profile: get(r!.snapshot, "encoding_profile") };
}

export function erpCnabOperationalEvents(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const file = uuid(a, "p_file_id");
  const limit = int(a, "p_limit");
  const after = int(a, "p_after");
  access(db, uuid(a, "p_user_id"));
  if (limit === null || limit < 1 || limit > 100 || after === null || after < 1 || after > 9999) invalidQuery();
  if (!one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE id=? AND purpose='operational'`, file)) raise("P0002", "erp_cnab_not_found");
  const rows = db
    .exec(
      `SELECT o.line, o.duplicate, e.id, e.payload,
        (SELECT command_id FROM "erp_cnab__operational_binding" b WHERE b.event_id=e.id) binding,
        (SELECT command_id FROM "erp_cnab__operational_settlement" s WHERE s.event_id=e.id) settlement
       FROM "erp_cnab__return_occurrence" o JOIN "erp_cnab__return_event" e ON e.id=o.event_id WHERE o.file_id=? AND o.line>? ORDER BY o.line LIMIT ?`,
      file,
      after,
      limit,
    )
    .rows.map((x) => {
      const p = parse(x.payload);
      return {
        line: Number(x.line),
        duplicate: Number(x.duplicate) === 1,
        event_id: x.id,
        kind: get(p, "kind"),
        occurrence: get(p, "occurrence"),
        control: get(p, "control"),
        document_number: get(p, "documentNumber"),
        amount_cents: get(p, "amountCents"),
        paid_cents: get(p, "paidCents"),
        binding_command_id: x.binding ?? null,
        settlement_command_id: x.settlement ?? null,
      };
    });
  const last = rows.length ? rows[rows.length - 1].line : null;
  const more = !!one(db, 'SELECT 1 x FROM "erp_cnab__return_occurrence" WHERE file_id=? AND line>?', file, last ?? after);
  return { ...operationalSafety(), file_id: file, items: rows, limit, has_more: more, next_cursor: more ? last : null };
}

export function erpCnabOperationalSettlementGet(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const r = one(db, 'SELECT receipt, title_id, settlement_id FROM "erp_cnab__operational_settlement" WHERE command_id=?', uuid(a, "p_command_id"));
  if (!r) raise("P0002", "erp_cnab_not_found");
  const receipt = parse(r!.receipt);
  return {
    purpose: "operational",
    read_only: true,
    financialMutationPerformed: false,
    originAuthenticated: false,
    bankTransmissionPerformed: false,
    receipt,
    current_title: dto(db, "titles", String(r!.title_id)),
    current_account: dto(db, "accounts", txt(receipt, "account_id")),
    current_settlement: dto(db, "settlements", String(r!.settlement_id)),
  };
}

export function erpCnabReview(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const limit = int(a, "p_limit");
  const after = int(a, "p_after");
  access(db, uuid(a, "p_user_id"));
  if (limit === null || limit < 1 || limit > 100 || after === null || after < 1) raise("22023", "erp_cnab_invalid_pagination");
  const f = one(db, `SELECT id, profile_id, file_hash, warnings FROM "erp_cnab__return_file" WHERE id=? AND purpose='homologation'`, uuid(a, "p_file_id"));
  if (!f) raise("P0002", "erp_cnab_not_found");
  const items = db
    .exec(
      `SELECT o.line, o.duplicate, e.id, e.event_hash, e.billing_title_id, e.proposed_action, e.reason, e.payload FROM "erp_cnab__return_occurrence" o
       JOIN "erp_cnab__return_event" e ON e.id=o.event_id WHERE o.file_id=? AND o.line>? ORDER BY o.line LIMIT ?`,
      f!.id,
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
        billing_title_id: x.billing_title_id,
        action: x.proposed_action,
        reason: x.reason,
        control: txt(p, "control"),
        document_number: txt(p, "documentNumber"),
        our_number: txt(p, "ourNumber"),
        occurrence: txt(p, "occurrence"),
        kind: txt(p, "kind"),
        amount_cents: txt(p, "amountCents"),
        paid_cents: txt(p, "paidCents"),
        occurrence_date: txt(p, "occurrenceDate"),
        credit_date: txt(p, "creditDate"),
        canSettle: false,
      };
    });
  const last = items.length ? items[items.length - 1].line : null;
  const more = !!one(db, 'SELECT 1 x FROM "erp_cnab__return_occurrence" WHERE file_id=? AND line>?', f!.id, last ?? after);
  return {
    id: f!.id,
    profile_id: f!.profile_id,
    file_hash: f!.file_hash,
    warnings: parse(f!.warnings),
    items,
    has_more: more,
    next_cursor: more ? last : null,
    limit,
    canSettle: false,
    productionReady: false,
    financialMutationPerformed: false,
  };
}

const HASH = /^[a-f0-9]{64}$/;

export function erpCnabReturnContext(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const profile = uuid(a, "p_profile_id");
  const fileHash = text(a, "p_file_hash");
  const events = textArray(a, "p_event_hashes") ?? [];
  const controls = textArray(a, "p_controls") ?? [];
  access(db, uuid(a, "p_user_id"), true);
  const inList = (list: (string | null)[]) => (list.length ? `IN (${list.map(() => "?").join(",")})` : "IN (NULL)");
  if (
    one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=? AND purpose<>'homologation'`, profile, fileHash) ||
    one(db, `SELECT 1 x FROM "erp_cnab__return_event" WHERE profile_id=? AND event_hash ${inList(events)} AND purpose<>'homologation'`, profile, ...events) ||
    one(
      db,
      `SELECT 1 x FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id WHERE b.profile_id=? AND b.control ${inList(controls)} AND r.purpose<>'homologation'`,
      profile,
      ...controls,
    )
  )
    raise("40001", "erp_cnab_purpose_mismatch");
  const given = (v: unknown) => v !== null && v !== undefined;
  if (
    (given(fileHash) && !HASH.test(fileHash!)) ||
    (given(a.p_event_hashes) && events.length > 10000) ||
    (given(a.p_controls) && controls.length > 10000) ||
    events.some((h) => h !== null && !HASH.test(h))
  )
    raise("22023", "erp_cnab_context_invalid");
  const p = profileRow(db, profile);
  if (!p) raise("P0002", "erp_cnab_not_found");
  const titles = db
    .exec(
      `SELECT b.id, b.control, b.document_number, b.our_number, t.cancelled, CAST(t.amount_cents AS TEXT) a, CAST(t.settled_cents AS TEXT) s, t.due_on
       FROM "erp_cnab__billing_title" b JOIN "erp_finance__title" t ON t.id=b.title_id
       WHERE b.profile_id=? AND b.control ${inList(controls)} AND EXISTS(SELECT 1 FROM "erp_cnab__remittance" r WHERE r.id=b.remittance_id AND r.purpose='homologation') ORDER BY b.id`,
      p!.id,
      ...controls,
    )
    .rows.map((b) => ({
      id: b.id,
      accountScope: p!.account_scope,
      control: b.control,
      documentNumber: b.document_number,
      ourNumber: b.our_number,
      status: Number(b.cancelled) === 1 ? "cancelled" : BigInt(String(b.s)) === BigInt(String(b.a)) ? "settled" : "open",
      amountCents: String(b.a),
      outstandingCents: (BigInt(String(b.a)) - BigInt(String(b.s))).toString(),
      dueDate: b.due_on,
    }));
  return {
    profile: coreProfile(db, p!.id),
    titles,
    seenFileHashes: db.exec('SELECT file_hash FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=?', p!.id, fileHash).rows.map((r) => r.file_hash),
    seenEventHashes: db
      .exec(`SELECT event_hash FROM "erp_cnab__return_event" WHERE profile_id=? AND event_hash ${inList(events)}`, p!.id, ...events)
      .rows.map((r) => r.event_hash),
  };
}

registerRpc("erp_cnab_access", erpCnabAccess);
registerRpc("erp_cnab_files", erpCnabFiles);
registerRpc("erp_cnab_operational_files", erpCnabOperationalFiles);
registerRpc("erp_cnab_operational_files_v2", erpCnabOperationalFilesV2);
registerRpc("erp_cnab_profiles", erpCnabProfiles);
registerRpc("erp_cnab_profile_context", erpCnabProfileContext);
registerRpc("erp_cnab_operational_profiles", erpCnabOperationalProfiles);
registerRpc("erp_cnab_operational_profiles_v2", erpCnabOperationalProfilesV2);
registerRpc("erp_cnab_reservation", erpCnabReservation);
registerRpc("erp_cnab_operational_reservation", erpCnabOperationalReservation);
registerRpc("erp_cnab_operational_reservation_v2", erpCnabOperationalReservationV2);
registerRpc("erp_cnab_operational_events", erpCnabOperationalEvents);
registerRpc("erp_cnab_operational_settlement_get", erpCnabOperationalSettlementGet);
registerRpc("erp_cnab_review", erpCnabReview);
registerRpc("erp_cnab_return_context", erpCnabReturnContext);
