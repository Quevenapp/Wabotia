// Política de saldo negativo (erp_stock_policy_get/set/command) nos dois
// motores: acesso, validação, recibo, conflito de versão e de comando,
// repetição pelo mesmo comando e leitura do recibo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u;
before(async () => {
  f = await dualFixture();
  u = f.users;
});
after(() => f?.close());

const code = (p) => p.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
const get = (user) => f.rpc("erp_stock_policy_get", { p_user_id: user });
const set = (args) =>
  f.rpc("erp_stock_policy_set", {
    p_user_id: u.admin,
    p_command_id: randomUUID(),
    p_expected_version: 0,
    p_allow_negative: true,
    p_reason: "Liberar saldo negativo",
    p_confirmed: true,
    ...args,
  });

test("leitura: papéis, can_manage e a política semeada", async () => {
  for (const role of ["admin", "consulta", "estoque", "vendas", "fiscal"]) await get(u[role]);
  // Os outros papéis: o resultado (aceito ou 42501) é o mesmo nos dois motores (f.rpc compara).
  for (const role of ["financeiro", "vendedor"]) await code(get(u[role]));
  assert.match(await code(get(u.inactive)), /^42501:erp_stock_access_denied/);
  const r = await get(u.admin);
  assert.equal(r.can_manage, true);
  assert.equal((await get(u.estoque)).can_manage, false);
});

test("alteração: validação, recibo, conflitos e repetição", async () => {
  assert.match(await code(set({ p_user_id: u.estoque })), /^42501:erp_stock_policy_access_denied/);
  for (const bad of [
    { p_reason: "ab" },
    { p_reason: "   ab   " },
    { p_reason: "x".repeat(501) },
    { p_reason: "com\ttab" },
    { p_confirmed: false },
    { p_confirmed: null },
    { p_expected_version: -1 },
    { p_expected_version: 2147483647 },
    { p_allow_negative: null },
    { p_reason: null },
  ])
    assert.match(await code(set(bad)), /^22023:erp_stock_policy_input_invalid/, JSON.stringify(bad));
  assert.match(await code(set({ p_allow_negative: false })), /^22023:erp_stock_policy_unchanged/);
  assert.match(await code(set({ p_expected_version: 3 })), /^40001:erp_stock_policy_version_conflict/);
  const command = randomUUID();
  const first = await set({ p_command_id: command, p_reason: "  Liberar para a contagem  " });
  assert.equal(first.replayed, false);
  assert.equal(first.policy.allow_negative, true);
  assert.equal(first.receipt.reason, "Liberar para a contagem");
  // Mesmo comando, mesmo pedido: o recibo; pedido diferente: conflito.
  const again = await set({ p_command_id: command, p_reason: "  Liberar para a contagem  " });
  assert.equal(again.replayed, true);
  assert.match(await code(set({ p_command_id: command, p_reason: "Outro motivo qualquer" })), /^40001:erp_stock_policy_command_conflict/);
  // Id de comando já usado em outra tabela de comando do Estoque.
  const product = await f.catalog("products", { name: "Produto da política", unit: "UN", kind: "P", price: "1.0000" });
  const warehouse = await f.catalog("warehouses", { name: "Depósito da política" });
  const used = randomUUID();
  await f.rpc("erp_stock_post", {
    p_user_id: u.estoque, p_command_id: used, p_kind: "receipt", p_occurred_on: "2026-10-15", p_reason: "Entrada da política",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "1", expected_version: 0 }], p_reference: null,
  });
  assert.match(await code(set({ p_command_id: used, p_expected_version: 1, p_allow_negative: false })), /^40001:erp_stock_policy_command_conflict/);
  const back = await set({ p_expected_version: 1, p_allow_negative: false, p_reason: "Voltar ao bloqueio" });
  assert.equal(back.receipt.to.version, 2);
  // Leitura do recibo.
  const read = await f.rpc("erp_stock_policy_command", { p_user_id: u.admin, p_command_id: command });
  assert.equal(read.replayed, true);
  assert.equal(read.policy.version, 2);
  assert.match(await code(f.rpc("erp_stock_policy_command", { p_user_id: u.admin, p_command_id: randomUUID() })), /^P0002:/);
  assert.match(await code(f.rpc("erp_stock_policy_command", { p_user_id: u.admin, p_command_id: null })), /^22023:/);
  assert.match(await code(f.rpc("erp_stock_policy_command", { p_user_id: u.estoque, p_command_id: command })), /^42501:/);
});
