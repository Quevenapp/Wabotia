// Tela Vendas › Expedição (web/erp/Expedicao.tsx) no harness do painel:
// componentes e handlers reais, porta simulada, nenhuma rede. Prova a
// recusa com a parte desligada (dizendo o que ligar), a escolha dos pedidos e
// a lista de separação gerada, a marcação pela leitura do código, os volumes
// enviados com os itens, a devolução e o atalho para a devolução fiscal.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port, location = "/expedicao") => mountComponent("../../Expedicao.tsx", { port }, { expandChildren: true, location, modules });
globalThis.window ??= { confirm: () => true, prompt: () => "" };

const ORDER = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c", LIST = "7a2c9b63-7e1f-4d8f-8b44-2a1e8e2b3c4d";
const access = (parts = {}) => ({ ready: true, role: "admin", demo: false, parts: { shipping: true, sales: true, stock: true, fiscal: true, delivery: true, ...parts } });
const summary = (changes = {}) => ({
  id: ORDER, number: 12, date: "2026-11-19", order_status: "open", status: "to_pick", status_label: "A separar", version: 0, customer: "Cliente do Ensaio",
  city: "São Paulo", state: "SP", total_cents: "5100", carrier: { id: "c1", name: "Transportes do Ensaio" }, freight_mode: null, own_delivery: false,
  warehouse: { id: "w1", name: "Loja" }, pick_list: null, pending: 0, volumes: 0, shipped_on: null, tracking_code: null, delivery_id: null, ...changes,
});
const overview = (items = [summary()]) => ({ role: "admin", can_write: true, fiscal: true, counts: { to_pick: 1, picking: 0, picked: 0, packed: 0, shipped: 0 },
  items, truncated: false, lists: [], packages: [] });
const pickList = (picked = "0.000000") => ({
  list: { id: LIST, number: 3, status: "open", version: 1, created_at: null, finished_at: null },
  rows: [{ key: "p1|w1|a-01", product_id: "p1", warehouse: { id: "w1", name: "Loja" }, location: "A-01", description: "Parafuso sextavado", code: "PAR-1", gtin: "7891234567895",
    unit: "UN", quantity: "5.000000", picked, done: picked === "5.000000", orders: [{ document_id: ORDER, number: 12, quantity: "5.000000", picked }] }],
  orders: [{ id: ORDER, number: 12, customer: "Cliente do Ensaio", status: "picking", status_label: "Em separação", quantity: "5.000000", picked }],
});
const detail = (changes = {}) => ({
  fiscal: true,
  order: { ...summary({ status: "picked", status_label: "Separado", version: 2 }), recipient: { name: "Cliente do Ensaio", document: null, phone: null, street: "Praça da Sé", number: "200",
    complement: null, district: "Sé", city: "São Paulo", state: "SP", postal_code: "01001000", delivery_address: false }, address: "Praça da Sé, 200 · Sé · São Paulo - SP",
    transport: { carrier_id: "c1", freight_mode: null, tracking_code: null, own_delivery: false }, transport_synced_at: null, delivery_at: null },
  lines: [{ key: "item-1", product_id: "p1", description: "Parafuso sextavado", code: "PAR-1", gtin: null, unit: "UN", location: "A-01", quantity: "5.000000", returned: "0.000000",
    net_weight_g: 50, gross_weight_g: 60 }],
  pending: [], volumes: [], returns: [], emission: null, packages: [{ id: "pk1", name: "Caixa média", length_mm: 400, width_mm: 300, height_mm: 200, empty_weight_g: 300, active: true, version: 1 }],
  ...changes,
});
function fakePort(overrides = {}) {
  const calls = [];
  let n = 0;
  const port = {
    access: () => access(),
    overview: async (q) => { calls.push(["overview", q]); return overview(); },
    pickList: async () => pickList(),
    createPick: async (input, command) => { calls.push(["createPick", input, command]); return pickList(); },
    mark: async (list, input) => { calls.push(["mark", list, input]); return pickList("1.000000"); },
    order: async () => detail(),
    pack: async (order, input, command) => { calls.push(["pack", order, input, command]);
      return { ...detail({ order: { ...detail().order, status: "packed", status_label: "Embalado" } }), totals: { volumes: 1, net_weight_g: 250, gross_weight_g: 600 }, unpacked: [],
        transport: { written: true, reason: null }, items_without_weight: 0 }; },
    registerReturn: async (order, input, command) => { calls.push(["return", order, input, command]);
      return { return: { number: 1, movement_id: "m1" }, emission: { id: "e1", status: "autorizada", number: 10, series: 1, authorized: true, return_path: "/historico-fiscal?modelo=55&emissao=e1" } }; },
    command: () => `cmd-${++n}`,
    ...overrides,
  };
  return { port, calls };
}
const button = (view, label) => view.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes(label));

test("parte desligada: a tela diz o que ligar e não chama o servidor", async () => {
  const { port, calls } = fakePort({ access: () => access({ shipping: false, stock: false }) });
  const view = await mount(port);
  try {
    assert.match(view.text(), /precisa de Expedição e Estoque ligados/);
    assert.match(view.text(), /Gestão → Módulos/);
    assert.equal(calls.length, 0);
  } finally { view.unmount(); }
});

test("pedidos: filtra a separar, escolhe o pedido e gera a lista de separação", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port);
  try {
    assert.match(view.text(), /Cliente do Ensaio/);
    assert.match(view.text(), /Transportes do Ensaio/);
    assert.equal(calls[0][1].situacao, "a_separar");
    view.find((n) => n.type === "input" && n.props["aria-label"] === "Escolher o pedido 12").props.onChange();
    await view.flush();
    await view.click("Gerar lista de separação (1)");
    const created = calls.find((c) => c[0] === "createPick");
    assert.deepEqual(created[1].pedidos, [ORDER]);
    assert.equal(created[2], "cmd-1");
    assert.equal(view.location().search, `?lista=${LIST}`);
  } finally { view.unmount(); }
});

test("separação: a leitura do código acha o item pelo GTIN e soma um", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, `/expedicao?lista=${LIST}`);
  try {
    assert.match(view.text(), /Lista de separação 3/);
    assert.match(view.text(), /A-01/);
    view.find((n) => n.type === "input" && n.props.placeholder === "Leitor ou digite e Enter").props.onChange({ target: { value: "7891234567895" } });
    await view.flush();
    await view.submit(0);
    assert.deepEqual(calls.find((c) => c[0] === "mark"), ["mark", LIST, { versao: 1, linha: "p1|w1|a-01", separado: "1" }]);
    assert.match(view.text(), /Lido: Parafuso sextavado/);
    view.find((n) => n.type === "input" && n.props.placeholder === "Leitor ou digite e Enter").props.onChange({ target: { value: "000" } });
    await view.flush();
    await view.submit(0);
    assert.match(view.text(), /O código 000 não é de nenhum item desta lista/);
  } finally { view.unmount(); }
});

test("pedido: volumes com a embalagem e os itens; devolução mostra o atalho para a devolução fiscal", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, `/expedicao?pedido=${ORDER}`);
  try {
    assert.match(view.text(), /Pedido 12/);
    await view.click("Salvar volumes");
    const packed = calls.find((c) => c[0] === "pack");
    assert.deepEqual(packed[2], { versao: 2, volumes: [{ embalagem: "pk1", itens: [{ linha: "item-1", quantidade: "5" }] }] });
    assert.match(view.text(), /1 volume, peso bruto 0,600 kg/);
    assert.match(view.text(), /foram para o transporte do pedido/);
    view.find((n) => n.type === "input" && n.props["aria-label"] === "Quantidade de Parafuso sextavado que voltou").props.onChange({ target: { value: "2" } });
    view.find((n) => n.type === "input" && n.props.placeholder === "Ex.: cliente recusou na entrega").props.onChange({ target: { value: "Cliente recusou" } });
    await view.flush();
    await button(view, "Registrar devolução").props.onClick();
    await view.flush();
    const made = calls.find((c) => c[0] === "return");
    assert.deepEqual(made[2], { motivo: "Cliente recusou", itens: [{ linha: "item-1", quantidade: "2", estado: "volta_ao_estoque" }] });
    assert.match(view.text(), /Devolução 1 registrada/);
    assert.match(view.text(), /abra a nota e emita a NF-e de devolução/);
  } finally { view.unmount(); }
});
