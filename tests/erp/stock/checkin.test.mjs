// Diferencial dos oito RPCs de check-in. DETAIL não integra o contrato do
// motor; código/mensagem, resposta e tabelas escritas são comparados pelo harness.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import { invoice, product, seed, error, readEffects } from "./invoice-fixture.mjs";
let f, p, w;
before(async () => {
  for (const action of ["get", "save", "issue", "batch", "restart", "finish", "finish_post", "post_preview"]) assert.ok(isPorted(`erp_stock_checkin_${action}`));
  f = await dualFixture(); p = await product(f); w = await f.catalog("warehouses", { name: "Check-in" });
});
after(() => f?.close());
const args = (id, version = 0, more = {}) => ({ p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: version, p_command_id: randomUUID(), ...more });
const get = (id, user = f.users.estoque) => f.rpc("erp_stock_checkin_get", { p_user_id: user, p_invoice_id: id });
const call = (action, a) => f.rpc(`erp_stock_checkin_${action}`, a);
const note = (options = {}) => invoice(f, { items: [{ product_id: p.id }, { product_id: p.id, quantity: "3" }], ...options });

test("salvar, pendência, lote, reinício e finalizar: recibos, CAS e imutabilidade", async () => {
  const id = await note();
  assert.equal((await get(id)).version, 0);
  const save = args(id, 0, { p_items: [{ position: 1, received: "1.5" }] });
  const r = await call("save", save);
  assert.equal(r.version, 1); assert.equal(r.items[0].received, "1.5000");
  assert.equal((await call("save", save)).replayed, true);
  await assert.rejects(call("save", { ...save, p_items: [{ position: 1, received: "1" }] }), error("erp_stock_checkin_command_conflict", "40001"));
  await assert.rejects(call("save", args(id, 0, { p_items: [{ position: 1, received: "1" }] })), error("erp_stock_checkin_version_conflict", "40001"));
  const issue = args(id, 1, { p_position: 2, p_kind: "damaged", p_quantity: "1", p_action: "none" });
  assert.equal((await call("issue", issue)).items[1].issue, "damaged");
  assert.equal((await call("issue", issue)).replayed, true);
  await assert.rejects(call("issue", { ...issue, p_quantity: "2" }), error("erp_stock_checkin_command_conflict", "40001"));
  const batch = args(id, 2, { p_positions: [2, 1] });
  assert.equal((await call("batch", batch)).version, 3);
  assert.equal((await call("batch", batch)).replayed, true);
  await assert.rejects(call("batch", { ...batch, p_positions: [1] }), error("erp_stock_checkin_command_conflict", "40001"));
  await seed(f, "update erp_fiscal_invoices.invoice set version=2 where id=$1", [id]);
  assert.equal((await get(id)).checkin.stale, true);
  await assert.rejects(call("batch", args(id, 3, { p_positions: [1] })), error("erp_stock_checkin_note_changed", "40001"));
  const restart = args(id, 3);
  assert.equal((await call("restart", restart)).items[0].received, "0.0000");
  assert.equal((await call("restart", restart)).replayed, true);
  await assert.rejects(call("restart", { ...restart, p_expected_version: 4 }), error("erp_stock_checkin_command_conflict", "40001"));
  const finish = args(id, 4);
  const done = await call("finish", finish);
  assert.equal(done.version, 6); assert.equal(done.checkin.state, "finished");
  assert.equal((await call("finish", finish)).replayed, true);
  await assert.rejects(call("finish", { ...finish, p_expected_version: 5 }), error("erp_stock_checkin_command_conflict", "40001"));
  await assert.rejects(call("restart", args(id, 6)), error("erp_stock_checkin_finished", "40001"));
  await readEffects(f, p.id);
});

test("validação de entrada e acesso de cada RPC", async () => {
  const id = await note();
  for (const user of [f.users.admin, f.users.estoque, f.users.fiscal]) await get(id, user);
  for (const user of [f.users.consulta, f.users.vendas, f.users.financeiro, f.users.inactive]) await assert.rejects(get(id, user), error("erp_stock_checkin_access_denied", "42501"));
  await assert.rejects(get(null), error("erp_stock_invalid_query"));
  const valid = {
    save: { ...args(id), p_items: [{ position: 1, received: "1" }] }, issue: { ...args(id), p_position: 1, p_kind: "missing", p_quantity: "1", p_action: "none" },
    batch: { ...args(id), p_positions: [1] }, restart: args(id, 1), finish: args(id, 1),
    post_preview: { p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: 1, p_warehouse_id: w.id },
    finish_post: args(id, 1, { p_warehouse_id: w.id, p_preview_hash: "0".repeat(64) }),
  };
  for (const [action, a] of Object.entries(valid)) {
    const posting = action.includes("post");
    for (const user of [f.users.fiscal, f.users.consulta, f.users.vendas, f.users.financeiro, f.users.inactive])
      await assert.rejects(call(action, { ...a, p_user_id: user }), error(posting ? "erp_invoice_stock_access_denied" : "erp_stock_checkin_access_denied", "42501"));
    for (const version of [null, -1, 2147483647]) await assert.rejects(call(action, { ...a, p_expected_version: version }), error(posting ? "erp_invoice_stock_invalid" : "erp_stock_checkin_input_invalid"));
    if (!posting) for (const key of ["p_invoice_id", "p_command_id"]) await assert.rejects(call(action, { ...a, [key]: null }), error("erp_stock_checkin_input_invalid"));
    else await assert.rejects(call(action, { ...a, p_warehouse_id: null }), error("erp_invoice_stock_invalid"));
  }
  for (const items of [null, {}, [], [null], [{ position: 0, received: "1" }], [{ position: 1, received: 1 }], [{ position: 1, received: "01" }], [{ position: 1, received: "1.00001" }], [{ position: 1, received: "1", extra: true }], [{ position: 1, received: "1" }, { position: 1, received: "2" }]])
    await assert.rejects(call("save", { ...valid.save, p_items: items }), error("erp_stock_checkin_input_invalid"));
  for (const positions of [null, {}, [], [0], ["1"], [1, 1], [1000]]) await assert.rejects(call("batch", { ...valid.batch, p_positions: positions }), error("erp_stock_checkin_input_invalid"));
  for (const patch of [{ p_kind: null }, { p_kind: "x" }, { p_action: "credit" }, { p_quantity: null }, { p_quantity: "0" }, { p_quantity: "-1" }, { p_position: 991 }, { p_kind: "refused" }]) await assert.rejects(call("issue", { ...valid.issue, ...patch }), error("erp_stock_checkin_input_invalid"));
});

test("recusas de negócio, nota vazia/fechada e item recusado", async () => {
  const id = await note();
  await assert.rejects(call("save", args(id, 0, { p_items: [{ position: 1, received: "0" }] })), error("erp_stock_checkin_unchanged"));
  await assert.rejects(call("issue", args(id, 0, { p_position: 1, p_kind: "missing", p_quantity: "3", p_action: "none" })), error("erp_stock_checkin_issue_quantity_invalid"));
  await call("issue", args(id, 0, { p_position: 1, p_kind: "refused", p_quantity: null, p_action: "none" }));
  for (const [action, extra] of [["save", { p_items: [{ position: 1, received: "1" }] }], ["batch", { p_positions: [1] }], ["issue", { p_position: 1, p_kind: "refused", p_quantity: null, p_action: "none" }]])
    await assert.rejects(call(action, args(id, 1, extra)), error("erp_stock_checkin_item_refused"));
  await assert.rejects(call("post_preview", { p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: 1, p_warehouse_id: w.id }), error("erp_stock_checkin_nothing_received"));
  const empty = await note({ items: [] });
  await assert.rejects(call("batch", args(empty, 0, { p_positions: [1] })), error("erp_stock_checkin_note_empty"));
  await assert.rejects(call("save", args(id, 1, { p_items: [{ position: 990, received: "1" }] })), error("erp_stock_checkin_item_not_found", "P0002"));
  await seed(f, "update erp_fiscal_invoices.invoice set status=3 where id=$1", [id]);
  assert.equal((await get(id)).note.open, false);
  await assert.rejects(call("restart", args(id, 1)), error("erp_stock_checkin_note_closed", "40001"));
  await assert.rejects(get(await note({ status: 3 })), error("erp_stock_checkin_note_not_found", "P0002"));
  await assert.rejects(get(await note({ direction: "1" })), error("erp_stock_checkin_note_not_found", "P0002"));
});

test("finalizar com estoque usa recebido, ignora recusados, permite estorno e replay", async () => {
  const productRow = await product(f), id = await note({ items: [{ product_id: productRow.id, quantity: "5" }, { product_id: productRow.id, quantity: "3" }] });
  await call("save", args(id, 0, { p_items: [{ position: 1, received: "2" }, { position: 2, received: "3" }] }));
  await call("issue", args(id, 1, { p_position: 2, p_kind: "refused", p_quantity: null, p_action: "none" }));
  const a = { p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: 2, p_warehouse_id: w.id };
  const preview = (await call("post_preview", a)).preview;
  assert.equal(preview.positions[0].quantity, "2.000000");
  await assert.rejects(call("post_preview", { ...a, p_expected_version: 1 }), error("erp_stock_checkin_version_conflict", "40001"));
  await assert.rejects(call("finish_post", { ...a, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }), error("erp_invoice_stock_preview_conflict", "40001"));
  const command = { ...a, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash };
  const result = await call("finish_post", command);
  assert.equal(result.checkin.checkin.state, "finished"); assert.equal(result.flag.flag, "S");
  assert.equal((await call("finish_post", command)).replayed, true);
  await assert.rejects(call("finish_post", { ...command, p_expected_version: 3 }), error("erp_invoice_stock_conflict", "40001"));
  await readEffects(f, productRow.id);
  const reverse = { p_user_id: f.users.estoque, p_invoice_id: id, p_posting_id: result.posting.id, p_posting_version: 1 };
  const rp = await f.rpc("erp_stock_invoice_reverse_preview", reverse);
  await f.rpc("erp_stock_invoice_reverse", { ...reverse, p_command_id: randomUUID(), p_preview_hash: rp.preview.preview_hash });
  await readEffects(f, productRow.id);
  assert.equal((await call("finish_post", command)).flag.flag, null);
});

test("CAS em todas as escritas e replay de lote sem mudança de quantidade", async () => {
  const id = await note();
  await call("batch", args(id, 0, { p_user_id: f.users.admin, p_positions: [1, 2] }));
  for (const [action, extra] of [["save", { p_items: [{ position: 1, received: "1" }] }], ["issue", { p_position: 1, p_kind: "incorrect", p_quantity: "1", p_action: "none" }], ["batch", { p_positions: [1] }], ["restart", {}], ["finish", {}]])
    await assert.rejects(call(action, args(id, 2, extra)), error("erp_stock_checkin_version_conflict", "40001"));
  const batch = args(id, 1, { p_positions: [1, 2] });
  assert.equal((await call("batch", batch)).version, 2);
  assert.equal((await call("batch", batch)).replayed, true);
  const a = { p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: 1, p_warehouse_id: w.id };
  await assert.rejects(call("finish_post", { ...a, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }), error("erp_stock_checkin_version_conflict", "40001"));
  await assert.rejects(call("save", { ...args(id, 2, { p_items: [{ position: 1, received: "1" }] }), p_command_id: batch.p_command_id }), error("erp_stock_checkin_command_conflict", "40001"));
});

test("check-in com unidade tributária proporcional recusa arredondamento", async () => {
  const own = await product(f), id = await note({ items: [{ product_id: own.id, quantity: "3", unit: "CX", others: { tax_unit: "UN", tax_quantity: "1" } }] });
  await call("save", args(id, 0, { p_items: [{ position: 1, received: "1" }] }));
  const a = { p_user_id: f.users.estoque, p_invoice_id: id, p_expected_version: 1, p_warehouse_id: w.id };
  await assert.rejects(call("post_preview", a), error("erp_invoice_stock_conversion_inexact"));
  const before = await get(id);
  await assert.rejects(call("finish_post", { ...a, p_command_id: randomUUID(), p_preview_hash: "0".repeat(64) }), error("erp_invoice_stock_conversion_inexact"));
  assert.deepEqual(await get(id), before);
  await readEffects(f, own.id);
});

test("solicitado preserva os campos ainda nulos do pedido de compra", async () => {
  const contact = await f.catalog("contacts", { name: "Fornecedor do pedido em edição", person_type: "J", roles: ["supplier"] });
  const doc = (await f.rpc("erp_document_save", { p_user_id: f.users.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2024-09-01", contact_id: contact.id, items: [{ product_id: p.id, description: "Em edição", unit: "UN", quantity: "2", unit_price: "5" }] } })).document;
  await seed(f, "update erp_documents.item set quantity=null,unit_price=null where document_id=$1", [doc.id]);
  const id = await note();
  await seed(f, "insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [id, doc.id]);
  assert.deepEqual((await get(id)).items[0].requested, { quantity: "0.0000", prices: [null] });
});
