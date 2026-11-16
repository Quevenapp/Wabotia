// Cartão "Novas NF-es" (migração 334) na fixture dupla: o subteste "PRF-252: Novas NF-es counts real synced
// and received notes since the last view, never drafts or homologation" de
// workers/erp-api/test/plataforma-h-sql.test.mjs, pelos RPCs (o original passa pela rota da erp-api, que só
// repassa). As linhas do Origin entram por SQL direto no Postgres e são copiadas (f.write).
// Mais: homologação no arquivo do Origin fica de fora; a mesma chave conta uma vez.
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
const counts = (user) => f.rpc("erp_platform_new_invoices", { p_user_id: user });

test("PRF-252: Novas NF-es counts real synced and received notes since the last view, never drafts or homologation", async () => {
  const empty = await counts(f.users.admin);
  assert.deepEqual([empty.total, empty.seen_before], [0, false]);
  await write("insert into origin_sync.resource_state(resource) values('nfe') on conflict do nothing");
  const add = (id, situacao, key) =>
    write("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','nfe',$1,$2::jsonb,$3)", [
      id, JSON.stringify({ id, situacao, chaveAcesso: key }), createHash("sha256").update(id).digest("hex"),
    ]);
  // Situações do Origin v3: 5 Autorizada e 6 Emitida DANFE contam; 1 Pendente não.
  await add("9001", 5, "3".repeat(44));
  await add("9002", 1, "4".repeat(44));
  await add("9003", 6, null);
  await add("9004", { id: "5" }, "3".repeat(44));
  const counted = await counts(f.users.fiscal);
  assert.deepEqual([counted.total, counted.synced, counted.received], [2, 2, 0], "Pendente (situação 1) is not counted; the same key counts once");
  await fails(() => counts(f.users.vendas), "42501");
  const command = randomUUID(),
    seen = await f.rpc("erp_platform_new_invoices_seen", { p_user_id: f.users.fiscal, p_command_id: command });
  assert.equal(seen.view.total, 0);
  assert.equal(seen.view.seen_before, true);
  assert.equal((await f.rpc("erp_platform_new_invoices_seen", { p_user_id: f.users.fiscal, p_command_id: command })).replayed, true);
  await fails(() => f.rpc("erp_platform_new_invoices_seen", { p_user_id: f.users.consulta, p_command_id: command }), "40001");
  await fails(() => f.rpc("erp_platform_new_invoices_seen", { p_user_id: f.users.consulta, p_command_id: null }), "22023");
  assert.equal((await counts(f.users.admin)).total, 2, "the view is per user");
});
