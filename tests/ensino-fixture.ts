import { env } from "cloudflare:test";
import { exec } from "../src/db";
import { modules } from "../src/modules/registry";
import type { ModuleDefinition } from "../src/modules/types";
import { modulesApi, onRead, onCommand, onRoute, onConversationAction, onMcpTool, onMenuChoice, onCredentialClaim } from "../src/modules/api";
import { ensinoModule } from "../src/modules/ensino/definition";
import { ensinoReads, ensinoWrites, ensinoCommands, ensinoTool, requestAccess, customerAction, claimAccess } from "../src/modules/ensino/ensino";
import { peopleExtension } from "../src/modules/os/people/extension";
import { motorFixture, motorOrder, motorWorkType } from "./os-motor-fixture";
import { defaultRule } from "../src/modules/ensino/model";
import { createClass, enroll, grantGuardian } from "../src/modules/ensino/store";
import { now, uid, type Actor } from "../src/types";
import { perform } from "../src/service";

// Registros exclusivamente locais aos testes: nenhum arquivo de produção é alterado.
export function installEnsinoTest() {
  const added = !modules.some(m => m.id === "ensino");
  if (added) (modules as ModuleDefinition[]).push(ensinoModule);
  for (const r of ensinoReads) onRead("ensino", r.path, r.handler, r.options);
  for (const r of ensinoWrites) onRoute("ensino", r);
  for (const r of ensinoCommands) onCommand("ensino", r.op, r.handler);
  for (const r of peopleExtension.reads) onRead("os", r.path, r.handler);
  onConversationAction("ensino", "ensino_boletim", (ctx, a, c, d, r) => customerAction(ctx, a, c, d, r.requestId));
  onMenuChoice("ensino_boletim", async (ctx, c, _item, r) => { await requestAccess(ctx, c, `menu:${r.rowId}`); });
  onMcpTool("ensino", ensinoTool);
  onCredentialClaim("ensino", claimAccess);
  return () => { if (added) (modules as ModuleDefinition[]).splice(modules.findIndex(m => m.id === "ensino"), 1); };
}
export async function schoolFixture() {
  const f = await motorFixture();
  const secretary: Actor = { ...f.member, access: ["*", "ensino:secretaria", "os:sensitive"] };
  const professor: Actor = { ...f.other, access: ["ensino:professor"] };
  for (const a of [secretary, professor]) await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(a.access), a.id);
  await perform(env, f.admin, f.profile, "module.set", { id: "ensino", enabled: true }, uid());
  const type = motorWorkType();
  type.id = "matricula"; type.features.customer_open = false; type.fields = type.fields.filter(f => f.sensitive);
  type.labels.customer_singular = "Aluno";
  await exec(env, "UPDATE profiles SET settings=json_set(settings,'$.os_work_types',json(?)) WHERE id=?", JSON.stringify([type]), f.profile);
  const order = await motorOrder(f, { customer_name: "Ana", item: "Matrícula", problem: "Atendimento escolar" });
  await exec(env, "UPDATE os_orders SET type_id=?,type_snapshot_json=?,stage=? WHERE profile_id=? AND id=?", type.id, JSON.stringify({ schema_version: 1, type }), "entrada", f.profile, order.id);
  const ctx = modulesApi(env, f.profile, "ensino");
  const input = { name: "Turma A", school_year: "2025", start_date: "2025-01-01", end_date: "2025-12-31", teacher_id: professor.id, type_id: type.id, capacity: 2,
    schedule: [{ day: 1, start: "08:00", end: "09:00" }], periods: [{ id: "p1", name: "1º período", start: "2025-01-01", end: "2025-06-30" }], rule: defaultRule, justified_counts: false };
  const classroom = await createClass(ctx, secretary, input, uid());
  const student = await enroll(ctx, secretary, { id: classroom.id, version: 1, order_id: order.id, start_date: input.start_date, end_date: input.end_date }, uid());
  return { ...f, ctx, secretary, professor, input, classroom, student, order, type };
}
export type SchoolFixture = Awaited<ReturnType<typeof schoolFixture>>;
export async function linkedGuardian(f: SchoolFixture, version = 2, phone = "5511988887777") {
  const personId = uid();
  await exec(env, `INSERT INTO os_people(id,profile_id,order_id,role,name,phone,sensitive,client_visible,created_by,created,updated)
    VALUES(?,?,?,?,?,?,1,0,?,?,?)`, personId, f.profile, f.order.id, "Responsável", "Maria", phone, f.secretary.id, now(), now());
  const grant = await grantGuardian(f.ctx, f.secretary, { id: f.classroom.id, version, enrollment_id: f.student.id, person_id: personId,
    valid_until: "2099-12-31", identity_confirmed: true }, uid());
  return { personId, grant, phone };
}
