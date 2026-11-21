// NF-e: casos especiais (combustível, monofásico, veículo, medicamento, autXML,
// Suframa, retirada e entrega) contra o contrato do cofre 0.12.0. O que o
// cofre recebe (PIS/COFINS monofásico) sai no PedidoNfe e passa no cofre
// simulado; o que não recebe bloqueia em palavras ou vira aviso na revisão.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "./fixtures.mjs";
import { CONTRACT_VERSION, contractHasProperty, pedidoNfeErrors } from "./contrato-cofre.mjs";
import { installCommercialNfePreparation } from "../../../src/erp/domains/fiscal/comnfe/prepare.ts";
import { capturePreparationSources } from "../../../src/erp/domains/fiscal/comnfe/source.ts";
import { calculatePreparationTaxes } from "../../../src/erp/domains/fiscal/comnfe/taxes.ts";
import { mapPreparation } from "../../../src/erp/domains/fiscal/comnfe/mapper.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { com1Hash } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { NFE_SPECIAL_GROUPS, SPECIAL_GROUPS_VAULT_VERSION, specialGroupNotices } from "../../../src/erp/domains/fiscal/comnfe/special-groups.ts";

const connection = com1Hash("cofre de ensaio sem rede");
const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
  transport: { freight_mode: "9", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } };
function fixture(t, options = {}) {
  const f = com1Fixture(t, options);
  t.after(installCommercialNfePreparation());
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: f.order.version, p_command_id: randomUUID(),
    p_body: { ...f.orderBody, payment_means: "15", payment_indicator: "1", commercial, items: f.orderBody.items.map((item, index) => ({ ...item, code: `P${index + 1}` })) } }).document;
  t.after(installCommercialConnectionResolver(() => ({ fingerprint: connection, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: "1795089600000000", compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao"], series: [{ environment: "homologacao", series: 1 }] })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  f.input = () => ({ document_id: f.order.id, expected_document_version: f.order.version, command_id: randomUUID(),
    choices: { nature_id: f.nature.id, presence: "presencial", final_consumer: true } });
  f.prepare = () => f.rpc("erp_com1_prepare", { p_input: f.input() });
  return f;
}
function mapped(f, change = () => {}) {
  const sources = structuredClone(f.transaction(ctx => capturePreparationSources(ctx, f.input())));
  change(sources);
  return mapPreparation(sources, calculatePreparationTaxes(sources), { environment: "homologacao", reference: `wb.${f.order.id}.v1` });
}
const rules = (pis, cofins, icms = { situation: "102", cfop: "5102" }) => [{ tax: "icms", data: icms }, { tax: "pis", data: pis }, { tax: "cofins", data: cofins }];
const blockerOf = (result, field) => result.blockers.find(blocker => blocker.field === field);

test("a conferência foi feita no contrato que o cliente usa e os grupos não aceitos seguem fora dele", () => {
  assert.equal(CONTRACT_VERSION, SPECIAL_GROUPS_VAULT_VERSION, "contrato do cofre mudou: refaça a conferência de special-groups.ts");
  // Nomes que o contrato teria se recebesse cada grupo; nenhum existe no PedidoNfe.
  for (const name of ["comb", "combustivel", "codigoAnp", "veicProd", "veiculoNovo", "med", "medicamento", "rastro", "rastreabilidade", "autXML", "autorizadosXml", "suframa", "inscricaoSuframa", "retirada", "localRetirada", "entrega", "localEntrega"])
    assert.equal(contractHasProperty(name), false, name);
  assert.deepEqual(Object.entries(NFE_SPECIAL_GROUPS).filter(([, group]) => group.accepted).map(([key]) => key), ["pis_cofins_monophase"]);
  for (const group of Object.values(NFE_SPECIAL_GROUPS)) { assert.ok(group.layout); assert.ok(group.fields.length); assert.ok(group.action); }
});

test("PIS e COFINS monofásicos na revenda (CST 04) saem no pedido e passam no cofre simulado", t => {
  const f = fixture(t, { nature: { rules: rules({ situation: "04" }, { situation: "04" }) } });
  const prepared = f.prepare();
  assert.deepEqual(prepared.blockers, []);
  assert.equal(prepared.emission.status, "preparada");
  const body = prepared.emission.revision.body;
  assert.deepEqual(body.itens[0].impostos.pis, { cst: "04" });
  assert.deepEqual(body.itens[0].impostos.cofins, { cst: "04" });
  assert.deepEqual(pedidoNfeErrors(body), []);
  // O total da nota não muda: PIS e COFINS monofásicos não somam.
  assert.equal(body.pagamentos.reduce((sum, payment) => sum + payment.valor, 0), 51);
});

test("PIS e COFINS monofásicos do fabricante (CST 02, alíquota diferenciada) levam base, alíquota e valor", t => {
  const f = fixture(t, { nature: { rules: rules({ situation: "02", base_rate: "100.0000", rate: "2.1000" }, { situation: "02", base_rate: "100.0000", rate: "9.7100" }) } });
  const result = mapped(f);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.body.itens[0].impostos.pis, { cst: "02", baseCalculo: 51, aliquota: 2.1, valor: 1.07 });
  assert.deepEqual(result.body.itens[0].impostos.cofins, { cst: "02", baseCalculo: 51, aliquota: 9.71, valor: 4.95 });
  assert.deepEqual(pedidoNfeErrors(result.body), []);
  // Regra de CST 02 sem alíquota não some: bloqueia na natureza.
  const missing = mapped(f, sources => { delete sources.snapshot.nature.rules[1].data.rate; });
  assert.equal(missing.body, null);
  assert.ok(missing.blockers.some(blocker => blocker.field === "items.0.pis.rate" && blocker.correction.screen === "fiscal_natures"));
});

test("ICMS monofásico de combustível bloqueia dizendo que o cofre não recebe e o que fazer", t => {
  const f = fixture(t);
  for (const situation of ["02", "15", "53", "61"]) {
    const result = mapped(f, sources => { sources.snapshot.nature.rules[0].data = { situation, cfop: "5656" }; });
    assert.equal(result.body, null, situation);
    const blocker = blockerOf(result, "items.0.icms.situation");
    assert.equal(blocker.code, "fiscal_operation_unsupported");
    assert.match(blocker.message, /ICMS monofásico/);
    assert.match(blocker.message, /cofre fiscal ainda não recebe/);
    assert.match(blocker.message, /regra da natureza/);
  }
});

test("produto com código ANP (combustível) bloqueia no cadastro do produto, em palavras", t => {
  const f = fixture(t);
  const result = mapped(f, sources => { Object.assign(sources.snapshot.products[0], { anp_code: "320102001", anp_description: "GASOLINA C COMUM" }); });
  assert.equal(result.body, null);
  for (const field of ["items.0.product.anp_code", "items.0.product.anp_description"]) {
    const blocker = blockerOf(result, field);
    assert.equal(blocker.code, "fiscal_operation_unsupported", field);
    assert.equal(blocker.correction.screen, "products");
    assert.equal(blocker.correction.id, f.product.id);
    assert.match(blocker.message, /combustível \(código ANP\)/);
    assert.match(blocker.message, /apague o código ANP/);
  }
});

test("veículo novo, medicamento e lote no item bloqueiam com o grupo e a saída", t => {
  const f = fixture(t);
  const result = mapped(f, sources => {
    sources.snapshot.items[0].vehicle = { chassis: "9BWZZZ377VT004251" };
    sources.snapshot.items[0].medicine = { anvisa_code: "1234567890123" };
    sources.snapshot.items[0].rastro = [{ lot: "L1", quantity: "2" }];
  });
  assert.equal(result.body, null);
  for (const [field, words] of [["items.0.vehicle", /veículo novo/], ["items.0.medicine", /ANVISA/], ["items.0.rastro", /rastreabilidade de lote/]]) {
    const blocker = blockerOf(result, field);
    assert.ok(blocker, field);
    assert.equal(blocker.code, "fiscal_operation_unsupported");
    assert.equal(blocker.correction.screen, "sales_orders");
    assert.match(blocker.message, words);
  }
});

test("endereço de entrega e de retirada bloqueiam dizendo como seguir", t => {
  const f = fixture(t);
  const result = mapped(f, sources => {
    sources.snapshot.document.delivery_address = { street: "Rua da Obra", number: "10", city: "São Paulo", state: "SP", postal_code: "01001-000" };
    sources.snapshot.document.pickup_address = { street: "Depósito", city: "Guarulhos", state: "SP" };
  });
  assert.equal(result.body, null);
  assert.match(blockerOf(result, "delivery_address").message, /apague o endereço de entrega no pedido/);
  assert.match(blockerOf(result, "pickup_address").message, /local de retirada/);
});

test("desoneração do ICMS por Suframa bloqueia: o cofre não recebe a inscrição do cliente", t => {
  const f = fixture(t);
  const source = structuredClone(f.transaction(ctx => capturePreparationSources(ctx, f.input())));
  source.snapshot.company.crt = "3"; source.snapshot.nature.crt = "3";
  source.snapshot.nature.rules[0].data = { situation: "40", cfop: "6109", rate: "12.0000", deson_reason: "7", deson_deduct: true };
  source.snapshot.recipient.state = "AM";
  const blocker = calculatePreparationTaxes(source).blockers.find(value => value.field === "items.0.icms.deson_reason" && /Suframa/.test(value.message));
  assert.ok(blocker);
  assert.equal(blocker.code, "fiscal_operation_unsupported");
  assert.match(blocker.message, /Zona Franca/);
});

test("autorizados a baixar o XML e inscrição Suframa viram aviso; a nota sai igual e dentro do contrato", t => {
  const f = fixture(t, { customer: { suframa: "200123456" } });
  const sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(sources.snapshot.recipient.suframa, "200123456");
  const result = mapped(f, value => { value.tax_sources.preferences.autxml_people = [{ document: "12345678909", name: "Contador" }]; });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.calculation.special_notices.map(notice => notice.code), ["nfe_autxml_not_sent", "nfe_suframa_not_sent"]);
  assert.match(result.calculation.special_notices[0].message, /Exportação para o contador/);
  assert.match(result.calculation.special_notices[1].message, /200123456/);
  assert.deepEqual(pedidoNfeErrors(result.body), []);
  assert.equal(JSON.stringify(result.body).includes("200123456"), false);
  assert.equal(JSON.stringify(result.body).includes("12345678909"), false);
});

test("sem autorizados nem Suframa, a revisão não ganha aviso nem a fonte muda", t => {
  const f = fixture(t);
  const sources = f.transaction(ctx => capturePreparationSources(ctx, f.input()));
  assert.equal(Object.hasOwn(sources.snapshot.recipient, "suframa"), false);
  const result = mapped(f);
  assert.deepEqual(result.blockers, []);
  assert.equal(Object.hasOwn(result.calculation, "special_notices"), false);
  assert.deepEqual(specialGroupNotices({ preferences: { autxml_people: [], autxml_carrier: false }, recipient: { suframa: "  " } }), []);
  assert.deepEqual(pedidoNfeErrors(result.body), []);
});

test("o validador do cofre simulado recusa grupo fora do contrato", t => {
  const f = fixture(t);
  const result = mapped(f);
  assert.deepEqual(pedidoNfeErrors(result.body), []);
  const withAutXml = { ...result.body, autXML: [{ cpf: "12345678909" }] };
  assert.ok(pedidoNfeErrors(withAutXml).some(error => error.includes("autXML")));
  const withFuel = structuredClone(result.body); withFuel.itens[0].comb = { cProdANP: "320102001" };
  assert.ok(pedidoNfeErrors(withFuel).some(error => error.includes("comb")));
});
