// CNAB, bloco C3: remessa operacional v1 (migração 042) e v2, a codificação
// Itaú 109 (migração 067), nas versões finais do oráculo.
// public.erp_cnab_operational_approve e _v2, _operational_reserve e _v2,
// _operational_finalize e _v2, _operational_file e _v2 e
// _operational_command_v2. Nenhuma transmite ao banco nem mexe no financeiro.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { bool, date, int, json, text, textArray, uuid } from "../args.ts";
import { cnabObjectKey, operationalFinish, startCommand, storageCheck } from "../commands.ts";
import {
  access,
  encodingApproval,
  encodingSafety,
  encodingSnapshotCheck,
  get,
  lpad,
  operationalConfigHash,
  operationalSafety,
  operationalSnapshotCheck,
  operationalStatus,
  parse,
  profileRow,
  REMITTANCE_COLUMNS,
  requireOperational,
  requireOperationalForEncoding,
  sha256,
  toRemittance,
  ts,
  txt,
  type Json,
} from "../core.ts";
import { finalizeRemittance, NO_CHARGES, OBSERVED } from "../finalize.ts";
import { encodingAccess, reserveForPurpose } from "../reserve.ts";

const ENCODINGS = [NO_CHARGES, OBSERVED];
/** btrim(x, espaços Unicode do Fagoo): sobra algo além de espaço? */
const SPACE_CODES = [0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
const onlySpaces = (s: string) => [...s].every((c) => SPACE_CODES.includes(c.codePointAt(0)!));

function companyIdentity(db: SqlDriver) {
  const c = one(db, 'SELECT version, data FROM "erp_company__identity" WHERE singleton=1');
  return c ? { version: Number(c.version), data: parse(c.data) } : null;
}

/** erp_cnab_operational_approve (v1) e _v2: a aprovação operacional versionada do perfil. */
function approve(ctx: RpcContext, a: RpcArgs, v2: boolean) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const profile = uuid(a, "p_profile_id");
  const expectedApproval = int(a, "p_expected_approval");
  const expectedProfile = int(a, "p_expected_profile");
  const expectedIdentity = int(a, "p_expected_identity");
  const enabled = bool(a, "p_enabled");
  const confirmedOn = date(a, "p_confirmed_on");
  const reference = text(a, "p_reference");
  access(db, user, true, true);
  if (
    profile === null ||
    expectedApproval === null ||
    expectedApproval < 0 ||
    expectedApproval > 2147483646 ||
    expectedProfile === null ||
    expectedProfile < 1 ||
    enabled === null ||
    confirmedOn === null ||
    confirmedOn < "2000-01-01" ||
    confirmedOn > todaySaoPaulo() ||
    reference === null ||
    pgLength(pgBtrim(reference)) < 3 ||
    pgLength(pgBtrim(reference)) > 200 ||
    pgHasCntrl.test(reference) ||
    onlySpaces(reference)
  )
    raise("22023", "erp_cnab_operational_approval_invalid");
  let allowed: string[] = [];
  let compatibility: boolean | null = null;
  let acknowledged: boolean | null = null;
  if (v2) {
    const list = textArray(a, "p_allowed_encoding_profiles");
    compatibility = bool(a, "p_compatibility_confirmed");
    acknowledged = bool(a, "p_permanent_instructions_acknowledged");
    if (
      list === null ||
      list.length > 2 ||
      list.includes(null) ||
      (enabled && list.length === 0) ||
      (!enabled && list.length !== 0) ||
      list.some((x) => !ENCODINGS.includes(x!)) ||
      new Set(list).size !== list.length ||
      compatibility === null ||
      acknowledged === null ||
      compatibility !== list.includes(OBSERVED) ||
      acknowledged !== compatibility
    )
      raise("22023", "erp_cnab_encoding_confirmation_required");
    allowed = list as string[];
  }
  let cmd: Json = {
    profile_id: profile,
    approval_version: expectedApproval,
    profile_version: expectedProfile,
    identity_version: expectedIdentity,
    enabled,
    confirmed_on: confirmedOn,
    reference,
  };
  if (v2) cmd = { ...cmd, allowed_encoding_profiles: allowed, compatibility_confirmed: compatibility, permanent_instructions_acknowledged: acknowledged };
  const action = v2 ? "operational_approve_v2" : "operational_approve";
  const command = uuid(a, "p_command_id");
  const replay = startCommand(ctx, user!, command, action, cmd);
  if (v2) encodingAccess(ctx, user, true);
  if (replay) return replay;
  const p = profileRow(db, profile);
  if (!p) raise("P0002", "erp_cnab_not_found");
  if (v2 && (txt(p!.identity, "bank") !== "341" || txt(p!.identity, "wallet") !== "109")) raise("22023", "erp_cnab_encoding_profile_unsupported");
  const c = companyIdentity(db);
  const current = one(db, 'SELECT version FROM "erp_cnab__operational_approval" WHERE profile_id=?', profile);
  const v = current ? Number(current.version) : 0;
  if (v !== expectedApproval || p!.version !== expectedProfile || (c ? c.version : null) !== expectedIdentity) raise("40001", "erp_cnab_operational_version_conflict");
  const bankOk = !!one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, p!.account_id);
  const simpleRequired = v2 ? allowed.includes(NO_CHARGES) : true;
  if (
    enabled &&
    (!c ||
      txt(c.data, "cnpj") !== txt(p!.identity, "cnpj") ||
      !bankOk ||
      get(p!.settings, "contractVerified") !== true ||
      (simpleRequired && get(p!.settings, "simpleCollectionPolicyVerified") !== true) ||
      (txt(p!.identity, "bank") === "077" && txt(p!.identity, "wallet") === "110" && get(p!.settings, "reservedRange", "verified") !== true))
  )
    raise("40001", "erp_cnab_operational_prerequisites");
  const next = v + 1;
  if (v2) encodingAccess(ctx, user, true);
  const now = ctx.clock.next().toString();
  const trimmed = pgBtrim(reference!);
  db.exec(
    `INSERT INTO "erp_cnab__operational_approval_revision"(profile_id, version, enabled, profile_config_hash, profile_version, identity_version, company_cnpj, reference, confirmed_on, actor, command_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    p!.id,
    next,
    enabled ? 1 : 0,
    operationalConfigHash(db, p!.id),
    p!.version,
    c ? c.version : null,
    c ? txt(c.data, "cnpj") : null,
    trimmed,
    confirmedOn,
    user,
    command,
    now,
  );
  db.exec(
    'INSERT INTO "erp_cnab__operational_approval"(profile_id, version) VALUES(?,?) ON CONFLICT(profile_id) DO UPDATE SET version=excluded.version',
    p!.id,
    next,
  );
  if (v2) {
    const policy = sha256({
      profile_id: p!.id,
      approval_version: next,
      allowed_encoding_profiles: allowed,
      compatibility_confirmed: compatibility,
      permanent_instructions_acknowledged: acknowledged,
      reference: trimmed,
      confirmed_on: confirmedOn,
    });
    db.exec(
      `INSERT INTO "erp_cnab__operational_encoding_revision"(profile_id, approval_version, allowed_encoding_profiles, compatibility_confirmed, permanent_instructions_acknowledged, policy_hash)
       VALUES(?,?,?,?,?,?)`,
      p!.id,
      next,
      JSON.stringify(allowed),
      compatibility ? 1 : 0,
      acknowledged ? 1 : 0,
      policy,
    );
    return operationalFinish(ctx, user!, command!, action, cmd, p!.id, { ...encodingSafety(), profile_id: p!.id, approval: encodingApproval(db, p!.id) });
  }
  return operationalFinish(ctx, user!, command!, action, cmd, p!.id, { approval: operationalStatus(db, p!.id) });
}

export const erpCnabOperationalApprove = (ctx: RpcContext, a: RpcArgs) => approve(ctx, a, false);
export const erpCnabOperationalApproveV2 = (ctx: RpcContext, a: RpcArgs) => approve(ctx, a, true);

export function erpCnabOperationalReserve(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const approval = int(a, "p_expected_approval");
  const confirm = bool(a, "p_confirm_operational");
  const preview = bool(a, "p_preview");
  const hash = text(a, "p_preview_hash");
  access(ctx.db, user, true);
  if (approval === null || approval < 1 || confirm === null || (preview === false && !confirm)) raise("22023", "erp_cnab_operational_confirmation_required");
  if ((preview === true && hash !== null) || (preview === false && (hash === null || !/^[a-f0-9]{64}$/.test(hash)))) raise("22023", "erp_cnab_operational_preview_required");
  return reserveForPurpose(ctx, {
    user,
    command: uuid(a, "p_command_id"),
    profile: uuid(a, "p_profile_id"),
    expectedVersion: int(a, "p_expected_version"),
    generatedOn: date(a, "p_generated_on"),
    titles: json(a, "p_titles"),
    preview,
    purpose: "operational",
    expectedApproval: approval,
    previewHash: hash,
  });
}

export function erpCnabOperationalReserveV2(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const encoding = text(a, "p_encoding_profile");
  const approval = int(a, "p_expected_approval");
  const confirmEncoding = bool(a, "p_confirm_encoding_profile");
  const confirm = bool(a, "p_confirm_operational");
  const zero = textArray(a, "p_zero_daily_title_ids");
  const preview = bool(a, "p_preview");
  const hash = text(a, "p_preview_hash");
  access(ctx.db, user, true);
  // Três valores do Postgres: com p_preview nulo, as duas últimas linhas dão nulo e não recusam.
  if (
    encoding === null ||
    !ENCODINGS.includes(encoding) ||
    approval === null ||
    approval < 1 ||
    confirmEncoding === null ||
    confirm === null ||
    zero === null ||
    zero.length > 30 ||
    zero.includes(null) ||
    new Set(zero.map((x) => x!.toLowerCase())).size !== zero.length ||
    (encoding === NO_CHARGES && zero.length > 0) ||
    (preview === true && (confirmEncoding || confirm || hash !== null)) ||
    (preview === false && (!confirmEncoding || !confirm || hash === null || !/^[a-f0-9]{64}$/.test(hash)))
  )
    raise("22023", "erp_cnab_encoding_confirmation_required");
  return reserveForPurpose(ctx, {
    user,
    command: uuid(a, "p_command_id"),
    profile: uuid(a, "p_profile_id"),
    expectedVersion: int(a, "p_expected_version"),
    generatedOn: date(a, "p_generated_on"),
    titles: json(a, "p_titles"),
    preview,
    purpose: "operational",
    expectedApproval: approval,
    previewHash: hash,
    encoding: { profile: encoding!, zeroIds: zero.map((x) => x!.toLowerCase()) },
  });
}

/** erp_cnab_operational_finalize (v1) e _v2. */
function finalize(ctx: RpcContext, a: RpcArgs, v2: boolean) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_id");
  const hash = text(a, "p_hash");
  const size = int(a, "p_size");
  const path = text(a, "p_path");
  const manifest = json(a, "p_manifest");
  const expected = int(a, "p_expected_approval");
  access(db, user, true);
  if (expected === null || expected < 1) raise("22023", "erp_cnab_operational_approval_required");
  const command = { id, hash, size, path, manifest, approval_version: expected };
  const action = v2 ? "operational_finalize_v2" : "operational_finalize";
  const replay = startCommand(ctx, user!, uuid(a, "p_command_id"), action, command);
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS}, manifest FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational'`, id);
  const r = row ? toRemittance(row) : null;
  if (!r || Object.prototype.hasOwnProperty.call(r.snapshot ?? {}, "encoding_profile") !== v2) raise("P0002", "erp_cnab_not_found");
  const encoding = v2 ? txt(r!.snapshot, "encoding_profile") : null;
  if (v2) {
    encodingAccess(ctx, user);
    requireOperationalForEncoding(db, r!.profile_id, expected, encoding);
    encodingSnapshotCheck(db, r!.id);
  } else {
    requireOperational(db, r!.profile_id, expected);
    operationalSnapshotCheck(db, r!.id);
  }
  if (replay) return replay;
  storageCheck(ctx, r!.profile_id, "remittances", hash, size, path);
  finalizeRemittance(ctx, r!, {
    hash,
    size,
    path,
    manifest,
    stored: row!.manifest,
    simple: !v2 || encoding === NO_CHARGES,
    encoding,
    beforeSnapshot: v2 ? () => encodingAccess(ctx, user) : undefined,
  });
  let result: Json = { id: r!.id, profile_id: r!.profile_id, state: "ready", sequence: r!.sequence, file_hash: hash, byte_size: size };
  if (v2) result = { ...encodingSafety(), ...result, encoding_profile: get(r!.snapshot, "encoding_profile"), approval_version: expected };
  return operationalFinish(ctx, user!, uuid(a, "p_command_id")!, action, command, r!.id, result);
}

export const erpCnabOperationalFinalize = (ctx: RpcContext, a: RpcArgs) => finalize(ctx, a, false);
export const erpCnabOperationalFinalizeV2 = (ctx: RpcContext, a: RpcArgs) => finalize(ctx, a, true);

/** A remessa operacional pronta da família pedida (v1: sem encoding_profile; v2: com). */
function readyRemittance(db: SqlDriver, id: string | null, v2: boolean) {
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational' AND state='ready'`, id);
  const r = row ? toRemittance(row) : null;
  return r && Object.prototype.hasOwnProperty.call(r.snapshot ?? {}, "encoding_profile") === v2 ? r : null;
}

function file(ctx: RpcContext, a: RpcArgs, v2: boolean) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const r = readyRemittance(db, uuid(a, "p_id"), v2);
  if (!r) raise("P0002", "erp_cnab_not_found");
  let approval;
  if (v2) {
    approval = requireOperationalForEncoding(db, r!.profile_id, null, txt(r!.snapshot, "encoding_profile"));
    encodingSnapshotCheck(db, r!.id);
  } else {
    approval = requireOperational(db, r!.profile_id, null);
    operationalSnapshotCheck(db, r!.id);
  }
  storageCheck(ctx, r!.profile_id, "remittances", r!.file_hash, r!.byte_size, r!.object_path);
  const body = {
    id: r!.id,
    profile_id: r!.profile_id,
    hash: r!.file_hash,
    size: r!.byte_size,
    path: r!.object_path,
    approval_version: approval.approval_version,
    filename: (txt(r!.snapshot, "profile", "bank") === "077" ? "CI400_001_" : "ITAU_COBRANCA_") + lpad(r!.sequence, 7) + ".REM",
  };
  return v2 ? { ...encodingSafety(), ...body, encoding_profile: get(r!.snapshot, "encoding_profile") } : { ...operationalSafety(), ...body };
}

export const erpCnabOperationalFile = (ctx: RpcContext, a: RpcArgs) => file(ctx, a, false);
export const erpCnabOperationalFileV2 = (ctx: RpcContext, a: RpcArgs) => file(ctx, a, true);

/** Chave do arquivo que o download confere: o caminho gravado na remessa (lido antes da transação). */
const fileObjects = (v2: boolean) => (a: RpcArgs, db?: SqlDriver) => {
  if (!db) return [];
  try {
    const r = readyRemittance(db, uuid(a, "p_id"), v2);
    return r?.object_path ? [cnabObjectKey(r.object_path)] : [];
  } catch {
    return [];
  }
};

export function erpCnabOperationalCommandV2(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_command_id");
  access(db, user);
  const c = one(db, 'SELECT id, result FROM "erp_cnab__command" WHERE id=? AND actor=?', id, user);
  const result = c ? (parse(c.result) as Json) : null;
  const audited = (actions: string[]) =>
    !!one(db, `SELECT 1 x FROM "erp_cnab__audit" WHERE command_id=? AND action IN (${actions.map(() => "?").join(",")})`, id, ...actions);
  if (!c || txt(result, "contract") !== "itau109-operational-v2" || !audited(["operational_reserve_v2", "operational_finalize_v2", "operational_approve_v2"]))
    raise("P0002", "erp_cnab_not_found");
  if (audited(["operational_approve_v2"])) {
    access(db, user, false, true);
    const profile = txt(result, "profile_id");
    return {
      ...encodingSafety(),
      kind: "approval",
      read_only: true,
      command_id: id,
      receipt: result,
      current: { profile_id: get(result, "profile_id"), approval: encodingApproval(db, profile!) },
    };
  }
  const row = one(
    db,
    `SELECT ${REMITTANCE_COLUMNS}, CAST(finalized_at AS TEXT) finalized FROM "erp_cnab__remittance" WHERE id=? AND purpose='operational'`,
    txt(result, "id"),
  );
  const r = row ? toRemittance(row) : null;
  if (!r || !Object.prototype.hasOwnProperty.call(r.snapshot ?? {}, "encoding_profile")) raise("P0002", "erp_cnab_not_found");
  return {
    ...encodingSafety(),
    kind: "remittance",
    read_only: true,
    command_id: id,
    receipt: result,
    current: {
      id: r!.id,
      profile_id: r!.profile_id,
      state: r!.state,
      sequence: r!.sequence,
      encoding_profile: get(r!.snapshot, "encoding_profile"),
      file_hash: r!.file_hash,
      byte_size: r!.byte_size,
      created_at: ts(r!.created_at),
      finalized_at: ts(row!.finalized),
    },
  };
}

registerRpc("erp_cnab_operational_approve", erpCnabOperationalApprove);
registerRpc("erp_cnab_operational_approve_v2", erpCnabOperationalApproveV2);
registerRpc("erp_cnab_operational_reserve", erpCnabOperationalReserve);
registerRpc("erp_cnab_operational_reserve_v2", erpCnabOperationalReserveV2);
registerRpc("erp_cnab_operational_finalize", erpCnabOperationalFinalize, { objects: (a) => [cnabObjectKey(text(a, "p_path") ?? "")] });
registerRpc("erp_cnab_operational_finalize_v2", erpCnabOperationalFinalizeV2, { objects: (a) => [cnabObjectKey(text(a, "p_path") ?? "")] });
registerRpc("erp_cnab_operational_file", erpCnabOperationalFile, { objects: fileObjects(false) });
registerRpc("erp_cnab_operational_file_v2", erpCnabOperationalFileV2, { objects: fileObjects(true) });
registerRpc("erp_cnab_operational_command_v2", erpCnabOperationalCommandV2);
