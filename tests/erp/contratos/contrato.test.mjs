// Contratos: o contrato das operações (nomes, caminhos, o que é sensível e o
// que é só de tela), os argumentos dos RPCs a partir da consulta e do corpo em
// português, as assinaturas e o portão de partes de cada RPC, e as contas da
// tela (valores e datas como a pessoa lê). Sem rede e sem Worker.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContractArgsError, ERP_CONTRACT_OPERATIONS, ERP_CONTRATOS_MODULE_CONTRACT, contractRpcArgs, erpContractOperationFor, erpContractParams,
} from "../../../src/erp/contratos/contract.ts";
import { ENGINE_SIGNATURES } from "../../../src/erp/engine/signatures-engine.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements.ts";
import { centsText, dayText, moneyInput, percentText, quantityInput } from "../../../web/erp/contratos-api.ts";

const ID = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
const command = async () => "11111111-1111-4111-8111-111111111111";
const args = (name, params = {}, query = "", body) => contractRpcArgs(ERP_CONTRACT_OPERATIONS.find((op) => op.name === name), params, new URLSearchParams(query), body, command);

test("operações: ativar, suspender, reajustar e encerrar são sensíveis; consultas são leitura; o resto é só de tela", () => {
  const bot = ERP_CONTRACT_OPERATIONS.filter((op) => op.bot !== false);
  assert.deepEqual(bot.filter((op) => op.sensitive).map((op) => op.name).sort(), ["erp.contratos.ativar", "erp.contratos.encerrar", "erp.contratos.reajustar", "erp.contratos.suspender"]);
  assert.ok(bot.filter((op) => !op.sensitive).every((op) => op.method === "GET"));
  assert.deepEqual(ERP_CONTRATOS_MODULE_CONTRACT.routes, ["erp-contratos"]);
  for (const op of ERP_CONTRACT_OPERATIONS) {
    assert.ok(ENGINE_SIGNATURES[op.rpc], `${op.rpc} sem assinatura`);
    assert.equal(ERP_RPC_RULES[op.rpc], "contracts", `${op.rpc} fora do portão`);
    assert.ok(op.summary.length > 10 && op.description.length > 30, op.name);
    assert.doesNotMatch(`${op.summary} ${op.description}`, /Fagoo|Origin/);
    for (const key of erpContractParams(op).required) assert.ok(erpContractParams(op).properties[key], `${op.name}: ${key}`);
  }
  assert.equal(erpContractOperationFor("GET", `erp-contratos/contratos/${ID}`).operation.name, "erp.contratos.ver");
  assert.equal(erpContractOperationFor("POST", `erp-contratos/contratos/${ID}/reajuste`).operation.name, "erp.contratos.reajustar");
  assert.equal(erpContractOperationFor("GET", `erp-contratos/contratos/${ID}/reajuste`).operation.name, "erp.contratos.reajuste_previa");
  assert.equal(erpContractOperationFor("POST", "erp-contratos/bling/9701/adotar").params.fonte, "9701");
  assert.equal(erpContractOperationFor("DELETE", "erp-contratos/contratos"), null);
  assert.deepEqual(erpDestinationRequirement("/contratos")?.requirement.all, ["erp-contratos", "erp-financeiro", "erp"]);
});

test("argumentos: filtros e corpo em português viram os do motor; o que não vale recusa com mensagem", async () => {
  assert.deepEqual(await args("erp.contratos.lista", {}, "situacao=ativo&busca=ar&vencendo_em=30"), { p_args: { status: "active", q: "ar", ending_within: 30 } });
  await assert.rejects(args("erp.contratos.lista", {}, "situacao=qualquer"), ContractArgsError);
  await assert.rejects(args("erp.contratos.lista", {}, "outro=1"), /Parâmetro não aceito/);
  assert.deepEqual(await args("erp.contratos.faturas", {}, "situacao=cobranca_a_enviar"), { p_args: { status: "charge_pending" } });
  const created = await args("erp.contratos.criar", {}, "", {
    cliente: ID, objeto: "Manutenção", inicio: "2026-10-05", fim: "", periodicidade: "trimestral", dia_vencimento: 10,
    itens: [{ servico: ID, quantidade: 2, valor: "150,00" }, { descricao: "Deslocamento", valor: 20 }], reajuste: { indice: "fixo", percentual: "5", mes: 3, avisar_cliente: true },
  });
  assert.deepEqual(created, { p_command_id: await command(), p_data: {
    object: "Manutenção", starts_on: "2026-10-05", ends_on: null, due_day: 10, contact_id: ID, periodicity: "quarterly",
    items: [{ product_id: ID, quantity: "2", unit_price: "150,00" }, { description: "Deslocamento", unit_price: "20" }],
    adjustment: { index: "fixed", month: 3, percent: "5", notify: true },
  } });
  await assert.rejects(args("erp.contratos.criar", {}, "", { periodicidade: "semanal", cliente: ID }), /periodicidade/);
  await assert.rejects(args("erp.contratos.criar", {}, "", { reajuste: { indice: "selic", mes: 1 }, cliente: ID }), /reajuste.indice/);
  assert.deepEqual(await args("erp.contratos.encerrar", { id: ID }, "", { versao: 3, motivo: "Cliente fechou" }),
    { p_command_id: await command(), p_data: { id: ID, expected_version: 3, action: "end", reason: "Cliente fechou" } });
  await assert.rejects(args("erp.contratos.ativar", { id: ID }, "", {}), /versao/);
  assert.deepEqual((await args("erp.contratos.cobranca", { id: ID }, "", { versao: 1, ligada: true, enviar_whatsapp: true, a_partir_de: "2026-11-05" })).p_data,
    { id: ID, expected_version: 1, enabled: true, send_whatsapp: true, from: "2026-11-05" });
  assert.deepEqual((await args("erp.contratos.reajustar", { id: ID }, "", { versao: 2, mes: "2027-03", percentual: 4.56 })).p_data,
    { id: ID, expected_version: 2, month: "2027-03", percent: "4.56" });
  assert.deepEqual((await args("erp.contratos.aditivo", { id: ID }, "", { versao: 2, a_partir_de: "2027-01-01", fim: "", motivo: "Mudança" })).p_data,
    { id: ID, expected_version: 2, effective_on: "2027-01-01", reason: "Mudança", ends_on: null });
  assert.deepEqual((await args("erp.contratos.indice_salvar", {}, "", { indice: "ipca", mes: "2027-03", percentual: "" })).p_data, { index: "ipca", month: "2027-03", percent: null });
  assert.deepEqual((await args("erp.contratos.fatura_marcar", { id: ID }, "", { acao: "cobranca_enviada" })).p_data, { id: ID, action: "charge_sent" });
  await assert.rejects(args("erp.contratos.fatura_marcar", { id: ID }, "", { acao: "pagar" }), /acao/);
  assert.deepEqual((await args("erp.contratos.bling_adotar", { fonte: "9701" }, "", { versao_bling: "1", periodicidade: "anual" })).p_data,
    { source_id: "9701", version: "1", periodicity: "annual" });
  await assert.rejects(args("erp.contratos.bling_adotar", { fonte: "abc" }, "", { versao_bling: "1" }), /fonte/);
});

test("tela: valores, datas, percentuais e campos como a pessoa digita", () => {
  assert.equal(centsText(31368), "R$ 313,68");
  assert.equal(centsText(123456789), "R$ 1.234.567,89");
  assert.equal(dayText("2027-03-10"), "10/03/2027");
  assert.equal(percentText("4.5600"), "4,56%");
  assert.equal(percentText("10.0000"), "10%");
  assert.equal(moneyInput("1.234,50"), "1234.50");
  assert.equal(moneyInput("R$ 350"), "350");
  assert.equal(moneyInput("3,505"), null);
  assert.equal(quantityInput("2,5"), "2.5");
  assert.equal(quantityInput("0"), null);
});
