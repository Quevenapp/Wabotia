// Descritores de rotas e registro do provedor cadastral da própria extensão.
import { registerCustomerProvider } from "../../customer/ports";
import { ensinoCustomerProvider, linkEnsinoCustomer } from "./customer-provider";
import type { onRead, onCommand, onRoute, onMcpTool } from "../api";
import { classView, classroom, staff, forbidden } from "./access";
import * as store from "./store";
import * as diary from "./diary";
import * as notices from "./notices";
import { ownReport, ownStudents } from "./customer";
export { requestAccess, customerAction, claimAccess } from "./customer";

export { ensinoNoStore } from "./http";
registerCustomerProvider("ensino", ensinoCustomerProvider);

type Read = { path: string; handler: Parameters<typeof onRead>[2]; options?: Parameters<typeof onRead>[3] };
type Command = { op: string; handler: Parameters<typeof onCommand>[2] };
export const ensinoReads: Read[] = [
  { path: "ensino/classes", handler: (c, a, r) => store.listClasses(c, a, r.query) },
  { path: "ensino/classes/:id", handler: async (c, a, r) => classView(await classroom(c, a, r.params.id)) },
  { path: "ensino/classes/:id/enrollments", handler: (c, a, r) => store.roster(c, a, r.params.id) },
  { path: "ensino/classes/:id/enrollments/:enrollment_id/guardians", handler: (c, a, r) => store.guardians(c, a, r.params.id, r.params.enrollment_id) },
  { path: "ensino/classes/:id/lessons", handler: (c, a, r) => diary.lessons(c, a, r.params.id, r.query) },
  { path: "ensino/classes/:id/lessons/:lesson_id/attendance", handler: (c, a, r) => diary.attendance(c, a, r.params.id, r.params.lesson_id) },
  { path: "ensino/classes/:id/assessments", handler: (c, a, r) => diary.assessments(c, a, r.params.id, r.query) },
  { path: "ensino/classes/:id/assessments/:assessment_id/grades", handler: (c, a, r) => diary.grades(c, a, r.params.id, r.params.assessment_id) },
  { path: "ensino/classes/:id/enrollments/:enrollment_id/reports/:period_id", handler: (c, a, r) => diary.previewReport(c, a, r.params.id, r.params.enrollment_id, r.params.period_id) },
  { path: "ensino/classes/:id/notices", handler: (c, a, r) => notices.notices(c, a, r.params.id) },
  { path: "ensino/access/:id/students", options: { credential: true }, handler: (c, a, r) => ownStudents(c, a, r.params.id, r.query) },
  { path: "ensino/access/:id/students/:enrollment_id", options: { credential: true }, handler: (c, a, r) => ownReport(c, a, r.params.id, r.params.enrollment_id) },
];
export const ensinoWrites: Parameters<typeof onRoute>[1][] = [
  { method: "PUT", path: "ensino/classes/:id/enrollments/:enrollment_id/guardians/:guardian_id/contact", op: "ensino.customer.guardian.link" },
  { method: "PUT", path: "ensino/classes/:id/enrollments/:enrollment_id/billing-contact", op: "ensino.customer.billing.link" },
  { method: "POST", path: "ensino/classes", op: "ensino.class.create" },
  { method: "PATCH", path: "ensino/classes/:id", op: "ensino.class.update" },
  { method: "POST", path: "ensino/classes/:id/enrollments", op: "ensino.enrollment.create" },
  { method: "POST", path: "ensino/classes/:id/enrollments/:enrollment_id/end", op: "ensino.enrollment.end" },
  { method: "POST", path: "ensino/classes/:id/enrollments/:enrollment_id/guardians", op: "ensino.guardian.grant" },
  { method: "POST", path: "ensino/classes/:id/enrollments/:enrollment_id/guardians/:guardian_id/revoke", op: "ensino.guardian.revoke" },
  { method: "POST", path: "ensino/classes/:id/lessons", op: "ensino.lesson.create" },
  { method: "PATCH", path: "ensino/classes/:id/lessons/:lesson_id", op: "ensino.lesson.update" },
  { method: "POST", path: "ensino/classes/:id/lessons/:lesson_id/attendance", op: "ensino.attendance.record" },
  { method: "POST", path: "ensino/classes/:id/assessments", op: "ensino.assessment.create" },
  { method: "POST", path: "ensino/classes/:id/assessments/:assessment_id/grades", op: "ensino.grade.record" },
  { method: "POST", path: "ensino/classes/:id/enrollments/:enrollment_id/reports", op: "ensino.report.publish" },
  { method: "POST", path: "ensino/classes/:id/notices", op: "ensino.notice.create" },
  { method: "POST", path: "ensino/classes/:id/notices/:notice_id/publish", op: "ensino.notice.publish" },
  { method: "POST", path: "ensino/classes/:id/notices/:notice_id/send", op: "ensino.notice.send" },
];
const handlers = {
  "ensino.class.create": store.createClass, "ensino.class.update": store.updateClass,
  "ensino.enrollment.create": store.enroll, "ensino.enrollment.end": store.endEnrollment,
  "ensino.guardian.grant": store.grantGuardian, "ensino.guardian.revoke": store.revokeGuardian,
  "ensino.lesson.create": diary.createLesson, "ensino.lesson.update": diary.updateLesson,
  "ensino.attendance.record": diary.recordAttendance, "ensino.assessment.create": diary.createAssessment,
  "ensino.grade.record": diary.recordGrade, "ensino.report.publish": diary.publishReport,
  "ensino.notice.create": notices.createNotice, "ensino.notice.publish": notices.publishNotice,
  "ensino.notice.send": notices.sendNoticeBatch,
};
export const ensinoCommands: Command[] = Object.entries(handlers).map(([op, handler]) => ({
  op, handler: async (ctx, actor, data, { requestId }) => {
    // Antes do replay, conferir a autorização ATUAL; depois, retomar sem revalidar
    // como "inicial" uma nota/chamada que já foi confirmada no lote anterior.
    const secretaryOnly = /ensino\.(class|enrollment|guardian|report)\.|ensino\.notice\.(publish|send)/.test(op);
    if (op === "ensino.class.create") {
      if (!(await staff(ctx, actor, true))) forbidden();
    } else await classroom(ctx, actor, data?.id, true, secretaryOnly);
    const previous = op === "ensino.notice.send" ? null : await store.replayChange(ctx, actor, op.slice(7), requestId, data);
    return previous ?? handler(ctx, actor, data, requestId);
  },
}));
ensinoCommands.push(
  { op: "ensino.customer.guardian.link", handler: (ctx, actor, data, { requestId }) => linkEnsinoCustomer(ctx, actor, data, requestId, "guardian") },
  { op: "ensino.customer.billing.link", handler: (ctx, actor, data, { requestId }) => linkEnsinoCustomer(ctx, actor, data, requestId, "billing") },
);
export const ensinoTool: Parameters<typeof onMcpTool>[1] = {
  name: "ensino_pedir_boletim",
  description: "Envia no WhatsApp uma consulta escolar protegida. Confere o telefone verificado de um responsável autorizado. Não retorna notas, frequência, vínculos nem o link à IA.",
  input: { conversation_id: { type: "string" } }, required: ["conversation_id"], write: true, customer: "read",
  call: (a, profile) => ({ method: "POST", path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`, body: { action: "ensino_boletim" } }),
};
