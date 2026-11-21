// Empresa: arquivos e logotipo (reserva, envio com aluguel, confirmação do
// objeto no armazenamento, exclusão lógica). Um código só para os dois tipos:
// public.erp_company_file_* e erp_company_logo_*.
// storage.buckets/objects do Supabase: no Vinki o objeto fica no R2; o
// bucket sempre existe (erp_attachments.storage_ready não falha) e a
// confirmação lê o objeto que o hub consultou antes da transação
// (ctx.objects, registerRpc(…, { objects })).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { activityRequireAdmin } from "../../access/public.ts";
import { requireAccess, sha256, ts } from "../internal.ts";

type Kind = "file" | "logo";
const BUCKET = "erp-attachments";
const s = (v: unknown) => (v === undefined ? null : (v as string | null));
const T = (k: Kind) => `"erp_company__${k}"`;
const A = (k: Kind) => `"erp_company__${k}_audit"`;
const objectName = (k: Kind, id: string, sha: string) => `company/${k === "file" ? "files" : "logo"}/${id}/${sha}`;
const COLUMNS =
  "id, command_id, actor, request_hash, mime_type, size_bytes, sha256, status, lease_token, lease_actor, CAST(lease_until AS TEXT) lease_until, finished_by, created_at, finished_at, deleted_at, deleted_by, delete_command_id";

/** erp_company.file_dto / logo_dto */
function dto(ctx: RpcContext, k: Kind, id: string, internal = false) {
  const r = one(ctx.db, `SELECT * FROM ${T(k)} WHERE id=?`, id);
  if (!r) return null;
  const owner = one(ctx.db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', r.actor);
  return {
    id: r.id,
    ...(k === "file" ? { filename: r.filename } : {}),
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    sha256: r.sha256,
    status: r.status,
    created_at: ts(r.created_at),
    finished_at: ts(r.finished_at),
    deleted: r.deleted_at !== null,
    owner_name: owner?.name === null || owner?.name === undefined ? null : [...String(owner.name)].slice(0, 120).join(""),
    ...(internal ? { bucket: BUCKET, object_key: objectName(k, String(r.id), String(r.sha256)) } : {}),
  };
}

/** erp_company.file_row / logo_row */
function row(ctx: RpcContext, k: Kind, id: string | null) {
  if (k === "file" && id === null) raise("P0002", "erp_company_file_not_found");
  const r = id === null ? null : one(ctx.db, `SELECT ${k === "file" ? "filename, " : ""}${COLUMNS} FROM ${T(k)} WHERE id=?`, id);
  if (!r) raise("P0002", `erp_company_${k}_not_found`);
  return { ...r, lease_until: r.lease_until === null ? null : BigInt(r.lease_until as string) } as Record<string, any>;
}

/**
 * Gatilhos file_identity / logo_identity (BEFORE UPDATE): identidade
 * imutável; fora de "reserved", aluguel e conclusão imutáveis; exclusão
 * imutável depois de gravada. Toda atualização passa por aqui.
 */
function update(ctx: RpcContext, k: Kind, old: Record<string, any>, set: Record<string, unknown>) {
  const next = { ...old, ...set };
  const differs = (cols: string[]) => cols.some((c) => String(old[c] ?? "") !== String(next[c] ?? ""));
  if (
    (old.status !== "reserved" && differs(["status", "lease_token", "lease_actor", "lease_until", "finished_by", "finished_at"])) ||
    (old.deleted_at !== null && differs(["deleted_at", "deleted_by", "delete_command_id"]))
  )
    raise("40001", `erp_company_${k}_immutable`);
  const cols = Object.keys(set);
  ctx.db.exec(
    `UPDATE ${T(k)} SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE id=?`,
    ...cols.map((c) => (typeof set[c] === "bigint" ? (set[c] as bigint).toString() : set[c])),
    old.id,
  );
}

function auditRow(ctx: RpcContext, k: Kind, id: string, actor: string, action: string, cmd: string | null = null) {
  ctx.db.exec(
    `INSERT INTO ${A(k)}(${k}_id, actor, action, command_id, created_at) VALUES(?,?,?,?,?)`,
    id,
    actor,
    action,
    cmd,
    ctx.clock.next().toString(),
  );
}

/** Autorização: arquivos, só administrador (erp_activity.require_admin); logo, erp_company.logo_authorize. */
function authorize(ctx: RpcContext, k: Kind, user: string, write: boolean | null): string | null {
  if (k === "file") {
    activityRequireAdmin(ctx.db, user);
    return null;
  }
  if (write === null) raise("22023", "erp_company_logo_invalid_action");
  return requireAccess(ctx.db, user, write ? "identity" : "read");
}

const LEASE_US = 120_000_000n;

function claim(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  authorize(ctx, k, user, true);
  const lease = s(a.p_lease);
  if (lease === null) raise("22023", `erp_company_${k}_invalid_lease`);
  const v = row(ctx, k, s(a.p_id));
  const now = ctx.clock.next();
  if (
    v.status === "aborted" ||
    v.deleted_at !== null ||
    (v.status === "reserved" && v.lease_until !== null && v.lease_until > now && (v.lease_token !== lease || v.lease_actor !== user))
  )
    raise("40001", `erp_company_${k}_upload_conflict`);
  if (v.status === "reserved") update(ctx, k, v, { lease_token: lease, lease_actor: user, lease_until: ctx.clock.next() + LEASE_US });
  return { ...dto(ctx, k, v.id, true), data_mode: "erp_native" };
}

function remove(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  authorize(ctx, k, user, true);
  const cmd = s(a.p_command_id);
  if (cmd === null) raise("22023", `erp_company_${k}_invalid_action`);
  const v = row(ctx, k, s(a.p_id));
  if (v.delete_command_id === cmd) {
    if (v.deleted_by !== user) raise("40001", `erp_company_${k}_command_conflict`);
    return { [k]: dto(ctx, k, v.id), replayed: true, data_mode: "erp_native" };
  }
  if (one(ctx.db, `SELECT 1 x FROM ${T(k)} WHERE delete_command_id=? OR command_id=?`, cmd, cmd))
    raise("40001", `erp_company_${k}_command_conflict`);
  if (v.status !== "ready" || v.deleted_at !== null) raise("40001", `erp_company_${k}_not_ready`);
  update(ctx, k, v, { deleted_at: ctx.clock.next(), deleted_by: user, delete_command_id: cmd });
  auditRow(ctx, k, v.id, user, "delete", cmd);
  return { [k]: dto(ctx, k, v.id), replayed: false, data_mode: "erp_native" };
}

function finish(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  authorize(ctx, k, user, true);
  const v = row(ctx, k, s(a.p_id));
  const sha = s(a.p_sha256);
  const size = a.p_size_bytes === undefined || a.p_size_bytes === null ? null : Number(a.p_size_bytes);
  if (sha !== v.sha256 || size !== v.size_bytes) raise("40001", `erp_company_${k}_integrity_conflict`);
  if (v.status === "ready") return { [k]: dto(ctx, k, v.id), replayed: true, data_mode: "erp_native" };
  const lease = s(a.p_lease);
  if (v.status !== "reserved" || lease === null || v.lease_token !== lease || v.lease_actor !== user || v.lease_until === null || v.lease_until <= ctx.clock.next())
    raise("40001", `erp_company_${k}_upload_conflict`);
  const stored = ctx.objects(`${BUCKET}/${objectName(k, v.id, v.sha256)}`);
  if (!stored || stored.size !== v.size_bytes || stored.mimetype !== v.mime_type) raise("40001", `erp_company_${k}_object_unconfirmed`);
  update(ctx, k, v, { status: "ready", lease_token: null, lease_actor: null, lease_until: null, finished_by: user, finished_at: ctx.clock.next() });
  auditRow(ctx, k, v.id, user, "finalize");
  if (k === "logo")
    // O logo novo substitui os anteriores (guardados, excluídos logicamente e auditados).
    for (const old of ctx.db.exec(`SELECT id FROM ${T(k)} WHERE status='ready' AND deleted_at IS NULL AND id<>? ORDER BY id`, v.id).rows) {
      update(ctx, k, row(ctx, k, String(old.id)), { deleted_at: ctx.clock.next(), deleted_by: user });
      auditRow(ctx, k, String(old.id), user, "delete");
    }
  return { [k]: dto(ctx, k, v.id), replayed: false, data_mode: "erp_native" };
}

function object(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  const write = a.p_write === undefined ? null : (a.p_write as boolean | null);
  authorize(ctx, k, user, write);
  if (k === "file" && write === null) raise("22023", "erp_company_file_invalid_action");
  const v = row(ctx, k, s(a.p_id));
  if (v.status === "aborted" || v.deleted_at !== null || (!write && v.status !== "ready")) raise("40001", `erp_company_${k}_not_ready`);
  return { ...dto(ctx, k, v.id, true), data_mode: "erp_native" };
}

const MIME = ["application/pdf", "image/png", "image/jpeg", "application/xml", "text/plain"];
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/xml": "xml", "text/plain": "txt" };

function reserve(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  authorize(ctx, k, user, true);
  const cmd = s(a.p_command_id);
  const mime = s(a.p_mime_type);
  const size = a.p_size_bytes === undefined || a.p_size_bytes === null ? null : Number(a.p_size_bytes);
  const sha = s(a.p_sha256);
  const filename = s(a.p_filename);
  const invalid =
    k === "file"
      ? cmd === null || mime === null || !MIME.includes(mime) || size === null || size < 1 || size > 10485760 || sha === null ||
        !/^[a-f0-9]{64}$/.test(sha) || filename === null || !/^arquivo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(pdf|png|jpg|xml|txt)$/.test(filename) ||
        filename.split(".")[1] !== EXT[mime]
      : cmd === null || mime === null || !["image/png", "image/jpeg"].includes(mime) || size === null || size < 1 || size > 2097152 ||
        sha === null || !/^[a-f0-9]{64}$/.test(sha);
  if (invalid) raise("22023", `erp_company_${k}_invalid_metadata`);
  const hash = sha256(
    jsonbText(k === "file" ? { actor: user, filename, mime_type: mime, size_bytes: size, sha256: sha } : { actor: user, mime_type: mime, size_bytes: size, sha256: sha }),
  );
  const existing = one(ctx.db, `SELECT id, actor, request_hash FROM ${T(k)} WHERE command_id=?`, cmd);
  if (existing) {
    if (existing.actor !== user || existing.request_hash !== hash) raise("40001", `erp_company_${k}_command_conflict`);
    return { [k]: dto(ctx, k, String(existing.id)), replayed: true, data_mode: "erp_native" };
  }
  if (one(ctx.db, `SELECT 1 x FROM ${T(k)} WHERE delete_command_id=?`, cmd)) raise("40001", `erp_company_${k}_command_conflict`);
  const quota = k === "file" ? 5000 : 200;
  if (Number(one(ctx.db, `SELECT count(*) n FROM ${T(k)}`)!.n) >= quota) raise("54000", `erp_company_${k}_quota`);
  const id = crypto.randomUUID();
  ctx.db.exec(
    k === "file"
      ? `INSERT INTO ${T(k)}(id, command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status, created_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?)`
      : `INSERT INTO ${T(k)}(id, command_id, actor, request_hash, mime_type, size_bytes, sha256, status, created_at) VALUES(?,?,?,?,?,?,?,'reserved',?)`,
    ...(k === "file" ? [id, cmd, user, hash, filename, mime, size, sha] : [id, cmd, user, hash, mime, size, sha]),
    ctx.clock.next().toString(),
  );
  auditRow(ctx, k, id, user, "reserve", cmd);
  return { [k]: dto(ctx, k, id), replayed: false, data_mode: "erp_native" };
}

function stop(ctx: RpcContext, k: Kind, a: RpcArgs) {
  const user = s(a.p_user_id)!;
  authorize(ctx, k, user, true);
  const abort = a.p_abort === undefined ? null : (a.p_abort as boolean | null);
  if (abort === null) raise("22023", `erp_company_${k}_invalid_action`);
  const v = row(ctx, k, s(a.p_id));
  const lease = s(a.p_lease);
  if (abort) {
    if (v.status === "ready" || (v.lease_until !== null && v.lease_until > ctx.clock.next())) raise("40001", `erp_company_${k}_upload_conflict`);
    if (v.status !== "aborted") {
      update(ctx, k, v, { status: "aborted", lease_token: null, lease_actor: null, lease_until: null, finished_by: user, finished_at: ctx.clock.next() });
      auditRow(ctx, k, v.id, user, "abort");
    }
  } else if (v.status === "reserved" && v.lease_token === lease && v.lease_actor === user)
    update(ctx, k, v, { lease_token: null, lease_actor: null, lease_until: null });
  return { [k]: dto(ctx, k, v.id), data_mode: "erp_native" };
}

const objectsFor = (k: Kind) => (a: RpcArgs) =>
  typeof a.p_id === "string" && typeof a.p_sha256 === "string" ? [`${BUCKET}/${objectName(k, a.p_id, a.p_sha256)}`] : [];

for (const k of ["file", "logo"] as const) {
  registerRpc(`erp_company_${k}_claim`, (ctx, a) => claim(ctx, k, a));
  registerRpc(`erp_company_${k}_delete`, (ctx, a) => remove(ctx, k, a));
  registerRpc(`erp_company_${k}_finish`, (ctx, a) => finish(ctx, k, a), { objects: objectsFor(k) });
  registerRpc(`erp_company_${k}_object`, (ctx, a) => object(ctx, k, a));
  registerRpc(`erp_company_${k}_reserve`, (ctx, a) => reserve(ctx, k, a));
  registerRpc(`erp_company_${k}_stop`, (ctx, a) => stop(ctx, k, a));
}

/** public.erp_company_logo_get: logo atual e, para o administrador, as reservas pendentes. */
registerRpc("erp_company_logo_get", (ctx: RpcContext, a: RpcArgs) => {
  const role = authorize(ctx, "logo", s(a.p_user_id)!, false);
  const current = one(ctx.db, `SELECT id FROM "erp_company__logo" WHERE status='ready' AND deleted_at IS NULL ORDER BY finished_at DESC, id DESC LIMIT 1`);
  const pending =
    role === "admin"
      ? ctx.db
          .exec(`SELECT id FROM "erp_company__logo" WHERE status='reserved' ORDER BY created_at, id LIMIT 20`)
          .rows.map((r) => dto(ctx, "logo", String(r.id)))
      : [];
  return {
    scope: "company_logo",
    data_mode: "erp_native",
    can_manage: role === "admin",
    logo: current ? dto(ctx, "logo", String(current.id)) : null,
    pending,
  };
});
