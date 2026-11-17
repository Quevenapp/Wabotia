// CNAB, bloco C4: retornos operacionais sem baixa (migrações 043 e 067,
// versões finais no oráculo). public.erp_cnab_operational_return_profile,
// _return_file, _return_verify, _return_commit, _operational_event e
// _operational_bind (o vínculo do nosso número do Inter 112). A baixa
// (_operational_settle) é o C5.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { day, keys } from "../../finance/public.ts";
import { bool, int, json, text, uuid } from "../args.ts";
import { cnabObjectKey, operationalFinish, startCommand, storageCheck } from "../commands.ts";
import { access, coreProfile, operationalSafety, parse, profileRow, txt, type Json } from "../core.ts";
import { insertOccurrence, operationalContextHash, operationalEventContext, pgInt, requireReturnOperational } from "../returns.ts";
import { eventPayload, FILE_KEYS, returnFile, returnFileObjects } from "./erp_cnab_return_writes.ts";

const hasKey = (o: unknown, k: string) => jsonType(o) === "object" && Object.prototype.hasOwnProperty.call(o, k);
const field = (o: unknown, k: string) => (hasKey(o, k) ? (o as Json)[k] : null);
const bytes = (v: unknown) => new TextEncoder().encode(jsonbText(v)).length;
const distinct = (a: unknown, b: unknown) => (a ?? null) !== (b ?? null);
const EVENT_KEYS = [
  "version", "accountScope", "bank", "wallet", "control", "documentNumber", "ourNumber", "occurrence", "kind", "occurrenceDate", "creditDate", "dueDate",
  "amountCents", "paidCents", "adjustments", "operationNumber", "rejection", "settlementChannel", "eventHash", "lineHash", "line", "warnings",
];

export function erpCnabOperationalReturnProfile(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const profile = uuid(a, "p_profile_id");
  const expected = int(a, "p_expected_approval");
  access(db, uuid(a, "p_user_id"), true);
  if (expected === null || expected < 1) raise("22023", "erp_cnab_operational_approval_required");
  if (profile === null || !profileRow(db, profile)) raise("P0002", "erp_cnab_not_found");
  requireReturnOperational(db, profile!, expected);
  return { profile: coreProfile(db, profile), approval_version: expected };
}

export function erpCnabOperationalReturnFile(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  access(db, uuid(a, "p_user_id"));
  const f = one(db, `SELECT id FROM "erp_cnab__return_file" WHERE id=? AND purpose='operational'`, uuid(a, "p_file_id"));
  if (!f) raise("P0002", "erp_cnab_not_found");
  const r = returnFile(db, String(f!.id))!;
  const approval = requireReturnOperational(db, r.profile_id, null);
  storageCheck(ctx, r.profile_id, "returns", r.hash, r.size, r.path);
  return { id: r.id, profile_id: r.profile_id, hash: r.hash, size: r.size, path: r.path, approval_version: approval.approval_version ?? null, filename: `RETORNO_${r.id}.RET` };
}

export function erpCnabOperationalEvent(ctx: RpcContext, a: RpcArgs) {
  access(ctx.db, uuid(a, "p_user_id"));
  const context = operationalEventContext(ctx, uuid(a, "p_event_id"), uuid(a, "p_file_id"), int(a, "p_line"));
  return { ...operationalSafety(), event_id: uuid(a, "p_event_id"), context_hash: operationalContextHash(context), context, bytes_verified: false };
}

export function erpCnabOperationalReturnVerify(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  access(db, uuid(a, "p_user_id"), true);
  const detail = erpCnabOperationalEvent(ctx, a);
  const f = returnFile(db, fileId)!;
  storageCheck(ctx, f.profile_id, "returns", f.hash, f.size, f.path);
  const e = one(db, 'SELECT payload FROM "erp_cnab__return_event" WHERE id=?', eventId);
  return {
    detail,
    profile: coreProfile(db, f.profile_id),
    file: { id: f.id, profile_id: f.profile_id, hash: f.hash, size: f.size, path: f.path, century: f.century },
    payload: e ? parse(e.payload) : null,
  };
}

export function erpCnabOperationalReturnCommit(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const commandId = uuid(a, "p_command_id");
  const profileId = uuid(a, "p_profile_id");
  const expected = int(a, "p_expected_approval");
  const file = json(a, "p_file");
  const events = json(a, "p_events");
  access(db, user, true);
  keys(file, FILE_KEYS);
  if (expected === null || expected < 1 || jsonType(events) !== "array" || (events as unknown[]).length > 9998 || bytes(events) > 16000000)
    raise("22023", "erp_cnab_operational_return_invalid");
  const cmd = { profile_id: profileId, approval_version: expected, file };
  const replay = startCommand(ctx, user!, commandId, "operational_return", cmd);
  const p = profileRow(db, profileId);
  if (!p) raise("P0002", "erp_cnab_not_found");
  requireReturnOperational(db, p!.id, expected);
  if (replay) return replay;
  const list = events as Json[];
  const fileHash = txt(file, "hash");
  const hashes = list.map((r) => txt(r, "eventHash"));
  const inList = (xs: (string | null)[]) => (xs.length ? `IN (${xs.map(() => "?").join(",")})` : "IN (NULL)");
  if (
    one(db, `SELECT 1 x FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=? AND purpose<>'operational'`, p!.id, fileHash) ||
    one(db, `SELECT 1 x FROM "erp_cnab__return_event" WHERE profile_id=? AND event_hash ${inList(hashes)} AND purpose<>'operational'`, p!.id, ...hashes)
  )
    raise("40001", "erp_cnab_purpose_mismatch");
  const size = pgInt(txt(file, "size"));
  storageCheck(ctx, p!.id, "returns", fileHash, size, txt(file, "path"));
  const evidence = field(file, "evidence");
  const count = pgInt(txt(file, "record_count"));
  const century = pgInt(txt(file, "century"));
  // Três valores: contagem ou século nulos dão nulo; day() recusa data inválida com o erro do Financeiro.
  if (
    jsonType(field(file, "warnings")) !== "array" ||
    jsonType(evidence) !== "object" ||
    (count !== null && count !== list.length + 2) ||
    (century !== null && century !== 2000) ||
    day(field(file, "generated_on")) > todaySaoPaulo() ||
    distinct(txt(evidence, "source"), "authenticated-bank-download") ||
    distinct(txt(evidence, "fileHash"), fileHash) ||
    distinct(txt(evidence, "accountId"), p!.account_id) ||
    distinct(txt(evidence, "reviewedBy"), user) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(txt(evidence, "referenceId") ?? "")
  )
    raise("22023", "erp_cnab_bank_declaration_required");
  const existing = one(db, 'SELECT id, file_hash, byte_size, record_count FROM "erp_cnab__return_file" WHERE profile_id=? AND file_hash=?', p!.id, fileHash);
  if (existing) {
    if (Number(existing.byte_size) !== size || Number(existing.record_count) !== count) raise("40001", "erp_cnab_file_conflict");
    return operationalFinish(ctx, user!, commandId!, "operational_return", cmd, String(existing.id), {
      id: existing.id, profile_id: p!.id, file_hash: existing.file_hash, duplicate_file: true, new_events: 0, duplicate_events: list.length, canSettle: false,
    });
  }
  const fid = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_cnab__return_file"(id, profile_id, file_hash, object_path, byte_size, generated_on, century, record_count, warnings, evidence, actor, purpose, created_at)
     VALUES(?,?,?,?,?,?,2000,?,?,?,?,'operational',?)`,
    fid,
    p!.id,
    fileHash,
    txt(file, "path"),
    size,
    day(field(file, "generated_on")),
    count,
    JSON.stringify(field(file, "warnings")),
    JSON.stringify({ ...(evidence as Json), operational_approval_version: expected }),
    user,
    ctx.clock.next().toString(),
  );
  let added = 0;
  let duplicates = 0;
  const bank = txt(p!.identity, "bank");
  const wallet = txt(p!.identity, "wallet");
  list.forEach((r, i) => {
    keys(r, EVENT_KEYS);
    if (
      distinct(txt(r, "accountScope"), p!.account_scope) ||
      distinct(txt(r, "bank"), bank) ||
      distinct(txt(r, "wallet"), wallet) ||
      !/^[a-f0-9]{64}$/.test(txt(r, "eventHash") ?? "") ||
      !/^[a-f0-9]{64}$/.test(txt(r, "lineHash") ?? "") ||
      ((l) => l !== null && l !== i + 2)(pgInt(txt(r, "line")))
    )
      raise("22023", "erp_cnab_return_event_invalid");
    const payload = eventPayload(r);
    const stored = one(db, 'SELECT id, payload FROM "erp_cnab__return_event" WHERE profile_id=? AND event_hash=?', p!.id, txt(r, "eventHash"));
    let eid: string;
    if (stored) {
      if (jsonbText(parse(stored.payload)) !== jsonbText(payload)) raise("40001", "erp_cnab_event_hash_conflict");
      eid = String(stored.id);
      duplicates++;
    } else {
      const found = one(
        db,
        `SELECT b.id FROM "erp_cnab__billing_title" b JOIN "erp_cnab__remittance" m ON m.id=b.remittance_id JOIN "erp_finance__title" t ON t.id=b.title_id
         WHERE b.profile_id=? AND m.purpose='operational' AND m.state='ready' AND b.control=? AND b.document_number=? AND CAST(t.amount_cents AS TEXT)=? AND t.due_on=?`,
        p!.id,
        txt(r, "control"),
        txt(r, "documentNumber"),
        txt(r, "amountCents"),
        txt(r, "dueDate"),
      );
      const bill = found ? String(found.id) : null;
      eid = crypto.randomUUID();
      db.exec(
        `INSERT INTO "erp_cnab__return_event"(id, profile_id, event_hash, payload, billing_title_id, proposed_action, reason, purpose, created_at) VALUES(?,?,?,?,?,'REVIEW',?,'operational',?)`,
        eid,
        p!.id,
        txt(r, "eventHash"),
        JSON.stringify(payload),
        bill,
        bill === null ? "EXACT_LINK_NOT_CONFIRMED" : "OPERATIONAL_REVIEW_REQUIRED",
        ctx.clock.next().toString(),
      );
      added++;
    }
    insertOccurrence(db, fid, i + 2, eid, txt(r, "lineHash"), !!stored);
  });
  return operationalFinish(ctx, user!, commandId!, "operational_return", cmd, fid, {
    id: fid, profile_id: p!.id, file_hash: fileHash, duplicate_file: false, new_events: added, duplicate_events: duplicates, canSettle: false,
  });
}

/** erp_cnab.lock_operational_event(event, file, line, approval): o perfil do evento, conferido. */
export function lockOperationalEvent(db: SqlDriver, event: string | null, file: string | null, line: number | null, approval: number | null): string {
  const e = one(db, `SELECT profile_id, billing_title_id FROM "erp_cnab__return_event" WHERE id=? AND purpose='operational'`, event);
  if (!e) raise("P0002", "erp_cnab_operational_event_not_found");
  if (one(db, 'SELECT 1 x FROM "erp_cnab__return_exclusion" WHERE file_id=?', file)) raise("40001", "erp_cnab_return_excluded");
  requireReturnOperational(db, String(e!.profile_id), approval, (e!.billing_title_id as string | null) ?? null);
  if (!one(db, 'SELECT 1 x FROM "erp_cnab__return_occurrence" WHERE event_id=? AND file_id=? AND line=?', event, file, line)) raise("P0002", "erp_cnab_operational_event_not_found");
  return String(e!.profile_id);
}

export function erpCnabOperationalBind(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuid(a, "p_user_id");
  const eventId = uuid(a, "p_event_id");
  const fileId = uuid(a, "p_file_id");
  const line = int(a, "p_line");
  const expected = int(a, "p_expected_approval");
  const commandId = uuid(a, "p_command_id");
  const hash = text(a, "p_context_hash");
  access(db, user, true);
  if (bool(a, "p_confirm") !== true || expected === null || expected < 1 || hash === null || !/^[a-f0-9]{64}$/.test(hash))
    raise("22023", "erp_cnab_operational_confirmation_required");
  const cmd = { event_id: eventId, file_id: fileId, line, approval_version: expected, context_hash: hash };
  const replay = startCommand(ctx, user!, commandId, "operational_bind", cmd);
  const pid = lockOperationalEvent(db, eventId, fileId, line, expected);
  if (replay) return replay;
  const c = operationalEventContext(ctx, eventId, fileId, line);
  if (operationalContextHash(c) !== hash || (c.binding as Json).allowed !== true) raise("40001", "erp_cnab_operational_review_changed");
  const f = returnFile(db, fileId)!;
  storageCheck(ctx, pid, "returns", f.hash, f.size, f.path);
  const bid = txt(c, "billing", "id");
  const our = txt(c, "event", "our_number");
  const updated = bid === null ? undefined : one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE id=? AND our_number IS NULL', bid);
  if (!updated) raise("40001", "erp_cnab_operational_review_changed");
  db.exec('UPDATE "erp_cnab__billing_title" SET our_number=? WHERE id=? AND our_number IS NULL', our, bid);
  db.exec(
    `INSERT INTO "erp_cnab__operational_binding"(event_id, billing_title_id, profile_id, our_number, file_id, line, context_hash, command_id, actor, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    eventId,
    bid,
    pid,
    our,
    fileId,
    line,
    hash,
    commandId,
    user,
    ctx.clock.next().toString(),
  );
  return operationalFinish(ctx, user!, commandId!, "operational_bind", cmd, eventId!, { event_id: eventId, billing_title_id: bid, our_number: our, command_id: commandId, bound: true });
}

registerRpc("erp_cnab_operational_return_profile", erpCnabOperationalReturnProfile);
registerRpc("erp_cnab_operational_return_file", erpCnabOperationalReturnFile, { objects: returnFileObjects("p_file_id") });
registerRpc("erp_cnab_operational_event", erpCnabOperationalEvent);
registerRpc("erp_cnab_operational_return_verify", erpCnabOperationalReturnVerify, { objects: returnFileObjects("p_file_id") });
registerRpc("erp_cnab_operational_return_commit", erpCnabOperationalReturnCommit, {
  objects: (a) => [cnabObjectKey(txt(typeof a.p_file === "string" ? JSON.parse(a.p_file) : a.p_file, "path") ?? "")],
});
registerRpc("erp_cnab_operational_bind", erpCnabOperationalBind, { objects: returnFileObjects("p_file_id") });
