// Recebimento de compra por item (rpc/purchase-receipts.ts) no diferencial:
// conferência, recebimento parcial, o resto, estorno de um recebimento,
// replay, leitura e as recusas. O pedido de compra nasce pelo
// erp_document_save e pelo erp_document_transition do oráculo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, supplier;
const message = (expected) => (error) => error.message === expected;
const scalar = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const reason = "Recebimento sintético";

before(async () => {
  f = await dualFixture();
  u = f.users;
  supplier = await f.catalog("contacts", { name: "Fornecedor dos recebimentos", person_type: "J", roles: ["supplier"] });
});
after(() => f?.close());

const product = (name, extra = {}) => f.catalog("products", { name, unit: "UN", kind: "P", format: "S", price: "10", ...extra });
const version = (id) => scalar("select version v from erp_documents.document where id=$1", [id]);
const balance = (p, w) => scalar("select quantity::text v from erp_stock.balance where product_id=$1 and warehouse_id=$2", [p.id, w.id]);
async function order(items, w) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: u.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date: today, contact_id: supplier.id, warehouse_id: w.id, items },
    })
  ).document;
  d = (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Transição sintética" })).document;
  return d;
}
const itemIds = async (d) => (await f.db.query("select id::text from erp_documents.item where document_id=$1 order by position", [d.id])).rows.map((r) => r.id);
const preview = async (d, items, extra = {}) =>
  (await f.rpc("erp_purchase_receipts_preview", { p_user_id: u.estoque, p_document_id: d.id, p_expected_version: await version(d.id), p_occurred_on: null, p_reason: reason, p_items: items, ...extra })).preview;
// O recebimento sem data falha nos dois motores: a conferência completa a data só na cópia dela, e o erp_stock.post recebe nulo.
async function receive(d, items, { command = randomUUID(), extra = {} } = {}) {
  const p = await preview(d, items);
  return f.rpc("erp_purchase_receipts_receive", {
    p_user_id: u.estoque, p_document_id: d.id, p_expected_version: await version(d.id), p_occurred_on: today, p_reason: reason, p_items: items,
    p_command_id: command, p_preview_hash: p.preview_hash, p_confirm: true, ...extra,
  });
}
async function reverse(d, receipt) {
  const base = { p_user_id: u.estoque, p_document_id: d.id, p_expected_version: await version(d.id), p_receipt_id: receipt, p_occurred_on: today, p_reason: "Estorno sintético" };
  const p = (await f.rpc("erp_purchase_receipts_reverse_preview", base)).preview;
  return f.rpc("erp_purchase_receipts_reverse", { ...base, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_confirm: true });
}

test("recebimento parcial, o resto, estorno e replay", async () => {
  const a = await product("Peça recebida A"),
    b = await product("Peça recebida B"),
    w = await f.catalog("warehouses", { name: "Depósito dos recebimentos" });
  const d = await order(
    [
      { product_id: a.id, description: "A", unit: "UN", quantity: "5", unit_price: "2" },
      { product_id: b.id, description: "B", unit: "UN", quantity: "3", unit_price: "4" },
    ],
    w,
  );
  const [ia, ib] = await itemIds(d);
  const shown = await preview(d, [{ item_id: ia, quantity: "2" }, { item_id: ib, quantity: "3" }]);
  assert.equal(shown.positions.length, 2);
  const command = randomUUID();
  const first = await receive(d, [{ item_id: ia, quantity: "2" }, { item_id: ib, quantity: "3" }], { command });
  assert.equal(await balance(a, w), "2.000000");
  assert.equal(first.current.items[0].remaining_quantity, "3.000000");
  // O mesmo comando com os mesmos dados: o resultado gravado.
  const again = await f.rpc("erp_purchase_receipts_command", { p_user_id: u.estoque, p_command_id: command });
  assert.equal(again.replayed, true);
  // Acima do pedido: recusa.
  await assert.rejects(preview(d, [{ item_id: ia, quantity: "4" }]), message("purchase_receipt_quantity_exceeded"));
  const second = await receive(d, [{ item_id: ia, quantity: "3" }]);
  assert.equal(await balance(a, w), "5.000000");
  // Estorno do primeiro recebimento.
  const undone = await reverse(d, first.receipt.receipt.id);
  assert.equal(undone.receipt.reversal.receipt_id, first.receipt.receipt.id);
  assert.equal(await balance(a, w), "3.000000");
  assert.equal(await balance(b, w), "0.000000");
  await assert.rejects(reverse(d, first.receipt.receipt.id), message("purchase_receipt_already_reversed"));
  const got = await f.rpc("erp_purchase_receipts_get", { p_user_id: u.estoque, p_document_id: d.id, p_limit: 25, p_after: null, p_receipt_id: second.receipt.receipt.id });
  assert.equal(got.items.length, 2);
  assert.equal(got.current.document.active_receipts, 1);
});

test("recusas: data fora da preferência, itens inválidos, sem acesso, confirmação", async () => {
  const a = await product("Peça das recusas"),
    w = await f.catalog("warehouses", { name: "Depósito das recusas de compra" });
  const d = await order([{ product_id: a.id, description: "A", unit: "UN", quantity: "2", unit_price: "1" }], w);
  const [ia] = await itemIds(d);
  await assert.rejects(preview(d, [{ item_id: ia, quantity: "1" }], { p_occurred_on: "2026-01-02" }), message("purchase_receipt_launch_date_mismatch"));
  await assert.rejects(preview(d, [{ item_id: ia, quantity: "0" }]), message("purchase_receipt_items_invalid"));
  await assert.rejects(preview(d, [{ item_id: ia, quantity: 1 }]), message("purchase_receipt_items_invalid"));
  await assert.rejects(preview(d, [{ item_id: randomUUID(), quantity: "1" }]), message("purchase_receipt_items_invalid"));
  await assert.rejects(
    f.rpc("erp_purchase_receipts_preview", { p_user_id: u.consulta, p_document_id: d.id, p_expected_version: await version(d.id), p_occurred_on: null, p_reason: reason, p_items: [{ item_id: ia, quantity: "1" }] }),
    message("purchase_receipt_access_denied"),
  );
  await assert.rejects(receive(d, [{ item_id: ia, quantity: "1" }], { extra: { p_confirm: false } }), message("purchase_receipt_input_invalid"));
  await assert.rejects(receive(d, [{ item_id: ia, quantity: "1" }], { extra: { p_preview_hash: "a".repeat(64) } }), message("purchase_receipt_preview_changed"));
});
