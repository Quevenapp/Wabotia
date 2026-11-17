// CNAB, bloco C4: retornos de homologação e a conferência humana, sem baixa
// (migrações 014, 024, 042 e 213, versões finais no oráculo).
// public.erp_cnab_return_commit, _return_exclude, _human_review_save e
// _human_review_verify. O arquivo já está no R2 (storage_check); nada aqui
// mexe no financeiro.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../../engine/text.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { day, keys, uuidValue } from "../../finance/public.ts";
import { int, json, text, uuid } from "../args.ts";
import { cnabObjectKey, finishCommand, recordCommand, startCommand, storageCheck } from "../commands.ts";
import { access, coreProfile, humanReviewSafety, parse, profileRow, returnApplied, txt, type Json } from "../core.ts";
import { humanReviewContext, humanReviewDetail, humanReviewHash, humanReviewRevisionDto } from "../human-review.ts";
import { insertOccurrence, pgInt } from "../returns.ts";

const hasKey = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);
const bytes = (v: unknown) => new TextEncoder().encode(jsonbText(v)).length;
const EVENT_KEYS = [
  "version", "accountScope", "bank", "wallet", "control", "documentNumber", "ourNumber", "occurrence", "kind", "occurrenceDate", "creditDate", "dueDate",
  "amountCents", "paidCents", "adjustments", "operationNumber", "rejection", "settlementChannel", "eventHash", "lineHash", "line", "warnings",
];
export const FILE_KEYS = ["hash", "size", "path", "generated_on", "century", "record_count", "warnings", "evidence"];
/** row - array['eventHash','lineHash','line'] */
export const eventPayload = (row: Json) => Object.fromEntries(Object.entries(row).filter(([k]) => !["eventHash", "lineHash", "line"].includes(k)));
/** a IS DISTINCT FROM b para o texto de jsonb (->>). */
const distinct = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);
/** decision->'x' IS DISTINCT FROM row->'x' (jsonb inteiro; chave ausente é NULL). */
const jsonDistinct = (a: unknown, ak: string, b: unknown, bk: string) => {
  const x = hasKey(a, ak) ? (a as Json)[ak] : undefined;
  const y = hasKey(b, bk) ? (b as Json)[bk] : undefined;
  return x === undefined || y === undefined ? x !== y : jsonbText(x) !== jsonbText(y);
};

export function erpCnabReturnCommit(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const commandId = uuid(a, "p_command_id");
  const profileId = uuid(a, "p_profile_id");
  const file = json(a, "p_file");
  const events = json(a, "p_events");
  const decisions = json(a, "p_decisions");
  access(db, user, true);
  keys(file, FILE_KEYS);
  if (
    jsonType(events) !== "array" ||
    jsonType(decisions) !== "array" ||
    (events as unknown[]).length > 9998 ||
    (events as unknown[]).length !== (decisions as unknown[]).length ||
    bytes(events) > 16000000 ||
    bytes(decisions) > 8000000
  )
    raise("22023", "erp_cnab_return_invalid");
  const command = { profile_id: profileId, file };
  const replay = startCommand(ctx, user!, commandId, "return_commit", command);
  if (replay) return replay;
  const p = profileRow(db, profileId);
  if (!p) raise("P0002", "erp_cnab_not_found");
  const list = events as Json[];
  const rows = decisions as Json[];
  const fileHash = txt(file, "hash");
  const inList = (xs: (string | null)[]) => (xs.length ? `IN (${xs.map(() => "?").join(",")})` : "IN (NULL)");
  const hashes = list.map((r) => txt(r, "eventHash"));
  const controls = list.map((r) => txt(r, "control"));
  if (
    one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=? AND purpose<>'homologation'`, p!.id, fileHash) ||
    one(db, `SELECT 1 x FROM "erp_cnab__return_event" WHERE profile_id=? AND purpose<>'homologation' AND event_hash ${inList(hashes)}`, p!.id, ...hashes) ||
    one(
      db,
      `SELECT 1 x FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" r ON r.id=b.remittance_id WHERE b.profile_id=? AND r.purpose<>'homologation' AND b.control ${inList(controls)}`,
      p!.id,
      ...controls,
    )
  )
    raise("40001", "erp_cnab_purpose_mismatch");
  const size = pgInt(txt(file, "size"));
  storageCheck(ctx, p!.id, "returns", fileHash, size, txt(file, "path"));
  if (
    jsonType(get(file, "warnings")) !== "array" ||
    jsonType(get(file, "evidence")) !== "object" ||
    // Contagem ou século nulos dão nulo e não recusam aqui (o insert é que recusa).
    ((n) => n !== null && n !== list.length + 2)(pgInt(txt(file, "record_count"))) ||
    ((c) => c !== null && ![1900, 2000, 2100].includes(c))(pgInt(txt(file, "century")))
  )
    raise("22023", "erp_cnab_return_invalid");
  const existing = one(db, 'SELECT id, byte_size, record_count FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=?', p!.id, fileHash);
  if (existing) {
    if (Number(existing.byte_size) !== size || Number(existing.record_count) !== pgInt(txt(file, "record_count"))) raise("40001", "erp_cnab_file_conflict");
    return finishCommand(ctx, user!, commandId!, "return_commit", command, String(existing.id), {
      id: existing.id, profile_id: p!.id, file_hash: fileHash, duplicate_file: true, new_events: 0, duplicate_events: list.length, canSettle: false,
    });
  }
  const fid = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_cnab__return_file"(id, profile_id, file_hash, object_path, byte_size, generated_on, century, record_count, warnings, evidence, actor, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    fid,
    p!.id,
    fileHash,
    txt(file, "path"),
    size,
    day(get(file, "generated_on")),
    pgInt(txt(file, "century")),
    pgInt(txt(file, "record_count")),
    JSON.stringify(get(file, "warnings")),
    JSON.stringify(get(file, "evidence")),
    user,
    ctx.clock.next().toString(),
  );
  let added = 0;
  let duplicates = 0;
  const bank = txt(p!.identity, "bank");
  const wallet = txt(p!.identity, "wallet");
  list.forEach((row, position) => {
    let decision = rows[position];
    keys(row, EVENT_KEYS);
    keys(decision, ["eventHash", "fileHash", "lineHash", "line", "titleId", "canSettle", "action", "reason"]);
    if (
      distinct(txt(row, "accountScope"), p!.account_scope) ||
      distinct(txt(row, "bank"), bank) ||
      distinct(txt(row, "wallet"), wallet) ||
      !/^[a-f0-9]{64}$/.test(txt(row, "eventHash") ?? "") ||
      !/^[a-f0-9]{64}$/.test(txt(row, "lineHash") ?? "") ||
      distinct(txt(decision, "eventHash"), txt(row, "eventHash")) ||
      distinct(txt(decision, "lineHash"), txt(row, "lineHash")) ||
      distinct(txt(decision, "fileHash"), fileHash) ||
      jsonDistinct(decision, "line", row, "line") ||
      !hasKey(decision, "canSettle") ||
      decision.canSettle !== false ||
      // action not in (…): ação nula dá nulo e não recusa (o Postgres).
      (txt(decision, "action") !== null && !["REVIEW", "SKIP", "PROPOSE_BANK_NUMBER_BINDING_REVIEW", "PROPOSE_SETTLEMENT_REVIEW"].includes(txt(decision, "action")!)) ||
      !/^[A-Z0-9_]{1,100}$/.test(txt(decision, "reason") ?? "")
    )
      raise("22023", "erp_cnab_return_event_invalid");
    const line = pgInt(txt(row, "line"));
    if (line !== position + 2) raise("22023", "erp_cnab_return_line_invalid");
    const payload = eventPayload(row);
    const stored = one(db, 'SELECT id, payload FROM "erp_cnab__return_event" WHERE profile_id=? AND event_hash=?', p!.id, txt(row, "eventHash"));
    let eid: string;
    if (stored) {
      if (jsonbText(parse(stored.payload)) !== jsonbText(payload)) raise("40001", "erp_cnab_event_hash_conflict");
      eid = String(stored.id);
      duplicates++;
    } else {
      // Só o vínculo exato fica gravado; uma sugestão com valor, data ou número diferentes fica sem vínculo.
      const found = one(
        db,
        `SELECT b.id FROM "erp_cnab__billing_title" b JOIN "erp_finance__title" t ON t.id=b.title_id
         WHERE b.profile_id=? AND b.control=? AND b.document_number=? AND CAST(t.amount_cents AS TEXT)=? AND t.due_on=?
           AND (b.our_number=? OR (b.our_number IS NULL AND ?='077' AND ?='112' AND ?='REGISTERED'))`,
        p!.id,
        txt(row, "control"),
        txt(row, "documentNumber"),
        txt(row, "amountCents"),
        txt(row, "dueDate"),
        txt(row, "ourNumber"),
        bank,
        wallet,
        txt(row, "kind"),
      );
      let bill = found ? String(found.id) : null;
      if (distinct(txt(decision, "titleId"), bill)) bill = null;
      if (
        bill !== null &&
        txt(decision, "action") === "PROPOSE_SETTLEMENT_REVIEW" &&
        !one(db, `SELECT 1 x FROM "erp_cnab__billing_title" b JOIN "erp_finance__title" t ON t.id=b.title_id WHERE b.id=? AND t.cancelled=0 AND t.settled_cents=0`, bill)
      )
        decision = { ...decision, action: "REVIEW", reason: "FINANCIAL_STATE_CHANGED" };
      const action = txt(decision, "action");
      eid = crypto.randomUUID();
      db.exec(
        `INSERT INTO "erp_cnab__return_event"(id, profile_id, event_hash, payload, billing_title_id, proposed_action, reason, created_at) VALUES(?,?,?,?,?,?,?,?)`,
        eid,
        p!.id,
        txt(row, "eventHash"),
        JSON.stringify(payload),
        bill,
        bill === null ? "REVIEW" : action,
        bill === null && action !== null && action.startsWith("PROPOSE_") ? "EXACT_LINK_NOT_CONFIRMED" : txt(decision, "reason"),
        ctx.clock.next().toString(),
      );
      added++;
    }
    insertOccurrence(db, fid, line!, eid, txt(row, "lineHash"), !!stored);
  });
  return finishCommand(ctx, user!, commandId!, "return_commit", command, fid, {
    id: fid, profile_id: p!.id, file_hash: fileHash, duplicate_file: false, new_events: added, duplicate_events: duplicates, canSettle: false,
  });
}

const get = (o: unknown, k: string) => (hasKey(o, k) ? (o as Json)[k] : null);

export function erpCnabReturnExclude(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const command = uuid(a, "p_command_id");
  const data = json(a, "p_data");
  access(db, user, true);
  if (data === null || jsonType(data) !== "object") raise("22023", "erp_cnab_invalid_query");
  keys(data, ["id"]);
  const id = uuidValue((data as Json).id);
  const replay = startCommand(ctx, user!, command, "return_exclude", data);
  if (replay) return replay;
  const f = one(db, 'SELECT id FROM "erp_cnab__return_file" WHERE id=?', id);
  if (!f) raise("P0002", "erp_cnab_not_found");
  if (one(db, 'SELECT 1 x FROM "erp_cnab__return_exclusion" WHERE file_id=?', id)) raise("P0002", "erp_cnab_not_found");
  if (returnApplied(db, id!)) raise("40001", "erp_cnab_return_applied");
  db.exec('INSERT INTO "erp_cnab__return_exclusion"(file_id, actor, command_id, created_at) VALUES(?,?,?,?)', id, user, command, ctx.clock.next().toString());
  access(db, user, true);
  const result = { entity: "cnab_return_exclusion", record: { id, excluded: true }, data_mode: "erp_native", replayed: false };
  return recordCommand(ctx, user!, command!, "return_exclude", data, id!, result);
}

/** O arquivo de retorno registrado (para storage_check). */
function returnFile(db: SqlDriver, id: string | null) {
  const f = one(db, 'SELECT id, profile_id, file_hash, byte_size, object_path, century FROM "erp_cnab__return_file" WHERE id=?', id);
  return f
    ? { id: String(f.id), profile_id: String(f.profile_id), hash: String(f.file_hash), size: Number(f.byte_size), path: String(f.object_path), century: Number(f.century) }
    : null;
}
/** Chave do arquivo de retorno que a RPC confere, lida do banco antes da transação. */
export const returnFileObjects = (argument: string) => (a: RpcArgs, db?: SqlDriver) => {
  if (!db) return [];
  try {
    const f = returnFile(db, uuid(a, argument));
    return f ? [cnabObjectKey(f.path)] : [];
  } catch {
    return [];
  }
};
export { returnFile };

export function erpCnabHumanReviewSave(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  const line = int(a, "p_line");
  const command = uuid(a, "p_command_id");
  const expected = int(a, "p_expected_review_version");
  const hash = text(a, "p_expected_context_hash");
  const status = text(a, "p_status");
  const reason = text(a, "p_reason");
  access(db, user, true);
  if (
    !one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE id=? AND purpose='homologation'`, fileId) ||
    !one(db, `SELECT 1 x FROM "erp_cnab__return_event" WHERE id=? AND purpose='homologation'`, eventId)
  )
    raise("P0002", "erp_cnab_review_not_found");
  if (
    eventId === null ||
    fileId === null ||
    line === null ||
    line < 2 ||
    line > 9999 ||
    expected === null ||
    expected < 0 ||
    expected === 2147483647 ||
    hash === null ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    status === null ||
    !["confirmed", "pending_issue"].includes(status) ||
    reason === null ||
    pgLength(pgBtrim(reason)) < 3 ||
    pgLength(pgBtrim(reason)) > 1000 ||
    pgHasCntrl.test(reason)
  )
    raise("22023", "erp_cnab_review_invalid");
  const cmd = { event_id: eventId, file_id: fileId, line, expected_review_version: expected, expected_context_hash: hash, status, reason };
  const replay = startCommand(ctx, user!, command, "human_review", cmd);
  if (replay) return replay;
  const current = one(db, 'SELECT version FROM "erp_cnab__human_review" WHERE event_id=?', eventId);
  const v = current ? Number(current.version) : 0;
  if (v !== expected) raise("40001", "erp_cnab_review_version_conflict");
  // Relido depois das travas: fecha o intervalo entre a conferência do arquivo e esta transação.
  const context = humanReviewContext(db, eventId, fileId, line);
  const h = humanReviewHash(context);
  if (h !== hash) raise("40001", "erp_cnab_review_context_changed");
  const f = returnFile(db, fileId)!;
  storageCheck(ctx, f.profile_id, "returns", f.hash, f.size, f.path);
  const next = v + 1;
  db.exec(
    `INSERT INTO "erp_cnab__human_review_revision"(event_id, version, status, reason, context_hash, context, actor, command_id, reviewed_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    eventId,
    next,
    status,
    pgBtrim(reason!),
    h,
    JSON.stringify(context),
    user,
    command,
    ctx.clock.next().toString(),
  );
  db.exec('INSERT INTO "erp_cnab__human_review"(event_id, version) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET version=excluded.version', eventId, next);
  const result = { ...humanReviewSafety(), event_id: eventId, record: humanReviewRevisionDto(db, eventId, next) };
  return finishCommand(ctx, user!, command!, "human_review", cmd, eventId!, result as Json);
}

export function erpCnabHumanReviewVerify(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  access(db, uuid(a, "p_user_id"), true);
  const detail = humanReviewDetail(db, eventId, fileId, int(a, "p_line"));
  const f = returnFile(db, fileId)!;
  const e = one(db, 'SELECT payload FROM "erp_cnab__return_event" WHERE id=?', eventId)!;
  storageCheck(ctx, f.profile_id, "returns", f.hash, f.size, f.path);
  return {
    detail,
    file: { id: f.id, profile_id: f.profile_id, hash: f.hash, size: f.size, path: f.path, century: f.century },
    profile: coreProfile(db, f.profile_id),
    payload: parse(e.payload),
  };
}

registerRpc("erp_cnab_return_commit", erpCnabReturnCommit, { objects: (a) => [cnabObjectKey(txt(jsonArg(a.p_file), "path") ?? "")] });
registerRpc("erp_cnab_return_exclude", erpCnabReturnExclude);
registerRpc("erp_cnab_human_review_save", erpCnabHumanReviewSave, { objects: returnFileObjects("p_file_id") });
registerRpc("erp_cnab_human_review_verify", erpCnabHumanReviewVerify, { objects: returnFileObjects("p_file_id") });

function jsonArg(v: unknown) {
  return typeof v === "string" ? JSON.parse(v) : v;
}
