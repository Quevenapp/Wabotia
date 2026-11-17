// Lotes nos lançamentos (rpc/movement-lots.ts) no diferencial: lançamento
// com lote (entrada com lote novo, saída, transferência, balanço), informar
// os lotes de uma entrada já lançada e os lotes das linhas de um pedido.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, product, a, b;
const message = (expected) => (error) => error.message === expected;
const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const version = async (w) => (await scalar("select version v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [product.id, w.id])) ?? 0;
const lotBalance = (lot, w) => scalar("select quantity::text v from erp_stock.lot_balance where lot_id=$1 and warehouse_id=$2", [lot, w.id]);

before(async () => {
  f = await dualFixture();
  u = f.users;
  product = await f.catalog("products", { name: "Produto dos lotes lançados", unit: "UN", kind: "P", format: "S", price: "10" });
  const v = await scalar("select version v from erp_catalog.record where id=$1", [product.id]);
  await f.rpc("erp_catalog_product_save", { p_user_id: u.admin, p_id: product.id, p_expected_version: v, p_command_id: randomUUID(), p_data: { name: "Produto dos lotes lançados", lot_control: true }, p_acknowledged: null });
  a = await f.catalog("warehouses", { name: "Depósito A dos lotes" });
  b = await f.catalog("warehouses", { name: "Depósito B dos lotes" });
});
after(() => f?.close());

const lotLaunch = async (kind, w, quantity, lot, extra = {}) =>
  f.rpc("erp_stock_lot_launch", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: kind, p_product_id: product.id, p_warehouse_id: w.id, p_quantity: quantity,
    p_expected_version: await version(w), p_unit_price: null, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null, p_lot: lot, ...extra,
  });

test("lançamento com lote: entrada com lote novo, saída, transferência e balanço", async () => {
  const entry = await lotLaunch("receipt", a, "10", { code: "L-01", expires_on: "2027-06-30" });
  assert.equal(entry.lot.created, true);
  const lot = entry.lot.id;
  await lotLaunch("issue", a, "3", { lot_id: lot });
  await assert.rejects(lotLaunch("issue", a, "30", { lot_id: lot }), message("erp_stock_lot_insufficient"));
  await lotLaunch("transfer", a, "2", { lot_id: lot }, { p_destination_id: b.id, p_destination_version: await version(b) });
  assert.equal(await lotBalance(lot, a), "5.000000");
  assert.equal(await lotBalance(lot, b), "2.000000");
  const counted = await lotLaunch("balance", a, "4", { lot_id: lot });
  assert.deepEqual(counted.lot.balance, { counted: "4.000000", previous: "5.000000" });
  await assert.rejects(lotLaunch("receipt", a, "1", { code: "l-01" }), message("erp_stock_lot_code_taken"));
  await assert.rejects(lotLaunch("issue", a, "1", { code: "L-02" }), message("erp_stock_lot_launch_invalid"));
  await assert.rejects(lotLaunch("receipt", a, "1", { code: "L-03", expires_on: "2027-02-30" }), message("erp_stock_lot_launch_invalid"));
});

test("informar os lotes de uma entrada já lançada; as linhas do pedido", async () => {
  const launched = await f.rpc("erp_stock_launch", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_product_id: product.id, p_warehouse_id: b.id, p_quantity: "6",
    p_expected_version: await version(b), p_unit_price: null, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null,
  });
  const movement = launched.movement.id;
  const shown = await f.rpc("erp_stock_movement_lots", { p_user_id: u.consulta, p_movement_id: movement, p_product_id: product.id, p_warehouse_id: b.id });
  assert.equal(shown.line.assignable, true);
  assert.equal(shown.room, "6.000000");
  const lot = shown.candidates[0].id;
  const assigned = await f.rpc("erp_stock_movement_lots_assign", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_movement_id: movement, p_product_id: product.id, p_warehouse_id: b.id, p_expected_lots: 0,
    p_lots: [{ lot_id: lot, quantity: "2" }, { code: "M-01", quantity: "1.5", expires_on: "2028-01-01" }],
  });
  assert.equal(assigned.line.assigned, "3.500000");
  await assert.rejects(
    f.rpc("erp_stock_movement_lots_assign", {
      p_user_id: u.estoque, p_command_id: randomUUID(), p_movement_id: movement, p_product_id: product.id, p_warehouse_id: b.id, p_expected_lots: 0,
      p_lots: [{ lot_id: lot, quantity: "1" }],
    }),
    message("erp_stock_lot_version_conflict"),
  );
  await assert.rejects(
    f.rpc("erp_stock_movement_lots_assign", {
      p_user_id: u.estoque, p_command_id: randomUUID(), p_movement_id: movement, p_product_id: product.id, p_warehouse_id: b.id, p_expected_lots: 2,
      p_lots: [{ code: "M-02", quantity: "5" }],
    }),
    message("erp_stock_lot_assign_exceeded"),
  );
  // Pedido de compra recebido pelo lançamento do documento: as linhas dele com os lotes.
  const supplier = await f.catalog("contacts", { name: "Fornecedor dos lotes", person_type: "J", roles: ["supplier"] });
  let d = (await f.rpc("erp_document_save", {
    p_user_id: u.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-10-15", contact_id: supplier.id, warehouse_id: a.id, items: [{ product_id: product.id, description: "Item", unit: "UN", quantity: "2", unit_price: "1" }] },
  })).document;
  d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Transição" })).document;
  const meta = { p_user_id: u.estoque, p_kind: d.kind, p_document_id: d.id, p_occurred_on: "2026-10-15", p_reason: "Lançamento sintético" };
  const p = (await f.rpc("erp_document_stock_preview", { ...meta, p_expected_version: d.version })).preview;
  await f.rpc("erp_document_stock_post", { ...meta, p_expected_version: d.version, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_ignored_item_ids: [] });
  const lines = await f.rpc("erp_stock_source_lots", { p_user_id: u.estoque, p_source: "document", p_source_id: d.id, p_product_id: product.id });
  assert.equal(lines.posted, true);
  assert.equal(lines.lines.length, 1);
  assert.equal(lines.lines[0].unassigned, "2.000000");
});
