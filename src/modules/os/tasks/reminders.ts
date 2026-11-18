import { all, exec, one } from "../../../db";
import { ApiError, type Env } from "../../../types";
import { modulesApi, type ModuleContext } from "../../api";
import type { DueBudget, DueRequest, DueResult } from "../extensions";
import { resolveWorkType, type WorkOrderRow } from "../public";
import { projectChildForCustomer } from "../privacy";
import { stableKey, taskView, type TaskRow } from "./model";

/** Reserva conservadora por item, incluindo retries de leituras e serviços.
 * Webhooks acrescentam uma instrução por assinatura. O consumo real é medido
 * no DB, inclusive batches e chamadas que falham, sempre ANTES da execução.
 */
export const TASK_DUE_SQL_RESERVE = 32;
class BudgetExhausted extends Error {}
export function budgetedEnv(env: Env, budget: DueBudget): Env {
  const raw = new WeakMap<object, D1PreparedStatement>();
  const charge = (count: number) => {
    if (budget.remaining < count) throw new BudgetExhausted();
    budget.consume(count);
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        const value = Reflect.get(target, key);
        if (["first", "all", "run", "raw"].includes(String(key))) return (...args: unknown[]) => {
          charge(1);
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    raw.set(proxy, statement);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch") return (statements: D1PreparedStatement[]) => {
        charge(statements.length);
        return target.batch(statements.map((statement) => raw.get(statement) ?? statement));
      };
      // Este fluxo usa somente prepared statements; não permitir SQL sem medição.
      if (key === "exec") return () => { throw new Error("Use prepared statements no agendador de tarefas."); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB };
}

/** O terceiro argumento é uma costura local de teste; produção usa modulesApi.
 * Recriar o contexto é necessário: seus serviços fecham sobre env, não ctx.env.
 */
export async function runTaskDue(
  source: ModuleContext,
  request: DueRequest,
  context: typeof modulesApi = modulesApi,
): Promise<DueResult> {
  const { now, budget } = request;
  const limit = Math.min(10, Math.max(0, Math.floor(request.limit)));
  if (!Number.isFinite(limit) || !Number.isSafeInteger(now) || now < 0)
    throw new ApiError(400, "invalid_request", "Rodada de prazos inválida.");
  if (!limit || budget.remaining < TASK_DUE_SQL_RESERVE + 6) return { processed: 0, has_more: true };
  const ctx = context(budgetedEnv(source.env, budget), source.profile, "os");
  await ctx.requireEnabled();
  // Limite superior do fan-out; inclui até assinaturas sem permissão/evento.
  const subscribers = await one<{ total: number }>(ctx.env,
    "SELECT COUNT(*) total FROM webhook_subscriptions WHERE profile_id=? AND enabled=1", ctx.profile);
  const reserve = TASK_DUE_SQL_RESERVE + subscribers!.total;
  if (budget.remaining < reserve + 2) return { processed: 0, has_more: true };
  const rows = await all<TaskRow>(ctx.env,
    `SELECT t.* FROM os_tasks t JOIN os_orders o ON o.profile_id=t.profile_id AND o.id=t.order_id
     WHERE t.profile_id=? AND t.state='open' AND t.archived_at IS NULL
       AND t.notified_at IS NULL AND t.remind_at IS NOT NULL AND t.remind_at<=?
     ORDER BY t.remind_at,t.id LIMIT ?`, ctx.profile, now, limit + 1);
  let processed = 0, has_more = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    if (budget.remaining < reserve) return { processed, has_more: true };
    try {
      const parent = await one<WorkOrderRow>(ctx.env,
        "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, row.order_id);
      if (!parent) continue;
      const snapshot = parent.type_snapshot_json ? JSON.parse(parent.type_snapshot_json) : null;
      const type = await resolveWorkType(ctx, parent.type_id, snapshot);
      if (!type.features.tasks) continue;
      // Chave do vencimento, independente de edições de texto e falhas entre
      // fila e marcação. Voltar ao mesmo prazo não reenvia o mesmo lembrete.
      const key = `task-due:${await stableKey(ctx.profile, row.order_id, row.id, row.due_at, row.remind_at, row.audience, row.assignee)}`;
      if (row.audience === "customer") {
        const task = projectChildForCustomer(taskView(row));
        if (!task || !parent.conversation_id) { has_more = true; continue; }
        const c = await ctx.conversation(parent.conversation_id);
        const phone = ctx.verifiedPhone(c);
        if (c.profile_id !== ctx.profile || !phone || phone !== parent.phone) { has_more = true; continue; }
        await ctx.sendMessage(c, { text: `Lembrete: ${task.title}\nVencimento: ${new Date(task.due_at!).toISOString()}` }, { key, notification: true });
      } else {
        const assignee = row.assignee && (await ctx.grantees("technician")).some((p) => p.id === row.assignee) ? row.assignee : null;
        // Evento durável para a equipe também funciona sem conversa. Nunca
        // leva título/descrição: até tarefas sensíveis usam somente referência.
        await ctx.publish("os.task.due", row.id, {
          id: row.id, order_id: row.order_id, version: row.version, assignee,
          reason: row.assignee && !assignee ? "assignee_unavailable" : "due",
        }, { key });
      }
      const marked = await exec(ctx.env,
        `UPDATE os_tasks SET notified_at=? WHERE profile_id=? AND order_id=? AND id=?
         AND version=? AND state='open' AND archived_at IS NULL AND notified_at IS NULL`,
        now, ctx.profile, row.order_id, row.id, row.version);
      if (marked.meta.changes) processed++;
      else has_more = true;
    } catch (error) {
      // Sem texto de erro/valores de tarefa em logs; não perder nem marcar o aviso.
      has_more = true;
      if (error instanceof BudgetExhausted) break;
    }
  }
  return { processed, has_more };
}
