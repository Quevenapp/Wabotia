// Anexos dos documentos (public.erp_attachment_list, _reserve, _object, _claim,
// _finish, _stop e _delete) e dos contatos (public.erp_attachment_contact_*,
// com a foto do contato). Mesmo desenho da foto do funcionário
// (erp_attachment_employee.ts): R2 no lugar de storage.objects (ctx.objects),
// bucket sempre presente (storageReady) e os gatilhos immutable_identity,
// contact_file_identity e de trilha imutável cumpridos aqui.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLeft } from "../../../engine/text.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { contactRequireVisible, requireAccess as catalogRequireAccess } from "../../catalog/public.ts";
import { contactUsable, mirrorRequireVisible, requireAccess as documentsRequireAccess } from "../../documents/public.ts";
import { bool, int, text, uuid } from "../args.ts";
import { frameworkHash } from "../framework.ts";
import { nowMicros } from "../platform.ts";
import { storageReady } from "../public.ts";

const BUCKET = "erp-attachments";
const LEASE = 120_000_000n;
const MIME: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/xml": "xml", "text/plain": "txt" };

interface Kind {
  table: string;
  owner: string; // coluna do dono (document_id ou contact_id)
  prefix: string; // documents/ ou contacts/
  audit: { table: string; file: string };
  /** O dono do arquivo é legível (ou gravável) por este usuário. */
  authorize(db: SqlDriver, a: RpcArgs, write: boolean | null): void;
  ownerArg: string;
  /** Campos a mais no DTO. */
  extra(f: Record<string, unknown>): Record<string, unknown>;
}

const COLUMNS = (owner: string, extra = "") => `id, ${owner}, ${extra}command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status,
  lease_token, lease_actor, CAST(lease_until AS TEXT) lease_until, CAST(created_at AS TEXT) created_at, CAST(finished_at AS TEXT) finished_at,
  CAST(deleted_at AS TEXT) deleted_at, deleted_by, delete_command_id`;

/** erp_attachments.authorize(user, kind, document, write) */
function documentAuthorize(db: SqlDriver, a: RpcArgs, write: boolean | null) {
  const user = uuid(a, "p_user_id");
  const kind = text(a, "p_kind");
  const document = uuid(a, "p_document_id");
  mirrorRequireVisible(db, user, document, write === true);
  documentsRequireAccess(db, user, kind, write === true);
  const d = document === null ? undefined : one(db, 'SELECT contact_id FROM "erp_documents__document" WHERE id=? AND kind=?', document, kind);
  if (!d) raise("P0002", "erp_attachment_document_not_found");
  // 267: os anexos do documento de um contato que o usuário não vê não são encontrados.
  if (!contactUsable(db, user, (d.contact_id as string | null) ?? null)) raise("P0002", "erp_attachment_document_not_found");
}

/** erp_attachments.contact_authorize(user, contact, write) */
function contactAuthorize(db: SqlDriver, a: RpcArgs, write: boolean | null) {
  const user = uuid(a, "p_user_id");
  const contact = uuid(a, "p_contact_id");
  if (write === null) raise("22023", "erp_attachment_invalid_action");
  catalogRequireAccess(db, user, "contacts", write);
  if (
    contact === null ||
    !one(db, `SELECT 1 x FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE c.record_id=? AND r.entity='contacts'`, contact)
  )
    raise("P0002", "erp_attachment_contact_not_found");
  contactRequireVisible(db, user, contact);
}

const DOCUMENT: Kind = {
  table: "erp_attachments__attachment",
  owner: "document_id",
  prefix: "documents",
  audit: { table: "erp_attachments__audit", file: "attachment_id" },
  authorize: documentAuthorize,
  ownerArg: "p_document_id",
  extra: () => ({}),
};
const CONTACT: Kind = {
  table: "erp_attachments__contact_file",
  owner: "contact_id",
  prefix: "contacts",
  audit: { table: "erp_attachments__contact_file_audit", file: "file_id" },
  authorize: contactAuthorize,
  ownerArg: "p_contact_id",
  extra: (f) => ({ purpose: f.purpose }),
};

const columns = (k: Kind) => COLUMNS(k.owner, k === CONTACT ? "purpose, " : "");

function row(db: SqlDriver, k: Kind, owner: string | null, id: string | null) {
  const v = id === null || owner === null ? undefined : one(db, `SELECT ${columns(k)} FROM "${k.table}" WHERE id=? AND ${k.owner}=?`, id, owner);
  if (!v) raise("P0002", "erp_attachment_not_found");
  return v;
}

/** erp_attachments.dto / contact_dto */
function dto(db: SqlDriver, k: Kind, id: string, internal = false) {
  const f = one(db, `SELECT ${columns(k)} FROM "${k.table}" WHERE id=?`, id)!;
  const owner = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', f.actor);
  return {
    id: f.id,
    [k.owner]: f[k.owner],
    ...k.extra(f),
    filename: f.filename,
    mime_type: f.mime_type,
    size_bytes: Number(f.size_bytes),
    sha256: f.sha256,
    status: f.status,
    created_at: jsonTimestamp(String(f.created_at)),
    finished_at: f.finished_at === null ? null : jsonTimestamp(String(f.finished_at)),
    deleted: f.deleted_at !== null,
    owner_name: owner && owner.name !== null ? pgLeft(String(owner.name), 120) : null,
    ...(internal ? { bucket: BUCKET, object_key: `${k.prefix}/${f[k.owner]}/${f.id}/${f.sha256}` } : {}),
  };
}

function audit(ctx: RpcContext, k: Kind, file: string, actor: string, action: string, command: string | null = null) {
  ctx.db.exec(
    `INSERT INTO "${k.audit.table}"(${k.audit.file}, actor, action, command_id, created_at) VALUES (?,?,?,?,?)`,
    file,
    actor,
    action,
    command,
    ctx.clock.next().toString(),
  );
}

const held = (v: Record<string, unknown>) => v.lease_until !== null && BigInt(String(v.lease_until)) > nowMicros();

function list(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const owner = uuid(a, k.ownerArg);
    k.authorize(db, a, false);
    if (k === DOCUMENT) {
      const items = db
        .exec(`SELECT id FROM "${k.table}" WHERE document_id=? AND deleted_at IS NULL ORDER BY created_at, id`, owner)
        .rows.map((r) => dto(db, k, String(r.id)));
      return { items, document_id: owner, data_mode: "erp_native" };
    }
    const items = db
      .exec(`SELECT id FROM "${k.table}" WHERE contact_id=? AND purpose='attachment' AND deleted_at IS NULL ORDER BY created_at, id`, owner)
      .rows.map((r) => dto(db, k, String(r.id)));
    const photo = one(
      db,
      `SELECT id FROM "${k.table}" WHERE contact_id=? AND purpose='photo' AND status='ready' AND deleted_at IS NULL ORDER BY finished_at DESC, id DESC LIMIT 1`,
      owner,
    );
    const pending = db
      .exec(`SELECT id FROM "${k.table}" WHERE contact_id=? AND purpose='photo' AND status='reserved' ORDER BY created_at, id`, owner)
      .rows.map((r) => dto(db, k, String(r.id)));
    return { contact_id: owner, items, photo: photo ? dto(db, k, String(photo.id)) : null, pending_photos: pending, data_mode: "erp_native" };
  };
}

function reserve(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const user = uuid(a, "p_user_id");
    const owner = uuid(a, k.ownerArg);
    const command = uuid(a, "p_command_id");
    const purpose = k === CONTACT ? text(a, "p_purpose") : null;
    const filename = text(a, "p_filename");
    const mime = text(a, "p_mime_type");
    const size = int(a, "p_size_bytes");
    const sha = text(a, "p_sha256");
    k.authorize(db, a, true);
    storageReady();
    const ext = mime === null ? null : (MIME[mime] ?? null);
    if (
      command === null ||
      (k === CONTACT && (purpose === null || !["attachment", "photo"].includes(purpose))) ||
      filename === null ||
      ext === null ||
      size === null ||
      size < 1 ||
      size > 10485760 ||
      (purpose === "photo" && (!["png", "jpg"].includes(ext) || size > 2097152)) ||
      sha === null ||
      !/^[a-f0-9]{64}$/.test(sha) ||
      !new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${ext}$`).test(filename)
    )
      raise("22023", "erp_attachment_invalid_metadata");
    const hash =
      k === DOCUMENT
        ? frameworkHash({ actor: user, kind: text(a, "p_kind"), document_id: owner, filename, mime_type: mime, size_bytes: size, sha256: sha })
        : frameworkHash({ actor: user, contact_id: owner, purpose, filename, mime_type: mime, size_bytes: size, sha256: sha });
    const stored = one(db, `SELECT id, actor, request_hash FROM "${k.table}" WHERE command_id=?`, command);
    if (stored) {
      if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_attachment_command_conflict");
      return { attachment: dto(db, k, String(stored.id)), replayed: true, data_mode: "erp_native" };
    }
    if (Number(one(db, `SELECT count(*) n FROM "${k.table}" WHERE ${k.owner}=?`, owner)!.n) >= 100) raise("54000", "erp_attachment_quota");
    const id = crypto.randomUUID();
    db.exec(
      `INSERT INTO "${k.table}"(id, ${k.owner}, ${k === CONTACT ? "purpose, " : ""}command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status, created_at)
       VALUES (?,?,${k === CONTACT ? "?," : ""}?,?,?,?,?,?,?,'reserved',?)`,
      ...[id, owner, ...(k === CONTACT ? [purpose] : []), command, user, hash, filename, mime, size, sha, ctx.clock.next().toString()],
    );
    // O anexo do documento audita a reserva sem o comando; o do contato, com ele.
    audit(ctx, k, id, user!, "reserve", k === CONTACT ? command : null);
    return { attachment: dto(db, k, id), replayed: false, data_mode: "erp_native" };
  };
}

function object(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const write = bool(a, "p_write");
    if (k === DOCUMENT && write === null) raise("22023", "erp_attachment_invalid_action");
    k.authorize(db, a, write);
    storageReady();
    const v = row(db, k, uuid(a, k.ownerArg), uuid(a, "p_id"));
    if (v.status === "aborted" || v.deleted_at !== null || (!write && v.status !== "ready")) raise("40001", "erp_attachment_not_ready");
    return { ...dto(db, k, String(v.id), true), data_mode: "erp_native" };
  };
}

function claim(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const user = uuid(a, "p_user_id");
    const lease = uuid(a, "p_lease");
    k.authorize(db, a, true);
    storageReady();
    if (lease === null) raise("22023", "erp_attachment_invalid_lease");
    const v = row(db, k, uuid(a, k.ownerArg), uuid(a, "p_id"));
    // O anexo do documento não confere a exclusão aqui; o do contato, sim.
    if (
      v.status === "aborted" ||
      (k === CONTACT && v.deleted_at !== null) ||
      (v.status === "reserved" && held(v) && (v.lease_token !== lease || v.lease_actor !== user))
    )
      raise("40001", "erp_attachment_upload_conflict");
    if (v.status === "reserved")
      db.exec(`UPDATE "${k.table}" SET lease_token=?, lease_actor=?, lease_until=? WHERE id=?`, lease, user, (nowMicros() + LEASE).toString(), v.id);
    return { ...dto(db, k, String(v.id), true), data_mode: "erp_native" };
  };
}

function finish(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const user = uuid(a, "p_user_id");
    const owner = uuid(a, k.ownerArg);
    const lease = uuid(a, "p_lease");
    const sha = text(a, "p_sha256");
    const size = int(a, "p_size_bytes");
    k.authorize(db, a, true);
    storageReady();
    const v = row(db, k, owner, uuid(a, "p_id"));
    const id = String(v.id);
    if (sha !== v.sha256 || size !== Number(v.size_bytes)) raise("40001", "erp_attachment_integrity_conflict");
    if (v.status === "ready") return { attachment: dto(db, k, id), replayed: true, data_mode: "erp_native" };
    if (v.status !== "reserved" || lease === null || v.lease_token !== lease || v.lease_actor !== user || v.lease_until === null || !held(v))
      raise("40001", "erp_attachment_upload_conflict");
    const stored = ctx.objects(`${BUCKET}/${k.prefix}/${owner}/${id}/${v.sha256}`);
    if (!stored || String(stored.size) !== String(v.size_bytes) || stored.mimetype !== v.mime_type) raise("40001", "erp_attachment_object_unconfirmed");
    db.exec(
      `UPDATE "${k.table}" SET status='ready', lease_token=NULL, lease_actor=NULL, lease_until=NULL, finished_by=?, finished_at=? WHERE id=?`,
      user,
      ctx.clock.next().toString(),
      id,
    );
    audit(ctx, k, id, user!, "finalize");
    // A foto nova do contato substitui a anterior (mantida, excluída logicamente e auditada).
    if (k === CONTACT && v.purpose === "photo")
      for (const old of db.exec(
        `SELECT id FROM "${k.table}" WHERE contact_id=? AND purpose='photo' AND status='ready' AND deleted_at IS NULL AND id<>?`,
        owner,
        id,
      ).rows) {
        db.exec(`UPDATE "${k.table}" SET deleted_at=?, deleted_by=? WHERE id=?`, ctx.clock.next().toString(), user, old.id);
        audit(ctx, k, String(old.id), user!, "delete");
      }
    return { attachment: dto(db, k, id), replayed: false, data_mode: "erp_native" };
  };
}

function stop(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const user = uuid(a, "p_user_id");
    const abort = bool(a, "p_abort");
    const lease = uuid(a, "p_lease");
    k.authorize(db, a, true);
    if (abort === null) raise("22023", "erp_attachment_invalid_action");
    const v = row(db, k, uuid(a, k.ownerArg), uuid(a, "p_id"));
    const id = String(v.id);
    if (abort) {
      if (v.status === "ready" || held(v)) raise("40001", "erp_attachment_upload_conflict");
      if (v.status !== "aborted") {
        db.exec(
          `UPDATE "${k.table}" SET status='aborted', lease_token=NULL, lease_actor=NULL, lease_until=NULL, finished_by=?, finished_at=? WHERE id=?`,
          user,
          ctx.clock.next().toString(),
          id,
        );
        audit(ctx, k, id, user!, "abort");
      }
    } else if (v.status === "reserved" && lease !== null && v.lease_token === lease && v.lease_actor === user)
      db.exec(`UPDATE "${k.table}" SET lease_token=NULL, lease_actor=NULL, lease_until=NULL WHERE id=?`, id);
    return { attachment: dto(db, k, id), data_mode: "erp_native" };
  };
}

function remove(k: Kind) {
  return (ctx: RpcContext, a: RpcArgs) => {
    const db = ctx.db;
    const user = uuid(a, "p_user_id");
    const command = uuid(a, "p_command_id");
    k.authorize(db, a, true);
    if (command === null) raise("22023", "erp_attachment_invalid_action");
    const v = row(db, k, uuid(a, k.ownerArg), uuid(a, "p_id"));
    const id = String(v.id);
    if (v.delete_command_id === command) {
      if (v.deleted_by !== user) raise("40001", "erp_attachment_command_conflict");
      return { attachment: dto(db, k, id), replayed: true, data_mode: "erp_native" };
    }
    if (one(db, `SELECT 1 x FROM "${k.table}" WHERE delete_command_id=? OR command_id=?`, command, command)) raise("40001", "erp_attachment_command_conflict");
    if (v.status !== "ready" || v.deleted_at !== null) raise("40001", "erp_attachment_not_ready");
    db.exec(`UPDATE "${k.table}" SET deleted_at=?, deleted_by=?, delete_command_id=? WHERE id=?`, ctx.clock.next().toString(), user, command, id);
    audit(ctx, k, id, user!, "delete", command);
    return { attachment: dto(db, k, id), replayed: false, data_mode: "erp_native" };
  };
}

/** A chave que o finish confere, a partir dos argumentos (p_sha256 tem de ser o da reserva). */
const finishObjects = (k: Kind) => (a: RpcArgs) => {
  const id = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null);
  const owner = id(a[k.ownerArg]),
    file = id(a.p_id);
  return owner && file && typeof a.p_sha256 === "string" ? [`${BUCKET}/${k.prefix}/${owner}/${file}/${a.p_sha256}`] : [];
};

for (const [prefix, k] of [
  ["erp_attachment", DOCUMENT],
  ["erp_attachment_contact", CONTACT],
] as const) {
  registerRpc(`${prefix}_list`, list(k));
  registerRpc(`${prefix}_reserve`, reserve(k));
  registerRpc(`${prefix}_object`, object(k));
  registerRpc(`${prefix}_claim`, claim(k));
  registerRpc(`${prefix}_finish`, finish(k), { objects: finishObjects(k) });
  registerRpc(`${prefix}_stop`, stop(k));
  registerRpc(`${prefix}_delete`, remove(k));
}
