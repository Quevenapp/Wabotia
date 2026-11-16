// Plataforma (erp_platform, migrações 330 a 334): a fila de tarefas
// agendadas (notificações, exportação da empresa, limpeza) com posse por
// lease, tentativas e histórico. Portado de erp_platform.enqueue,
// task_held, task_dto. Quem roda as tarefas (o alarme do objeto erp:) é da
// fase 3: aqui ficam os RPCs que ele chama (claim, progress, finish).
// Os gatilhos task_guard e attempt_guard são cumpridos aqui: as linhas só
// mudam por estes caminhos.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonbText } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { pgLeft } from "../../engine/text.ts";
import { jsonTimestamp } from "../../engine/time.ts";

export const MINUTE = 60_000_000n;
/** clock_timestamp() em microssegundos (comparação, sem mexer no relógio do motor). */
export const nowMicros = () => BigInt(Date.now()) * 1000n;
const ts = (v: unknown) => (v === null || v === undefined ? null : jsonTimestamp(String(v)));
const parse = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(String(v)));

export interface Task {
  id: string;
  purpose: string;
  operation_id: string;
  requested_by: string | null;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_until: bigint | null;
  next_attempt_at: bigint;
  progress: unknown;
  result: unknown;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const COLUMNS = `id, purpose, operation_id, requested_by, payload, status, CAST(attempts AS TEXT) attempts, CAST(max_attempts AS TEXT) max_attempts,
  lease_token, CAST(lease_until AS TEXT) lease_until, CAST(next_attempt_at AS TEXT) next_attempt_at, progress, result, error_code,
  CAST(created_at AS TEXT) created_at, CAST(started_at AS TEXT) started_at, CAST(finished_at AS TEXT) finished_at`;

function toTask(r: Record<string, unknown>): Task {
  return {
    id: String(r.id),
    purpose: String(r.purpose),
    operation_id: String(r.operation_id),
    requested_by: (r.requested_by as string | null) ?? null,
    payload: parse(r.payload),
    status: String(r.status),
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    lease_token: (r.lease_token as string | null) ?? null,
    lease_until: r.lease_until === null ? null : BigInt(String(r.lease_until)),
    next_attempt_at: BigInt(String(r.next_attempt_at)),
    progress: parse(r.progress),
    result: parse(r.result),
    error_code: (r.error_code as string | null) ?? null,
    created_at: String(r.created_at),
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
  };
}

export const taskById = (db: SqlDriver, id: string | null) => {
  const r = id === null ? null : one(db, `SELECT ${COLUMNS} FROM "erp_platform__task" WHERE id=?`, id);
  return r ? toTask(r) : null;
};

export const tasksWhere = (db: SqlDriver, where: string, ...params: unknown[]) =>
  db.exec(`SELECT ${COLUMNS} FROM "erp_platform__task" ${where}`, ...params).rows.map(toTask);

/** erp_platform.enqueue(p_purpose, p_operation, p_requested_by, p_payload, p_max_attempts): uma tarefa por operação. */
export function enqueue(ctx: RpcContext, purpose: string, operation: string, requestedBy: string | null, payload: unknown, maxAttempts: number): Task {
  const db = ctx.db;
  const existing = one(db, `SELECT id FROM "erp_platform__task" WHERE company_key='empresa' AND purpose=? AND operation_id=?`, purpose, operation);
  if (existing) return taskById(db, String(existing.id))!;
  const id = crypto.randomUUID();
  const now = ctx.clock.next().toString();
  db.exec(
    `INSERT INTO "erp_platform__task"(id, company_key, purpose, operation_id, requested_by, payload, status, attempts, max_attempts,
     next_attempt_at, progress, created_at) VALUES (?, 'empresa', ?, ?, ?, ?, 'queued', 0, ?, ?, '{}', ?)`,
    id,
    purpose,
    operation,
    requestedBy,
    jsonbText(payload ?? {}),
    maxAttempts,
    now,
    now,
  );
  return taskById(db, id)!;
}

/** erp_platform.task_held(p_task, p_lease): a tarefa em execução com a posse válida. */
export function taskHeld(db: SqlDriver, id: string | null, lease: string | null): Task {
  const t = taskById(db, id);
  if (!t) raise("P0002", "erp_platform_task_not_found");
  if (lease === null || t.status !== "running" || t.lease_token !== lease || t.lease_until === null || t.lease_until < nowMicros())
    raise("40001", "erp_platform_task_lease_lost");
  return t;
}

/** erp_platform.task_dto(t) */
export function taskDto(db: SqlDriver, t: Task) {
  const profile = t.requested_by === null ? null : one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', t.requested_by);
  const progress = t.progress as Record<string, unknown> | null;
  return {
    id: t.id,
    purpose: t.purpose,
    operation_id: t.operation_id,
    status: t.status,
    attempts: t.attempts,
    max_attempts: t.max_attempts,
    created_at: ts(t.created_at),
    started_at: ts(t.started_at),
    finished_at: ts(t.finished_at),
    next_attempt_at: t.status === "queued" ? jsonTimestamp(t.next_attempt_at.toString()) : null,
    result: t.result,
    error_code: t.error_code,
    progress: t.status === "running" && progress && typeof progress === "object" && !Array.isArray(progress) ? (progress.summary ?? null) : null,
    requested_by_name: profile ? pgLeft(String(profile.name), 120) : null,
    history: db
      .exec(
        `SELECT CAST(attempt AS TEXT) attempt, CAST(started_at AS TEXT) started_at, CAST(finished_at AS TEXT) finished_at, outcome, error_code
         FROM "erp_platform__task_attempt" WHERE task_id=? ORDER BY attempt`,
        t.id,
      )
      .rows.map((a) => ({
        attempt: Number(a.attempt),
        started_at: ts(a.started_at),
        finished_at: ts(a.finished_at),
        outcome: (a.outcome as string | null) ?? null,
        error_code: (a.error_code as string | null) ?? null,
      })),
  };
}

/** Atualiza colunas da tarefa (só pelos RPCs, como exige task_guard). */
export function updateTask(db: SqlDriver, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set);
  db.exec(`UPDATE "erp_platform__task" SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`, ...keys.map((k) => set[k]), id);
}
