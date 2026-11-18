import { all, batch, one } from "../../db";
import { hex, sha } from "../../security";
import { now, uid, type Actor } from "../../types";
import type { BinaryDownload, BinaryUploadHandler, ModuleContext } from "../api";
import {
  audit, auditStatement, clinical, decrypt, pageQuery, protectedDto, subject,
} from "./access";
import { fail, LEASE, LIMIT, parse, idSchema, versionSchema, type Attachment } from "./model";
import { commit } from "./store";

export async function attachment(ctx: ModuleContext, actor: Actor, subjectId: string, id: string, write = false) {
  await clinical(ctx, actor, write);
  await subject(ctx, subjectId);
  parse(idSchema, id);
  const row = await one<Attachment>(ctx.env,
    "SELECT * FROM saude_attachments WHERE profile_id=? AND subject_id=? AND id=?", ctx.profile, subjectId, id);
  if (!row) fail(404, "not_found");
  return row;
}
const objectKey = (ctx: ModuleContext, row: Attachment, attempt: string) =>
  `private/saude/${ctx.profile}/${row.subject_id}/${row.id}/${attempt}`;
const keyFor = (ctx: ModuleContext, actor: Actor, id: string, key: string) => sha(JSON.stringify([ctx.profile, actor.id, id, key]));
const validKey = (key: string) => {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) fail(400, "invalid_request");
};
export async function beginUpload(ctx: ModuleContext, actor: Actor, subjectId: string, id: string, version: number, uploadKey: string) {
  const row = await attachment(ctx, actor, subjectId, id, true);
  parse(versionSchema, version);
  validKey(uploadKey);
  const key = await keyFor(ctx, actor, id, uploadKey);
  if (row.upload_key === key && row.attempt && (row.version === version || (row.state === "ready" && row.version === version + 1)))
    return { id, attempt: row.attempt, version };
  if (row.state !== "pending" || row.version !== version) fail(409, "version_conflict");
  if (row.lease_until && row.lease_until > now()) fail(409, "upload_busy");
  const attempt = uid();
  const r2key = objectKey(ctx, row, attempt);
  await batch(ctx.env, [[
    `UPDATE saude_attachments SET upload_key=?,attempt=?,lease_until=?,r2_key=? WHERE profile_id=? AND subject_id=? AND id=? AND version=? AND state='pending' AND (lease_until IS NULL OR lease_until<=?)`,
    [key, attempt, now() + LEASE, r2key, ctx.profile, subjectId, id, version, now()],
  ], ["INSERT INTO saude_assert(profile_id,ok) VALUES(?,changes())", [ctx.profile]], [
    "INSERT INTO saude_objects(profile_id,subject_id,attachment_id,r2_key) VALUES(?,?,?,?)", [ctx.profile, subjectId, id, r2key],
  ], auditStatement(ctx, actor, "attachment.upload.begin", subjectId, [id]),
  ["DELETE FROM saude_assert WHERE profile_id=?", [ctx.profile]]]);
  return { id, attempt, version };
}

export async function completeUpload(ctx: ModuleContext, actor: Actor, subjectId: string, id: string, version: number, attempt: string) {
  const row = await attachment(ctx, actor, subjectId, id, true);
  parse(versionSchema, version);
  parse(idSchema, attempt);
  if (row.attempt !== attempt || row.r2_key !== objectKey(ctx, row, attempt)) fail(409, "content_mismatch");
  if (row.state === "ready" && row.version === version + 1) return { id, version: row.version };
  if (row.version !== version) fail(409, "version_conflict");
  if (!row.lease_until || row.lease_until <= now()) fail(409, "upload_expired");
  const object = await ctx.env.MEDIA.get(row.r2_key);
  if (!object) fail(409, "content_mismatch");
  if (object.size !== row.expected_bytes || object.size > LIMIT) {
    await object.body.cancel();
    fail(409, "content_mismatch");
  }
  const bytes = await object.arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== object.customMetadata?.sha256 || bytes.byteLength !== row.expected_bytes) fail(409, "content_mismatch");
  const key = await sha(JSON.stringify([ctx.profile, id, attempt, "complete"]));
  return commit(ctx, actor, { key, hash: key, op: "attachment.upload.complete" }, subjectId, [[
    "UPDATE saude_attachments SET state='ready',sha256=?,version=version+1,lease_until=NULL WHERE profile_id=? AND subject_id=? AND id=? AND version=? AND attempt=? AND state='pending' AND lease_until>?",
    [digest, ctx.profile, subjectId, id, version, attempt, now()],
  ]], { id, version: version + 1 });
}

// Mesmo transporte de documentos da F0: content() limitado, command() serializado,
// R2 privado e PUT condicional; não importa armazenamento interno do módulo os.
export const attachmentUpload: BinaryUploadHandler = {
  operations: ["saude.attachment.upload.begin", "saude.attachment.upload.complete"],
  async authorize(ctx, actor, { params }) {
    await attachment(ctx, actor, params.subject_id, params.document_id, true);
  },
  async upload(ctx, actor, request) {
    const { subject_id: subjectId, document_id: id } = request.params;
    await attachment(ctx, actor, subjectId, id, true);
    const grant = await request.command("saude.attachment.upload.begin", {
      version: request.version, upload_key: request.key,
    }) as { attempt: string };
    const row = await attachment(ctx, actor, subjectId, id, true);
    if (row.attempt !== grant.attempt || row.upload_key !== await keyFor(ctx, actor, id, request.key)) fail(409, "content_mismatch");
    if (row.state === "ready" && row.version === request.version + 1) return { id, version: row.version };
    if (row.version !== request.version) fail(409, "version_conflict");
    if (!row.lease_until || row.lease_until <= now()) fail(409, "upload_expired");
    if (!row.r2_key || row.r2_key !== objectKey(ctx, row, grant.attempt)) fail(409, "content_mismatch");
    if (!(await ctx.env.MEDIA.head(row.r2_key))) {
      const content = await request.content();
      if (content.byte_length !== row.expected_bytes || content.byte_length > LIMIT) fail(409, "content_mismatch");
      if (row.lease_until <= now()) fail(409, "upload_expired");
      await ctx.env.MEDIA.put(row.r2_key, content.bytes, {
        onlyIf: { etagDoesNotMatch: "*" }, sha256: content.sha256,
        httpMetadata: { contentType: row.mime_type }, customMetadata: { sha256: content.sha256 },
      });
    }
    try {
      // Se o descarte começou enquanto R2 respondia, não deixar bytes tardios.
      await attachment(ctx, actor, subjectId, id, true);
      return await request.command("saude.attachment.upload.complete", { version: request.version, attempt: grant.attempt });
    } catch (error) {
      const parent = await one<{ state: string }>(ctx.env, "SELECT state FROM saude_subjects WHERE profile_id=? AND id=?", ctx.profile, subjectId);
      if (parent && parent.state !== "active") await ctx.env.MEDIA.delete(row.r2_key);
      throw error;
    }
  },
};
export async function attachmentView(ctx: ModuleContext, row: Attachment) {
  return { id: row.id, episode_id: row.episode_id, ...await decrypt(ctx, row.id, row.payload_enc),
    mime_type: row.mime_type, expected_bytes: row.expected_bytes, sha256: row.sha256,
    state: row.state, version: row.version, sensitive: true, client_visible: false };
}
export async function listAttachments(ctx: ModuleContext, actor: Actor, subjectId: string, query: Record<string, string>) {
  await clinical(ctx, actor);
  await subject(ctx, subjectId);
  const { cursor, limit } = pageQuery(query);
  const rows = await all<Attachment>(ctx.env,
    "SELECT * FROM saude_attachments WHERE profile_id=? AND subject_id=? AND id>? ORDER BY id LIMIT ?", ctx.profile, subjectId, cursor, limit + 1);
  const page = rows.slice(0, limit);
  await audit(ctx, actor, "attachments.read", subjectId, page.map(r => r.id));
  return { data: await Promise.all(page.map(async r => protectedDto(ctx, actor, r.id, await attachmentView(ctx, r)))),
    next_cursor: rows.length > limit ? page.at(-1)!.id : null };
}
export async function downloadAttachment(ctx: ModuleContext, actor: Actor, subjectId: string, id: string): Promise<BinaryDownload> {
  const row = await attachment(ctx, actor, subjectId, id);
  if (row.state !== "ready" || !row.attempt || row.r2_key !== objectKey(ctx, row, row.attempt)) fail(404, "not_found");
  await audit(ctx, actor, "attachment.download", subjectId, [id]);
  const object = await ctx.env.MEDIA.get(row.r2_key!);
  if (!object) fail(404, "not_found");
  return { body: object.body, headers: {
    "Content-Type": row.mime_type, "Content-Length": String(row.expected_bytes),
    // Nome neutro evita expor metadados clínicos em cabeçalhos e histórico de downloads.
    "Content-Disposition": 'attachment; filename="anexo-clinico"', "Cache-Control": "no-store",
  } };
}
