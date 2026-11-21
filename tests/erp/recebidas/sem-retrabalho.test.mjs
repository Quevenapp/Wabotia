// Compra pela nota sem retrabalho, no motor (SQLite, rotinas reais das telas):
// a baixa do pedido de compra pela nota (atendido total ou parcial, sem lançar
// o estoque duas vezes), o produto criado a partir do item do XML, a
// reposição pelo estoque mínimo e máximo com os pedidos por fornecedor, o
// inventário valorizado numa data e as notas recebidas nos relatórios de notas
// de entrada. Nada fala com cofre, R2 ou governo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inboundFixture, nfeXml, accessKey } from "./fixtures.mjs";
import { parseInboundXml } from "../../../src/erp/recebidas/xml.ts";
import { todaySaoPaulo } from "../../../src/erp/engine/time.ts";

const code = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };
const CHOICES = { items: [{ position: 1, factor: "12" }] };

/** Pedido de compra do fornecedor da nota, em andamento (o único que recebe nota). */
function purchaseOrder(f, items, extra = {}) {
  const order = f.rpc("erp_document_save", { p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    contact_id: f.supplier.id, date: "2026-11-10", ...extra, items } }).document;
  f.rpc("erp_document_transition", { p_kind: "purchase_orders", p_id: order.id, p_expected_version: order.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Iniciar compra" });
  return f.lite.prepare("SELECT id, version FROM erp_documents__document WHERE id=?").get(order.id);
}
const remaining = (f, order) => Object.fromEntries(f.rpc("erp_purchase_receipts_get", { p_document_id: order.id, p_limit: 5, p_after: null, p_receipt_id: null })
  .current.items.map((i) => [i.product_id, i.remaining_quantity]));
const biscuitOnly = (quantity = "2.0000", number = 501) =>
  nfeXml({ number, key: accessKey(number), freight: 0, items: [{ code: "F-001", gtin: "7891234567895", description: "Biscoito de polvilho pacote", unit: "CX", quantity, price: "120.0000000000" }] });

test("baixa do pedido: a nota atende em parte, o saldo fica pendente e o pedido não recebe de novo", (t) => {
  const f = inboundFixture(t);
  const order = purchaseOrder(f, [
    { product_id: f.biscuit.id, description: "Biscoito de polvilho", unit: "UN", quantity: "30", unit_price: "10" },
    { product_id: f.milk.id, description: "Leite integral", unit: "UN", quantity: "10", unit_price: "5" },
  ]);
  const reg = f.register(biscuitOnly());
  const r = f.review(reg, CHOICES);
  assert.equal(r.order_id, order.id);
  assert.deepEqual(r.order_difference.lines.map((l) => [l.attend_quantity, l.pending_quantity, l.fulfillment]), [["24.000000", "6.000000", "parcial"]]);
  assert.equal(r.order_difference.fulfillment, "parcial");
  assert.equal(r.order_difference.missing[0].remaining_quantity, "10.000000");
  const done = f.enter(reg, CHOICES);
  assert.equal(done.entry.result.order.id, order.id);
  assert.deepEqual(done.entry.result.order.items.map((i) => [i.product_id, i.quantity, i.pending]), [[f.biscuit.id, "24.000000", "6.000000"]]);
  assert.equal(f.balance(f.biscuit.id), "24");
  // O pedido conta o que a nota trouxe: falta 6 do biscoito e o leite inteiro.
  assert.deepEqual(remaining(f, order), { [f.biscuit.id]: "6.000000", [f.milk.id]: "10.000000" });
  // Pela tela do pedido, receber mais do que falta é recusado; o que falta, não.
  const item = f.lite.prepare("SELECT id FROM erp_documents__item WHERE document_id=? AND product_id=?").get(order.id, f.biscuit.id).id;
  const preview = (quantity) => f.rpc("erp_stock_purchase_receive_preview", { p_document_id: order.id, p_expected_version: f.lite.prepare("SELECT version FROM erp_documents__document WHERE id=?").get(order.id).version,
    p_warehouse_id: f.warehouse.id, p_occurred_on: null, p_reason: "Chegou o resto", p_items: [{ item_id: item, quantity }] });
  assert.match(code(() => preview("7")), /purchase_receipt_quantity_exceeded/);
  assert.equal(preview("6").preview.items[0].remaining_after, "0.000000");
  // Lançar o pedido inteiro pelo documento contaria o biscoito duas vezes: recusado.
  const version = f.lite.prepare("SELECT version FROM erp_documents__document WHERE id=?").get(order.id).version;
  assert.match(code(() => f.rpc("erp_document_stock_preview", { p_kind: "purchase_orders", p_document_id: order.id, p_expected_version: version, p_occurred_on: todaySaoPaulo(), p_reason: "Lançar" })),
    /erp_document_stock_posted_by_inbound/);
  // A próxima nota com o resto atende o item por inteiro.
  const next = f.register(nfeXml({ number: 502, key: accessKey(502), freight: 0, items: [{ code: "F-001", gtin: "7891234567895", description: "Biscoito", unit: "UN", quantity: "6.0000", price: "10.0000000000" }] }));
  const r2 = f.review(next);
  assert.deepEqual(r2.order_difference.lines.map((l) => [l.remaining_quantity, l.attend_quantity, l.pending_quantity, l.fulfillment]), [["6.000000", "6.000000", "0.000000", "atendido"]]);
  // Estornar a primeira nota devolve a baixa ao pedido.
  f.reverse(reg, "Nota lançada por engano");
  assert.deepEqual(remaining(f, order), { [f.biscuit.id]: "30.000000", [f.milk.id]: "10.000000" });
});

test("pedido atendido por inteiro pelas notas sai da lista; nota que não lança estoque não baixa o pedido", (t) => {
  const f = inboundFixture(t);
  const order = purchaseOrder(f, [{ product_id: f.biscuit.id, description: "Biscoito", unit: "UN", quantity: "24", unit_price: "10" }]);
  const finance = f.register(biscuitOnly("2.0000", 511));
  // Só contas a pagar: o pedido fica como estava.
  const onlyFinance = f.enter(finance, { ...CHOICES, stock: false });
  assert.equal(onlyFinance.entry.stock_status, "not_chosen");
  assert.equal(onlyFinance.entry.result.order, undefined);
  assert.deepEqual(remaining(f, order), { [f.biscuit.id]: "24.000000" });
  const full = f.register(biscuitOnly("2.0000", 512));
  const done = f.enter(full, CHOICES);
  assert.equal(done.entry.result.order.fulfillment, "total");
  assert.deepEqual(remaining(f, order), { [f.biscuit.id]: "0.000000" });
  const later = f.register(biscuitOnly("1.0000", 513));
  const r = f.review(later, CHOICES);
  assert.deepEqual([r.orders.length, r.order_id, r.order_difference], [0, null, null]);
});

test("pedido que já recebeu pela tela: a nota não lança o mesmo estoque de novo", (t) => {
  const f = inboundFixture(t);
  const order = purchaseOrder(f, [{ product_id: f.biscuit.id, description: "Biscoito", unit: "UN", quantity: "30", unit_price: "10" }]);
  const item = f.lite.prepare("SELECT id FROM erp_documents__item WHERE document_id=?").get(order.id).id;
  const args = { p_document_id: order.id, p_expected_version: order.version, p_warehouse_id: f.warehouse.id, p_occurred_on: null, p_reason: "Chegou pela tela", p_items: [{ item_id: item, quantity: "24" }] };
  const p = f.rpc("erp_stock_purchase_receive_preview", args).preview;
  f.rpc("erp_stock_purchase_receive", { ...args, p_occurred_on: p.occurred_on, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_confirm: true });
  assert.equal(f.balance(f.biscuit.id), "24");
  const reg = f.register(biscuitOnly());
  const r = f.review(reg, CHOICES);
  assert.equal(r.stock, false);
  assert.ok(r.warnings.includes("order_received_before"));
  // A pessoa marca o estoque: a nota traz 24 e só faltam 6 no pedido.
  assert.ok(f.review(reg, { ...CHOICES, stock: true }).blockers.includes("order_received_before"));
  assert.match(code(() => f.enter(reg, { ...CHOICES, stock: true })), /inbound_blocked:.*order_received_before/);
  // Só as contas a pagar: entra sem tocar no estoque.
  assert.equal(f.enter(reg, CHOICES).entry.stock_status, "not_chosen");
  assert.equal(f.balance(f.biscuit.id), "24");
});

test("produto pelo XML: prévia com descrição, NCM, CEST, unidade, GTIN e custo; cadastro ligado ao código do fornecedor", (t) => {
  const f = inboundFixture(t);
  const xml = nfeXml({ number: 601, key: accessKey(601), freight: 0, items: [
    { code: "F-001", gtin: "7891234567895", description: "Biscoito de polvilho pacote", unit: "CX", quantity: "2.0000", price: "120.0000000000" },
    { code: "F-777", gtin: "7894900011517", description: "Molho de tomate sache", unit: "UN", quantity: "12.0000", price: "2.5000000000" },
  ] }).replace("<NCM>19053100</NCM><CFOP>5102</CFOP><uCom>UN</uCom>", "<NCM>21032010</NCM><CEST>1700700</CEST><CFOP>5102</CFOP><uCom>UN</uCom>");
  assert.equal(parseInboundXml(xml).note.items[1].cest, "1700700");
  assert.equal("cest" in parseInboundXml(xml).note.items[0], false);
  const reg = f.register(xml);
  const input = (extra) => ({ id: reg.note.id, xml_sha256: reg.sha256, note: reg.parsed.note, ...extra });
  // Sem lista: só o item que não casa com nenhum produto (o biscoito casa pelo GTIN).
  const preview = f.rpc("erp_inbound_product_preview", { p_input: input({}) });
  assert.equal(preview.can_create, true);
  assert.deepEqual(preview.items.map((i) => i.position), [2]);
  // Preço e custo com as casas da preferência do ERP (empresa.decimais_preco_entrada; 2 na semeadura).
  assert.deepEqual(preview.items[0].proposal, { name: "Molho de tomate sache", code: null, unit: "UN", ncm: "21032010", cest: "1700700", gtin: "7894900011517",
    purchase_price: "2.50", cost_price: "2.50" });
  assert.deepEqual(preview.items[0].problems, []);
  // O biscoito, pedido à força: o GTIN já é de um produto do cadastro.
  assert.deepEqual(f.rpc("erp_inbound_product_preview", { p_input: input({ items: [{ position: 1 }] }) }).items[0].problems, ["gtin_exists"]);
  assert.match(code(() => f.rpc("erp_inbound_product_create", { p_input: input({ command_id: randomUUID(), items: [{ position: 1 }] }) })), /inbound_product_blocked:1:gtin_exists/);
  // Quem só consulta vê a prévia e não cadastra.
  assert.equal(f.rpc("erp_inbound_product_preview", { p_input: input({}) }, { role: "consulta" }).can_create, false);
  assert.match(code(() => f.rpc("erp_inbound_product_create", { p_input: input({ command_id: randomUUID(), items: [{ position: 2 }] }) }, { role: "consulta" })), /inbound_role_denied/);
  const command = randomUUID();
  const created = f.rpc("erp_inbound_product_create", { p_input: input({ command_id: command, items: [{ position: 2, name: "Molho de tomate 340 g" }] }) });
  assert.equal(created.created.length, 1);
  const id = created.created[0].product.id;
  const saved = f.lite.prepare("SELECT r.name, p.unit, p.ncm, p.cest, p.gtin, p.kind FROM erp_catalog__record r JOIN erp_catalog__product p ON p.record_id=r.id WHERE r.id=?").get(id);
  assert.deepEqual({ ...saved }, { name: "Molho de tomate 340 g", unit: "UN", ncm: "21032010", cest: "1700700", gtin: "7894900011517", kind: "P" });
  const link = f.lite.prepare("SELECT code, CAST(purchase_price AS TEXT) price, is_default FROM erp_catalog__product_supplier WHERE record_id=? AND supplier_id=?").get(id, f.supplier.id);
  assert.equal(link.code, "F-777");
  assert.equal(link.is_default, 1);
  // Repetir o pedido não cria outro produto.
  const again = f.rpc("erp_inbound_product_create", { p_input: input({ command_id: command, items: [{ position: 2, name: "Molho de tomate 340 g" }] }) });
  assert.equal(again.created[0].product.id, id);
  assert.equal(again.replayed, true);
  assert.equal(f.count("erp_catalog__record", "entity='products' AND name LIKE 'Molho%'"), 1);
  // Na conferência, o item casa sozinho pelo código do fornecedor, na unidade da nota.
  const line = f.review(reg).lines[1];
  assert.deepEqual([line.product.id, line.matched_by, line.factor, line.stock_quantity], [id, "supplier_code", "1", "12.000000"]);
  // Sem Produtos ligado, a rotina recusa com a parte desligada.
  assert.equal(code(() => f.rpc("erp_inbound_product_preview", { p_input: input({}) }, { parts: { products: false } })), "Esta rotina depende de uma parte desligada.");
});

test("reposição pelo mínimo e máximo: máximo − saldo − pedidos em aberto; um pedido por fornecedor com um clique", (t) => {
  const f = inboundFixture(t);
  const save = (id, data) => f.rpc("erp_catalog_product_save", { p_id: id, p_expected_version: f.lite.prepare("SELECT version FROM erp_catalog__record WHERE id=?").get(id).version,
    p_command_id: randomUUID(), p_acknowledged: null, p_data: data });
  save(f.biscuit.id, { stock_min: "10", stock_max: "30", suppliers: [{ supplier_id: f.supplier.id, code: "F-001", purchase_price: "9.5", cost_price: null, is_default: true }] });
  save(f.milk.id, { stock_min: "5" });
  f.rpc("erp_stock_launch", { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: f.biscuit.id, p_warehouse_id: f.warehouse.id, p_quantity: "4", p_expected_version: 0,
    p_unit_price: "9", p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null });
  purchaseOrder(f, [{ product_id: f.biscuit.id, description: "Biscoito", unit: "UN", quantity: "6", unit_price: "9.5" }]);
  const list = f.rpc("erp_inbound_replenishment", { p_input: {} });
  const biscuit = list.items.find((i) => i.product_id === f.biscuit.id), milk = list.items.find((i) => i.product_id === f.milk.id);
  assert.deepEqual([biscuit.balance, biscuit.ordered, biscuit.suggestion, biscuit.supplier_id, biscuit.unit_price, biscuit.value], ["4.000000", "6.000000", "20.000000", f.supplier.id, "9.5000000000", "190.00"]);
  // Sem máximo, completa até o mínimo; sem fornecedor, a pessoa escolhe antes de gerar o pedido.
  assert.deepEqual([milk.suggestion, milk.supplier_id], ["5.000000", null]);
  assert.equal(list.totals.without_supplier, 1);
  assert.equal(list.can_order, true);
  assert.match(code(() => f.rpc("erp_inbound_replenishment_generate", { p_input: { command_id: randomUUID(), items: [{ product_id: f.milk.id, quantity: "5" }] } })), /inbound_replenishment_supplier_missing/);
  const command = randomUUID();
  const items = [{ product_id: f.biscuit.id, quantity: biscuit.suggestion }, { product_id: f.milk.id, quantity: "5", supplier_id: f.supplier.id }];
  const generated = f.rpc("erp_inbound_replenishment_generate", { p_input: { command_id: command, items } });
  assert.equal(generated.orders.length, 1);
  assert.equal(generated.orders[0].items, 2);
  const doc = generated.orders[0].document_id;
  const lines = f.lite.prepare("SELECT product_id, CAST(quantity AS TEXT) q FROM erp_documents__item WHERE document_id=? ORDER BY position").all(doc).map((r) => [r.product_id, r.q]);
  assert.deepEqual(lines, [[f.biscuit.id, "20000000"], [f.milk.id, "5000000"]]);
  // Repetir o clique devolve o mesmo pedido.
  assert.equal(f.rpc("erp_inbound_replenishment_generate", { p_input: { command_id: command, items } }).orders[0].document_id, doc);
  assert.equal(f.count("erp_documents__document", "kind='purchase_orders'"), 2);
  // Com o pedido gerado, a sugestão cai a zero (o pedido em aberto já cobre).
  const after = f.rpc("erp_inbound_replenishment", { p_input: {} }).items.find((i) => i.product_id === f.biscuit.id);
  assert.deepEqual([after.suggestion, after.covered_by_orders], ["0.000000", true]);
  // Quem não vê pedidos de compra não vê a reposição; quem só consulta vê e não gera.
  assert.match(code(() => f.rpc("erp_inbound_replenishment", { p_input: {} }, { role: "vendas" })), /denied/);
  assert.equal(f.rpc("erp_inbound_replenishment", { p_input: {} }, { role: "consulta" }).can_order, false);
  assert.equal(code(() => f.rpc("erp_inbound_replenishment", { p_input: {} }, { parts: { stock: false } })), "Esta rotina depende de uma parte desligada.");
});

test("inventário valorizado numa data: saldo e custo médio da data por produto e depósito", (t) => {
  const f = inboundFixture(t);
  const launch = (quantity, price) => f.rpc("erp_stock_launch", { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: f.biscuit.id, p_warehouse_id: f.warehouse.id,
    p_quantity: quantity, p_expected_version: Number(f.lite.prepare("SELECT version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?").get(f.biscuit.id, f.warehouse.id)?.version ?? 0),
    p_unit_price: price, p_unit_cost: null, p_note: null, p_destination_id: null, p_destination_version: null });
  launch("10", "4");
  launch("10", "6");
  const today = todaySaoPaulo();
  const inv = f.rpc("erp_inbound_inventory", { p_input: { date: today } });
  assert.equal(inv.cost_visible, true);
  assert.deepEqual(inv.items.map((i) => [i.product_id, i.warehouse_id, i.quantity, i.average_cost, i.value]), [[f.biscuit.id, f.warehouse.id, "20.000000", "5.0000000000", "100.00"]]);
  assert.deepEqual(inv.totals, { value: "100.00", uncosted: 0 });
  assert.equal(inv.warehouses[0].value, "100.00");
  // Antes dos lançamentos não havia nada.
  assert.equal(f.rpc("erp_inbound_inventory", { p_input: { date: "2020-01-01" } }).total, 0);
  // Sem ver custo (papel que não lê pedidos de compra), só as quantidades.
  const blind = f.rpc("erp_inbound_inventory", { p_input: { date: today } }, { role: "vendas" });
  assert.deepEqual([blind.cost_visible, blind.items[0].value, blind.totals.value], [false, null, null]);
  assert.match(code(() => f.rpc("erp_inbound_inventory", { p_input: { date: "21/11/2026" } })), /inbound_inventory_date_invalid/);
});

test("relatório de notas de entrada e lista do check-in leem as notas recebidas com entrada", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  f.enter(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  const report = (group) => f.rpc("erp_stock_report_entry_notes", { p_date_from: "2026-11-01", p_date_to: "2026-11-30", p_group: group });
  const bySupplier = report("supplier");
  assert.deepEqual([bySupplier.totals.notes, bySupplier.totals.value], [1, "312.00"]);
  assert.equal(bySupplier.items[0].label, "Fornecedor Sintetico Ltda");
  const byProduct = report("product");
  assert.deepEqual(byProduct.items.map((i) => [i.key, i.quantity, i.value]).sort(), [[f.biscuit.id, "24.0000", "240.00"], [f.milk.id, "10.0000", "50.00"]].sort());
  assert.equal(report("month").items[0].label, "11/2026");
  // Fora do período, nada.
  assert.equal(f.rpc("erp_stock_report_entry_notes", { p_date_from: "2026-10-01", p_date_to: "2026-10-31", p_group: "nature" }).totals.notes, 0);
  // O relatório customizado "NF-e de entrada" também lê a nota recebida.
  const custom = f.rpc("erp_preferences_report_run", { p_base: "notas_entrada", p_columns: ["numero", "contato", "total", "chave"], p_filters: [], p_view_limit: 50, p_offset: 0, p_page: 1 });
  assert.ok(JSON.stringify(custom).includes(accessKey(101)));
});
