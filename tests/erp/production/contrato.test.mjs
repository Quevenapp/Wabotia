// Produção: o contrato da rota /erp-producao (operações, leitura × sensível,
// argumentos em português → RPC), a parte Produção (depende de Estoque e
// Produtos, desligada por padrão, mensagem de parte desligada e destino da
// tela) e os números da tela. Puro: sem Worker, sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERP_PRODUCTION_OPERATIONS, ERP_PRODUCAO_MODULE_CONTRACT, ProductionArgsError, erpProductionOperationFor, erpProductionParams, productionRpcArgs } from "../../../src/erp/production/contract.ts";
import { ERP_MODULE_IDS, ERP_PART_DEPENDENCIES, ERP_PART_MODULES, ERP_PART_NAMES, erpPartOffMessage, erpRequirement, erpRequirementMet, normalizeErpParts } from "../../../src/erp/parts.ts";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { ENGINE_SIGNATURES } from "../../../src/erp/engine/signatures-engine.ts";
import { moneyText, quantityText } from "../../../web/erp/producao.ts";

const ID = "6f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f";
const command = async () => "11111111-2222-4333-8444-555555555555";
const args = (name, params = {}, query = "", body) => {
  const op = ERP_PRODUCTION_OPERATIONS.find((o) => o.name === name);
  return productionRpcArgs(op, params, new URLSearchParams(query), body, command);
};

test("parte Produção: depende de Estoque e Produtos, nome em palavras e mensagem de parte desligada", () => {
  assert.equal(ERP_PART_MODULES.production, "erp-producao");
  assert.ok(ERP_MODULE_IDS.includes("erp-producao"));
  assert.deepEqual([...ERP_PART_DEPENDENCIES["erp-producao"]], ["erp-estoque", "erp-produtos"]);
  assert.equal(ERP_PART_NAMES["erp-producao"], "Produção");
  assert.deepEqual([...erpRequirement("erp-producao").all].sort(), ["erp", "erp-estoque", "erp-producao", "erp-produtos"]);
  assert.equal(erpRequirementMet(normalizeErpParts({ stock: false }), erpRequirement("erp-producao")), false);
  const on = Object.fromEntries(ERP_MODULE_IDS.map((id) => [id, true]));
  assert.equal(erpPartOffMessage("erp-producao", erpRequirement("erp-producao"), on), null);
  assert.equal(erpPartOffMessage("erp-producao", erpRequirement("erp-producao"), { ...on, "erp-producao": false }),
    "Esta tela faz parte de Produção, que está desligado. Ligue em Gestão → Módulos.");
  assert.match(erpPartOffMessage("erp-producao", erpRequirement("erp-producao"), { ...on, "erp-producao": false, "erp-estoque": false }), /Produção depende de Estoque/);
  assert.equal(erpDestinationRequirement("/producao").owner, "erp-producao");
  assert.equal(erpDestinationRequirement("/producao?ordem=nova").owner, "erp-producao");
});

test("operações: consultar é leitura; criar, concluir e estornar são sensíveis; o resto só pela tela", () => {
  const bot = ERP_PRODUCTION_OPERATIONS.filter((o) => o.bot !== false);
  assert.deepEqual(bot.filter((o) => !o.sensitive).map((o) => o.name), ["erp.producao.ordens", "erp.producao.ordem", "erp.producao.sugestoes", "erp.producao.previa"]);
  assert.deepEqual(bot.filter((o) => o.sensitive).map((o) => o.name), ["erp.producao.criar", "erp.producao.concluir", "erp.producao.estornar"]);
  assert.ok(bot.every((o) => (o.method === "GET") === !o.sensitive));
  assert.deepEqual(ERP_PRODUCAO_MODULE_CONTRACT.routes, ["erp-producao"]);
  for (const o of ERP_PRODUCTION_OPERATIONS) {
    assert.equal(o.parts[0], "erp-producao", o.name);
    assert.ok(ERP_RPC_RULES[o.rpc], `${o.rpc} classificado no portão de partes`);
    assert.ok(ENGINE_SIGNATURES[o.rpc], `${o.rpc} com assinatura`);
    assert.ok(o.description.length > 40 && !/Fagoo|Origin/.test(o.description + o.summary), o.name);
    for (const key of o.required.filter((k) => k !== "id")) assert.ok(o.body.includes(key) || o.query.includes(key), `${o.name}: ${key}`);
  }
  assert.equal(ERP_RPC_RULES.erp_production_purchase, "production_purchase");
  assert.deepEqual(ERP_PRODUCTION_OPERATIONS.find((o) => o.name === "erp.producao.comprar").parts, ["erp-producao", "erp-compras"]);
  assert.deepEqual(erpProductionParams(ERP_PRODUCTION_OPERATIONS.find((o) => o.name === "erp.producao.estornar")).required, ["id", "versao", "motivo"]);
  assert.equal(erpProductionOperationFor("GET", `erp-producao/ordens/${ID}`).operation.name, "erp.producao.ordem");
  assert.equal(erpProductionOperationFor("POST", `erp-producao/ordens/${ID}/concluir`).params.id, ID);
  assert.equal(erpProductionOperationFor("POST", `erp-producao/apontamentos/${ID}/estorno/`).operation.name, "erp.producao.estornar");
  assert.equal(erpProductionOperationFor("DELETE", `erp-producao/ordens/${ID}`), null);
});

test("argumentos: português da rota → RPC, com os erros em palavras", async () => {
  assert.deepEqual(await args("erp.producao.ordens", {}, "situacao=em_producao&busca=bolo&pagina=2"), { p_args: { status: "in_progress", q: "bolo", page: 2 } });
  assert.deepEqual(await args("erp.producao.criar", {}, "", { produto: ID, quantidade: "10", insumos: [{ produto: ID, por_unidade: "0,5", perda: "5" }], situacao: "liberada" }),
    { p_command_id: "11111111-2222-4333-8444-555555555555", p_data: { product_id: ID, quantity: "10", inputs: [{ product_id: ID, per_unit: "0,5", loss_percent: "5" }], status: "released" } });
  assert.deepEqual((await args("erp.producao.concluir", { id: ID }, "", { versao: 3, quantidade: "2", custo_adicional: "12.50", lote: { codigo: "L1", validade: "2027-01-31" }, encerrar: true })).p_data,
    { id: ID, expected_version: 3, quantity: "2", extra_cost: "12.50", lot: { code: "L1", expires_on: "2027-01-31" }, finish: true });
  assert.deepEqual((await args("erp.producao.estornar", { id: ID }, "", { versao: 4, motivo: "Errado" })).p_data, { completion_id: ID, expected_version: 4, reason: "Errado" });
  assert.deepEqual((await args("erp.producao.situacao", { id: ID }, "", { versao: 1, acao: "cancelar", motivo: "Desistimos" })).p_data, { id: ID, expected_version: 1, action: "cancel", reason: "Desistimos" });
  assert.deepEqual((await args("erp.producao.previa", { id: ID }, `quantidade=3&consumo=${encodeURIComponent(JSON.stringify([{ produto: ID, quantidade: "1" }]))}`)).p_args,
    { id: ID, quantity: "3", inputs: [{ product_id: ID, quantity: "1" }] });
  for (const [name, params, query, body, message] of [
    ["erp.producao.ordens", {}, "situacao=outra", undefined, /situacao/],
    ["erp.producao.ordens", {}, "x=1", undefined, /Parâmetro não aceito/],
    ["erp.producao.editar", { id: ID }, "", { quantidade: "1" }, /versao/],
    ["erp.producao.situacao", { id: ID }, "", { versao: 1, acao: "apagar" }, /acao/],
    ["erp.producao.concluir", { id: ID }, "", { versao: 1, quantidade: "1", lote: { codigo: "L", outro: 1 } }, /lote/],
    ["erp.producao.criar", {}, "", { produto: "x", quantidade: "1" }, /produto/],
  ]) await assert.rejects(args(name, params, query, body), (e) => e instanceof ProductionArgsError && message.test(e.message), name);
});

test("números da tela em português", () => {
  assert.equal(quantityText("12.500000"), "12,5");
  assert.equal(quantityText("1234.000000"), "1.234");
  assert.equal(quantityText("-0.250000"), "-0,25");
  assert.equal(moneyText("5.0000000000"), "R$ 5,00");
  assert.equal(moneyText("1234.5678000000"), "R$ 1.234,5678");
  assert.equal(moneyText(null), "—");
});
