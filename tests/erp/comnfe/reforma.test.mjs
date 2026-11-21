// Reforma tributária no preparo da NF-e (structural.ts, reforma-calculo): o
// grupo IBS/CBS só vai ao cofre quando o contrato dele aceita (capacidade
// lida no teste de conexão e guardada na configuração da NF-e). Cofre que
// não aceita: a nota sai como hoje e o cálculo fica só informativo. Teste de
// conexão antigo (sem a leitura): a classificação continua bloqueando. Tudo
// contra o motor em memória, sem cofre nem rede.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "./fixtures.mjs";
import { installCommercialNfePreparation } from "../../../src/erp/domains/fiscal/comnfe/prepare.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { com1Hash } from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const connection = com1Hash("cofre de ensaio sem rede");
const ACCEPTS = { ibs_cbs: true, selective: true, purposes: ["normal", "complementar", "ajuste", "devolucao"], credit_debit: false };
const REFUSES = { ibs_cbs: false, selective: false, purposes: ["normal", "complementar", "ajuste", "devolucao"], credit_debit: false };
const commercial = { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
  transport: { freight_mode: "9", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } };

/** O pedido do ensaio (2 × R$ 25,50, empresa do Simples, CSOSN 102, PIS e COFINS 07) e o cofre com a capacidade dada. */
function fixture(t, reform) {
  const f = com1Fixture(t);
  t.after(installCommercialNfePreparation());
  const complete = { ...f.orderBody, payment_means: "15", payment_indicator: "1", commercial,
    items: f.orderBody.items.map((item, index) => ({ ...item, code: `P${index + 1}` })) };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: f.order.version,
    p_command_id: randomUUID(), p_body: complete }).document;
  t.after(installCommercialConnectionResolver(() => ({ fingerprint: connection, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: "1795089600000000", compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao"], series: [{ environment: "homologacao", series: 1 }],
    ...(reform === undefined ? {} : { reform }) })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  let previous = null;
  f.prepare = () => {
    const result = f.rpc("erp_com1_prepare", { p_input: { document_id: f.order.id, expected_document_version: f.order.version, command_id: randomUUID(),
      choices: { nature_id: f.nature.id, presence: "presencial", final_consumer: true }, ...(previous ? { expected_emission_version: previous } : {}) } });
    previous = result.emission.version;
    return result;
  };
  f.classify = (classification = { cst: "000", cclasstrib: "000001" }) => {
    const current = f.rpc("erp_fiscal_reform_product_get", { p_product_id: f.product.id });
    return f.rpc("erp_fiscal_reform_product_save", { p_command_id: randomUUID(), p_product_id: f.product.id, p_expected_hash: current.expected_hash, p_classification: classification });
  };
  f.simplesRegular = () => f.rpc("erp_fiscal_reform_settings_save", { p_command_id: randomUUID(), p_expected_version: 0, p_data: { simples_regular: true, rates: {} } });
  return f;
}
const ready = (result) => { assert.deepEqual(result.blockers, []); assert.equal(result.emission.status, "preparada"); return result.emission; };

test("sem classificação nem configuração e com teste de conexão antigo: a nota sai exatamente como antes", t => {
  const f = fixture(t, undefined);
  const emission = ready(f.prepare());
  assert.equal(emission.revision.calculation.reform, undefined);
  assert.equal(emission.revision.tax_sources.reform_calc, undefined);
  assert.equal(JSON.stringify(emission.revision.body).includes("ibsCbs"), false);
});

test("cofre aceita e nenhum item classificado: a nota sai sem o grupo e avisa o que falta", t => {
  const f = fixture(t, ACCEPTS);
  f.simplesRegular();
  const emission = ready(f.prepare());
  assert.equal(JSON.stringify(emission.revision.body).includes("ibsCbs"), false);
  const reform = emission.revision.calculation.reform;
  assert.deepEqual([reform.vault, reform.items[0].status], ["accepts", "unclassified"]);
  assert.ok(reform.notices.some(n => n.code === "reform_unclassified"));
});

test("cofre aceita: o item leva o grupo IBS/CBS com as alíquotas de teste de 2026 e o total não muda", t => {
  const f = fixture(t, ACCEPTS);
  const before = ready(f.prepare());
  f.classify();
  f.simplesRegular();
  const emission = ready(f.prepare());
  const item = emission.revision.body.itens[0];
  assert.deepEqual(item.impostos.ibsCbs, {
    cst: "000", classificacao: "000001", baseCalculo: 51,
    ibsUf: { aliquota: 0.1, valor: 0.05 }, ibsMunicipio: { aliquota: 0, valor: 0 }, cbs: { aliquota: 0.9, valor: 0.46 },
  });
  const reform = emission.revision.calculation.reform;
  assert.deepEqual([reform.year, reform.vault, reform.sent, reform.regime, reform.informative], [2026, "accepts", true, "simples_regular", true]);
  assert.deepEqual(reform.totals, { base: "51.00", cbs: "0.46", ibs_uf: "0.05", ibs_mun: "0.00", ibs: "0.05", selective: "0.00", total: "0.51" });
  assert.equal(emission.revision.calculation.fiscal_total_cents, before.revision.calculation.fiscal_total_cents);
  assert.equal(emission.revision.body.cobranca.fatura.valorLiquido, before.revision.body.cobranca.fatura.valorLiquido);
});

test("cofre aceita, empresa do Simples sem a opção: a nota sai sem o grupo e diz por quê", t => {
  const f = fixture(t, ACCEPTS);
  f.classify();
  const emission = ready(f.prepare());
  assert.equal(JSON.stringify(emission.revision.body).includes("ibsCbs"), false);
  const reform = emission.revision.calculation.reform;
  assert.deepEqual([reform.regime, reform.sent], ["simples", false]);
  assert.match(reform.message, /Simples Nacional/);
});

test("isenção ou imunidade: vai só o CST e a classificação, sem base", t => {
  const f = fixture(t, ACCEPTS);
  f.classify({ cst: "410", cclasstrib: "410004" });
  f.simplesRegular();
  const emission = ready(f.prepare());
  assert.deepEqual(emission.revision.body.itens[0].impostos.ibsCbs, { cst: "410", classificacao: "410004" });
});

test("cofre não aceita: a nota sai como hoje, sem o grupo, e a tela diz que o cofre ainda não recebe a reforma", t => {
  const f = fixture(t, REFUSES);
  f.classify();
  f.simplesRegular();
  const emission = ready(f.prepare());
  assert.equal(JSON.stringify(emission.revision.body).includes("ibsCbs"), false);
  const reform = emission.revision.calculation.reform;
  assert.deepEqual([reform.vault, reform.sent], ["refuses", false]);
  assert.match(reform.message, /ainda não recebe/);
  assert.equal(reform.totals.cbs, "0.46");
});

test("teste de conexão antigo (sem a leitura do contrato): a classificação bloqueia e manda testar a conexão", t => {
  const f = fixture(t, undefined);
  f.classify();
  const result = f.prepare();
  const blocker = result.blockers.find(b => b.code === "fiscal_reform_required");
  assert.ok(blocker);
  assert.equal(blocker.correction.screen, "fiscal_settings");
  assert.match(blocker.message, /Teste a conexão do cofre/);
  assert.equal(result.emission.status, "bloqueada");
});

test("classificação ou configuração mudam o fingerprint das fontes", t => {
  const f = fixture(t, ACCEPTS);
  const first = ready(f.prepare()).revision.source_fingerprint;
  f.classify();
  const second = ready(f.prepare()).revision.source_fingerprint;
  assert.notEqual(second, first);
  f.simplesRegular();
  assert.notEqual(ready(f.prepare()).revision.source_fingerprint, second);
});
