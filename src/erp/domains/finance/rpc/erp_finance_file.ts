// Anexos do Financeiro (contas e lançamentos de caixa):
// public.erp_finance_file_reserve, _claim, _finish, _stop, _delete, _list e
// _object, com erp_finance.file_authorize, file_row, file_dto e a camada de
// tabela de file (file_identity) e file_audit (só inserção).
// storage.buckets/objects do Supabase: no Vinki o objeto fica no R2; o
// erp_attachments.storage_ready não lança (preferences/public.ts), e o finish
// confere o objeto que o motor consultou antes da transação (ctx.objects,
// registerRpc(…, { objects })).
import { createHash } from "node:crypto";
import { one, type Row, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { storageReady } from "../../preferences/public.ts";
import { requireAccess, ts, uuidArg } from "../internal.ts";
import { left } from "../titles.ts";

const BUCKET = "erp-attachments";
const LEASE_MICROS = 120_000_000n;
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/xml": "xml", "text/plain": "txt" };
const objectKey = (owner: string, id: string, sha: string) => `finance/${owner}/${id}/${sha}`;

/** erp_finance.file_authorize */
function fileAuthorize(db: SqlDriver, user: string, kind: string | null, owner: string | null, write: boolean | null) {
  if (write === null || kind === null || !["title", "cash_entry"].includes(kind)) raise("22023", "erp_attachment_invalid_action");
  requireAccess(db, user, write);
  const o = owner === null ? null : one(db, `SELECT deleted_at FROM "${kind === "title" ? "erp_finance__title" : "erp_finance__cash_entry"}" WHERE id=?`, owner);
  if (!o) raise("P0002", "erp_attachment_owner_not_found");
  if (write && o.deleted_at !== null) raise("40001", "erp_finance_deleted_owner");
}

/** erp_finance.file_row */
function fileRow(db: SqlDriver, kind: string, owner: string, id: string | null): Row {
  const v = id === null ? null : one(db, 'SELECT * FROM "erp_finance__file" WHERE id=? AND owner_kind=? AND owner_id=?', id, kind, owner);
  if (!v) raise("P0002", "erp_attachment_not_found");
  return v;
}

/** erp_finance.file_dto(id, interno) */
function fileDto(db: SqlDriver, id: string, internal = false) {
  const f = one(db, 'SELECT * FROM "erp_finance__file" WHERE id=?', id)!;
  const name = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', f.actor)?.name as string | undefined;
  return {
    id: f.id,
    owner_kind: f.owner_kind,
    owner_id: f.owner_id,
    filename: f.filename,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes,
    sha256: f.sha256,
    status: f.status,
    created_at: ts(f.created_at),
    finished_at: ts(f.finished_at),
    deleted: f.deleted_at !== null,
    owner_name: name === undefined || name === null ? null : left(name, 120),
    ...(internal ? { bucket: BUCKET, object_key: objectKey(String(f.owner_id), String(f.id), String(f.sha256)) } : {}),
  };
}

/** UPDATE de file com o file_identity (identidade fixa; fora de 'reserved' o envio não muda; excluído não volta). */
function updateFile(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  const old = one(ctx.db, 'SELECT * FROM "erp_finance__file" WHERE id=?', id)!;
  const next = { ...old, ...set };
  const differ = (cols: string[]) => cols.some((c) => String(next[c] ?? "") !== String(old[c] ?? "") || (next[c] === null) !== (old[c] === null));
  if (
    (old.status !== "reserved" && differ(["status", "lease_token", "lease_actor", "lease_until", "finished_by", "finished_at"])) ||
    (old.deleted_at !== null && differ(["deleted_at", "deleted_by", "delete_command_id"]))
  )
    raise("40001", "erp_attachment_immutable");
  const cols = Object.keys(set);
  ctx.db.exec(`UPDATE "erp_finance__file" SET ${cols.map((c) => `"${c}"=?`).join(", ")} WHERE id=?`, ...cols.map((c) => set[c]), id);
}

function audit(ctx: RpcContext, file: string, actor: string, action: string, command: string | null = null) {
  ctx.db.exec(
    'INSERT INTO "erp_finance__file_audit"(file_id, actor, action, command_id, created_at) VALUES(?,?,?,?,?)',
    file, actor, action, command, ctx.clock.next().toString(),
  );
}

const args = (a: RpcArgs) => ({
  user: uuidArg(a.p_user_id)!,
  kind: (a.p_owner_kind as string | null) ?? null,
  owner: uuidArg(a.p_owner_id),
  id: uuidArg(a.p_id),
});

function reserve(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner } = args(a);
  const command = uuidArg(a.p_command_id);
  const filename = (a.p_filename as string | null) ?? null;
  const mime = (a.p_mime_type as string | null) ?? null;
  const size = (a.p_size_bytes as number | null) ?? null;
  const sha = (a.p_sha256 as string | null) ?? null;
  fileAuthorize(db, user, kind, owner, true);
  storageReady();
  const ext = mime === null ? undefined : EXT[mime];
  if (
    command === null || filename === null || ext === undefined || size === null || size < 1 || size > 10485760 || sha === null || !/^[a-f0-9]{64}$/.test(sha) ||
    !new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${ext}$`).test(filename)
  )
    raise("22023", "erp_attachment_invalid_metadata");
  const hash = createHash("sha256")
    .update(jsonbText({ actor: user, owner_kind: kind, owner_id: owner, filename, mime_type: mime, size_bytes: size, sha256: sha }), "utf8")
    .digest("hex");
  const existing = one(db, 'SELECT * FROM "erp_finance__file" WHERE command_id=?', command);
  if (existing) {
    if (existing.actor !== user || existing.request_hash !== hash) raise("40001", "erp_attachment_command_conflict");
    return { attachment: fileDto(db, String(existing.id)), replayed: true, data_mode: "erp_native" };
  }
  // Um teto por conta ou lançamento; os abortados e excluídos também contam.
  if (Number(one(db, 'SELECT count(*) n FROM "erp_finance__file" WHERE owner_kind=? AND owner_id=?', kind, owner)!.n) >= 100) raise("54000", "erp_attachment_quota");
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__file"(id, owner_kind, owner_id, title_id, cash_entry_id, command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`,
    id, kind, owner, kind === "title" ? owner : null, kind === "cash_entry" ? owner : null, command, user, hash, filename, mime, size, sha, ctx.clock.next().toString(),
  );
  audit(ctx, id, user, "reserve", command);
  return { attachment: fileDto(db, id), replayed: false, data_mode: "erp_native" };
}

function claim(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner, id } = args(a);
  const lease = uuidArg(a.p_lease);
  fileAuthorize(db, user, kind, owner, true);
  storageReady();
  if (lease === null) raise("22023", "erp_attachment_invalid_lease");
  const v = fileRow(db, kind!, owner!, id);
  const now = ctx.clock.next();
  if (
    v.status === "aborted" || v.deleted_at !== null ||
    (v.status === "reserved" && v.lease_until !== null && BigInt(String(v.lease_until)) > now && (v.lease_token !== lease || v.lease_actor !== user))
  )
    raise("40001", "erp_attachment_upload_conflict");
  if (v.status === "reserved") updateFile(ctx, id!, { lease_token: lease, lease_actor: user, lease_until: (now + LEASE_MICROS).toString() });
  return { ...fileDto(db, id!, true), data_mode: "erp_native" };
}

function finish(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner, id } = args(a);
  const lease = uuidArg(a.p_lease);
  const sha = (a.p_sha256 as string | null) ?? null;
  const size = (a.p_size_bytes as number | null) ?? null;
  fileAuthorize(db, user, kind, owner, true);
  storageReady();
  const v = fileRow(db, kind!, owner!, id);
  if (sha !== v.sha256 || size !== Number(v.size_bytes)) raise("40001", "erp_attachment_integrity_conflict");
  if (v.status === "ready") return { attachment: fileDto(db, id!), replayed: true, data_mode: "erp_native" };
  if (v.status !== "reserved" || lease === null || v.lease_token !== lease || v.lease_actor !== user || v.lease_until === null || BigInt(String(v.lease_until)) <= ctx.clock.next())
    raise("40001", "erp_attachment_upload_conflict");
  const stored = ctx.objects(`${BUCKET}/${objectKey(owner!, id!, String(v.sha256))}`);
  if (!stored || String(stored.size) !== String(v.size_bytes) || stored.mimetype !== v.mime_type) raise("40001", "erp_attachment_object_unconfirmed");
  updateFile(ctx, id!, { status: "ready", lease_token: null, lease_actor: null, lease_until: null, finished_by: user, finished_at: ctx.clock.next().toString() });
  audit(ctx, id!, user, "finalize");
  return { attachment: fileDto(db, id!), replayed: false, data_mode: "erp_native" };
}

/** Chave que o finish confere, a partir dos argumentos (p_sha256 tem de ser o da reserva). */
function finishObjects(a: RpcArgs): string[] {
  const uuid = (v: unknown) => (typeof v === "string" ? uuidArg(v) : null);
  const owner = uuid(a.p_owner_id),
    id = uuid(a.p_id);
  return owner && id && typeof a.p_sha256 === "string" ? [`${BUCKET}/${objectKey(owner, id, a.p_sha256)}`] : [];
}

function stop(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner, id } = args(a);
  const abort = (a.p_abort as boolean | null) ?? null;
  const lease = uuidArg(a.p_lease);
  fileAuthorize(db, user, kind, owner, true);
  if (abort === null) raise("22023", "erp_attachment_invalid_action");
  const v = fileRow(db, kind!, owner!, id);
  if (abort) {
    if (v.status === "ready" || (v.lease_until !== null && BigInt(String(v.lease_until)) > ctx.clock.next())) raise("40001", "erp_attachment_upload_conflict");
    if (v.status !== "aborted") {
      updateFile(ctx, id!, { status: "aborted", lease_token: null, lease_actor: null, lease_until: null, finished_by: user, finished_at: ctx.clock.next().toString() });
      audit(ctx, id!, user, "abort");
    }
  } else if (v.status === "reserved" && lease !== null && v.lease_token === lease && v.lease_actor === user) {
    updateFile(ctx, id!, { lease_token: null, lease_actor: null, lease_until: null });
  }
  return { attachment: fileDto(db, id!), data_mode: "erp_native" };
}

function remove(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner, id } = args(a);
  const command = uuidArg(a.p_command_id);
  fileAuthorize(db, user, kind, owner, true);
  if (command === null) raise("22023", "erp_attachment_invalid_action");
  const v = fileRow(db, kind!, owner!, id);
  if (v.delete_command_id === command) {
    if (v.deleted_by !== user) raise("40001", "erp_attachment_command_conflict");
    return { attachment: fileDto(db, id!), replayed: true, data_mode: "erp_native" };
  }
  if (one(db, 'SELECT 1 x FROM "erp_finance__file" WHERE delete_command_id=? OR command_id=? LIMIT 1', command, command)) raise("40001", "erp_attachment_command_conflict");
  if (v.status !== "ready" || v.deleted_at !== null) raise("40001", "erp_attachment_not_ready");
  updateFile(ctx, id!, { deleted_at: ctx.clock.next().toString(), deleted_by: user, delete_command_id: command });
  audit(ctx, id!, user, "delete", command);
  return { attachment: fileDto(db, id!), replayed: false, data_mode: "erp_native" };
}

function list(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner } = args(a);
  fileAuthorize(db, user, kind, owner, false);
  const rows = db
    .exec('SELECT id, created_at FROM "erp_finance__file" WHERE owner_kind=? AND owner_id=? AND deleted_at IS NULL', kind, owner)
    .rows.sort((x, y) => Number(x.created_at) - Number(y.created_at) || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
  return { owner_kind: kind, owner_id: owner, items: rows.map((r) => fileDto(db, String(r.id))), data_mode: "erp_native" };
}

function object(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const { user, kind, owner, id } = args(a);
  const write = (a.p_write as boolean | null) ?? null;
  fileAuthorize(db, user, kind, owner, write);
  storageReady();
  const v = fileRow(db, kind!, owner!, id);
  if (v.status === "aborted" || v.deleted_at !== null || (!write && v.status !== "ready")) raise("40001", "erp_attachment_not_ready");
  return { ...fileDto(db, id!, true), data_mode: "erp_native" };
}

registerRpc("erp_finance_file_reserve", reserve);
registerRpc("erp_finance_file_claim", claim);
registerRpc("erp_finance_file_finish", finish, { objects: finishObjects });
registerRpc("erp_finance_file_stop", stop);
registerRpc("erp_finance_file_delete", remove);
registerRpc("erp_finance_file_list", list);
registerRpc("erp_finance_file_object", object);
