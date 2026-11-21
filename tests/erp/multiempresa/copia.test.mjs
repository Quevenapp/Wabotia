// Multiempresa (Wabotia, sem função no oráculo): copiar cadastros entre duas
// empresas (dois ERPs) pelas funções de domínio de cada uma — exportar de uma,
// importar na outra pela importação existente —, com prévia e sem duplicar
// (produto pelo código, contato pelo CPF/CNPJ, os demais pelo nome); e o
// resumo de cada empresa para o consolidado. Sem rede: dois motores SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { applyCopy, compactKey, copyKindsOf, fold, importReasonText, planCopy, readSnapshot, stableUuid, summaryOf, totalOf } from "../../../src/erp/multiempresa/service.ts";
import { COPY_KINDS, ERP_COMPANY_OPERATIONS, erpCompanyOperationFor, erpCompanyParams } from "../../../src/erp/multiempresa/contract.ts";

const port = (f) => async (rpc, args = {}) => f.rpc(rpc, args);
const count = (f, sql, ...args) => Number(f.db.exec(sql, ...args).rows[0].n);
const cmd = () => randomUUID();

function companies(t) {
  const a = com1Fixture(t);
  const b = com1Fixture(t, { company: { cnpj: "19131243000197", trade_name: "Filial do Ensaio", legal_name: "Filial do Ensaio Ltda." },
    customer: { name: "Cliente só da filial", document: "11444777000161" } });
  // Origem: categorias em dois níveis, um produto novo, um que a filial já tem, um sem código.
  const bebidas = a.rpc("erp_catalog_taxonomy_save", { p_kind: "categories", p_id: null, p_expected_version: 0, p_command_id: cmd(), p_data: { name: "Bebidas" } }).item;
  const sucos = a.rpc("erp_catalog_taxonomy_save", { p_kind: "categories", p_id: null, p_expected_version: 0, p_command_id: cmd(), p_data: { name: "Sucos", parent_id: bebidas.id } }).item;
  const product = (f, data) => f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_acknowledged: null,
    p_data: { unit: "UN", kind: "P", format: "S", ...data } }).record;
  const suco = product(a, { name: "Suco de uva 1 L", code: "SU-1", price: "9.90", category_id: sucos.id, ncm: "20096100" });
  product(a, { name: "Água 500 ml", code: "AG-1", price: "2.50" });
  product(b, { name: "Água mineral (nome da filial)", code: "ag-1", price: "3.00" });
  // Lista de preços com o preço do suco; uma lista ligada a clientes não vai.
  a.rpc("erp_pricing_list_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_data: { name: "Atacado", category: "other", list_type: "custom",
    factor: null, factor_unit: "percent", direction: "discount", considers_datetime: false, contacts: [], regions: [], add_products: [suco.id] } });
  const atacado = a.rpc("erp_pricing_lists", {}).items.find((l) => l.name === "Atacado");
  a.rpc("erp_pricing_list_import", { p_id: atacado.id, p_expected_version: atacado.version, p_command_id: cmd(), p_rows: [{ code: "SU-1", price: "8.50" }] });
  a.rpc("erp_pricing_list_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_data: { name: "Clientes VIP", category: "contact", list_type: "rates",
    factor: "5", factor_unit: "percent", direction: "discount", considers_datetime: false, contacts: [a.customer.id], regions: [] } });
  // Contatos: um novo, o da filial já existe com outra máscara.
  a.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_acknowledged: null,
    p_data: { name: "Fornecedor de frutas", person_type: "J", document: "11.444.777/0001-61", roles: ["supplier"] } });
  a.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_acknowledged: null,
    p_data: { name: "Mercado da esquina", person_type: "J", document: "45.723.174/0001-10", roles: ["customer"] } });
  // Forma de pagamento, categorias financeiras e uma natureza a mais.
  a.rpc("erp_catalog_payment_method_save", { p_id: null, p_expected_version: 0, p_command_id: cmd(), p_data: { description: "Pix da loja", payment_type: "17",
    condition: null, destination: "contas", account_id: null, business_days: false, applicable: "ambos", interest_rate: null, fine_rate: null, card_brand: null,
    card_integration: null, card_cnpj: null, auto_settle: false, pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null } });
  const vendas = a.rpc("erp_finance_category_execute", { p_command_id: cmd(), p_action: "category_create", p_data: { kind: "receivable", parent_id: null, name: "Vendas" } }).record;
  a.rpc("erp_finance_category_execute", { p_command_id: cmd(), p_action: "category_create", p_data: { kind: "receivable", parent_id: vendas.id, name: "Balcão" } });
  a.rpc("erp_finance_category_execute", { p_command_id: cmd(), p_action: "category_create", p_data: { kind: "payable", parent_id: null, name: "Aluguel" } });
  a.rpc("erp_fiscal_nature_execute", { p_command_id: cmd(), p_action: "create", p_data: { nature: { description: "Devolução de compra", direction: "1", crt: "1",
    presence: "1", final_consumer: false, rules: [{ tax: "icms", data: { situation: "900", cfop: "5202" } }] } } });
  return { a, b };
}

test("contrato: rotas, bots e chaves de comparação", () => {
  assert.deepEqual(ERP_COMPANY_OPERATIONS.map((op) => op.name), ["erp.empresas.listar", "erp.empresas.consolidado", "erp.empresas.copiar_previa", "erp.empresas.copiar", "erp.empresas.nova"]);
  assert.equal(erpCompanyOperationFor("GET", "erp-empresas/consolidado/")?.name, "erp.empresas.consolidado");
  assert.equal(erpCompanyOperationFor("POST", "erp-empresas/consolidado"), null);
  // Bots: consultar o consolidado é leitura comum; copiar é sensível; criar empresa é só pela tela.
  assert.equal(erpCompanyOperationFor("GET", "erp-empresas/consolidado").sensitive, false);
  assert.equal(erpCompanyOperationFor("POST", "erp-empresas/copiar").sensitive, true);
  assert.equal(erpCompanyOperationFor("POST", "erp-empresas/nova").bot, false);
  assert.deepEqual(erpCompanyParams(erpCompanyOperationFor("POST", "erp-empresas/copiar")).required, ["origem", "cadastros"]);
  assert.equal(compactKey("11.444.777/0001-61"), "11444777000161");
  assert.equal(compactKey(" ag-1 "), "ag1");
  assert.equal(fold("  Água   Mineral "), "agua mineral");
  assert.deepEqual(copyKindsOf("produtos, contatos,produtos"), ["produtos", "contatos"]);
  assert.throws(() => copyKindsOf("produtos,estoque"), /Escolha o que copiar/);
  assert.throws(() => copyKindsOf([]), /Escolha o que copiar/);
  assert.match(importReasonText("erp_preferences_import_ambiguous:category"), /mais de um cadastro com a categoria/);
  assert.match(importReasonText("qualquer"), /Confira os dados/);
});

test("prévia: o que é novo, o que já existe e o que não vai, sem gravar nada", async (t) => {
  const { a, b } = companies(t);
  const kinds = [...COPY_KINDS];
  const before = count(b, 'SELECT count(*) n FROM "erp_catalog__record"');
  const source = await readSnapshot(port(a), kinds, true);
  const target = await readSnapshot(port(b), kinds, false);
  const plan = planCopy(kinds, source, target);
  const by = Object.fromEntries(plan.kinds.map((k) => [k.cadastro, k]));
  assert.deepEqual(plan.kinds.map((k) => k.cadastro), ["formas_pagamento", "categorias_financeiras", "naturezas", "produtos", "contatos"]);
  // Produtos: o suco é novo; a água já existe (código igual, sem diferenciar maiúsculas); o do ensaio não tem código.
  assert.equal(by.produtos.novos, 1);
  assert.deepEqual(by.produtos.amostra, ["SU-1 · Suco de uva 1 L"]);
  assert.equal(by.produtos.existentes, 1);
  assert.ok(by.produtos.ignorados.some((s) => s.nome === "Mercadoria do Ensaio" && /sem código/.test(s.motivo)));
  assert.ok(by.produtos.ignorados.some((s) => s.nome === "Lista de preços Clientes VIP" && /clientes/.test(s.motivo)));
  assert.equal(by.produtos.categorias_novas, 2);
  assert.equal(by.produtos.listas_novas, 1);
  // Contatos: o cliente do ensaio é novo na filial; o fornecedor já existe (mesmo CNPJ com máscara).
  assert.equal(by.contatos.existentes, 1);
  assert.deepEqual(by.contatos.amostra.sort(), ["Cliente do Ensaio", "Mercado da esquina"]);
  assert.equal(by.formas_pagamento.novos, 1);
  assert.ok(by.formas_pagamento.avisos.some((x) => /conta bancária/.test(x)));
  assert.deepEqual(by.categorias_financeiras.amostra, ["Receitas › Vendas", "Despesas › Aluguel", "Receitas › Vendas › Balcão"]);
  // Naturezas: a venda nacional existe nas duas; a devolução é nova.
  assert.equal(by.naturezas.existentes, 1);
  assert.deepEqual(by.naturezas.amostra, ["Devolução de compra"]);
  assert.equal(count(b, 'SELECT count(*) n FROM "erp_catalog__record"'), before, "a prévia não grava");
});

test("cópia: grava só o que falta, com categoria e lista de preços, e repetir não duplica", async (t) => {
  const { a, b } = companies(t);
  const kinds = [...COPY_KINDS];
  const run = async (command) => {
    const plan = planCopy(kinds, await readSnapshot(port(a), kinds, true), await readSnapshot(port(b), kinds, false));
    return { plan, results: await applyCopy(port(b), plan, command, "Cópia de Ensaio Comercial") };
  };
  const first = await run(randomUUID());
  const by = Object.fromEntries(first.results.map((r) => [r.cadastro, r]));
  assert.deepEqual(by.produtos.recusados, []);
  assert.equal(by.produtos.criados, 1);
  assert.equal(by.produtos.categorias_criadas, 2);
  assert.equal(by.produtos.listas_criadas, 1);
  assert.equal(by.contatos.criados, 2, JSON.stringify(by.contatos));
  assert.equal(by.formas_pagamento.criados, 1, JSON.stringify(by.formas_pagamento));
  assert.equal(by.categorias_financeiras.criados, 3, JSON.stringify(by.categorias_financeiras));
  assert.equal(by.naturezas.criados, 1, JSON.stringify(by.naturezas));
  // O suco chegou na categoria Sucos (filha de Bebidas) e com o preço da lista.
  const suco = b.rpc("erp_catalog_product_export_v2", { p_limit: 50 }).items.find((p) => p.code === "SU-1");
  assert.equal(suco.category, "Sucos");
  const tree = b.rpc("erp_catalog_taxonomy_list", { p_kind: "categories" }).items;
  assert.equal(tree.find((c) => c.id === suco.category_id).parent_id, tree.find((c) => c.name === "Bebidas").id);
  const list = b.rpc("erp_pricing_lists", {}).items.find((l) => l.name === "Atacado");
  const items = b.rpc("erp_pricing_list_get", { p_id: list.id }).items;
  assert.deepEqual(items.map((i) => [i.code, Number(i.custom_price)]), [["SU-1", 8.5]]);
  assert.equal(b.rpc("erp_pricing_lists", {}).items.some((l) => l.name === "Clientes VIP"), false);
  // A água da filial ficou como estava (nome e preço da filial).
  const agua = b.rpc("erp_catalog_product_export_v2", { p_limit: 50 }).items.filter((p) => compactKey(p.code) === "ag1");
  assert.equal(agua.length, 1);
  assert.equal(agua[0].name, "Água mineral (nome da filial)");
  // Forma de pagamento sem a conta da outra empresa.
  const pix = b.rpc("erp_catalog_payment_method_page", {}).items.find((m) => m.description === "Pix da loja");
  assert.equal(pix.account_id, null);
  const natures = b.rpc("erp_fiscal_nature_list", {}).items.map((n) => n.description).sort();
  assert.deepEqual(natures, ["Devolução de compra", "Venda nacional de mercadorias"]);
  // De novo (outro pedido): nada novo, nada duplicado.
  const counts = () => [count(b, 'SELECT count(*) n FROM "erp_catalog__record"'), count(b, 'SELECT count(*) n FROM "erp_finance__category"'),
    count(b, 'SELECT count(*) n FROM "erp_catalog__payment_method"'), count(b, 'SELECT count(*) n FROM "erp_pricing__price_list"')];
  const after = counts();
  const second = await run(randomUUID());
  assert.ok(second.plan.kinds.every((k) => k.novos === 0), JSON.stringify(second.plan.kinds.map((k) => [k.cadastro, k.novos])));
  assert.ok(second.results.every((r) => r.criados === 0 && r.recusados.length === 0));
  assert.deepEqual(counts(), after);
});

test("cópia repetida com o mesmo pedido: os comandos se repetem sem duplicar", async (t) => {
  const { a, b } = companies(t);
  const kinds = ["formas_pagamento", "produtos"];
  const command = randomUUID();
  const plan = planCopy(kinds, await readSnapshot(port(a), kinds, true), await readSnapshot(port(b), kinds, false));
  await applyCopy(port(b), plan, command, "Cópia");
  const after = count(b, 'SELECT count(*) n FROM "erp_catalog__record"');
  // O mesmo plano de novo (como numa repetição depois de cair a conexão): os recibos devolvem o resultado gravado.
  const again = await applyCopy(port(b), plan, command, "Cópia");
  assert.equal(count(b, 'SELECT count(*) n FROM "erp_catalog__record"'), after);
  assert.ok(again.every((r) => r.recusados.length === 0), JSON.stringify(again));
  assert.equal(await stableUuid("x", "y"), await stableUuid("x", "y"));
  assert.notEqual(await stableUuid("x", "y"), await stableUuid("x", "z"));
});

test("cópia de quem não é administrador no destino: a importação recusa e a cópia diz o que houve", async (t) => {
  const { a, b } = companies(t);
  const kinds = ["contatos"];
  const plan = planCopy(kinds, await readSnapshot(port(a), kinds, true), await readSnapshot(port(b), kinds, false));
  const seller = async (rpc, args = {}) => b.rpc(rpc, args, { role: "vendas" });
  const [result] = await applyCopy(seller, plan, randomUUID(), "Cópia");
  assert.equal(result.criados, 0);
  assert.equal(result.recusados.length, 2);
  assert.ok(result.recusados.every((r) => /Só o administrador do ERP/.test(r.motivo)), JSON.stringify(result.recusados));
});

test("consolidado: o resumo de cada ERP e a soma lado a lado", async (t) => {
  const { a } = companies(t);
  const overview = a.rpc("erp_home_overview", { p_period: "12m" });
  const summary = summaryOf(overview);
  assert.ok(summary.vendas && typeof summary.vendas.total_centavos === "string");
  assert.ok(summary.receber && summary.pagar);
  assert.equal(typeof summary.saldo_contas_centavos, "string");
  // Papel de vendas não vê o financeiro: a empresa mostra só as vendas.
  const sales = summaryOf(a.rpc("erp_home_overview", { p_period: "12m" }, { role: "vendas" }));
  assert.equal(sales.receber, null);
  assert.equal(sales.saldo_contas_centavos, null);
  const synthetic = (v, r, p, s) => ({ vendas: { pedidos: 1, total_centavos: v }, receber: { aberto_centavos: r, vencido_centavos: "100", contas: 1 },
    pagar: { aberto_centavos: p, vencido_centavos: "0", contas: 1 }, saldo_contas_centavos: s, partes_desligadas: [] });
  const total = totalOf([synthetic("1000", "500", "300", "-200"), synthetic("99999999999999999", "1", "2", "3")]);
  assert.equal(total.vendas_centavos, "100000000000000999");
  assert.equal(total.receber_centavos, "501");
  assert.equal(total.receber_vencido_centavos, "200");
  assert.equal(total.saldo_contas_centavos, "-197");
  assert.equal(total.incompleto, false);
  assert.equal(totalOf([synthetic("1", "1", "1", "1"), null]).incompleto, true);
});
