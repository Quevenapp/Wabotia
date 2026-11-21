// Conciliação: contrato das rotas (consultar pendências é leitura; conciliar a
// linha do extrato e receber o cartão na conta são sensíveis e vão para o bot;
// importar, regras, modelos e taxas só pela tela), argumentos em português,
// menu do Financeiro, destino do painel e a entrada estrutural. Sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERP_CONCILIACAO_MODULE_CONTRACT, ERP_RECONCILIATION_OPERATIONS, erpReconciliationOperationFor, erpReconciliationParams } from "../../../src/erp/conciliacao/contract.ts";
import { ReconciliationArgsError, mappingParam, rateParam, reconciliationRpcArgs } from "../../../src/erp/conciliacao/args.ts";
import { RECONCILIATION_REASONS } from "../../../src/erp/conciliacao/reasons.ts";
import { ERP_STRUCTURAL } from "../../../src/erp/schema/structural.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements.ts";
import { ERP_MANAGEMENT_ITEMS, ORIGIN_MENU } from "../../../src/modules/erp/panel-menu.ts";

const UUID = "11111111-2222-4333-8444-555555555555", OTHER = "66666666-7777-4888-9999-000000000000";
const command = async () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const op = (name) => ERP_RECONCILIATION_OPERATIONS.find((o) => o.name === name);
const args = (name, params = {}, query = "", body) => reconciliationRpcArgs(op(name), params, new URLSearchParams(query), body, command);

test("contrato: pendências são leitura; conciliar e receber são sensíveis e do bot; o resto só pela tela", () => {
  for (const o of ERP_RECONCILIATION_OPERATIONS) {
    assert.ok(o.path.startsWith("erp-conciliacao/"), o.name);
    assert.ok(o.description.length > 30 && !/Fagoo|Origin/.test(o.description + o.summary), o.name);
    if (o.method === "GET") assert.equal(o.sensitive, false, o.name);
    else if (!o.read) assert.equal(o.sensitive, true, o.name);
  }
  const forBot = ERP_RECONCILIATION_OPERATIONS.filter((o) => o.bot !== false);
  assert.deepEqual(forBot.filter((o) => !o.sensitive).map((o) => o.name), ["erp.conciliacao.resumo", "erp.conciliacao.banco", "erp.conciliacao.cartao"]);
  assert.deepEqual(forBot.filter((o) => o.sensitive).map((o) => o.name), ["erp.conciliacao.banco.conciliar", "erp.conciliacao.cartao.receber"]);
  assert.ok(ERP_CONCILIACAO_MODULE_CONTRACT.definition.bot.sensitive.includes("erp.conciliacao.banco.conciliar"));
  assert.deepEqual(ERP_CONCILIACAO_MODULE_CONTRACT.routes, ["erp-conciliacao"]);
  assert.equal(erpReconciliationOperationFor("GET", `erp-conciliacao/banco/${UUID}`).params.conta, UUID);
  assert.equal(erpReconciliationOperationFor("POST", `erp-conciliacao/banco/linhas/${UUID}`).operation.name, "erp.conciliacao.banco.conciliar");
  assert.equal(erpReconciliationOperationFor("POST", `erp-conciliacao/banco/${UUID}/importar`).operation.name, "erp.conciliacao.banco.importar");
  assert.equal(erpReconciliationOperationFor("DELETE", "erp-conciliacao/resumo"), null);
  assert.deepEqual(erpReconciliationParams(op("erp.conciliacao.banco.conciliar")).required, ["id", "acao", "versao"]);
  // Toda recusa conhecida tem frase em português que diz o que fazer, sem "Não foi possível concluir a operação".
  for (const [code, [status, , message]] of Object.entries(RECONCILIATION_REASONS)) {
    assert.ok(status >= 400 && status < 600, code);
    assert.doesNotMatch(message, /Não foi possível concluir|Fagoo|Origin/, code);
  }
});

test("argumentos: português da rota para o motor, com recusa clara", async () => {
  assert.deepEqual(await args("erp.conciliacao.banco", { conta: UUID }, "situacao=ignoradas&de=2026-11-01"),
    { p_args: { account_id: UUID, state: "ignored", from: "2026-11-01", to: null, search: null } });
  await assert.rejects(args("erp.conciliacao.banco", { conta: UUID }, "situacao=abertas"), ReconciliationArgsError);
  await assert.rejects(args("erp.conciliacao.banco", { conta: UUID }, "outro=1"), /Parâmetro não aceito/);
  assert.deepEqual(await args("erp.conciliacao.banco.conciliar", { id: UUID }, "", { acao: "confirmar", versao: 2, vinculos: [{ tipo: "movimento", id: OTHER }] }),
    { p_command_id: await command(), p_args: { line_id: UUID, expected_version: 2, action: "confirm", links: [{ kind: "movement", id: OTHER }] } });
  assert.deepEqual((await args("erp.conciliacao.banco.conciliar", { id: UUID }, "", { acao: "baixar", versao: 1, contas: [{ id: OTHER, versao: 3, valor: "1500" }] })).p_args.titles,
    [{ id: OTHER, expected_version: 3, amount_cents: "1500" }]);
  await assert.rejects(args("erp.conciliacao.banco.conciliar", { id: UUID }, "", { acao: "ignorar", versao: 1 }), /motivo/);
  assert.equal((await args("erp.conciliacao.banco.conciliar", { id: UUID }, "", { acao: "desfazer", versao: 1, estornar: true })).p_args.reverse, true);
  assert.deepEqual((await args("erp.conciliacao.regra.salvar", {}, "", { texto: "tarifa", direcao: "saidas", categoria: OTHER })).p_args,
    { name: null, pattern: "tarifa", direction: "out", account_id: null, category_id: OTHER, contact_id: null, note: null });
  assert.deepEqual(mappingParam({ colunas: { data: "Data", credito: "Entrada" }, decimal: ",", formato_data: "dd/mm/aaaa" }, "bank"),
    { columns: { date: "Data", credit: "Entrada" }, decimal: ",", date_format: "dmy" });
  assert.throws(() => mappingParam({ colunas: { valorzinho: "X" } }, "bank"), /colunas/);
  assert.equal(rateParam("1,99"), 199);
  assert.equal(rateParam(2.5), 250);
  assert.throws(() => rateParam("abc"), /taxa/);
  const rate = (await args("erp.conciliacao.cartao.taxa", {}, "", { adquirente: "cielo", bandeira: "visa", modalidade: "credito", parcelas_de: 2, parcelas_ate: 6, taxa: "2,49", prazo: 30 })).p_args;
  assert.deepEqual(rate, { acquirer: "cielo", brand: "visa", product: "credit", installments_from: 2, installments_to: 6, rate_bp: 249, fixed_cents: "0", settle_days: 30 });
  assert.deepEqual((await args("erp.conciliacao.cartao", {}, "tipo=recebivel&situacao=abertas&divergentes=true")).p_args,
    { kind: "receivable", state: "open", from: null, to: null, search: null, divergent: true });
  assert.deepEqual((await args("erp.conciliacao.cartao.receber", {}, "", { linhas: [UUID], conta: OTHER, data: "2026-11-20" })).p_args,
    { line_ids: [UUID], account_id: OTHER, received_on: "2026-11-20", bank_line_id: null });
  assert.equal((await args("erp.conciliacao.cartao.lote", {}, "", { acao: "confirmar_sugestoes", confianca_minima: 90 })).p_args.min_confidence, 90);
  assert.equal((await args("erp.conciliacao.previa", {}, "", { alvo: "cartao", tipo: "recebiveis", conteudo: "a;b" })).p_args.kind, "receivables");
});

test("menu e destino: as duas telas no Financeiro, para Administrador, Financeiro e Consulta", () => {
  for (const [id, to, label] of [["erp.bank-reconciliation", "/conciliacao-bancaria", "Conciliação bancária"], ["erp.card-reconciliation", "/conciliacao-cartoes", "Conciliação de cartões"]]) {
    const item = ERP_MANAGEMENT_ITEMS.find((i) => i.id === id);
    assert.deepEqual([item.module, item.part, item.target.to, item.label, item.groupLabel], ["erp-financeiro", "financeiro", to, label, "Financeiro"]);
    assert.deepEqual([...item.permission.roles].sort(), ["admin", "consulta", "financeiro"]);
    const destination = erpDestinationRequirement(to);
    assert.equal(destination.owner, "erp-financeiro");
    assert.deepEqual([...destination.requirement.all].sort(), ["erp", "erp-financeiro"]);
  }
  const finance = ORIGIN_MENU.find((g) => g.name === "Financeiro").columns.flatMap((c) => c.items).map((i) => i.label);
  assert.ok(finance.includes("Conciliação bancária") && finance.includes("Conciliação de cartões"));
});

test("estrutura: a entrada conciliacao explica as tabelas da versão 30", () => {
  const entry = ERP_STRUCTURAL.find((s) => s.id === "conciliacao");
  assert.ok(entry);
  for (const t of ERP_ENGINE_TABLES.filter((x) => x.since === 30)) {
    assert.equal(t.structural, "conciliacao", t.table);
    assert.ok(entry.replaced_by.includes(t.table.replace("erp_reconciliation", "")), t.table);
  }
});
