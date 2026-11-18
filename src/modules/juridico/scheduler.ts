import { all, exec } from "../../db";
import { ApiError, type Actor, type Env } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import type { DueBudget, DueRequest, DueResult } from "../os/extensions";
import { staff } from "./access";
import { alertStatement, deadlineSelect, recalculate, type DeadlineRow } from "./store";

/** Mede cada instrução, inclusive SQL dentro dos serviços do motor e retries. */
export function meteredEnv(env: Env, budget: DueBudget): Env {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const charge = (n: number) => {
    if (n > budget.remaining) throw new ApiError(429, "juridico_budget", "Rodada será continuada.");
    budget.consume(n);
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
      const value = Reflect.get(target, key);
      if (["all", "first", "run", "raw"].includes(String(key))) return (...args: unknown[]) => { charge(1); return value.apply(target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement); return proxy;
  };
  return { ...env, DB: new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (key === "batch") return (statements: D1PreparedStatement[]) => { charge(statements.length); return target.batch(statements.map(s => originals.get(s) ?? s)); };
    if (key === "exec") return () => { throw new Error("Use instruções preparadas no agendador jurídico."); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

/** Costura de contexto para testes; produção sempre usa modulesApi. */
export async function runJuridicoDue(source: ModuleContext, request: DueRequest, context: typeof modulesApi = modulesApi): Promise<DueResult> {
  const { now, budget } = request, limit = Math.min(10, Math.floor(request.limit));
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(limit) || limit < 0) throw new ApiError(400, "invalid_request", "Rodada inválida.");
  if (!limit || budget.remaining < 50) return { processed: 0, has_more: true };
  const ctx = context(meteredEnv(source.env, budget), source.profile, "juridico");
  if (!(await ctx.enabled())) return { processed: 0, has_more: false };
  let processed = 0, has_more = false;
  try {
    const changes = await all<DeadlineRow>(ctx.env, `${deadlineSelect}
      JOIN jur_calendars c ON c.profile_id=d.profile_id AND c.id=d.calendar_id
      WHERE d.profile_id=? AND d.calendar_revision<>c.revision AND t.state='open' AND t.archived_at IS NULL
      ORDER BY d.updated,d.id LIMIT ?`, ctx.profile, limit + 1);
    has_more = changes.length > limit;
    for (const row of changes.slice(0, limit)) {
      if (budget.remaining < 45) return { processed, has_more: true };
      try { await recalculate(ctx, row, now); processed++; }
      catch { has_more = true; } // Sem conteúdo ou exceção sensível em logs.
    }
    if (processed >= limit || budget.remaining < 8) return { processed, has_more: true };
    const due = await all<DeadlineRow>(ctx.env, `${deadlineSelect}
      WHERE d.profile_id=? AND t.state='open' AND t.archived_at IS NULL AND d.alert_at<=?
      AND NOT EXISTS(SELECT 1 FROM jur_alerts a WHERE a.profile_id=d.profile_id AND a.deadline_id=d.id AND a.revision=d.revision AND a.kind='fatal')
      ORDER BY d.alert_at,d.id LIMIT ?`, ctx.profile, now, limit - processed + 1);
    const available = limit - processed;
    has_more ||= due.length > available;
    for (const row of due.slice(0, available)) {
      if (budget.remaining < 2) return { processed, has_more: true };
      const [sql, args] = alertStatement(ctx, row, row.revision, "fatal", now);
      await exec(ctx.env, sql, ...args); // A própria inserção é a entrega durável na caixa interna.
      processed++;
    }
    return { processed, has_more };
  } catch { return { processed, has_more: true }; }
}

export async function scheduleJuridico(ctx: ModuleContext, tick: { now: number }) {
  let remaining = 200;
  const budget: DueBudget = { get remaining() { return remaining; }, consume(n) { remaining -= n; } };
  const result = await runJuridicoDue(ctx, { now: tick.now, budget, limit: 10 });
  if (result.has_more) await ctx.wake();
}

export async function listAlerts(ctx: ModuleContext, actor: Actor) {
  await staff(ctx, actor);
  const rows = await all<{ id: string; deadline_id: string; kind: string; revision: number; created: number }>(ctx.env,
    `SELECT a.id,a.deadline_id,a.kind,a.revision,a.created FROM jur_alerts a
     JOIN jur_deadlines d ON d.profile_id=a.profile_id AND d.id=a.deadline_id
     JOIN os_tasks t ON t.profile_id=d.profile_id AND t.order_id=d.order_id AND t.id=d.task_id
     WHERE a.profile_id=? AND a.recipient=? AND a.acknowledged_at IS NULL
       AND t.state='open' AND a.revision=d.revision ORDER BY a.created,a.id LIMIT 100`, ctx.profile, actor.id);
  return { data: rows.map(row => ({ ...row, message: row.kind === "fatal"
    ? "Prazo fatal próximo ou vencido no controle. Abra a memória e confira a providência com o advogado."
    : row.kind === "recalculated" ? "Calendário alterado: confira o cálculo anterior e o novo antes de confirmar."
      : "Não foi possível recalcular com o calendário atual. A data anterior foi mantida; confira a cobertura e as regras." })) };
}
export async function acknowledge(ctx: ModuleContext, actor: Actor, id: string) {
  await staff(ctx, actor, true);
  const result = await exec(ctx.env, "UPDATE jur_alerts SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE profile_id=? AND id=? AND recipient=?", Date.now(), ctx.profile, id, actor.id);
  if (!result.meta.changes) throw new ApiError(404, "not_found", "Aviso não encontrado.");
  return { id };
}
