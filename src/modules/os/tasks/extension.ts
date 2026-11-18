import type { OsExtension } from "../extensions";
import { runTaskDue } from "./reminders";
import { createTask, listTasks, updateTask } from "./store";

/** Somente I registra este descritor; importá-lo não registra rotas/agendadores.
 * Integração em os/extensions.ts: importar tasksExtension e incluir na lista.
 * definition.ts/events: os.task.created, os.task.updated, os.task.archived,
 * os.task.due. definition.ts/bot.deny: service-orders/:id/private-tasks
 * (os.private já está negado). A rota de conversa já consta em BOUND_ROUTES.
 * A entrada automática de etapa depende de M chamar createStageTasks;
 * F0 não tem gancho nem configuração de modelos de tarefa por etapa.
 */
export const tasksExtension: OsExtension = {
  id: "tasks",
  reads: [
    { path: "service-orders/my-tasks", handler: (ctx, actor, { query }) => listTasks(ctx, actor, null, query) },
    { path: "service-orders/conversation/:id/orders/:order_id/tasks", handler: (ctx, actor, { params, query }) => listTasks(ctx, actor, params.order_id, query, params.id) },
    { path: "service-orders/:id/tasks", handler: (ctx, actor, { params, query }) => listTasks(ctx, actor, params.id, query) },
  ],
  writes: [
    { method: "POST", path: "service-orders/:id/tasks", op: "os.task.create" },
    { method: "PATCH", path: "service-orders/:id/tasks/:task_id", op: "os.task.update" },
    { method: "POST", path: "service-orders/:id/tasks/:task_id/archive", op: "os.task.archive" },
    { method: "POST", path: "service-orders/:id/private-tasks", op: "os.private.task.create" },
    { method: "PATCH", path: "service-orders/:id/private-tasks/:task_id", op: "os.private.task.update" },
    { method: "POST", path: "service-orders/:id/private-tasks/:task_id/archive", op: "os.private.task.archive" },
  ],
  commands: [
    { op: "os.task.create", handler: (ctx, actor, data, { requestId }) => createTask(ctx, actor, data, requestId) },
    { op: "os.task.update", handler: (ctx, actor, data, { requestId }) => updateTask(ctx, actor, data, requestId) },
    { op: "os.task.archive", handler: (ctx, actor, data, { requestId }) => updateTask(ctx, actor, data, requestId, true) },
    { op: "os.private.task.create", handler: (ctx, actor, data, { requestId }) => createTask(ctx, actor, data, requestId, true) },
    { op: "os.private.task.update", handler: (ctx, actor, data, { requestId }) => updateTask(ctx, actor, data, requestId, false, true) },
    { op: "os.private.task.archive", handler: (ctx, actor, data, { requestId }) => updateTask(ctx, actor, data, requestId, true, true) },
  ],
  tools: [{
    name: "os_tarefas",
    description: "Consulta tarefas públicas da ordem do cliente da conversa autenticada. Apresente pendentes, concluídas e canceladas separadamente, usando state. Nunca informe um telefone como identidade.",
    input: {
      conversation_id: { type: "string" }, order_id: { type: "string" },
      state: { type: "string", enum: ["open", "done", "cancelled"] },
      cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["conversation_id", "order_id"],
    call: (args, profile) => ({
      path: `/profiles/${encodeURIComponent(profile)}/service-orders/conversation/${encodeURIComponent(args.conversation_id)}/orders/${encodeURIComponent(args.order_id)}/tasks`,
      query: Object.fromEntries(["state", "cursor", "limit"].filter((key) => args[key] !== undefined).map((key) => [key, args[key]])),
    }),
  }],
  runDue: runTaskDue,
};
