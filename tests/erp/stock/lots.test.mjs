// Cadastro de lotes (rpc/lots.ts) no diferencial: criar, editar, inativar,
// listar e abrir; as recusas do código, das datas e do "Controle de lote".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, product, plain, warehouse;
const message = (expected) => (error) => error.message === expected;

before(async () => {
  f = await dualFixture();
  u = f.users;
  product = await f.catalog("products", { name: "Produto com lote", unit: "UN", kind: "P", format: "S", price: "10" });
  plain = await f.catalog("products", { name: "Produto sem lote", unit: "UN", kind: "P", format: "S", price: "10" });
  const v = (await f.db.query("select version v from erp_catalog.record where id=$1", [product.id])).rows[0].v;
  await f.rpc("erp_catalog_product_save", { p_user_id: u.admin, p_id: product.id, p_expected_version: v, p_command_id: randomUUID(), p_data: { name: "Produto com lote", lot_control: true }, p_acknowledged: null });
  warehouse = await f.catalog("warehouses", { name: "Depósito dos lotes do cadastro" });
});
after(() => f?.close());

const save = (data, extra = {}) =>
  f.rpc("erp_stock_lot_save", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_product_id: product.id, p_lot_id: null, p_expected_version: 0,
    p_code: data.code, p_manufactured_on: data.manufactured_on ?? null, p_expires_on: data.expires_on ?? null, p_note: data.note ?? null, ...extra,
  });

test("criar, editar, inativar, listar e abrir", async () => {
  const command = randomUUID();
  const b = (await save({ code: "b-002", expires_on: "2027-03-01", note: " primeira " }, { p_command_id: command })).lot;
  const a = (await save({ code: "A-001", manufactured_on: "2026-01-01", expires_on: "2026-12-31" })).lot;
  await save({ code: "C-003" });
  const edited = await save({ code: "b-002", expires_on: "2027-04-01" }, { p_lot_id: b.id, p_expected_version: 1 });
  assert.equal(edited.lot.version, 2);
  const off = await f.rpc("erp_stock_lot_status", { p_user_id: u.estoque, p_command_id: randomUUID(), p_lot_id: a.id, p_expected_version: 1, p_active: false });
  assert.equal(off.lot.active, false);
  const list = await f.rpc("erp_stock_lots", { p_user_id: u.consulta, p_product_id: product.id, p_warehouse_id: null, p_status: "all", p_offset: 0, p_limit: 10 });
  assert.deepEqual(list.items.map((l) => l.code), ["b-002", "C-003", "A-001"]);
  await f.rpc("erp_stock_lots", { p_user_id: u.consulta, p_product_id: product.id, p_warehouse_id: warehouse.id, p_status: "active", p_offset: 1, p_limit: 1 });
  const got = await f.rpc("erp_stock_lot_get", { p_user_id: u.consulta, p_lot_id: b.id, p_limit: 10 });
  assert.equal(got.lot.code, "b-002");
});

test("recusas: código repetido, código imutável, sem mudança, datas e controle de lote", async () => {
  const lot = (await save({ code: "D-004" })).lot;
  await assert.rejects(save({ code: " d-004 " }), message("erp_stock_lot_code_taken"));
  await assert.rejects(save({ code: "D-005" }, { p_lot_id: lot.id, p_expected_version: 1 }), message("erp_stock_lot_code_immutable"));
  await assert.rejects(save({ code: "D-004" }, { p_lot_id: lot.id, p_expected_version: 1 }), message("erp_stock_lot_unchanged"));
  await assert.rejects(save({ code: "E-005", manufactured_on: "2027-01-02", expires_on: "2027-01-01" }), message("erp_stock_lot_invalid"));
  await assert.rejects(save({ code: "" }), message("erp_stock_lot_invalid"));
  await assert.rejects(save({ code: "F-006" }, { p_product_id: plain.id }), message("erp_stock_lot_control_off"));
  await assert.rejects(save({ code: "G-007" }, { p_user_id: u.consulta }), (e) => e.code === "42501");
  await assert.rejects(f.rpc("erp_stock_lot_status", { p_user_id: u.estoque, p_command_id: randomUUID(), p_lot_id: lot.id, p_expected_version: 1, p_active: true }), message("erp_stock_lot_unchanged"));
});
