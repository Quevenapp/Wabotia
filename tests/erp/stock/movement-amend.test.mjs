import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
let f, u, p, wh, movement;
const code = p => p.then(() => "ok", e => e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message);
before(async () => {
  f = await dualFixture(); u = f.users;
  wh = (await f.catalog("warehouses", { name: "Depósito" })).id;
  p = (await f.catalog("products", { name: "Produto", kind: "P", unit: "UN" })).id;
  movement = (await f.rpc("erp_stock_launch", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt",
    p_product_id: p, p_warehouse_id: wh, p_quantity: "5", p_expected_version: 0, p_unit_price: "2", p_unit_cost: "1", p_note: "Entrada" })).movement.id;
});
after(() => f?.close());
test("revisão: preço, custo, nota, versões, repetição e papéis", async () => {
  const base = { p_user_id: u.estoque, p_command_id: randomUUID(), p_movement_id: movement, p_product_id: p,
    p_expected_revision: 1, p_unit_price: "3.12", p_unit_cost: "2.01", p_note: "  Revisado  " };
  const amend = (patch = {}) => f.rpc("erp_stock_movement_amend", { ...base, ...patch });
  for (const bad of [{ p_command_id: null }, { p_movement_id: null }, { p_product_id: null }, { p_expected_revision: null },
    { p_expected_revision: -1 }, { p_expected_revision: 2147483647 }, { p_note: null }, { p_note: "x".repeat(501) }, { p_note: "a\nb" }])
    assert.match(await code(amend(bad)), /^22023:erp_stock_amend_invalid/);
  for (const bad of [{ p_unit_price: "-1" }, { p_unit_cost: "1.00000000001" }]) assert.match(await code(amend(bad)), /^22023:erp_stock_price_invalid/);
  for (const role of ["consulta", "vendas", "inactive"]) assert.match(await code(amend({ p_user_id: u[role] })), /^42501:/);
  assert.match(await code(amend({ p_movement_id: randomUUID() })), /^P0002:erp_stock_movement_not_found/);
  assert.match(await code(amend({ p_expected_revision: 0 })), /^40001:erp_stock_amend_version_conflict/);
  assert.match(await code(amend({ p_unit_price: "2", p_unit_cost: "1", p_note: "Entrada" })), /^22023:erp_stock_amend_unchanged/);
  const r = await amend(); assert.equal(r.detail.revision, 2); assert.equal(r.detail.note, "Revisado");
  assert.equal((await amend()).replayed, true);
  assert.match(await code(amend({ p_note: "Outro" })), /^40001:erp_stock_amend_conflict/);
  await amend({ p_user_id: u.admin, p_command_id: randomUUID(), p_expected_revision: 2, p_unit_price: null, p_unit_cost: null, p_note: "" });
  await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: p });
  await f.rpc("erp_stock_movements", { p_user_id: u.admin, p_product_id: p });
  await f.rpc("erp_stock_ledger", { p_user_id: u.admin, p_product_id: p });
});
test("preço de entrada respeita a preferência nas duas colunas", async () => {
  const pref = (await f.db.query(`select d.page_id,coalesce(v.version,0) version from erp_preferences.definition d
    left join erp_preferences.company_value v on v.key=d.key where d.key='empresa.decimais_preco_entrada'`)).rows[0];
  await f.rpc("erp_preferences_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_page: pref.page_id,
    p_changes: [{ key: "empresa.decimais_preco_entrada", expected_version: pref.version, value: 1 }] });
  for (const field of ["p_unit_price", "p_unit_cost"]) {
    assert.match(await code(f.rpc("erp_stock_movement_amend", { p_user_id: u.admin, p_command_id: randomUUID(), p_movement_id: movement,
      p_product_id: p, p_expected_revision: 3, p_unit_price: null, p_unit_cost: null, p_note: "Preço", [field]: "1.001" })), /^22023:erp_stock_price_decimals_exceeded/);
  }
});

