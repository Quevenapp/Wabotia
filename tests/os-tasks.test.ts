import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { all, batch, exec, one } from "../src/db";
import { event } from "../src/events";
import { perform, settingsRevision } from "../src/service";
import { modulesApi } from "../src/modules/api";
import * as motor from "../src/modules/os/public";
import type { ChildMutation } from "../src/modules/os/public";
import type { MutationRef } from "../src/modules/os/contracts";
import { tasksExtension } from "../src/modules/os/tasks/extension";
import { taskInput } from "../src/modules/os/tasks/model";
import { budgetedEnv, runTaskDue, TASK_DUE_SQL_RESERVE } from "../src/modules/os/tasks/reminders";
import { createStageTasks } from "../src/modules/os/tasks/stages";
import { createTask, listTasks, updateTask } from "../src/modules/os/tasks/store";
import { ApiError, uid, type Actor } from "../src/types";
import { countingEnv } from "./d1-counter";
import { motorFixture, motorOrder, motorWorkType, MOTOR_SENTINEL } from "./os-motor-fixture";
import { receive, drain } from "./service-center-fixture";

afterEach(() => vi.restoreAllMocks());
const input = { title: "Conferir entrega", audience: "staff", client_visible: false, sensitive: false };
function budget(size = 200) {
  let remaining = size;
  return {
    get remaining() { return remaining; },
    consume(count: number) {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(remaining);
      remaining -= count;
    },
  };
}
const dueContext: typeof modulesApi = (environment, profile, moduleId) => {
  const ctx = modulesApi(environment, profile, moduleId);
  // I ainda não registrou os eventos. Somente este contexto local usa o
  // serviço real de eventos/fan-out sem exigir alteração de definition.ts.
  return { ...ctx, publish: (kind, id, payload, options) => event(environment, profile, kind, id, payload, options?.key) };
};

/** Costura explícita da tarefa M. Mantém autorização F0 e SQL D1 reais.
 * O mock não prova a transação/histórico de M; prova o plano entregue por T,
 * CAS, escopo, recuperação e projeções sem depender de M implementada.
 */
async function setup() {
  const f = await motorFixture();
  // Índice da 0100, ainda ausente na F0. Só nesta fixture local: a migração
  // 0101 permanece exatamente o DDL congelado, dependente de 0100 em produção.
  await exec(env, "CREATE UNIQUE INDEX IF NOT EXISTS os_orders_profile_id ON os_orders(profile_id,id)");
  // M agora existe: o pai persistido precisa corresponder ao tipo simulado.
  // Uma OS embutida tem etapa "received", ausente no tipo "projeto".
  await perform(env, f.admin, f.profile, "settings", {
    os_work_types: [motorWorkType()], settings_revision: await settingsRevision(env, f.profile),
  }, uid());
  const order = await motorOrder(f, { type_id: motorWorkType().id });
  const original = motor.authorizedOrder;
  const stages = new Map<string, { stage: string; version: number }>();
  vi.spyOn(motor, "authorizedOrder").mockImplementation(async (...args) => {
    const authorized = await original(...args);
    const entry = stages.get(authorized.row.id);
    return { row: { ...authorized.row, ...(entry ? { stage: entry.stage, row_version: entry.version } : {}) }, type: motorWorkType() };
  });
  vi.spyOn(motor, "resolveWorkType").mockResolvedValue(motorWorkType());
  const receipts = new Map<string, MutationRef>();
  const effects: Array<{ event: string; fields: string[]; ref: MutationRef }> = [];
  const plans: ChildMutation[] = [];
  let failAfterCommit = false;
  const commit = vi.spyOn(motor, "commitChild").mockImplementation(async (ctx, _actor, parent, mutation) => {
    const replay = receipts.get(mutation.mutation_key);
    if (replay) return replay;
    plans.push(mutation);
    const row = await one(env, "SELECT version FROM os_tasks WHERE profile_id=? AND order_id=? AND id=?", ctx.profile, parent.row.id, mutation.id);
    if ((mutation.expected_version === null && row) || (mutation.expected_version !== null && row?.version !== mutation.expected_version))
      throw new ApiError(409, "version_conflict", "Versão antiga.");
    const results = await batch(ctx.env, mutation.statements);
    if (results[0].meta.changes !== 1) throw new ApiError(409, "version_conflict", "Mutação não aplicada.");
    const ref = { id: mutation.id, order_id: parent.row.id, version: (mutation.expected_version ?? 0) + 1 };
    receipts.set(mutation.mutation_key, ref);
    effects.push({ event: mutation.event, fields: mutation.changed_fields, ref });
    if (failAfterCommit) { failAfterCommit = false; throw new Error("falha após confirmação"); }
    return ref;
  });
  await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["*", "os:technician"]), f.member.id);
  const create = (data: Record<string, unknown> = {}, key = uid(), actor = f.member, privateAccess = false) =>
    createTask(f.ctx, actor, { id: order.id, ...input, ...data }, key, privateAccess);
  const edit = (task: MutationRef, data: Record<string, unknown>, key = uid(), actor = f.member, privateAccess = false) =>
    updateTask(f.ctx, actor, { id: order.id, task_id: task.id, version: task.version, ...data }, key, false, privateAccess);
  const row = (id: string) => one(env, "SELECT * FROM os_tasks WHERE profile_id=? AND order_id=? AND id=?", f.profile, order.id, id);
  return { f, order, stages, create, edit, row, effects, plans, commit, failCommit: () => { failAfterCommit = true; } };
}

describe("tarefas: fundação e descritor", () => {
  it("confirma filho, histórico e atividade pelo motor real e recupera sem duplicar", async () => {
    const f = await motorFixture();
    await perform(env, f.admin, f.profile, "settings", {
      os_work_types: [motorWorkType()], settings_revision: await settingsRevision(env, f.profile),
    }, uid());
    const order = await motorOrder(f, { type_id: motorWorkType().id });
    await exec(env, "UPDATE os_orders SET updated=1,stale_notified_at=1 WHERE profile_id=? AND id=?", f.profile, order.id);
    const data = { id: order.id, ...input };
    const requestId = uid();
    const task = await createTask(f.ctx, f.member, data, requestId);
    expect(task).toMatchObject({ order_id: order.id, version: 1 });
    expect(await one(env, "SELECT title,version FROM os_tasks WHERE profile_id=? AND order_id=? AND id=?", f.profile, order.id, task.id))
      .toEqual({ title: input.title, version: 1 });
    const parent = await one(env, "SELECT updated,stale_notified_at FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id);
    expect(parent.updated).toBeGreaterThan(1);
    expect(parent.stale_notified_at).toBeNull();
    expect(await createTask(f.ctx, f.member, data, requestId)).toEqual(task);
    expect(await one(env, "SELECT updated,stale_notified_at FROM os_orders WHERE profile_id=? AND id=?", f.profile, order.id)).toEqual(parent);
    expect(await all(env, "SELECT id FROM os_tasks WHERE profile_id=? AND order_id=?", f.profile, order.id)).toHaveLength(1);
    const history = await all(env, "SELECT entity_id,entity_version,entity_kind FROM os_history WHERE profile_id=? AND order_id=? AND kind='os.task.created'", f.profile, order.id);
    expect(history).toEqual([{ entity_id: task.id, entity_version: 1, entity_kind: "task" }]);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.task.created'", f.profile)).toHaveLength(1);
  });

  it("preserva o embutido desligado, o isolamento e recusa mutação vazia", async () => {
    const f = await motorFixture();
    const order = await motorOrder(f);
    await expect(listTasks(f.ctx, f.member, order.id)).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(createTask(f.ctx, f.member, { id: order.id, ...input }, uid())).rejects.toMatchObject({ code: "feature_disabled" });
    const other = await motorFixture();
    await expect(listTasks(other.ctx, other.member, order.id)).rejects.toMatchObject({ status: 404 });
    const disabled = await motorFixture({ enabled: false });
    await expect(listTasks(disabled.ctx, disabled.member, order.id)).rejects.toMatchObject({ code: "module_disabled" });
    const authorized = await motor.authorizedOrder(f.ctx, f.member, order.id);
    await expect(motor.commitChild(f.ctx, f.member, authorized, {
      entity_kind: "task", id: uid(), expected_version: null, mutation_key: uid(),
      changed_fields: ["title"], statements: [], event: "os.task.created",
    })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(await all(env, "SELECT id FROM os_tasks WHERE profile_id=?", f.profile)).toEqual([]);
  });

  it("exporta rotas completas, comandos privados e um único runDue sem registrar", () => {
    expect(tasksExtension.id).toBe("tasks");
    expect(tasksExtension.reads.map((read) => read.path)).toEqual([
      "service-orders/my-tasks", "service-orders/conversation/:id/orders/:order_id/tasks", "service-orders/:id/tasks",
    ]);
    expect(tasksExtension.writes.every((route) => tasksExtension.commands.some((command) => command.op === route.op))).toBe(true);
    expect(tasksExtension.runDue).toBe(runTaskDue);
    expect(tasksExtension.tools![0].call({ conversation_id: "c", order_id: "o", state: "open" }, "p")).toEqual({
      path: "/profiles/p/service-orders/conversation/c/orders/o/tasks", query: { state: "open" },
    });
  });
});

describe("tarefas: entrada, versões e ciclo de vida", () => {
  it("cria, edita, conclui, reabre, cancela e arquiva com CAS do filho", async () => {
    const s = await setup();
    let task = await s.create({ title: "  📋 Conferir  ", description: "  Texto  ", assignee: s.f.member.id, due_at: 200, remind_at: 100 });
    expect(await s.row(task.id)).toMatchObject({ title: "📋 Conferir", description: "Texto", version: 1, state: "open" });
    expect(task).toEqual({ id: task.id, order_id: s.order.id, version: 1 });
    const initial = task;
    task = await s.edit(task, { state: "done" });
    expect((await s.row(task.id)).completed_at).toBeGreaterThan(0);
    await expect(s.edit(initial, { title: "antigo" })).rejects.toMatchObject({ code: "version_conflict" });
    task = await s.edit(task, { state: "open" });
    expect(await s.row(task.id)).toMatchObject({ state: "open", completed_at: null, notified_at: null });
    task = await s.edit(task, { state: "cancelled" });
    const archived = await updateTask(s.f.ctx, s.f.member, { id: s.order.id, task_id: task.id, version: task.version }, "archive", true);
    expect(archived.version).toBe(5);
    expect((await s.row(task.id)).archived_at).toBeGreaterThan(0);
    expect((await listTasks(s.f.ctx, s.f.member, s.order.id)).data).toEqual([]);
    await expect(s.edit(archived, { state: "open" })).rejects.toMatchObject({ code: "version_conflict" });
    expect(s.plans.every((plan) => plan.statements[0][0].includes("profile_id") && plan.statements[0][0].includes("order_id"))).toBe(true);
    expect(s.plans.filter((plan) => plan.expected_version !== null).every((plan) => plan.statements[0][0].includes("version=?"))).toBe(true);
    expect(s.effects.flatMap((effect) => effect.fields)).not.toContain("Texto");
  });

  it("recupera criação, atualização e arquivamento após a confirmação", async () => {
    const s = await setup();
    s.failCommit();
    await expect(s.create({}, "create-replay")).rejects.toThrow("falha após confirmação");
    const task = await s.create({}, "create-replay");
    expect(await s.create({}, "create-replay")).toEqual(task);
    s.failCommit();
    await expect(s.edit(task, { state: "done" }, "edit-replay")).rejects.toThrow();
    const done = await s.edit(task, { state: "done" }, "edit-replay");
    expect(done.version).toBe(2);
    const payload = { id: s.order.id, task_id: task.id, version: done.version };
    s.failCommit();
    await expect(updateTask(s.f.ctx, s.f.member, payload, "archive-replay", true)).rejects.toThrow();
    expect((await updateTask(s.f.ctx, s.f.member, payload, "archive-replay", true)).version).toBe(3);
    expect(s.effects).toHaveLength(3);
    expect(await all(env, "SELECT id FROM os_tasks WHERE profile_id=? AND order_id=?", s.f.profile, s.order.id)).toHaveLength(1);
  });

  it("valida Unicode, datas, destinatário, propriedades e responsável da área", async () => {
    const s = await setup();
    expect(taskInput({ ...input, title: "🙂".repeat(160) }).title).toHaveLength(320);
    for (const invalid of [
      { title: " " }, { title: "🙂".repeat(161) }, { description: "x".repeat(4001) }, { description: null },
      { due_at: "200" }, { due_at: -1 }, { due_at: 0.5 }, { due_at: Number.MAX_SAFE_INTEGER },
      { remind_at: 2 }, { due_at: 1, remind_at: 2 }, { audience: "outsider" },
      { audience: "customer" }, { client_visible: 1 }, { assignee: "outra-area" }, { unknown: MOTOR_SENTINEL },
    ]) await expect(s.create(invalid)).rejects.toMatchObject({ code: "invalid_task" });
    const task = await s.create({ due_at: 0, remind_at: 0, assignee: s.f.member.id });
    await expect(s.edit(task, { state: "unknown" })).rejects.toMatchObject({ code: "invalid_task" });
    await expect(s.edit(task, { version: 0, title: "x" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(s.edit(task, {})).rejects.toMatchObject({ code: "invalid_task" });
    expect(s.effects).toHaveLength(1);
  });

  it("limita a 500 incluindo arquivadas e mantém replay no limite", async () => {
    const s = await setup();
    const first = await s.create({}, "limit-replay");
    await exec(env, `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<499)
      INSERT INTO os_tasks(id,profile_id,order_id,title,created_by,created,updated,archived_at)
      SELECT ? || x,?,?,'Arquivo',?,1,1,1 FROM n`, uid(), s.f.profile, s.order.id, s.f.member.id);
    await expect(s.create()).rejects.toMatchObject({ code: "collection_limit" });
    expect(await s.create({}, "limit-replay")).toEqual(first);
  });
});

describe("tarefas: acesso e paginação", () => {
  it("isola área, pai e escopos de leitura/escrita", async () => {
    const s = await setup();
    const task = await s.create();
    const otherOrder = await motorOrder(s.f);
    await expect(updateTask(s.f.ctx, s.f.member, { id: otherOrder.id, task_id: task.id, version: 1, state: "done" }, uid())).rejects.toMatchObject({ status: 404 });
    const other = await motorFixture();
    await expect(listTasks(other.ctx, other.member, s.order.id)).rejects.toMatchObject({ status: 404 });
    const app: Actor = { ...s.f.member, kind: "app", scopes: [] };
    await expect(listTasks(s.f.ctx, app, s.order.id)).rejects.toMatchObject({ status: 403 });
    await expect(s.create({}, uid(), app)).rejects.toMatchObject({ status: 403 });
    await expect(listTasks(s.f.ctx, { ...app, scopes: ["conversations:read"] }, null)).rejects.toMatchObject({ status: 403 });
  });

  it("pagina por created/id, amarra cursor a filtros/área/pai/visão e omite ocultas antes do LIMIT", async () => {
    const s = await setup();
    const sensitiveActor = { ...s.f.member, access: ["*", "os:sensitive"] };
    await s.create({ title: MOTOR_SENTINEL, sensitive: true }, uid(), sensitiveActor, true);
    const first = await s.create({ title: "A", client_visible: true });
    const second = await s.create({ title: "B", client_visible: true });
    await exec(env, "UPDATE os_tasks SET created=1 WHERE profile_id=? AND order_id=?", s.f.profile, s.order.id);
    const page = await listTasks(s.f.ctx, s.f.member, s.order.id, { limit: "1" });
    expect(page.data).toHaveLength(1);
    const next = await listTasks(s.f.ctx, s.f.member, s.order.id, { limit: "1", cursor: page.next_cursor! });
    expect(new Set([...page.data, ...next.data].map((task) => task.id))).toEqual(new Set([first.id, second.id]));
    expect(next.next_cursor).toBeNull();
    expect(JSON.stringify([page, next])).not.toContain(MOTOR_SENTINEL);
    for (const query of [{ state: "done" }, { cursor: "bad" }])
      await expect(listTasks(s.f.ctx, s.f.member, s.order.id, { cursor: page.next_cursor!, ...query })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(listTasks(s.f.ctx, sensitiveActor, s.order.id, { cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    const other = await motorOrder(s.f);
    await expect(listTasks(s.f.ctx, s.f.member, other.id, { cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    for (const query of [{ limit: "101" }, { limit: "1.5" }, { state: "bad" }, { phone: "123" }])
      await expect(listTasks(s.f.ctx, s.f.member, s.order.id, query)).rejects.toMatchObject({ code: "invalid_filter" });
  });

  it("meus prazos usa a pessoa autenticada, vencimento/id e estado aberto por padrão", async () => {
    const s = await setup();
    const late = await s.create({ assignee: s.f.member.id, due_at: 30 });
    const early = await s.create({ assignee: s.f.member.id, due_at: 10 });
    const done = await s.create({ assignee: s.f.member.id, due_at: 5 });
    await s.edit(done, { state: "done" });
    await s.create({ due_at: 1 });
    await s.create({ assignee: s.f.member.id });
    const page = await listTasks(s.f.ctx, s.f.member, null, { limit: "1" });
    expect(page.data.map((task) => task.id)).toEqual([early.id]);
    expect((await listTasks(s.f.ctx, s.f.member, null, { cursor: page.next_cursor! })).data.map((task) => task.id)).toEqual([late.id]);
    expect((await listTasks(s.f.ctx, s.f.other, null)).data).toEqual([]);
    expect((await listTasks(s.f.ctx, s.f.member, null, { state: "done" })).data.map((task) => task.id)).toEqual([done.id]);
    await expect(listTasks(s.f.ctx, s.f.other, null, { cursor: page.next_cursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("cliente vê só suas tarefas públicas e bot/via nunca vê sentinela", async () => {
    const s = await setup();
    const c = await receive(s.f, s.f.line, "oi", "5511960010203");
    await drain(s.f);
    await s.create({ title: "Pública", client_visible: true });
    await s.create({ title: "Interna" });
    const privateActor = { ...s.f.member, access: ["*", "os:sensitive"] };
    await s.create({ title: MOTOR_SENTINEL, description: MOTOR_SENTINEL, sensitive: true }, uid(), privateActor, true);
    const customer = await listTasks(s.f.ctx, s.f.member, s.order.id, {}, c.id);
    expect(customer.data.map((task) => task.title)).toEqual(["Pública"]);
    expect(customer.data[0]).not.toHaveProperty("created_by");
    expect(customer.data[0]).not.toHaveProperty("profile_id");
    const other = await receive(s.f, s.f.line, "oi", "5511960010999");
    await expect(listTasks(s.f.ctx, s.f.member, s.order.id, {}, other.id)).rejects.toMatchObject({ status: 404 });
    for (const actor of [
      { ...privateActor, via: { kind: "bot", bot_id: "b", run_id: "r", masked: false } } as Actor,
      { ...privateActor, id: "bot:test" },
      { ...privateActor, kind: "app", scopes: ["conversations:read", "conversations:write"] } as Actor,
    ]) {
      expect((await listTasks(s.f.ctx, actor, s.order.id)).data.map((task) => task.title)).toEqual(["Pública"]);
      await expect(s.create({ sensitive: true, title: MOTOR_SENTINEL }, uid(), actor, true)).rejects.toMatchObject({ code: "sensitive_forbidden" });
    }
    await expect(s.create({ sensitive: true }, uid(), privateActor)).rejects.toMatchObject({ code: "sensitive_forbidden" });
    expect(JSON.stringify([customer, s.effects])).not.toContain(MOTOR_SENTINEL);
    expect((await listTasks(s.f.ctx, privateActor, s.order.id)).data).toHaveLength(3);
  });
});

describe("tarefas: prazos e recuperação", () => {
  it("avisa antes/no/depois do vencimento uma única vez; reprogramar cria outro aviso", async () => {
    const s = await setup();
    let task = await s.create({ assignee: s.f.member.id, due_at: 200, remind_at: 100 });
    const run = (at: number) => runTaskDue(s.f.ctx, { now: at, budget: budget(), limit: 10 }, dueContext);
    expect(await run(99)).toEqual({ processed: 0, has_more: false });
    expect(await run(100)).toEqual({ processed: 1, has_more: false });
    expect((await s.row(task.id)).notified_at).toBe(100);
    expect((await run(200)).processed).toBe(0);
    expect((await run(201)).processed).toBe(0);
    task = await s.edit(task, { due_at: 400, remind_at: 300 });
    expect((await s.row(task.id)).notified_at).toBeNull();
    expect((await run(401)).processed).toBe(1);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.task.due'", s.f.profile)).toHaveLength(2);
    const atDeadline = await s.create({ due_at: 500, remind_at: 500 });
    expect((await run(499)).processed).toBe(0);
    expect((await run(500)).processed).toBe(1);
    expect((await s.row(atDeadline.id)).notified_at).toBe(500);
  });

  it("ignora concluídas/canceladas/arquivadas e não entrega ao responsável removido", async () => {
    const s = await setup();
    for (const state of ["done", "cancelled"]) {
      const task = await s.create({ due_at: 10, remind_at: 10 });
      await s.edit(task, { state });
    }
    const archived = await s.create({ due_at: 10, remind_at: 10 });
    await updateTask(s.f.ctx, s.f.member, { id: s.order.id, task_id: archived.id, version: 1 }, uid(), true);
    const removed = await s.create({ assignee: s.f.member.id, due_at: 10, remind_at: 10 });
    await exec(env, "UPDATE users SET disabled=1 WHERE id=?", s.f.member.id);
    expect(await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, dueContext)).toEqual({ processed: 1, has_more: false });
    const result = await one(env, "SELECT payload FROM events WHERE profile_id=? AND kind='os.task.due'", s.f.profile);
    expect(JSON.parse(result.payload)).toMatchObject({ id: removed.id, assignee: null, reason: "assignee_unavailable" });
  });

  it("enfileira para o cliente autenticado antes de marcar e recupera falha sem duplicar", async () => {
    const s = await setup();
    const c = await receive(s.f, s.f.line, "oi", "5511960010203");
    await drain(s.f);
    await exec(env, "UPDATE os_orders SET conversation_id=? WHERE profile_id=? AND id=?", c.id, s.f.profile, s.order.id);
    const task = await s.create({ audience: "customer", client_visible: true, assignee: s.f.member.id, due_at: 20, remind_at: 10 });
    const originalExec = db.exec;
    let fail = true;
    vi.spyOn(db, "exec").mockImplementation(async (environment, sql, ...args) => {
      if (fail && sql.includes("SET notified_at")) { fail = false; throw new Error("falha após fila"); }
      return originalExec(environment, sql, ...args);
    });
    expect(await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, dueContext)).toEqual({ processed: 0, has_more: true });
    expect((await s.row(task.id)).notified_at).toBeNull();
    // Texto e responsável interno entre fila e recuperação não duplicam o prazo.
    await s.edit(task, { title: "Conferência revisada", assignee: null });
    expect(await runTaskDue(s.f.ctx, { now: 11, budget: budget(), limit: 10 }, dueContext)).toEqual({ processed: 1, has_more: false });
    const queued = await all(env, "SELECT payload FROM outbox WHERE profile_id=? AND dedupe LIKE '%task-due:%'", s.f.profile);
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].payload).text).toContain(input.title);
    expect((await s.row(task.id)).notified_at).toBe(11);
  });

  it("não marca falha de publicação ou cliente sem conversa", async () => {
    const s = await setup();
    const staff = await s.create({ due_at: 10, remind_at: 10 });
    const customer = await s.create({ audience: "customer", client_visible: true, due_at: 10, remind_at: 10 });
    const failing: typeof modulesApi = (...args) => ({ ...dueContext(...args), publish: async () => { throw new Error(MOTOR_SENTINEL); } });
    expect(await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, failing)).toEqual({ processed: 0, has_more: true });
    expect((await s.row(staff.id)).notified_at).toBeNull();
    expect((await s.row(customer.id)).notified_at).toBeNull();
  });

  it("avança sobre dez clientes sem conversa e volta a tentá-los depois", async () => {
    const s = await setup();
    const blocked = [];
    for (let i = 0; i < 10; i++) blocked.push(await s.create({ audience: "customer", client_visible: true, due_at: 20, remind_at: 1 }));
    const ready = await s.create({ due_at: 20, remind_at: 2 });
    const run = async () => {
      // Recriar o contexto a cada rodada exige que o avanço seja durável.
      const measured = countingEnv(env);
      const allowance = budget();
      const result = await runTaskDue(modulesApi(measured.env, s.f.profile, "os"), { now: 10, budget: allowance, limit: 10 }, dueContext);
      expect(200 - allowance.remaining).toBe(measured.count.statements);
      expect(measured.count.statements).toBeLessThanOrEqual(200);
      return result;
    };
    expect(await run()).toEqual({ processed: 0, has_more: true });
    expect((await run()).processed).toBe(1);
    expect((await s.row(ready.id)).notified_at).toBe(10);
    for (const task of blocked) expect((await s.row(task.id)).notified_at).toBeNull();
    const c = await receive(s.f, s.f.line, "oi", "5511960010203");
    await drain(s.f);
    await exec(env, "UPDATE os_orders SET conversation_id=? WHERE profile_id=? AND id=?", c.id, s.f.profile, s.order.id);
    expect((await run()).processed).toBe(10);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe LIKE '%task-due:%'", s.f.profile)).toHaveLength(10);
    for (const task of blocked) expect((await s.row(task.id)).notified_at).toBe(10);
  });

  it("avança também sobre falhas de publicação e retenta ao completar a volta", async () => {
    const s = await setup();
    const blocked = new Set<string>();
    for (let i = 0; i < 10; i++) blocked.add((await s.create({ due_at: 20, remind_at: 1 })).id);
    await s.create({ due_at: 20, remind_at: 2 });
    const failing: typeof modulesApi = (...args) => {
      const ctx = dueContext(...args);
      return { ...ctx, publish: async (kind, id, ...rest) => {
        if (blocked.has(id)) throw new Error("publicação indisponível");
        return ctx.publish(kind, id, ...rest);
      } };
    };
    expect((await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, failing)).processed).toBe(0);
    expect((await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, failing)).processed).toBe(1);
    expect((await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, dueContext)).processed).toBe(10);
  });

  it("trocar responsável só reinicia avisos à equipe, sem repetir o mesmo aviso ao cliente", async () => {
    const s = await setup();
    const c = await receive(s.f, s.f.line, "oi", "5511960010203");
    await drain(s.f);
    await exec(env, "UPDATE os_orders SET conversation_id=? WHERE profile_id=? AND id=?", c.id, s.f.profile, s.order.id);
    const customer = await s.create({ audience: "customer", client_visible: true, assignee: s.f.member.id, due_at: 20, remind_at: 10 });
    const staff = await s.create({ assignee: s.f.member.id, due_at: 20, remind_at: 10 });
    expect((await runTaskDue(s.f.ctx, { now: 10, budget: budget(), limit: 10 }, dueContext)).processed).toBe(2);
    await s.edit(customer, { assignee: null });
    await s.edit(staff, { assignee: null });
    expect((await s.row(customer.id)).notified_at).toBe(10);
    expect((await s.row(staff.id)).notified_at).toBeNull();
    expect((await runTaskDue(s.f.ctx, { now: 11, budget: budget(), limit: 10 }, dueContext)).processed).toBe(1);
    expect(await all(env, "SELECT id FROM outbox WHERE profile_id=? AND dedupe LIKE '%task-due:%'", s.f.profile)).toHaveLength(1);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='os.task.due'", s.f.profile)).toHaveLength(2);
  });

  it.each([
    ["2026-11-19T01:30:00.000Z", "18/11/2026 às 22:30 (Brasília)"],
    ["2026-11-19T03:05:00.000Z", "19/11/2026 às 00:05 (Brasília)"],
  ])("formata o instante %s em Brasília sem alterar o prazo", async (iso, expected) => {
    const s = await setup();
    const c = await receive(s.f, s.f.line, "oi", "5511960010203");
    await drain(s.f);
    await exec(env, "UPDATE os_orders SET conversation_id=? WHERE profile_id=? AND id=?", c.id, s.f.profile, s.order.id);
    const due = Date.parse(iso);
    const task = await s.create({ audience: "customer", client_visible: true, due_at: due, remind_at: due });
    expect((await runTaskDue(s.f.ctx, { now: due, budget: budget(), limit: 10 }, dueContext)).processed).toBe(1);
    const queued = await one(env, "SELECT payload FROM outbox WHERE profile_id=? AND dedupe LIKE '%task-due:%'", s.f.profile);
    expect(JSON.parse(queued.payload).text).toBe(`Lembrete: ${input.title}\nVencimento: ${expected}`);
    expect((await s.row(task.id)).due_at).toBe(due);
  });

  it("limita 10 itens e mede cada instrução, inclusive serviços e batches", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) await s.create({ due_at: 10, remind_at: 10 });
    const measured = countingEnv(env);
    const ctx = modulesApi(measured.env, s.f.profile, "os");
    const allowance = budget();
    const result = await runTaskDue(ctx, { now: 10, budget: allowance, limit: 100 }, dueContext);
    expect(result).toEqual({ processed: 10, has_more: true });
    expect(200 - allowance.remaining).toBe(measured.count.statements);
    expect(measured.count.statements).toBeLessThanOrEqual(200);
    expect((await runTaskDue(ctx, { now: 10, budget: budget(), limit: 1 }, dueContext)).processed).toBe(1);
    const before = measured.count.statements;
    expect(await runTaskDue(ctx, { now: 10, budget: budget(TASK_DUE_SQL_RESERVE - 1), limit: 10 }, dueContext)).toEqual({ processed: 0, has_more: true });
    expect(measured.count.statements).toBe(before);
    const batchBudget = budget(2);
    await batch(budgetedEnv(env, batchBudget), [["SELECT 1", []], ["SELECT 2", []]]);
    expect(batchBudget.remaining).toBe(0);
  });
});

describe("tarefas padrão na entrada de etapa", () => {
  it("valida sigilo, responsável e destinatário somente nos modelos da etapa atual", async () => {
    const s = await setup();
    s.stages.set(s.order.id, { stage: "execucao", version: 2 });
    const template = { ...input, audience: "staff" as const, id: "atual", stage: "execucao", due_after_ms: null, remind_before_ms: null };
    const mayNotify = vi.spyOn(s.f.ctx, "mayNotify").mockResolvedValue(false);
    const templates = [
      template,
      { ...template, id: "sigiloso", stage: "revisao", sensitive: true, title: MOTOR_SENTINEL },
      { ...template, id: "removido", stage: "revisao", assignee: "responsavel-removido" },
      { ...template, id: "cliente", stage: "revisao", audience: "customer" as const, client_visible: true },
    ];
    const result = await createStageTasks(s.f.ctx, s.f.member, s.order.id, { stage: "execucao", version: 2, entered_at: 1000, templates });
    expect(result).toHaveLength(1);
    expect(mayNotify).not.toHaveBeenCalled();
    expect(await all(env, "SELECT title FROM os_tasks WHERE profile_id=? AND order_id=?", s.f.profile, s.order.id)).toEqual([{ title: input.title }]);
    for (const other of templates.slice(1)) {
      await expect(createStageTasks(s.f.ctx, s.f.member, s.order.id, {
        stage: "execucao", version: 2, entered_at: 1000, templates: [{ ...other, stage: "execucao" }],
      })).rejects.toBeInstanceOf(ApiError);
    }
    expect(s.effects).toHaveLength(1);
  });

  it("usa entrada/versionamento estável; repetir não duplica e reentrar cria novas", async () => {
    const s = await setup();
    s.stages.set(s.order.id, { stage: "execucao", version: 2 });
    const entry = { stage: "execucao", version: 2, entered_at: 1000, templates: [
      { ...input, audience: "staff" as const, id: "visita", stage: "execucao", due_after_ms: 2000, remind_before_ms: 500 },
      { ...input, audience: "staff" as const, id: "conferir", stage: "execucao", due_after_ms: null, remind_before_ms: null },
      { ...input, audience: "staff" as const, id: "revisar", stage: "revisao", due_after_ms: null, remind_before_ms: null },
    ] };
    s.failCommit();
    await expect(createStageTasks(s.f.ctx, s.f.member, s.order.id, entry)).rejects.toThrow();
    const first = await createStageTasks(s.f.ctx, s.f.member, s.order.id, entry);
    expect(first).toHaveLength(2);
    expect(await s.row(first[0].id)).toMatchObject({ due_at: 3000, remind_at: 2500 });
    expect(await createStageTasks(s.f.ctx, s.f.member, s.order.id, entry)).toEqual(first);
    expect(await createStageTasks(s.f.ctx, s.f.other, s.order.id, entry)).toEqual(first);
    s.stages.set(s.order.id, { stage: "execucao", version: 4 });
    const again = await createStageTasks(s.f.ctx, s.f.member, s.order.id, { ...entry, version: 4 });
    expect(again[0].id).not.toBe(first[0].id);
    await expect(createStageTasks(s.f.ctx, s.f.member, s.order.id, entry)).rejects.toMatchObject({ code: "version_conflict" });
  });

  it.each(["execucao", "revisao"])("valida a estrutura dos modelos de %s antes de criar qualquer tarefa", async (stage) => {
    const s = await setup();
    s.stages.set(s.order.id, { stage: "execucao", version: 2 });
    const template = { ...input, audience: "staff" as const, id: "visita", stage: "execucao", due_after_ms: 2000, remind_before_ms: 500 };
    await expect(createStageTasks(s.f.ctx, s.f.member, s.order.id, {
      stage: "execucao", version: 2, entered_at: 1000,
      templates: [template, { ...template, stage, id: "invalido", title: "" }],
    })).rejects.toMatchObject({ code: "invalid_task" });
    expect(s.commit).not.toHaveBeenCalled();
  });
});
