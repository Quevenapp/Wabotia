import assert from "node:assert/strict";
import { all, exec, one } from "../src/db";
import { now, uid, json, type Actor } from "../src/types";
import { sha, MOBILE_TOKEN_PREFIX } from "../src/security";
import { fullCatalog, resetCatalogCache } from "../src/bot-actions/catalog";
import { moduleStates, hiddenMenuTypes } from "../src/modules/registry";
import { modulesApi } from "../src/modules/api";
import { scheduledModules, moduleMcpTools, menuHandler } from "../src/modules/hooks";
import { authorizedOrder } from "../src/modules/os/public";
import { projectOrderForBot, projectOrderForCustomer } from "../src/modules/os/privacy";
import { receiveDocument } from "../src/modules/os/documents/delivery";
import { runDue } from "../src/modules/os/reminders";
import { runTaskDue } from "../src/modules/os/tasks/reminders";
import { validateFields, validateAnswers, formPage } from "../src/web-steps";
import { customOpenForm, openingAnswers } from "../src/modules/os/forms";
import { motorWorkType } from "./os-motor-fixture";
import { defaultRule } from "../src/modules/ensino/model";
import { saudeExtension } from "../src/modules/saude/saude";
import { canOpenPage } from "../web/workspace-navigation";
import { applyRegisteredTemplate, integrationFixture, customerConversation, selection, messages, type IntegrationHarness, type IntegrationFixture } from "./os-integration-fixture";
import { areaTemplates } from "../src/area-templates";

const SECRET = "SEGREDO_I2_NAO_SAI_847";
const extensionIds = ["juridico", "condominio", "saude", "ensino"];
async function grants(h: IntegrationHarness, f: IntegrationFixture, roles: string[]) {
  f.actor.access = ["*", ...roles];
  await exec(h.env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(f.actor.access), f.actor.id);
}
async function base(h: IntegrationHarness, model: string, module: string, roles: string[]) {
  const f = await applyRegisteredTemplate(h, model);
  await f.call(`/modules/${module}`, "PUT", { enabled: true });
  await grants(h, f, roles);
  return f;
}
async function create(h: IntegrationHarness, f: IntegrationFixture, typeId?: string, extra = {}) {
  const c = await customerConversation(h, f);
  const types = (await f.call("/service-orders/types")).data;
  const type = typeId ? types.find((t: any) => t.id === typeId) : types.find((t: any) => t.kind === "custom" && !t.archived);
  const values = Object.fromEntries((type?.fields || []).filter((x: any) => x.required && !x.sensitive).map((x: any) => [x.id,
    x.kind === "choice" ? x.options[0].id : x.kind === "boolean" ? false : x.kind === "date" ? "2026-11-18" : x.kind === "integer" || x.kind === "decimal" ? (x.min ?? 1) : "Referência"]));
  const order = await f.call("/service-orders", "POST", { type_id: type?.id, conversation_id: c, customer_name: "Responsável", item: "Pedido administrativo", problem: "Atendimento", extra: { ...values, ...extra }, notify: false });
  return { order, c, type, path: `/service-orders/${order.id}` };
}
async function noCommonSecret(h: IntegrationHarness, f: IntegrationFixture, orderId: string, secret = SECRET) {
  const ctx = modulesApi(h.env, f.profile, "os");
  const order = await authorizedOrder(ctx, f.actor, orderId);
  for (const view of [projectOrderForBot(ctx, f.actor, order), projectOrderForCustomer(ctx, f.actor, order), await f.call(`/service-orders/${orderId}`), await f.call(`/service-orders/${orderId}/history`)])
    assert(!JSON.stringify(view).includes(secret));
  for (const table of ["events", "os_history", "outbox"])
    assert(!JSON.stringify(await all(h.env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).includes(secret), table);
}
async function isolate(h: IntegrationHarness, module: string, target: string) {
  const other = await integrationFixture(h);
  await other.call("/modules/os", "PUT", { enabled: true });
  await other.call(`/modules/${module}`, "PUT", { enabled: true });
  await grants(h, other, ["os:sensitive", `${module}:lawyer`, `${module}:curator`, `${module}:admin`, `${module}:clinical_read`, `${module}:clinical_write`, `${module}:secretaria`]);
  await other.call(target, "GET", undefined, uid(), 404);
}
export async function extensionDefaults(h: IntegrationHarness) {
  const f = await integrationFixture(h), states = await moduleStates(h.env, f.profile);
  for (const id of extensionIds) {
    assert.equal(states[id], false);
    assert.equal(canOpenPage(id, "admin", states), false);
    assert.equal(canOpenPage(id, "admin", undefined), false);
  }
  assert(hiddenMenuTypes(states).has("ensino_boletim"));
  assert(hiddenMenuTypes(states).has("cond_unit"));
  const before = await one(h.env, "SELECT settings FROM profiles WHERE id=?", f.profile);
  for (const path of ["juridico/deadlines", "condominio/units", "saude/subjects", "ensino/classes"])
    await f.call("/" + path, "GET", undefined, uid(), 409);
  assert.deepEqual(await one(h.env, "SELECT settings FROM profiles WHERE id=?", f.profile), before);
  await f.call("/modules/os", "PUT", { enabled: true });
  const order = await f.call("/service-orders", "POST", { phone: "5511999990000", item: "Equipamento", problem: "Defeito", notify: false });
  assert.equal(order.type_id, "service_order");
  assert.equal(order.status, "received");
  assert.equal(order.number, 1);
  assert.deepEqual(order.next_statuses, ["analyzing", "in_progress", "cancelled"]);
  const after = await h.alarm(f.profile);
  assert(after.statements < 800);
  assert.equal((await all(h.env, "SELECT id FROM jur_alerts WHERE profile_id=?", f.profile)).length, 0);
  assert.equal((await all(h.env, "SELECT phone FROM cond_notice_recipients WHERE profile_id=?", f.profile)).length, 0);
  assert.equal(scheduledModules().filter(([id]) => id === "os").length, 1);
  assert.equal(scheduledModules().filter(([id]) => id === "juridico").length, 1);
  assert.equal(scheduledModules().filter(([id]) => id === "condominio").length, 1);
}
export async function juridicoIntegration(h: IntegrationHarness) {
  const f = await base(h, "advogados", "juridico", ["os:sensitive", "juridico:lawyer", "juridico:curator"]);
  const { order, path, c } = await create(h, f);
  const calendar = await f.call("/juridico/calendars", "POST", { calendar: { name: "Calendário", jurisdiction: "Teste", from: "2026-01-01", to: "2027-12-31", timezone: "America/Sao_Paulo", weekend: [0, 6], events: [] }, seed_national: false });
  const deadline = await f.call("/juridico/deadlines", "POST", { order_id: order.id, calendar_id: calendar.id, calendar_revision: calendar.revision, assignee: f.actor.id, title: SECRET, rule: { start_date: "2026-11-16", days: 5, include_start: false, start_non_working: "next", due_non_working: "next", due_time: "18:00", alert_days: 2, alert_time: "09:00" } });
  const detail = await f.call(`/juridico/deadlines/${deadline.id}`);
  assert.equal(detail.review, "pending");
  await f.call(`/juridico/deadlines/${deadline.id}/confirm`, "POST", { version: detail.version, task_version: detail.task_version, checked: true });
  assert.equal((await f.call(`/service-orders/conversation/${c}/orders/${order.id}/tasks`)).data.length, 0);
  assert.equal((await f.call(path + "/tasks")).data.length, 1);
  await isolate(h, "juridico", `/juridico/deadlines/${deadline.id}`);
  await noCommonSecret(h, f, order.id);
  resetCatalogCache(); assert.equal(fullCatalog().some(x => x.module === "juridico"), false);
}
export async function condominioIntegration(h: IntegrationHarness) {
  const f = await base(h, "condominios", "condominio", ["condominio:admin", "condominio:mesa"]);
  const c = await customerConversation(h, f);
  const block = await f.call("/condominio/blocks", "POST", { name: "Bloco" });
  const unit = await f.call("/condominio/units", "POST", { block_id: block.id, number: "302" });
  const person = await f.call("/condominio/people", "POST", { name: "Morador" });
  await f.call("/condominio/phones", "POST", { person_id: person.id, conversation_id: c, confirmed: true });
  await f.call("/condominio/memberships", "POST", { person_id: person.id, unit_id: unit.id, role: "proprietario", starts_at: now() - 1000, notices: true });
  const work = await f.call("/condominio/works", "POST", { kind: "ocorrencia", person_id: person.id, unit_id: unit.id, item: "Solicitação", problem: "Conferir", extra: { categoria: "outro", risco_imediato: false } });
  const detail = await f.call(`/condominio/works/${work.id}`);
  assert(detail);
  const order = await f.call(`/service-orders/${work.id}`);
  assert.equal(order.extra.unidade, "Bloco · 302");
  const transition = order.next_stages.find((x: any) => x.kind === "manual");
  await f.call(`/condominio/works/${work.id}/stage`, "POST", { transition_id: transition.transition_id, version: order.version });
  assert.equal((await one(h.env, "SELECT unit_id FROM cond_works WHERE profile_id=? AND id=?", f.profile, work.id))!.unit_id, unit.id);
  const access = await portal(h, f, c, "condominio", "cond_unit");
  assert.equal((await access.get(`/condominio/me/${encodeURIComponent(access.subject)}/units`)).data[0].id, unit.id);
  assert((await access.get(`/condominio/me/${encodeURIComponent(access.subject)}/work-types`)).data.length);
  await isolate(h, "condominio", `/condominio/works/${work.id}`);
  await grants(h, f, ["condominio:admin", "condominio:mesa", "os:sensitive"]);
  const current = await f.call(`/service-orders/${work.id}`);
  await f.call(`/service-orders/${work.id}/private-fields`, "PATCH", { version: current.version, extra: { detalhes_restritos: SECRET } });
  await noCommonSecret(h, f, work.id);
  resetCatalogCache(); assert.equal(fullCatalog().some(x => x.module === "condominio"), false);
}
export async function saudeIntegration(h: IntegrationHarness) {
  const f = await base(h, "clinica_medica", "saude", ["os:sensitive", "saude:clinical_read", "saude:clinical_write", "saude:responsible"]);
  const { order, path } = await create(h, f);
  const patient = await f.call("/saude/subjects", "POST", { kind: "human", name: "Paciente" });
  const root = `/saude/subjects/${patient.id}`;
  const episode = await f.call(root + "/episodes", "POST", { order_id: order.id });
  const record = await f.call(root + "/records", "POST", { episode_id: episode.id, kind: "evolution", text: SECRET });
  await f.call(root + `/records/${record.id}/sign`, "POST", { version: 1, confirm: true });
  assert.equal((await f.call(root + "/records")).data[0].text, SECRET);
  await isolate(h, "saude", root);
  // Cada rota de leitura registra acesso antes de devolver qualquer conteúdo.
  for (const read of ["/saude/subjects", root, root + "/episodes", root + "/records", root + "/attachments", root + "/export", "/saude/audit", `/saude/retention/${patient.id}`, `/saude/attendance/${order.id}`, "/saude/policy"]) {
    const before = (await all(h.env, "SELECT id FROM saude_access_audit WHERE profile_id=?", f.profile)).length;
    const response = await h.fetch(f.request(read));
    assert.equal(response.status, 200, read); await response.text();
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert((await all(h.env, "SELECT id FROM saude_access_audit WHERE profile_id=?", f.profile)).length > before, read);
  }
  const ctx = modulesApi(h.env, f.profile, "saude");
  for (const actor of [{ ...f.actor, access: ["*", "os:sensitive"] }, { ...f.actor, via: { kind: "bot" as const, bot_id: "b", run_id: "r", masked: false } }, { ...f.actor, bots: ["b"] }, { ...f.actor, kind: "app" as const, scopes: ["conversations:read", "conversations:write"] }]) {
    for (const r of saudeExtension.binaryReads.filter(r => !r.path.includes("attendance")))
      await assert.rejects(r.handler(ctx, actor, { params: { subject_id: patient.id, order_id: order.id }, query: {}, request: new Request("https://test") }), (e: any) => e.status === 403);
  }
  await grants(h, f, ["os:sensitive"]);
  await f.call(root, "GET", undefined, uid(), 403);
  await grants(h, f, ["os:sensitive", "saude:clinical_read", "saude:clinical_write", "saude:responsible"]);
  // Falha da auditoria fecha a leitura, sem vazar o corpo.
  await h.env.DB.exec(`CREATE TRIGGER i2_audit_failure BEFORE INSERT ON saude_access_audit WHEN NEW.profile_id='${f.profile}' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  const denied = await h.fetch(f.request(root + "/records"));
  assert.equal(denied.status, 500); assert(!(await denied.text()).includes(SECRET));
  await h.env.DB.exec("DROP TRIGGER i2_audit_failure");
  await noCommonSecret(h, f, order.id);
  const exported = await f.call("/area-templates/export", "POST", { id: "export_i2", name: "Exportação", type_ids: [order.type_id] });
  assert(!JSON.stringify(exported).includes(SECRET));
  for (const url of [`https://test/api/public/saude/subjects/${patient.id}/export`, `https://test/api/v1/profiles/${f.profile}${root}/export`]) {
    const response = await h.fetch(new Request(url)); assert(!(await response.text()).includes(SECRET));
  }
  assert.equal((await f.call(path + "/documents")).data.length, 0);
  resetCatalogCache(); assert.equal(fullCatalog().some(x => x.module === "saude"), false);
  return { f, patient, record };
}
export async function ensinoIntegration(h: IntegrationHarness) {
  const f = await base(h, "escolas", "ensino", ["os:sensitive", "ensino:secretaria", "ensino:professor"]);
  const { order, path, c } = await create(h, f, "area_escolas__escolas_matricula");
  await f.call(path + "/private-fields", "PATCH", { version: order.version, extra: { nome_aluno: SECRET } });
  const classroom = await f.call("/ensino/classes", "POST", { name: "Turma", school_year: "2025", start_date: "2025-01-01", end_date: "2025-12-31", teacher_id: f.actor.id, type_id: order.type_id, capacity: 20, schedule: [{ day: 1, start: "08:00", end: "09:00" }], periods: [{ id: "p1", name: "Período", start: "2025-01-01", end: "2025-12-31" }], rule: defaultRule, justified_counts: false });
  const root = `/ensino/classes/${classroom.id}`;
  const enrollment = await f.call(root + "/enrollments", "POST", { version: 1, order_id: order.id, start_date: "2025-01-01", end_date: "2025-12-31" });
  const lesson = await f.call(root + "/lessons", "POST", { version: 2, date: "2025-11-17", starts: "08:00", ends: "09:00", status: "held" });
  await f.call(root + `/lessons/${lesson.id}/attendance`, "POST", { version: 3, enrollment_id: enrollment.id, status: "present", reason: "initial" });
  const assessment = await f.call(root + "/assessments", "POST", { version: 4, period_id: "p1", subject: "Matemática", title: "Avaliação", date: "2025-11-17", max_score: 10, weight: 1, kind: "regular" });
  await f.call(root + `/assessments/${assessment.id}/grades`, "POST", { version: 5, enrollment_id: enrollment.id, status: "graded", score: 8, reason: "initial" });
  const report = await f.call(root + `/enrollments/${enrollment.id}/reports/p1`);
  assert.equal(report.name, SECRET);
  assert.equal((await f.call(root + "/enrollments")).data[0].name, SECRET);
  await f.call(root + `/enrollments/${enrollment.id}/reports`, "POST", { version: 6, period_id: "p1" });
  const linked = await f.call(path + "/people", "POST", { role: "Responsável", name: "Responsável", phone: "5511960010203", sensitive: true, client_visible: false });
  await f.call(root + `/enrollments/${enrollment.id}/guardians`, "POST", { version: 7, person_id: linked.id, valid_until: "2099-12-31", identity_confirmed: true });
  const access = await portal(h, f, c, "ensino", "ensino_boletim");
  const students = await access.get(`/ensino/access/${encodeURIComponent(access.subject)}/students`);
  assert.equal(students.data[0].name, SECRET);
  const ownReport = await access.get(`/ensino/access/${encodeURIComponent(access.subject)}/students/${enrollment.id}`);
  assert.equal(ownReport.reports[0].name, SECRET);
  await isolate(h, "ensino", root);
  await noCommonSecret(h, f, order.id);
  resetCatalogCache(); assert.equal(fullCatalog().some(x => x.module === "ensino"), false);
  const response = await h.fetch(f.request(root)); assert.match(response.headers.get("Cache-Control")!, /no-store/);
}
async function customFixture(h: IntegrationHarness, type = motorWorkType()) {
  const f = await integrationFixture(h);
  await f.call("/modules/os", "PUT", { enabled: true });
  const catalog = await f.call("/service-orders/types");
  await f.call("/settings", "PUT", { os_work_types: [type], settings_revision: catalog.settings_revision });
  await grants(h, f, ["os:sensitive", "os:technician"]);
  return { f, ...await create(h, f, type.id), type };
}
async function appKey(h: IntegrationHarness, f: IntegrationFixture, bots: string[] = []) {
  const app = uid(), token = "wab_" + uid();
  const scopes = ["conversations:read", "conversations:write", "contacts:read"];
  await exec(h.env, "INSERT INTO applications(id,name,profiles,scopes,bots,created) VALUES(?,?,?,?,?,?)", app, "Teste I2", JSON.stringify([f.profile]), JSON.stringify(scopes), JSON.stringify(bots), now());
  await exec(h.env, "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)", uid(), app, await sha(token), token.slice(0, 12), now() + 600000, now());
  return { app, token };
}
export async function securityReminders(h: IntegrationHarness) {
  const type = motorWorkType();
  type.stages.push({ id: "pronto", label: "Pronto", base_status: "ready", message: "" });
  type.transitions.push({ id: "cancelar_pronto", from: "pronto", to: "cancelado", label: "Cancelar", kind: "manual" }, { id: "pronto", from: "entrada", to: "pronto", label: "Pronto", kind: "manual" }, { id: "retirar", from: "pronto", to: "entregue", label: "Retirar", kind: "manual" });
  type.fields = ["a", "b"].map(id => ({ id, label: id, help: "", kind: "text", max_length: 2000, multiline: true, required: false, sensitive: false, client_visible: true }));
  type.features.pickup_reminder_days = 1; type.pickup_reminder_text = "{campo_a}{campo_b}";
  const { f, order, c, path } = await customFixture(h, type);
  await f.call(path, "PATCH", { version: order.version, extra: { a: "a".repeat(2000), b: "😀".repeat(2000) } });
  await exec(h.env, "UPDATE os_orders SET status='ready',stage='pronto',ready_at=? WHERE profile_id=? AND id=?", now() - 3 * 86400000, f.profile, order.id);
  const builtin = await f.call("/service-orders", "POST", { conversation_id: c, item: "Equipamento", problem: "Defeito", notify: false });
  await exec(h.env, "UPDATE os_orders SET status='ready',stage='ready',ready_at=?,updated=? WHERE profile_id=? AND id=?", now() - 40 * 86400000, now() - 40 * 86400000, f.profile, builtin.id);
  const ctx = modulesApi(h.env, f.profile, "os");
  await runDue(ctx, now());
  const out = await messages(h, f);
  assert(out.length >= 2); assert(out.every(r => json(r.payload).text.length <= 3800));
  assert((await one(h.env, "SELECT pickup_reminded_at FROM os_orders WHERE id=?", builtin.id))!.pickup_reminded_at);
  // Injeção de falha no transporte: não marcar o primeiro e continuar o segundo.
  await exec(h.env, "UPDATE os_orders SET pickup_reminded_at=NULL WHERE profile_id=?", f.profile);
  let sends = 0;
  const broken = { ...ctx, sendMessage: async (...args: Parameters<typeof ctx.sendMessage>) => { sends++; if (sends === 1) throw Error("transporte indisponível"); return ctx.sendMessage(...args); } };
  await runDue(broken, now());
  assert.equal(sends, 2);
  assert.equal((await all(h.env, "SELECT id FROM os_orders WHERE profile_id=? AND pickup_reminded_at IS NULL", f.profile)).length, 1);
  // Cinquenta falhas permanentes não prendem a próxima página; o cursor é durável.
  const blocked = await integrationFixture(h), at = now();
  await blocked.call("/modules/os", "PUT", { enabled: true });
  const recipient = await customerConversation(h, blocked);
  let lastId = "";
  for (let i = 0; i < 51; i++) {
    const next = await blocked.call("/service-orders", "POST", { conversation_id: recipient, item: "Equipamento", problem: "Defeito", notify: false });
    await exec(h.env, "UPDATE os_orders SET status='ready',stage='ready',ready_at=? WHERE profile_id=? AND id=?", at - 40 * 86400000 + i, blocked.profile, next.id);
    lastId = next.id;
  }
  const blockedCtx = modulesApi(h.env, blocked.profile, "os");
  const delivery = { ...blockedCtx, sendMessage: async (...args: Parameters<typeof blockedCtx.sendMessage>) => {
    if (!args[2]?.key?.includes(lastId)) throw Error("transporte indisponível");
    return blockedCtx.sendMessage(...args);
  } };
  await runDue(delivery, at);
  assert.equal((await all(h.env, "SELECT id FROM os_orders WHERE profile_id=? AND pickup_reminded_at IS NOT NULL", blocked.profile)).length, 0);
  await runDue({ ...delivery }, at + 60000);
  assert.deepEqual((await all(h.env, "SELECT id FROM os_orders WHERE profile_id=? AND pickup_reminded_at IS NOT NULL", blocked.profile)).map(r => r.id), [lastId]);
  // Os primeiros dez sem conversa não podem prender o décimo primeiro.
  const missing = await f.call("/service-orders", "POST", { type_id: type.id, phone: "5511988880000", item: "Sem conversa", problem: "Atendimento", notify: false });
  for (let i = 0; i < 11; i++) await exec(h.env,
    "INSERT INTO os_tasks(id,profile_id,order_id,title,description,audience,due_at,remind_at,sensitive,client_visible,created_by,created,updated) VALUES(?,?,?,?,?,'customer',?,?,0,1,?,?,?)",
    `i2_${uid()}`, f.profile, i < 10 ? missing.id : order.id, "Prazo", "", now() + 10000, now() - 20000 + i, f.actor.id, now(), now());
  for (let i = 0; i < 4; i++) { let remaining = 200; await runTaskDue(ctx, { now: now(), limit: 10, budget: { get remaining() { return remaining; }, consume(n) { remaining -= n; } } }); }
  assert.equal((await all(h.env, "SELECT id FROM os_tasks WHERE profile_id=? AND notified_at IS NOT NULL", f.profile)).length, 1);
  assert.equal((await all(h.env, "SELECT id FROM os_tasks WHERE profile_id=? AND order_id=? AND notified_at IS NOT NULL", f.profile, missing.id)).length, 0);
}
export async function integrationPendencies(h: IntegrationHarness) {
  const { f, type, order, c, path } = await customFixture(h);
  const ctx = modulesApi(h.env, f.profile, "os"), conversation = await ctx.conversation(c);
  let inspected = 0;
  const replies: string[] = [];
  const attachmentCtx = { ...ctx, inboundAttachments: async () => { inspected++; return [{ id: "photo" }] as any; }, sendMessage: async (_c: any, message: { text: string }) => { replies.push(message.text); return "id"; } };
  for (const text of ["segue", "Foto do serviço", "Áudio do cliente", "", "documentos anexos"])
    assert.equal(await receiveDocument(attachmentCtx, conversation, { text, rowId: uid(), replyId: null }), false);
  assert.equal(inspected, 0);
  assert.equal(replies.length, 0);
  assert.equal((await all(h.env, "SELECT id FROM os_documents WHERE profile_id=?", f.profile)).length, 0);
  for (const text of ["DOCUMENTO", "DOCUMENTO inválido"]) {
    assert.equal(await receiveDocument(attachmentCtx, conversation, { text, rowId: uid(), replyId: null }), true);
    assert.match(replies.at(-1)!, /número global/);
  }
  assert.equal(replies.length, 2);
  assert.equal((await all(h.env, "SELECT id FROM os_documents WHERE profile_id=?", f.profile)).length, 0);
  const privateDto = await f.call(path + "/private-fields");
  assert.deepEqual(privateDto.fields.map((field: any) => field.id), ["segredo"]);
  await grants(h, f, []);
  assert(!(await f.call(path)).fields.some((field: any) => field.sensitive));
  await grants(h, f, ["os:sensitive", "os:technician"]);
  await f.call(path + "/private-fields", "PATCH", { version: order.version, extra: { segredo: SECRET } });
  const live = await f.call(path);
  assert.deepEqual(live.features, type.features);
  const future = now() + 10000;
  await f.call(path, "PATCH", { version: live.version, assignee: f.actor.id, due_at: future });
  const task = await f.call(path + "/tasks", "POST", { title: "Próxima", due_at: future, audience: "staff", sensitive: false, client_visible: false });
  await f.call(path + "/private-tasks", "POST", { title: SECRET, due_at: future - 1, audience: "staff", sensitive: true, client_visible: false });
  await grants(h, f, []);
  const page = await f.call(`/service-orders?type_id=${type.id}&assignee=me&due_from=${future}&due_to=${future}`);
  assert.equal(page.data[0].next_task.id, task.id);
  assert.equal((await f.call(`/service-orders?assignee=unassigned`)).data.length, 0);
  assert.deepEqual((await f.call(`/service-orders?due_from=${future + 1}`)).counts, page.counts);
  await grants(h, f, ["os:sensitive", "os:technician"]);
  // Revisar o catálogo não muda as capacidades/definições fixadas no detalhe.
  const revision = (await f.call("/service-orders/types")).settings_revision;
  await f.call("/settings", "PUT", { os_work_types: [{ ...type, revision: 2, labels: { ...type.labels, singular: "Novo nome" }, features: { ...type.features, tasks: false, documents: false } }], settings_revision: revision });
  assert.equal((await f.call(path)).type_revision, 1);
  assert.deepEqual((await f.call(path)).features, type.features);
  // Orçamento: versão obsoleta é recusada; clientes antigos continuam aceitos.
  const builtin = await f.call("/service-orders", "POST", { phone: "5511988880001", item: "Item", problem: "Defeito", notify: false });
  const quote = { items: [{ description: "Serviço", quantity: 1, unit_cents: 1000 }] };
  await f.call(`/service-orders/${builtin.id}/quote`, "PUT", { ...quote, version: 999 }, uid(), 409);
  await f.call(`/service-orders/${builtin.id}/quote`, "PUT", quote);
  // A revisão do catálogo não troca nem bloqueia a política de orçamento antigo.
  const quotedArea = await applyRegisteredTemplate(h, "assistencia_tecnica");
  const quotedWork = await create(h, quotedArea);
  const quotedCatalog = await quotedArea.call("/service-orders/types");
  const settings = json((await one(h.env, "SELECT settings FROM profiles WHERE id=?", quotedArea.profile))!.settings);
  await quotedArea.call("/settings", "PUT", {
    settings_revision: quotedCatalog.settings_revision,
    os_work_types: settings.os_work_types.map((current: any) => current.id === quotedWork.type.id
      ? { ...current, revision: current.revision + 1, features: { ...current.features, quote: { ...current.features.quote, default_valid_days: 30 } } } : current),
  });
  const fixed = await quotedArea.call(quotedWork.path);
  assert.equal(fixed.features.quote.default_valid_days, 7);
  assert(fixed.features.quote.source_stages.includes(fixed.stage));
  const quoteKey = uid(), quoteBody = { ...quote, version: fixed.version };
  const savedQuote = await quotedArea.call(quotedWork.path + "/quote", "PUT", quoteBody, quoteKey);
  assert.equal(savedQuote.quote.valid_days, null); // Sem escolha explícita; usa a política ao enviar.
  assert.deepEqual(await quotedArea.call(quotedWork.path + "/quote", "PUT", quoteBody, quoteKey), savedQuote);
  const sentQuote = await quotedArea.call(quotedWork.path + "/quote/send", "POST", { notify: false });
  const validity = sentQuote.quote.valid_until - sentQuote.quote.sent_at;
  assert(validity >= 6 * 86400000 && validity <= 8 * 86400000, "validade continua em sete dias, não trinta");
  // Formulário: seleção 1..32, limite textual e conversão pelo snapshot.
  for (const count of [1, 21, 32]) {
    const formType = structuredClone(type);
    formType.fields = [{ id: "escolha", label: "Opção", help: "", kind: "choice", required: true, sensitive: false, client_visible: true, options: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, label: `Opção ${i}` })) }, { id: "texto", label: "Texto", help: "", kind: "text", max_length: 1500, multiline: false, required: false, sensitive: false, client_visible: true }];
    let captured: any;
    await customOpenForm({ ...ctx, openWebStep: async (_c: any, input: any) => { captured = input; return {} as any; } }, conversation, formType, { actor: f.actor.id, sourceKey: uid(), trigger: "agent" });
    const fields = validateFields(captured.spec.fields);
    assert.equal(fields.find(x => x.id === "extra_escolha")!.options!.length, count);
    assert.equal(fields.find(x => x.id === "extra_texto")!.max_length, 1500);
    const answers = { item: "Item", problem: "Problema", extra_escolha: `${count}. Opção ${count - 1}`, extra_texto: "x".repeat(1500) };
    assert(validateAnswers(fields, answers).ok);
    assert(!validateAnswers(fields, { ...answers, extra_texto: "x".repeat(1501) }).ok);
    assert(formPage({ spec: JSON.stringify({ ...captured.spec, fields }) }, "Teste").includes('maxlength="1500"'));
    const result = await openingAnswers(ctx, { ref_id: captured.ref } as any, answers);
    assert.equal(result!.extra.escolha, `o${count - 1}`);
    const legacyStep = { ref_id: captured.ref, fields: [{ id: "extra_escolha", type: "text" }] } as any;
    assert.equal((await openingAnswers(ctx, legacyStep, { ...answers, extra_escolha: `o${count - 1}` }))!.extra.escolha, `o${count - 1}`);
    await assert.rejects(openingAnswers(ctx, legacyStep, { ...answers, extra_escolha: "id_inexistente" }));
  }
  const legacy = validateFields([{ id: "legacy", label: "Legado", type: "text" }]);
  assert(!validateAnswers(legacy, { legacy: "x".repeat(301) }).ok);
}
export async function templateRecovery(h: IntegrationHarness) {
  const f = await integrationFixture(h), model = areaTemplates.find(t => t.id === "servicos")!;
  const source = { template_id: model.id, selection: selection(model) };
  const preview = await f.call("/area-templates/preview", "POST", source);
  const body = { ...source, preview_hash: preview.preview_hash }, key = uid();
  // Falhar depois do commit da configuração, antes de publicar o primeiro evento.
  await h.env.DB.exec(`CREATE TRIGGER i2_event_failure BEFORE INSERT ON events WHEN NEW.profile_id='${f.profile}' AND NEW.kind='module.changed' BEGIN SELECT RAISE(ABORT,'publication unavailable'); END`);
  const response = await h.fetch(f.request("/area-templates/apply", "POST", body, key));
  assert.equal(response.status, 500);
  const receipt = await one(h.env, "SELECT * FROM os_area_template_receipts WHERE profile_id=?", f.profile);
  assert(receipt); assert.equal(receipt.published, 0);
  await h.env.DB.exec("DROP TRIGGER i2_event_failure");
  const recovered = await f.call("/area-templates/apply", "POST", body, key);
  assert.deepEqual(recovered, json(receipt.result_json));
  assert.equal((await one(h.env, "SELECT published FROM os_area_template_receipts WHERE profile_id=?", f.profile))!.published, 1);
  const events = await all(h.env, "SELECT id FROM events WHERE profile_id=? AND kind='module.changed'", f.profile);
  assert(events.length);
  await f.call("/area-templates/apply", "POST", body, key);
  assert.deepEqual(await all(h.env, "SELECT id FROM events WHERE profile_id=? AND kind='module.changed'", f.profile), events);
  await f.call("/area-templates/apply", "POST", { ...body, preview_hash: "0".repeat(64) }, key, 409);
}
export async function stageNotificationAuthorization(h: IntegrationHarness) {
  const type = motorWorkType();
  type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 24, request_text: "Confirma?" };
  type.stages[1].message = "Etapa autorizada";
  const { f, path, order } = await customFixture(h, type);
  const pending = await f.call(path + "/stage-approval", "POST", { version: order.version, transition_id: "iniciar" });
  const key = await appKey(h, f), idempotency = uid();
  const request = () => new Request(`https://test${f.root}${path}/stage-approval/decision`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json", "Idempotency-Key": idempotency }, body: JSON.stringify({ version: pending.version, approval_version: pending.stage_approval.version, decision: "approve" }) });
  const before = await messages(h, f);
  const response = await h.fetch(request()); assert.equal(response.status, 200);
  assert.equal((await response.json<any>()).stage, "execucao");
  await exec(h.env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", `app:${key.app}:${f.profile}:os.stage.decision`, idempotency);
  const replay = await h.fetch(request()); assert.equal(replay.status, 200);
  assert.deepEqual(await messages(h, f), before);
}

export async function schedulerSerialization(h: IntegrationHarness) {
  const { onSchedule } = await import("../src/modules/api");
  for (const action of ["private", "done", "cancelled", "archive"]) {
    const { f, path, order } = await customFixture(h);
    const at = now() - 1000;
    const task = await f.call(path + "/tasks", "POST", { title: "Lembrete público", audience: "customer", due_at: at, remind_at: at, sensitive: false, client_visible: true });
    let selected!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { selected = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    onSchedule("os", async (ctx) => {
      if (ctx.profile !== f.profile) return;
      // Pausa após a seleção SQL real, antes da projeção/enfileiramento.
      const raw = new WeakMap<object, D1PreparedStatement>();
      const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
        const proxy = new Proxy(statement, { get(target, property) {
          if (property === "bind") return (...args: any[]) => wrap(target.bind(...args), sql);
          if (property === "all" && sql.includes("SELECT t.* FROM os_tasks")) return async () => { const result = await target.all(); selected(); await paused; return result; };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } }); raw.set(proxy, statement); return proxy;
      };
      const DB = new Proxy(ctx.env.DB, { get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch") return (items: D1PreparedStatement[]) => target.batch(items.map(x => raw.get(x) ?? x));
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      let remaining = 200;
      await runTaskDue(modulesApi({ ...ctx.env, DB }, ctx.profile, "os"), { now: now(), limit: 10, budget: { get remaining() { return remaining; }, consume(n) { remaining -= n; } } });
      // O teste termina na inclusão durável; não aciona o provedor de WhatsApp.
      await exec(h.env, "UPDATE outbox SET status='sent',completion_handled=1 WHERE profile_id=?", f.profile);
    });
    const alarm = h.alarm(f.profile);
    await entered;
    const stub = h.env.COORDINATOR.get(h.env.COORDINATOR.idFromName(f.profile));
    const operation = action === "private" ? "os.private.task.update" : action === "archive" ? "os.task.archive" : "os.task.update";
    const data = { id: order.id, task_id: task.id, version: task.version, ...(action === "private" ? { sensitive: true, client_visible: false, audience: "staff" } : action === "archive" ? {} : { state: action }) };
    const before = (await messages(h, f)).length;
    try {
      // O Coordinator aceita o comando com a rodada dos módulos parada entre a
      // seleção e o envio (sem blockConcurrencyWhile em volta da rodada).
      const result = await stub.fetch("https://coordinator/command", { method: "POST", body: JSON.stringify({ profile: f.profile, actor: f.actor, operation, data, key: uid(), requestId: uid() }) });
      assert.equal(result.status, 200, await result.text());
      release();
      await alarm;
      // A reserva condicionada à versão lida recusa a tarefa alterada: nada
      // vai ao cliente. (Reclassificada para a equipe, ela pode ser avisada à
      // equipe pela rodada normal, só por evento, sem texto.)
      const sent = (await messages(h, f)).slice(before).filter(r => String(json(r.payload).text || "").includes("Lembrete público"));
      assert.deepEqual(sent, [], `${action}: lembrete enviado depois da alteração`);
      if (action !== "private") {
        const row = await one(h.env, "SELECT notified_at FROM os_tasks WHERE profile_id=? AND id=?", f.profile, task.id);
        assert.equal(row!.notified_at, null, `${action}: tarefa encerrada marcada como avisada`);
      }
    } finally {
      release();
      onSchedule("os", async (ctx, tick) => { await runDue(ctx, tick.now); });
    }
  }
}

async function portal(h: IntegrationHarness, f: IntegrationFixture, conversationId: string, module: string, menu: string) {
  await exec(h.env, "INSERT INTO instance_settings(key,value,updated) VALUES('public_origin','https://test',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", now());
  const ctx = modulesApi(h.env, f.profile, module), c = await ctx.conversation(conversationId);
  await menuHandler(menu)!(h.env, c, { type: menu }, uid());
  const outbox = await messages(h, f);
  const text = outbox.map(r => json(r.payload).text).reverse().find(text => text?.includes(`#`));
  assert(text && !text.includes(SECRET));
  const code = text.match(/#([2-9A-HJ-NP-Za-km-np-z]{32})/)![1];
  const response = await h.fetch(new Request("https://test/api/credentials/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Responsável", device: "I2" }) }));
  assert.equal(response.status, 200, await response.clone().text());
  const claim = await response.json<any>();
  assert(!JSON.stringify(claim.data).includes(SECRET));
  return { subject: claim.subject, get: async (path: string) => {
    const response = await h.fetch(new Request(`https://test${f.root}${path}`, { headers: { Authorization: `Bearer ${claim.token}` } }));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json<any>();
  } };
}

export const clinicalChannels = ["WhatsApp", "rota pública", "exportação comum", "evento de integração", "histórico da ordem", "ferramenta de bot", "chamada de IA", "administrador sem papel", "anexo e auditoria"] as const;
export async function clinicalChannel(h: IntegrationHarness, channel: typeof clinicalChannels[number]) {
  const f = await base(h, "clinica_medica", "saude", ["os:sensitive", "saude:clinical_read", "saude:clinical_write"]);
  const { order, path } = await create(h, f);
  const subject = await f.call("/saude/subjects", "POST", { kind: "human", name: SECRET });
  const root = `/saude/subjects/${subject.id}`;
  const episode = await f.call(root + "/episodes", "POST", { order_id: order.id });
  const record = await f.call(root + "/records", "POST", { episode_id: episode.id, kind: "evolution", text: SECRET });
  const safe = (value: unknown) => assert(!JSON.stringify(value).includes(SECRET));
  if (channel === "WhatsApp") safe(await messages(h, f));
  if (channel === "rota pública") {
    for (const url of [`https://test/api/public/saude/subjects/${subject.id}/export`, `https://test/api/v1/profiles/${f.profile}${root}/records`]) {
      const response = await h.fetch(new Request(url)); assert.notEqual(response.status, 200); safe(await response.text());
    }
  }
  if (channel === "exportação comum") safe(await f.call("/area-templates/export", "POST", { id: "sem_prontuario", name: "Definição administrativa", type_ids: [order.type_id] }));
  if (channel === "evento de integração") {
    const rows = await all(h.env, "SELECT kind,payload FROM events WHERE profile_id=?", f.profile);
    safe(rows); assert(!JSON.stringify(rows).includes(record.id));
  }
  if (channel === "histórico da ordem") { const history = await f.call(path + "/history"); safe(history); assert(!JSON.stringify(history).includes(record.id)); }
  if (channel === "ferramenta de bot") {
    assert.equal(moduleMcpTools().some(t => t.module === "saude"), false);
    resetCatalogCache(); assert.equal(fullCatalog().some(t => t.module === "saude"), false);
  }
  if (channel === "chamada de IA") {
    const ctx = modulesApi(h.env, f.profile, "saude");
    for (const actor of [{ ...f.actor, bots: ["bot"] }, ...[true, false].map(masked => ({ ...f.actor, via: { kind: "bot" as const, bot_id: "bot", run_id: "run", masked } }))]) {
      for (const r of saudeExtension.binaryReads) await assert.rejects(r.handler(ctx, actor, { params: { subject_id: subject.id, order_id: order.id }, query: {}, request: new Request("https://test") }), (e: any) => e.status === 403);
      for (const c of saudeExtension.commands) await assert.rejects(c.handler(ctx, actor, { subject_id: subject.id }, { requestId: uid() }), (e: any) => e.status === 403);
      await assert.rejects(saudeExtension.binaryUploads[0].handler.authorize(ctx, actor, { params: { subject_id: subject.id }, query: {}, request: new Request("https://test") }), (e: any) => e.status === 403);
    }
  }
  if (channel === "administrador sem papel") {
    for (const roles of [[], ["os:sensitive"], ["saude:responsible"]]) {
      await grants(h, f, roles);
      for (const read of [root, root + "/records", root + "/export", root + "/attachments"]) await f.call(read, "GET", undefined, uid(), 403);
    }
  }
  if (channel === "anexo e auditoria") {
    const attachment = await f.call(root + "/attachments", "POST", { episode_id: episode.id, name: SECRET + ".txt", mime_type: "text/plain", expected_bytes: new TextEncoder().encode(SECRET).byteLength });
    const url = `https://test${f.root}${root}/attachments/${attachment.id}/content`;
    const upload = await h.fetch(new Request(url, { method: "PUT", headers: { Authorization: `Bearer ${f.token}`, "Idempotency-Key": uid(), "Upload-Version": "1", "Content-Type": "text/plain" }, body: SECRET }));
    assert.equal(upload.status, 200, await upload.text());
    const download = await h.fetch(new Request(url, { headers: { Authorization: `Bearer ${f.token}` } }));
    assert.equal(await download.text(), SECRET);
    assert.equal(download.headers.get("Cache-Control"), "no-store");
    assert(await one(h.env, "SELECT id FROM saude_access_audit WHERE profile_id=? AND actor=? AND action='attachment.download'", f.profile, f.actor.id));
    assert.equal((await f.call(path + "/documents")).data.length, 0);
    const exported = await h.fetch(f.request(root + "/export"));
    assert((await exported.text()).includes(btoa(SECRET)));
    assert(await one(h.env, "SELECT id FROM saude_access_audit WHERE profile_id=? AND action='export.complete'", f.profile));
  }
}
