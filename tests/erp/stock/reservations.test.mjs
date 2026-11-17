// Reservas de estoque do pedido de venda (rpc/reservations.ts) no diferencial:
// conferência de reservar, liberar e baixar; leitura da reserva, do comando e
// das reservas do produto. A aplicação (erp_stock_reservation_apply) ainda
// roda só no oráculo (pedido de venda espera os adiados da O) e o estado é
// espelhado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, contact, product, warehouse;
const message = (expected) => (error) => error.message === expected;
const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const meta = { p_occurred_on: "2026-10-15", p_reason: "Reserva sintética" };

before(async () => {
  f = await dualFixture();
  u = f.users;
  contact = await f.catalog("contacts", { name: "Cliente das reservas", person_type: "J", roles: ["customer", "supplier"] });
  product = await f.catalog("products", { name: "Produto das reservas", unit: "UN", kind: "P", format: "S", price: "10" });
  warehouse = await f.catalog("warehouses", { name: "Depósito das reservas" });
  await f.rpc("erp_stock_post", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-14", p_reason: "Saldo inicial", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "10", expected_version: 0 }],
  });
});
after(() => f?.close());

const version = (id) => scalar("select version v from erp_documents.document where id=$1", [id]);
async function order(quantity = "4", statuses = ["verified"]) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: "2026-10-15", contact_id: contact.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, description: "Item", unit: "UN", quantity, unit_price: "5" }] },
    })
  ).document;
  for (const s of statuses)
    d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: "Transição sintética" })).document;
  return d;
}
const preview = async (d, action = "reserve", extra = {}) =>
  (await f.rpc("erp_stock_reservation_preview", { p_user_id: u.estoque, p_document_id: d.id, p_expected_version: await version(d.id), p_action: action, ...meta, ...extra })).preview;
async function apply(d, action = "reserve", extra = {}) {
  const p = await preview(d, action, extra);
  const command = randomUUID();
  const r = await f.rpc("erp_stock_reservation_apply", {
    p_user_id: u.estoque, p_document_id: d.id, p_expected_version: await version(d.id), p_command_id: command, p_action: action,
    p_preview_hash: p.preview_hash, ...meta, p_ignored_item_ids: p.ignored.map((i) => i.id), ...extra,
  });
  return { r, command };
}

test("conferência de reservar, reserva aplicada, leitura e conferência de liberar e baixar", async () => {
  const d = await order("4");
  const shown = await preview(d);
  assert.equal(shown.positions.length, 1);
  assert.equal(shown.positions[0].quantity, "4.000000");
  assert.equal(shown.positions[0].available_after, "6.000000");
  const { command } = await apply(d);
  const reservation = (await f.db.query("select id::text, version from erp_stock.reservation where document_id=$1 and state='active'", [d.id])).rows[0];
  const got = await f.rpc("erp_stock_reservation_get", { p_user_id: u.consulta, p_document_id: d.id, p_limit: 25 });
  assert.equal(got.current.active_reservation.id, reservation.id);
  assert.equal(got.items[0].positions_count, 1);
  const receipt = await f.rpc("erp_stock_reservation_command", { p_user_id: u.estoque, p_command_id: command });
  assert.equal(receipt.replayed, true);
  const byProduct = await f.rpc("erp_stock_product_reservations", { p_user_id: u.consulta, p_product_id: product.id, p_warehouse_id: null });
  assert.equal(byProduct.quantity, "4.000000");
  // Reservar de novo: já há reserva ativa.
  await assert.rejects(preview(d), message("erp_stock_reservation_ineligible"));
  const ref = { p_reservation_id: reservation.id, p_reservation_version: reservation.version };
  const release = await preview(d, "release", ref);
  assert.equal(release.positions[0].reserved_after, "0.000000");
  const consume = await preview(d, "consume", ref);
  assert.equal(consume.positions[0].physical_after, "6.000000");
  // Versão da reserva errada, data antes da reserva, ação inválida.
  await assert.rejects(preview(d, "release", { ...ref, p_reservation_version: reservation.version + 1 }), message("erp_stock_reservation_conflict"));
  await assert.rejects(preview(d, "release", { ...ref, p_occurred_on: "2026-10-14" }), message("erp_stock_reservation_invalid_date"));
  await assert.rejects(preview(d, "reserve", ref), message("erp_stock_reservation_invalid_action"));
});

test("reserva acima do disponível e pedido fora da situação", async () => {
  // Físico 10, reservado 4 no teste anterior: 8 cabem no físico, não no disponível.
  await assert.rejects(preview(await order("8")), message("erp_stock_available_quantity_insufficient"));
  // Acima do físico, a conferência do documento recusa antes.
  await assert.rejects(preview(await order("100")), message("erp_stock_insufficient_or_excess_quantity"));
  await assert.rejects(preview(await order("1", [])), message("erp_stock_reservation_ineligible"));
  await assert.rejects(f.rpc("erp_stock_reservation_get", { p_user_id: u.consulta, p_document_id: randomUUID(), p_limit: 25 }), message("erp_document_not_found"));
  await assert.rejects(f.rpc("erp_stock_product_reservations", { p_user_id: u.consulta, p_product_id: null, p_warehouse_id: null }), message("erp_stock_invalid_query"));
});
