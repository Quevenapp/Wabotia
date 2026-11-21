// Fatia C na tela: Passar a operar aqui (data de corte com conferência antes
// de confirmar, saldos, estoque de abertura e conferência final) e a lista de
// notas emitidas no Bling no Fiscal. Cliente simulado: nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountComponent } from "../../../web/erp/test/helpers/component-recovery-harness.mjs";
import { adoptionInputs, adoptionOutputs } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_CUTOVER_TEXTS } from "../../../src/erp/bling/cutover-contracts.ts";

const controller = { getSnapshot: () => ({ phase: "ready", membership: { user_id: "pessoa-teste", role: "admin", resources: [] } }), subscribe: () => () => {} };
const HASH = "a".repeat(64);
const steps = (stockOn = true) => [
  ["adoption", "Adotar o que falta", "Cadastros", true], ["partials", "Contas parciais, pagas e canceladas", "Financeiro", true], ["balances", "Saldos de abertura", "Financeiro", true],
  ["stock", "Estoque de abertura", "Estoque", stockOn], ["invoices", "Notas emitidas no Bling", "Fiscal", true], ["package", "Pacote do contador", "Fiscal", true], ["report", "Conferência final", "Cadastros", true],
].map(([key, label, module_name, enabled]) => ({ key, label, module_name, enabled, part_off_message: enabled ? null : "Para gravar o estoque de abertura, ligue o módulo Estoque em Gestão → Módulos.", done: false, summary: "A fazer." }));

function service({ confirmed = false, stockOn = true } = {}) {
  const calls = [];
  let state = confirmed ? "confirmed" : "none";
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input: structuredClone(input) });
    const receipt = { command_id: input.command_id ?? "x", operation: name, replayed: false };
    const cutover = { state, cutover_on: state === "none" ? null : "2026-11-15", confirmed_at: state === "none" ? null : "2026-11-20T15:00:00.000Z", concluded_at: null, revision: state === "none" ? "0" : "1", can_change_date: true };
    let value;
    if (name === "erp_bling_cutover_status") value = { cutover, proposed_on: input.cutover_on ?? cutover.cutover_on, today: "2026-11-20",
      missing: [{ entity: "contacts", label: "Contatos", enabled: true, part_off_message: null, waiting: 2, pending: 1, ignored: 0 }], steps: steps(stockOn),
      checks: [{ key: "archive", label: "Acervo do Bling disponível", ok: true, message: "Conta vinculada." }, { key: "date", label: "Data de corte escolhida", ok: !!(input.cutover_on ?? cutover.cutover_on), message: "Escolha a data." },
        { key: "job", label: "Lote de adoção parado", ok: true, message: "Nenhum lote." }, { key: "pending", label: "Pendências de revisão decididas", ok: false, message: "1 pendência(s) de revisão." }],
      conflicts: 0, texts: { ...BLING_CUTOVER_TEXTS } };
    else if (name === "erp_bling_cutover_confirm") { state = "confirmed"; value = { cutover: { ...cutover, state: "confirmed", cutover_on: input.cutover_on, confirmed_at: "2026-11-20T15:00:00.000Z", revision: "1" }, receipt }; }
    else if (name === "erp_bling_cutover_balances") value = { cutover_on: "2026-11-15", items: [{ source_id: "700", record_id: "0b8f9d8e-1111-4222-8333-444455556666", name: "Caixa da loja",
      computed_cents: "10025", computed_entries: 2, computed_note: "Somados 2 lançamento(s) de caixa coletados até a data de corte.", erp_cents_at_cutover: "0", state: "waiting",
      posted_cents: null, entry_cents: null, posted_on: null, posted_at: null }] };
    else if (name === "erp_bling_cutover_balance_post") value = { item: { source_id: "700", record_id: "0b8f9d8e-1111-4222-8333-444455556666", name: "Caixa da loja", computed_cents: "10025",
      computed_entries: 2, computed_note: "ok", erp_cents_at_cutover: "123456", state: "posted", posted_cents: input.confirmed_cents, entry_cents: input.confirmed_cents, posted_on: "2026-11-20", posted_at: "2026-11-20T15:00:00.000Z" }, receipt };
    else if (name === "erp_bling_cutover_stock") value = { cutover_on: "2026-11-15", negative_allowed: false, lines: null, warehouses: [{ source_id: "400", record_id: "0b8f9d8e-1111-4222-8333-999955556666",
      name: "Loja", products: 3, ready: 1, without_product: 1, negatives: 1, differences: 0, unsupported: 0, valued_cents: "10625", state: "waiting", posted_lines: 0, preview_hash: HASH, movements: [] }] };
    else if (name === "erp_bling_cutover_stock_post") value = { warehouse: { source_id: "400", record_id: "0b8f9d8e-1111-4222-8333-999955556666", name: "Loja", products: 3, ready: 1, without_product: 1,
      negatives: 1, differences: 0, unsupported: 0, valued_cents: "10625", state: "posted", posted_lines: 1, preview_hash: HASH, movements: ["m1"] }, posted_lines: 1, remaining: 0, movement_id: "m1", receipt };
    else if (name === "erp_bling_cutover_report") value = { cutover, entities: [{ key: "contacts", label: "Contatos", bling: 3, adopted: 2, history: 0, pending: 1, ignored: 0, waiting: 0 }],
      money: [{ key: "receivables", label: "A receber", bling_cents: "14000", erp_cents: "10000", difference_cents: "-4000", explanation: "Parcial ainda não adotada." }],
      differences: [{ key: "saldo", kind: "saldo", label: "Contas financeiras sem saldo de abertura gravado", count: 1, cents: null, explanation: "Grave ou justifique.", justified: calls.some(c => c.name === "erp_bling_cutover_justify"),
        justification: null, items: [{ key: "saldo:700", label: "Caixa da loja", detail: null, justified: false }] }], blocking: 1, can_conclude: false };
    else if (name === "erp_bling_cutover_justify") value = { key: input.key, receipt };
    else throw new Error("operação inesperada " + name);
    return adoptionOutputs[name].parse(value);
  } };
  return { client, calls };
}

test("data de corte: conferência antes de confirmar, o que falta adotar, e só confirma com a data conferida e o aceite", async () => {
  const server = service();
  const view = await mountComponent("CutoverBling.tsx", { client: server.client, controller, administrator: true }, { componentName: "CutoverBling", expandChildren: true });
  try {
    const text = view.text();
    assert.match(text, /Nenhuma etapa do corte roda sem ela/);
    assert.match(text, /O que falta adotar/); assert.match(text, /Contatos/);
    assert.match(text, /Conferência antes de confirmar/);
    assert.equal(view.button("Confirmar data de corte").disabled, true);
    await view.change("bling-cutover-date", "2026-11-15");
    await view.submit();
    assert.deepEqual(server.calls.filter(c => c.name === "erp_bling_cutover_status").at(-1).input, { cutover_on: "2026-11-15" });
    assert.equal(view.button("Confirmar data de corte").disabled, true, "sem o aceite");
    await view.change("bling-cutover-ack", true);
    await view.click("Confirmar data de corte");
    const confirm = server.calls.find(c => c.name === "erp_bling_cutover_confirm");
    assert.deepEqual([confirm.input.cutover_on, confirm.input.acknowledged], ["2026-11-15", true]);
    assert.match(view.text(), /Data de corte confirmada: 15\/11\/2026/);
    assert.doesNotMatch(view.text(), /Fagoo|Origin/);
  } finally { view.unmount(); }
});

test("saldos e estoque: valor confirmado ou corrigido pela pessoa; estoque diz que não recria movimentos, lotes nem reservas", async () => {
  const server = service({ confirmed: true });
  const view = await mountComponent("CutoverBling.tsx", { client: server.client, controller, administrator: true }, { componentName: "CutoverBling", expandChildren: true });
  try {
    await view.click("Atualizar saldos");
    assert.match(view.text(), /Somados 2 lançamento/);
    assert.equal(view.input("bling-balance-700").props.value, "100,25");
    await view.change("bling-balance-700", "1.234,56");
    await view.click("Confirmar e gravar saldo de Caixa da loja");
    const post = server.calls.find(c => c.name === "erp_bling_cutover_balance_post");
    assert.deepEqual([post.input.source_id, post.input.confirmed_cents, post.input.computed_cents], ["700", "123456", "10025"]);
    assert.match(view.text(), /Saldo de abertura de Caixa da loja gravado/);
    assert.match(view.text(), /Movimentos antigos, lotes e reservas do Bling não são recriados/);
    await view.click("Atualizar prévia");
    assert.match(view.text(), /Sem cadastro adotado/);
    assert.match(view.text(), /não aceita estoque negativo/);
    await view.click("Gravar estoque de abertura de Loja");
    const stock = server.calls.find(c => c.name === "erp_bling_cutover_stock_post");
    assert.deepEqual([stock.input.warehouse, stock.input.preview_hash], ["400", HASH]);
    assert.match(view.text(), /Estoque de abertura de Loja gravado: 1 produto/);
  } finally { view.unmount(); }
});

test("conferência final: diferenças com explicação; justificar registra; concluir só sem pendência", async () => {
  const server = service({ confirmed: true });
  const view = await mountComponent("CutoverBling.tsx", { client: server.client, controller, administrator: true }, { componentName: "CutoverBling", expandChildren: true });
  try {
    await view.click("Atualizar conferência");
    assert.match(view.text(), /Contas financeiras sem saldo de abertura gravado/);
    assert.match(view.text(), /1 sem justificativa/);
    assert.equal(view.button("Concluir o corte").disabled, true);
    await view.change("bling-why-saldo", "Conta sem movimento no Bling.");
    await view.click("Registrar justificativa");
    const justify = server.calls.find(c => c.name === "erp_bling_cutover_justify");
    assert.deepEqual([justify.input.key, justify.input.text], ["saldo", "Conta sem movimento no Bling."]);
  } finally { view.unmount(); }
});

test("estoque com a parte desligada: diz qual módulo ligar e não deixa pedir a prévia", async () => {
  const server = service({ confirmed: true, stockOn: false });
  const view = await mountComponent("CutoverBling.tsx", { client: server.client, controller, administrator: true }, { componentName: "CutoverBling", expandChildren: true });
  try {
    assert.match(view.text(), /ligue o módulo Estoque em Gestão → Módulos/);
    assert.equal(view.button("Atualizar prévia").disabled, true);
  } finally { view.unmount(); }
});

test("Fiscal → Notas emitidas no Bling: lista por chave, abre o resumo e diz que é só consulta, sem ações de nota", async () => {
  const calls = [];
  const item = { entity: "nfe", source_id: "8001", number: "123", series: "1", access_key: "35261011222333000181550010000001231000001234", issued_on: "2026-10-05",
    contact_name: "Ana Souza", contact_document: "529.982.247-25", total_cents: "15090", situation: "Autorizada", direction: "Saída", has_xml: false };
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input });
    if (name === "erp_bling_cutover_invoices") return adoptionOutputs[name].parse({ items: [item], next_cursor: null, read_only_message: BLING_CUTOVER_TEXTS.invoices });
    if (name === "erp_bling_cutover_invoice_get") return adoptionOutputs[name].parse({ item, read_only_message: BLING_CUTOVER_TEXTS.invoices, fields: { "Chave de acesso": item.access_key, "Situação no Bling": "Autorizada" },
      xml: { available: false, text: null, sha256: null, filename: null, note: "O XML desta nota não foi coletado do Bling. Peça a coleta de XML em Configuração." } });
    throw new Error("operação inesperada " + name);
  } };
  const view = await mountComponent("BlingInvoices.tsx", { client, controller, administrator: true }, { componentName: "BlingInvoices", expandChildren: true });
  try {
    assert.match(view.text(), /não podem ser canceladas nem corrigidas por aqui/);
    await view.change("bling-invoices-q", item.access_key);
    await view.submit();
    assert.deepEqual(calls.filter(c => c.name === "erp_bling_cutover_invoices").at(-1).input, { limit: 20, q: item.access_key });
    await view.click("Abrir NF-e 123");
    assert.match(view.text(), /emitida no Bling \(só consulta\)/);
    assert.match(view.text(), /Peça a coleta de XML/);
    for (const label of ["Cancelar", "Corrigir", "Carta de correção", "Emitir", "Transmitir"]) assert.ok(!view.nodes().some(node => node.type === "button" && String(node.props.children).startsWith(label)), label);
    assert.doesNotMatch(view.text(), /Fagoo|Origin/);
  } finally { view.unmount(); }
});
