// Contrato das lojas (src/erp/lojas/contract.ts): nomes estáveis, leituras e
// gravações, o que vai ao inventário dos bots (consultar é leitura; gravar só
// pela tela) e a rota do painel na Base. Sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERP_LOJAS_PART, ERP_LOJAS_ROUTE, ERP_STORE_OPERATIONS, STORE_OPERATION_KINDS, erpStoreOperationFor, erpStoreParams } from "../../../src/erp/lojas/contract.ts";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";
import { ENGINE_SIGNATURES } from "../../../src/erp/engine/signatures-engine.ts";

test("operações: leituras para o bot, gravações só pela tela, todas com RPC classificado e assinado", () => {
  assert.equal(ERP_LOJAS_ROUTE, "erp-lojas");
  assert.equal(ERP_LOJAS_PART, "erp");
  const bot = ERP_STORE_OPERATIONS.filter((op) => op.bot !== false);
  assert.deepEqual(bot.map((op) => op.name), ["erp.lojas.listar", "erp.lojas.relatorio", "erp.lojas.operacoes"]);
  assert.ok(bot.every((op) => op.method === "GET"), "o bot só consulta as lojas");
  assert.equal(bot.find((op) => op.name === "erp.lojas.operacoes").sensitive, true, "a lista com nomes de clientes é leitura sensível");
  for (const op of ERP_STORE_OPERATIONS) {
    assert.equal(ERP_RPC_RULES[op.rpc], "stores", op.rpc);
    assert.ok(ENGINE_SIGNATURES[op.rpc], op.rpc);
    assert.ok(op.description.length > 30 && !/Fagoo|Origin/.test(op.description), op.name);
  }
  assert.equal(erpStoreOperationFor("GET", "erp-lojas/").name, "erp.lojas.listar");
  assert.equal(erpStoreOperationFor("POST", "erp-lojas/pessoas").rpc, "erp_store_person_set");
  assert.equal(erpStoreOperationFor("DELETE", "erp-lojas"), null);
  assert.deepEqual(erpStoreParams(ERP_STORE_OPERATIONS[1]).required, ["de", "ate"]);
  assert.deepEqual(Object.values(STORE_OPERATION_KINDS).sort(), ["pos_sales", "purchase_orders", "sales_orders", "sales_proposals", "stock_moves", "titles"]);
});

test("tela /lojas é da Base (Cadastros)", () => {
  const r = erpDestinationRequirement("/lojas");
  assert.equal(r.owner, "erp");
  assert.deepEqual([...r.requirement.all], ["erp"]);
});
