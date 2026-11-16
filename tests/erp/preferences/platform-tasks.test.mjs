// Fila de tarefas da plataforma (migração 330) na fixture dupla.
// Adaptado de workers/erp-api/test/plataforma-h-sql.test.mjs: "PRF-280: a lost lease cannot finish; an expired
// lease is retried and then fails after the attempts" (os updates diretos de lease_until passam pela cópia do
// estado); a agenda e a listagem do subteste "PRF-280, PRF-283" (as notificações em si vêm no bloco seguinte).
// Fora, declarados: GRANT/RLS ("330-334 RPCs are service-only…") e o DELETE direto recusado pelo gatilho
// task_guard (no motor a tarefa só muda pelos RPCs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
const fails = (assert, fn, code) => assert.rejects(fn, (e) => e.code === code);
const write = async (sql, args = []) => {
  await f.db.query(sql, args);
  await f.sync();
};

test("PRF-280: a lost lease cannot finish; an expired lease is retried and then fails after the attempts", async () => {
  await write("insert into erp_platform.task(purpose,operation_id,max_attempts) values('notifications_generate','notificacoes:lease',2)");
  const lease = randomUUID(),
    claimed = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["notifications_generate"] })).task;
  assert.equal(claimed.operation_id, "notificacoes:lease");
  await fails(assert, () => f.rpc("erp_platform_task_finish", { p_task: claimed.id, p_lease: randomUUID(), p_ok: true, p_result: {}, p_error: null }), "40001");
  await write("update erp_platform.task set lease_until=clock_timestamp()-interval '1 second' where id=$1", [claimed.id]);
  const again = (await f.rpc("erp_platform_task_claim", { p_lease: randomUUID(), p_purposes: ["notifications_generate"] })).task;
  assert.equal(again.id, claimed.id);
  assert.equal(again.attempts, 2);
  assert.equal(again.history[0].outcome, "expired");
  await write("update erp_platform.task set lease_until=clock_timestamp()-interval '1 second' where id=$1", [claimed.id]);
  assert.equal((await f.rpc("erp_platform_task_claim", { p_lease: randomUUID(), p_purposes: ["notifications_generate"] })).task, null);
  assert.equal(await f.scalar("select status v from erp_platform.task where id=$1", [claimed.id]), "failed");
});

test("schedule: the same hour is the same task; claim, progress, retry and finish; the list by role", async () => {
  const now = new Date().toISOString();
  const first = await f.rpc("erp_platform_schedule", { p_now: now }),
    second = await f.rpc("erp_platform_schedule", { p_now: now });
  assert.deepEqual(first.tasks, second.tasks, "the same hour is the same task");
  await fails(assert, () => f.rpc("erp_platform_schedule", { p_now: "2020-01-01T00:00:00Z" }), "22023");
  for (const p of [[], ["x"], ["company_export", "export_cleanup", "notifications_generate", "company_export"], '"x"', [1]])
    await fails(assert, () => f.rpc("erp_platform_task_claim", { p_lease: randomUUID(), p_purposes: p }), "22023");
  await fails(assert, () => f.rpc("erp_platform_task_claim", { p_lease: null, p_purposes: null }), "22023");
  const lease = randomUUID();
  const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["notifications_generate"] })).task;
  assert.equal(task.purpose, "notifications_generate");
  const progressed = await f.rpc("erp_platform_task_progress", { p_task: task.id, p_lease: lease, p_progress: { summary: { feitos: 1 } } });
  assert.deepEqual(progressed.task.progress, { feitos: 1 });
  for (const args of [{ p_ok: true, p_result: null, p_error: null }, { p_ok: true, p_result: {}, p_error: "X" }, { p_ok: false, p_result: null, p_error: "com espaço" }, { p_ok: null }])
    await fails(assert, () => f.rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_result: null, p_error: null, ...args }), "22023");
  const retried = await f.rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: false, p_result: null, p_error: "ERP_FALHA_SINTETICA" });
  assert.deepEqual([retried.task.status, retried.task.history[0].outcome], ["queued", "retry"]);
  const cleanup = randomUUID();
  const c = (await f.rpc("erp_platform_task_claim", { p_lease: cleanup, p_purposes: ["export_cleanup"] })).task;
  const done = await f.rpc("erp_platform_task_finish", { p_task: c.id, p_lease: cleanup, p_ok: true, p_result: { removidos: 0 }, p_error: null });
  assert.deepEqual([done.task.status, done.task.result], ["done", { removidos: 0 }]);
  await fails(assert, () => f.rpc("erp_platform_task_finish", { p_task: c.id, p_lease: cleanup, p_ok: true, p_result: {}, p_error: null }), "40001");
  const all = await f.rpc("erp_platform_tasks", { p_user_id: f.users.admin, p_limit: 10 });
  assert.equal(all.all, true);
  assert.ok(all.items.length >= 2);
  const mine = await f.rpc("erp_platform_tasks", { p_user_id: f.users.vendas, p_limit: 10 });
  assert.deepEqual([mine.all, mine.items], [false, []]);
  await fails(assert, () => f.rpc("erp_platform_tasks", { p_user_id: f.users.admin, p_limit: 101 }), "22023");
  await fails(assert, () => f.rpc("erp_platform_tasks", { p_user_id: f.users.inactive, p_limit: 10 }), "42501");
  await fails(assert, () => f.rpc("erp_platform_task_progress", { p_task: randomUUID(), p_lease: lease, p_progress: {} }), "P0002");
});
