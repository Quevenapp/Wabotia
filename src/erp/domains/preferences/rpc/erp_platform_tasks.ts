// Fila de tarefas da plataforma: public.erp_platform_schedule,
// _task_claim, _task_progress, _task_finish e _tasks (migração 330).
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgLength } from "../../../engine/text.ts";
import { memberRole } from "../../access/public.ts";
import { bool, int, json, text, uuid } from "../args.ts";
import { MINUTE, enqueue, nowMicros, taskById, taskDto, taskHeld, tasksWhere, updateTask } from "../platform.ts";

const PURPOSES = ["notifications_generate", "company_export", "export_cleanup"];
const invalidTask = (): never => raise("22023", "erp_platform_task_input_invalid");

const localParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});
/** p_now at time zone 'America/Sao_Paulo': dia e hora locais. */
function local(ms: number) {
  const p = Object.fromEntries(localParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour };
}

/** public.erp_platform_schedule(p_now): as tarefas da hora (notificações) e do dia (limpeza das exportações). */
export function erpPlatformSchedule(ctx: RpcContext, a: RpcArgs) {
  const raw = text(a, "p_now");
  const ms = raw === null ? NaN : Date.parse(raw);
  const now = Date.now();
  if (raw === null || Number.isNaN(ms) || ms < now - 86_400_000 || ms > now + 86_400_000) raise("22023", "erp_platform_schedule_input_invalid");
  const l = local(ms);
  const t1 = enqueue(ctx, "notifications_generate", `notificacoes:${l.day}T${l.hour}`, null, { day: l.day }, 3);
  const t2 = enqueue(ctx, "export_cleanup", `limpeza-exportacoes:${l.day}`, null, {}, 3);
  return { scope: "platform_schedule", data_mode: "erp_native", tasks: [t1.id, t2.id] };
}

/** public.erp_platform_task_claim(p_lease, p_purposes): expira posses vencidas e toma a próxima tarefa. */
export function erpPlatformTaskClaim(ctx: RpcContext, a: RpcArgs) {
  const lease = uuid(a, "p_lease");
  const purposes = json(a, "p_purposes") as unknown[] | null;
  const db = ctx.db;
  if (
    lease === null ||
    (purposes !== null &&
      (jsonType(purposes) !== "array" ||
        purposes.length < 1 ||
        purposes.length > 3 ||
        purposes.some((x) => jsonType(x) !== "string" || !PURPOSES.includes(x as string))))
  )
    invalidTask();
  const now = nowMicros();
  // Posse vencida: a tentativa termina como expirada; com tentativas sobrando a tarefa volta à fila, senão falha.
  for (const t of tasksWhere(db, "WHERE status='running' AND lease_until<?", now.toString())) {
    const at = ctx.clock.next().toString();
    db.exec(
      `UPDATE "erp_platform__task_attempt" SET finished_at=?, outcome='expired', error_code='ERP_TASK_LEASE_EXPIRED'
       WHERE task_id=? AND attempt=? AND finished_at IS NULL`,
      at,
      t.id,
      t.attempts,
    );
    if (t.attempts >= t.max_attempts)
      updateTask(db, t.id, { status: "failed", lease_token: null, lease_until: null, finished_at: at, error_code: "ERP_TASK_LEASE_EXPIRED" });
    else updateTask(db, t.id, { status: "queued", lease_token: null, lease_until: null, next_attempt_at: at });
  }
  const due = tasksWhere(
    db,
    `WHERE status='queued' AND next_attempt_at<=? AND attempts<max_attempts
     ${purposes === null ? "" : "AND purpose IN (SELECT value FROM json_each(?))"} ORDER BY next_attempt_at, created_at, id LIMIT 1`,
    nowMicros().toString(),
    ...(purposes === null ? [] : [JSON.stringify(purposes)]),
  )[0];
  if (!due) return { scope: "platform_task", data_mode: "erp_native", task: null };
  const at = ctx.clock.next();
  updateTask(db, due.id, {
    status: "running",
    attempts: due.attempts + 1,
    lease_token: lease,
    lease_until: (at + 5n * MINUTE).toString(),
    started_at: due.started_at ?? at.toString(),
  });
  db.exec(
    'INSERT INTO "erp_platform__task_attempt"(task_id, attempt, lease_token, started_at) VALUES (?,?,?,?)',
    due.id,
    due.attempts + 1,
    lease,
    ctx.clock.next().toString(),
  );
  const t = taskById(db, due.id)!;
  return { scope: "platform_task", data_mode: "erp_native", task: { ...taskDto(db, t), payload: t.payload, state: t.progress } };
}

/** public.erp_platform_task_progress(p_task, p_lease, p_progress): grava o progresso e renova a posse. */
export function erpPlatformTaskProgress(ctx: RpcContext, a: RpcArgs) {
  const id = uuid(a, "p_task");
  const lease = uuid(a, "p_lease");
  const progress = json(a, "p_progress");
  const db = ctx.db;
  if (progress === null || jsonType(progress) !== "object" || pgLength(jsonbText(progress)) > 65536) invalidTask();
  const t = taskHeld(db, id, lease);
  updateTask(db, t.id, { progress: jsonbText(progress), lease_until: (ctx.clock.next() + 5n * MINUTE).toString() });
  return { scope: "platform_task", data_mode: "erp_native", task: taskDto(db, taskById(db, t.id)!) };
}

/** public.erp_platform_task_finish(p_task, p_lease, p_ok, p_result, p_error): conclui, agenda nova tentativa ou falha. */
export function erpPlatformTaskFinish(ctx: RpcContext, a: RpcArgs) {
  const id = uuid(a, "p_task");
  const lease = uuid(a, "p_lease");
  const ok = bool(a, "p_ok");
  const result = json(a, "p_result");
  const error = text(a, "p_error");
  const db = ctx.db;
  if (
    ok === null ||
    (ok && (result === null || jsonType(result) !== "object" || pgLength(jsonbText(result)) > 16384 || error !== null)) ||
    (!ok && (error === null || !/^[A-Za-z0-9_]{1,80}$/.test(error)))
  )
    invalidTask();
  const t = taskHeld(db, id, lease);
  const retry = !ok && t.attempts < t.max_attempts;
  const at = ctx.clock.next();
  db.exec(
    `UPDATE "erp_platform__task_attempt" SET finished_at=?, outcome=?, error_code=? WHERE task_id=? AND attempt=? AND finished_at IS NULL`,
    at.toString(),
    ok ? "done" : retry ? "retry" : "failed",
    error,
    t.id,
    t.attempts,
  );
  if (ok)
    updateTask(db, t.id, { status: "done", lease_token: null, lease_until: null, finished_at: at.toString(), result: jsonbText(result), error_code: null });
  else if (retry)
    updateTask(db, t.id, {
      status: "queued",
      lease_token: null,
      lease_until: null,
      error_code: error,
      next_attempt_at: (at + BigInt(Math.min(60, 2 ** t.attempts)) * MINUTE).toString(),
    });
  else updateTask(db, t.id, { status: "failed", lease_token: null, lease_until: null, finished_at: at.toString(), error_code: error });
  return { scope: "platform_task", data_mode: "erp_native", task: taskDto(db, taskById(db, t.id)!) };
}

/** public.erp_platform_tasks(p_user_id, p_limit): as tarefas (todas para o administrador; as próprias para os demais). */
export function erpPlatformTasks(ctx: RpcContext, a: RpcArgs) {
  const user = uuid(a, "p_user_id");
  const limit = int(a, "p_limit");
  const db = ctx.db;
  const role = memberRole(db, user);
  if (limit === null || limit < 1 || limit > 100) invalidTask();
  const items = tasksWhere(
    db,
    `${role === "admin" ? "" : "WHERE requested_by=?"} ORDER BY created_at DESC, id LIMIT ?`,
    ...(role === "admin" ? [] : [user]),
    limit,
  ).map((t) => taskDto(db, t));
  return { scope: "platform_tasks", data_mode: "erp_native", all: role === "admin", items };
}

registerRpc("erp_platform_schedule", erpPlatformSchedule);
registerRpc("erp_platform_task_claim", erpPlatformTaskClaim);
registerRpc("erp_platform_task_progress", erpPlatformTaskProgress);
registerRpc("erp_platform_task_finish", erpPlatformTaskFinish);
registerRpc("erp_platform_tasks", erpPlatformTasks);
