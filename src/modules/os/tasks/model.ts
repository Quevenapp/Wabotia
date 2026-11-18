import { ApiError, requireValue, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { CreateTaskRequest, Task, TaskState } from "../contracts";
import { mayReadSensitive, projectChildForBot, projectChildForCustomer, projectChildForStaff } from "../privacy";

export type TaskRow = Omit<Task, "client_visible" | "sensitive"> & {
  profile_id: string;
  client_visible: number;
  sensitive: number;
};
export const taskFields = ["title", "description", "assignee", "audience", "due_at", "remind_at", "client_visible", "sensitive"] as const;
export const taskStates: TaskState[] = ["open", "done", "cancelled"];

export function invalidTask(field: string): never {
  throw new ApiError(400, "invalid_task", `Tarefa inválida: ${field}.`);
}
export function body(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "Corpo inválido.");
  const data = value as Record<string, unknown>;
  for (const field of Object.keys(data)) if (!allowed.includes(field)) invalidTask(field);
  return data;
}
export function identifier(value: unknown): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 256, "Identificador inválido.");
  return value;
}
export function version(value: unknown): number {
  requireValue(Number.isSafeInteger(value) && Number(value) > 0, "Versão inválida.");
  return value as number;
}
function text(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== "string") invalidTask(field);
  const normalized = value.trim();
  if ((required && !normalized) || [...normalized].length > max || normalized.includes("\0")) invalidTask(field);
  return normalized;
}
export function instant(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8640000000000000) invalidTask(field);
  return value as number;
}
export function taskInput(data: Record<string, unknown>): Required<CreateTaskRequest> {
  if (typeof data.client_visible !== "boolean") invalidTask("client_visible");
  if (typeof data.sensitive !== "boolean") invalidTask("sensitive");
  if (data.audience !== "staff" && data.audience !== "customer") invalidTask("audience");
  const assignee = data.assignee == null ? null : text(data.assignee, "assignee", 256, true);
  const due = instant(data.due_at, "due_at"), remind = instant(data.remind_at, "remind_at");
  if (remind !== null && (due === null || remind > due)) invalidTask("remind_at");
  if (data.sensitive && data.client_visible) invalidTask("client_visible");
  if (data.audience === "customer" && (!data.client_visible || data.sensitive)) invalidTask("audience");
  return {
    title: text(data.title, "title", 160, true),
    description: text("description" in data ? data.description : "", "description", 4000),
    assignee, audience: data.audience, due_at: due, remind_at: remind,
    client_visible: data.client_visible, sensitive: data.sensitive,
  };
}
/** Monta uma lista explícita de campos: nunca espalhar a linha SQL na resposta. */
export function taskView(row: TaskRow): Task {
  return {
    id: row.id, order_id: row.order_id, version: row.version,
    title: row.title, description: row.description, assignee: row.assignee,
    audience: row.audience, due_at: row.due_at, remind_at: row.remind_at,
    state: row.state, notified_at: row.notified_at, completed_at: row.completed_at,
    client_visible: !!row.client_visible, sensitive: !!row.sensitive,
    created_by: row.created_by, created: row.created, updated: row.updated,
    archived_at: row.archived_at,
  };
}
export const botActor = (actor: Actor) => actor.kind !== "user" || !!actor.via || !!actor.module || actor.id.startsWith("bot:");
export async function visibility(ctx: ModuleContext, actor: Actor, customer = false) {
  if (customer || botActor(actor)) return "public" as const;
  return (await mayReadSensitive(ctx, actor)) ? "private" as const : "staff" as const;
}
export async function projectTask(ctx: ModuleContext, actor: Actor, row: TaskRow, customer = false) {
  const dto = taskView(row);
  const projected = customer ? projectChildForCustomer(dto) : botActor(actor)
    ? projectChildForBot(dto) : await projectChildForStaff(ctx, actor, dto);
  if (projected && (customer || botActor(actor))) {
    // O responsável interno e o controle de envio não pertencem à visão pública.
    return { ...projected, assignee: null, notified_at: null };
  }
  return projected;
}
export async function checkAssignee(ctx: ModuleContext, assignee: string | null) {
  if (assignee && !(await ctx.grantees("technician")).some((person) => person.id === assignee)) invalidTask("assignee");
}
export async function checkSensitive(ctx: ModuleContext, actor: Actor, sensitive: boolean) {
  if (sensitive && !(await mayReadSensitive(ctx, actor)))
    throw new ApiError(403, "sensitive_forbidden", "Acesso sensível não autorizado.");
}
export async function stableKey(...parts: unknown[]) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
