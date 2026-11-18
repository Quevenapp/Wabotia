import { z } from "zod";
import { all, one } from "../../db";
import { ApiError, now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { commitChild, type ChildStatement } from "../os/public";
import { projectChildForStaff, projectOrderForStaff } from "../os/privacy";
import { assignees, motorContext, parent, staff } from "./access";
import { calendarRow, cas } from "./calendars";
import { calculate, type Calculation } from "./calculation";
import { idSchema, parse, ruleSchema, stableId, versionSchema, WARNING, type Calendar, type Rule } from "./model";

export interface DeadlineRow {
  profile_id: string; id: string; order_id: string; task_id: string; calendar_id: string; calendar_revision: number;
  revision: number; title: string; assignee: string; rule_json: string; due_at: number; calculated_due_at: number;
  previous_due_at: number | null; alert_at: number; review: "pending" | "confirmed" | "error"; error_code: string | null;
  confirmed_by: string | null; confirmed_at: number | null; completion_evidence: string | null;
  created_by: string; created: number; updated: number;
  current_calendar_revision: number;
  task_version: number; state: "open" | "done" | "cancelled"; completed_at: number | null;
}
export const deadlineSelect = `SELECT d.*,t.version task_version,t.state,t.completed_at,
  (SELECT revision FROM jur_calendars WHERE profile_id=d.profile_id AND id=d.calendar_id) current_calendar_revision FROM jur_deadlines d
  JOIN os_tasks t ON t.profile_id=d.profile_id AND t.order_id=d.order_id AND t.id=d.task_id`;
export async function deadlineRow(ctx: ModuleContext, id: string) {
  const row = await one<DeadlineRow>(ctx.env, `${deadlineSelect} WHERE d.profile_id=? AND d.id=?`, ctx.profile, id);
  if (!row) throw new ApiError(404, "not_found", "Prazo não encontrado.");
  return row;
}
export function deadlineView(row: DeadlineRow) {
  return { id: row.id, order_id: row.order_id, version: row.revision, task_id: row.task_id, task_version: row.task_version,
    calendar_id: row.calendar_id, calendar_revision: row.calendar_revision, title: row.title, assignee: row.assignee,
    due_at: row.due_at, calculated_due_at: row.calculated_due_at, previous_due_at: row.previous_due_at,
    alert_at: row.alert_at, review: row.review, error_code: row.error_code, state: row.state, completed_at: row.completed_at,
    confirmed_by: row.confirmed_by, confirmed_at: row.confirmed_at, completion_evidence: row.completion_evidence,
    recalculation_pending: row.state === "open" && row.calendar_revision !== row.current_calendar_revision,
    client_visible: false, sensitive: true, archived_at: null, created_by: row.created_by, created: row.created, updated: row.updated, warning: WARNING };
}
export function alertStatement(ctx: ModuleContext, row: Pick<DeadlineRow, "id" | "assignee">, revision: number, kind: "fatal" | "recalculated" | "calculation_error", at: number): ChildStatement {
  return [`INSERT OR IGNORE INTO jur_alerts(profile_id,id,deadline_id,revision,recipient,kind,created) VALUES(?,?,?,?,?,?,?)`,
    [ctx.profile, `${row.id}:${revision}:${kind}`, row.id, revision, row.assignee, kind, at]];
}
function memoryStatement(ctx: ModuleContext, id: string, revision: number, calendarRevision: number, memory: unknown, actor: string, at: number, error: string | null = null): ChildStatement {
  return ["INSERT INTO jur_calculations(profile_id,deadline_id,revision,calendar_revision,memory_json,error_code,created_by,created) VALUES(?,?,?,?,?,?,?,?)",
    [ctx.profile, id, revision, calendarRevision, JSON.stringify(memory), error, actor, at]];
}
const mutationKey = async (ctx: ModuleContext, actor: Actor, op: string, key: string) => `juridico:${await stableId(ctx.profile, actor.id, op, parse(idSchema, key))}`;

export async function previewDeadline(ctx: ModuleContext, actor: Actor, input: unknown) {
  await staff(ctx, actor);
  const data = parse(z.strictObject({ calendar_id: idSchema, calendar_revision: versionSchema, rule: ruleSchema }), input);
  const calendar = await calendarRow(ctx, data.calendar_id);
  if (calendar.revision !== data.calendar_revision) throw new ApiError(409, "version_conflict", "O calendário mudou. Refaça a prévia.");
  return calculate(JSON.parse(calendar.definition_json), data.rule);
}
export async function createDeadline(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string) {
  await staff(ctx, actor, true);
  const data = parse(z.strictObject({ order_id: idSchema, calendar_id: idSchema, calendar_revision: versionSchema,
    title: z.string().trim().min(1).max(160), assignee: idSchema, rule: ruleSchema }), input);
  const order = await parent(ctx, actor, data.order_id, true), os = motorContext(ctx);
  const key = await mutationKey(ctx, actor, "create", requestId), id = `jur_${await stableId(key)}`, task = `task_${id}`;
  // commitChild recupera também a publicação se houve falha depois da transação.
  const repeated = await one(ctx.env, "SELECT id FROM jur_deadlines WHERE profile_id=? AND id=? AND order_id=?", ctx.profile, id, data.order_id);
  if (repeated) {
    const ref = await commitChild(os, actor, order, { id: task, entity_kind: "task", expected_version: null, mutation_key: key, changed_fields: [], statements: [], event: "os.task.created" });
    return { id, task_id: task, task_version: ref.version };
  }
  if (["delivered", "cancelled"].includes(order.row.status)) throw new ApiError(409, "order_closed", "O trabalho está encerrado.");
  if (!(await assignees(ctx, actor)).data.some(p => p.id === data.assignee)) throw new ApiError(400, "invalid_assignee", "Escolha um advogado ativo com acesso sensível na área.");
  const calendar = await calendarRow(ctx, data.calendar_id);
  if (calendar.revision !== data.calendar_revision) throw new ApiError(409, "version_conflict", "O calendário mudou. Refaça a prévia.");
  const memory = calculate(JSON.parse(calendar.definition_json), data.rule), at = now();
  const statements: ChildStatement[] = [
    [`INSERT INTO os_tasks(id,profile_id,order_id,title,description,assignee,audience,due_at,client_visible,sensitive,created_by,created,updated,juridico_revision)
      SELECT ?,?,?,'Prazo jurídico','Confira a memória no painel Jurídico.',?,'staff',?,0,1,?,?,?,1
      WHERE (SELECT COUNT(*) FROM os_tasks WHERE profile_id=? AND order_id=?)<500`,
    [task, ctx.profile, data.order_id, data.assignee, memory.due_at, actor.id, at, at, ctx.profile, data.order_id]],
    [`INSERT INTO jur_deadlines(profile_id,id,order_id,task_id,calendar_id,calendar_revision,title,assignee,rule_json,due_at,calculated_due_at,alert_at,review,created_by,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
    [ctx.profile, id, data.order_id, task, calendar.id, calendar.revision, data.title, data.assignee, JSON.stringify(data.rule), memory.due_at, memory.due_at, memory.alert_at, actor.id, at, at]],
    memoryStatement(ctx, id, 1, calendar.revision, memory, actor.id, at),
  ];
  const ref = await commitChild(os, actor, order, { entity_kind: "task", id: task, expected_version: null, mutation_key: key,
    changed_fields: ["due_at", "assignee", "sensitive"], statements, event: "os.task.created" });
  return { id, task_id: task, task_version: ref.version };
}

export async function listDeadlines(ctx: ModuleContext, actor: Actor, query: Record<string, string> = {}) {
  await staff(ctx, actor);
  const q = parse(z.strictObject({ order_id: idSchema.optional(), assignee: idSchema.optional(), state: z.enum(["open", "done", "cancelled", "all"]).optional(),
    sort: z.enum(["due", "assignee", "process"]).optional(), cursor: z.string().max(4096).optional() }), query);
  const sort = q.sort === "assignee" ? "d.assignee" : q.sort === "process" ? "d.order_id" : "d.due_at";
  const where = ["d.profile_id=?"], args: unknown[] = [ctx.profile];
  if (q.order_id) { await parent(ctx, actor, q.order_id); where.push("d.order_id=?"); args.push(q.order_id); }
  if (q.assignee) { where.push("d.assignee=?"); args.push(q.assignee); }
  if (q.state !== "all") { where.push("t.state=?"); args.push(q.state ?? "open"); }
  const scope = await stableId(ctx.profile, actor.id, q.order_id, q.assignee, q.state, q.sort);
  if (q.cursor) {
    try {
      const [bound, value, due, id] = JSON.parse(decodeURIComponent(atob(q.cursor)));
      if (bound !== scope || !["string", "number"].includes(typeof value) || !Number.isSafeInteger(due) || typeof id !== "string") throw new Error();
      where.push(`(${sort}>? OR (${sort}=? AND (d.due_at>? OR (d.due_at=? AND d.id>?))))`); args.push(value, value, due, due, id);
    } catch { throw new ApiError(400, "invalid_cursor", "Cursor de prazos inválido."); }
  }
  const rows = await all<DeadlineRow>(ctx.env, `${deadlineSelect} WHERE ${where.join(" AND ")} ORDER BY ${sort},d.due_at,d.id LIMIT 11`, ...args);
  const data = [];
  const parents = new Map<string, string>();
  for (const row of rows.slice(0, 10)) {
    if (!parents.has(row.order_id)) {
      const order = await parent(ctx, actor, row.order_id);
      const projected = projectOrderForStaff(motorContext(ctx), actor, order);
      parents.set(row.order_id, `${projected.display_number} · ${projected.item}`);
    }
    const view = await projectChildForStaff(ctx, actor, { ...deadlineView(row), process_label: parents.get(row.order_id) });
    if (view) data.push(view);
  }
  const last = rows[9];
  return { data, next_cursor: rows.length > 10 ? btoa(encodeURIComponent(JSON.stringify([scope, q.sort === "assignee" ? last.assignee : q.sort === "process" ? last.order_id : last.due_at, last.due_at, last.id]))) : null };
}
export async function deadlineDetail(ctx: ModuleContext, actor: Actor, id: string, revision?: string) {
  await staff(ctx, actor);
  const row = await deadlineRow(ctx, parse(idSchema, id));
  await parent(ctx, actor, row.order_id);
  const wanted = revision === undefined ? row.revision : parse(versionSchema, Number(revision));
  const memory = await one<{ memory_json: string; error_code: string | null }>(ctx.env,
    "SELECT memory_json,error_code FROM jur_calculations WHERE profile_id=? AND deadline_id=? AND revision=?", ctx.profile, row.id, wanted);
  if (!memory) throw new ApiError(404, "not_found", "Memória não encontrada.");
  const calendar = await calendarRow(ctx, row.calendar_id);
  const current = JSON.parse(memory.memory_json);
  const calendar_changes: string[] = [];
  if (wanted > 1) {
    const previous = await one<{ memory_json: string }>(ctx.env, "SELECT memory_json FROM jur_calculations WHERE profile_id=? AND deadline_id=? AND revision=?", ctx.profile, row.id, wanted - 1);
    if (previous) {
      const before = JSON.parse(previous.memory_json).calendar as Calendar, after = current.calendar as Calendar;
      const labels = { name: "Nome", jurisdiction: "Âmbito", from: "Início da cobertura", to: "Fim da cobertura", timezone: "Fuso", weekend: "Dias da semana não úteis (domingo=0)" };
      for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) calendar_changes.push(`${labels[key]}: ${String(before[key])} → ${String(after[key])}.`);
      }
      for (const event of after.events) {
        const old = before.events.find(e => e.id === event.id);
        if (!old) calendar_changes.push(`Ocorrência adicionada: ${event.name} (${event.from} a ${event.to}).`);
        else if (JSON.stringify(old) !== JSON.stringify(event)) calendar_changes.push(`Ocorrência alterada: ${old.name} (${old.from} a ${old.to}) → ${event.name} (${event.from} a ${event.to}); confira efeitos e fontes nas duas memórias.`);
      }
      for (const event of before.events) if (!after.events.some(e => e.id === event.id)) calendar_changes.push(`Ocorrência removida: ${event.name} (${event.from} a ${event.to}).`);
    }
  }
  return projectChildForStaff(ctx, actor, { ...deadlineView(row), memory: current, memory_revision: wanted, calendar_changes,
    recalculation_pending: row.state === "open" && row.calendar_revision !== calendar.revision });
}

export async function changeDeadline(ctx: ModuleContext, actor: Actor, input: unknown, requestId: string, operation: "confirm" | "complete") {
  await staff(ctx, actor, true);
  const data = parse(z.strictObject({ id: idSchema, version: versionSchema, task_version: versionSchema,
    evidence: z.string().trim().min(1).max(1000).optional(), checked: z.literal(true).optional() }), input);
  if (operation === "confirm" && data.checked !== true) throw new ApiError(400, "review_required", "Registre a conferência do advogado.");
  if (operation === "complete" && !data.evidence) throw new ApiError(400, "evidence_required", "Informe a referência da providência realizada.");
  const row = await deadlineRow(ctx, data.id), order = await parent(ctx, actor, row.order_id, true);
  const calendar = await calendarRow(ctx, row.calendar_id), at = now();
  const key = await mutationKey(ctx, actor, `${operation}:${row.id}`, requestId);
  const statements: ChildStatement[] = [
    [`UPDATE os_tasks SET due_at=?,state=?,completed_at=?,updated=?,version=version+1,juridico_revision=juridico_revision+1
      WHERE profile_id=? AND order_id=? AND id=? AND version=? AND state='open' AND archived_at IS NULL
      AND EXISTS(SELECT 1 FROM jur_deadlines WHERE profile_id=? AND id=? AND revision=? ${operation === "confirm" ? "AND review<>'error' AND calendar_revision=?" : ""})`,
    [operation === "confirm" ? row.calculated_due_at : row.due_at, operation === "complete" ? "done" : "open", operation === "complete" ? at : null,
      at, ctx.profile, row.order_id, row.task_id, data.task_version, ctx.profile, row.id, data.version, ...(operation === "confirm" ? [calendar.revision] : [])]],
  ];
  // A revisão identifica a memória; confirmar/cumprir muda a versão da tarefa,
  // sem fabricar uma memória nova. CAS de ambas protege a tela antiga.
  if (operation === "confirm") {
    const stored = await one<{ memory_json: string }>(ctx.env, "SELECT memory_json FROM jur_calculations WHERE profile_id=? AND deadline_id=? AND revision=?", ctx.profile, row.id, row.revision);
    const memory = JSON.parse(stored!.memory_json) as Calculation;
    statements.push([`UPDATE jur_deadlines SET due_at=calculated_due_at,alert_at=?,review='confirmed',confirmed_by=?,confirmed_at=?,updated=? WHERE profile_id=? AND id=? AND revision=?`,
      [memory.alert_at ?? row.alert_at, actor.id, at, at, ctx.profile, row.id, data.version]], cas);
  } else statements.push(["UPDATE jur_deadlines SET completion_evidence=?,updated=? WHERE profile_id=? AND id=? AND revision=?", [data.evidence, at, ctx.profile, row.id, data.version]], cas);
  const ref = await commitChild(motorContext(ctx), actor, order, { entity_kind: "task", id: row.task_id, expected_version: data.task_version, mutation_key: key,
    changed_fields: [operation === "complete" ? "state" : "due_at"], statements, event: "os.task.updated" });
  return { id: row.id, task_id: row.task_id, task_version: ref.version };
}

/** Só chamado pelo agendador no Coordinator; não recebe ator do corpo HTTP. */
export async function recalculate(ctx: ModuleContext, row: DeadlineRow, at: number) {
  const calendar = await calendarRow(ctx, row.calendar_id);
  const actor = ctx.moduleActor({ reach: ["os"], label: "Recálculo jurídico" });
  const order = await parent(ctx, actor, row.order_id, true);
  const revision = row.revision + 1;
  let memory: Calculation | { calendar: Calendar; rule: Rule; warning: string }, error: string | null = null;
  try { memory = calculate(JSON.parse(calendar.definition_json), JSON.parse(row.rule_json)); }
  catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 422) throw cause;
    error = cause.code;
    memory = { calendar: JSON.parse(calendar.definition_json), rule: JSON.parse(row.rule_json), warning: WARNING };
  }
  const result = "due_at" in memory ? memory : null;
  // Conserva a data mais cedo até a revisão humana. Nunca prorroga silenciosamente.
  const due = result ? Math.min(row.due_at, result.due_at) : row.due_at;
  const statements: ChildStatement[] = [
    [`UPDATE os_tasks SET due_at=?,updated=?,version=version+1,juridico_revision=juridico_revision+1
      WHERE profile_id=? AND order_id=? AND id=? AND version=? AND state='open' AND archived_at IS NULL`,
    [due, at, ctx.profile, row.order_id, row.task_id, row.task_version]],
    [`UPDATE jur_deadlines SET revision=?,calendar_revision=?,previous_due_at=due_at,due_at=?,calculated_due_at=?,alert_at=?,review=?,error_code=?,confirmed_by=NULL,confirmed_at=NULL,updated=?
      WHERE profile_id=? AND id=? AND revision=?`,
    [revision, calendar.revision, due, result?.due_at ?? row.calculated_due_at, result ? Math.min(row.alert_at, result.alert_at) : row.alert_at,
      error ? "error" : "pending", error, at, ctx.profile, row.id, row.revision]], cas,
    memoryStatement(ctx, row.id, revision, calendar.revision, memory, actor.id, at, error),
    alertStatement(ctx, row, revision, error ? "calculation_error" : "recalculated", at),
  ];
  await commitChild(motorContext(ctx), actor, order, { entity_kind: "task", id: row.task_id, expected_version: row.task_version,
    mutation_key: `juridico:recalculate:${row.id}:${revision}:${calendar.revision}`, changed_fields: ["due_at"], statements, event: "os.task.updated" });
}
