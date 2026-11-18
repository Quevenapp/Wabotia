import { one } from "../../../db";
import { ApiError, requireValue, type Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { CreateTaskRequest, MutationRef } from "../contracts";
import { checkAssignee, checkSensitive, instant, stableKey, taskInput } from "./model";
import { createTask, taskOrder } from "./store";

/** Contrato LOCAL: F0 não contém campo de modelos nem gancho de entrada de etapa.
 * M deve fornecer modelos imutáveis da entrada confirmada, nunca dados HTTP.
 * Os deslocamentos são milissegundos corridos, não prazos forenses.
 */
export interface StageTaskTemplate extends Omit<CreateTaskRequest, "due_at" | "remind_at"> {
  id: string;
  stage: string;
  due_after_ms: number | null;
  remind_before_ms: number | null;
}
export interface StageTaskEntry {
  stage: string;
  version: number;
  entered_at: number;
  templates: readonly StageTaskTemplate[];
}
/** Chamar depois de confirmar a etapa, inclusive ao recuperar o mesmo comando.
 * Cada filho passa por commitChild; IDs estáveis recuperam falha entre filhos.
 */
export async function createStageTasks(ctx: ModuleContext, actor: Actor, orderId: string, entry: StageTaskEntry): Promise<MutationRef[]> {
  const order = await taskOrder(ctx, actor, orderId, true);
  requireValue(Number.isSafeInteger(entry.version) && entry.version > 0, "Versão de entrada inválida.");
  requireValue(instant(entry.entered_at, "entered_at") !== null, "Data de entrada inválida.");
  if ((order.row.stage ?? order.row.status) !== entry.stage || (order.row.row_version ?? 1) !== entry.version)
    throw new ApiError(409, "version_conflict", "A etapa da ordem mudou.");
  requireValue(Array.isArray(entry.templates) && entry.templates.length <= 500, "Modelos de tarefas inválidos.");
  const ids = new Set<string>();
  const tasks = [];
  for (const template of entry.templates) {
    requireValue(typeof template.id === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(template.id) && !ids.has(template.id), "ID de modelo de tarefa inválido.");
    ids.add(template.id);
    requireValue(order.type.stages.some((stage) => stage.id === template.stage), "Etapa de modelo inválida.");
    const delay = instant(template.due_after_ms, "due_after_ms");
    const before = instant(template.remind_before_ms, "remind_before_ms");
    requireValue(before === null || (delay !== null && before <= delay), "Antecedência de lembrete inválida.");
    const values = taskInput({ ...template,
      due_at: delay === null ? null : entry.entered_at + delay,
      remind_at: before === null || delay === null ? null : entry.entered_at + delay - before,
    });
    // A estrutura de todos os modelos é validada; permissões e destinatários
    // só são exigidos para as tarefas que esta entrada realmente vai criar.
    if (template.stage !== entry.stage) continue;
    await checkSensitive(ctx, actor, values.sensitive);
    await checkAssignee(ctx, values.assignee);
    if (values.audience === "customer" && !(await ctx.mayNotify(actor, order.row.conversation_id)))
      throw new ApiError(403, "forbidden", "Ator não pode programar aviso ao cliente.");
    tasks.push({ values,
      key: `os.task.stage:${await stableKey(ctx.profile, orderId, entry.stage, entry.version, template.id)}`,
    });
  }
  // Preflight de todos os modelos antes da primeira escrita. O limite também
  // é conferido no INSERT de cada filho e conta arquivados.
  const count = await one<{ total: number }>(ctx.env, "SELECT COUNT(*) total FROM os_tasks WHERE profile_id=? AND order_id=?", ctx.profile, orderId);
  let missing = 0;
  for (const task of tasks) {
    const id = `task_${await stableKey(task.key)}`;
    if (!(await one(ctx.env, "SELECT id FROM os_tasks WHERE profile_id=? AND order_id=? AND id=?", ctx.profile, orderId, id))) missing++;
  }
  if (count!.total + missing > 500) throw new ApiError(409, "collection_limit", "Limite de 500 tarefas por ordem.");
  const results = [];
  for (const task of tasks) results.push(await createTask(ctx, actor, { id: orderId, ...task.values }, task.key, task.values.sensitive, task.key));
  return results;
}
