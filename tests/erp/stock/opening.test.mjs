// Apenas as leituras independentes do Origin são registradas nesta etapa.
// page/batch/apply dependem de erp_cutover.stock_observation_id, sem porta pública.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
let f, u, wh, command;
const code = p => p.then(() => "ok", e => e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message);
before(async () => {
  f = await dualFixture(); u = f.users;
  wh = (await f.catalog("warehouses", { name: "Depósito abertura" })).id;
});
after(() => f?.close());
test("depósitos vinculados: vazio, fonte higienizada e papéis", async () => {
  const list = user => f.rpc("erp_stock_opening_warehouses", { p_user_id: user });
  assert.equal((await list(u.admin)).items.length, 0);
  for (const role of ["estoque", "consulta", "vendas", "inactive"]) assert.match(await code(list(u[role])), /^42501:stock_opening_access_denied/);
  await f.db.query(`insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)
    values('123',$1::uuid,(select command_id from erp_catalog.command where result#>>'{record,id}'=$1::text limit 1),repeat('a',64),1,now(),'{}',$2::jsonb,'{}')`,
    [wh, JSON.stringify({ name: "  Origem\nDepósito\t " })]);
  await f.sync();
  const r = await list(u.admin); assert.equal(r.items[0].source_name, "Origem Depósito");
  assert.equal(r.items[0].warehouse_id, wh);
});
test("consulta de comando: recibo, estado atual, repetição e acesso", async () => {
  command = randomUUID();
  const get = (patch = {}) => f.rpc("erp_stock_opening_command", { p_user_id: u.admin, p_command_id: command, ...patch });
  assert.match(await code(get({ p_command_id: null })), /^22023:stock_opening_query_invalid/);
  assert.match(await code(get()), /^P0002:stock_opening_command_not_found/);
  for (const role of ["estoque", "consulta", "vendas", "inactive"]) assert.match(await code(get({ p_user_id: u[role] })), /^42501:stock_opening_access_denied/);
  await f.db.query(`insert into erp_stock.opening_command(id,actor,request_hash,warehouse_source_id,occurred_on,preview_hash,result)
    values($1,$2,repeat('b',64),'123','2026-01-01',repeat('c',64),'{"scope":"stock_opening_command","receipt":{"items":[]}}')`, [command, u.admin]);
  await f.sync();
  const product = (await f.catalog("products", { name: "Produto zero", kind: "P", unit: "UN" })).id;
  await f.db.query(`insert into erp_stock.opening_receipt(product_id,warehouse_id,warehouse_source_id,product_source_id,command_id,outcome,target,
    previous_quantity,adjustment,unit,source_hash,source_version,source_seen_at,occurred_on,actor)
    values($1,$2,'123','456',$3,'adopted_zero',0,0,0,'UN',repeat('d',64),1,now(),'2026-01-01',$4)`, [product, wh, command, u.admin]);
  await f.sync();
  const r = await get(); assert.equal(r.replayed, true); assert.equal(r.current[0].state, "adopted_zero");
  assert.deepEqual(await get(), r);
  await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: product });
});

