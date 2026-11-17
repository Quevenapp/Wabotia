// CNAB, bloco C2: perfis e remessa de homologação (migrações 014, 042 e 213,
// versões finais no oráculo). public.erp_cnab_profile_save, _approve,
// _reserve, _finalize, _file e _remittance_exclude.
// O arquivo vai para o R2 pela camada /storage/v1 (src/erp-storage.ts); aqui
// só se registra e confere hash, tamanho e caminho (erp_cnab.storage_check).
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { pgLength } from "../../../engine/text.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { keys, txt as financeTxt, uuidValue } from "../../finance/public.ts";
import { bool, date, int, json, text, uuid } from "../args.ts";
import { cnabObjectKey, finishCommand, recordCommand, startCommand, storageCheck } from "../commands.ts";
import { access, get, lpad, parse, profileDto, profileRow, REMITTANCE_COLUMNS, toRemittance, txt, type Json } from "../core.ts";
import { reserveForPurpose } from "../reserve.ts";

const hasKey = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);
/** o -> k do jsonb: undefined quando a chave falta (NULL do SQL), null quando é o JSON null. */
const field = (o: unknown, k: string) => (hasKey(o, k) ? (o as Json)[k] : undefined);
/** a IS DISTINCT FROM b entre jsonb (chave ausente é NULL). */
const distinct = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a !== b : jsonbText(a) !== jsonbText(b));
const IDENTITY_KEYS = ["bank", "layout", "agency", "account", "accountDigit", "wallet", "cnpj"];
const invalidProfile = (): never => raise("22023", "erp_cnab_invalid_profile");

export function erpCnabProfileSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_id");
  const version = int(a, "p_expected_version");
  const data = json(a, "p_data");
  access(db, user, true, true);
  keys(data, [
    "account_id", "bank", "layout", "agency", "account", "accountDigit", "wallet", "cnpj", "companyName", "agreementReference",
    "contractVerified", "simpleCollectionPolicyVerified", "reservedRange", "ourNumberStart", "remittanceSequenceStart",
  ]);
  const d = data as Json;
  const command = { id, version, data };
  const replay = startCommand(ctx, user!, uuid(a, "p_command_id"), "profile_save", command);
  if (replay) return replay;
  const account = uuidValue(d.account_id);
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : d[k] === undefined || d[k] === null ? null : jsonbText(d[k]));
  const bank = s("bank");
  const wallet = s("wallet");
  if (
    IDENTITY_KEYS.some((k) => jsonType(d[k]) !== "string") ||
    jsonType(d.remittanceSequenceStart) !== "string" ||
    (d.ourNumberStart !== undefined && d.ourNumberStart !== null && jsonType(d.ourNumberStart) !== "string")
  )
    invalidProfile();
  if (!one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, account)) raise("22023", "erp_cnab_bank_account_required");
  const re = (v: string | null, r: RegExp) => r.test(v ?? "");
  if (
    !["341", "077"].includes(bank!) ||
    (bank === "341" && (wallet !== "109" || s("layout") !== "itau-cnab400-2017-01")) ||
    (bank === "077" && (!["110", "112"].includes(wallet!) || s("layout") !== "inter-cnab400-v2.2-2024-08-26")) ||
    !re(s("agency"), /^[0-9]{4}$/) ||
    s("agency") === "0000" ||
    (bank === "077" && s("agency") !== "0001") ||
    !re(s("account"), bank === "341" ? /^[0-9]{5}$/ : /^[0-9]{9}$/) ||
    /^0+$/.test(s("account")!) ||
    !re(s("accountDigit"), /^[0-9]$/) ||
    !re(s("cnpj"), /^[0-9]{14}$/) ||
    !re(s("companyName"), /^[A-Z0-9 .&/-]{1,30}$/) ||
    pgLength(s("agreementReference") ?? "") < 1 ||
    pgLength(s("agreementReference") ?? "") > 200 ||
    jsonType(d.contractVerified) !== "boolean" ||
    jsonType(d.simpleCollectionPolicyVerified) !== "boolean" ||
    !re(s("remittanceSequenceStart"), /^[1-9][0-9]{0,6}$/)
  )
    invalidProfile();
  let nn: bigint | null;
  if (bank === "077" && wallet === "112") {
    nn = null;
    if (d.ourNumberStart !== undefined && d.ourNumberStart !== null) raise("22023", "erp_cnab_bank_assigned_number");
  } else {
    if (!re(s("ourNumberStart"), bank === "341" ? /^[0-9]{8}$/ : /^[0-9]{10}$/) || BigInt(s("ourNumberStart")!) === 0n) raise("22023", "erp_cnab_number_start_required");
    nn = BigInt(s("ourNumberStart")!);
  }
  if (bank === "077" && wallet === "110") {
    const range = d.reservedRange;
    keys(range, ["verified", "start", "end"]);
    const r = range as Json;
    const rs = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    if (
      jsonType(r.verified) !== "boolean" ||
      !re(rs("start"), /^[0-9]{10}$/) ||
      !re(rs("end"), /^[0-9]{10}$/) ||
      nn! < BigInt(rs("start")!) ||
      nn! > BigInt(rs("end")!)
    )
      raise("22023", "erp_cnab_invalid_range");
  } else if (hasKey(d, "reservedRange")) raise("22023", "erp_cnab_range_not_applicable");
  const identity: Json = Object.fromEntries(IDENTITY_KEYS.map((k) => [k, d[k]]));
  const settings: Json = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "account_id" && !IDENTITY_KEYS.includes(k)));
  const scope = [bank, s("agency"), s("account"), s("accountDigit"), wallet, s("cnpj")].join(":");
  const seq = BigInt(s("remittanceSequenceStart")!);
  const now = () => ctx.clock.next().toString();
  let pid: string;
  if (id === null) {
    if (version !== 0) raise("40001", "erp_cnab_version_conflict");
    // Unicidade na ordem em que o Postgres confere os índices (o primeiro violado dá a mensagem).
    const duplicate = (name: string) => raise("23505", `duplicate key value violates unique constraint "${name}"`);
    if (one(db, 'SELECT 1 x FROM "erp_cnab__profile" WHERE account_scope=?', scope)) duplicate("profile_account_scope_key");
    if (
      one(
        db,
        `SELECT 1 x FROM "erp_cnab__profile" WHERE identity->>'bank'=? AND identity->>'agency'=? AND identity->>'account'=?`,
        bank,
        s("agency"),
        s("account"),
      )
    )
      duplicate("erp_cnab_profile_bank_account");
    if (one(db, 'SELECT 1 x FROM "erp_cnab__profile" WHERE account_id=?', account)) duplicate("erp_cnab_profile_financial_account");
    pid = crypto.randomUUID();
    const t = now();
    db.exec(
      `INSERT INTO "erp_cnab__profile"(id, account_id, identity, settings, account_scope, next_sequence, next_our_number, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      pid,
      account,
      JSON.stringify(identity),
      JSON.stringify(settings),
      scope,
      seq.toString(),
      nn === null ? null : nn.toString(),
      user,
      t,
      t,
      t,
    );
  } else {
    const p = profileRow(db, id);
    if (!p) raise("P0002", "erp_cnab_not_found");
    if (
      p!.version !== version ||
      jsonbText(p!.identity) !== jsonbText(identity) ||
      p!.account_id !== account ||
      distinct(field(p!.settings, "ourNumberStart"), field(settings, "ourNumberStart")) ||
      distinct(field(p!.settings, "remittanceSequenceStart"), field(settings, "remittanceSequenceStart")) ||
      distinct(field(p!.settings, "reservedRange"), field(settings, "reservedRange"))
    )
      raise("40001", "erp_cnab_identity_or_version_conflict");
    const t = now();
    db.exec('UPDATE "erp_cnab__profile" SET settings=?, version=version+1, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?', JSON.stringify(settings), user, t, t, p!.id);
    pid = p!.id;
  }
  return finishCommand(ctx, user!, uuid(a, "p_command_id")!, "profile_save", command, pid, { profile: profileDto(db, pid) });
}

export function erpCnabApprove(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_id");
  const version = int(a, "p_expected_version");
  const data = json(a, "p_data");
  access(db, user, true, true);
  keys(data, ["contract_verified", "policy_verified", "range_verified", "reference"]);
  const d = data as Json;
  if (jsonType(d.contract_verified) !== "boolean" || jsonType(d.policy_verified) !== "boolean" || (hasKey(d, "range_verified") && jsonType(d.range_verified) !== "boolean"))
    raise("22023", "erp_cnab_invalid_approval");
  financeTxt(d, "reference", 120, true);
  const command = { id, version, data };
  const replay = startCommand(ctx, user!, uuid(a, "p_command_id"), "approve", command);
  if (replay) return replay;
  const p = profileRow(db, id);
  if (!p) raise("P0002", "erp_cnab_not_found");
  if (p!.version !== version) raise("40001", "erp_cnab_version_conflict");
  let settings: Json = { ...p!.settings };
  if (txt(p!.identity, "bank") === "077" && txt(p!.identity, "wallet") === "110") {
    if (!hasKey(d, "range_verified")) raise("22023", "erp_cnab_range_confirmation_required");
    const range = get(settings, "reservedRange");
    // jsonb_set(settings, '{reservedRange,verified}', …): só muda quando reservedRange é objeto.
    if (jsonType(range) === "object") settings = { ...settings, reservedRange: { ...(range as Json), verified: d.range_verified } };
  } else if (hasKey(d, "range_verified")) raise("22023", "erp_cnab_range_not_applicable");
  settings = {
    ...settings,
    contractVerified: d.contract_verified,
    simpleCollectionPolicyVerified: d.policy_verified,
    agreementReference: typeof d.reference === "string" ? d.reference : d.reference === null || d.reference === undefined ? null : jsonbText(d.reference),
  };
  const t = ctx.clock.next().toString();
  db.exec('UPDATE "erp_cnab__profile" SET settings=?, version=version+1, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?', JSON.stringify(settings), user, t, t, p!.id);
  return finishCommand(ctx, user!, uuid(a, "p_command_id")!, "approve", command, p!.id, { profile: profileDto(db, p!.id) });
}

export const erpCnabReserve = (ctx: RpcContext, a: RpcArgs) =>
  reserveForPurpose(ctx, {
    user: uuid(a, "p_user_id"),
    command: uuid(a, "p_command_id"),
    profile: uuid(a, "p_profile_id"),
    expectedVersion: int(a, "p_expected_version"),
    generatedOn: date(a, "p_generated_on"),
    titles: json(a, "p_titles"),
    preview: bool(a, "p_preview"),
    purpose: "homologation",
    expectedApproval: null,
  });

/** Confirmações do perfil exigidas para gerar o arquivo (mesmas da reserva). */
function requireConfirmed(p: NonNullable<ReturnType<typeof profileRow>>) {
  if (
    get(p.settings, "contractVerified") !== true ||
    get(p.settings, "simpleCollectionPolicyVerified") !== true ||
    (txt(p.identity, "bank") === "077" && txt(p.identity, "wallet") === "110" && get(p.settings, "reservedRange", "verified") !== true)
  )
    raise("40001", "erp_cnab_profile_unconfirmed");
}

/** Títulos e contatos da remessa mudaram desde a reserva? (erp_cnab_snapshot_stale) */
const snapshotStale = (db: SqlDriver, remittance: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_cnab__billing_title" bt JOIN "erp_finance__title" t ON t.id=bt.title_id JOIN "erp_catalog__record" c ON c.id=t.contact_id
     WHERE bt.remittance_id=? AND (t.version<>CAST(json_extract(bt.snapshot,'$.finance_title_version') AS INTEGER) OR t.cancelled=1 OR t.settled_cents<>0
       OR c.version<>CAST(json_extract(bt.snapshot,'$.contact_version') AS INTEGER) OR c.active=0)`,
    remittance,
  );

/**
 * O manifesto do arquivo gerado (cnab-core) contra os títulos da remessa:
 * grava o nosso número com o dígito. Comum ao finalize de homologação e ao
 * operacional v1 (C3).
 */
export function applyManifest(ctx: RpcContext, remittance: string, manifest: unknown) {
  const db = ctx.db;
  const count = Number(one(db, 'SELECT count(*) n FROM "erp_cnab__billing_title" WHERE remittance_id=?', remittance)!.n);
  if (jsonType(manifest) !== "array" || (manifest as unknown[]).length !== count) raise("22023", "erp_cnab_manifest_invalid");
  const rows = manifest as unknown[];
  const ids = rows.map((row) => txt(row, "titleId")).filter((x) => x !== null);
  if (new Set(ids).size !== rows.length) raise("22023", "erp_cnab_manifest_duplicate");
  for (const row of rows) {
    keys(row, ["titleId", "control", "documentNumber", "amountCents", "dueDate", "ourNumber"]);
    const b = one(
      db,
      'SELECT id, control, document_number, our_number_base, snapshot FROM "erp_cnab__billing_title" WHERE id=? AND remittance_id=?',
      uuidValue(get(row, "titleId")),
      remittance,
    );
    const snap = b ? parse(b.snapshot) : null;
    if (
      !b ||
      txt(row, "control") !== b.control ||
      txt(row, "documentNumber") !== b.document_number ||
      txt(row, "amountCents") !== txt(snap, "title", "amountCents") ||
      txt(row, "dueDate") !== txt(snap, "title", "dueOn")
    )
      raise("40001", "erp_cnab_manifest_mismatch");
    const n = txt(row, "ourNumber");
    const base = b!.our_number_base as string | null;
    if (base === null) {
      if (n !== null) raise("40001", "erp_cnab_manifest_number");
    } else if (n === null || !/^[0-9]+$/.test(n) || n.length !== base.length + 1 || n.slice(0, base.length) !== base) raise("40001", "erp_cnab_manifest_number");
    db.exec('UPDATE "erp_cnab__billing_title" SET our_number=? WHERE id=?', n, b!.id);
  }
}

export function erpCnabFinalize(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const id = uuid(a, "p_id");
  const hash = text(a, "p_hash");
  const size = int(a, "p_size");
  const path = text(a, "p_path");
  const manifest = json(a, "p_manifest");
  access(db, user, true);
  if (!one(db, `SELECT 1 x FROM "erp_cnab__remittance" WHERE id=? AND purpose='homologation'`, id)) raise("P0002", "erp_cnab_not_found");
  const command = { id, hash, size, path, manifest };
  const replay = startCommand(ctx, user!, uuid(a, "p_command_id"), "finalize", command);
  if (replay) return replay;
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS}, manifest FROM "erp_cnab__remittance" WHERE id=?`, id)!;
  const r = toRemittance(row);
  const stored = row.manifest;
  storageCheck(ctx, r.profile_id, "remittances", hash, size, path);
  if (r.state === "ready") {
    // file_hash<>hash or byte_size<>size or manifest<>p_manifest: manifesto nulo não recusa.
    const manifestDiffers = manifest === null || stored === null ? false : jsonbText(parse(stored)) !== jsonbText(manifest);
    if (r.file_hash !== hash || r.byte_size !== size || manifestDiffers) raise("40001", "erp_cnab_finalized_conflict");
  } else {
    const p = profileRow(db, r.profile_id)!;
    requireConfirmed(p);
    if (!one(db, `SELECT 1 x FROM "erp_finance__account" WHERE id=? AND active=1 AND kind='bank'`, p.account_id)) raise("40001", "erp_cnab_bank_account_required");
    if (snapshotStale(db, r.id)) raise("40001", "erp_cnab_snapshot_stale");
    applyManifest(ctx, r.id, manifest);
    db.exec(
      `UPDATE "erp_cnab__remittance" SET state='ready', object_path=?, file_hash=?, byte_size=?, manifest=?, finalized_at=? WHERE id=?`,
      path,
      hash,
      size,
      JSON.stringify(manifest),
      ctx.clock.next().toString(),
      r.id,
    );
  }
  return finishCommand(ctx, user!, uuid(a, "p_command_id")!, "finalize", command, r.id, {
    id: r.id,
    profile_id: r.profile_id,
    state: "ready",
    sequence: r.sequence,
    file_hash: hash,
    byte_size: size,
  });
}

/** O arquivo registrado de uma remessa pronta ou de um retorno (homologação). */
function fileRecord(db: SqlDriver, kind: string | null, id: string | null) {
  if (kind === "remittance") {
    const r = one(
      db,
      `SELECT r.id, r.profile_id, r.file_hash, r.byte_size, r.object_path, CAST(r.sequence AS TEXT) sequence, p.identity FROM "erp_cnab__remittance" r
       JOIN "erp_cnab__profile" p ON p.id=r.profile_id WHERE r.id=? AND r.purpose='homologation' AND r.state='ready'`,
      id,
    );
    return r
      ? {
          id: String(r.id),
          profile_id: String(r.profile_id),
          hash: r.file_hash as string | null,
          size: r.byte_size === null ? null : Number(r.byte_size),
          path: r.object_path as string | null,
          filename: (txt(parse(r.identity), "bank") === "077" ? "CI400_001_" : "ITAU_TESTE_") + lpad(String(r.sequence), 7) + ".REM",
        }
      : null;
  }
  if (kind === "return") {
    const f = one(db, `SELECT id, profile_id, file_hash, byte_size, object_path FROM "erp_cnab__return_file" WHERE id=? AND purpose='homologation'`, id);
    return f
      ? { id: String(f.id), profile_id: String(f.profile_id), hash: f.file_hash as string, size: Number(f.byte_size), path: f.object_path as string, filename: `RETORNO_${f.id}.RET` }
      : null;
  }
  return raise("22023", "erp_cnab_invalid_kind");
}

export function erpCnabFile(ctx: RpcContext, a: RpcArgs) {
  const kind = text(a, "p_kind");
  access(ctx.db, uuid(a, "p_user_id"));
  const result = fileRecord(ctx.db, kind, uuid(a, "p_id"));
  if (!result) raise("P0002", "erp_cnab_not_found");
  storageCheck(ctx, result!.profile_id, kind === "return" ? "returns" : "remittances", result!.hash, result!.size, result!.path);
  return result;
}

/**
 * Chave do objeto que erp_cnab_file confere: vem do banco (o caminho
 * registrado), não dos argumentos. Com o banco à mão, antes da transação,
 * o objeto erp: a consulta; sem ele, nenhuma (e a conferência recusa).
 */
const fileObjects = (a: RpcArgs, db?: SqlDriver) => {
  if (!db) return [];
  try {
    const r = fileRecord(db, text(a, "p_kind"), uuid(a, "p_id"));
    return r?.path ? [cnabObjectKey(r.path)] : [];
  } catch {
    return [];
  }
};

export function erpCnabRemittanceExclude(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const data = json(a, "p_data");
  access(db, user, true);
  if (data === null || jsonType(data) !== "object") raise("22023", "erp_cnab_invalid_query");
  keys(data, ["id", "sequence"]);
  const replay = startCommand(ctx, user!, command, "remittance_exclude", data);
  if (replay) return replay;
  const d = data as Json;
  const row = one(db, `SELECT ${REMITTANCE_COLUMNS} FROM "erp_cnab__remittance" WHERE id=?`, uuidValue(d.id));
  if (!row) raise("P0002", "erp_cnab_not_found");
  const r = toRemittance(row!);
  if (jsonType(d.sequence) !== "string" || d.sequence !== r.sequence) raise("40001", "erp_cnab_version_conflict");
  if (r.state !== "reserved" || r.object_path !== null || r.file_hash !== null) raise("40001", "erp_cnab_remittance_has_file");
  const p = profileRow(db, r.profile_id)!;
  if (one(db, 'SELECT 1 x FROM "erp_cnab__return_event" e JOIN "erp_cnab__billing_title" b ON b.id=e.billing_title_id WHERE b.remittance_id=?', r.id))
    raise("40001", "erp_cnab_remittance_in_use");
  const titles = db
    .exec(
      'SELECT id, title_id, profile_id, remittance_id, control, document_number, our_number_base, our_number, snapshot FROM "erp_cnab__billing_title" WHERE remittance_id=? ORDER BY id',
      r.id,
    )
    .rows.map((b) => ({ ...b, snapshot: parse(b.snapshot) }));
  db.exec('DELETE FROM "erp_cnab__billing_title" WHERE remittance_id=?', r.id);
  db.exec('DELETE FROM "erp_cnab__remittance" WHERE id=?', r.id);
  // O número reservado só volta quando é o último entregue (nunca houve arquivo com ele).
  let released = false;
  if (
    BigInt(p.next_sequence) === BigInt(r.sequence) + 1n &&
    !one(db, 'SELECT 1 x FROM "erp_cnab__remittance" WHERE profile_id=? AND sequence>=?', p.id, r.sequence)
  ) {
    db.exec('UPDATE "erp_cnab__profile" SET next_sequence=?, version=version+1, updated_at=? WHERE id=?', r.sequence, ctx.clock.next().toString(), p.id);
    released = true;
  }
  db.exec(
    `INSERT INTO "erp_cnab__remittance_exclusion"(remittance_id, profile_id, sequence, generated_on, purpose, snapshot, titles, released_sequence, actor, command_id, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    r.id,
    r.profile_id,
    r.sequence,
    r.generated_on,
    r.purpose,
    JSON.stringify(r.snapshot),
    JSON.stringify(titles),
    released ? 1 : 0,
    user,
    command,
    ctx.clock.next().toString(),
  );
  access(db, user, true);
  const result = {
    entity: "cnab_remittance_exclusion",
    record: { id: r.id, sequence: r.sequence, titles: titles.length, released_sequence: released },
    data_mode: "erp_native",
    replayed: false,
  };
  return recordCommand(ctx, user!, command!, "remittance_exclude", data, r.id, result);
}

registerRpc("erp_cnab_profile_save", erpCnabProfileSave);
registerRpc("erp_cnab_approve", erpCnabApprove);
registerRpc("erp_cnab_reserve", erpCnabReserve);
registerRpc("erp_cnab_finalize", erpCnabFinalize, { objects: (a) => [cnabObjectKey(text(a, "p_path") ?? "")] });
registerRpc("erp_cnab_file", erpCnabFile, { objects: fileObjects });
registerRpc("erp_cnab_remittance_exclude", erpCnabRemittanceExclude);
