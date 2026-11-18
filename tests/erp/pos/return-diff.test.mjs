// P3: resultado, SQLSTATE e tabelas tocadas pelo dualFixture, sem espelhar o RPC.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { posLaneFixture, today } from "../fagoo/documents-lanes-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";

let f;
before(async () => {
  assert.ok(isPorted("erp_pos_return_execute"), "o diferencial exige a devolução portada");
  f = await posLaneFixture();
  await f.receive(f.product.id, "100");
  await f.rpc("erp_pos_settings_execute", { p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "settings_save",
    p_data: { expected_version: Number(await f.scalar("select version v from erp_pos.settings")), consumer_contact_id: f.consumer.id,
      pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null } });
});
after(() => f?.close());

const pay = (amount, cash = true) => ({ payment_method_id: cash ? f.methods.dinheiro : f.methods.cartao, days: cash ? 0 : 30, amount_cents: amount, note: null });
const finish = async ({ quantity = "2", price = "10", discount = "0", freight = "0", payments = [pay("2000")], service = false, user = f.users.admin } = {}) => {
  const product = service ? f.service : f.product;
  return (await f.rpc("erp_pos_sale_execute", { p_user_id: user, p_command_id: randomUUID(), p_action: "sale_finish",
    p_data: { sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null,
      account_id: f.store.id, cash_session_id: null, contact_id: null, price_list_id: null, destination_account_id: null, to_ledger: false, cash_received_cents: null,
      document: { date: today(), warehouse_id: f.warehouse.id, items: [{ id: randomUUID(), product_id: product.id, description: product.name,
        code: product.code, unit: "UN", quantity, unit_price: price, discount_percent: "0", detailed_description: null }], discount_mode: "amount", discount_value: discount,
        freight, other_expenses: "0", notes: null, internal_notes: null, seller_id: null, category_id: null }, payments } })).record;
};
const dataFor = (s, quantity) => ({ sale_id: s.id, expected_version: s.version, items: [{ item_id: s.items[0].id, quantity }],
  refund_account_id: null, cash_session_id: null, reason: "Devolução diferencial" });
const act = (data, user = f.users.admin, command = randomUUID()) => f.rpc("erp_pos_return_execute", {
  p_user_id: user, p_command_id: command, p_action: "sale_return", p_data: data,
});
const giveBack = (s, quantity) => act(dataFor(s, quantity));
const refused = (promise, code, message) => assert.rejects(promise, (e) => e.code === code && e.message === message);
const titles = async (s) => (await f.db.query(`select t.id,t.version,t.cancelled,t.amount_cents::text amount,t.settled_cents::text settled,r.source
  from erp_finance.document_posting p join erp_finance.document_title l on l.posting_id=p.id
  join erp_finance.title t on t.id=l.title_id left join erp_finance.title_return r on r.title_id=t.id
  where p.document_id=$1 and p.state='active' order by l.position`, [s.document_id])).rows;

test("parcial e total: última devolução leva o restante do item; frete fica na venda", async () => {
  const s = await finish({ quantity: "3", price: "1", discount: "2", freight: "0.50", payments: [pay("150")] });
  const balance = BigInt(await f.balance(f.store.id)), stock = await f.stock(f.product.id);
  const first = await giveBack(s, "1"), second = await giveBack(first.record, "1"), last = await giveBack(second.record, "1");
  assert.deepEqual([first.return.value_cents, second.return.value_cents, last.return.value_cents], ["33", "33", "34"]);
  assert.equal(last.record.returned[s.items[0].id], "3.000000");
  assert.equal(last.record.returns.length, 3);
  assert.equal(BigInt(await f.balance(f.store.id)), balance - 100n);
  assert.equal(Number(await f.stock(f.product.id)), Number(stock) + 3);
  await refused(giveBack(last.record, "0.000001"), "22023", "erp_pos_return_exceeds");
});

test("repetição congela resultado, não duplica auditoria; dados e ator conflitantes recusam", async () => {
  const s = await finish(), data = dataFor(s, "1"), command = randomUUID();
  const first = await act(data, f.users.admin, command);
  await giveBack(first.record, "1");
  assert.deepEqual(await act(data, f.users.admin, command), { ...first, replayed: true });
  await refused(act({ ...data, reason: "Outro motivo" }, f.users.admin, command), "40001", "erp_pos_command_conflict");
  await refused(act(data, f.users.vendas, command), "40001", "erp_pos_command_conflict");
  assert.equal(await f.scalar("select count(*)::int v from erp_pos.sale_return where command_id=$1", [command]), 1);
  const audit = (await f.db.query("select before_data,after_data from erp_pos.audit where command_id=$1", [command])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].before_data.version, s.version);
  assert.deepEqual(audit[0].after_data, first.return);
  await refused(act(data), "40001", "erp_pos_version_conflict");
});

test("limite de 20 devoluções: a vigésima passa e a próxima recusa antes de devolver", async () => {
  let s = await finish({ quantity: "21", price: "1", payments: [pay("2100")] });
  for (let n = 0; n < 20; n++) s = (await giveBack(s, "1")).record;
  assert.equal(s.returns.length, 20);
  assert.equal(s.returned[s.items[0].id], "20.000000");
  await refused(giveBack(s, "1"), "22023", "erp_pos_returns_limit");
});

test("dinheiro limitado ao recebido; parcela aberta vira Devolvido só ao completar a venda", async () => {
  const s = await finish({ payments: [pay("1000"), pay("1000", false)] });
  const first = await giveBack(s, "1");
  assert.deepEqual([first.return.refund_cents, first.return.returned_titles], ["1000", 0]);
  assert.deepEqual((await titles(s)).map((t) => [t.cancelled, t.source]), [[false, null], [false, null]]);
  await refused(giveBack(first.record, "0.5"), "22023", "erp_pos_return_exceeds_paid");
  const last = await giveBack(first.record, "1");
  assert.deepEqual([last.return.value_cents, last.return.refund_cents, last.return.refund, last.return.returned_titles], ["1000", "0", false, 1]);
  assert.deepEqual((await titles(s)).map((t) => [t.cancelled, t.source?.kind ?? null]), [[false, null], [true, "pos_return"]]);
  const mixed = await finish({ payments: [pay("800"), pay("1200", false)] });
  const full = await giveBack(mixed, "2");
  assert.deepEqual([full.return.value_cents, full.return.refund_cents, full.return.returned_titles], ["2000", "800", 1]);
  const credit = await finish({ payments: [pay("2000", false)] });
  const unpaid = await giveBack(credit, "2");
  assert.deepEqual([unpaid.return.refund_cents, unpaid.return.refund, unpaid.return.returned_titles], ["0", false, 1]);
});

test("parcela parcialmente recebida bloqueia e desfaz inclusive a entrada de estoque", async () => {
  const s = await finish({ payments: [pay("2000", false)] }), [title] = await titles(s);
  await f.rpc("erp_finance_execute", { p_user_id: f.users.financeiro, p_command_id: randomUUID(), p_action: "settle",
    p_data: { id: title.id, expected_version: title.version, account_id: f.store.id, posted_on: today(), principal_cents: "500" } });
  const stock = await f.stock(f.product.id), balance = await f.balance(f.store.id), command = randomUUID();
  await refused(act(dataFor(s, "2"), f.users.admin, command), "22023", "erp_pos_return_partial_title");
  assert.equal(await f.stock(f.product.id), stock);
  assert.equal(await f.balance(f.store.id), balance);
  assert.deepEqual((await titles(s)).map((t) => [t.settled, t.cancelled, t.source]), [["500", false, null]]);
  assert.equal(await f.scalar("select count(*)::int v from erp_pos.command where id=$1", [command]), 0);
  assert.equal(await f.scalar("select count(*)::int v from erp_pos.sale_return where sale_id=$1", [s.id]), 0);
});

test("efeitos pendentes e perfis sem estoque ou financeiro recusam", async () => {
  const pending = await finish({ user: f.users.vendas });
  await refused(giveBack(pending, "1"), "40001", "erp_pos_return_effects_pending");
  const s = await finish();
  await refused(act(dataFor(s, "1"), f.users.vendas), "42501", "erp_pos_return_stock_denied");
  const service = await finish({ service: true });
  await refused(act(dataFor(service, "1"), f.users.vendas), "42501", "erp_pos_return_finance_denied");
  for (const user of [f.users.estoque, f.users.financeiro, f.users.consulta])
    await refused(act(dataFor(s, "1"), user), "42501", "erp_pos_access_denied");
});

test("validações: ausência, jsonb null, quantidade, repetição de item e motivo", async () => {
  const s = await finish(), valid = dataFor(s, "1");
  const missing = { ...valid }; delete missing.items;
  await refused(act(missing), "22023", "erp_pos_invalid_data");
  await refused(act({ ...valid, items: null }), "22023", "erp_pos_invalid_items");
  await refused(act({ ...valid, reason: "ab" }), "22023", "erp_pos_reason_required");
  for (const quantity of [null, 1, "0", "-1", "0.0000001"])
    await refused(act({ ...valid, items: [{ item_id: s.items[0].id, quantity }] }), "22023", "erp_pos_invalid_items");
  await refused(act({ ...valid, items: [{ item_id: s.items[0].id }] }), "22023", "erp_pos_invalid_data");
  await refused(act({ ...valid, items: [...valid.items, ...valid.items] }), "22023", "erp_pos_invalid_items");
  await refused(act({ ...valid, items: [{ ...valid.items[0], item_id: randomUUID() }] }), "22023", "erp_pos_invalid_items");
});
