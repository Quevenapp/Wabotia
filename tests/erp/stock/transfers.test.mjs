import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
let f, u, source, destination, products;
const code = p => p.then(() => "ok", e => e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message);
before(async () => {
  f = await dualFixture(); u = f.users;
  source = (await f.catalog("warehouses", { name: "Origem" })).id;
  destination = (await f.catalog("warehouses", { name: "Destino" })).id;
  products = [];
  for (const name of ["Água", "Café"]) {
    const p = await f.catalog("products", { name, unit: "UN", kind: "P" }); products.push(p.id);
    await f.rpc("erp_stock_launch", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt", p_product_id: p.id,
      p_warehouse_id: source, p_quantity: "10", p_expected_version: 0, p_unit_price: "5", p_unit_cost: "3" });
  }
});
after(() => f?.close());
test("posições: saldos, sugestões, validação e papéis", async () => {
  const positions = (patch = {}) => f.rpc("erp_stock_transfer_positions", { p_user_id: u.estoque, p_source_id: source,
    p_destination_id: destination, p_product_ids: products, ...patch });
  const r = await positions(); assert.equal(r.items[0].source.quantity, "10.000000");
  await positions({ p_user_id: u.admin, p_destination_id: null });
  for (const role of ["consulta", "vendas", "inactive"]) assert.match(await code(positions({ p_user_id: u[role] })), /^42501:/);
  for (const bad of [{ p_source_id: null }, { p_destination_id: source }, ...[null, {}, [], [1], ["bad"], [products[0], products[0]],
    Array.from({ length: 51 }, randomUUID)].map(p_product_ids => ({ p_product_ids }))])
    assert.match(await code(positions(bad)), /^22023:erp_stock_invalid_query/);
  assert.match(await code(positions({ p_source_id: randomUUID() })), /^P0002:erp_stock_warehouse_not_found/);
  assert.match(await code(positions({ p_product_ids: [randomUUID()] })), /^P0002:erp_stock_product_not_found/);
});
test("lote: atomicidade, versões, repetição, conflito e saldos", async () => {
  const items = products.map(product_id => ({ product_id, quantity: "2.5", source_version: 1, destination_version: 0, unit_price: "5", unit_cost: "3" }));
  const base = { p_user_id: u.admin, p_command_id: randomUUID(), p_source_id: source, p_destination_id: destination, p_note: "  Transferência teste  ", p_items: items };
  const batch = (patch = {}) => f.rpc("erp_stock_transfer_batch", { ...base, ...patch });
  for (const role of ["consulta", "vendas", "inactive"]) assert.match(await code(batch({ p_user_id: u[role] })), /^42501:/);
  for (const bad of [{ p_command_id: null }, { p_source_id: null }, { p_destination_id: null }, { p_destination_id: source },
    { p_note: "x".repeat(501) }, { p_note: "a\nb" }, ...[null, {}, [], [null], [items[0], items[0]]].map(p_items => ({ p_items })),
    ...[{ product_id: 3 }, { product_id: "bad" }, { quantity: "0" }, { quantity: "-1" }, { quantity: "1.0000001" },
      { quantity: 2 }, { source_version: -1 }, { source_version: 2147483647 }, { source_version: "1" }, { destination_version: null },
      { destination_version: 2147483647 }, { unit_price: 3 }, { unit_cost: false }, { unknown: true }].map(x => ({ p_items: [{ ...items[0], ...x }] }))])
    assert.match(await code(batch(bad)), /^22023:erp_stock_transfer_batch_invalid/);
  assert.match(await code(batch({ p_items: [{ ...items[0], unit_price: "-1" }] })), /^22023:erp_stock_price_invalid/);
  assert.match(await code(batch({ p_items: [items[0], { ...items[1], source_version: 8 }] })), /^40001:erp_stock_version_conflict/);
  const r = await batch(); assert.equal(r.receipt.items.length, 2); assert.equal(r.replayed, false);
  assert.equal((await batch()).replayed, true);
  assert.match(await code(batch({ p_note: "Outro" })), /^40001:erp_stock_transfer_batch_conflict/);
  await batch({ p_user_id: u.estoque, p_command_id: randomUUID(), p_items: items.map(x => ({ ...x, source_version: 2, destination_version: 1 })) });
  for (const id of products) {
    await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: id });
    await f.rpc("erp_stock_movements", { p_user_id: u.admin, p_product_id: id });
  }
});


test("lote opcional: transferência, saldo, inativo e quantidade insuficiente", async () => {
  const p = await f.catalog("products", { name: "Produto por lote", kind: "P", unit: "UN", format: "S" });
  await f.rpc("erp_catalog_product_save", { p_user_id: u.admin, p_id: p.id, p_expected_version: p.version,
    p_command_id: randomUUID(), p_data: { lot_control: true }, p_acknowledged: null });
  const launched = await f.rpc("erp_stock_lot_launch", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: "receipt",
    p_product_id: p.id, p_warehouse_id: source, p_quantity: "5", p_expected_version: 0, p_unit_price: null, p_unit_cost: null,
    p_note: null, p_destination_id: null, p_destination_version: null, p_lot: { code: "L-A", expires_on: "2099-12-31" } });
  const lot = launched.lot.id;
  const line = { product_id: p.id, quantity: "2", source_version: 1, destination_version: 0, lot_id: lot };
  const base = { p_user_id: u.admin, p_command_id: randomUUID(), p_source_id: source, p_destination_id: destination, p_note: null, p_items: [line] };
  const batch = (patch = {}) => f.rpc("erp_stock_transfer_batch", { ...base, ...patch });
  for (const lot_id of [null, 3, "bad"]) assert.match(await code(batch({ p_items: [{ ...line, lot_id }] })), /^22023:erp_stock_transfer_batch_invalid/);
  assert.match(await code(batch({ p_items: [{ ...line, product_id: products[0] }] })), /^22023:erp_stock_lot_control_off/);
  assert.match(await code(batch({ p_items: [{ ...line, lot_id: randomUUID() }] })), /^P0002:erp_stock_lot_not_found/);
  assert.match(await code(batch({ p_items: [{ ...line, quantity: "6" }] })), /^22023:erp_stock_lot_insufficient/);
  const positions = await f.rpc("erp_stock_transfer_positions", { p_user_id: u.admin, p_source_id: source, p_destination_id: destination, p_product_ids: [p.id] });
  assert.equal(positions.items[0].lot_control, true); assert.equal(positions.items[0].lots[0].id, lot);
  assert.equal((await batch()).receipt.items[0].lot_id, lot);
  assert.equal((await batch()).replayed, true);
  await f.rpc("erp_stock_balances", { p_user_id: u.admin, p_product_id: p.id });
  const after = await f.rpc("erp_stock_transfer_positions", { p_user_id: u.admin, p_source_id: source, p_destination_id: destination, p_product_ids: [p.id] });
  assert.equal(after.items[0].lots[0].quantity, "3.000000");
  const empty = await f.rpc("erp_stock_lot_save", { p_user_id: u.admin, p_command_id: randomUUID(), p_product_id: p.id,
    p_lot_id: null, p_expected_version: 0, p_code: "L-INATIVO", p_manufactured_on: null, p_expires_on: null, p_note: null });
  await f.rpc("erp_stock_lot_status", { p_user_id: u.admin, p_command_id: randomUUID(), p_lot_id: empty.lot.id, p_expected_version: 1, p_active: false });
  assert.match(await code(batch({ p_command_id: randomUUID(), p_items: [{ ...line, lot_id: empty.lot.id, source_version: 2, destination_version: 1 }] })), /^22023:erp_stock_lot_inactive/);
});
