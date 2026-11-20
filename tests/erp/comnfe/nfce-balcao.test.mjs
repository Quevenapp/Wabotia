// Balcão com NFC-e: venda real do Caixa / PDV → cupom pela máquina da NF-e
// comercial (tabelas counter_*), com cofre simulado em memória. Sem rede.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { com1Fixture, COM1_DATE } from "./fixtures.mjs";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { createNfceService } from "../../../src/erp/commercial-nfe/nfce-service.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { com1Hash } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { fakeNfeValue } from "../emissor/fake-vault-value.ts";

const fingerprint = com1Hash("cofre-local-balcao");
// cUF 35, 2611, CNPJ do emitente, modelo 65, série 001, número 1.
const accessKey = "35261111222333000181650010000000011000000010";
const justification = "Cliente desistiu da compra ainda no caixa.";
const cpf = "52998224725";
const row = (f, sql, ...params) => f.db.exec(sql, ...params).rows[0];
const count = (f, table, where = "1=1", ...params) => row(f, `SELECT count(*) n FROM ${table} WHERE ${where}`, ...params).n;
const eventXml = () => `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>165260000000002</nProt><dhRegEvento>2026-11-19T12:02:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;

function setup(t, options = {}) {
  const f = com1Fixture(t, options);
  t.after(installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: String(f.clock.next()), compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao", "producao"],
    series: [{ environment: "homologacao", series: 1 }] })));
  f.warehouse = f.catalog("warehouses", { name: "Depósito do balcão" });
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: "cash", name: "Caixa do balcão", start_on: "2020-01-01", opening_cents: "0" } }).record;
  const method = data => f.rpc("erp_catalog_payment_method_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: {
    description: "Dinheiro", payment_type: "01", condition: null, destination: "caixa", account_id: null, business_days: false,
    applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null, card_integration: null, card_cnpj: null,
    auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null, ...data } }).item;
  f.cash = method({});
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo do balcão", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }] });
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "existing", finance_timing: "existing", acknowledge_tax_limits: true } });
  const state = { role: "admin", parts: {}, remote: null, mode: "authorized", lost: false, calls: [], bodies: [], options: [], kinds: [] };
  const output = (body, status) => ({ kind: "nfce", status, provider_ref: "nfce_balcao", reference: body.referencia, environment: body.ambiente,
    series: "1", number: 1, access_key: status === "rejected" ? null : accessKey, protocol: ["authorized", "cancelled"].includes(status) ? "165260000000001" : null,
    nfse_number: null, issued_at: "2026-11-19T12:00:00Z", authorized_at: ["authorized", "cancelled"].includes(status) ? "2026-11-19T12:00:01Z" : null,
    total: fakeNfeValue(body), qr_code: null, consult_url: null, corrections: 0,
    messages: status === "rejected" ? [{ code: "778", description: "Rejeição: Informado NCM inexistente" }] : [], xml_available: true,
    replayed: false, event_repeated: null, contingency: null });
  const provider = {
    async emit(_ctx, kind, body, _key, opts) {
      state.calls.push("emit"); state.kinds.push(kind); state.bodies.push(structuredClone(body)); state.options.push(opts);
      state.remote = output(body, state.mode);
      if (state.lost) { state.lost = false; throw new Error("resposta perdida no caminho do cofre"); }
      return structuredClone(state.remote);
    },
    async find(_ctx, kind) { state.calls.push("find"); state.kinds.push(kind); return structuredClone(state.remote); },
    async get(_ctx, kind) { state.calls.push("get"); state.kinds.push(kind); return structuredClone(state.remote); },
    async reconcile() { state.calls.push("reconcile"); return structuredClone(state.remote); },
    async cancel(_ctx, kind) { state.calls.push("cancel"); state.kinds.push(kind); state.remote = { ...state.remote, status: "cancelled", event_repeated: false }; return structuredClone(state.remote); },
    async cancellationXml() { state.calls.push("cancel_xml"); return eventXml(); },
    async danfce(_ctx, id, opts) { state.calls.push(`danfce:${opts?.width}:${opts?.copy ?? "consumer"}`); const body = new TextEncoder().encode(`%PDF-1.4\n${id}\n%%EOF`); return { body, size: body.length, content_type: "application/pdf" }; },
    async danfe() { throw new Error("o cupom usa o DANFCE, nunca o DANFE"); },
  };
  const bridge = { async call(name, input) {
    const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name);
    if (evidence) return callRpc(f.db, name, { p_input: input }, f.clock, f.env({ role: state.role, parts: state.parts }));
    return f.rpc(name, ["erp_com1_config_get", "erp_com1_nfce_config_get"].includes(name) ? {} : { p_input: input }, { role: state.role, parts: state.parts });
  } };
  const base = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  const nfce = createNfceService({ bridge, base, now: () => f.clock.now(), vaultStatus: async () => ({ configured: true, checked_at: f.clock.now(),
    ufs: ["SP"], series: [{ environment: "homologacao", series: 1, next_number: 1 }], contingency_pending: 0, certificate_days_left: 200, environments: ["homologacao", "producao"] }) });
  /** Venda real do caixa: R$ 51,00 em dinheiro, recebidos R$ 60,00 (troco de R$ 9,00). */
  const sell = (role = "admin") => f.rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_finish", p_data: {
    sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: f.account.id, cash_session_id: null,
    contact_id: f.customer.id, price_list_id: null,
    document: { date: COM1_DATE, warehouse_id: f.warehouse.id, items: [{ product_id: f.product.id, description: "Mercadoria do Ensaio", code: "P1", unit: "UN", quantity: "2", unit_price: "25.50" }] },
    payments: [{ payment_method_id: f.cash.id, days: 0, amount_cents: "5100", note: null }],
    destination_account_id: null, to_ledger: false, cash_received_cents: "6000" } }, { role }).record;
  return Object.assign(f, { state, provider, base, nfce, sell });
}

test("venda do caixa: NFC-e autorizada pela mesma máquina, modelo 65, sem transporte e com troco", async t => {
  const f = setup(t), sale = f.sell();
  assert.equal(sale.state, "finished");
  const command = randomUUID();
  const coupon = await f.nfce.emit(sale.id, command, cpf);
  assert.equal(coupon.situation, "autorizado", JSON.stringify(coupon));
  assert.ok(coupon.actions.includes("imprimir") && coupon.actions.includes("cancelar"));
  assert.deepEqual([...new Set(f.state.kinds)], ["nfce"]);
  assert.deepEqual(f.state.options[0], { keep_issue_date: true, contingency: "automatic" });
  const body = f.state.bodies[0];
  assert.equal(body.presenca, "presencial");
  assert.deepEqual(body.destinatario, { cpf });
  for (const key of ["transporte", "cobranca", "consumidorFinal", "tipo", "destinoOperacao", "dataSaida"]) assert.equal(key in body, false, key);
  assert.deepEqual(body.pagamentos, [{ forma: "01", valor: 60, indicador: "a_vista" }]);
  assert.equal(body.troco, 9);
  assert.equal(body.referencia, `wb.${sale.document_id}.v1`);
  assert.equal(count(f, "erp_fiscal_vault__counter_emission"), 1);
  assert.equal(count(f, "erp_fiscal_vault__order_emission"), 0);
  assert.equal(row(f, "SELECT substr(access_key,21,2) m FROM erp_fiscal_vault__counter_emission").m, "65");
  // Repetir o mesmo comando, ou pedir de novo, não emite outro cupom.
  assert.equal((await f.nfce.emit(sale.id, command, cpf)).situation, "autorizado");
  assert.equal((await f.nfce.emit(sale.id, randomUUID(), null)).situation, "autorizado");
  assert.equal(f.state.calls.filter(call => call === "emit").length, 1);
  assert.equal(count(f, "erp_stock__document_posting"), 1);
  const pdf = await f.nfce.coupon(sale.id);
  assert.match(await pdf.text(), /^%PDF-/);
  assert.ok(f.state.calls.includes("danfce:80:consumer"));
  // A venda com cupom vigente não é cancelada pelo caminho comercial direto.
  assert.throws(() => f.rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_cancel",
    p_data: { sale_id: sale.id, expected_version: row(f, "SELECT version FROM erp_pos__sale WHERE id=?", sale.id).version, reason: "Tentativa direta" } }), /erp_pos_sale_invoice_linked/);
  // A NF-e do pedido não sai por cima do cupom.
  assert.throws(() => f.rpc("erp_com1_prepare", { p_input: { document_id: sale.document_id, command_id: randomUUID(),
    expected_document_version: row(f, "SELECT version FROM erp_documents__document WHERE id=?", sale.document_id).version,
    choices: { nature_id: f.nature.id, presence: "presencial", final_consumer: true } } }), /fiscal_emission_open/);
});

test("cofre sem resposta: a venda fica feita, o cupom pendente e a consulta precede qualquer reenvio", async t => {
  const f = setup(t), sale = f.sell();
  f.state.lost = true;
  const pending = await f.nfce.emit(sale.id, randomUUID(), null);
  assert.equal(pending.situation, "pendente");
  assert.equal(pending.reason.code, "uncertain");
  assert.deepEqual(pending.actions, ["consultar"]);
  assert.equal(row(f, "SELECT state FROM erp_pos__sale WHERE id=?", sale.id).state, "finished");
  // Dentro da reivindicação (60 s) a mesma emissão segue ocupada: nada sai de novo.
  assert.equal((await f.nfce.consult(sale.id, randomUUID())).situation, "pendente");
  assert.equal(f.state.calls.filter(call => call !== "emit").length, 0);
  f.clock.advance(61_000);
  // "Tentar de novo" sobre resultado incerto vira consulta: não há segundo envio.
  const consulted = await f.nfce.emit(sale.id, randomUUID(), null);
  assert.equal(consulted.situation, "autorizado", JSON.stringify(consulted.reason));
  assert.equal(f.state.calls.filter(call => call === "emit").length, 1);
  assert.ok(f.state.calls.includes("find"));
  assert.equal(consulted.coupon.access_key, accessKey);
});

test("rejeição da SEFAZ aparece em palavras e o reenvio corrigido usa a mesma referência", async t => {
  const f = setup(t), sale = f.sell();
  f.state.mode = "rejected";
  const rejected = await f.nfce.emit(sale.id, randomUUID(), null);
  assert.equal(rejected.situation, "pendente");
  assert.equal(rejected.reason.code, "rejected");
  assert.match(rejected.reason.text, /NCM inexistente/);
  assert.ok(rejected.actions.includes("tentar_de_novo") && rejected.actions.includes("corrigir_e_reenviar"));
  f.state.mode = "authorized";
  const fixed = await f.nfce.emit(sale.id, randomUUID(), null);
  assert.equal(fixed.situation, "autorizado");
  assert.equal(new Set(f.state.bodies.map(body => body.referencia)).size, 1);
  assert.equal(count(f, "erp_fiscal_vault__counter_emission"), 1);
  assert.equal(count(f, "erp_fiscal_vault__counter_revision"), 2);
});

test("contingência do cofre: o cupom vale para o cliente, imprime e fica pendente até a SEFAZ", async t => {
  const f = setup(t), sale = f.sell();
  f.state.mode = "contingency";
  const offline = await f.nfce.emit(sale.id, randomUUID(), null);
  assert.equal(offline.situation, "pendente");
  assert.equal(offline.reason.code, "contingency");
  assert.ok(offline.actions.includes("imprimir") && offline.actions.includes("consultar"));
  assert.match(await (await f.nfce.coupon(sale.id, "establishment")).text(), /^%PDF-/);
  f.state.remote = { ...f.state.remote, status: "authorized", protocol: "165260000000001", authorized_at: "2026-11-19T12:05:00Z" };
  f.clock.advance(61_000);
  assert.equal((await f.nfce.consult(sale.id, randomUUID())).situation, "autorizado");
  assert.equal(f.state.calls.filter(call => call === "emit").length, 1);
});

test("cancelar no prazo: primeiro o cofre, depois a venda, o estoque e as contas; o turno conta o cancelado", async t => {
  const f = setup(t), sale = f.sell();
  assert.equal((await f.nfce.emit(sale.id, randomUUID(), null)).situation, "autorizado");
  const cancelled = await f.nfce.cancel(sale.id, randomUUID(), justification, true);
  assert.equal(cancelled.situation, "cancelado", JSON.stringify(cancelled));
  assert.equal(cancelled.sale_state, "cancelled");
  assert.deepEqual(f.state.calls.filter(call => call === "cancel"), ["cancel"]);
  assert.equal(count(f, "erp_stock__document_posting", "document_id=? AND state='active'", sale.document_id), 0);
  assert.equal(count(f, "erp_finance__document_posting", "document_id=? AND state='active'", sale.document_id), 0);
  const view = f.rpc("erp_com1_get", { p_input: { emission_id: cancelled.coupon.emission_id } });
  assert.equal(view.cancellation.state, "registrado");
  const second = f.sell();
  f.state.lost = true;
  await f.nfce.emit(second.id, randomUUID(), null);
  const summary = await f.nfce.sales({ from: COM1_DATE, to: COM1_DATE });
  assert.deepEqual(summary.counts, { autorizado: 0, pendente: 1, cancelado: 1 });
  const pending = await f.nfce.sales({ pending_only: true });
  assert.deepEqual(pending.items.map(item => item.sale_id), [second.id]);
});

test("fora do prazo de cancelamento: a tela explica a devolução e nada é cancelado", async t => {
  const f = setup(t), sale = f.sell();
  await f.nfce.emit(sale.id, randomUUID(), null);
  f.clock.advance(31 * 60 * 1000);
  const late = await f.nfce.get(sale.id);
  assert.ok(late.actions.includes("devolucao") && !late.actions.includes("cancelar"));
  await assert.rejects(f.nfce.cancel(sale.id, randomUUID(), justification, true), error => error.code === "nfce_cancel_deadline" && /devolução/.test(error.message));
  assert.equal(f.state.calls.includes("cancel"), false);
  assert.equal(row(f, "SELECT state FROM erp_pos__sale WHERE id=?", sale.id).state, "finished");
});

test("partes: com Fiscal desligado o caixa vende igual e o cupom recusa com parte desligada", async t => {
  const f = setup(t);
  f.state.parts = { fiscal: false };
  const sale = f.rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_finish", p_data: {
    sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: f.account.id, cash_session_id: null,
    contact_id: f.customer.id, price_list_id: null,
    document: { date: COM1_DATE, warehouse_id: f.warehouse.id, items: [{ product_id: f.product.id, description: "Mercadoria do Ensaio", unit: "UN", quantity: "1", unit_price: "25.50" }] },
    payments: [{ payment_method_id: f.cash.id, days: 0, amount_cents: "2550", note: null }], destination_account_id: null, to_ledger: false, cash_received_cents: null } },
    { parts: { fiscal: false } }).record;
  assert.equal(sale.state, "finished");
  await assert.rejects(f.nfce.emit(sale.id, randomUUID(), null), /module_disabled|parte/);
  assert.throws(() => f.rpc("erp_com1_nfce_sales", { p_input: { environment: "homologacao" } }, { parts: { pos: false } }), /module_disabled|parte desligada/);
  assert.equal(f.state.calls.length, 0);
});

test("CPF/CNPJ do consumidor é opcional e conferido; natureza única é usada sozinha", async t => {
  const f = setup(t), sale = f.sell();
  await assert.rejects(f.nfce.emit(sale.id, randomUUID(), "12345678900"), /fiscal_consumer_document_invalid/);
  const config = f.rpc("erp_com1_nfce_config_get", {});
  assert.equal(config.resolved_nature_id, f.nature.id);
  assert.equal(f.state.calls.length, 0);
});
