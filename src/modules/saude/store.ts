import { z } from "zod";
import { all, batch, one } from "../../db";
import { sha } from "../../security";
import { now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { authorizedOrder } from "../os/public";
import { projectOrderForStaff } from "../os/privacy";
import {
  audit, auditStatement, clinical, decrypt, encrypt, episode, human,
  pageQuery, protectedDto, responsible, subject, type Statement,
} from "./access";
import {
  DAY, attachmentSchema, fail, idSchema, parse, policySchema, prescriptionNotice,
  recordSchema, subjectSchema, versionSchema, type Policy, type RecordRow,
} from "./model";

export const policy = async (ctx: ModuleContext): Promise<Policy> =>
  await one<Policy>(ctx.env, "SELECT retention_days,deletion_enabled,version FROM saude_policy WHERE profile_id=?", ctx.profile) ||
  { retention_days: null, deletion_enabled: 0, version: 0 };

export async function record(ctx: ModuleContext, subjectId: string, id: string) {
  parse(idSchema, id);
  const row = await one<RecordRow>(ctx.env, "SELECT * FROM saude_records WHERE profile_id=? AND subject_id=? AND id=?", ctx.profile, subjectId, id);
  if (!row) fail(404, "not_found");
  return row;
}
export async function recordView(ctx: ModuleContext, row: RecordRow) {
  return {
    id: row.id, episode_id: row.episode_id, kind: row.kind, author: row.author,
    created: row.created, version: row.version, signed_at: row.signed_at,
    digest: row.digest, addendum_of: row.addendum_of, request_id: row.request_id,
    ...await decrypt(ctx, row.id, row.payload_enc),
    ...(row.kind === "prescription" ? { notice: prescriptionNotice } : {}),
    ...(row.kind === "exam_result" ? { review: "received_unreviewed" } : {}),
  };
}
export async function readSubject(ctx: ModuleContext, actor: Actor, subjectId: string) {
  await clinical(ctx, actor);
  const row = await subject(ctx, subjectId);
  await audit(ctx, actor, "subject.read", subjectId, [subjectId]);
  return protectedDto(ctx, actor, row.id, {
    ...await decrypt(ctx, row.id, row.payload_enc!), kind: row.kind,
    version: row.version, retain_until: row.retain_until, legal_hold: !!row.legal_hold,
  });
}
export async function listSubjects(ctx: ModuleContext, actor: Actor, query: Record<string, string>) {
  await clinical(ctx, actor);
  const { cursor, limit } = pageQuery(query);
  const rows = await all<{ id: string; payload_enc: string; kind: string }>(ctx.env,
    "SELECT id,payload_enc,kind FROM saude_subjects WHERE profile_id=? AND state='active' AND id>? ORDER BY id LIMIT ?", ctx.profile, cursor, limit + 1);
  const page = rows.slice(0, limit);
  await audit(ctx, actor, "subjects.read", null, page.map(r => r.id));
  const data = await Promise.all(page.map(async r => protectedDto(ctx, actor, r.id, {
    name: (await decrypt(ctx, r.id, r.payload_enc)).name, kind: r.kind,
  })));
  return { data, next_cursor: rows.length > limit ? page.at(-1)!.id : null };
}
export async function timeline(ctx: ModuleContext, actor: Actor, subjectId: string, query: Record<string, string>) {
  await clinical(ctx, actor);
  await subject(ctx, subjectId);
  const { cursor, limit } = pageQuery(query);
  const rows = await all<RecordRow>(ctx.env,
    "SELECT * FROM saude_records WHERE profile_id=? AND subject_id=? AND id>? ORDER BY id LIMIT ?", ctx.profile, subjectId, cursor, limit + 1);
  const page = rows.slice(0, limit);
  await audit(ctx, actor, "records.read", subjectId, page.map(r => `${r.id}:v${r.version}`));
  return { data: await Promise.all(page.map(async r => protectedDto(ctx, actor, r.id, await recordView(ctx, r)))),
    next_cursor: rows.length > limit ? page.at(-1)!.id : null };
}
export async function episodes(ctx: ModuleContext, actor: Actor, subjectId: string, query: Record<string, string>) {
  await clinical(ctx, actor);
  await subject(ctx, subjectId);
  const { cursor, limit } = pageQuery(query);
  const rows = await all(ctx.env, "SELECT id,order_id,created FROM saude_episodes WHERE profile_id=? AND subject_id=? AND id>? ORDER BY id LIMIT ?", ctx.profile, subjectId, cursor, limit + 1);
  const data = rows.slice(0, limit);
  await audit(ctx, actor, "episodes.read", subjectId, data.map(r => r.id));
  return { data, next_cursor: rows.length > limit ? data.at(-1)!.id : null };
}
export async function attendance(ctx: ModuleContext, actor: Actor, orderId: string) {
  await human(ctx, actor);
  const order = await authorizedOrder(ctx, actor, orderId);
  const view = projectOrderForStaff(ctx, actor, order);
  await audit(ctx, actor, "attendance.read", null, [orderId]);
  // Nem subject_id, nem contagem de registros, nem existência de conteúdo clínico.
  return { order_id: view.id, number: view.number, status: view.status, attendance_exists: true };
}

export interface Mutation {
  key: string; hash: string; op: string;
}
export async function commit(
  ctx: ModuleContext, actor: Actor, mutation: Mutation,
  subjectId: string | null, statements: Statement[], response: Record<string, unknown>, touch = true,
) {
  const at = now();
  const sql: Statement[] = [statements[0],
    ["INSERT INTO saude_assert(profile_id,ok) VALUES(?,changes())", [ctx.profile]],
    ...statements.slice(1)];
  if (subjectId && touch) sql.push([
    `UPDATE saude_subjects SET last_activity=?,version=version+1,
     retain_until=CASE WHEN (SELECT retention_days FROM saude_policy WHERE profile_id=?) IS NULL THEN retain_until
       ELSE MAX(COALESCE(retain_until,0),?+(SELECT retention_days FROM saude_policy WHERE profile_id=?)*?) END
     WHERE profile_id=? AND id=? AND state='active'`,
    [at, ctx.profile, at, ctx.profile, DAY, ctx.profile, subjectId],
  ]);
  sql.push(auditStatement(ctx, actor, mutation.op, subjectId, [String(response.id || subjectId || "policy")]));
  sql.push(["INSERT INTO saude_mutations(profile_id,mutation_key,request_hash,response_json) VALUES(?,?,?,?)",
    [ctx.profile, mutation.key, mutation.hash, JSON.stringify(response)]]);
  sql.push(["DELETE FROM saude_assert WHERE profile_id=?", [ctx.profile]]);
  try { await batch(ctx.env, sql); }
  catch (error) {
    if (String(error).includes("CHECK constraint failed: ok=1")) fail(409, "version_conflict");
    throw error;
  }
  return response;
}

// Único despacho de escrita, serializado pelo Coordinator. Respostas só contêm referências.
export async function command(ctx: ModuleContext, actor: Actor, op: string, raw: Record<string, unknown>, requestId: string) {
  if (op === "policy.set" || op === "hold.set") await responsible(ctx, actor, true);
  else await clinical(ctx, actor, true);
  const key = await sha(JSON.stringify([ctx.profile, actor.id, op, requestId]));
  const hash = await sha(JSON.stringify(raw));
  const previous = await one<{ request_hash: string; response_json: string }>(ctx.env,
    "SELECT request_hash,response_json FROM saude_mutations WHERE profile_id=? AND mutation_key=?", ctx.profile, key);
  if (previous) {
    if (previous.request_hash !== hash) fail(409, "idempotency_conflict");
    return JSON.parse(previous.response_json);
  }
  const mutation = { key, hash, op };
  const { subject_id, record_id, document_id: _documentId, ...data } = raw;
  const subjectId = subject_id === undefined ? null : parse(idSchema, subject_id);
  const at = now();
  const id = `${String(at).padStart(16, "0")}_${key}`;
  if (op === "policy.set") {
    const input = parse(policySchema, data);
    const old = await policy(ctx);
    if (old.version !== input.version) fail(409, "version_conflict");
    const statements: Statement[] = [[
      `INSERT INTO saude_policy(profile_id,retention_days,deletion_enabled,version) VALUES(?,?,?,1)
       ON CONFLICT(profile_id) DO UPDATE SET retention_days=excluded.retention_days,deletion_enabled=excluded.deletion_enabled,version=saude_policy.version+1 WHERE saude_policy.version=?`,
      [ctx.profile, input.retention_days, +input.deletion_enabled, input.version],
    ]];
    if (input.retention_days !== null) statements.push([
      "UPDATE saude_subjects SET retain_until=MAX(COALESCE(retain_until,0),last_activity+?*?),version=version+1 WHERE profile_id=? AND state='active'",
      [input.retention_days, DAY, ctx.profile],
    ]);
    return commit(ctx, actor, mutation, null, statements, { version: old.version + 1 }, false);
  }
  if (op === "subject.create") {
    const input = parse(subjectSchema, data);
    const rules = await policy(ctx);
    return commit(ctx, actor, mutation, id, [[
      "INSERT INTO saude_subjects(profile_id,id,kind,payload_enc,created,last_activity,retain_until) VALUES(?,?,?,?,?,?,?)",
      [ctx.profile, id, input.kind, await encrypt(ctx, id, input), at, at, rules.retention_days === null ? null : at + rules.retention_days * DAY],
    ]], { id, version: 1 }, false);
  }
  if (!subjectId) fail(400, "invalid_request");
  const parent = await subject(ctx, subjectId);
  if (op === "episode.create") {
    const input = parse(z.object({ order_id: idSchema }).strict(), data);
    await authorizedOrder(ctx, actor, input.order_id, { write: true });
    const linked = await one(ctx.env, "SELECT id FROM saude_episodes WHERE profile_id=? AND order_id=?", ctx.profile, input.order_id);
    if (linked) fail(409, "order_already_linked");
    return commit(ctx, actor, mutation, subjectId, [[
      "INSERT INTO saude_episodes(profile_id,id,subject_id,order_id,created) VALUES(?,?,?,?,?)", [ctx.profile, id, subjectId, input.order_id, at],
    ]], { id, version: 1 });
  }
  if (op === "hold.set") {
    const input = parse(z.object({ legal_hold: z.boolean(), version: versionSchema }).strict(), data);
    return commit(ctx, actor, mutation, subjectId, [[
      "UPDATE saude_subjects SET legal_hold=?,version=version+1 WHERE profile_id=? AND id=? AND version=? AND state='active'",
      [+input.legal_hold, ctx.profile, subjectId, input.version],
    ]], { id: subjectId, version: input.version + 1 }, false);
  }
  if (op === "record.create") {
    const input = parse(recordSchema, data);
    await episode(ctx, subjectId, input.episode_id);
    if (input.addendum_of) {
      const original = await record(ctx, subjectId, input.addendum_of);
      if (original.kind !== "evolution" || !original.signed_at || original.episode_id !== input.episode_id) fail(409, "invalid_addendum");
    }
    if (input.request_id) {
      const request = await record(ctx, subjectId, input.request_id);
      if (input.kind !== "exam_result" || request.kind !== "exam_request" || request.episode_id !== input.episode_id) fail(409, "invalid_exam_request");
    }
    return commit(ctx, actor, mutation, subjectId, [[
      `INSERT INTO saude_records(profile_id,id,subject_id,episode_id,kind,payload_enc,author,created,addendum_of,request_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [ctx.profile, id, subjectId, input.episode_id, input.kind, await encrypt(ctx, id, input), actor.id, at, input.addendum_of || null, input.request_id || null],
    ]], { id, version: 1 });
  }
  if (op === "record.edit" || op === "record.sign") {
    const row = await record(ctx, subjectId, parse(idSchema, record_id));
    if (row.signed_at) fail(409, "immutable");
    if (row.author !== actor.id) fail(403, "author_required");
    if (row.kind !== "evolution") fail(409, "immutable");
    if (op === "record.sign") {
      const input = parse(z.object({ version: versionSchema, confirm: z.literal(true) }).strict(), data);
      const digest = await sha(JSON.stringify([ctx.profile, subjectId, row.id, row.episode_id, row.author, row.created, row.version, at, await decrypt(ctx, row.id, row.payload_enc)]));
      return commit(ctx, actor, mutation, subjectId, [[
        "UPDATE saude_records SET signed_at=?,digest=?,version=version+1 WHERE profile_id=? AND subject_id=? AND id=? AND version=? AND author=? AND signed_at IS NULL",
        [at, digest, ctx.profile, subjectId, row.id, input.version, actor.id],
      ]], { id: row.id, version: input.version + 1 });
    }
    const input = parse(z.object({ version: versionSchema, text: z.string().trim().min(1).max(20000) }).strict(), data);
    const value = { ...await decrypt(ctx, row.id, row.payload_enc), text: input.text };
    return commit(ctx, actor, mutation, subjectId, [[
      "UPDATE saude_records SET payload_enc=?,version=version+1 WHERE profile_id=? AND subject_id=? AND id=? AND version=? AND author=? AND signed_at IS NULL",
      [await encrypt(ctx, row.id, value), ctx.profile, subjectId, row.id, input.version, actor.id],
    ], [
      "INSERT INTO saude_revisions(profile_id,record_id,subject_id,version,payload_enc,author,created) VALUES(?,?,?,?,?,?,?)",
      [ctx.profile, row.id, subjectId, row.version, row.payload_enc, actor.id, at],
    ]], { id: row.id, version: input.version + 1 });
  }
  if (op === "attachment.reserve") {
    const input = parse(attachmentSchema, data);
    await episode(ctx, subjectId, input.episode_id);
    return commit(ctx, actor, mutation, subjectId, [[
      `INSERT INTO saude_attachments(profile_id,id,subject_id,episode_id,payload_enc,mime_type,expected_bytes,created,author) VALUES(?,?,?,?,?,?,?,?,?)`,
      [ctx.profile, id, subjectId, input.episode_id, await encrypt(ctx, id, { name: input.name }), input.mime_type, input.expected_bytes, at, actor.id],
    ]], { id, version: 1 });
  }
  // Não aceitar operações arbitrárias nem registrar conteúdo em erros.
  void parent;
  fail(404, "not_found");
}
