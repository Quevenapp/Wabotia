import { studentNameSql } from "./access";
import { all, one } from "../../db";
import { ApiError, now, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import { classroom, classView, enrollment, notFound, today, type ClassRow, type Enrollment } from "./access";
import { calculate, choice, date, frequency, id, invalid, number, object, page, text, time, type Mark } from "./model";
import { change, mutationId } from "./store";

const inRange = (day: string, start: string, end: string) => day >= start && day <= end;
export async function lessons(ctx: ModuleContext, actor: Actor, classId: string, query: Record<string, string>) {
  const c = await classroom(ctx, actor, classId), p = page(query, `${ctx.profile}:${actor.id}:${c.id}:lessons`);
  const rows = await all(ctx.env,
    "SELECT id,date,starts,ends,status FROM ensino_lessons WHERE profile_id=? AND class_id=? AND id>? ORDER BY id LIMIT ?",
    ctx.profile, c.id, p.after, p.limit + 1);
  return { data: rows.slice(0, p.limit), next_cursor: rows.length > p.limit ? p.cursor(rows[p.limit - 1].id) : null, version: c.version };
}
export async function createLesson(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "date", "starts", "ends", "status", "exception"]);
  const c = await classroom(ctx, actor, d.id, true), day = date(d.date), start = time(d.starts), end = time(d.ends);
  if (!inRange(day, c.start_date, c.end_date) || start >= end) invalid("horário da aula");
  if (d.exception !== undefined && typeof d.exception !== "boolean") invalid("aula extraordinária");
  if (!d.exception && !classView(c).schedule.some(s => s.day === new Date(`${day}T12:00:00Z`).getUTCDay() && s.start === start && s.end === end))
    invalid("horário previsto; marque aula extraordinária para reposição");
  const status = choice(d.status, "situação da aula", ["planned", "held", "cancelled"]);
  if (status === "held" && day > today()) invalid("aula realizada no futuro");
  const count = await one<{ n: number }>(ctx.env, "SELECT count(*) n FROM ensino_lessons WHERE profile_id=? AND class_id=?", ctx.profile, c.id);
  if ((count?.n ?? 0) >= 1000) throw new ApiError(409, "collection_limit", "Limite de aulas desta turma atingido.");
  const conflict = await one(ctx.env,
    "SELECT id FROM ensino_lessons WHERE profile_id=? AND class_id=? AND date=? AND starts<? AND ends>? AND status<>'cancelled'",
    ctx.profile, c.id, day, end, start);
  const entityId = await mutationId(ctx, actor, "lesson.create", key);
  if (conflict && conflict.id !== entityId && status !== "cancelled") throw new ApiError(409, "schedule_conflict", "Já existe aula neste horário.");
  return change(ctx, actor, "lesson.create", key, d, c, entityId, [[
    "INSERT INTO ensino_lessons(profile_id,id,class_id,date,starts,ends,status) VALUES(?,?,?,?,?,?,?)", [ctx.profile, entityId, c.id, day, start, end, status],
  ]]);
}
export async function updateLesson(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "lesson_id", "status", "reason"]);
  const c = await classroom(ctx, actor, d.id, true);
  const row = await one(ctx.env, "SELECT id,date,status,starts,ends FROM ensino_lessons WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(d.lesson_id));
  if (!row) notFound();
  choice(d.reason, "motivo", ["correction"]);
  const status = choice(d.status, "situação", ["planned", "held", "cancelled"]);
  if (status === "held" && row.date > today()) invalid("aula realizada no futuro");
  if (status !== "cancelled") {
    const conflict = await one(ctx.env,
      "SELECT 1 FROM ensino_lessons WHERE profile_id=? AND class_id=? AND id<>? AND date=? AND starts<? AND ends>? AND status<>'cancelled'",
      ctx.profile, c.id, row.id, row.date, row.ends, row.starts);
    if (conflict) throw new ApiError(409, "schedule_conflict", "Já existe aula neste horário.");
  }
  return change(ctx, actor, "lesson.update", key, d, c, row.id, [[
    "UPDATE ensino_lessons SET status=? WHERE profile_id=? AND class_id=? AND id=?", [status, ctx.profile, c.id, row.id],
  ]]);
}
export async function attendance(ctx: ModuleContext, actor: Actor, classId: string, lessonId: string) {
  const c = await classroom(ctx, actor, classId);
  const lesson = await one(ctx.env, "SELECT id,date,status FROM ensino_lessons WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(lessonId));
  if (!lesson) notFound();
  const data = await all(ctx.env,
    `SELECT e.id enrollment_id,${studentNameSql} name,a.status,a.revision FROM ensino_enrollments e
     JOIN os_orders o ON o.profile_id=e.profile_id AND o.id=e.order_id
     LEFT JOIN ensino_attendance a ON a.profile_id=e.profile_id AND a.enrollment_id=e.id AND a.lesson_id=?
       AND a.revision=(SELECT max(x.revision) FROM ensino_attendance x WHERE x.profile_id=a.profile_id AND x.lesson_id=a.lesson_id AND x.enrollment_id=a.enrollment_id)
     WHERE e.profile_id=? AND e.class_id=? AND e.start_date<=? AND e.end_date>=? ORDER BY e.id LIMIT 100`,
    lesson.id, ctx.profile, c.id, lesson.date, lesson.date);
  return { data, lesson, version: c.version };
}
export async function recordAttendance(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "lesson_id", "enrollment_id", "status", "reason"]);
  const c = await classroom(ctx, actor, d.id, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  const l = await one(ctx.env, "SELECT id,date,status FROM ensino_lessons WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(d.lesson_id));
  if (!l) notFound();
  if (l.status !== "held" || !inRange(l.date, e.start_date, e.end_date)) invalid("aula realizada durante a enturmação");
  const previous = await one<{ revision: number }>(ctx.env, "SELECT max(revision) revision FROM ensino_attendance WHERE profile_id=? AND lesson_id=? AND enrollment_id=?", ctx.profile, l.id, e.id);
  const revision = (previous?.revision ?? 0) + 1;
  const reason = choice(d.reason, "motivo", revision > 1 ? ["correction"] : ["initial"]);
  const status = choice(d.status, "frequência", ["present", "absent", "justified"]);
  return change(ctx, actor, "attendance.record", key, d, c, e.id, [[
    "INSERT INTO ensino_attendance(profile_id,class_id,lesson_id,enrollment_id,revision,status,reason,actor_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
    [ctx.profile, c.id, l.id, e.id, revision, status, reason, actor.id, now()],
  ]]);
}
export async function assessments(ctx: ModuleContext, actor: Actor, classId: string, query: Record<string, string>) {
  const c = await classroom(ctx, actor, classId), p = page(query, `${ctx.profile}:${actor.id}:${c.id}:assessments`);
  const rows = await all(ctx.env,
    "SELECT id,period_id,subject,title,date,max_score,weight,kind FROM ensino_assessments WHERE profile_id=? AND class_id=? AND id>? ORDER BY id LIMIT ?",
    ctx.profile, c.id, p.after, p.limit + 1);
  return { data: rows.slice(0, p.limit), next_cursor: rows.length > p.limit ? p.cursor(rows[p.limit - 1].id) : null, version: c.version };
}
export async function createAssessment(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "period_id", "subject", "title", "date", "max_score", "weight", "kind"]);
  const c = await classroom(ctx, actor, d.id, true), view = classView(c);
  const period = view.periods.find(p => p.id === id(d.period_id));
  const day = date(d.date);
  if (!period || !inRange(day, period.start, period.end)) invalid("período da avaliação");
  const kind = choice(d.kind, "avaliação", ["regular", "recovery"]);
  if (kind === "recovery" && view.rule.recovery.mode === "none") invalid("recuperação desligada na regra da turma");
  const count = await one<{ n: number }>(ctx.env,
    "SELECT count(*) n FROM ensino_assessments WHERE profile_id=? AND class_id=? AND period_id=?", ctx.profile, c.id, period.id);
  if ((count?.n ?? 0) >= 100) throw new ApiError(409, "collection_limit", "Limite de 100 avaliações por período.");
  const entityId = await mutationId(ctx, actor, "assessment.create", key);
  return change(ctx, actor, "assessment.create", key, d, c, entityId, [[
    "INSERT INTO ensino_assessments(profile_id,id,class_id,period_id,subject,title,date,max_score,weight,kind) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [ctx.profile, entityId, c.id, period.id, text(d.subject, "disciplina", 80), text(d.title, "avaliação", 80), day,
      number(d.max_score, "escala", 0.01, 10000, 2), number(d.weight, "peso", 0.01, 100, 2), kind],
  ]]);
}
export async function grades(ctx: ModuleContext, actor: Actor, classId: string, assessmentId: string) {
  const c = await classroom(ctx, actor, classId);
  const a = await one(ctx.env, "SELECT id,date FROM ensino_assessments WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(assessmentId));
  if (!a) notFound();
  return { version: c.version, data: await all(ctx.env,
    `SELECT e.id enrollment_id,${studentNameSql} name,g.status,g.score,g.revision FROM ensino_enrollments e
     JOIN os_orders o ON o.profile_id=e.profile_id AND o.id=e.order_id
     LEFT JOIN ensino_grades g ON g.profile_id=e.profile_id AND g.enrollment_id=e.id AND g.assessment_id=?
       AND g.revision=(SELECT max(x.revision) FROM ensino_grades x WHERE x.profile_id=g.profile_id AND x.assessment_id=g.assessment_id AND x.enrollment_id=g.enrollment_id)
     WHERE e.profile_id=? AND e.class_id=? AND e.start_date<=? AND e.end_date>=? ORDER BY e.id LIMIT 100`, a.id, ctx.profile, c.id, a.date, a.date) };
}
export async function recordGrade(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "assessment_id", "enrollment_id", "status", "score", "reason"]);
  const c = await classroom(ctx, actor, d.id, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  const a = await one(ctx.env, "SELECT id,date,max_score FROM ensino_assessments WHERE profile_id=? AND class_id=? AND id=?", ctx.profile, c.id, id(d.assessment_id));
  if (!a) notFound();
  if (!inRange(a.date, e.start_date, e.end_date) || a.date > today()) invalid("avaliação durante a enturmação, não futura");
  const status = choice(d.status, "resultado", ["graded", "absent", "exempt"]);
  const score = status === "graded" ? number(d.score, "nota", 0, a.max_score, 2) : null;
  if (status !== "graded" && d.score !== null && d.score !== undefined) invalid("nota de avaliação ausente ou dispensada");
  const previous = await one<{ revision: number }>(ctx.env, "SELECT max(revision) revision FROM ensino_grades WHERE profile_id=? AND assessment_id=? AND enrollment_id=?", ctx.profile, a.id, e.id);
  const revision = (previous?.revision ?? 0) + 1;
  const reason = choice(d.reason, "motivo", revision > 1 ? ["correction"] : ["initial"]);
  return change(ctx, actor, "grade.record", key, d, c, e.id, [[
    "INSERT INTO ensino_grades(profile_id,class_id,assessment_id,enrollment_id,revision,score,status,reason,actor_id,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [ctx.profile, c.id, a.id, e.id, revision, score, status, reason, actor.id, now()],
  ]]);
}
export async function studentFrequency(ctx: ModuleContext, c: ClassRow, e: Enrollment, start = e.start_date, end = e.end_date) {
  const rows = await all<{ id: string; date: string; starts: string; ends: string; status: string; attendance: string | null }>(ctx.env,
    `SELECT l.id,l.date,l.starts,l.ends,l.status,a.status attendance FROM ensino_lessons l
     LEFT JOIN ensino_attendance a ON a.profile_id=l.profile_id AND a.lesson_id=l.id AND a.enrollment_id=?
       AND a.revision=(SELECT max(x.revision) FROM ensino_attendance x WHERE x.profile_id=a.profile_id AND x.lesson_id=a.lesson_id AND x.enrollment_id=a.enrollment_id)
     WHERE l.profile_id=? AND l.class_id=? AND l.date>=? AND l.date<=? AND l.date>=? AND l.date<=? ORDER BY l.date,l.starts LIMIT 1000`,
    e.id, ctx.profile, c.id, start, end, e.start_date, e.end_date);
  return { ...frequency(rows, !!c.justified_counts), lessons: rows };
}
export async function buildReport(ctx: ModuleContext, c: ClassRow, e: Enrollment, periodId: string) {
  const view = classView(c), period = view.periods.find(p => p.id === periodId);
  if (!period) notFound();
  const marks = await all<Mark & { subject: string; revision: number | null }>(ctx.env,
    `SELECT a.id,a.title,a.subject,a.max_score,a.weight,a.kind,g.score,coalesce(g.status,'pending') status,g.revision
     FROM ensino_assessments a LEFT JOIN ensino_grades g ON g.profile_id=a.profile_id AND g.assessment_id=a.id AND g.enrollment_id=?
       AND g.revision=(SELECT max(x.revision) FROM ensino_grades x WHERE x.profile_id=g.profile_id AND x.assessment_id=g.assessment_id AND x.enrollment_id=g.enrollment_id)
     WHERE a.profile_id=? AND a.class_id=? AND a.period_id=? AND a.date>=? AND a.date<=? ORDER BY a.date,a.id LIMIT 100`,
    e.id, ctx.profile, c.id, period.id, e.start_date, e.end_date);
  const subjects = [...new Set(marks.map(m => m.subject))].map(subject => ({ subject, ...calculate(marks.filter(m => m.subject === subject), view.rule) }));
  const student = await one<{ name: string }>(ctx.env, `SELECT ${studentNameSql} name FROM os_orders o WHERE o.profile_id=? AND o.id=?`, ctx.profile, e.order_id);
  return { name: student?.name ?? "", class_name: c.name, school_year: c.school_year, period,
    subjects, frequency: await studentFrequency(ctx, c, e, period.start, period.end), rule_version: c.version };
}
export async function previewReport(ctx: ModuleContext, actor: Actor, classId: string, enrollmentId: string, periodId: string) {
  const c = await classroom(ctx, actor, classId), e = await enrollment(ctx, c.id, enrollmentId);
  return { ...(await buildReport(ctx, c, e, periodId)), version: c.version };
}
export async function publishReport(ctx: ModuleContext, actor: Actor, input: unknown, key: string) {
  const d = object(input, ["id", "version", "enrollment_id", "period_id"]);
  const c = await classroom(ctx, actor, d.id, true, true), e = await enrollment(ctx, c.id, d.enrollment_id);
  const report = await buildReport(ctx, c, e, id(d.period_id));
  if (report.period.end >= today()) throw new ApiError(409, "period_open", "Publique após o fim do período avaliativo.");
  if (!report.subjects.length || report.subjects.some(s => s.final === null) || report.frequency.pending)
    throw new ApiError(409, "pending_results", "Conclua as notas e chamadas antes de publicar o boletim.");
  const previous = await one<{ revision: number }>(ctx.env,
    "SELECT max(revision) revision FROM ensino_reports WHERE profile_id=? AND enrollment_id=? AND period_id=?", ctx.profile, e.id, report.period.id);
  const entityId = await mutationId(ctx, actor, "report.publish", key);
  return change(ctx, actor, "report.publish", key, d, c, entityId, [[
    "INSERT INTO ensino_reports(profile_id,id,class_id,enrollment_id,period_id,revision,class_version,snapshot_json,published_by,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [ctx.profile, entityId, c.id, e.id, report.period.id, (previous?.revision ?? 0) + 1, c.version, JSON.stringify(report), actor.id, now()],
  ]]);
}
