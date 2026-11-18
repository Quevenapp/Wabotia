import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import * as db from "../src/db";
import { perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { modules } from "../src/modules/registry";
import { osModule } from "../src/modules/os/definition";
import * as motor from "../src/modules/os/public";
import { projectChildForBot, projectChildForCustomer } from "../src/modules/os/privacy";
import { listTasks } from "../src/modules/os/tasks/store";
import { juridicoModule } from "../src/modules/juridico/definition";
import { juridicoReads, juridicoWrites, juridicoCommands } from "../src/modules/juridico/juridico";
import { listCalendars, saveCalendar } from "../src/modules/juridico/calendars";
import { createDeadline, changeDeadline, deadlineDetail, deadlineRow, deadlineView, listDeadlines, previewDeadline, recalculate } from "../src/modules/juridico/store";
import { acknowledge, listAlerts, runJuridicoDue } from "../src/modules/juridico/scheduler";
import type { Calendar, Rule } from "../src/modules/juridico/model";
import { motorFixture, motorOrder, motorWorkType, MOTOR_SENTINEL } from "./os-motor-fixture";
import { receive } from "./service-center-fixture";
import { countingEnv } from "./d1-counter";

// Registro exclusivamente local ao teste: nenhum arquivo de integração alterado.
const events = osModule.events, grants = osModule.grants;
let addedModule = false;
beforeAll(() => {
  if (!modules.some(m => m.id === "juridico")) { (modules as typeof juridicoModule[]).push(juridicoModule); addedModule = true; }
  osModule.events = [...new Set([...events, "os.task.created", "os.task.updated"])];
  osModule.grants = [...(grants ?? []).filter(g => g.id !== "sensitive"), { id: "sensitive", label: "Sensível", description: "Teste" }];
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  osModule.events = events; osModule.grants = grants;
  if (addedModule) (modules as typeof juridicoModule[]).splice(modules.indexOf(juridicoModule), 1);
});

const calendar = (): Calendar => ({ name: "Calendário local", jurisdiction: "Unidade de teste", from: "2026-01-01", to: "2027-12-31", timezone: "America/Sao_Paulo", weekend: [0, 6], events: [] });
const rule = (): Rule => ({ start_date: "2026-11-16", days: 5, include_start: false, start_non_working: "next", due_non_working: "next", due_time: "18:00", alert_days: 2, alert_time: "09:00" });
function budget(size = 200) {
  let remaining = size;
  return { get remaining() { return remaining; }, consume(n: number) { expect(n).toBeLessThanOrEqual(remaining); remaining -= n; } };
}
async function setup() {
  const f = await motorFixture();
  await perform(env, f.admin, f.profile, "module.set", { id: "juridico", enabled: true }, uid());
  const lawyer: Actor = { ...f.member, access: ["*", "os:sensitive", "juridico:lawyer", "juridico:curator"] };
  await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(lawyer.access), lawyer.id);
  const ctx = modulesApi(env, f.profile, "juridico");
  const order = await motorOrder(f);
  const type = motorWorkType();
  await exec(env, "UPDATE os_orders SET type_id=?,type_snapshot_json=?,stage=?,type_number=1 WHERE profile_id=? AND id=?", type.id, JSON.stringify({ schema_version: 1, type }), type.initial_stage, f.profile, order.id);
  const cal = await saveCalendar(ctx, lawyer, { calendar: calendar(), seed_national: false }, uid());
  const body = { order_id: order.id, calendar_id: cal.id, calendar_revision: cal.revision, assignee: lawyer.id, title: MOTOR_SENTINEL, rule: rule() };
  const create = (changes = {}, key = uid(), actor = lawyer) => createDeadline(ctx, actor, { ...body, ...changes }, key);
  return { f, ctx, lawyer, order, cal, body, create };
}

describe("jurídico: declaração e acesso", () => {
  it("exige os, vem desligado, não expõe menu ou rota de cliente nem ferramenta IA", () => {
    expect(juridicoModule.requires).toEqual(["os"]); expect(juridicoModule.default_enabled).toBe(false);
    expect(juridicoModule.menu_item_types).toEqual([]); expect(juridicoModule.bot).toMatchObject({ deny: ["juridico", "juridico."], sensitive: ["juridico."] });
    expect(juridicoWrites.every(w => juridicoCommands.some(c => c.op === w.op))).toBe(true);
    expect(juridicoReads.every(r => r.path.startsWith("juridico/"))).toBe(true);
  });
  it("não concede papéis implicitamente a administrador; recusa bot mascarado ou não, aplicação, conector e credencial", async () => {
    const s = await setup();
    const actors: Actor[] = [s.f.admin, { ...s.lawyer, access: ["juridico:lawyer"] }, { ...s.lawyer, access: ["os:sensitive"] },
      { ...s.lawyer, id: "bot:teste" }, { ...s.lawyer, kind: "app" }, { ...s.lawyer, kind: "connector" },
      { ...s.lawyer, via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } },
      { ...s.lawyer, via: { kind: "bot", bot_id: "b", run_id: "r", masked: true } },
      { ...s.lawyer, credential: { id: "c", module: "juridico", subject: "x" } }];
    for (const actor of actors) {
      await expect(listDeadlines(s.ctx, actor)).rejects.toMatchObject({ status: 403 });
      await expect(s.create({}, uid(), actor)).rejects.toMatchObject({ status: 403 });
    }
    await expect(saveCalendar(s.ctx, { ...s.lawyer, access: ["os:sensitive", "juridico:lawyer"] }, { calendar: calendar() }, uid())).rejects.toMatchObject({ status: 403 });
  });
  it("módulo desligado, dependência desligada e tarefas desabilitadas bloqueiam operações", async () => {
    const s = await setup();
    await perform(env, s.f.admin, s.f.profile, "module.set", { id: "juridico", enabled: false }, uid());
    await expect(s.create()).rejects.toMatchObject({ code: "module_disabled" });
    await perform(env, s.f.admin, s.f.profile, "module.set", { id: "juridico", enabled: true }, uid());
    const type = motorWorkType(); type.features.tasks = false;
    await exec(env, "UPDATE os_orders SET type_snapshot_json=? WHERE profile_id=? AND id=?", JSON.stringify({ schema_version: 1, type }), s.f.profile, s.order.id);
    await expect(s.create()).rejects.toMatchObject({ code: "feature_disabled" });
    await perform(env, s.f.admin, s.f.profile, "module.set", { id: "os", enabled: false, cascade: true }, uid());
    await expect(listCalendars(s.ctx, s.lawyer)).rejects.toMatchObject({ code: "module_disabled" });
  });
});

describe("jurídico: tarefas, calendário e privacidade", () => {
  it("cria tarefa sensível, memória reproduzível e repete sem duplicar", async () => {
    const s = await setup(), key = uid();
    const first = await s.create({}, key); expect(await s.create({}, key)).toEqual(first);
    const detail = await deadlineDetail(s.ctx, s.lawyer, first.id);
    expect(detail).toMatchObject({ review: "pending", sensitive: true, client_visible: false, version: 1 });
    expect(detail!.memory.trace.filter((d: any) => d.phase === "count" && d.counted)).toHaveLength(5);
    expect(await one(env, "SELECT * FROM os_tasks WHERE profile_id=? AND id=?", s.f.profile, first.task_id)).toMatchObject({ due_at: detail!.due_at, sensitive: 1, client_visible: 0, remind_at: null, audience: "staff", assignee: s.lawyer.id });
    expect(await all(env, "SELECT id FROM jur_deadlines WHERE profile_id=?", s.f.profile)).toHaveLength(1);
    const h = await all(env, "SELECT * FROM os_history WHERE profile_id=? AND entity_id=?", s.f.profile, first.task_id);
    expect(h).toHaveLength(1); expect(JSON.stringify(h)).not.toContain(MOTOR_SENTINEL);
    expect(JSON.stringify(await all(env, "SELECT payload FROM events WHERE profile_id=?", s.f.profile))).not.toContain(MOTOR_SENTINEL);
  });
  it("não permite calendário, processo, prazo, memória, responsável ou cursor de outra área", async () => {
    const s = await setup(), other = await setup(), first = await s.create();
    await expect(other.create({ order_id: s.order.id })).rejects.toMatchObject({ status: 404 });
    await expect(other.create({ calendar_id: s.cal.id })).rejects.toMatchObject({ status: 404 });
    await expect(other.create({ assignee: s.lawyer.id })).rejects.toMatchObject({ code: "invalid_assignee" });
    await expect(deadlineDetail(other.ctx, other.lawyer, first.id)).rejects.toMatchObject({ status: 404 });
    expect((await listDeadlines(other.ctx, other.lawyer)).data).toEqual([]);
    expect((await listCalendars(other.ctx, other.lawyer)).data.some(c => c.id === s.cal.id)).toBe(false);
    await expect(s.create({ profile_id: other.f.profile })).rejects.toMatchObject({ status: 400 });
  });
  it("o cliente vê somente filhos públicos do telefone verificado; prazos jurídicos nunca aparecem", async () => {
    const s = await setup(), first = await s.create();
    const own = await receive(s.f, s.f.line, "olá", "5511960010203");
    const stranger = await receive(s.f, s.f.line, "olá", "5511960019999");
    expect((await listTasks(s.f.ctx, s.f.member, s.order.id, {}, own.id)).data).toEqual([]);
    await expect(listTasks(s.f.ctx, s.f.member, s.order.id, {}, stranger.id)).rejects.toMatchObject({ status: 404 });
    const dto = deadlineView(await deadlineRow(s.ctx, first.id));
    expect(projectChildForCustomer(dto)).toBeNull(); expect(projectChildForBot(dto)).toBeNull();
  });
  it("guarda cada revisão e marca a carga nacional; calendário antigo e versão vencida são recusados", async () => {
    const s = await setup(), key = uid();
    const seeded = await saveCalendar(s.ctx, s.lawyer, { calendar: calendar(), seed_national: true }, key);
    expect(await saveCalendar(s.ctx, s.lawyer, { calendar: calendar(), seed_national: true }, key)).toMatchObject(seeded);
    const view = (await listCalendars(s.ctx, s.lawyer)).data.find(c => c.id === seeded.id)!;
    expect(view.calendar.events).toHaveLength(18); expect(view.seed_warning).toContain("Confira antes de usar");
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: { ...calendar(), name: "Revisão" } }, uid());
    await expect(s.create()).rejects.toMatchObject({ code: "version_conflict" });
    await expect(saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: calendar() }, uid())).rejects.toMatchObject({ code: "version_conflict" });
    expect(await all(env, "SELECT revision FROM jur_calendar_versions WHERE profile_id=? AND calendar_id=?", s.f.profile, s.cal.id)).toHaveLength(2);
  });
  it("recálculo posterior mantém a data mais cedo, avisa e só prorroga depois de conferência", async () => {
    const s = await setup(), first = await s.create(), old = await deadlineRow(s.ctx, first.id);
    const updated = { ...calendar(), events: [{ id: "feriado", name: "Feriado de teste", from: "2026-11-17", to: "2026-11-17", kind: "court" as const, effect: "all" as const, source: "Fonte informada" }] };
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: updated }, uid());
    await expect(changeDeadline(s.ctx, s.lawyer, { id: first.id, version: 1, task_version: 1, checked: true }, uid(), "confirm")).rejects.toMatchObject({ code: "version_conflict" });
    await recalculate(s.ctx, old, now());
    const row = await deadlineRow(s.ctx, first.id);
    expect(row).toMatchObject({ revision: 2, due_at: old.due_at, previous_due_at: old.due_at, review: "pending" });
    expect(row.calculated_due_at).toBeGreaterThan(old.due_at);
    expect((await listAlerts(s.ctx, s.lawyer)).data[0].kind).toBe("recalculated");
    expect((await deadlineDetail(s.ctx, s.lawyer, first.id))!.calendar_changes.join(" ")).toContain("Feriado de teste");
    const key = uid(), body = { id: row.id, version: row.revision, task_version: row.task_version, checked: true };
    const ref = await changeDeadline(s.ctx, s.lawyer, body, key, "confirm");
    expect(await changeDeadline(s.ctx, s.lawyer, body, key, "confirm")).toEqual(ref);
    expect(await deadlineRow(s.ctx, row.id)).toMatchObject({ due_at: row.calculated_due_at, review: "confirmed", confirmed_by: s.lawyer.id });
    expect((await deadlineDetail(s.ctx, s.lawyer, row.id, "1"))!.memory.due_at).toBe(old.due_at);
  });
  it("recálculo anterior antecipa a tarefa e mudança sem cobertura preserva data e exige revisão", async () => {
    const s = await setup();
    const c = { ...calendar(), events: [{ id: "f", name: "Feriado", from: "2026-11-17", to: "2026-11-17", kind: "court" as const, effect: "all" as const, source: "Fonte" }] };
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: c }, uid());
    const first = await s.create({ calendar_revision: 2 }), old = await deadlineRow(s.ctx, first.id);
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 2, calendar: calendar() }, uid());
    await recalculate(s.ctx, old, now());
    const earlier = await deadlineRow(s.ctx, first.id); expect(earlier.due_at).toBeLessThan(old.due_at);
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 3, calendar: { ...calendar(), to: "2026-11-17" } }, uid());
    await recalculate(s.ctx, earlier, now());
    const failed = await deadlineRow(s.ctx, first.id);
    expect(failed).toMatchObject({ due_at: earlier.due_at, review: "error", error_code: "calendar_coverage" });
    await expect(changeDeadline(s.ctx, s.lawyer, { id: first.id, version: failed.revision, task_version: failed.task_version, checked: true }, uid(), "confirm")).rejects.toMatchObject({ code: "version_conflict" });
  });
  it("cumprimento exige referência e nunca é recalculado, reaberto ou reprogramado", async () => {
    const s = await setup(), first = await s.create();
    const input = { id: first.id, version: 1, task_version: 1 };
    await expect(changeDeadline(s.ctx, s.lawyer, input, uid(), "complete")).rejects.toMatchObject({ code: "evidence_required" });
    await changeDeadline(s.ctx, s.lawyer, { ...input, evidence: "Documento conferido" }, uid(), "complete");
    const completed = await deadlineRow(s.ctx, first.id);
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: { ...calendar(), name: "Nova" } }, uid());
    await runJuridicoDue(s.ctx, { now: now() + 999999999, budget: budget(), limit: 10 });
    const preserved = await deadlineRow(s.ctx, first.id);
    expect({ ...preserved, current_calendar_revision: completed.current_calendar_revision }).toEqual(completed);
    await expect(exec(env, "UPDATE os_tasks SET state='open' WHERE profile_id=? AND id=?", s.f.profile, first.task_id)).rejects.toThrow();
  });
  it("protege data, sigilo, responsável e arquivo contra alterações genéricas", async () => {
    const s = await setup(), first = await s.create();
    for (const set of ["due_at=due_at+1", "sensitive=0", "client_visible=1", "assignee=NULL", "archived_at=1"])
      await expect(exec(env, `UPDATE os_tasks SET ${set} WHERE profile_id=? AND id=?`, s.f.profile, first.task_id)).rejects.toThrow();
    await expect(exec(env, "DELETE FROM os_tasks WHERE profile_id=? AND id=?", s.f.profile, first.task_id)).rejects.toThrow();
    expect(await one(env, "SELECT state FROM os_tasks WHERE profile_id=? AND id=?", s.f.profile, first.task_id)).toMatchObject({ state: "open" });
  });
  it("falha no lote desfaz tarefa e prazo juntos", async () => {
    const s = await setup(), original = motor.commitChild;
    vi.spyOn(motor, "commitChild").mockImplementation((ctx, actor, order, mutation) => original(ctx, actor, order, { ...mutation, statements: [...mutation.statements, ["SELECT json('falha_injetada')", []]] }));
    await expect(s.create()).rejects.toThrow();
    expect(await all(env, "SELECT id FROM jur_deadlines WHERE profile_id=?", s.f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM os_tasks WHERE profile_id=?", s.f.profile)).toEqual([]);
  });
  it("prévia não grava; listas ordenam e paginam sem mudar o escopo", async () => {
    const s = await setup();
    await previewDeadline(s.ctx, s.lawyer, { calendar_id: s.cal.id, calendar_revision: 1, rule: rule() });
    expect(await all(env, "SELECT id FROM os_tasks WHERE profile_id=?", s.f.profile)).toEqual([]);
    for (let i = 0; i < 11; i++) await s.create({ rule: { ...rule(), days: i + 1 } });
    const page = await listDeadlines(s.ctx, s.lawyer); expect(page.data).toHaveLength(10); expect(page.next_cursor).toBeTruthy();
    expect((await listDeadlines(s.ctx, s.lawyer, { cursor: page.next_cursor! })).data).toHaveLength(1);
    await expect(listDeadlines(s.ctx, s.lawyer, { sort: "process", cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    for (const sort of ["due", "assignee", "process"]) expect((await listDeadlines(s.ctx, s.lawyer, { sort, order_id: s.order.id, assignee: s.lawyer.id })).data).toHaveLength(10);
  });
});

describe("jurídico: avisos internos e orçamento", () => {
  it("entrega para o responsável na antecedência, deduplica e restringe o reconhecimento", async () => {
    const s = await setup(), first = await s.create(), row = await deadlineRow(s.ctx, first.id);
    await runJuridicoDue(s.ctx, { now: row.alert_at - 1, budget: budget(), limit: 10 });
    expect((await listAlerts(s.ctx, s.lawyer)).data).toEqual([]);
    await runJuridicoDue(s.ctx, { now: row.alert_at, budget: budget(), limit: 10 });
    await runJuridicoDue(s.ctx, { now: row.alert_at, budget: budget(), limit: 10 });
    const alerts = (await listAlerts(s.ctx, s.lawyer)).data; expect(alerts).toHaveLength(1); expect(alerts[0].kind).toBe("fatal");
    expect(JSON.stringify(alerts)).not.toContain(MOTOR_SENTINEL);
    const other = { ...s.f.other, access: s.lawyer.access };
    expect((await listAlerts(s.ctx, other)).data).toEqual([]);
    await expect(acknowledge(s.ctx, other, alerts[0].id)).rejects.toMatchObject({ status: 404 });
    await acknowledge(s.ctx, s.lawyer, alerts[0].id);
    expect((await listAlerts(s.ctx, s.lawyer)).data).toEqual([]);
    expect((await deadlineRow(s.ctx, first.id)).state).toBe("open");
  });
  it("não excede dez itens ou 200 instruções e continua o restante", async () => {
    const s = await setup();
    for (let i = 0; i < 11; i++) await s.create();
    const counted = countingEnv(env), ctx = modulesApi(counted.env, s.f.profile, "juridico"), b = budget();
    const first = await runJuridicoDue(ctx, { now: Date.parse("2027-01-01"), budget: b, limit: 10 });
    expect(first).toMatchObject({ processed: 10, has_more: true });
    expect(counted.count.statements).toBe(200 - b.remaining); expect(counted.count.statements).toBeLessThanOrEqual(200);
    expect(await runJuridicoDue(ctx, { now: Date.parse("2027-01-01"), budget: budget(), limit: 10 })).toMatchObject({ processed: 1, has_more: false });
    expect(await runJuridicoDue(ctx, { now: now(), budget: budget(0), limit: 10 })).toEqual({ processed: 0, has_more: true });
  });
  it("retoma falha de entrega sem marcar aviso e não repete depois de inserir", async () => {
    const s = await setup(), first = await s.create(), row = await deadlineRow(s.ctx, first.id);
    const original = db.exec;
    const failure = vi.spyOn(db, "exec").mockImplementation((environment, sql, ...args) => {
      if (sql.includes("INSERT OR IGNORE INTO jur_alerts")) throw new Error("falha de D1 simulada");
      return original(environment, sql, ...args);
    });
    expect(await runJuridicoDue(s.ctx, { now: row.alert_at, budget: budget(), limit: 10 })).toMatchObject({ has_more: true });
    expect((await listAlerts(s.ctx, s.lawyer)).data).toEqual([]);
    failure.mockRestore();
    await runJuridicoDue(s.ctx, { now: row.alert_at, budget: budget(), limit: 10 });
    await runJuridicoDue(s.ctx, { now: row.alert_at, budget: budget(), limit: 10 });
    expect((await listAlerts(s.ctx, s.lawyer)).data).toHaveLength(1);
  });
  it("mede também o SQL do motor durante recálculos e continua entre rodadas", async () => {
    const s = await setup();
    for (let i = 0; i < 11; i++) await s.create();
    await saveCalendar(s.ctx, s.lawyer, { id: s.cal.id, revision: 1, calendar: { ...calendar(), name: "Revisão para lote" } }, uid());
    for (let round = 0; round < 6; round++) {
      const counted = countingEnv(env), b = budget();
      const result = await runJuridicoDue(modulesApi(counted.env, s.f.profile, "juridico"), { now: Date.parse("2026-11-16"), budget: b, limit: 10 });
      expect(result.processed).toBeLessThanOrEqual(10);
      expect(counted.count.statements).toBe(200 - b.remaining);
      expect(counted.count.statements).toBeLessThanOrEqual(200);
      if (!result.has_more) break;
    }
    expect(await all(env, "SELECT id FROM jur_deadlines WHERE profile_id=? AND calendar_revision<>2", s.f.profile)).toEqual([]);
    expect(await all(env, "SELECT id FROM jur_alerts WHERE profile_id=? AND kind='recalculated'", s.f.profile)).toHaveLength(11);
  });
});
