import { all, batch, one } from "../../db";
import { now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { audit, auditStatement, clinical, responsible, subject } from "./access";
import { DAY, fail } from "./model";
import { policy } from "./store";

export async function retentionView(ctx: ModuleContext, actor: Actor, subjectId: string) {
  await responsible(ctx, actor);
  const row = await subject(ctx, subjectId, true);
  await audit(ctx, actor, "retention.read", subjectId, [subjectId]);
  return { id: row.id, state: row.state, version: row.version,
    retain_until: row.retain_until, last_activity: row.last_activity, legal_hold: !!row.legal_hold };
}
/** Descarte explícito e retomável, no Coordinator, até 20 objetos por chamada. */
export async function purge(ctx: ModuleContext, actor: Actor, subjectId: string, confirm: unknown) {
  await clinical(ctx, actor, true);
  await responsible(ctx, actor, true);
  if (confirm !== true) fail(400, "invalid_request");
  const row = await subject(ctx, subjectId, true);
  if (row.state === "deleted") return { id: subjectId, state: "deleted", has_more: false };
  if (row.state === "active") {
    const rules = await policy(ctx);
    const activeUpload = await one(ctx.env,
      "SELECT id FROM saude_attachments WHERE profile_id=? AND subject_id=? AND lease_until>? LIMIT 1", ctx.profile, subjectId, now());
    if (!rules.deletion_enabled || rules.retention_days === null || row.retain_until === null || row.legal_hold || activeUpload ||
        Math.max(row.retain_until, row.last_activity + rules.retention_days * DAY) > now()) fail(409, "retention");
    // Auditoria e bloqueio contra novas leituras/escritas precedem qualquer remoção R2.
    await batch(ctx.env, [[
      "UPDATE saude_subjects SET state='deleting',version=version+1 WHERE profile_id=? AND id=? AND state='active' AND version=?",
      [ctx.profile, subjectId, row.version],
    ], ["INSERT INTO saude_assert(profile_id,ok) VALUES(?,changes())", [ctx.profile]],
    auditStatement(ctx, actor, "purge.begin", subjectId, [subjectId]),
    ["DELETE FROM saude_assert WHERE profile_id=?", [ctx.profile]]]);
  }
  const objects = await all<{ r2_key: string }>(ctx.env,
    "SELECT r2_key FROM saude_objects WHERE profile_id=? AND subject_id=? ORDER BY r2_key LIMIT 20", ctx.profile, subjectId);
  for (const object of objects) {
    // Chaves somente do inventário privado da mesma área/paciente; nunca do corpo HTTP.
    await ctx.env.MEDIA.delete(object.r2_key);
  }
  if (objects.length) {
    await batch(ctx.env, [
      ...objects.map(object => ["DELETE FROM saude_objects WHERE profile_id=? AND subject_id=? AND r2_key=?", [ctx.profile, subjectId, object.r2_key]] as [string, unknown[]]),
      auditStatement(ctx, actor, "purge.objects", subjectId, [String(objects.length)]),
    ]);
    return { id: subjectId, state: "deleting", has_more: true };
  }
  // Filhos autorreferenciados são removidos em uma instrução (FK conferida ao fim).
  await batch(ctx.env, [
    ["DELETE FROM saude_revisions WHERE profile_id=? AND subject_id=?", [ctx.profile, subjectId]],
    ["DELETE FROM saude_records WHERE profile_id=? AND subject_id=?", [ctx.profile, subjectId]],
    ["DELETE FROM saude_attachments WHERE profile_id=? AND subject_id=?", [ctx.profile, subjectId]],
    ["DELETE FROM saude_episodes WHERE profile_id=? AND subject_id=?", [ctx.profile, subjectId]],
    ["UPDATE saude_subjects SET state='deleted',payload_enc=NULL,version=version+1 WHERE profile_id=? AND id=? AND state='deleting'", [ctx.profile, subjectId]],
    auditStatement(ctx, actor, "purge.complete", subjectId, [subjectId]),
  ]);
  return { id: subjectId, state: "deleted", has_more: false };
}
