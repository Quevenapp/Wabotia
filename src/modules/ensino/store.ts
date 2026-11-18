import { all, one } from "../../db";
import { sha, hmac } from "../../security";
import { ApiError, now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { resolveWorkType } from "../os/public";
import { privateSchoolType, studentNameSql, classView, classroom, enrollment, forbidden, phoneHash, responsiblePerson, schoolOrder, staff, today, type ClassRow } from "./access";
import { canonical, date, id, invalid, number, object, overlaps, page, periods, rule, schedule, text, type Slot } from "./model";

export type SQL = [string, unknown[]];
export interface Mutation { id: string; class_id: string; version: number }
export async function mutationId(ctx: ModuleContext, actor: Actor, op: string, key: string) {
  return sha(JSON.stringify([ctx.profile, actor.id, op, text(key, "Idempotency-Key", 200)]));
}
export async function replayChange(ctx: ModuleContext, actor: Actor, op: string, key: string, data: unknown): Promise<Mutation | null> {
  const previous = await one<{ entity_id: string; class_id: string; version: number; request_hash: string }>(ctx.env,
    "SELECT entity_id,class_id,version,request_hash FROM ensino_audit WHERE profile_id=? AND id=?",
    ctx.profile, await mutationId(ctx, actor, op, key));
  if (!previous) return null;
  if (previous.request_hash !== await hmac(ctx.env.MASTER_KEY, canonical(data)))
    throw new ApiError(409, "idempotency_conflict", "Pedido repetido com conteúdo diferente.");
  return { id: previous.entity_id, class_id: previous.class_id, version: previous.version };
}
/** O CAS, a auditoria e os dados pertencem a um único batch D1 transacional. */
export async function change(ctx: ModuleContext, actor: Actor, op: string, key: string,
  data: Record<string, any>, c: ClassRow | null, entityId: string, statements: SQL[], create?: SQL): Promise<Mutation> {
  const mutation = await mutationId(ctx, actor, op, key);
  const requestHash = await hmac(ctx.env.MASTER_KEY, canonical(data));
  const previous = await replayChange(ctx, actor, op, key, data);
  if (previous) return previous;
  const classId = c?.id ?? entityId;
  const version = c ? number(data.version, "versão", 1, 2147483646) + 1 : 1;
  const first: SQL = create ?? ["UPDATE ensino_classes SET version=version+1 WHERE profile_id=? AND id=? AND version=?", [ctx.profile, classId, version - 1]];
  try {
    await ctx.env.DB.batch([first,
      [`INSERT INTO ensino_audit(profile_id,id,class_id,entity_id,operation,actor_id,version,request_hash,changed,created)
        VALUES(?,?,?,?,?,?,?,?,changes(),?)`, [ctx.profile, mutation, classId, entityId, op, actor.id, version, requestHash, now()]],
      ...statements,
    ].map(([sql, args]) => ctx.env.DB.prepare(sql as string).bind(...args as unknown[])));
  } catch (error) {
    const message = String(error);
    if (message.includes("ensino_capacity")) throw new ApiError(409, "class_full", "Não há vaga no intervalo informado.");
    if (/CHECK constraint|UNIQUE constraint/.test(message)) throw new ApiError(409, "version_conflict", "Os dados mudaram ou o registro já existe. Atualize a tela.");
    throw error;
  }
  return { id: entityId, class_id: classId, version };
}
export async function listClasses(ctx: ModuleContext, actor: Actor, query: Record<string, string>) {
  const secretary = await staff(ctx, actor);
  const p = page(query, `${ctx.profile}:${actor.id}:classes`);
  const rows = await all<ClassRow>(ctx.env,
    "SELECT * FROM ensino_classes WHERE profile_id=? AND (?=1 OR teacher_id=?) AND id>? ORDER BY id LIMIT ?",
    ctx.profile, +secretary, actor.id, p.after, p.limit + 1);
  return { data: rows.slice(0, p.limit).map(classView), next_cursor: rows.length > p.limit ? p.cursor(rows[p.limit - 1].id) : null, secretary };
}
export async function roster(ctx: ModuleContext, actor: Actor, classId: string) {
  const c = await classroom(ctx, actor, classId);
  const rows = await all(ctx.env,
    `SELECT e.id,e.order_id,e.start_date,e.end_date,e.ended,${studentNameSql} name FROM ensino_enrollments e
     JOIN os_orders o ON o.profile_id=e.profile_id AND o.id=e.order_id
     WHERE e.profile_id=? AND e.class_id=? ORDER BY e.id LIMIT 501`, ctx.profile, c.id);
  // Classe tem até 100 vagas; histórico de transferências é limitado e não truncado silenciosamente.
  if (rows.length > 500) throw new ApiError(409, "collection_limit", "Limite de enturmações desta turma atingido.");
  return { data: rows, version: c.version };
}
async function teacher(ctx: ModuleContext, value: unknown) {
  const teacherId = id(value);
  if (!(await ctx.grantees("professor")).some(p => p.id === teacherId)) invalid("professor ativo da área");
  return teacherId;
}
async function teacherSchedule(ctx: ModuleContext, teacherId: string, start: string, end: string, slots: Slot[], except = "") {
  const rows = await all<{ schedule_json: string }>(ctx.env,
    "SELECT schedule_json FROM ensino_classes WHERE profile_id=? AND teacher_id=? AND id<>? AND start_date<=? AND end_date>=? LIMIT 501",
    ctx.profile, teacherId, except, end, start);
  if (rows.length > 500 || rows.some(r => (JSON.parse(r.schedule_json) as Slot[]).some(a => slots.some(b => overlaps(a, b)))))
    throw new ApiError(409, "schedule_conflict", "O professor já tem turma neste horário. Confira a atribuição.");
}
export async function createClass(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  if (!(await staff(ctx, actor, true))) forbidden();
  const d = object(input, ["name", "school_year", "start_date", "end_date", "teacher_id", "type_id", "capacity", "schedule", "periods", "rule", "justified_counts"]);
  const start = date(d.start_date), end = date(d.end_date);
  if (end < start) invalid("vigência");
  const slots = schedule(d.schedule), ps = periods(d.periods, start, end), r = rule(d.rule);
  const type = await resolveWorkType(ctx, id(d.type_id));
  if (type.kind !== "custom" || !type.features.people || type.archived) invalid("tipo de matrícula com pessoas ligadas");
  if (!privateSchoolType(type))
    invalid("tipo escolar: extras sensíveis e mensagens sem dados do aluno");
  const teacherId = await teacher(ctx, d.teacher_id);
  const entityId = await mutationId(ctx, actor, "class.create", key);
  await teacherSchedule(ctx, teacherId, start, end, slots, entityId);
  if (typeof d.justified_counts !== "boolean") invalid("efeito das faltas justificadas");
  return change(ctx, actor, "class.create", key, d, null, entityId, [],
    [`INSERT INTO ensino_classes(profile_id,id,name,school_year,start_date,end_date,teacher_id,type_id,capacity,schedule_json,periods_json,rule_json,justified_counts,created)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ctx.profile, entityId, text(d.name, "turma"), text(d.school_year, "período letivo", 80),
      start, end, teacherId, type.id, number(d.capacity, "capacidade", 1, 100), JSON.stringify(slots), JSON.stringify(ps), JSON.stringify(r), +d.justified_counts, now()]]);
}
export async function updateClass(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "teacher_id", "schedule", "rule", "justified_counts"]);
  const c = await classroom(ctx, actor, d.id, true, true);
  const teacherId = d.teacher_id === undefined ? c.teacher_id : await teacher(ctx, d.teacher_id);
  const slots = d.schedule === undefined ? JSON.parse(c.schedule_json) : schedule(d.schedule);
  await teacherSchedule(ctx, teacherId, c.start_date, c.end_date, slots, c.id);
  if (d.justified_counts !== undefined && typeof d.justified_counts !== "boolean") invalid("efeito das faltas justificadas");
  return change(ctx, actor, "class.update", key, d, c, c.id, [[
    "UPDATE ensino_classes SET teacher_id=?,schedule_json=?,rule_json=?,justified_counts=? WHERE profile_id=? AND id=?",
    [teacherId, JSON.stringify(slots), d.rule === undefined ? c.rule_json : JSON.stringify(rule(d.rule)),
      d.justified_counts === undefined ? c.justified_counts : +d.justified_counts, ctx.profile, c.id],
  ]]);
}
export async function enroll(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "order_id", "start_date", "end_date"]);
  const c = await classroom(ctx, actor, d.id, true, true);
  const { order, name } = await schoolOrder(ctx, actor, d.order_id, c.type_id);
  if (!name?.trim()) invalid("nome do aluno na matrícula");
  const start = date(d.start_date), end = date(d.end_date);
  if (start < c.start_date || end > c.end_date || end < start) invalid("intervalo de enturmação");
  const existing = await all<{ schedule_json: string }>(ctx.env,
    `SELECT c.schedule_json FROM ensino_enrollments e JOIN ensino_classes c ON c.profile_id=e.profile_id AND c.id=e.class_id
     WHERE e.profile_id=? AND e.order_id=? AND e.class_id<>? AND e.start_date<=? AND e.end_date>=? LIMIT 101`,
    ctx.profile, order.row.id, c.id, end, start);
  if (existing.length > 100 || existing.some(r => (JSON.parse(r.schedule_json) as Slot[]).some(a => (JSON.parse(c.schedule_json) as Slot[]).some(b => overlaps(a, b)))))
    throw new ApiError(409, "schedule_conflict", "A matrícula já participa de uma turma neste horário.");
  const count = await one<{ n: number }>(ctx.env, "SELECT count(*) n FROM ensino_enrollments WHERE profile_id=? AND class_id=?", ctx.profile, c.id);
  if ((count?.n ?? 0) >= 500) throw new ApiError(409, "collection_limit", "Limite de enturmações da turma atingido.");
  const entityId = await mutationId(ctx, actor, "enrollment.create", key);
  return change(ctx, actor, "enrollment.create", key, d, c, entityId, [[
    "INSERT INTO ensino_enrollments(profile_id,id,class_id,order_id,start_date,end_date) VALUES(?,?,?,?,?,?)",
    [ctx.profile, entityId, c.id, order.row.id, start, end],
  ]]);
}
export async function endEnrollment(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "enrollment_id", "end_date"]);
  const c = await classroom(ctx, actor, d.id, true, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  const end = date(d.end_date);
  if (end < e.start_date || end > e.end_date) invalid("fim da enturmação");
  const later = await one(ctx.env,
    `SELECT 1 FROM ensino_attendance a JOIN ensino_lessons l ON l.profile_id=a.profile_id AND l.id=a.lesson_id
     WHERE a.profile_id=? AND a.enrollment_id=? AND l.date>? UNION ALL
     SELECT 1 FROM ensino_grades g JOIN ensino_assessments a ON a.profile_id=g.profile_id AND a.id=g.assessment_id
     WHERE g.profile_id=? AND g.enrollment_id=? AND a.date>? LIMIT 1`, ctx.profile, e.id, end, ctx.profile, e.id, end);
  if (later) throw new ApiError(409, "recorded_after_end", "Há lançamentos depois desta data. Preserve o histórico ao encerrar a participação.");
  return change(ctx, actor, "enrollment.end", key, d, c, e.id, [[
    "UPDATE ensino_enrollments SET end_date=?,ended=1 WHERE profile_id=? AND class_id=? AND id=?", [end, ctx.profile, c.id, e.id],
  ]]);
}
export async function grantGuardian(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "enrollment_id", "person_id", "valid_until", "identity_confirmed"]);
  const c = await classroom(ctx, actor, d.id, true, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  await schoolOrder(ctx, actor, e.order_id, c.type_id);
  if (d.identity_confirmed !== true) invalid("identidade e poderes pedagógicos conferidos pela secretaria");
  const p = await responsiblePerson(ctx, actor, e.order_id, d.person_id);
  const count = await one<{ n: number }>(ctx.env,
    "SELECT count(*) n FROM ensino_guardians WHERE profile_id=? AND order_id=? AND revoked_at IS NULL AND valid_until>=?",
    ctx.profile, e.order_id, today());
  if ((count?.n ?? 0) >= 10) throw new ApiError(409, "collection_limit", "Revogue autorizações antigas antes de cadastrar outro responsável (limite: 10).");
  const until = date(d.valid_until);
  if (until < today()) invalid("validade da autorização");
  const entityId = await mutationId(ctx, actor, "guardian.grant", key);
  return change(ctx, actor, "guardian.grant", key, d, c, entityId, [[
    `INSERT INTO ensino_guardians(profile_id,id,order_id,person_id,person_version,phone_hash,valid_until,verified_by,created)
     VALUES(?,?,?,?,?,?,?,?,?)`, [ctx.profile, entityId, e.order_id, p.id, p.version, await phoneHash(ctx, p.phone), until, actor.id, now()],
  ]]);
}
export async function revokeGuardian(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "enrollment_id", "guardian_id"]);
  const c = await classroom(ctx, actor, d.id, true, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  const guardian = await one(ctx.env, "SELECT id FROM ensino_guardians WHERE profile_id=? AND order_id=? AND id=?", ctx.profile, e.order_id, id(d.guardian_id));
  if (!guardian) invalid("autorização");
  return change(ctx, actor, "guardian.revoke", key, d, c, guardian.id, [[
    "UPDATE ensino_guardians SET revoked_at=? WHERE profile_id=? AND order_id=? AND id=?", [now(), ctx.profile, e.order_id, guardian.id],
  ]]);
}
export async function guardians(ctx: ModuleContext, actor: Actor, classId: string, enrollmentId: string) {
  const c = await classroom(ctx, actor, classId, false, true), e = await enrollment(ctx, c.id, enrollmentId);
  return { data: await all(ctx.env,
    `SELECT g.id,g.person_id,g.valid_until,g.revoked_at,p.name,p.version<>g.person_version OR p.archived_at IS NOT NULL stale
     FROM ensino_guardians g JOIN os_people p ON p.profile_id=g.profile_id AND p.order_id=g.order_id AND p.id=g.person_id
     WHERE g.profile_id=? AND g.order_id=? ORDER BY g.created DESC LIMIT 100`, ctx.profile, e.order_id) };
}
