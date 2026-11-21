// Rotinas do agendador do ERP (docs/ERP-AGENDADOR.md): o registro em código e
// a tabela wb_routine, estrutura do Wabotia fora do oráculo (declarada em
// src/erp/schema/structural.ts, "agendador"). Só sintaxe TypeScript apagável:
// os testes do Node importam este arquivo direto.
import type { SqlDriver } from "../engine/driver.ts";
import type { Clock } from "../engine/time.ts";
import { saoPauloLocal, saoPauloParts } from "../engine/time.ts";
import { callRpc, inTransaction } from "../engine/registry.ts";
import type { ErpParts } from "../parts.ts";
import { contractsDailyStep } from "../domains/contracts/rpc.ts";
import { todaySaoPaulo } from "../engine/time.ts";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Estado das rotinas, uma linha por rotina declarada: a tabela é criada pelo
 * migrate (schema/migrate.ts, WB_ROUTINE_DDL), como a erp_meta, e de novo
 * pelo despachante (IF NOT EXISTS) para quem roda sem o migrate (testes).
 */
export { WB_ROUTINE_DDL } from "../schema/migrate.ts";

/** O que a rotina recebe em cada unidade (uma transação). */
export interface StepContext {
  db: SqlDriver;
  clock: Clock;
  /** Agora, em ms (o relógio da rodada). */
  now: number;
  parts: Readonly<ErpParts>;
}

export interface Routine {
  id: string;
  /** Módulo exigido; inclusive a Base precisa estar ligada. */
  block: string;
  /** Próximo horário depois de `after` (ms). Dias parado: roda uma vez e vai ao próximo horário. */
  next(after: number): number;
  /** Uma unidade de trabalho: "more" pede outra unidade na mesma rodada (ou na próxima, se o orçamento acabou). */
  step(ctx: StepContext): "done" | "more";
}

/** Próxima hora cheia depois de `after` (UTC e São Paulo diferem em horas inteiras). */
export const nextHour = (after: number) => Math.floor(after / HOUR_MS) * HOUR_MS + HOUR_MS;

const addDay = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);

/** Próximo "HH:MM" de São Paulo depois de `after` (horário de verão incluído, pelo Intl). */
export function nextLocalTime(after: number, hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  const seconds = h * 3600 + m * 60;
  let date = saoPauloParts(BigInt(after) * 1000n).date;
  for (let i = 0; i < 3; i++) {
    const at = Number(saoPauloLocal(date, seconds) / 1000n);
    if (at > after) return at;
    date = addDay(date, 1);
  }
  throw new Error(`Horário ${hm} sem próximo dia.`);
}

/** Dias que a retenção guarda das tarefas da plataforma terminadas. */
export const TASK_RETENTION_DAYS = 90;
/** Tarefas apagadas por unidade da retenção (cada uma leva as tentativas). */
export const RETENTION_BATCH = 100;

/**
 * Retenção das tarefas da plataforma: tarefa terminada (done/failed) há mais
 * de 90 dias, com as tentativas. O Fagoo as declara imutáveis e nunca apaga
 * (task_guard e attempt_guard recusam DELETE); no motor os gatilhos são
 * cumpridos em código (domains/preferences/platform.ts) e não há gatilho no
 * SQLite. Desvio declarado em structural.ts ("retencao-tarefas"). Tarefa de
 * exportação fica enquanto a exportação existir (FK de erp_platform__export,
 * linha imutável). command_receipt fica de fora.
 */
export function retentionStep(ctx: StepContext): "done" | "more" {
  const cutoff = (BigInt(ctx.now - TASK_RETENTION_DAYS * DAY_MS) * 1000n).toString();
  const ids = ctx.db
    .exec(
      `SELECT t.id FROM "erp_platform__task" t
       WHERE t.status IN ('done','failed') AND t.finished_at < ?
         AND NOT EXISTS (SELECT 1 FROM "erp_platform__export" e WHERE e.task_id = t.id)
       ORDER BY t.finished_at, t.id LIMIT ?`,
      cutoff,
      RETENTION_BATCH,
    )
    .rows.map((r) => String(r.id));
  if (!ids.length) return "done";
  const list = JSON.stringify(ids);
  ctx.db.exec(`DELETE FROM "erp_platform__task_attempt" WHERE task_id IN (SELECT value FROM json_each(?))`, list);
  ctx.db.exec(`DELETE FROM "erp_platform__task" WHERE id IN (SELECT value FROM json_each(?))`, list);
  return ids.length < RETENTION_BATCH ? "done" : "more";
}

/** Rotinas do primeiro corte. A fila de tarefas não é rotina: o despachante a drena a cada rodada. */
export const ROUTINES: readonly Routine[] = [
  {
    // erp_platform_schedule(now): a tarefa da hora (notificações) e a do dia
    // (limpeza das exportações), chaves em São Paulo como no Fagoo. Só a hora
    // corrente: horas perdidas não são recuperadas (o digest é acumulativo).
    id: "platform.schedule",
    block: "erp",
    next: nextHour,
    step(ctx) {
      callRpc(ctx.db, "erp_platform_schedule", { p_now: new Date(ctx.now).toISOString() }, ctx.clock, { parts: ctx.parts });
      return "done";
    },
  },
  {
    id: "retention",
    block: "erp",
    next: (after) => nextLocalTime(after, "03:10"),
    step: retentionStep,
  },
  {
    // Contratos de serviço (src/erp/domains/contracts/rpc.ts): a conta a
    // receber de cada período dos contratos ativos com a cobrança ligada (uma
    // só por período, mesmo se o alarme repetir), o aviso de renovação e o
    // de mês de reajuste. Só com a parte Contratos (e o Financeiro) ligada.
    id: "contracts.daily",
    block: "erp-contratos",
    next: (after) => nextLocalTime(after, "06:20"),
    step: (ctx) => inTransaction(ctx.db, (c) => contractsDailyStep(c, todaySaoPaulo(ctx.now)), ctx.clock, { parts: ctx.parts }) ? "more" : "done",
  },
];
