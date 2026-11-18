// P2: cada RPC passa pelo dualFixture (resposta, SQLSTATE e tabelas tocadas).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { posLaneFixture, today } from "../fagoo/documents-lanes-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";

let f;
before(async () => {
  assert.ok(isPorted("erp_pos_sale_execute"), "o diferencial exige a venda portada");
  f = await posLaneFixture();
  await f.receive(f.product.id, "100");
  await consumer(f.consumer.id);
});
after(() => f?.close());

const act = (action, data, user = f.users.admin, command = randomUUID()) =>
  f.rpc("erp_pos_sale_execute", { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const refused = (promise, code, message) => assert.rejects(promise, (e) => e.code === code && e.message === message);
const consumer = async (id) => f.rpc("erp_pos_settings_execute", {
  p_user_id: f.users.admin, p_command_id: randomUUID(), p_action: "settings_save",
  p_data: { expected_version: Number(await f.scalar("select version v from erp_pos.settings")), consumer_contact_id: id,
    pix_key_type: null, pix_key: null, pix_merchant_name: null, pix_merchant_city: null },
});
const item = (quantity = "1", price = "10") => ({ id: randomUUID(), product_id: f.product.id, description: f.product.name,
  code: f.product.code, unit: "UN", quantity, unit_price: price, discount_percent: "0", detailed_description: null });
const sale = (extra = {}, document = {}) => ({
  sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null,
  account_id: f.store.id, cash_session_id: null, contact_id: null, price_list_id: null,
  document: { date: today(), warehouse_id: f.warehouse.id, items: [item()], discount_mode: "amount", discount_value: "0",
    freight: "0", other_expenses: "0", notes: null, internal_notes: null, seller_id: null, category_id: null, ...document },
  payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: "1000", note: null }],
  destination_account_id: null, to_ledger: false, cash_received_cents: null, ...extra,
});
const cancel = (s, user = f.users.admin) => act("sale_cancel", { sale_id: s.id, expected_version: s.version, reason: "Cancelamento diferencial" }, user);

test("sale_save cria, atualiza, confere CAS da venda e do pedido e repete o recibo", async () => {
  const command = randomUUID(), data = sale({ payments: [] });
  const first = await act("sale_save", data, f.users.admin, command), s = first.record;
  assert.deepEqual([s.state, s.status, s.version, s.document_version, s.total_cents], ["open", "open", 1, 1, "1000"]);
  assert.deepEqual(await act("sale_save", data, f.users.admin, command), { ...first, replayed: true });
  await refused(act("sale_save", { ...data, cash_received_cents: "1000" }, f.users.admin, command), "40001", "erp_pos_command_conflict");
  await refused(act("sale_save", data, f.users.vendas, command), "40001", "erp_pos_command_conflict");
  const edit = { ...data, sale_id: s.id, expected_version: s.version, document_version: s.document_version,
    document: { ...data.document, notes: "Pré-venda revisada" } };
  await refused(act("sale_save", { ...edit, expected_version: 2 }), "40001", "erp_pos_version_conflict");
  await refused(act("sale_save", { ...edit, document_version: 2 }), "40001", "erp_pos_document_state");
  const saved = (await act("sale_save", edit)).record;
  assert.deepEqual([saved.id, saved.version, saved.document_version, saved.notes], [s.id, 2, 2, "Pré-venda revisada"]);
  // A repetição antiga devolve o registro congelado, mesmo depois de outra edição.
  assert.deepEqual(await act("sale_save", data, f.users.admin, command), { ...first, replayed: true });
  assert.equal(await f.scalar("select count(*)::int v from erp_pos.audit where command_id=$1", [command]), 1);
  const audit = (await f.db.query("select before_data,after_data from erp_pos.audit where sale_id=$1 order by id", [s.id])).rows;
  assert.equal(audit[0].before_data, null);
  assert.equal(audit[1].before_data.version, 1);
  assert.equal(audit[1].after_data.version, 2);
});

test("sale_finish com id nulo cria e finaliza: vendas deixa efeitos pendentes; admin recebe à vista", async () => {
  const stock = await f.stock(f.product.id), balance = await f.balance(f.store.id);
  const pending = (await act("sale_finish", sale(), f.users.vendas)).record;
  assert.deepEqual([pending.state, pending.status, pending.version], ["finished", "fulfilled", 2]);
  assert.deepEqual(pending.effects, { stock: "pending", finance: "pending", settled_cents: "0", open_cents: "0" });
  assert.equal(await f.stock(f.product.id), stock);
  const data = sale({ cash_received_cents: "1500" }), command = randomUUID();
  const done = await act("sale_finish", data, f.users.admin, command), s = done.record;
  assert.deepEqual(s.effects, { stock: "posted", finance: "posted", settled_cents: "1000", open_cents: "0" });
  assert.equal(s.change_cents, "500");
  assert.ok(s.payments[0].title_id && s.payments[0].settlement_id);
  assert.equal(BigInt(await f.balance(f.store.id)), BigInt(balance) + 1000n);
  assert.deepEqual(await act("sale_finish", data, f.users.admin, command), { ...done, replayed: true });
  await refused(cancel(s, f.users.vendas), "42501", "erp_pos_reverse_stock_denied");
  const reversed = (await cancel(s)).record;
  assert.deepEqual([reversed.state, reversed.status, reversed.effects.stock, reversed.effects.finance], ["cancelled", "cancelled", "reversed", "reversed"]);
  assert.equal(await f.balance(f.store.id), balance);
  assert.equal(await f.stock(f.product.id), stock);
  assert.equal((await cancel(pending, f.users.vendas)).record.state, "cancelled");
});

test("troco: Dinheiro (01) e Cheque (02) à vista contam no valor recebido; cartão não; recebido abaixo é recusado", async () => {
  const cheque = (await f.db.query("insert into erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) values('Cheque','02','caixa','ambos',$1,$1) returning id", [f.users.admin])).rows[0].id;
  await f.sync();
  const pay = (method, amount, days = 0) => ({ payment_method_id: method, days, amount_cents: amount, note: null });
  const save = (payments, received) => act("sale_save", sale({ payments, cash_received_cents: received }));
  // Só cheque: o recebido conta contra o cheque.
  assert.equal((await save([pay(cheque, "1000")], "1200")).record.change_cents, "200");
  // Dinheiro + cheque: os dois somam; o cartão fica fora do troco.
  assert.equal((await save([pay(f.methods.dinheiro, "400"), pay(cheque, "600")], "1000")).record.change_cents, "0");
  assert.equal((await save([pay(f.methods.dinheiro, "400"), pay(f.methods.cartao, "600")], "500")).record.change_cents, "100");
  // Cheque a prazo não é à vista; sem nada à vista, recebido é recusado.
  await refused(save([pay(cheque, "1000", 30)], "1000"), "22023", "erp_pos_cash_received_invalid");
  await refused(save([pay(cheque, "1000")], "999"), "22023", "erp_pos_cash_received_invalid");
});

test("sale_cancel sem efeitos e recusa financeira sem estoque", async () => {
  const open = (await act("sale_save", sale({ payments: [] }))).record;
  const cancelled = (await cancel(open, f.users.vendas)).record;
  assert.deepEqual(cancelled.effects, { stock: "none", finance: "none", settled_cents: "0", open_cents: "0" });
  await refused(cancel(cancelled), "40001", "erp_pos_sale_state");
  const service = { ...item(), product_id: f.service.id, description: f.service.name, code: f.service.code, unit_price: "10" };
  const done = (await act("sale_finish", sale({}, { items: [service] }))).record;
  assert.equal(done.effects.stock, "none");
  await refused(cancel(done, f.users.vendas), "42501", "erp_pos_reverse_finance_denied");
  await cancel(done);
});

test("sale_transfer: mesa habilitada, ocupada, CAS e repetição", async () => {
  await f.setPreference("vendas-frente-caixa", "pdv.controle_mesas", true);
  try {
    const a = (await act("sale_save", sale({ kind: "mesa", table_number: 81, payments: [] }))).record;
    const b = (await act("sale_save", sale({ kind: "mesa", table_number: 82, payments: [] }))).record;
    const data = { sale_id: a.id, expected_version: a.version, table_number: 83 }, command = randomUUID();
    await refused(act("sale_transfer", { ...data, table_number: 81 }), "22023", "erp_pos_invalid_number");
    await refused(act("sale_transfer", { ...data, table_number: 82 }), "40001", "erp_pos_table_busy");
    const moved = await act("sale_transfer", data, f.users.vendas, command);
    assert.deepEqual([moved.record.table_number, moved.record.version], [83, 2]);
    assert.deepEqual(await act("sale_transfer", data, f.users.vendas, command), { ...moved, replayed: true });
    await refused(act("sale_transfer", data), "40001", "erp_pos_version_conflict");
    await cancel(moved.record); await cancel(b);
  } finally { await f.setPreference("vendas-frente-caixa", "pdv.controle_mesas", false); }
});

test("recusas de data, consumidor, controle de caixa e estoque negativo", async () => {
  await refused(act("sale_finish", sale({}, { date: "2000-01-01" })), "22023", "erp_pos_invalid_date");
  await consumer(null);
  try { await refused(act("sale_save", sale({ payments: [] })), "22023", "erp_pos_consumer_required"); }
  finally { await consumer(f.consumer.id); }
  await f.setPreference("vendas-frente-caixa", "pdv.controle_caixa", true);
  try { await refused(act("sale_finish", sale()), "40001", "erp_pos_cash_session_required"); }
  finally { await f.setPreference("vendas-frente-caixa", "pdv.controle_caixa", false); }
  await refused(act("sale_save", sale({ payments: [] }, { items: [item("1000")] })), "22023", "erp_pos_stock_insufficient");
  // A recusa do documento também desfaz pedido, recibo e auditoria.
  const count = await f.scalar("select count(*)::int v from erp_documents.document"), command = randomUUID();
  await refused(act("sale_finish", sale({ payments: [{ payment_method_id: f.methods.dinheiro, days: 0, amount_cents: "999", note: null }] }), f.users.admin, command), "22023", "erp_document_installment_total_mismatch");
  assert.equal(await f.scalar("select count(*)::int v from erp_documents.document"), count);
  assert.equal(await f.scalar("select count(*)::int v from erp_pos.command where id=$1", [command]), 0);
});

test("vendedor sem pdv_editar_preco: preço base, preço da lista e recusa fora da lista", async () => {
  const sellerContact = await f.catalog("contacts", { name: "Vendedor diferencial", roles: ["customer"] });
  await f.db.query("insert into erp_catalog.seller(contact_id,user_id,modules,created_by,updated_by) values($1,$2,$3,$4,$4)",
    [sellerContact.id, f.users.vendedor, JSON.stringify({ frente_caixa: true, pdv_registro_itens: true }), f.users.admin]);
  const list = await f.scalar("insert into erp_pricing.price_list(name,category,list_type,factor,factor_unit,direction) values('Lista diferencial','other','custom',null,'percent','discount') returning id v");
  await f.db.query("insert into erp_pricing.price_list_item(list_id,product_id,custom_price) values($1,$2,8.125)", [list, f.product.id]);
  await f.sync();
  // erp_pricing_product_lists arredonda o preço customizado a duas casas.
  const data = sale({ payments: [], price_list_id: list }, { items: [item("1", "8.13")] });
  const listed = (await act("sale_save", data, f.users.vendedor)).record;
  assert.equal(listed.total_cents, "813");
  assert.equal(listed.price_list_id, list);
  await act("sale_save", sale({ payments: [], price_list_id: list }), f.users.vendedor);
  await refused(act("sale_save", sale({ payments: [], price_list_id: list }, { items: [item("1", "8.12")] }), f.users.vendedor), "42501", "erp_pos_edit_price_denied");
  await refused(act("sale_save", sale({ payments: [] }, { items: [item("1", "8.125")] }), f.users.vendedor), "42501", "erp_pos_edit_price_denied");
});

test("jsonb null, chaves ausentes, tipos inválidos e escala de quantidade/dinheiro", async () => {
  for (const [key, value, code, message] of [
    ["to_ledger", null, "22023", "erp_pos_invalid_data"],
    ["cash_received_cents", 1000, "22023", "erp_pos_invalid_amount"],
    ["table_number", "1", "22023", "erp_pos_invalid_number"],
    ["contact_id", "invalid", "22023", "erp_pos_invalid_id"],
    ["payments", null, "22023", "erp_pos_invalid_payments"],
  ]) await refused(act("sale_save", sale({ [key]: value })), code, message);
  const missing = sale(); delete missing.to_ledger;
  await refused(act("sale_save", missing), "22023", "erp_pos_invalid_data");
  const settings = await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: "empresa-geral" });
  const priceDecimals = settings.items.find((i) => i.key === "empresa.decimais_preco_saida").value;
  const quantityDecimals = settings.items.find((i) => i.key === "empresa.decimais_quantidade").value;
  await f.setPreference("empresa-geral", "empresa.decimais_preco_saida", 10);
  await f.setPreference("empresa-geral", "empresa.decimais_quantidade", 6);
  try {
    const saved = (await act("sale_save", sale({ payments: [] }, { items: [item("0.123456", "10.1234567890")] }))).record;
    assert.deepEqual([saved.items[0].quantity, saved.items[0].unit_price, saved.total_cents], ["0.123456", "10.1234567890", "125"]);
  } finally {
    await f.setPreference("empresa-geral", "empresa.decimais_preco_saida", priceDecimals);
    await f.setPreference("empresa-geral", "empresa.decimais_quantidade", quantityDecimals);
  }
});

test("efeito recusado após escrever: savepoint reverte a baixa e conserva venda/contas", async () => {
  // Falha deliberadamente tardia: o movimento da baixa já foi escrito quando
  // o gatilho recusa. Os dois bancos recebem a mesma condição; nenhum RPC é mockado.
  await f.db.exec(`create function erp_pos.test_refuse_settlement() returns trigger language plpgsql as $$
    begin raise exception 'erp_pos_test_late_refusal' using errcode='22023'; end $$;
    create trigger test_pos_late_refusal after insert on erp_finance.settlement for each row execute function erp_pos.test_refuse_settlement();`);
  f.lite.exec(`CREATE TEMP TRIGGER test_pos_late_refusal AFTER INSERT ON erp_finance__settlement
    BEGIN SELECT RAISE(ABORT,'22023:erp_pos_test_late_refusal'); END`);
  const command = randomUUID(), balance = await f.balance(f.store.id);
  try {
    const done = (await act("sale_finish", sale(), f.users.admin, command)).record;
    assert.deepEqual(done.effects, { stock: "posted", finance: "posted", settled_cents: "0", open_cents: "1000", settle_reason: "erp_pos_test_late_refusal" });
    assert.equal(done.payments[0].settlement_id, null);
    assert.ok(done.payments[0].title_id);
    assert.equal(await f.balance(f.store.id), balance);
    const h = createHash("md5").update(`${command}:erp_pos:settle:1`).digest("hex");
    const step = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    assert.equal(await f.scalar("select count(*)::int v from erp_finance.command where id=$1", [step]), 0);
  } finally {
    f.lite.exec("DROP TRIGGER test_pos_late_refusal");
    await f.db.exec("drop trigger test_pos_late_refusal on erp_finance.settlement; drop function erp_pos.test_refuse_settlement()");
  }
});
