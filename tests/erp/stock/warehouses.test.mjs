// Depósitos no Estoque (erp_stock_warehouses, _warehouse_options,
// _warehouse_set_default, _position_warehouses, _product_locations) nos dois
// motores: busca com acento, filtro, páginas, padrão por comando e recusas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, wh;
const code = (p) => p.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
before(async () => {
  f = await dualFixture();
  u = f.users;
  wh = [];
  for (const name of ["Depósito Central", "depósito ÁGUA", "Loja Sul", "ÉDEN filial", "Almoxarifado"]) wh.push((await f.catalog("warehouses", { name })).id);
});
after(() => f?.close());

test("lista: busca sem acento, ativo, páginas, padrão e acesso", async () => {
  const list = (args) => f.rpc("erp_stock_warehouses", { p_user_id: u.estoque, p_page: 1, p_size: 2, p_query: null, p_active: null, ...args });
  await list({});
  await list({ p_page: 2 });
  await list({ p_page: 3, p_size: 2 });
  for (const q of ["deposito", "  AGUA  ", "eden", "zzz", "", "   "]) await list({ p_query: q, p_size: 100 });
  await list({ p_active: true, p_size: 100 });
  await list({ p_active: false, p_size: 100 });
  for (const bad of [{ p_page: 0 }, { p_page: 100001 }, { p_size: 0 }, { p_size: 101 }, { p_query: "x".repeat(121) }, { p_query: "a\u0007b" }, { p_page: null }])
    assert.match(await code(list(bad)), /^22023:erp_stock_invalid_query/, JSON.stringify(bad));
  for (const role of ["admin", "consulta", "vendas", "financeiro", "fiscal", "vendedor", "inactive"]) await code(list({ p_user_id: u[role] }));
  assert.equal((await list({ p_user_id: u.admin })).can_manage, true);
});

test("opções e posições: ordem, cursor e acesso", async () => {
  await f.rpc("erp_stock_warehouse_options", { p_user_id: u.estoque });
  for (const role of ["consulta", "vendas", "financeiro", "inactive"]) await code(f.rpc("erp_stock_warehouse_options", { p_user_id: u[role] }));
  const pos = (args) => f.rpc("erp_stock_position_warehouses", { p_user_id: u.estoque, p_limit: 2, p_after: null, ...args });
  const first = await pos({});
  assert.equal(first.has_more, true);
  await pos({ p_after: first.next_cursor });
  await pos({ p_limit: 100 });
  for (const bad of [{ p_limit: 0 }, { p_limit: 101 }, { p_limit: null }]) assert.match(await code(pos(bad)), /^22023:/);
});

test("padrão: comando, versão, inativo, repetição e conflito", async () => {
  const set = (args) =>
    f.rpc("erp_stock_warehouse_set_default", { p_user_id: u.estoque, p_command_id: randomUUID(), p_warehouse_id: wh[0], p_expected_version: 0, ...args });
  assert.match(await code(set({ p_user_id: u.consulta })), /^42501:erp_stock_warehouse_access_denied/);
  for (const bad of [{ p_command_id: null }, { p_warehouse_id: null }, { p_expected_version: -1 }, { p_expected_version: 2147483647 }])
    assert.match(await code(set(bad)), /^22023:erp_stock_warehouse_input_invalid/);
  assert.match(await code(set({ p_warehouse_id: randomUUID() })), /^P0002:erp_stock_warehouse_not_found/);
  assert.match(await code(set({ p_expected_version: 5 })), /^40001:erp_stock_warehouse_version_conflict/);
  const command = randomUUID();
  const first = await set({ p_command_id: command });
  assert.equal(first.warehouse.is_default, true);
  assert.equal((await set({ p_command_id: command })).replayed, true);
  assert.match(await code(set({ p_command_id: command, p_warehouse_id: wh[1] })), /^40001:erp_stock_warehouse_command_conflict/);
  assert.match(await code(set({ p_expected_version: 1 })), /^22023:erp_stock_warehouse_default_unchanged/);
  // Depósito inativo não vira padrão.
  const inactive = await f.catalog("warehouses", { name: "Depósito desligado", active: false }).catch(() => null);
  if (inactive) assert.match(await code(set({ p_warehouse_id: inactive.id, p_expected_version: 1 })), /^22023:erp_stock_default_warehouse_inactive/);
  await set({ p_warehouse_id: wh[2], p_expected_version: 1 });
  await f.rpc("erp_stock_warehouses", { p_user_id: u.estoque, p_page: 1, p_size: 100, p_query: null, p_active: null });
  await f.rpc("erp_stock_warehouse_options", { p_user_id: u.estoque });
});

test("localização de produtos: validação e limpeza do texto", async () => {
  const p1 = await f.catalog("products", { name: "Produto com local", unit: "UN", kind: "P", price: "1.0000" });
  const p2 = await f.catalog("products", { name: "Produto sem local", unit: "UN", kind: "P", price: "1.0000" });
  await f.db.query(`update erp_catalog.product set location=$1 where record_id=$2`, ["  Corredor\t3\n\nPrateleira 2 ", p1.id]);
  await f.db.query(`update erp_catalog.product set location=$1 where record_id=$2`, ["\t\n ", p2.id]);
  await f.sync();
  const loc = (ids) => f.rpc("erp_stock_product_locations", { p_user_id: u.estoque, p_ids: ids });
  const r = await loc([p1.id, p2.id, randomUUID()]);
  assert.equal(r.items.length, 2);
  for (const bad of [[], [p1.id, p1.id], [p1.id.toUpperCase()], [1], '"x"', Array.from({ length: 501 }, () => randomUUID())])
    assert.match(await code(loc(bad)), /^22023:erp_stock_invalid_query/, JSON.stringify(bad).slice(0, 60));
  // Texto que não é JSON no argumento jsonb: 22P02 do Postgres.
  assert.match(await code(loc("x")), /^22P02:invalid input syntax for type json/);
});

test("salvar: criação, edição, sem mudança, versões, recibo e papéis", async () => {
  const base = { p_user_id: u.estoque, p_command_id: randomUUID(), p_warehouse_id: null, p_expected_version: 0,
    p_expected_setting_version: 0, p_name: "Depósito novo", p_ignore_balance: true };
  const save = (patch = {}) => f.rpc("erp_stock_warehouse_save", { ...base, ...patch });
  for (const bad of [{ p_command_id: null }, { p_expected_version: null }, { p_expected_version: -1 },
    { p_expected_version: 2147483647 }, { p_expected_version: 1 }, { p_expected_setting_version: null },
    { p_expected_setting_version: -1 }, { p_expected_setting_version: 2147483647 }, { p_expected_setting_version: 1 },
    { p_ignore_balance: null }, { p_name: null }, { p_name: "" }, { p_name: " X " }, { p_name: "x".repeat(201) }, { p_name: "a\nb" }])
    assert.match(await code(save(bad)), /^22023:erp_stock_warehouse_input_invalid/);
  for (const role of ["consulta", "vendas", "inactive"]) assert.match(await code(save({ p_user_id: u[role] })), /^42501:/);
  const created = await save();
  assert.equal(created.warehouse.setting_version, 1);
  assert.equal(created.warehouse.ignore_balance, true);
  assert.equal((await save()).replayed, true);
  assert.match(await code(save({ p_name: "Outro" })), /^40001:erp_stock_warehouse_command_conflict/);
  const update = { p_user_id: u.admin, p_command_id: randomUUID(), p_warehouse_id: created.warehouse.id,
    p_expected_version: created.warehouse.version, p_expected_setting_version: 1, p_name: "Depósito editado", p_ignore_balance: false };
  assert.match(await code(save({ ...update, p_expected_version: 5 })), /^40001:erp_catalog_version_conflict/);
  assert.match(await code(save({ ...update, p_expected_setting_version: 0 })), /^40001:erp_stock_warehouse_version_conflict/);
  const changed = await save(update);
  assert.equal(changed.warehouse.setting_version, 2);
  const unchanged = await save({ ...update, p_command_id: randomUUID(), p_expected_version: changed.warehouse.version, p_expected_setting_version: 2 });
  assert.equal(unchanged.receipt.catalog_changed, false);
  assert.equal(unchanged.receipt.setting_changed, false);
  // A repetição relê o depósito atual e mantém o recibo da criação.
  assert.equal((await save()).warehouse.name, "Depósito editado");
  await f.rpc("erp_stock_warehouses", { p_user_id: u.admin });
});
