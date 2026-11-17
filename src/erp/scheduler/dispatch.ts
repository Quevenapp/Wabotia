// Despachante do agendador do ERP (docs/ERP-AGENDADOR.md): uma rodada por
// acordada do alarme da instância erp:<área>. Roda as rotinas vencidas e
// drena a fila de tarefas da plataforma (erp_platform__task), uma unidade por
// transação, cedendo a vez entre as unidades (um await de verdade): uma
// leitura do ERP que chega no meio da rodada é atendida sem esperar o fim.
// Orçamento por acordada: 2 s de relógio; a sobra continua 1 s depois.
// Só sintaxe TypeScript apagável (os testes do Node importam direto).
import "../domains/index.ts";
import type { SqlDriver } from "../engine/driver.ts";
import { ErpError } from "../engine/errors.ts";
import { callRpc } from "../engine/registry.ts";
import { Clock } from "../engine/time.ts";
import { HOUR_MS, ROUTINES, WB_ROUTINE_DDL, type Routine } from "./routines.ts";

/** Tarefa tomada da fila (o que erp_platform_task_claim devolve e o executor usa). */
export interface ClaimedTask {
  id: string;
  lease: string;
  purpose: string;
  payload: unknown;
  state: unknown;
}

/**
 * Executor de uma finalidade da fila: roda na mesma transação que conclui a
 * tarefa (erp_platform_task_finish); o resultado é o p_result. Erro: a tarefa
 * volta à fila com backoff (ou falha, sem tentativas).
 */
export type TaskHandler = (db: SqlDriver, task: ClaimedTask, clock: Clock) => Record<string, unknown>;

/**
 * Finalidades com executor. company_export e export_cleanup dependem do
 * armazenamento (/storage/v1, núcleo): ficam fora até lá, e as tarefas delas
 * esperam na fila sem acordar o alarme (stub em docs/ERP-AGENDADOR.md).
 */
export const TASK_HANDLERS: Readonly<Record<string, TaskHandler>> = {
  notifications_generate: (db, task, clock) =>
    callRpc(db, "erp_platform_notifications_run", { p_task: task.id, p_lease: task.lease }, clock) as Record<string, unknown>,
};

export const WAKE_BUDGET_MS = 2_000;
export const CONTINUE_AFTER_MS = 1_000;
/** Teto de unidades por acordada (rede de segurança, além do relógio). */
export const MAX_UNITS = 200;
/** Teto da espera entre acordadas: o alarme nunca dorme mais que isso. */
export const MAX_SLEEP_MS = HOUR_MS;

export interface RoundOptions {
  /** Agora em ms (relógio da rodada). Padrão: Date.now. */
  now?: () => number;
  /** Relógio de parede para o orçamento. Padrão: performance.now. */
  elapsed?: () => number;
  /** Cede a vez entre unidades. Padrão: setTimeout 0. */
  yieldTurn?: () => Promise<void>;
  /** Blocos do ERP ligados (vindos do wake); "erp" vale sempre. */
  blocks?: Readonly<Record<string, boolean>>;
  routines?: readonly Routine[];
  handlers?: Readonly<Record<string, TaskHandler>>;
  /**
   * Finalidades que rodam fora da rodada síncrona (com arquivo:
   * scheduler/files.ts). A rodada não as toma; elas contam para a próxima
   * acordada e para `fileDue`.
   */
  filePurposes?: readonly string[];
  clock?: Clock;
  budgetMs?: number;
  maxUnits?: number;
}

export interface RoundReport {
  units: number;
  /** Sobrou trabalho (orçamento ou teto de unidades): continua em 1 s. */
  more: boolean;
  /** Quando acordar de novo (ms); null só se nada estiver previsto (não ocorre com rotinas). */
  nextWake: number | null;
  routines: { id: string; status: "ok" | "partial" | "error" | "skipped"; error?: string }[];
  tasks: { id: string; purpose: string; outcome: "done" | "retry" | "lost" }[];
  /** Há tarefa com arquivo vencida (ou posse dela vencida) para o executor de arquivos. */
  fileDue: boolean;
}

const realYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const us = (ms: number) => (BigInt(ms) * 1000n).toString();
const ms = (micros: unknown) => (micros === null || micros === undefined ? null : Number(BigInt(String(micros)) / 1000n));

/** Código do erro para task_attempt.error_code (^[A-Za-z0-9_]{1,80}$). */
export function taskErrorCode(error: unknown): string {
  const raw = error instanceof ErpError ? error.message || error.code : error instanceof Error ? error.name : "unknown";
  const code = ("ERP_TASK_" + raw.toUpperCase().replace(/[^A-Z0-9_]+/g, "_")).slice(0, 80);
  return code.replace(/_+$/, "") || "ERP_TASK_ERROR";
}

const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 500);

/** Garante a wb_routine e uma linha por rotina (vencida na hora: a primeira rodada roda tudo uma vez). */
export function ensureRoutines(db: SqlDriver, routines: readonly Routine[], now: number) {
  db.exec(WB_ROUTINE_DDL);
  for (const r of routines) db.exec("INSERT INTO wb_routine(id, next_run_us) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", r.id, us(now));
}

const enabled = (r: Routine, blocks: Readonly<Record<string, boolean>>) => r.block === "erp" || blocks[r.block] === true;

/** Uma rodada: rotinas vencidas, depois a fila de tarefas, até o orçamento. */
export async function runRound(db: SqlDriver, options: RoundOptions = {}): Promise<RoundReport> {
  const now = options.now ?? Date.now;
  const elapsed = options.elapsed ?? (() => performance.now());
  const yieldTurn = options.yieldTurn ?? realYield;
  const blocks = options.blocks ?? {};
  const routines = options.routines ?? ROUTINES;
  const handlers = options.handlers ?? TASK_HANDLERS;
  const clock = options.clock ?? new Clock();
  const budget = options.budgetMs ?? WAKE_BUDGET_MS;
  const maxUnits = options.maxUnits ?? MAX_UNITS;
  const started = elapsed();
  const filePurposes = [...(options.filePurposes ?? [])];
  const report: RoundReport = { units: 0, more: false, nextWake: null, routines: [], tasks: [], fileDue: false };
  const spent = () => elapsed() - started >= budget || report.units >= maxUnits;

  ensureRoutines(db, routines, now());

  // (a) Rotinas vencidas, na ordem do registro.
  for (const routine of routines) {
    if (spent()) {
      report.more = true;
      break;
    }
    const row = db.exec("SELECT CAST(next_run_us AS TEXT) next_run_us, failures FROM wb_routine WHERE id=?", routine.id).rows[0];
    const t0 = now();
    if (!row || ms(row.next_run_us)! > t0) continue;
    if (!enabled(routine, blocks)) {
      db.exec(
        "UPDATE wb_routine SET next_run_us=?, last_run_us=?, last_status='skipped', last_error=NULL, last_ms=0 WHERE id=?",
        us(routine.next(t0)),
        us(t0),
        routine.id,
      );
      report.routines.push({ id: routine.id, status: "skipped" });
      continue;
    }
    const w0 = elapsed();
    let status: "ok" | "partial" | "error" = "partial";
    for (;;) {
      const at = now();
      try {
        const finished = db.transaction(() => {
          const r = routine.step({ db, clock, now: at });
          if (r === "done")
            db.exec(
              `UPDATE wb_routine SET next_run_us=?, last_run_us=?, last_status='ok', last_error=NULL, last_ms=?,
               runs=runs+1, failures=0 WHERE id=?`,
              us(routine.next(at)),
              us(at),
              Math.round(elapsed() - w0),
              routine.id,
            );
          return r === "done";
        });
        report.units++;
        if (finished) {
          status = "ok";
          break;
        }
      } catch (error) {
        // A unidade foi desfeita; o já feito antes dela fica. Nova tentativa
        // com backoff min(1 h, 1 min·2^n), sem passar do próximo horário.
        report.units++;
        const failures = Number(row.failures) + 1;
        const retry = Math.min(at + Math.min(HOUR_MS, 60_000 * 2 ** Math.min(failures, 6)), routine.next(at));
        db.exec(
          `UPDATE wb_routine SET next_run_us=?, last_run_us=?, last_status='error', last_error=?, last_ms=?,
           runs=runs+1, failures=? WHERE id=?`,
          us(retry),
          us(at),
          message(error),
          Math.round(elapsed() - w0),
          failures,
          routine.id,
        );
        report.routines.push({ id: routine.id, status: "error", error: message(error) });
        status = "error";
        break;
      } finally {
        await yieldTurn();
      }
      if (spent()) break;
    }
    if (status === "ok") report.routines.push({ id: routine.id, status });
    if (status === "partial") {
      // Fica vencida (next_run_us não mudou): a próxima acordada continua.
      db.exec("UPDATE wb_routine SET last_run_us=?, last_status='partial', last_ms=? WHERE id=?", us(now()), Math.round(elapsed() - w0), routine.id);
      report.routines.push({ id: routine.id, status });
      report.more = true;
    }
  }

  // (b) Fila de tarefas: uma por vez (tomar; executar e concluir numa transação).
  const purposes = Object.keys(handlers);
  while (purposes.length && !report.more) {
    if (spent()) {
      report.more = Boolean(dueTask(db, purposes, now()));
      break;
    }
    const lease = crypto.randomUUID();
    const claimed = (callRpc(db, "erp_platform_task_claim", { p_lease: lease, p_purposes: purposes }, clock) as { task: Record<string, unknown> | null }).task;
    report.units++;
    if (!claimed) break;
    await yieldTurn();
    const task: ClaimedTask = { id: String(claimed.id), lease, purpose: String(claimed.purpose), payload: claimed.payload, state: claimed.state };
    try {
      db.transaction(() => {
        const result = handlers[task.purpose](db, task, clock);
        callRpc(db, "erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: true, p_result: result ?? {}, p_error: null }, clock);
      });
      report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "done" });
    } catch (error) {
      try {
        callRpc(db, "erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: false, p_result: null, p_error: taskErrorCode(error) }, clock);
        report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "retry" });
      } catch {
        // Posse perdida (venceu durante a execução): o próximo claim a expira.
        report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "lost" });
      }
    }
    report.units++;
    await yieldTurn();
  }

  report.fileDue = filePurposes.length > 0 && Boolean(dueTask(db, filePurposes, now()));
  report.nextWake = report.more
    ? now() + CONTINUE_AFTER_MS
    : nextWake(db, routines, blocks, [...purposes, ...filePurposes], now());
  return report;
}

/** Há tarefa vencida de uma finalidade com executor? */
function dueTask(db: SqlDriver, purposes: string[], at: number) {
  return db.exec(
    `SELECT 1 x FROM "erp_platform__task" WHERE purpose IN (SELECT value FROM json_each(?))
     AND ((status='queued' AND attempts<max_attempts AND next_attempt_at<=?) OR (status='running' AND lease_until<?)) LIMIT 1`,
    JSON.stringify(purposes),
    us(at),
    us(at),
  ).rows[0];
}

/**
 * Próxima acordada: a rotina ligada mais cedo, a próxima tentativa de tarefa
 * com executor e a posse que vence (para expirá-la); nunca mais de 1 h.
 */
export function nextWake(
  db: SqlDriver,
  routines: readonly Routine[],
  blocks: Readonly<Record<string, boolean>>,
  purposes: string[],
  at: number,
): number {
  let next = at + MAX_SLEEP_MS;
  // Rotina de bloco desligado também conta: no horário dela o despachante
  // confere os blocos de novo (skipped) e a empurra para o próximo horário.
  const candidates = [
    db.exec(
      "SELECT CAST(min(next_run_us) AS TEXT) v FROM wb_routine WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(routines.map((r) => r.id)),
    ).rows[0]?.v,
  ];
  if (purposes.length)
    candidates.push(
      db.exec(
        `SELECT CAST(min(CASE WHEN status='queued' THEN next_attempt_at ELSE lease_until END) AS TEXT) v FROM "erp_platform__task"
         WHERE purpose IN (SELECT value FROM json_each(?)) AND ((status='queued' AND attempts<max_attempts) OR status='running')`,
        JSON.stringify(purposes),
      ).rows[0]?.v,
    );
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    // Arredonda para cima: o relógio do motor é monotônico em µs (pode estar
    // alguns µs à frente do ms), e acordar antes do vencimento é rodada vazia.
    const v = Number((BigInt(String(c)) + 999n) / 1000n);
    if (v < next) next = v;
  }
  return Math.max(next, at + 1);
}
