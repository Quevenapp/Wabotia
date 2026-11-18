import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { registerOpaqueHash } from "../harness/derived-ids.mjs";
// Os dois hashes internos incluem o UUID do produto criado nesta chamada.
// Os UUIDs aleatórios diferem entre motores; só essas duas colunas são
// declaradas opacas. O hash do comando externo e a repetição são literais.
registerOpaqueHash({ id: "stock.initial_balance_post_hash", columns: ["erp_stock__command.request_hash"],
  reason: "erp_stock.post calcula request_hash com product_id, gerado pelo Catálogo na mesma chamada de erp_stock_product_create." });
registerOpaqueHash({ id: "stock.initial_balance_launch_hash", columns: ["erp_stock__ledger_command.request_hash"],
  reason: "erp_stock_launch calcula request_hash com product_id, UUID novo do produto criado pelo saldo inicial nesta chamada." });
let f, u, wh;
const code = p => p.then(() => "ok", e => e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message);
before(async () => { f = await dualFixture(); u = f.users; wh = (await f.catalog("warehouses", { name: "Depósito" })).id; });
after(() => f?.close());
test("produto com saldo inicial: validações, rollback, recibo e papéis", async () => {
  const base = { p_user_id: u.admin, p_command_id: randomUUID(), p_data: { name: "Produto inicial", unit: "UN", kind: "P" },
    p_acknowledged: [], p_warehouse_id: wh, p_quantity: "2.123456", p_unit_price: "4", p_unit_cost: "3", p_note: "   " };
  const create = (patch = {}) => f.rpc("erp_stock_product_create", { ...base, ...patch });
  for (const bad of [{ p_command_id: null }, { p_data: null }, { p_data: [] }, { p_warehouse_id: null }, { p_quantity: null },
    { p_quantity: "0" }, { p_quantity: "-1" }, { p_quantity: "01" }, { p_quantity: "1.0000001" }, { p_quantity: "1000000000000" },
    { p_note: "a\nb" }, { p_note: "x".repeat(501) }]) assert.match(await code(create(bad)), /^22023:erp_stock_initial_balance_invalid/);
  for (const role of ["consulta", "vendas", "inactive"]) assert.match(await code(create({ p_user_id: u[role] })), /^42501:/);
  assert.match(await code(create({ p_unit_price: "-1" })), /^22023:erp_stock_price_invalid/);
  assert.match(await code(create({ p_warehouse_id: randomUUID() })), /^22023:erp_stock_warehouse_unavailable/);
  const r = await create(); assert.equal(r.initial_balance.quantity, "2.123456"); assert.equal(r.initial_balance.note, "Saldo inicial");
  assert.equal((await create()).replayed, true);
  assert.match(await code(create({ p_quantity: "3" })), /^40001:erp_stock_initial_balance_conflict/);
  await create({ p_user_id: u.estoque, p_command_id: randomUUID(), p_data: { name: "Produto estoque", unit: "UN", kind: "P" } });
  await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: r.record.id });
  await f.rpc("erp_stock_movements", { p_user_id: u.admin, p_product_id: r.record.id });
});

