// Cálculo da reforma tributária (IBS, CBS e IS) sem banco nem rede:
// src/erp/domains/fiscal/reform-calc.ts e reform-table.ts, a leitura da
// capacidade do cofre (src/erp/emissor/reform-capability.ts), o CSV do
// contador e os argumentos da rota erp-reforma.
//
// Os casos seguem as regras das calculadoras oficiais de IBS/CBS/IS da Receita
// Federal (regime geral): alíquota efetiva = alíquota × (1 − redução/100) com
// 4 casas; valor = base × alíquota efetiva / 100 com 2 casas, metade para
// longe do zero; vIBS = vIBSUF + vIBSMun; 2026 com CBS 0,9%, IBS estadual
// 0,1% e municipal 0%. Entrada e resultado esperados em cada caso.
import assert from "node:assert/strict";
import { test } from "node:test";
import contract from "../../../src/erp/emissor/contract/openapi.json" with { type: "json" };
import {
  calculateReform, calculateReformItem, effectiveRate, reformBaseFromItem, reformRatesFor, reformYearOf, regimeOf,
} from "../../../src/erp/domains/fiscal/reform-calc.ts";
import { REFORM_CLASSES, REFORM_CSTS, REFORM_YEAR_RATES, reformClassEntry } from "../../../src/erp/domains/fiscal/reform-table.ts";
import { readVaultReformCapability, vaultReformCapability } from "../../../src/erp/emissor/reform-capability.ts";
import { reformReportCsv } from "../../../src/erp/reforma/csv.ts";
import { erpReformOperationFor, reformRpcArgs, ERP_REFORM_OPERATIONS } from "../../../src/erp/reforma/contract.ts";

const regular = { year: 2026, crt: "3" };
const item = (base, cst, cclasstrib, extra = {}) => ({ item_id: "i1", description: "Item", base, classification: cst ? { cst, cclasstrib, source: "product" } : null, ...extra });
const values = (r) => ({ base: r.base, cbs: r.cbs?.value ?? null, ibs_uf: r.ibs_uf?.value ?? null, ibs_mun: r.ibs_mun?.value ?? null, ibs: r.ibs });

test("tabela: CSTs e classificações coerentes, versão e alíquotas de 2026", () => {
  assert.ok(REFORM_CSTS.some((c) => c.cst === "000" && c.kind === "taxed"));
  for (const entry of REFORM_CLASSES) {
    assert.match(entry.code, /^\d{6}$/);
    assert.equal(entry.code.slice(0, 3), entry.cst, entry.code);
    assert.ok(REFORM_CSTS.some((c) => c.cst === entry.cst), entry.code);
    assert.equal(new Set(REFORM_CLASSES.map((c) => c.code)).size, REFORM_CLASSES.length);
  }
  // As classificações usadas pelos testes de natureza (reform.test.mjs) estão na tabela.
  for (const code of ["000001", "200030", "200001", "410004", "011001"]) assert.ok(reformClassEntry(code), code);
  assert.deepEqual(REFORM_YEAR_RATES.map((y) => y.year), [2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033]);
  assert.deepEqual(reformRatesFor(2026), { year: 2026, cbs: "0.9", ibs_uf: "0.1", ibs_mun: "0", informative: true, selective: false, origin: "test",
    note: REFORM_YEAR_RATES[0].note });
});

test("calculadora: tributação integral (CST 000, cClassTrib 000001), base 100,00 em 2026", () => {
  const r = calculateReformItem(item("100.00", "000", "000001"), regular);
  assert.equal(r.status, "calculated");
  assert.deepEqual(values(r), { base: "100.00", cbs: "0.90", ibs_uf: "0.10", ibs_mun: "0.00", ibs: "0.10" });
  assert.deepEqual([r.cbs.effective_rate, r.ibs_uf.effective_rate, r.ibs_mun.effective_rate], ["0.9000", "0.1000", "0.0000"]);
  assert.equal(r.class_description, "Situações tributadas integralmente pelo IBS e CBS");
});

test("calculadora: arredondamento de 2 casas, metade para longe do zero", () => {
  assert.deepEqual(values(calculateReformItem(item("1234.56", "000", "000001"), regular)), { base: "1234.56", cbs: "11.11", ibs_uf: "1.23", ibs_mun: "0.00", ibs: "1.23" });
  assert.deepEqual(values(calculateReformItem(item("5.00", "000", "000001"), regular)), { base: "5.00", cbs: "0.05", ibs_uf: "0.01", ibs_mun: "0.00", ibs: "0.01" });
  assert.deepEqual(values(calculateReformItem(item("0.50", "000", "000001"), regular)), { base: "0.50", cbs: "0.00", ibs_uf: "0.00", ibs_mun: "0.00", ibs: "0.00" });
  assert.deepEqual(values(calculateReformItem(item("51.00", "000", "000001"), regular)), { base: "51.00", cbs: "0.46", ibs_uf: "0.05", ibs_mun: "0.00", ibs: "0.05" });
});

test("calculadora: alíquota reduzida da classificação (60%, 30% e 100%)", () => {
  const sixty = calculateReformItem(item("1000.00", "200", "200030"), regular);
  assert.deepEqual(values(sixty), { base: "1000.00", cbs: "3.60", ibs_uf: "0.40", ibs_mun: "0.00", ibs: "0.40" });
  assert.deepEqual([sixty.cbs.reduction, sixty.cbs.effective_rate, sixty.ibs_uf.effective_rate], ["60", "0.3600", "0.0400"]);
  assert.deepEqual(values(calculateReformItem(item("500.00", "200", "200052"), regular)), { base: "500.00", cbs: "3.15", ibs_uf: "0.35", ibs_mun: "0.00", ibs: "0.35" });
  assert.deepEqual(values(calculateReformItem(item("300.00", "200", "200003"), regular)), { base: "300.00", cbs: "0.00", ibs_uf: "0.00", ibs_mun: "0.00", ibs: "0.00" });
  assert.equal(effectiveRate("0.9", "60"), "0.3600");
  assert.equal(effectiveRate("8.8", "30"), "6.1600");
});

test("isenção, imunidade e regimes que o ERP não calcula: só CST e classificação", () => {
  const exempt = calculateReformItem(item("100.00", "410", "410004"), regular);
  assert.deepEqual([exempt.status, exempt.base, exempt.cbs, exempt.cst, exempt.cclasstrib], ["exempt", null, null, "410", "410004"]);
  const manual = calculateReformItem(item("100.00", "510", "510001"), regular);
  assert.deepEqual([manual.status, manual.base], ["manual", null]);
  assert.equal(calculateReformItem(item("100.00", "200", "000001"), regular).status, "class_mismatch");
  assert.equal(calculateReformItem(item("100.00", "200", "200999"), regular).status, "unknown_class");
  assert.equal(calculateReformItem(item("100.00", "999", "999001"), regular).status, "unknown_class");
  assert.equal(calculateReformItem(item("100.00", null), regular).status, "unclassified");
  assert.equal(calculateReformItem(item("-1.00", "000", "000001"), regular).status, "out_of_range");
});

test("Simples Nacional não destaca IBS/CBS, salvo a opção pelo regime regular", () => {
  for (const crt of ["1", "2", "4"]) {
    const r = calculateReformItem(item("100.00", "000", "000001"), { year: 2026, crt });
    assert.deepEqual([r.status, r.cbs], ["simples", null], crt);
  }
  const opted = calculateReformItem(item("100.00", "000", "000001"), { year: 2026, crt: "1", settings: { simples_regular: true, rates: {} } });
  assert.deepEqual(values(opted), { base: "100.00", cbs: "0.90", ibs_uf: "0.10", ibs_mun: "0.00", ibs: "0.10" });
  assert.equal(regimeOf("1", { simples_regular: true, rates: {} }), "simples_regular");
  assert.equal(regimeOf("3", null), "regular");
  const doc = calculateReform([item("100.00", "000", "000001")], { year: 2026, crt: "1" });
  assert.equal(doc.regime, "simples");
  assert.ok(doc.notices.some((n) => n.code === "reform_simples"));
});

test("transição: 2027 sem alíquota de referência pede as alíquotas; com as da empresa, calcula", () => {
  const missing = calculateReformItem(item("100.00", "000", "000001"), { year: 2027, crt: "3" });
  assert.equal(missing.status, "rates_unpublished");
  const settings = { simples_regular: false, rates: { 2027: { cbs: "8.8" } } };
  const rates = reformRatesFor(2027, settings);
  assert.deepEqual([rates.cbs, rates.ibs_uf, rates.ibs_mun, rates.origin, rates.informative], ["8.8", "0.05", "0.05", "company", false]);
  assert.deepEqual(values(calculateReformItem(item("100.00", "000", "000001"), { year: 2027, crt: "3", settings })),
    { base: "100.00", cbs: "8.80", ibs_uf: "0.05", ibs_mun: "0.05", ibs: "0.10" });
  // Alíquota inválida informada pela empresa é ignorada (fica a da tabela, ou falta).
  assert.equal(reformRatesFor(2027, { simples_regular: false, rates: { 2027: { cbs: "abc" } } }).origin, "unpublished");
});

test("Imposto Seletivo: a partir de 2027, pela alíquota do produto, e integra a base do IBS e da CBS", () => {
  const selective = { cst: "000", cclasstrib: "000001", rate: "10" };
  const settings = { simples_regular: false, rates: { 2027: { cbs: "8.8" } } };
  const r = calculateReformItem(item("100.00", "000", "000001", { selective }), { year: 2027, crt: "3", settings });
  assert.deepEqual(r.selective, { cst: "000", cclasstrib: "000001", base: "100.00", rate: "10", value: "10.00" });
  assert.deepEqual(values(r), { base: "110.00", cbs: "9.68", ibs_uf: "0.06", ibs_mun: "0.06", ibs: "0.12" });
  const in2026 = calculateReformItem(item("100.00", "000", "000001", { selective }), regular);
  assert.deepEqual([in2026.selective, in2026.base], [null, "100.00"]);
});

test("documento: totais somam os itens e o total a pagar não muda", () => {
  const doc = calculateReform([item("100.00", "000", "000001"), item("1000.00", "200", "200030"), item("50.00", "410", "410004"), item("10.00", null)], regular);
  assert.deepEqual(doc.totals, { base: "1100.00", cbs: "4.50", ibs_uf: "0.50", ibs_mun: "0.00", ibs: "0.50", selective: "0.00", total: "5.00" });
  assert.equal(doc.affects_total, false);
  assert.equal(doc.informative, true);
  assert.ok(doc.notices.some((n) => n.code === "reform_unclassified"));
});

test("base da NF-e em 2026: valor do item menos desconto, ICMS, PIS e COFINS", () => {
  assert.equal(reformBaseFromItem({ gross: "100.00", freight: "10.00", discount: "5.00", icms: "18.00", pis: "1.65", cofins: "7.60" }), "77.75");
  assert.equal(reformBaseFromItem({ gross: "51.00" }), "51.00");
  assert.equal(reformBaseFromItem({ gross: "10.00", discount: "20.00" }), "0.00");
  assert.equal(reformYearOf("2027-01-02"), 2027);
});

test("cofre: capacidade lida do contrato que ele serve", () => {
  const pinned = vaultReformCapability(contract);
  assert.deepEqual(pinned, { ibs_cbs: true, selective: true, purposes: ["normal", "complementar", "ajuste", "devolucao"], credit_debit: false });
  const old = structuredClone(contract);
  const props = old.components.schemas.PedidoNfe.allOf[1].properties.itens.items.properties.impostos.properties;
  delete props.ibsCbs;
  delete props.impostoSeletivo;
  assert.deepEqual(vaultReformCapability(old), { ibs_cbs: false, selective: false, purposes: ["normal", "complementar", "ajuste", "devolucao"], credit_debit: false });
  const future = structuredClone(contract);
  future.components.schemas.PedidoNfe.allOf[1].properties.finalidade.enum.push("credito", "debito");
  assert.equal(vaultReformCapability(future).credit_debit, true);
  assert.equal(vaultReformCapability({}), null);
  assert.deepEqual(readVaultReformCapability(pinned), pinned);
  assert.equal(readVaultReformCapability({ ...pinned, extra: 1 }), undefined);
  assert.equal(readVaultReformCapability(null), null);
});

test("CSV do contador: ponto e vírgula, vírgula decimal e aviso das notas sem cálculo", () => {
  const csv = reformReportCsv({
    from: "2026-11-01", to: "2026-11-30", environment: "producao", without_reform: 1, table: { version: "t1" },
    lines: [{ month: "2026-11", cst: "000", cclasstrib: "000001", description: "Situações tributadas integralmente pelo IBS e CBS", notes: 2, items: 3,
      base: "151.00", cbs: "1.36", ibs_uf: "0.15", ibs_mun: "0.00", ibs: "0.15", selective: "0.00" }],
    totals: { notes: 2, base: "151.00", cbs: "1.36", ibs_uf: "0.15", ibs_mun: "0.00", ibs: "0.15", selective: "0.00" },
  });
  assert.ok(csv.startsWith("﻿IBS, CBS e IS das NF-e autorizadas;01/11/2026 a 30/11/2026\r\n"));
  assert.ok(csv.includes("2026-11;000;000001;Situações tributadas integralmente pelo IBS e CBS;2;3;151,00;1,36;0,15;0,00;0,15;0,00\r\n"));
  assert.ok(csv.includes("Total;;;;2;;151,00;1,36;0,15;0,00;0,15;0,00"));
  assert.ok(csv.includes("1 nota(s) autorizada(s) no período sem cálculo da reforma"));
});

test("rota erp-reforma: operações só pela tela e argumentos do motor", () => {
  assert.ok(ERP_REFORM_OPERATIONS.every((op) => op.bot === false && op.parts[0] === "erp-fiscal"));
  const product = "9b2f0c1e-3d4a-4b5c-8d6e-7f8091a2b3c4";
  const found = erpReformOperationFor("POST", `erp-reforma/produtos/${product}`);
  assert.equal(found.operation.rpc, "erp_fiscal_reform_product_save");
  assert.deepEqual(reformRpcArgs(found.operation, found.params, new URLSearchParams(), { hash: "h", classificacao: { cst: "000", cclasstrib: "000001" } }, () => "c"),
    { p_command_id: "c", p_product_id: product, p_expected_hash: "h", p_classification: { cst: "000", cclasstrib: "000001" }, p_selective: null });
  const report = erpReformOperationFor("GET", "erp-reforma/relatorio");
  assert.deepEqual(reformRpcArgs(report.operation, {}, new URLSearchParams("de=2026-11-01&ate=2026-11-30"), undefined, () => "c"),
    { p_from: "2026-11-01", p_to: "2026-11-30", p_environment: "producao" });
  assert.throws(() => reformRpcArgs(report.operation, {}, new URLSearchParams("de=ontem"), undefined, () => "c"), /período/);
  const doc = erpReformOperationFor("GET", "erp-reforma/documento");
  assert.deepEqual(reformRpcArgs(doc.operation, {}, new URLSearchParams(`tipo=sales_orders&produtos=${product}`), undefined, () => "c"),
    { p_kind: "sales_orders", p_contact_id: null, p_product_ids: [product] });
  assert.equal(erpReformOperationFor("DELETE", "erp-reforma/configuracao"), null);
});
