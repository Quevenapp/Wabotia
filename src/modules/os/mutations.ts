import { batch, one } from "../../db";
import { ApiError, type Actor, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { AuthorizedOrder, ChildMutation, ChildStatement } from "./public";
import type { MutationRef } from "./contracts";

export const versionConflict = () => new ApiError(409, "version_conflict", "O registro mudou. Atualize e tente novamente.");
// SELECT também pertence à transação D1. A expressão só falha quando o CAS
// anterior não escreveu exatamente uma linha, revertendo o lote inteiro.
export const casGuard: ChildStatement = ["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('os_version_conflict') END", []];
export async function atomic(ctx: ModuleContext, statements: ChildStatement[]) {
  try { return await batch(ctx.env, statements); }
  catch (error) {
    if (/malformed JSON|os_version_conflict/i.test(String(error))) throw versionConflict();
    throw error;
  }
}
export function checkVersion(row: any, value: unknown, required = true) {
  if ((!required && value === undefined)) return;
  if (!Number.isSafeInteger(value) || value !== (row.row_version ?? 1)) throw versionConflict();
}
export async function mutationHistory(ctx: ModuleContext, key?: string) {
  return key ? one(ctx.env, "SELECT * FROM os_history WHERE profile_id=? AND mutation_key=?", ctx.profile, key) : null;
}
export async function publishMutation(ctx: ModuleContext, h: any) {
  if (!h.kind.startsWith("os.")) return;
  await ctx.publish(h.kind, h.entity_id ?? h.order_id, {
    id: h.entity_id ?? h.order_id, order_id: h.order_id, version: h.entity_version,
    ...(h.entity_kind ? { entity_kind: h.entity_kind } : {}),
    ...(h.from_stage ? { from_stage: h.from_stage, to_stage: h.to_stage } : {}),
  }, { key: `mutation:${h.id}` });
}
export async function commitChildMutation(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder, mutation: ChildMutation): Promise<MutationRef> {
  ctx.access(actor, "conversations:write");
  await ctx.requireEnabled();
  if (order.row.profile_id !== ctx.profile) throw new ApiError(404, "not_found", "Ordem não encontrada.");
  const previous = await mutationHistory(ctx, mutation.mutation_key);
  if (previous) {
    if (previous.order_id !== order.row.id || previous.entity_id !== mutation.id || previous.entity_kind !== mutation.entity_kind || previous.kind !== mutation.event)
      throw versionConflict();
    await publishMutation(ctx, previous);
    return { id: mutation.id, order_id: order.row.id, version: previous.entity_version };
  }
  if (!mutation.statements.length || !mutation.mutation_key || (mutation.expected_version !== null && (!Number.isSafeInteger(mutation.expected_version) || mutation.expected_version < 1))) throw versionConflict();
  const tables = { task: "os_tasks", person: "os_people", document: "os_documents", entry: "os_entries" };
  const table = tables[mutation.entity_kind];
  if (!table) throw versionConflict();
  const current = await one(ctx.env, `SELECT version FROM ${table} WHERE profile_id=? AND order_id=? AND id=?`, ctx.profile, order.row.id, mutation.id);
  if (mutation.expected_version === null ? !!current : current?.version !== mutation.expected_version) throw versionConflict();
  const version = (mutation.expected_version ?? 0) + 1;
  const at = now(), history = uid();
  await atomic(ctx, [
    mutation.statements[0], casGuard, ...mutation.statements.slice(1),
    ["INSERT INTO os_history(id,profile_id,order_id,kind,actor,created,entity_kind,entity_id,entity_version,mutation_key,changed_fields_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [history, ctx.profile, order.row.id, mutation.event, actor.id, at, mutation.entity_kind, mutation.id, version, mutation.mutation_key, JSON.stringify(mutation.changed_fields)]],
    ["UPDATE os_orders SET updated=?,stale_notified_at=NULL WHERE profile_id=? AND id=?", [at, ctx.profile, order.row.id]], casGuard,
  ]);
  await publishMutation(ctx, { id: history, kind: mutation.event, entity_id: mutation.id, order_id: order.row.id, entity_version: version, entity_kind: mutation.entity_kind });
  return { id: mutation.id, order_id: order.row.id, version };
}

/** Alteração do pai: CAS, histórico sem valores e publicação recuperável. */
export async function commitOrderMutation(ctx: ModuleContext, row: any, sets: Record<string, unknown>, actor: string, event: string, changed: string[], key?: string, note = "") {
  const previous = await mutationHistory(ctx, key);
  if (previous) {
    if (previous.order_id !== row.id || previous.kind !== event) throw versionConflict();
    await publishMutation(ctx, previous);
    return one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, row.id);
  }
  const at = now(), version = (row.row_version ?? 1) + 1, id = uid();
  const values = { ...sets, row_version: version, updated: at, stale_notified_at: null };
  const keys = Object.keys(values);
  const h = { id, order_id: row.id, kind: event, entity_version: version, from_stage: row.stage || row.status, to_stage: sets.stage ?? row.stage ?? row.status };
  await atomic(ctx, [
    [`UPDATE os_orders SET ${keys.map(k => k + "=?").join(",")} WHERE profile_id=? AND id=? AND row_version=?`, [...Object.values(values), ctx.profile, row.id, row.row_version ?? 1]], casGuard,
    ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,from_stage,to_stage,actor,created,entity_version,mutation_key,changed_fields_json,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, ctx.profile, row.id, event, row.status, sets.status ?? row.status, h.from_stage, h.to_stage, actor, at, version, key ?? null, JSON.stringify(changed), note]],
  ]);
  await publishMutation(ctx, h);
  return one(ctx.env, "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, row.id);
}
