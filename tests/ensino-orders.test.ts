import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { uid, type Actor } from "../src/types";
import { perform } from "../src/service";
import { ensinoModule } from "../src/modules/ensino/definition";
import { classroom, today } from "../src/modules/ensino/access";
import { createClass, enroll, listClasses, updateClass, roster, endEnrollment } from "../src/modules/ensino/store";
import { createLesson, recordAttendance, createAssessment, recordGrade, previewReport, publishReport, updateLesson } from "../src/modules/ensino/diary";
import { api, bearer } from "./service-center-fixture";
import { installEnsinoTest, schoolFixture } from "./ensino-fixture";

const cleanup = installEnsinoTest();
afterAll(cleanup);
describe("Ensino: criação, isolamento e papéis", () => {
  it("é desligado por padrão e exige o motor; nega a área quando OS desliga", async () => {
    expect(ensinoModule).toMatchObject({ default_enabled: false, requires: ["os"] });
    const f = await schoolFixture();
    await perform(env, f.admin, f.profile, "module.set", { id: "os", enabled: false, cascade: true }, uid());
    await expect(listClasses(f.ctx, f.secretary, {})).rejects.toMatchObject({ code: "module_disabled" });
  });
  it("cria, repete o mesmo pedido e não duplica turma", async () => {
    const f = await schoolFixture(), input = { ...f.input, name: "Turma B", schedule: [{ day: 2, start: "08:00", end: "09:00" }] }, key = uid();
    const first = await createClass(f.ctx, f.secretary, input, key);
    expect(await createClass(f.ctx, f.secretary, input, key)).toEqual(first);
    expect((await listClasses(f.ctx, f.secretary, {})).data).toHaveLength(2);
    expect(Object.keys(first).sort()).toEqual(["class_id", "id", "version"]);
  });
  it("secretaria vê tudo; professor só próprias turmas; administrador sem papel não ganha sigilo", async () => {
    const f = await schoolFixture();
    expect((await listClasses(f.ctx, f.professor, {})).data.map(c => c.id)).toEqual([f.classroom.id]);
    await expect(listClasses(f.ctx, f.admin, {})).rejects.toMatchObject({ status: 403 });
    await expect(createClass(f.ctx, f.professor, f.input, uid())).rejects.toMatchObject({ status: 403 });
    await expect(enroll(f.ctx, f.professor, { id: f.classroom.id }, uid())).rejects.toMatchObject({ status: 403 });
    const other: Actor = { ...f.secretary, access: ["ensino:professor"] };
    expect((await listClasses(f.ctx, other, {})).data).toEqual([]);
    await expect(roster(f.ctx, other, f.classroom.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateClass(f.ctx, f.professor, { id: f.classroom.id, version: 2 }, uid())).rejects.toMatchObject({ status: 403 });
  });
  it("nega IDs, cursores e matrículas de outra área, inclusive HTTP", async () => {
    const f = await schoolFixture(), foreign = await schoolFixture();
    await expect(classroom(f.ctx, f.secretary, foreign.classroom.id)).rejects.toMatchObject({ status: 404 });
    await expect(enroll(f.ctx, f.secretary, { id: f.classroom.id, version: 2, order_id: foreign.order.id, start_date: f.input.start_date, end_date: f.input.end_date }, uid())).rejects.toMatchObject({ status: 404 });
    const token = await bearer(f.secretary);
    expect((await api(token, `/profiles/${f.profile}/ensino/classes/${foreign.classroom.id}`)).status).toBe(404);
    await expect(listClasses(foreign.ctx, f.secretary, {})).rejects.toMatchObject({ status: 404 });
    await expect(listClasses(f.ctx, f.secretary, { cursor: btoa(JSON.stringify([foreign.profile, f.classroom.id])) })).rejects.toMatchObject({ status: 400 });
    await expect(listClasses(f.ctx, f.secretary, { phone: "5511988887777" })).rejects.toMatchObject({ status: 400 });
  });
  it("bloqueia IA, atuação via humano, módulos, credenciais e aplicações mesmo com todos os escopos", async () => {
    const f = await schoolFixture();
    const actors: Actor[] = [
      { ...f.secretary, via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } },
      { ...f.secretary, id: "bot:x" }, { ...f.secretary, bots: ["b"] },
      { ...f.secretary, kind: "app", scopes: ["conversations:read", "conversations:write", "contacts:read", "notes:read"] },
      { ...f.secretary, module: { id: "other", reach: ["ensino"] } },
      { ...f.secretary, credential: { id: "x", module: "ensino", subject: f.classroom.id } },
    ];
    for (const a of actors) {
      await expect(listClasses(f.ctx, a, {})).rejects.toMatchObject({ status: 403 });
      await expect(createLesson(f.ctx, a, { id: f.classroom.id }, uid())).rejects.toMatchObject({ status: 403 });
    }
    expect(ensinoModule.bot).toMatchObject({ deny: ["ensino/", "ensino."], sensitive: ["ensino."] });
  });
  it("confere conflitos de horário e tipo privado", async () => {
    const f = await schoolFixture();
    await expect(createClass(f.ctx, f.secretary, f.input, uid())).rejects.toMatchObject({ code: "schedule_conflict" });
    await expect(createClass(f.ctx, f.secretary, { ...f.input, type_id: "service_order" }, uid())).rejects.toMatchObject({ status: 400 });
    const type = { ...f.type, features: { ...f.type.features, customer_open: true } };
    await exec(env, "UPDATE profiles SET settings=json_set(settings,'$.os_work_types',json(?)) WHERE id=?", JSON.stringify([type]), f.profile);
    await expect(createClass(f.ctx, f.secretary, f.input, uid())).rejects.toMatchObject({ status: 400 });
  });
  it("CAS não escreve dados nem auditoria parcial; limite de vagas também existe no banco", async () => {
    const f = await schoolFixture();
    await expect(updateClass(f.ctx, f.secretary, { id: f.classroom.id, version: 1, justified_counts: true }, uid())).rejects.toMatchObject({ code: "version_conflict" });
    expect((await classroom(f.ctx, f.secretary, f.classroom.id)).justified_counts).toBe(0);
    const before = (await all(env, "SELECT id FROM ensino_audit WHERE profile_id=?", f.profile)).length;
    await exec(env, "UPDATE ensino_classes SET capacity=1 WHERE profile_id=? AND id=?", f.profile, f.classroom.id);
    // Mesmo aluno em uma segunda linha seria inválido por unicidade e pela capacidade.
    await expect(enroll(f.ctx, f.secretary, { id: f.classroom.id, version: 2, order_id: f.order.id, start_date: f.input.start_date, end_date: f.input.end_date }, uid())).rejects.toMatchObject({ code: "class_full" });
    expect((await all(env, "SELECT id FROM ensino_audit WHERE profile_id=?", f.profile)).length).toBe(before);
    expect((await classroom(f.ctx, f.secretary, f.classroom.id)).version).toBe(2);
  });
});

describe("Ensino: diário, avaliações e publicação", () => {
  it("usa o dia de Brasília, inclusive no começo do dia UTC", () => {
    expect(today(Date.parse("2026-01-02T01:00:00Z"))).toBe("2026-01-01");
    expect(today(Date.parse("2026-01-02T03:00:00Z"))).toBe("2026-01-02");
  });
  it("retoma comando confirmado sem repetir revisão, mesmo sem recibo externo", async () => {
    const f = await schoolFixture();
    const l = await createLesson(f.ctx, f.professor, { id: f.classroom.id, version: 2, date: "2025-02-03", starts: "08:00", ends: "09:00", status: "held" }, uid());
    const data = { id: f.classroom.id, version: 3, lesson_id: l.id, enrollment_id: f.student.id, status: "present", reason: "initial" }, key = uid();
    const first = await perform(env, f.professor, f.profile, "ensino.attendance.record", data, key);
    expect(await perform(env, f.professor, f.profile, "ensino.attendance.record", { ...data }, key)).toEqual(first);
    expect(await all(env, "SELECT revision FROM ensino_attendance WHERE profile_id=? AND lesson_id=?", f.profile, l.id)).toEqual([{ revision: 1 }]);
    await expect(perform(env, f.professor, f.profile, "ensino.attendance.record", { ...data, status: "absent" }, key)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("só chama alunos enturmados na data, exige aula realizada e preserva correções", async () => {
    const f = await schoolFixture();
    const l = await createLesson(f.ctx, f.professor, { id: f.classroom.id, version: 2, date: "2025-02-03", starts: "08:00", ends: "09:00", status: "planned" }, uid());
    const body = { id: f.classroom.id, version: 3, lesson_id: l.id, enrollment_id: f.student.id, status: "present", reason: "initial" };
    await expect(recordAttendance(f.ctx, f.professor, body, uid())).rejects.toMatchObject({ status: 400 });
    await updateLesson(f.ctx, f.professor, { id: f.classroom.id, version: 3, lesson_id: l.id, status: "held", reason: "correction" }, uid());
    await recordAttendance(f.ctx, f.professor, { ...body, version: 4 }, uid());
    await expect(recordAttendance(f.ctx, f.professor, { ...body, version: 5 }, uid())).rejects.toMatchObject({ status: 400 });
    await recordAttendance(f.ctx, f.professor, { ...body, version: 5, status: "justified", reason: "correction" }, uid());
    expect((await all(env, "SELECT revision,status FROM ensino_attendance WHERE profile_id=? AND lesson_id=? ORDER BY revision", f.profile, l.id))).toEqual([{ revision: 1, status: "present" }, { revision: 2, status: "justified" }]);
    await expect(endEnrollment(f.ctx, f.secretary, { id: f.classroom.id, version: 6, enrollment_id: f.student.id, end_date: "2025-01-31" }, uid())).rejects.toMatchObject({ code: "recorded_after_end" });
    await exec(env, "UPDATE ensino_enrollments SET start_date='2025-03-01' WHERE profile_id=? AND id=?", f.profile, f.student.id);
    await expect(recordAttendance(f.ctx, f.professor, { ...body, version: 6, reason: "correction" }, uid())).rejects.toMatchObject({ status: 400 });
  });
  it("publica fotografia reproduzível e mantém boletim anterior após mudar regra ou nota", async () => {
    const f = await schoolFixture();
    const a = await createAssessment(f.ctx, f.professor, { id: f.classroom.id, version: 2, period_id: "p1", subject: "Matemática", title: "Prova", date: "2025-02-03", max_score: 10, weight: 1, kind: "regular" }, uid());
    const publication = { id: f.classroom.id, version: 3, enrollment_id: f.student.id, period_id: "p1" };
    await expect(publishReport(f.ctx, f.secretary, publication, uid())).rejects.toMatchObject({ code: "pending_results" });
    await expect(publishReport(f.ctx, f.professor, publication, uid())).rejects.toMatchObject({ status: 403 });
    await expect(recordGrade(f.ctx, f.professor, { id: f.classroom.id, version: 3, assessment_id: a.id, enrollment_id: f.student.id, status: "graded", score: 11, reason: "initial" }, uid())).rejects.toMatchObject({ status: 400 });
    await recordGrade(f.ctx, f.professor, { id: f.classroom.id, version: 3, assessment_id: a.id, enrollment_id: f.student.id, status: "graded", score: 7.25, reason: "initial" }, uid());
    const preview = await previewReport(f.ctx, f.professor, f.classroom.id, f.student.id, "p1");
    expect(preview.subjects[0].final).toBe(7.3);
    const report = await publishReport(f.ctx, f.secretary, { ...publication, version: 4 }, uid());
    const before = await one(env, "SELECT snapshot_json FROM ensino_reports WHERE profile_id=? AND id=?", f.profile, report.id);
    await updateClass(f.ctx, f.secretary, { id: f.classroom.id, version: 5, rule: { ...f.input.rule, decimals: 2 } }, uid());
    await recordGrade(f.ctx, f.professor, { id: f.classroom.id, version: 6, assessment_id: a.id, enrollment_id: f.student.id, status: "graded", score: 8.55, reason: "correction" }, uid());
    await publishReport(f.ctx, f.secretary, { ...publication, version: 7 }, uid());
    expect(await one(env, "SELECT snapshot_json FROM ensino_reports WHERE profile_id=? AND id=?", f.profile, report.id)).toEqual(before);
    const rows = await all(env, "SELECT revision,snapshot_json FROM ensino_reports WHERE profile_id=? ORDER BY revision", f.profile);
    expect(rows.map(r => r.revision)).toEqual([1, 2]);
    expect(JSON.parse(rows[1].snapshot_json).subjects[0].final).toBe(8.55);
    const audit = JSON.stringify(await all(env, "SELECT * FROM ensino_audit WHERE profile_id=?", f.profile));
    expect(audit).not.toContain("Matemática"); expect(audit).not.toContain("7.25");
  });
  it("bloqueia publicação com chamada pendente e exclui aula cancelada", async () => {
    const f = await schoolFixture();
    const l = await createLesson(f.ctx, f.professor, { id: f.classroom.id, version: 2, date: "2025-02-03", starts: "08:00", ends: "09:00", status: "held" }, uid());
    const preview = await previewReport(f.ctx, f.professor, f.classroom.id, f.student.id, "p1");
    expect(preview.frequency).toMatchObject({ pending: 1, absent: 0, percent: null });
    await updateLesson(f.ctx, f.professor, { id: f.classroom.id, version: 3, lesson_id: l.id, status: "cancelled", reason: "correction" }, uid());
    expect((await previewReport(f.ctx, f.professor, f.classroom.id, f.student.id, "p1")).frequency.held).toBe(0);
  });
});
