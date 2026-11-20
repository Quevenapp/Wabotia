// Fatia B2 na tela: documentos e contas na mesma tabela da adoção, pendência
// com o cadastro que falta e o atalho, e o Histórico do Bling só para
// consulta. Cliente simulado: nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountComponent } from "../../../web/erp/test/helpers/component-recovery-harness.mjs";
import {
  adoptionInputs, adoptionOutputs, BLING_ADOPTION_ENTITIES, BLING_ADOPTION_LABELS, BLING_ADOPTION_REASONS, BLING_HISTORY_READONLY, BLING_HISTORY_SCOPES, isAdoptionB2,
} from "../../../src/erp/bling/adoption-contracts.ts";

const controller = { getSnapshot: () => ({ phase: "ready", membership: { user_id: "pessoa-teste", role: "admin", resources: [] } }), subscribe: () => () => {} };
const offSales = new Set(["sales_proposals", "sales_orders"]);
const entities = BLING_ADOPTION_ENTITIES.map(entity => ({
  entity, label: BLING_ADOPTION_LABELS[entity], module: offSales.has(entity) ? "erp-vendas" : "erp", module_name: offSales.has(entity) ? "Vendas" : "Cadastros",
  enabled: !offSales.has(entity), part_off_message: offSales.has(entity) ? `Para adotar ${BLING_ADOPTION_LABELS[entity].toLowerCase()}, ligue o módulo Vendas em Gestão → Módulos.` : null,
  updatable: false, collected: entity === "receivables" ? 4 : entity === "purchase_orders" ? 2 : 0, waiting: 0,
  adopted: entity === "receivables" ? 1 : 0, pending: entity === "purchase_orders" ? 1 : 0, ignored: 0,
  ...(isAdoptionB2(entity) ? { history: entity === "receivables" ? 3 : 0, outside: entity === "receivables"
    ? [{ scope: "paid", label: BLING_HISTORY_SCOPES.paid, count: 2, total_cents: "15000" }, { scope: "partial", label: BLING_HISTORY_SCOPES.partial, count: 1, total_cents: "10000" }] : [] } : {}),
}));
const idle = { state: "idle", entities: [], current: null, counts: { processed: 0, adopted: 0, linked: 0, pending: 0, skipped: 0 }, revision: "0", started_at: null, updated_at: null, finished_at: null, stop: null };
const review = { entity: "purchase_orders", source_id: "7001", state: "pending", reason: "missing_records", reason_text: BLING_ADOPTION_REASONS.missing_records,
  detail: "Falta adotar: contato \"Distribuidora Sul\" (id 101).", source_version: "1",
  bling: { "Nome": "pedido de compra nº 7", "Contato": "Distribuidora Sul", "Total": "R$ 50,00", "Situação": "Em aberto" }, erp: [],
  missing: [{ entity: "contacts", source_id: "101", label: "Distribuidora Sul", state: "waiting" }] };
const historyItem = { entity: "receivables", source_id: "6003", number: "NF 88", contact_name: "Ana Souza", issued_on: "2026-10-01", situation: "Pago",
  scope: "paid", scope_text: BLING_HISTORY_SCOPES.paid, total_cents: "8000", source_version: "1" };

function service() {
  const calls = [];
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input: structuredClone(input) });
    const receipt = { command_id: input.command_id ?? "x", operation: name, replayed: false };
    let value;
    if (name === "erp_bling_adoption_status") value = { available: true, unavailable_message: null, job: idle, entities };
    else if (name === "erp_bling_adoption_reviews") value = { items: calls.some(c => c.name === "erp_bling_adoption_resolve") ? [] : [review], next_cursor: null };
    else if (name === "erp_bling_adoption_adopt_one") value = { outcome: "adopted", record_id: "0b8f9d8e-1111-4222-8333-444455556666", message: "Adotado: criado no ERP a partir do Bling.", receipt };
    else if (name === "erp_bling_adoption_resolve") value = { outcome: "adopted", record_id: "0b8f9d8e-1111-4222-8333-777755556666", receipt };
    else if (name === "erp_bling_adoption_history") value = { items: [historyItem], next_cursor: null };
    else if (name === "erp_bling_adoption_history_get") value = { item: historyItem, read_only_message: BLING_HISTORY_READONLY, fields: { "Nome": "Venda balcão", "Situação": "Pago" },
      lines: [], installments: [], payload_text: "{\"id\":6003,\"situacao\":2}" };
    else throw new Error("operação inesperada " + name);
    return adoptionOutputs[name].parse(value);
  } };
  return { client, calls };
}

test("adoção: documentos e contas na mesma tabela, com o histórico, o que ficou de fora e o módulo a ligar", async () => {
  const server = service();
  const view = await mountComponent("AdoptBling.tsx", { client: server.client, controller, administrator: true, onHistory: () => {} }, { componentName: "AdoptBling", expandChildren: true });
  try {
    const text = view.text();
    for (const label of ["Propostas comerciais", "Pedidos de venda", "Pedidos de compra", "Contas a receber", "Contas a pagar"]) assert.match(text, new RegExp(label));
    assert.match(text, /No histórico \(só consulta\)/);
    assert.match(text, /Já encerrado no Bling \(só consulta\)/);
    assert.match(text, /em aberto no Bling/i);
    assert.match(text, /ligue o módulo Vendas em Gestão → Módulos/);
    assert.match(text, /R\$\s?150,00: Já pago ou recebido no Bling/);
    assert.match(text, /baixa parcial/);
    assert.equal(view.input("adopt-sales_orders").disabled, true);
    assert.equal(view.input("adopt-purchase_orders").disabled, false);
    assert.doesNotMatch(text, /Fagoo|Origin|Não foi possível concluir a operação/);
  } finally { view.unmount(); }
});

test("pendência de documento diz o cadastro que falta; o atalho adota o contato e tentar de novo adota o pedido", async () => {
  const server = service();
  const view = await mountComponent("AdoptBling.tsx", { client: server.client, controller, administrator: true }, { componentName: "AdoptBling", expandChildren: true });
  try {
    await view.click(`Ver pendências de ${BLING_ADOPTION_LABELS.purchase_orders}`);
    assert.match(view.text(), /Falta contato "Distribuidora Sul" \(ID no Bling 101\)/);
    await view.click("Adotar agora contato Distribuidora Sul");
    const one = server.calls.find(call => call.name === "erp_bling_adoption_adopt_one");
    assert.deepEqual([one.input.entity, one.input.source_id], ["contacts", "101"]);
    assert.match(view.text(), /Tentar adotar de novo/);
    await view.click("Tentar adotar de novo");
    const resolve = server.calls.find(call => call.name === "erp_bling_adoption_resolve");
    assert.deepEqual([resolve.input.entity, resolve.input.source_id, resolve.input.action], ["purchase_orders", "7001", "use_bling"]);
    assert.match(view.text(), /sem baixar estoque, gerar contas ou emitir nota/);
  } finally { view.unmount(); }
});

test("histórico do Bling: busca por número, contato e período; abrir mostra como veio e diz que é só consulta", async () => {
  const server = service();
  const view = await mountComponent("HistoryBling.tsx", { client: server.client, controller, administrator: true, entity: "receivables" }, { componentName: "HistoryBling", expandChildren: true });
  try {
    assert.match(view.text(), /não podem ser faturados, cancelados nem editados/);
    await view.change("bling-history-q", "Ana");
    await view.change("bling-history-from", "2026-09-01");
    await view.change("bling-history-to", "2026-10-31");
    await view.submit();
    const search = server.calls.find(call => call.name === "erp_bling_adoption_history");
    assert.deepEqual(search.input, { entity: "receivables", limit: 20, q: "Ana", from: "2026-09-01", to: "2026-10-31" });
    assert.match(view.text(), /Já pago ou recebido no Bling/);
    await view.click("Abrir conta a receber NF 88");
    const text = view.text();
    assert.match(text, /já encerrado no Bling \(só consulta\)/);
    assert.match(text, /não pode ser faturado, cancelado nem editado/);
    assert.match(text, /Registro como veio do Bling/);
    // Espelho: nenhuma ação de operar o documento.
    for (const label of ["Faturar", "Cancelar", "Editar", "Baixar", "Emitir"]) assert.ok(!view.nodes().some(node => node.type === "button" && new RegExp(`^${label}`).test(String(node.props.children))), label);
    assert.doesNotMatch(text, /Fagoo|Origin/);
  } finally { view.unmount(); }
});

test("histórico com a parte desligada avisa qual módulo ligar e não busca", async () => {
  const server = service();
  const view = await mountComponent("HistoryBling.tsx", { client: server.client, controller, administrator: true, entity: "sales_orders" }, { componentName: "HistoryBling", expandChildren: true });
  try {
    assert.match(view.text(), /ligue o módulo Vendas em Gestão → Módulos/);
    assert.equal(view.button("Buscar no histórico").disabled, true);
  } finally { view.unmount(); }
});
