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
const dueDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
const dueTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", timeStyle: "short" });
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
  // A última instrução fica reservada ao checkpoint, mesmo se um serviço
  // esgotar o orçamento durante o processamento de uma tarefa.
  const checkpointEnv = budgetedEnv(source.env, budget);
  const ctx = context(budgetedEnv(source.env, {
    get remaining() { return Math.max(0, budget.remaining - 1); },
    consume(count) { budget.consume(count); },
  }), source.profile, "os");
  await ctx.requireEnabled();
  // Limite superior do fan-out; inclui até assinaturas sem permissão/evento.
  const subscribers = await one<{ total: number }>(ctx.env,
    "SELECT COUNT(*) total FROM webhook_subscriptions WHERE profile_id=? AND enabled=1", ctx.profile);
  const reserve = TASK_DUE_SQL_RESERVE + subscribers!.total;
  if (budget.remaining < reserve + 4) return { processed: 0, has_more: true };
  // Uma linha por área no D1, só com a chave de paginação. Avança também
  // sobre impedidos; ao terminar a volta, eles voltam a ser candidatos.
  const checkpoint = await one<{ remind_at: number | null; task_id: string | null }>(ctx.env,
    "SELECT remind_at,task_id FROM os_task_reminder_cursors WHERE profile_id=?", ctx.profile);
  const saved = checkpoint?.remind_at != null && checkpoint.task_id != null
    ? [checkpoint.remind_at, checkpoint.task_id] as const : null;
  const rows = await all<TaskRow>(ctx.env,
    `SELECT t.* FROM os_tasks t JOIN os_orders o ON o.profile_id=t.profile_id AND o.id=t.order_id
     WHERE t.profile_id=? AND t.state='open' AND t.archived_at IS NULL
       AND t.notified_at IS NULL AND t.remind_at IS NOT NULL AND t.remind_at<=?
       ${saved ? "AND (t.remind_at>? OR (t.remind_at=? AND t.id>?))" : ""}
     ORDER BY t.remind_at,t.id LIMIT ?`, ctx.profile, now, ...(saved ? [saved[0], saved[0], saved[1]] : []), limit + 1);
  let processed = 0, has_more = rows.length > limit || !!saved;
  let examined = 0;
  for (const row of rows.slice(0, limit)) {
    if (budget.remaining < reserve + 1) { has_more = true; break; }
    examined++;
    try {
      const parent = await one<WorkOrderRow>(ctx.env,
        "SELECT * FROM os_orders WHERE profile_id=? AND id=?", ctx.profile, row.order_id);
      if (!parent) { has_more = true; continue; }
      const snapshot = parent.type_snapshot_json ? JSON.parse(parent.type_snapshot_json) : null;
      const type = await resolveWorkType(ctx, parent.type_id, snapshot);
      if (!type.features.tasks) { has_more = true; continue; }
      // Chave do vencimento, independente de edições de texto e falhas entre
      // fila e marcação. Voltar ao mesmo prazo não reenvia o mesmo lembrete.
      // A conversa já integra a chave de sendMessage. O responsável interno
      // só é destinatário dos avisos à equipe.
      const key = `task-due:${await stableKey(ctx.profile, row.order_id, row.id, row.due_at, row.remind_at, row.audience, row.audience === "staff" ? row.assignee : null)}`;
      if (row.audience === "customer") {
        if (!projectChildForCustomer(taskView(row)) || !parent.conversation_id) { has_more = true; continue; }
        const c = await ctx.conversation(parent.conversation_id);
        const phone = ctx.verifiedPhone(c);
        if (c.profile_id !== ctx.profile || !phone || phone !== parent.phone) { has_more = true; continue; }
        const task = projectChildForCustomer(taskView(row));
        if (!task) { has_more = true; continue; }
        // A rodada não bloqueia o Coordinator: um comando pode reclassificar,
        // encerrar ou arquivar a tarefa entre a leitura e o envio. Toda escrita
        // na tarefa incrementa a versão; a reserva só vale para a versão lida,
        // ainda aberta, pública e destinada ao cliente. Depois dela, o texto
        // enviado é o dessa versão, que era público no instante da reserva.
        const claimed = await exec(ctx.env,
          `UPDATE os_tasks SET notified_at=? WHERE profile_id=? AND order_id=? AND id=?
           AND version=? AND state='open' AND archived_at IS NULL AND notified_at IS NULL
           AND audience='customer' AND client_visible=1 AND sensitive=0`,
          now, ctx.profile, row.order_id, row.id, row.version);
        if (!claimed.meta.changes) { has_more = true; continue; }
        try {
          await ctx.sendMessage(c, { text: `Lembrete: ${task.title}\nVencimento: ${dueDate.format(task.due_at!)} às ${dueTime.format(task.due_at!)} (Brasília)` }, { key, notification: true });
        } catch (error) {
          // Falhou antes da fila: desfaz só a própria reserva. A chave de envio
          // é estável; uma inclusão já feita não se repete na próxima rodada.
          await exec(ctx.env,
            `UPDATE os_tasks SET notified_at=NULL WHERE profile_id=? AND order_id=? AND id=?
             AND version=? AND notified_at=?`,
            ctx.profile, row.order_id, row.id, row.version, now).catch(() => undefined);
          throw error;
        }
        processed++;
        continue;
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
  if (examined || saved) {
    const last = rows[examined - 1];
    const next = examined < rows.length ? (last ? [last.remind_at, last.id] : saved) : null;
    await exec(checkpointEnv,
      `INSERT INTO os_task_reminder_cursors(profile_id,remind_at,task_id) VALUES(?,?,?)
       ON CONFLICT(profile_id) DO UPDATE SET remind_at=excluded.remind_at,task_id=excluded.task_id`,
      ctx.profile, next?.[0] ?? null, next?.[1] ?? null);
  }
  return { processed, has_more };
}
