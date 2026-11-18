import { all, batch, one } from "../../db";
import { seal, unseal } from "../../security";
import { now, uid, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { mayReadSensitive, projectChildForStaff } from "../os/privacy";
import { fail, parse, idSchema, type Subject } from "./model";

export type Statement = [string, unknown[]];
export async function human(ctx: ModuleContext, actor: Actor, write = false) {
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  await ctx.requireEnabled();
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:"))
    fail(403, "forbidden");
}
export async function clinical(ctx: ModuleContext, actor: Actor, write = false) {
  await human(ctx, actor, write);
  if (!(await mayReadSensitive(ctx, actor)) || !(await ctx.granted(actor, "clinical_read")) ||
      (write && !(await ctx.granted(actor, "clinical_write")))) fail(403, "forbidden");
}
export async function responsible(ctx: ModuleContext, actor: Actor, write = false) {
  await human(ctx, actor, write);
  if (!(await ctx.granted(actor, "responsible"))) fail(403, "forbidden");
}
export async function subject(ctx: ModuleContext, id: string, inactive = false) {
  parse(idSchema, id);
  const row = await one<Subject>(ctx.env, "SELECT * FROM saude_subjects WHERE profile_id=? AND id=?", ctx.profile, id);
  if (!row || (!inactive && row.state !== "active")) fail(404, "not_found");
  return row;
}
export async function episode(ctx: ModuleContext, subjectId: string, id: string) {
  parse(idSchema, id);
  const row = await one<{ id: string; order_id: string }>(ctx.env,
    "SELECT id,order_id FROM saude_episodes WHERE profile_id=? AND subject_id=? AND id=?", ctx.profile, subjectId, id);
  if (!row) fail(404, "not_found");
  return row;
}
export const auditStatement = (ctx: ModuleContext, actor: Actor, action: string, subjectId: string | null, resources: string[]): Statement => [
  "INSERT INTO saude_access_audit(profile_id,id,subject_id,actor,action,resources_json,created) VALUES(?,?,?,?,?,?,?)",
  [ctx.profile, `${String(now()).padStart(16, "0")}_${uid()}`, subjectId, actor.id, action, JSON.stringify(resources), now()],
];
export async function audit(ctx: ModuleContext, actor: Actor, action: string, subjectId: string | null, resources: string[]) {
  // Nenhum conteúdo sai quando esta gravação falha, inclusive em exportações.
  await batch(ctx.env, [auditStatement(ctx, actor, action, subjectId, resources)]);
}
export const encrypt = (ctx: ModuleContext, id: string, value: unknown) => seal(ctx.env, { profile: ctx.profile, id, value });
export async function decrypt(ctx: ModuleContext, id: string, ciphertext: string) {
  const envelope = await unseal(ctx.env, ciphertext);
  if (envelope.profile !== ctx.profile || envelope.id !== id) fail(404, "not_found");
  return envelope.value;
}
export async function protectedDto(ctx: ModuleContext, actor: Actor, id: string, value: Record<string, unknown>) {
  const dto = await projectChildForStaff(ctx, actor, {
    order_id: "", version: 1, created: 0, updated: 0, archived_at: null, ...value, id,
    client_visible: false, sensitive: true,
  });
  if (!dto) fail(403, "forbidden");
  return dto;
}
export function pageQuery(query: Record<string, string>) {
  const cursor = query.cursor || "";
  if (cursor && !/^[a-zA-Z0-9_-]{1,120}$/.test(cursor)) fail(400, "invalid_request");
  const limit = Number(query.limit || 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, "invalid_request");
  return { cursor, limit };
}
export async function auditPage(ctx: ModuleContext, actor: Actor, query: Record<string, string>) {
  await responsible(ctx, actor);
  const { cursor, limit } = pageQuery(query);
  if (query.subject_id) parse(idSchema, query.subject_id);
  const data = await all(ctx.env,
    `SELECT id,subject_id,actor,action,resources_json,created FROM saude_access_audit
     WHERE profile_id=? AND id>? ${query.subject_id ? "AND subject_id=?" : ""} ORDER BY id LIMIT ?`,
    ctx.profile, cursor, ...(query.subject_id ? [query.subject_id] : []), limit + 1);
  const page = data.slice(0, limit);
  await audit(ctx, actor, "audit.read", query.subject_id || null, page.map(r => r.id));
  return { data: page.map(r => ({ ...r, resources: JSON.parse(r.resources_json), resources_json: undefined })),
    next_cursor: data.length > limit ? page.at(-1)!.id : null };
}
