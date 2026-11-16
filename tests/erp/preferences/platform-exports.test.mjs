// Exportação da empresa (migração 331) na fixture dupla. Adaptado de
// workers/erp-api/test/plataforma-h-sql.test.mjs, "PRF-029: the administrador asks for one export at a time…":
// o pedido, a repetição, a recusa enquanto há outra, o plano (tabelas e arquivos do armazenamento, pela listagem),
// a confirmação, a lista, o link curto e a limpeza depois da retenção, pelos RPCs que o runPlatformTasks chama.
// Fora, declarado: a montagem do ZIP e o envio ao armazenamento (erp-api, fora do motor; a confirmação usa um
// SHA-256 sintético) e o erp_platform_export_chunk (espera o rowJson central do motor).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
const fails = (fn, code) => assert.rejects(fn, (e) => e.code === code);
const write = async (sql, args = []) => {
  await f.db.query(sql, args);
  await f.sync();
};
const claim = async (purpose) => {
  const lease = randomUUID();
  const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: [purpose] })).task;
  return { task, lease };
};

test("PRF-029: one export at a time, the plan, the confirmation, the short link and the cleanup after the retention", async () => {
  await f.putObject("erp-attachments", `company/files/${randomUUID()}/${"a".repeat(64)}`, 17, "text/plain");
  await fails(() => f.rpc("erp_platform_export_request", { p_user_id: f.users.financeiro, p_command_id: randomUUID() }), "42501");
  const command = randomUUID(),
    asked = await f.rpc("erp_platform_export_request", { p_user_id: f.users.admin, p_command_id: command });
  assert.deepEqual([asked.export.status, asked.replayed], ["queued", false]);
  assert.equal((await f.rpc("erp_platform_export_request", { p_user_id: f.users.admin, p_command_id: command })).replayed, true);
  await fails(() => f.rpc("erp_platform_export_request", { p_user_id: f.users.admin, p_command_id: randomUUID() }), "55000");
  await fails(() => f.rpc("erp_platform_export_link", { p_user_id: f.users.admin, p_export_id: asked.export.id }), "55000");
  const { task, lease } = await claim("company_export");
  const plan = await f.rpc("erp_platform_export_plan", { p_task: task.id, p_lease: lease });
  assert.ok(plan.datasets.includes("erp_catalog.record") && plan.datasets.includes("origin_sync.raw_record"));
  assert.ok(!plan.datasets.some((n) => /erp_access|auth\.|credential|erp_platform|vault/.test(n)));
  assert.equal(plan.files.length, 1);
  const sha = createHash("sha256").update("zip sintético").digest("hex");
  for (const bad of [
    { p_sha256: "x" }, { p_object_key: "outro.zip" }, { p_size_bytes: 21 }, { p_size_bytes: 52428801 }, { p_manifest: [] },
  ])
    await fails(
      () => f.rpc("erp_platform_export_complete", { p_task: task.id, p_lease: lease, p_sha256: sha, p_size_bytes: 100, p_object_key: `exports/${asked.export.id}/${sha}.zip`, p_manifest: { summary: { tabelas: 3 } }, ...bad }),
      "22023",
    );
  const done = await f.rpc("erp_platform_export_complete", {
    p_task: task.id, p_lease: lease, p_sha256: sha, p_size_bytes: 100, p_object_key: `exports/${asked.export.id}/${sha}.zip`, p_manifest: { summary: { tabelas: 3 } },
  });
  assert.deepEqual([done.export.status, done.replayed, done.export.summary], ["ready", false, { tabelas: 3 }]);
  assert.equal(
    (await f.rpc("erp_platform_export_complete", { p_task: task.id, p_lease: lease, p_sha256: sha, p_size_bytes: 100, p_object_key: `exports/${asked.export.id}/${sha}.zip`, p_manifest: {} })).replayed,
    true,
  );
  await f.rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: true, p_result: { export_id: asked.export.id }, p_error: null });
  const list = await f.rpc("erp_platform_exports", { p_user_id: f.users.admin });
  assert.deepEqual([list.items[0].status, list.items[0].size_bytes], ["ready", 100]);
  await fails(() => f.rpc("erp_platform_exports", { p_user_id: f.users.consulta }), "42501");
  const link = await f.rpc("erp_platform_export_link", { p_user_id: f.users.admin, p_export_id: asked.export.id });
  assert.equal(link.expires_in, 120);
  assert.match(link.filename, /^brufap-exportacao-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  await fails(() => f.rpc("erp_platform_export_link", { p_user_id: f.users.vendas, p_export_id: asked.export.id }), "42501");
  await fails(() => f.rpc("erp_platform_export_link", { p_user_id: f.users.admin, p_export_id: randomUUID() }), "P0002");
  // Depois da retenção, a limpeza diária remove o objeto uma vez.
  await f.db.exec("alter table erp_platform.export disable trigger export_guard");
  await write("update erp_platform.export set expires_at=clock_timestamp()-interval '1 minute'");
  await f.db.exec("alter table erp_platform.export enable trigger export_guard");
  await f.rpc("erp_platform_schedule", { p_now: new Date().toISOString() });
  const cleanup = await claim("export_cleanup");
  const expired = await f.rpc("erp_platform_export_expired", { p_task: cleanup.task.id, p_lease: cleanup.lease });
  assert.deepEqual(expired.items.map((i) => i.id), [asked.export.id]);
  await fails(() => f.rpc("erp_platform_export_removed", { p_task: cleanup.task.id, p_lease: cleanup.lease, p_export_id: randomUUID() }), "P0002");
  const removed = await f.rpc("erp_platform_export_removed", { p_task: cleanup.task.id, p_lease: cleanup.lease, p_export_id: asked.export.id });
  assert.equal(removed.export.status, "expired");
  assert.equal((await f.rpc("erp_platform_export_removed", { p_task: cleanup.task.id, p_lease: cleanup.lease, p_export_id: asked.export.id })).export.status, "expired");
  await fails(() => f.rpc("erp_platform_export_link", { p_user_id: f.users.admin, p_export_id: asked.export.id }), "55000");
  await fails(() => f.rpc("erp_platform_export_plan", { p_task: cleanup.task.id, p_lease: cleanup.lease }), "22023");
});
