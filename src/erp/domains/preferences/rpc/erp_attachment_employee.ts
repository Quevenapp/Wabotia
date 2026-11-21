// Foto do funcionário (migração 272): public.erp_attachment_employee_list,
// _reserve, _object, _claim, _finish, _stop e _delete.
// storage.buckets/objects do Supabase: no Vinki o objeto fica no R2; o bucket
// sempre existe (storageReady) e a confirmação do envio lê o objeto que o hub
// consultou antes da transação (ctx.objects, registerRpc(…, { objects })).
// Os gatilhos employee_file_identity e employee_file_audit_immutable são
// cumpridos aqui: as linhas só mudam pelos caminhos abaixo.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { employeeAdmin } from "../../catalog/public.ts";
import { bool, int, text, uuid } from "../args.ts";
import { frameworkHash } from "../framework.ts";
import { nowMicros } from "../platform.ts";
import { storageReady } from "../public.ts";

const BUCKET = "erp-attachments";
const LEASE = 120_000_000n;
const objectKey = (employee: string, id: string, sha: string) => `employees/${employee}/${id}/${sha}`;

interface EmployeeFile {
  id: string;
  employee_id: string;
  command_id: string;
  actor: string;
  request_hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: string;
  lease_token: string | null;
  lease_actor: string | null;
  lease_until: string | null;
  created_at: string;
  finished_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_command_id: string | null;
}
const COLUMNS = `id, employee_id, command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status, lease_token, lease_actor,
  CAST(lease_until AS TEXT) lease_until, CAST(created_at AS TEXT) created_at, CAST(finished_at AS TEXT) finished_at,
  CAST(deleted_at AS TEXT) deleted_at, deleted_by, delete_command_id`;

/** erp_attachments.employee_authorize */
function authorize(db: SqlDriver, user: string | null, employee: string | null, write: boolean | null) {
  if (write === null) raise("22023", "erp_attachment_invalid_action");
  employeeAdmin(db, user);
  if (employee === null || !one(db, 'SELECT 1 x FROM "erp_catalog__employee" WHERE id=?', employee)) raise("P0002", "erp_attachment_employee_not_found");
}

/** erp_attachments.employee_row */
function row(db: SqlDriver, employee: string | null, id: string | null): EmployeeFile {
  const v = id === null ? undefined : one(db, `SELECT ${COLUMNS} FROM "erp_attachments__employee_file" WHERE id=? AND employee_id=?`, id, employee);
  if (!v) raise("P0002", "erp_attachment_not_found");
  return { ...(v as unknown as EmployeeFile), size_bytes: Number(v.size_bytes) };
}

/** erp_attachments.employee_dto */
function dto(db: SqlDriver, id: string, internal = false) {
  const f = one(db, `SELECT ${COLUMNS} FROM "erp_attachments__employee_file" WHERE id=?`, id)!;
  const owner = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', f.actor);
  return {
    id: f.id,
    employee_id: f.employee_id,
    purpose: "photo",
    filename: f.filename,
    mime_type: f.mime_type,
    size_bytes: Number(f.size_bytes),
    sha256: f.sha256,
    status: f.status,
    created_at: jsonTimestamp(String(f.created_at)),
    finished_at: f.finished_at === null ? null : jsonTimestamp(String(f.finished_at)),
    deleted: f.deleted_at !== null,
    owner_name: owner && owner.name !== null ? pgLeft(String(owner.name), 120) : null,
    ...(internal ? { bucket: BUCKET, object_key: objectKey(String(f.employee_id), String(f.id), String(f.sha256)) } : {}),
  };
}

function audit(ctx: RpcContext, file: string, actor: string, action: string, command: string | null = null) {
  ctx.db.exec(
    'INSERT INTO "erp_attachments__employee_file_audit"(file_id, actor, action, command_id, created_at) VALUES (?,?,?,?,?)',
    file,
    actor,
    action,
    command,
    ctx.clock.next().toString(),
  );
}

export function erpAttachmentEmployeeList(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const db = ctx.db;
  authorize(db, user, employee, false);
  const photo = one(
    db,
    `SELECT id FROM "erp_attachments__employee_file" WHERE employee_id=? AND status='ready' AND deleted_at IS NULL
     ORDER BY finished_at DESC, id DESC LIMIT 1`,
    employee,
  );
  const pending = db
    .exec(`SELECT id FROM "erp_attachments__employee_file" WHERE employee_id=? AND status='reserved' ORDER BY created_at, id LIMIT 100`, employee)
    .rows.map((r) => dto(db, String(r.id)));
  return { employee_id: employee, photo: photo ? dto(db, String(photo.id)) : null, pending_photos: pending, data_mode: "erp_native" };
}

export function erpAttachmentEmployeeReserve(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const command = uuid(a, "p_command_id");
  const filename = text(a, "p_filename");
  const mime = text(a, "p_mime_type");
  const size = int(a, "p_size_bytes");
  const sha = text(a, "p_sha256");
  const db = ctx.db;
  authorize(db, user, employee, true);
  storageReady();
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : null;
  if (
    command === null ||
    filename === null ||
    ext === null ||
    size === null ||
    size < 1 ||
    size > 2097152 ||
    sha === null ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    !new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${ext}$`).test(filename)
  )
    raise("22023", "erp_attachment_invalid_metadata");
  const hash = frameworkHash({ actor: user, employee_id: employee, filename, mime_type: mime, size_bytes: size, sha256: sha });
  const stored = one(db, 'SELECT id, actor, request_hash FROM "erp_attachments__employee_file" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_attachment_command_conflict");
    return { attachment: dto(db, String(stored.id)), replayed: true, data_mode: "erp_native" };
  }
  if (Number(one(db, 'SELECT count(*) n FROM "erp_attachments__employee_file" WHERE employee_id=?', employee)!.n) >= 100) raise("54000", "erp_attachment_quota");
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_attachments__employee_file"(id, employee_id, command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'reserved',?)`,
    id,
    employee,
    command,
    user,
    hash,
    filename,
    mime,
    size,
    sha,
    ctx.clock.next().toString(),
  );
  audit(ctx, id, user!, "reserve", command);
  return { attachment: dto(db, id), replayed: false, data_mode: "erp_native" };
}

export function erpAttachmentEmployeeObject(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const id = uuid(a, "p_id");
  const write = bool(a, "p_write");
  const db = ctx.db;
  authorize(db, user, employee, write);
  storageReady();
  const v = row(db, employee, id);
  if (v.status === "aborted" || v.deleted_at !== null || (!write && v.status !== "ready")) raise("40001", "erp_attachment_not_ready");
  return { ...dto(db, id!, true), data_mode: "erp_native" };
}

export function erpAttachmentEmployeeClaim(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const id = uuid(a, "p_id");
  const lease = uuid(a, "p_lease");
  const db = ctx.db;
  authorize(db, user, employee, true);
  storageReady();
  if (lease === null) raise("22023", "erp_attachment_invalid_lease");
  const v = row(db, employee, id);
  const held = v.lease_until !== null && BigInt(v.lease_until) > nowMicros();
  if (v.status === "aborted" || v.deleted_at !== null || (v.status === "reserved" && held && (v.lease_token !== lease || v.lease_actor !== user)))
    raise("40001", "erp_attachment_upload_conflict");
  if (v.status === "reserved")
    db.exec(
      'UPDATE "erp_attachments__employee_file" SET lease_token=?, lease_actor=?, lease_until=? WHERE id=?',
      lease,
      user,
      (nowMicros() + LEASE).toString(),
      id,
    );
  return { ...dto(db, id!, true), data_mode: "erp_native" };
}

export function erpAttachmentEmployeeFinish(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const id = uuid(a, "p_id");
  const lease = uuid(a, "p_lease");
  const sha = text(a, "p_sha256");
  const size = int(a, "p_size_bytes");
  const db = ctx.db;
  authorize(db, user, employee, true);
  storageReady();
  const v = row(db, employee, id);
  if (sha !== v.sha256 || size !== v.size_bytes) raise("40001", "erp_attachment_integrity_conflict");
  if (v.status === "ready") return { attachment: dto(db, id!), replayed: true, data_mode: "erp_native" };
  if (
    v.status !== "reserved" ||
    lease === null ||
    v.lease_token !== lease ||
    v.lease_actor !== user ||
    v.lease_until === null ||
    BigInt(v.lease_until) <= nowMicros()
  )
    raise("40001", "erp_attachment_upload_conflict");
  const stored = ctx.objects(`${BUCKET}/${objectKey(employee!, id!, v.sha256)}`);
  if (!stored || String(stored.size) !== String(v.size_bytes) || stored.mimetype !== v.mime_type) raise("40001", "erp_attachment_object_unconfirmed");
  db.exec(
    `UPDATE "erp_attachments__employee_file" SET status='ready', lease_token=NULL, lease_actor=NULL, lease_until=NULL, finished_by=?, finished_at=? WHERE id=?`,
    user,
    ctx.clock.next().toString(),
    id,
  );
  audit(ctx, id!, user!, "finalize");
  // A foto nova substitui a anterior (mantida, excluída logicamente e auditada).
  for (const old of db.exec(
    `SELECT id FROM "erp_attachments__employee_file" WHERE employee_id=? AND status='ready' AND deleted_at IS NULL AND id<>?`,
    employee,
    id,
  ).rows) {
    db.exec('UPDATE "erp_attachments__employee_file" SET deleted_at=?, deleted_by=? WHERE id=?', ctx.clock.next().toString(), user, old.id);
    audit(ctx, String(old.id), user!, "delete");
  }
  return { attachment: dto(db, id!), replayed: false, data_mode: "erp_native" };
}

export function erpAttachmentEmployeeStop(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const id = uuid(a, "p_id");
  const abort = bool(a, "p_abort");
  const lease = uuid(a, "p_lease");
  const db = ctx.db;
  authorize(db, user, employee, true);
  if (abort === null) raise("22023", "erp_attachment_invalid_action");
  const v = row(db, employee, id);
  if (abort) {
    if (v.status === "ready" || (v.lease_until !== null && BigInt(v.lease_until) > nowMicros())) raise("40001", "erp_attachment_upload_conflict");
    if (v.status !== "aborted") {
      db.exec(
        `UPDATE "erp_attachments__employee_file" SET status='aborted', lease_token=NULL, lease_actor=NULL, lease_until=NULL, finished_by=?, finished_at=? WHERE id=?`,
        user,
        ctx.clock.next().toString(),
        id,
      );
      audit(ctx, id!, user!, "abort");
    }
  } else if (v.status === "reserved" && lease !== null && v.lease_token === lease && v.lease_actor === user)
    db.exec('UPDATE "erp_attachments__employee_file" SET lease_token=NULL, lease_actor=NULL, lease_until=NULL WHERE id=?', id);
  return { attachment: dto(db, id!), data_mode: "erp_native" };
}

export function erpAttachmentEmployeeDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const employee = uuid(a, "p_employee_id");
  const id = uuid(a, "p_id");
  const command = uuid(a, "p_command_id");
  const db = ctx.db;
  authorize(db, user, employee, true);
  if (command === null) raise("22023", "erp_attachment_invalid_action");
  const v = row(db, employee, id);
  if (v.delete_command_id === command) {
    if (v.deleted_by !== user) raise("40001", "erp_attachment_command_conflict");
    return { attachment: dto(db, id!), replayed: true, data_mode: "erp_native" };
  }
  if (one(db, 'SELECT 1 x FROM "erp_attachments__employee_file" WHERE delete_command_id=? OR command_id=?', command, command))
    raise("40001", "erp_attachment_command_conflict");
  if (v.status !== "ready" || v.deleted_at !== null) raise("40001", "erp_attachment_not_ready");
  db.exec(
    'UPDATE "erp_attachments__employee_file" SET deleted_at=?, deleted_by=?, delete_command_id=? WHERE id=?',
    ctx.clock.next().toString(),
    user,
    command,
    id,
  );
  audit(ctx, id!, user!, "delete", command);
  return { attachment: dto(db, id!), replayed: false, data_mode: "erp_native" };
}

/** Chave que o finish confere, a partir dos argumentos (p_sha256 tem de ser o da reserva). */
function finishObjects(a: RpcArgs): string[] {
  const id = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null);
  const employee = id(a.p_employee_id),
    file = id(a.p_id);
  return employee && file && typeof a.p_sha256 === "string" ? [`${BUCKET}/${objectKey(employee, file, a.p_sha256)}`] : [];
}

registerRpc("erp_attachment_employee_list", erpAttachmentEmployeeList);
registerRpc("erp_attachment_employee_reserve", erpAttachmentEmployeeReserve);
registerRpc("erp_attachment_employee_object", erpAttachmentEmployeeObject);
registerRpc("erp_attachment_employee_claim", erpAttachmentEmployeeClaim);
registerRpc("erp_attachment_employee_finish", erpAttachmentEmployeeFinish, { objects: finishObjects });
registerRpc("erp_attachment_employee_stop", erpAttachmentEmployeeStop);
registerRpc("erp_attachment_employee_delete", erpAttachmentEmployeeDelete);
