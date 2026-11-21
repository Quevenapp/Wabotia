// Compra pela nota recebida, no motor (SQLite, rotinas reais das telas):
// conferência, entrada idempotente, custo com rateio, lote e validade,
// contas a pagar pelas duplicatas, vínculos lembrados, estorno com as guardas
// do Financeiro, partes desligadas, nota sem compra e o interruptor da
// manifestação. Nada fala com cofre, R2 ou governo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inboundFixture, nfeXml, accessKey } from "./fixtures.mjs";
import { classifyPurpose, landedCosts, stockQuantity } from "../../../src/erp/domains/inbound/model.ts";
import { parseInboundXml } from "../../../src/erp/recebidas/xml.ts";

const code = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

test("XML do fornecedor: itens, rastro, impostos, duplicatas e finalidade", () => {
  const { note, summary, purpose } = parseInboundXml(nfeXml());
  assert.equal(note.access_key, accessKey(101));
  assert.equal(note.environment, "homologacao");
  assert.equal(note.items.length, 2);
  assert.deepEqual(note.items[0], {
    position: 1, code: "F-001", gtin: "7891234567895", description: "Biscoito de polvilho pacote", ncm: "19053100", cfop: "5102", unit: "CX",
    quantity: "2.0000", unit_price: "120.0000000000", total_cents: 24000, discount_cents: 0, freight_cents: 0, insurance_cents: 0, other_cents: 0,
    ipi_cents: 1200, icms_cents: 4320, icms_st_cents: 0, fcp_st_cents: 0, lots: [], order_reference: null,
  });
  assert.deepEqual(note.items[1].lots, [{ code: "L2026A", quantity: "10.0000", manufactured_on: "2026-10-01", expires_on: "2027-04-01" }]);
  assert.equal(note.items[1].gtin, null);
  assert.deepEqual(note.totals, { products_cents: 29000, discount_cents: 0, freight_cents: 1000, insurance_cents: 0, other_cents: 0, ipi_cents: 1200,
    icms_cents: 5220, icms_st_cents: 0, fcp_st_cents: 0, total_cents: 31200 });
  assert.deepEqual(note.duplicates, [{ number: "001", due_on: "2026-12-20", amount_cents: 15600 }, { number: "002", due_on: "2027-01-19", amount_cents: 15600 }]);
  assert.equal(note.recipient_document, "11222333000181");
  assert.equal(note.protocol, "135260000000001");
  assert.equal(purpose, "compra");
  assert.deepEqual(summary.cfops, ["5102"]);
  // Arquivo errado: o motivo em palavras.
  assert.throws(() => parseInboundXml("%PDF-1.4 nada"), /XML/);
  assert.throws(() => parseInboundXml(nfeXml().replace("<mod>55</mod>", "<mod>65</mod>")), /NFC-e/);
});

test("finalidade pela natureza e pelo CFOP; conversão e rateio exatos", () => {
  assert.equal(classifyPurpose("1", "Venda", ["5102", "6102"]), "compra");
  assert.equal(classifyPurpose("4", "Devolução", ["5102"]), "devolucao");
  assert.equal(classifyPurpose("1", "Devolucao de compra", ["5202"]), "devolucao");
  assert.equal(classifyPurpose("1", "Bonificação", ["5910"]), "bonificacao");
  assert.equal(classifyPurpose("1", "Remessa em consignação", ["5917"]), "remessa");
  assert.equal(classifyPurpose("1", "Remessa para conserto", ["5915"]), "remessa");
  assert.equal(classifyPurpose("1", "Outras", ["5949"]), "remessa");
  assert.equal(classifyPurpose("1", "Venda", ["5102", "5910"]), "bonificacao");
  assert.equal(stockQuantity("2.0000", "12"), "24.000000");
  assert.equal(stockQuantity("1.5", "0.5"), "0.750000");
  assert.equal(stockQuantity("1.5", "0.333333"), null);
  assert.equal(stockQuantity("0.0001", "0.001"), null);
  const { note } = parseInboundXml(nfeXml());
  const costs = landedCosts(note, new Map([[1, "24"], [2, "10"]]), { icms_in_cost: false, decimals: 10 });
  // Frete de R$ 10,00 da nota rateado pelo valor dos produtos (240 e 50): 8,27 e 1,73.
  assert.deepEqual(costs.map((c) => [c.freight_cents, c.taxes_cents, c.cost_cents, c.unit_price, c.unit_cost]), [
    [827, 1200, 26027, "10.0000000000", "10.8445833333"],
    [173, 0, 5173, "5.0000000000", "5.1730000000"],
  ]);
  const icms = landedCosts(note, new Map([[1, "24"], [2, "10"]]), { icms_in_cost: true, decimals: 2 });
  assert.deepEqual(icms.map((c) => c.unit_cost), ["12.64", "6.07"]);
});

test("conferência: fornecedor pelo CNPJ, item pelo GTIN, sugestão pela descrição, unidade pendente", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  assert.equal(reg.note.purpose, "compra");
  assert.equal(reg.note.supplier.id, f.supplier.id);
  const r = f.review(reg);
  assert.equal(r.supplier.id, f.supplier.id);
  assert.equal(r.lines[0].product.id, f.biscuit.id);
  assert.equal(r.lines[0].matched_by, "gtin");
  assert.deepEqual(r.lines[0].problems, ["factor_missing"]);
  assert.equal(r.lines[1].product, null);
  assert.equal(r.lines[1].suggestions[0].id, f.milk.id);
  assert.deepEqual(r.lines[1].problems, ["product_missing"]);
  assert.equal(r.warehouse_id, f.warehouse.id);
  assert.deepEqual(r.finance.installments.map((d) => d.amount_cents), [15600, 15600]);
  assert.ok(r.blockers.includes("items_pending"));
  assert.equal(r.stock, true);
  assert.equal(r.finance_selected, true);
  // Escolhas da pessoa: caixa com 12 e o leite.
  const ok = f.review(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  assert.deepEqual(ok.lines.map((l) => [l.stock_quantity, l.problems, l.lot]), [
    ["24.000000", [], null],
    ["10.000000", [], { code: "L2026A", manufactured_on: "2026-10-01", expires_on: "2027-04-01" }],
  ]);
  assert.deepEqual(ok.blockers, []);
  // O XML precisa ser o do índice.
  assert.match(code(() => f.rpc("erp_inbound_review", { p_input: { id: reg.note.id, xml_sha256: "0".repeat(64), note: reg.parsed.note } })), /inbound_xml_changed/);
});

test("nota para outra empresa é recusada na importação; repetir a importação não duplica", (t) => {
  const f = inboundFixture(t);
  assert.match(code(() => f.register(nfeXml({ recipient: "19131243000197" }))), /inbound_not_for_company/);
  const a = f.register(nfeXml());
  const b = f.register(nfeXml());
  assert.equal(a.note.id, b.note.id);
  assert.equal(b.note.replayed, true);
  assert.equal(f.count("erp_purchase_inbound__note"), 1);
  // Mesmo número de chave com outro conteúdo: conflito, nada trocado.
  assert.match(code(() => f.register(nfeXml({ freight: 0 }))), /inbound_xml_conflict/);
});

test("entrada: estoque, lote, custo e contas a pagar numa vez só; repetir não duplica", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  const choices = { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }], category_id: f.category.id };
  const command = randomUUID();
  const done = f.enter(reg, choices, {}, command);
  assert.equal(done.replayed, false);
  assert.equal(done.entry.stock_status, "done");
  assert.equal(done.entry.finance_status, "done");
  assert.equal(f.balance(f.biscuit.id), "24");
  assert.equal(f.balance(f.milk.id), "10");
  const lot = f.lite.prepare("SELECT l.code, l.expires_on, l.manufactured_on, CAST(b.quantity AS TEXT) q FROM erp_stock__lot l JOIN erp_stock__lot_balance b ON b.lot_id=l.id WHERE l.product_id=?").get(f.milk.id);
  assert.deepEqual({ ...lot }, { code: "L2026A", expires_on: "2027-04-01", manufactured_on: "2026-10-01", q: "10000000" });
  // Preço e custo com as casas da preferência do ERP (empresa.decimais_preco_entrada; 2 na semeadura).
  const details = Object.fromEntries(f.lite.prepare("SELECT product_id, unit_price, unit_cost FROM erp_stock__movement_detail").all().map((r) => [r.product_id, [r.unit_price, r.unit_cost]]));
  assert.deepEqual(details, { [f.biscuit.id]: ["10.00", "10.84"], [f.milk.id]: ["5.00", "5.17"] });
  const titles = f.lite.prepare("SELECT kind, contact_id, category_id, amount_cents, due_on, description FROM erp_finance__title ORDER BY due_on").all().map((r) => ({ ...r }));
  assert.deepEqual(titles.map((r) => [r.kind, r.contact_id, r.category_id, r.amount_cents, r.due_on]), [
    ["payable", f.supplier.id, f.category.id, 15600, "2026-12-20"],
    ["payable", f.supplier.id, f.category.id, 15600, "2027-01-19"],
  ]);
  // Mesmo comando: o recibo. Outro comando: a entrada que já existe, sem nada novo.
  assert.equal(f.enter(reg, choices, {}, command).replayed, true);
  const again = f.enter(reg, choices);
  assert.equal(again.already_entered, true);
  assert.equal(again.entry.id, done.entry.id);
  assert.equal(f.balance(f.biscuit.id), "24");
  assert.equal(f.count("erp_finance__title"), 2);
  assert.equal(f.count("erp_purchase_inbound__entry"), 1);
  // Vínculos lembrados para a próxima nota.
  const links = f.lite.prepare("SELECT record_id, code FROM erp_catalog__product_supplier WHERE supplier_id=? ORDER BY code").all(f.supplier.id).map((r) => ({ ...r }));
  assert.deepEqual(links, [{ record_id: f.biscuit.id, code: "F-001" }, { record_id: f.milk.id, code: "F-002" }]);
  const factor = f.lite.prepare("SELECT unit, CAST(factor AS TEXT) factor FROM erp_stock__unit_conversion WHERE product_id=? AND supplier_id=?").get(f.biscuit.id, f.supplier.id);
  assert.deepEqual({ ...factor }, { unit: "CX", factor: "12000000" });
  const listed = f.rpc("erp_inbound_list", { p_input: { status: "lancadas" } });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].entry.id, done.entry.id);
});

test("próxima nota do mesmo fornecedor: código e caixa lembrados, sem perguntar de novo", (t) => {
  const f = inboundFixture(t);
  f.enter(f.register(nfeXml()), { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  const next = f.register(nfeXml({ number: 102, key: accessKey(102) }));
  const r = f.review(next);
  assert.deepEqual(r.lines.map((l) => [l.matched_by, l.factor, l.factor_from, l.stock_quantity, l.problems]), [
    ["supplier_code", "12", "remembered", "24.000000", []],
    ["supplier_code", "1", "same_unit", "10.000000", []],
  ]);
  assert.deepEqual(r.blockers, []);
  f.enter(next);
  assert.equal(f.balance(f.biscuit.id), "48");
});

test("estorno: desfaz estoque (com o lote) e cancela as contas, com motivo; repetir devolve o recibo", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  f.enter(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  assert.match(code(() => f.reverse(reg, "")), /inbound_reason_required/);
  const command = randomUUID();
  const undone = f.reverse(reg, "Nota lançada em duplicidade", {}, command);
  assert.equal(undone.entry.state, "reversed");
  assert.equal(undone.entry.reversal_reason, "Nota lançada em duplicidade");
  assert.equal(f.balance(f.biscuit.id), "0");
  assert.equal(f.balance(f.milk.id), "0");
  assert.equal(f.lite.prepare("SELECT CAST(quantity AS TEXT) q FROM erp_stock__lot_balance").get().q, "0");
  assert.equal(f.count("erp_finance__title", "cancelled=1"), 2);
  assert.equal(f.reverse(reg, "Nota lançada em duplicidade", {}, command).replayed, true);
  assert.match(code(() => f.reverse(reg)), /inbound_entry_not_found/);
  // Depois do estorno, a nota pode entrar de novo (outra entrada).
  f.enter(reg);
  assert.equal(f.balance(f.biscuit.id), "24");
  assert.equal(f.count("erp_purchase_inbound__entry"), 2);
});

test("estorno respeita o Financeiro: conta com pagamento trava tudo, nada fica pela metade", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  const done = f.enter(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  const account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  const title = f.lite.prepare("SELECT id, version FROM erp_finance__title WHERE id=?").get(done.entry.title_ids[0]);
  f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: title.id, expected_version: title.version, account_id: account.id,
    posted_on: "2026-11-19", principal_cents: "15600" } });
  assert.match(code(() => f.reverse(reg)), /erp_finance_active_payments/);
  assert.equal(f.balance(f.biscuit.id), "24");
  assert.equal(f.count("erp_finance__title", "cancelled=1"), 0);
  assert.equal(f.count("erp_purchase_inbound__entry", "state='active'"), 1);
});

test("partes: sem Estoque, só contas a pagar; sem Financeiro, só estoque; sem as duas, nada", (t) => {
  const f = inboundFixture(t);
  const choices = { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] };
  const a = f.register(nfeXml());
  const noStock = f.enter(a, choices, { parts: { stock: false } });
  assert.deepEqual([noStock.entry.stock_status, noStock.entry.finance_status], ["part_disabled", "done"]);
  assert.equal(f.balance(f.biscuit.id), null);
  const b = f.register(nfeXml({ number: 103, key: accessKey(103) }));
  const noFinance = f.enter(b, choices, { parts: { finance: false } });
  assert.deepEqual([noFinance.entry.stock_status, noFinance.entry.finance_status], ["done", "part_disabled"]);
  assert.equal(f.count("erp_finance__title"), 2);
  const c = f.register(nfeXml({ number: 104, key: accessKey(104) }));
  assert.match(code(() => f.enter(c, choices, { parts: { stock: false, finance: false } })), /inbound_nothing_done/);
  // Sem Compras, a rota toda recusa com parte desligada.
  assert.equal(code(() => f.rpc("erp_inbound_list", { p_input: {} }, { parts: { purchases: false } })), "Esta rotina depende de uma parte desligada.");
  // Estorno com a parte desligada: trava com o motivo, sem desfazer só metade.
  assert.match(code(() => f.reverse(b, "Teste de parte desligada", { parts: { stock: false } })), /inbound_reverse_stock_part_disabled/);
});

test("papéis: quem é só do estoque lança estoque e não gera contas; consulta só lê", (t) => {
  const f = inboundFixture(t);
  const reg = f.register(nfeXml());
  const done = f.enter(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] }, { role: "estoque" });
  assert.deepEqual([done.entry.stock_status, done.entry.finance_status], ["done", "role_missing"]);
  assert.match(code(() => f.enter(f.register(nfeXml({ number: 105, key: accessKey(105) })), {}, { role: "consulta" })), /inbound_role_denied/);
  assert.equal(f.rpc("erp_inbound_list", { p_input: {} }, { role: "consulta" }).total, 2);
});

test("nota sem compra (devolução, bonificação): não gera contas a pagar por padrão; a pessoa escolhe", (t) => {
  const f = inboundFixture(t);
  const items = [{ code: "F-001", gtin: "7891234567895", description: "Biscoito", unit: "UN", quantity: "3.0000", price: "10.0000000000" }];
  const back = f.register(nfeXml({ items, freight: 0, finality: "4", nature: "Devolução de venda", cfop: "5202", number: 201, key: accessKey(201) }));
  assert.equal(back.note.purpose, "devolucao");
  const r = f.review(back);
  assert.equal(r.finance_selected, false);
  assert.equal(r.stock, true);
  assert.ok(r.warnings.includes("not_purchase"));
  const done = f.enter(back);
  assert.deepEqual([done.entry.stock_status, done.entry.finance_status], ["done", "not_chosen"]);
  assert.equal(f.count("erp_finance__title"), 0);
  const gift = f.register(nfeXml({ items, freight: 0, nature: "Bonificação", cfop: "5910", number: 202, key: accessKey(202) }));
  assert.equal(f.review(gift).finance_selected, false);
  // A pessoa pode escolher gerar as contas mesmo assim.
  assert.equal(f.enter(gift, { finance: true }).entry.finance_status, "done");
  const shipment = f.register(nfeXml({ items, freight: 0, nature: "Remessa em consignação", cfop: "5917", number: 203, key: accessKey(203) }));
  const s = f.review(shipment);
  assert.deepEqual([s.stock, s.finance_selected], [false, false]);
  assert.ok(s.blockers.includes("nothing_chosen"));
});

test("pedido de compra em aberto do fornecedor: casa com a nota e mostra as diferenças", (t) => {
  const f = inboundFixture(t);
  const order = f.rpc("erp_document_save", { p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    contact_id: f.supplier.id, date: "2026-11-10", items: [
      { product_id: f.biscuit.id, description: "Biscoito de polvilho", unit: "UN", quantity: "20", unit_price: "9.50" },
      { product_id: f.milk.id, description: "Leite integral", unit: "UN", quantity: "10", unit_price: "5.00" },
    ] } }).document;
  // Só o pedido em andamento recebe nota (o mesmo critério do recebimento do pedido).
  f.rpc("erp_document_transition", { p_kind: "purchase_orders", p_id: order.id, p_expected_version: order.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Iniciar compra" });
  const reg = f.register(nfeXml());
  const r = f.review(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }] });
  assert.equal(r.orders.length, 1);
  assert.equal(r.order_id, order.id);
  const diff = r.order_difference;
  assert.equal(diff.order.id, order.id);
  assert.deepEqual(diff.lines.map((l) => [l.status, l.ordered_quantity, l.note_quantity, l.quantity_difference]), [
    ["different", "20.000000", "24.000000", "4.000000"],
    ["same", "10.000000", "10.000000", "0.000000"],
  ]);
  assert.equal(diff.lines[0].order_unit_price, "9.5000");
  assert.equal(diff.lines[0].note_unit_price, "10.00");
  // A pessoa pode não casar com o pedido.
  assert.equal(f.review(reg, { order_id: null }).order_difference, null);
  const done = f.enter(reg, { items: [{ position: 1, factor: "12" }, { position: 2, product_id: f.milk.id }], order_id: order.id });
  assert.equal(done.entry.order_id, order.id);
});

test("fornecedor novo: proposta com os dados do XML e cadastro pela rotina de contatos", (t) => {
  const f = inboundFixture(t);
  const xml = nfeXml({ supplier: "33000167000101", number: 301, key: `35261133000167000101550010000003011876543213` });
  const reg = f.register(xml);
  const r = f.review(reg);
  assert.equal(r.supplier, null);
  assert.equal(r.supplier_proposal.document, "33000167000101");
  assert.ok(r.blockers.includes("supplier_missing"));
  const created = f.rpc("erp_inbound_supplier_create", { p_input: { id: reg.note.id, xml_sha256: reg.sha256, note: reg.parsed.note, command_id: randomUUID() } });
  assert.equal(created.created, true);
  assert.equal(f.review(reg).supplier.id, created.supplier.id);
  const again = f.rpc("erp_inbound_supplier_create", { p_input: { id: reg.note.id, xml_sha256: reg.sha256, note: reg.parsed.note, command_id: randomUUID() } });
  assert.deepEqual([again.created, again.supplier.id], [false, created.supplier.id]);
});

test("manifestação: interruptor do administrador desligado; ligar exige a ciência do ato fiscal", (t) => {
  const f = inboundFixture(t);
  assert.equal(f.rpc("erp_inbound_settings_get", { p_input: {} }).manifest_enabled, false);
  assert.match(code(() => f.rpc("erp_inbound_settings_save", { p_input: { expected_version: 0, manifest_enabled: true } })), /inbound_fiscal_act_acknowledgement_required/);
  assert.match(code(() => f.rpc("erp_inbound_settings_save", { p_input: { expected_version: 0, manifest_enabled: true, acknowledge_fiscal_act: true } }, { role: "fiscal" })), /inbound_role_denied/);
  const reg = f.register(nfeXml());
  const claim = (extra = {}, overrides = {}) => f.rpc("erp_inbound_manifest_claim", { p_input: { id: reg.note.id, command_id: randomUUID(), type: "ciencia", ...extra } }, overrides);
  assert.match(code(() => claim()), /inbound_manifest_disabled/);
  const on = f.rpc("erp_inbound_settings_save", { p_input: { expected_version: 0, manifest_enabled: true, acknowledge_fiscal_act: true } });
  assert.deepEqual([on.manifest_enabled, on.version], [true, 1]);
  // Nota importada à mão não passa pelo cofre: não há o que manifestar por aqui.
  assert.match(code(() => claim()), /inbound_manifest_not_from_vault/);
});

test("busca no cofre: guarda de frequência, produção só com autorização e o índice das notas", (t) => {
  const f = inboundFixture(t);
  const claim = (extra = {}, overrides = {}) => f.rpc("erp_inbound_fetch_claim", { p_input: { environment: "homologacao", vault_url: "https://nfapi-cofre.fake-vault.test", ...extra } }, overrides);
  assert.match(code(() => claim({ environment: "producao" })), /inbound_production_authorization_required/);
  assert.match(code(() => claim({ environment: "producao", production_authorized: true }, { role: "fiscal" })), /inbound_production_authorization_required/);
  assert.equal(claim().allowed, true);
  const soon = claim();
  assert.equal(soon.allowed, false);
  assert.ok(soon.retry_at);
  const note = (sequence, extra = {}) => ({
    provider_ref: "rec_teste1", environment: "homologacao", cnpj: "11222333000181", access_key: accessKey(401), sequence, role: "recipient",
    issuer: { document: "44555666000181", name: "Fornecedor Sintetico Ltda", ie: null }, series: 1, number: 401, issued_at: "2026-11-18T10:00:00-03:00",
    authorized_at: "2026-11-18T10:00:05-03:00", protocol: "1", operation: "saida", total: 312, status: "authorized", xml_available: false,
    manifestation: null, automatic_acknowledgement_refused: null, received_at: "2026-11-18T13:00:00.000Z", updated_at: "2026-11-18T13:00:00.000Z", ...extra,
  });
  const recorded = f.rpc("erp_inbound_fetch_record", { p_input: { environment: "homologacao", last_sequence: 5, notes: [note(5)] } });
  assert.deepEqual([recorded.created, recorded.last_sequence], [1, 5]);
  const list = f.rpc("erp_inbound_list", { p_input: {} });
  assert.equal(list.items[0].source, "cofre");
  assert.equal(list.items[0].xml, null);
  assert.equal(list.items[0].vault.xml_available, false);
  assert.equal(list.items[0].total_cents, 31200);
  assert.equal(list.fetches[0].last_sequence, 5);
  // A mesma nota reaparece com sequência maior: atualiza, registra a mudança e não duplica.
  f.rpc("erp_inbound_fetch_record", { p_input: { environment: "homologacao", last_sequence: 9, notes: [note(9, { manifestation: { type: "ciencia", sequence: 1, registered_at: "2026-11-18T14:00:00.000Z", origin: "automatica" } })] } });
  assert.equal(f.count("erp_purchase_inbound__note"), 1);
  assert.equal(f.count("erp_fiscal_vault__received_change"), 2);
  assert.equal(f.rpc("erp_inbound_list", { p_input: {} }).items[0].vault.manifestation.type, "ciencia");
  // Depois do intervalo, nova busca liberada.
  f.clock.advance(121_000);
  assert.deepEqual(claim(), { allowed: true, after: 9 });
  // Manifestação: a nota do cofre; resultado incerto não é reenviado sem consulta e confirmação.
  f.rpc("erp_inbound_settings_save", { p_input: { expected_version: 0, manifest_enabled: true, acknowledge_fiscal_act: true } });
  const id = list.items[0].id, command = randomUUID();
  const first = f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: command, type: "confirmacao" } });
  assert.equal(first.state, "pedido");
  f.rpc("erp_inbound_manifest_record", { p_input: { event_id: first.event_id, state: "incerto" } });
  const blind = f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: randomUUID(), type: "confirmacao" } });
  assert.equal(blind.consult_first, true);
  assert.match(code(() => f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: randomUUID(), type: "desconhecimento" } })), /inbound_manifest_pending_other/);
  const resend = f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: randomUUID(), type: "confirmacao", resend: true } });
  assert.deepEqual([resend.event_id, resend.resend], [first.event_id, true]);
  f.rpc("erp_inbound_manifest_record", { p_input: { event_id: first.event_id, state: "registrado", protocol: "135", sequence: 1, registered_at: "2026-11-19T12:00:00.000Z", xml_available: true } });
  const after = f.rpc("erp_inbound_list", { p_input: {} }).items[0];
  assert.deepEqual([after.vault.manifestation.type, after.vault.pending, after.vault.xml_available], ["confirmacao", null, true]);
  assert.match(code(() => f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: randomUUID(), type: "nao_realizada", justification: "curta" } })), /inbound_justification_required/);
  assert.match(code(() => f.rpc("erp_inbound_manifest_claim", { p_input: { id, command_id: randomUUID(), type: "ciencia" } }, { role: "estoque" })), /inbound_role_denied/);
});
