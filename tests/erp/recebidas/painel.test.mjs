// Tela Compras › Notas recebidas (web/erp/NotasRecebidas.tsx) no harness do
// painel: componentes e handlers reais, porta simulada, nenhuma rede. Prova o
// que a pessoa vê com as partes ligadas e desligadas, a busca em produção só
// com a autorização marcada, a conferência e a entrada com o mesmo comando ao
// repetir, e a manifestação desligada.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port, location = "/notas-recebidas-compras") =>
  mountComponent("../../NotasRecebidas.tsx", { port }, { expandChildren: true, location, modules });

const NOTE_ID = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
const note = (changes = {}) => ({
  id: NOTE_ID, source: "manual", environment: "homologacao", access_key: "35261144555666000181550010000001011876543213", role: "destinatario",
  emitter: { document: "44555666000181", name: "Fornecedor Sintetico Ltda" }, supplier: { id: "s1", name: "Fornecedor Sintetico Ltda", code: null },
  series: 1, number: 101, issued_on: "2026-11-18", total_cents: 31200, situation: "autorizada", nature: "Venda", purpose: "compra",
  purpose_label: "Compra de mercadoria", xml: { key: "k", sha256: "a".repeat(64), size: 10 }, vault: null, entry: null, last_entry: null, ...changes,
});
const access = (changes = {}) => ({ ready: true, role: "admin", admin: true, demo: false, parts: { purchases: true, stock: true, finance: true, fiscal: true, ...changes } });
const page = (items = [note()]) => ({ items, total: items.length, page: 1, per_page: 50, settings: { version: 0, manifest_enabled: false }, fetches: [], company_document: "11222333000181" });
const review = (changes = {}) => ({
  note: note(), missing_xml: false,
  review: {
    warnings: [], supplier: { id: "s1", name: "Fornecedor Sintetico Ltda", code: null }, supplier_proposal: null,
    capability: { stock: { part: true, role: true }, finance: { part: true, role: true }, orders: true, fiscal: true },
    lines: [{ position: 1, code: "F-001", gtin: null, description: "Biscoito de polvilho", unit: "CX", quantity: "2.0000", total_cents: 24000, cfop: "5102",
      product: { id: "p1", name: "Biscoito", code: null, unit: "UN", lot_control: false }, matched_by: "gtin", suggestions: [], factor: null, factor_from: null,
      stock_quantity: null, lot: null, cost: null, problems: ["factor_missing"] }],
    products: [{ id: "p1", name: "Biscoito", code: null, unit: "UN" }], warehouses: [{ id: "w1", name: "Loja" }], warehouse_id: "w1",
    orders: [], order_id: null, order_difference: null,
    finance: { installments: [{ number: "001", due_on: "2026-12-20", amount_cents: 31200 }], total_cents: 31200, categories: [], category_id: null, payment_methods: [], payment_method_id: null },
    stock: true, finance_selected: true, icms_in_cost: false, blockers: ["items_pending"], entry: null, ...changes,
  },
});
function fakePort(overrides = {}) {
  const calls = [];
  let n = 0;
  const port = {
    access: () => access(),
    list: async (q) => { calls.push(["list", q]); return page(); },
    review: async () => review(),
    preview: async (id, choices) => { calls.push(["preview", choices]); return review({ blockers: [] }); },
    settings: async () => ({ version: 0, manifest_enabled: false }),
    fetchVault: async (input) => { calls.push(["buscar", input]); return { created: 1, updated: 0, with_xml: 1, xml_pending: [] }; },
    enter: async (id, command, choices) => { calls.push(["entrada", command, choices]); return { entry: { stock_status: "done", finance_status: "part_disabled" }, replayed: false }; },
    command: () => `cmd-${++n}`,
    xmlUrl: (id) => `/xml/${id}`,
    ...overrides,
  };
  return { port, calls };
}

test("lista: fornecedor, número, valor e situação; buscar no cofre e importar o XML", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port);
  try {
    const text = view.text();
    assert.match(text, /Notas recebidas/);
    assert.match(text, /Fornecedor Sintetico Ltda/);
    assert.match(text, /R\$\s?312,00/);
    assert.match(text, /Para dar entrada/);
    assert.match(text, /XML importado/);
    await view.click("Buscar no cofre");
    assert.deepEqual(calls.find((c) => c[0] === "buscar"), ["buscar", { ambiente: "homologacao" }]);
    assert.match(view.text(), /Busca feita: 1 nota\(s\) nova\(s\)/);
    // O interruptor da manifestação aparece para o administrador, desligado.
    assert.match(view.text(), /Permitir manifestar notas recebidas:.*desligado/);
  } finally { view.unmount(); }
});

test("produção: só busca com a autorização do administrador marcada naquela busca", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port);
  try {
    const select = view.find((n) => n.type === "select" && n.props.value === "homologacao");
    select.props.onChange({ target: { value: "producao" } });
    await view.flush();
    assert.equal(view.button("Buscar no cofre").disabled, true);
    const box = view.find((n) => n.type === "input" && n.props.type === "checkbox" && n.props.checked === false && n.props.onChange);
    box.props.onChange({ target: { checked: true } });
    await view.flush();
    await view.click("Buscar no cofre");
    assert.deepEqual(calls.find((c) => c[0] === "buscar"), ["buscar", { ambiente: "producao", autorizacao_producao: true }]);
  } finally { view.unmount(); }
});

test("partes: sem Fiscal a busca no cofre some e a tela diz o que ligar; sem Compras, a tela inteira diz", async () => {
  const noFiscal = fakePort({ access: () => access({ fiscal: false }) });
  const view = await mount(noFiscal.port);
  try {
    assert.throws(() => view.button("Buscar no cofre"));
    assert.match(view.text(), /ligue o Fiscal em Gestão → Módulos/);
  } finally { view.unmount(); }
  const off = await mount(fakePort({ access: () => access({ purchases: false }) }).port);
  try { assert.match(off.text(), /ligar Compras em Gestão → Módulos/); } finally { off.unmount(); }
});

test("conferência e entrada: a unidade pendente em palavras; repetir a entrada usa o mesmo comando", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, `/notas-recebidas-compras?nota=${NOTE_ID}`);
  try {
    const text = view.text();
    assert.match(text, /A unidade da nota é diferente da do produto/);
    assert.match(text, /Resolva os itens marcados/);
    assert.match(text, /Casado pelo código de barras/);
    const factor = view.find((n) => n.type === "input" && n.props.inputMode === "decimal");
    factor.props.onChange({ target: { value: "12" } });
    await view.flush();
    await view.click("Conferir de novo com as escolhas");
    assert.deepEqual(calls.find((c) => c[0] === "preview")[1].items, [{ position: 1, factor: "12" }]);
    await view.click("Dar entrada");
    await view.click("Dar entrada");
    const entries = calls.filter((c) => c[0] === "entrada");
    assert.equal(entries.length, 2);
    assert.equal(entries[0][1], entries[1][1]);
    assert.match(view.text(), /Entrada feita\. Estoque: Lançado\. Contas a pagar: Não lançado: a parte está desligada/);
    // Nota importada pelo XML não passa pelo cofre: sem o quadro da manifestação.
    assert.doesNotMatch(view.text(), /Manifestação do destinatário/);
  } finally { view.unmount(); }
});

test("nota do cofre só com o resumo: diz como conseguir o XML; manifestação desligada diz quem liga", async () => {
  const vaultNote = note({ source: "cofre", xml: null, vault: { id: "rcb_x", xml_available: false, manifestation: null, pending: null } });
  const { port } = fakePort({ review: async () => ({ note: vaultNote, review: null, missing_xml: true }), access: () => access() });
  const view = await mount(port, `/notas-recebidas-compras?nota=${NOTE_ID}`);
  try {
    assert.match(view.text(), /só tem o resumo desta nota/);
    assert.match(view.text(), /A manifestação está desligada\. Ligue em Notas recebidas → Configuração/);
  } finally { view.unmount(); }
});
