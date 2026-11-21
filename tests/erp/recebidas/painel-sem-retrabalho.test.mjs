// Tela Compras › Notas recebidas, compra sem retrabalho (web/erp/NotasRecebidas.tsx)
// no harness do painel: porta simulada, nenhuma rede. Prova a baixa do pedido
// na conferência, o cadastro do produto pelo XML com o mesmo comando ao
// repetir, a reposição pelo mínimo gerando os pedidos por fornecedor, o
// inventário valorizado com a planilha e o Estoque desligado dizendo o que ligar.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port, location) => mountComponent("../../NotasRecebidas.tsx", { port }, { expandChildren: true, location, modules });

const NOTE_ID = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
const note = { id: NOTE_ID, source: "manual", environment: "homologacao", access_key: "35261144555666000181550010000001011876543213", role: "destinatario",
  emitter: { document: "44555666000181", name: "Fornecedor Sintetico Ltda" }, supplier: { id: "s1", name: "Fornecedor Sintetico Ltda", code: null },
  series: 1, number: 101, issued_on: "2026-11-18", total_cents: 31200, situation: "autorizada", nature: "Venda", purpose: "compra",
  purpose_label: "Compra de mercadoria", xml: { key: "k", sha256: "a".repeat(64), size: 10 }, vault: null, entry: null, last_entry: null };
const access = (parts = {}) => ({ ready: true, role: "admin", admin: true, demo: false, parts: { purchases: true, stock: true, finance: true, fiscal: true, products: true, ...parts } });
const line = (changes) => ({ position: 1, code: "F-001", gtin: null, description: "Biscoito de polvilho", unit: "UN", quantity: "24.0000", total_cents: 24000, cfop: "5102",
  product: { id: "p1", name: "Biscoito", code: null, unit: "UN", lot_control: false }, matched_by: "gtin", suggestions: [], factor: "1", factor_from: "same_unit",
  stock_quantity: "24.000000", lot: null, cost: { unit_cost: "10", freight_cents: 0, taxes_cents: 0 }, problems: [], ...changes });
const review = (changes = {}) => ({
  note, missing_xml: false,
  review: {
    warnings: [], supplier: note.supplier, supplier_proposal: null, capability: { stock: { part: true, role: true }, finance: { part: true, role: true }, orders: true, fiscal: true },
    lines: [line(), line({ position: 2, code: "F-777", description: "Molho de tomate sache", product: null, matched_by: null, factor: null, factor_from: null, stock_quantity: null, cost: null, problems: ["product_missing"] })],
    products: [], warehouses: [{ id: "w1", name: "Loja" }], warehouse_id: "w1",
    orders: [{ id: "o1", number: "7", date: "2026-11-10", referenced: true }], order_id: "o1",
    order_difference: { order: { id: "o1", number: "7" }, fulfillment: "parcial",
      lines: [{ position: 1, remaining_quantity: "30.000000", note_quantity: "24.000000", attend_quantity: "24.000000", pending_quantity: "6.000000", fulfillment: "parcial", status: "different", order_unit_price: "10", note_unit_price: "10" }],
      missing: [] },
    finance: { installments: [], total_cents: 0, categories: [], category_id: null, payment_methods: [], payment_method_id: null },
    stock: true, finance_selected: false, icms_in_cost: false, blockers: ["items_pending"], entry: null, ...changes,
  },
});
const proposal = { position: 2, supplier_code: "F-777", description: "Molho de tomate sache", note_unit: "UN", quantity: "12.0000",
  proposal: { name: "Molho de tomate sache", code: null, unit: "UN", ncm: "21032010", cest: "1700700", gtin: "7894900011517", purchase_price: "2.50", cost_price: "2.50" },
  existing: null, problems: [], notices: [] };
const replenishment = { filters: { warehouse_id: null, supplier_id: null, only_below: true }, can_order: true, warehouses: [{ id: "w1", name: "Loja" }], total: 2,
  items: [
    { product_id: "p1", code: "B1", name: "Biscoito", unit: "UN", stock_min: "10.000000", stock_max: "30.000000", balance: "4.000000", ordered: "6.000000", orders: [{ id: "o1", number: "7", quantity: "6.000000" }],
      below_min: true, suggestion: "20.000000", covered_by_orders: false, supplier_id: "s1", supplier_name: "Fornecedor Sintetico Ltda", suppliers: [{ id: "s1", name: "Fornecedor Sintetico Ltda" }],
      unit_price: "9.5000000000", price_source: "supplier_purchase", value: "190.00" },
    { product_id: "p2", code: null, name: "Leite", unit: "UN", stock_min: "5.000000", stock_max: null, balance: "0.000000", ordered: "0.000000", orders: [],
      below_min: true, suggestion: "5.000000", covered_by_orders: false, supplier_id: null, supplier_name: null, suppliers: [], unit_price: null, price_source: null, value: null },
  ],
  totals: { below_min: 2, to_buy: 2, without_supplier: 1, value: "190.00" } };
const inventory = { filters: { date: "2026-11-21", warehouse_id: null, include_zero: false }, cost_visible: true, cost_basis: "preco_compra", warehouses_available: [{ id: "w1", name: "Loja" }], total: 1,
  items: [{ product_id: "p1", code: "B1", name: "Biscoito", unit: "UN", warehouse_id: "w1", warehouse_name: "Loja", ignored: false, quantity: "20.000000", average_cost: "5.0000000000", value: "100.00" }],
  warehouses: [{ warehouse_id: "w1", name: "Loja", products: 1, value: "100.00" }], totals: { value: "100.00", uncosted: 0 } };

function fakePort(overrides = {}) {
  const calls = [];
  let n = 0;
  const port = {
    access: () => access(),
    list: async () => ({ items: [note], total: 1, page: 1, per_page: 50, settings: { version: 0, manifest_enabled: false }, fetches: [], company_document: "11222333000181" }),
    review: async () => review(),
    preview: async (id, choices) => { calls.push(["preview", choices]); return review({ blockers: [] }); },
    settings: async () => ({ version: 0, manifest_enabled: false }),
    productPreview: async () => ({ supplier: note.supplier, can_create: true, blockers: [], items: [proposal] }),
    createProducts: async (id, command, items) => { calls.push(["produto", command, items]); return { created: [{ position: 2, product: { id: "p9", name: items[0].name, code: null } }], replayed: false }; },
    replenishment: async (q) => { calls.push(["reposicao", q]); return replenishment; },
    generateOrders: async (command, input) => { calls.push(["pedidos", command, input]); return { orders: [{ document_id: "d1", number: 8, supplier_id: "s1", supplier_name: "Fornecedor Sintetico Ltda", items: 1, replayed: false }], replayed: false }; },
    inventory: async (q) => { calls.push(["inventario", q]); return inventory; },
    inventoryCsvUrl: (q) => `/csv?data=${q.data}`,
    command: () => `cmd-${++n}`,
    xmlUrl: (id) => `/xml/${id}`,
    ...overrides,
  };
  return { port, calls };
}

test("conferência: a baixa do pedido por item e o que fica pendente", async () => {
  const { port } = fakePort();
  const view = await mount(port, `/notas-recebidas-compras?nota=${NOTE_ID}`);
  try {
    const text = view.text();
    assert.match(text, /Baixa nesta nota/);
    assert.match(text, /Fica pendente/);
    assert.match(text, /Atendido em parte/);
    assert.match(text, /o pedido fica atendido em parte: o que falta continua pendente no pedido/);
  } finally { view.unmount(); }
});

test("produto pelo XML: prévia com NCM, CEST e GTIN; cadastrar repete o mesmo comando e confere de novo", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, `/notas-recebidas-compras?nota=${NOTE_ID}`);
  try {
    await view.click("Cadastrar produto novo com os dados da nota");
    assert.match(view.text(), /21032010 · 1700700 · 7894900011517/);
    const name = view.find((n) => n.type === "input" && n.props["aria-label"] === "Nome do produto do item 2");
    name.props.onChange({ target: { value: "Molho de tomate 340 g" } });
    await view.flush();
    // Primeira tentativa sem resposta: o mesmo pedido usa o mesmo comando.
    let fail = true;
    const create = port.createProducts;
    port.createProducts = async (...args) => { calls.push(["produto", args[1], args[2]]); if (fail) { fail = false; throw new Error("A resposta não chegou."); } return create(...args); };
    await view.click("Cadastrar 1 produto(s)");
    assert.match(view.text(), /A resposta não chegou/);
    await view.click("Cadastrar 1 produto(s)");
    const sent = calls.filter((c) => c[0] === "produto");
    assert.equal(sent[0][1], sent[1][1]);
    assert.deepEqual(sent[0][2], [{ position: 2, name: "Molho de tomate 340 g" }]);
    // Depois do cadastro, a conferência é refeita no servidor.
    assert.ok(calls.some((c) => c[0] === "preview"));
  } finally { view.unmount(); }
});

test("reposição pelo mínimo: sugestão, fornecedor obrigatório e os pedidos por fornecedor com um clique", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, "/notas-recebidas-compras?aba=reposicao");
  try {
    const text = view.text();
    assert.match(text, /Reposição pelo estoque mínimo/);
    assert.match(text, /Cadastre o fornecedor na aba Fornecedores do produto/);
    assert.match(text, /R\$\s?190,00/);
    // O biscoito vem marcado (tem fornecedor); o leite não.
    await view.click("Gerar 1 pedido(s) de compra");
    const sent = calls.find((c) => c[0] === "pedidos");
    assert.deepEqual(sent[2], { deposito: null, itens: [{ product_id: "p1", quantity: "20", supplier_id: "s1" }] });
    assert.match(view.text(), /1 pedido\(s\) de compra gerado\(s\)/);
    assert.match(view.text(), /Pedido 8 para Fornecedor Sintetico Ltda/);
  } finally { view.unmount(); }
});

test("inventário valorizado: saldo, custo médio da data, total e a planilha; sem Estoque, diz o que ligar", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, "/notas-recebidas-compras?aba=inventario");
  try {
    const text = view.text();
    assert.match(text, /Inventário valorizado/);
    assert.match(text, /Total: R\$\s?100,00/);
    assert.ok(calls.some((c) => c[0] === "inventario" && /^\d{4}-\d{2}-\d{2}$/.test(c[1].data)));
    assert.ok(view.find((n) => n.type === "a" && String(n.props.href).startsWith("/csv?data=")));
  } finally { view.unmount(); }
  const off = await mount(fakePort({ access: () => access({ stock: false }) }).port, "/notas-recebidas-compras?aba=inventario");
  try { assert.match(off.text(), /ligar Estoque em Gestão → Módulos/); } finally { off.unmount(); }
});
