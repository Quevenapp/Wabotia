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
import { ERP_PART_MODULES, ERP_MODULE_IDS, erpRequirement, erpRequirementMet, normalizeErpParts, type ErpParts, type ErpModuleId } from "../parts.ts";
import { erpTaskRequirement } from "../parts-requirements.ts";
import { MINUTE, taskById, taskDto, tasksWhere, updateTask, type Task } from "../domains/preferences/platform.ts";
import { HOUR_MS, ROUTINES, WB_ROUTINE_DDL, type Routine } from "./routines.ts";

/** Tarefa tomada da fila (o que erp_platform_task_claim devolve e o executor usa). */
export interface ClaimedTask {
  id: string;
  lease: string;
  purpose: string;
  payload: unknown;
  state: unknown;
  /** Estado anterior ao claim, para devolver sem tentativa operacional. */
  previous?: Task;
}

/**
 * Executor de uma finalidade da fila: roda na mesma transação que conclui a
 * tarefa (erp_platform_task_finish); o resultado é o p_result. Erro: a tarefa
 * volta à fila com backoff (ou falha, sem tentativas).
 */
export type TaskHandler = (db: SqlDriver, task: ClaimedTask, clock: Clock, parts: Readonly<ErpParts>) => Record<string, unknown>;

/**
 * Finalidades com executor. company_export e export_cleanup dependem do
 * armazenamento (/storage/v1, núcleo): ficam fora até lá, e as tarefas delas
 * esperam na fila sem acordar o alarme (stub em docs/ERP-AGENDADOR.md).
 */
export const TASK_HANDLERS: Readonly<Record<string, TaskHandler>> = {
  notifications_generate: (db, task, clock, parts) =>
    callRpc(db, "erp_platform_notifications_run", { p_task: task.id, p_lease: task.lease }, clock, { parts }) as Record<string, unknown>,
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
  /** Fotografia explícita. Produção também fornece readParts, consultando o KV. */
  parts?: Readonly<ErpParts>;
  readParts?: () => Promise<Readonly<ErpParts> | null>;
  /** Compatibilidade de chamada direta do motor; nunca usada pelo wake. */
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
  tasks: { id: string; purpose: string; outcome: "done" | "retry" | "lost" | "waiting" }[];
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

// A forma antiga é somente para chamadas diretas do motor (testes anteriores).
const legacyParts = (blocks: Readonly<Record<string, boolean>> = {}) => normalizeErpParts({
  ...Object.fromEntries(Object.entries(ERP_PART_MODULES).map(([key, id]) => [key, blocks[id] ?? !["erp-fiscal", "erp-cobranca", "erp-pdv", "erp-expedicao"].includes(id)])),
});
const enabled = (r: Routine, parts: Readonly<ErpParts>) =>
  (ERP_MODULE_IDS as readonly string[]).includes(r.block) && erpRequirementMet(parts, erpRequirement(r.block as ErpModuleId));

export const taskEligible = (purpose: string, payload: unknown, parts: Readonly<ErpParts>) => {
  const requirement = erpTaskRequirement(purpose, payload);
  return !!requirement && erpRequirementMet(parts, requirement);
};
const eligibleTasks = (db: SqlDriver, purposes: readonly string[], parts: Readonly<ErpParts>) =>
  !parts.customers || !purposes.length ? [] : tasksWhere(db,
    `WHERE purpose IN (SELECT value FROM json_each(?)) AND ((status='queued' AND attempts<max_attempts) OR status='running')
     ORDER BY next_attempt_at, created_at, id`, JSON.stringify(purposes))
    .filter(t => taskEligible(t.purpose, t.payload, parts));

/**
 * Claim local do executor: mesmo protocolo da fila, mas seleção E expiração
 * respeitam o requisito persistido. O RPC legado expira inclusive tarefas
 * fora de p_purposes; por isso não serve para uma fila parcialmente suspensa.
 */
export function claimEligibleTask(db: SqlDriver, lease: string, purposes: readonly string[], clock: Clock, parts: Readonly<ErpParts>): ClaimedTask | null {
  return db.transaction(() => {
    const now = BigInt(Date.now()) * 1000n;
    for (const t of eligibleTasks(db, purposes, parts)) {
      if (t.status !== "running" || t.lease_until === null || t.lease_until >= now) continue;
      const at = clock.next().toString();
      db.exec(`UPDATE "erp_platform__task_attempt" SET finished_at=?, outcome='expired', error_code='ERP_TASK_LEASE_EXPIRED'
        WHERE task_id=? AND attempt=? AND finished_at IS NULL`, at, t.id, t.attempts);
      if (t.attempts >= t.max_attempts)
        updateTask(db, t.id, { status: "failed", lease_token: null, lease_until: null, finished_at: at, error_code: "ERP_TASK_LEASE_EXPIRED" });
      else updateTask(db, t.id, { status: "queued", lease_token: null, lease_until: null, next_attempt_at: at });
    }
    const due = eligibleTasks(db, purposes, parts).find(t => t.status === "queued" && t.next_attempt_at <= BigInt(Date.now()) * 1000n);
    if (!due) return null;
    const at = clock.next();
    updateTask(db, due.id, { status: "running", attempts: due.attempts + 1, lease_token: lease,
      lease_until: (at + 5n * MINUTE).toString(), started_at: due.started_at ?? at.toString() });
    db.exec('INSERT INTO "erp_platform__task_attempt"(task_id, attempt, lease_token, started_at) VALUES (?,?,?,?)',
      due.id, due.attempts + 1, lease, clock.next().toString());
    return { id: due.id, purpose: due.purpose, lease, payload: due.payload, state: due.progress, previous: due };
  });
}

export function claimedTaskDto(db: SqlDriver, task: ClaimedTask) {
  return { ...taskDto(db, taskById(db, task.id)!), payload: task.payload, state: task.state };
}

/** Desfaz só a posse deste executor; não marca erro nem gasta tentativa. */
export function releaseBlockedTask(db: SqlDriver, task: ClaimedTask): void {
  db.transaction(() => {
    const current = taskById(db, task.id);
    if (!current || current.status !== "running" || current.lease_token !== task.lease || !task.previous) return;
    db.exec('DELETE FROM "erp_platform__task_attempt" WHERE task_id=? AND attempt=? AND lease_token=? AND finished_at IS NULL',
      task.id, current.attempts, task.lease);
    updateTask(db, task.id, { status: "queued", attempts: current.attempts - 1, lease_token: null, lease_until: null,
      started_at: task.previous.started_at, next_attempt_at: task.previous.next_attempt_at.toString(),
      progress: JSON.stringify(task.previous.progress ?? {}), error_code: task.previous.error_code });
  });
}

/** Uma rodada: rotinas vencidas, depois a fila de tarefas, até o orçamento. */
export async function runRound(db: SqlDriver, options: RoundOptions = {}): Promise<RoundReport> {
  const now = options.now ?? Date.now;
  const elapsed = options.elapsed ?? (() => performance.now());
  const yieldTurn = options.yieldTurn ?? realYield;
  let parts: Readonly<ErpParts> | null = options.parts ?? legacyParts(options.blocks);
  const refresh = async () => {
    if (options.readParts) {
      try { parts = await options.readParts(); } catch { parts = null; }
    }
    return !!parts?.customers;
  };
  const routines = options.routines ?? ROUTINES;
  const handlers = options.handlers ?? TASK_HANDLERS;
  const clock = options.clock ?? new Clock();
  const budget = options.budgetMs ?? WAKE_BUDGET_MS;
  const maxUnits = options.maxUnits ?? MAX_UNITS;
  const started = elapsed();
  const filePurposes = [...(options.filePurposes ?? [])];
  const report: RoundReport = { units: 0, more: false, nextWake: null, routines: [], tasks: [], fileDue: false };
  const spent = () => elapsed() - started >= budget || report.units >= maxUnits;

  if (!(await refresh())) return report;
  ensureRoutines(db, routines, now());

  // (a) Rotinas vencidas, na ordem do registro.
  for (const routine of routines) {
    if (!(await refresh())) break;
    if (spent()) {
      report.more = true;
      break;
    }
    const row = db.exec("SELECT CAST(next_run_us AS TEXT) next_run_us, failures FROM wb_routine WHERE id=?", routine.id).rows[0];
    const t0 = now();
    if (!row || ms(row.next_run_us)! > t0) continue;
    if (!enabled(routine, parts!)) {
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
      if (!(await refresh()) || !enabled(routine, parts!)) break;
      const at = now();
      try {
        const finished = db.transaction(() => {
          const r = routine.step({ db, clock, now: at, parts: parts! });
          if (r === "done")
            db.exec(
              `UPDATE wb_routine SET next_run_us=?, last_run_us=?, last_status='ok', last_error=NULL, last_ms=?,
               runs=runs+1, failures=0 WHERE id=?`,
              us(routine.next(at)),
              us(at),
              Math.round(elapsed() - w0),
              routine.id,
            );
          else
            db.exec("UPDATE wb_routine SET last_run_us=?, last_status='partial', last_ms=? WHERE id=?",
              us(at), Math.round(elapsed() - w0), routine.id);
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
      // A última unidade já gravou seu progresso antes do yield. Não escreve
      // depois de uma revalidação que pode ter encontrado a Base vencida.
      report.routines.push({ id: routine.id, status });
      report.more = !!parts?.customers && enabled(routine, parts);
    }
  }

  // (b) Fila: a seleção e o claim usam o mesmo requisito do próximo wake.
  const purposes = Object.keys(handlers);
  while (purposes.length && !report.more) {
    if (!(await refresh())) break;
    if (spent()) break;
    if (!dueTask(db, purposes, now(), parts!)) break;
    const task = claimEligibleTask(db, crypto.randomUUID(), purposes, clock, parts!);
    if (!task) break;
    report.units++;
    await yieldTurn();
    if (!(await refresh()) || !taskEligible(task.purpose, task.payload, parts!)) {
      releaseBlockedTask(db, task);
      report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "waiting" });
      continue;
    }
    try {
      db.transaction(() => {
        const result = handlers[task.purpose](db, task, clock, parts!);
        callRpc(db, "erp_platform_task_finish", { p_task: task.id, p_lease: task.lease, p_ok: true, p_result: result ?? {}, p_error: null }, clock, { parts: parts! });
      });
      report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "done" });
    } catch (error) {
      try {
        callRpc(db, "erp_platform_task_finish", { p_task: task.id, p_lease: task.lease, p_ok: false, p_result: null, p_error: taskErrorCode(error) }, clock, { parts: parts! });
        report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "retry" });
      } catch {
        report.tasks.push({ id: task.id, purpose: task.purpose, outcome: "lost" });
      }
    }
    report.units++;
    await yieldTurn();
  }

  if (!(await refresh())) return { ...report, more: false, nextWake: null, fileDue: false };
  report.fileDue = Boolean(dueTask(db, filePurposes, now(), parts!));
  // Orçamento esgotado só implica continuação se ainda houver trabalho elegível.
  report.more = routines.some(r => enabled(r, parts!) &&
    ms(db.exec("SELECT CAST(next_run_us AS TEXT) v FROM wb_routine WHERE id=?", r.id).rows[0]?.v)! <= now()) ||
    Boolean(dueTask(db, purposes, now(), parts!));
  report.nextWake = report.more ? now() + CONTINUE_AFTER_MS : nextWake(db, routines, parts!, [...purposes, ...filePurposes], now());
  return report;
}

const dueTask = (db: SqlDriver, purposes: readonly string[], at: number, parts: Readonly<ErpParts>) =>
  eligibleTasks(db, purposes, parts).some(t => t.status === "queued"
    ? t.next_attempt_at < BigInt(at + 1) * 1000n : t.lease_until !== null && t.lease_until < BigInt(at) * 1000n);

/** Só trabalho elegível agenda alarme; fila inteiramente bloqueada fica sem wake. */
export function nextWake(db: SqlDriver, routines: readonly Routine[], parts: Readonly<ErpParts>, purposes: string[], at: number): number | null {
  if (!parts.customers) return null;
  const ids = routines.filter(r => enabled(r, parts)).map(r => r.id);
  const candidates: unknown[] = ids.length ? [db.exec(
    "SELECT CAST(min(next_run_us) AS TEXT) v FROM wb_routine WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids),
  ).rows[0]?.v] : [];
  for (const task of eligibleTasks(db, purposes, parts))
    candidates.push(task.status === "queued" ? task.next_attempt_at : task.lease_until === null ? null : task.lease_until + 1n);
  let next: number | null = null;
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const v = Number((BigInt(String(c)) + 999n) / 1000n);
    next = next === null ? v : Math.min(next, v);
  }
  return next === null ? null : Math.max(Math.min(next, at + MAX_SLEEP_MS), at + 1);
}
