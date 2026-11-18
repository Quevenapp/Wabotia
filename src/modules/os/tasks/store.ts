import { all, one } from "../../../db";
import { ApiError, now, type Actor } from "../../../types";
import { isBound } from "../../../visibility";
import { effectiveStage, snapshotType } from "../work-types";
import type { ModuleContext } from "../../api";
import type { MutationRef, Page, Task } from "../contracts";
import { authorizedOrder, commitChild, type AuthorizedOrder, type ChildMutation } from "../public";
import {
  body, botActor, checkAssignee, checkSensitive, identifier, invalidTask,
  projectTask, stableKey, taskFields, taskInput, taskStates, taskView,
  version, visibility, type TaskRow,
} from "./model";

export async function taskOrder(ctx: ModuleContext, actor: Actor, id: string, write = false, conversation_id?: string) {
  const order = await authorizedOrder(ctx, actor, id, { write, conversation_id });
  if (!order.type.features.tasks) throw new ApiError(409, "feature_disabled", "Tarefas desligadas neste tipo.");
  return order;
}
async function loadTask(ctx: ModuleContext, order: AuthorizedOrder, id: string) {
  const row = await one<TaskRow>(ctx.env,
    "SELECT * FROM os_tasks WHERE profile_id=? AND order_id=? AND id=?",
    ctx.profile, order.row.id, id);
  if (!row) throw new ApiError(404, "not_found", "Tarefa não encontrada.");
  return row;
}
async function mutationKey(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder, op: string, requestId: string) {
  identifier(requestId);
  return `os.task:${await stableKey(ctx.profile, actor.id, order.row.id, op, requestId)}`;
}
export async function createTask(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string, privateAccess = false, stageSourceKey?: string): Promise<MutationRef> {
  const data = body(input, ["id", ...taskFields]);
  const order = await taskOrder(ctx, actor, identifier(data.id), true);
  const values = taskInput(data);
  if (privateAccess) await checkSensitive(ctx, actor, true);
  else if (values.sensitive) throw new ApiError(403, "sensitive_forbidden", "Use a operação privada de tarefas.");
  await checkSensitive(ctx, actor, values.sensitive);
  await checkAssignee(ctx, values.assignee);
  if (values.audience === "customer" && !(await ctx.mayNotify(actor, order.row.conversation_id)))
    throw new ApiError(403, "forbidden", "Ator não pode programar aviso ao cliente.");
  // stageSourceKey é exclusivamente interno, nunca aceito no corpo HTTP.
  const key = stageSourceKey ?? await mutationKey(ctx, actor, order, privateAccess ? "private.create" : "create", requestId);
  const id = `task_${await stableKey(key)}`;
  const count = await one<{ total: number; existing: number }>(ctx.env,
    "SELECT COUNT(*) total, COALESCE(MAX(id=?),0) existing FROM os_tasks WHERE profile_id=? AND order_id=?",
    id, ctx.profile, order.row.id);
  if (count!.total >= 500 && !count!.existing) throw new ApiError(409, "collection_limit", "Limite de 500 tarefas por ordem.");
  const at = now();
  return commitChild(ctx, actor, order, {
    entity_kind: "task", id, expected_version: null, mutation_key: key,
    changed_fields: [...taskFields, "state"], event: "os.task.created",
    statements: [[
      `INSERT INTO os_tasks(id,profile_id,order_id,title,description,assignee,audience,due_at,remind_at,
        client_visible,sensitive,created_by,created,updated)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=?)
       AND (SELECT COUNT(*) FROM os_tasks WHERE profile_id=? AND order_id=?)<500`,
      [id, ctx.profile, order.row.id, values.title, values.description, values.assignee, values.audience,
        values.due_at, values.remind_at, Number(values.client_visible), Number(values.sensitive), actor.id, at, at,
        ctx.profile, order.row.id, ctx.profile, order.row.id],
    ]],
  });
}

export async function updateTask(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string, archive = false, privateAccess = false): Promise<MutationRef> {
  const data = body(input, archive ? ["id", "task_id", "version"] : ["id", "task_id", "version", "state", ...taskFields]);
  const order = await taskOrder(ctx, actor, identifier(data.id), true);
  const id = identifier(data.task_id), expected = version(data.version);
  const row = await loadTask(ctx, order, id);
  if (privateAccess) await checkSensitive(ctx, actor, true);
  else if (row.sensitive || data.sensitive === true) throw new ApiError(403, "sensitive_forbidden", "Use a operação privada de tarefas.");
  await checkSensitive(ctx, actor, !!row.sensitive);
  const key = await mutationKey(ctx, actor, order, `${privateAccess ? "private." : ""}${archive ? "archive" : "update"}:${id}`, requestId);
  const at = now();
  let mutation: ChildMutation;
  if (archive) {
    mutation = {
      entity_kind: "task", id, expected_version: expected, mutation_key: key,
      changed_fields: ["archived_at"], event: "os.task.archived",
      statements: [[`UPDATE os_tasks SET archived_at=?,updated=?,version=version+1
        WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
      [at, at, ctx.profile, order.row.id, id, expected]]],
    };
  } else {
    const fields = Object.keys(data).filter((field) => !["id", "task_id", "version"].includes(field));
    if (!fields.length) invalidTask("campos");
    const values = taskInput({ ...taskView(row), ...data });
    await checkSensitive(ctx, actor, values.sensitive);
    if (row.sensitive && !values.sensitive) invalidTask("sensitive");
    if ("assignee" in data) await checkAssignee(ctx, values.assignee);
    if (values.audience === "customer" && !(await ctx.mayNotify(actor, order.row.conversation_id)))
      throw new ApiError(403, "forbidden", "Ator não pode programar aviso ao cliente.");
    const state = "state" in data ? data.state : row.state;
    if (!taskStates.includes(state as Task["state"])) invalidTask("state");
    const completed = state === "done" ? (row.state === "done" ? row.completed_at : at) : null;
    // Reabrir ou reprogramar inicia um ciclo; outras edições não repetem aviso já enviado.
    const reset = (state === "open" && row.state !== "open") ||
      values.due_at !== row.due_at || values.remind_at !== row.remind_at ||
      (values.audience === "staff" && values.assignee !== row.assignee) || values.audience !== row.audience;
    mutation = {
      entity_kind: "task", id, expected_version: expected, mutation_key: key,
      changed_fields: [...fields, ...(reset ? ["notified_at"] : []), ...(state !== row.state ? ["completed_at"] : [])],
      event: "os.task.updated",
      statements: [[`UPDATE os_tasks SET title=?,description=?,assignee=?,audience=?,due_at=?,remind_at=?,
        client_visible=?,sensitive=?,state=?,completed_at=?,notified_at=?,updated=?,version=version+1
        WHERE profile_id=? AND order_id=? AND id=? AND version=? AND archived_at IS NULL`,
      [values.title, values.description, values.assignee, values.audience, values.due_at, values.remind_at,
        Number(values.client_visible), Number(values.sensitive), state, completed, reset ? null : row.notified_at,
        at, ctx.profile, order.row.id, id, expected]]],
    };
  }
  // Não recusar uma versão antiga aqui: M deve primeiro recuperar mutation_key já confirmada.
  return commitChild(ctx, actor, order, mutation);
}

type Query = Record<string, string>;
function pageQuery(query: Query, mine: boolean) {
  if (Object.keys(query).some((key) => !["state", "cursor", "limit"].includes(key)))
    throw new ApiError(400, "invalid_filter", "Filtro de tarefas inválido.");
  const state = query.state ?? (mine ? "open" : "");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((state && !taskStates.includes(state as Task["state"])) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (query.limit !== undefined && !/^\d+$/.test(query.limit)))
    throw new ApiError(400, "invalid_filter", "Filtro de tarefas inválido.");
  return { state, limit };
}
function cursor(value: string | undefined, scope: string): [number, string] | null {
  if (value === undefined) return null;
  try {
    if (!value || value.length > 4096) throw new Error();
    const parsed = JSON.parse(decodeURIComponent(atob(value)));
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== scope ||
      !Number.isSafeInteger(parsed[1]) || parsed[1] < 0 || typeof parsed[2] !== "string" || !parsed[2] || parsed[2].length > 256) throw new Error();
    return [parsed[1], parsed[2]];
  } catch {
    throw new ApiError(400, "invalid_cursor", "Cursor de tarefas inválido.");
  }
}
const encodeCursor = (scope: string, key: number, id: string) => btoa(encodeURIComponent(JSON.stringify([scope, key, id])));

export async function listTasks(ctx: ModuleContext, actor: Actor, orderId: string | null, query: Query = {}, conversationId?: string): Promise<Page<Task>> {
  ctx.access(actor, "conversations:read");
  await ctx.requireEnabled();
  const mine = orderId === null;
  if (mine && (botActor(actor) || actor.credential || isBound(actor))) throw new ApiError(403, "forbidden", "Meus prazos exige uma pessoa autenticada.");
  if (mine) return listMyTasks(ctx, actor, query);
  if (conversationId) await ctx.conversation(conversationId, actor);
  if (!mine) await taskOrder(ctx, actor, identifier(orderId), false, conversationId);
  const { state, limit } = pageQuery(query, mine);
  const view = await visibility(ctx, actor, !!conversationId);
  const scope = await stableKey(ctx.profile, orderId, mine ? actor.id : "", "tasks", state, view, conversationId ?? "");
  const after = cursor(query.cursor, scope);
  const where = ["profile_id=?", "archived_at IS NULL"];
  const args: unknown[] = [ctx.profile];
  if (mine) { where.push("assignee=?", "due_at IS NOT NULL"); args.push(actor.id); }
  else { where.push("order_id=?"); args.push(orderId); }
  if (state) { where.push("state=?"); args.push(state); }
  if (view !== "private") where.push("sensitive=0");
  if (view === "public") where.push("client_visible=1");
  const sort = mine ? "due_at" : "created";
  if (after) { where.push(`(${sort}>? OR (${sort}=? AND id>?))`); args.push(after[0], after[0], after[1]); }
  const rows = await all<TaskRow>(ctx.env, `SELECT * FROM os_tasks WHERE ${where.join(" AND ")} ORDER BY ${sort},id LIMIT ?`, ...args, limit + 1);
  const data: Task[] = [];
  const parents = new Map<string, AuthorizedOrder>();
  for (const row of rows.slice(0, limit)) {
    if (mine && !parents.has(row.order_id)) parents.set(row.order_id, await taskOrder(ctx, actor, row.order_id));
    const projected = await projectTask(ctx, actor, row, !!conversationId);
    if (projected) data.push(projected);
  }
  const last = rows[Math.min(rows.length, limit) - 1];
  return { data, next_cursor: rows.length > limit ? encodeCursor(scope, mine ? last.due_at! : last.created, last.id) : null };
}

/** Consulta global por prazo, com o snapshot do pai no mesmo SELECT. */
async function listMyTasks(ctx: ModuleContext, actor: Actor, query: Query): Promise<Page<Task>> {
  const bad = () => new ApiError(400, "invalid_filter", "Filtro de prazos inválido.");
  if (Object.keys(query).some(key => !["assignee", "state", "period", "type_id", "due_from", "due_to", "cursor", "limit"].includes(key)) ||
      (query.assignee !== undefined && query.assignee !== "me")) throw bad();
  const { state, limit } = pageQuery(Object.fromEntries(Object.entries(query).filter(([key]) => ["state", "cursor", "limit"].includes(key))), true);
  const period = query.period ?? "dated";
  if (!["dated", "overdue", "today", "next7", "range", "undated"].includes(period)) throw bad();
  const day = 86_400_000, at = now();
  const today = Math.floor((at - 3 * 3_600_000) / day) * day + 3 * 3_600_000;
  const civil = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad();
    const parsed = Date.parse(value + "T00:00:00-03:00");
    if (!Number.isFinite(parsed) || new Date(parsed - 3 * 3_600_000).toISOString().slice(0, 10) !== value) throw bad();
    return parsed;
  };
  const view = await visibility(ctx, actor);
  const where = ["t.profile_id=?", "t.assignee=?", "t.archived_at IS NULL"];
  const args: unknown[] = [ctx.profile, actor.id];
  if (state) { where.push("t.state=?"); args.push(state); }
  if (view !== "private") where.push("t.sensitive=0");
  if (query.type_id) { where.push("o.type_id=?"); args.push(query.type_id); }
  if (period === "undated") where.push("t.due_at IS NULL");
  else {
    where.push("t.due_at IS NOT NULL");
    if (period === "overdue") { where.push("t.due_at<?"); args.push(at); }
    if (["today", "next7", "range"].includes(period)) {
      const from = period === "range" ? civil(query.due_from) : today;
      const until = period === "range" ? civil(query.due_to) + day : today + (period === "next7" ? 7 : 1) * day;
      if (until <= from) throw bad();
      where.push("t.due_at>=? AND t.due_at<?"); args.push(from, until);
    }
  }
  // Inclui os limites civis (e não o relógio corrente) no vínculo do cursor.
  const scope = await stableKey(ctx.profile, actor.id, "my-tasks", state, period, query.type_id, query.due_from, query.due_to, view,
    ["today", "next7"].includes(period) ? today : null);
  const after = cursor(query.cursor, scope);
  if (after) { where.push("(COALESCE(t.due_at,0)>? OR (COALESCE(t.due_at,0)=? AND t.id>?))"); args.push(after[0], after[0], after[1]); }
  const rows = await all<TaskRow & { type_snapshot_json: string; type_id: string; stage: string | null; status: string; type_number: number }>(ctx.env,
    `SELECT t.*,o.type_snapshot_json,o.type_id,o.stage,o.status,COALESCE(o.type_number,o.number) type_number
     FROM os_tasks t JOIN os_orders o ON o.profile_id=t.profile_id AND o.id=t.order_id
     WHERE ${where.join(" AND ")} ORDER BY t.due_at,t.id LIMIT ?`, ...args, limit + 1);
  const data: Task[] = [];
  for (const row of rows.slice(0, limit)) {
    const type = snapshotType(row) ?? (await taskOrder(ctx, actor, row.order_id)).type;
    if (!type.features.tasks) throw new ApiError(409, "feature_disabled", "Tarefas desligadas neste tipo.");
    const stage = type.stages.find(stage => stage.id === effectiveStage(row));
    if (!stage || stage.base_status !== row.status)
      throw new ApiError(409, "invalid_snapshot", "Etapa e estado da ordem divergem.");
    const dto = await projectTask(ctx, actor, row);
    if (dto) data.push(Object.assign(dto, {
      type_id: row.type_id, type_label: type.labels.singular,
      display_number: type.number_prefix ? `${type.number_prefix}-${row.type_number}` : String(row.type_number),
      stage_label: stage.label,
    }));
  }
  const last = rows[Math.min(rows.length, limit) - 1];
  return { data, next_cursor: rows.length > limit ? encodeCursor(scope, last.due_at ?? 0, last.id) : null };
}
