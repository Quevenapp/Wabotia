// Tela Cadastros › Lojas e filiais (web/erp/Lojas.tsx) no harness do painel:
// componentes e handlers reais, porta simulada, nenhuma rede. Prova que com
// uma loja só nada novo aparece (nem abas, nem a barra "Loja em uso"), que o
// administrador cadastra a segunda loja com depósitos, caixa e depósito
// padrão, que a barra aparece com duas lojas, que o limite da pessoa é salvo
// e que a comparação mostra as lojas lado a lado com o total.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port, location = "/lojas", componentName) => mountComponent("../../Lojas.tsx", { port }, { expandChildren: true, location, modules, componentName });

const MAIN = "5a1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c", KIOSK = "6b2c9b63-7e1f-4d8f-8b44-2a1e8e2b3c4d";
const W1 = "7c3d0c74-8f20-4e90-9c55-3b2f9f3c4d5e", W2 = "8d4e1d85-9031-4fa1-8d66-4c3a0a4d5e6f", CASH = "9e5f2e96-0142-40b2-9e77-5d4b1b5e6f70";
const VENDAS = "10000000-0000-4000-8000-000000000005";
const access = () => ({ ready: true, role: "admin", demo: false, parts: { sales: true, purchases: true, stock: true, finance: true, pos: true } });
const main = { id: MAIN, name: "Ensaio Comercial", is_main: true, active: true, version: 1, address: { street: "Praça da Sé", number: "100", city: "São Paulo", state: "SP" },
  phone: "1130000000", cnpj: null, fiscal_series: null, default_warehouse_id: W1, default_warehouse_name: "Depósito da matriz",
  warehouses: [{ id: W1, name: "Depósito da matriz" }, { id: W2, name: "Depósito do quiosque" }], accounts: [{ id: CASH, name: "Caixa do quiosque", kind: "cash" }], people: 0 };
const kiosk = { id: KIOSK, name: "Quiosque do shopping", is_main: false, active: true, version: 1, address: { city: "Santos", state: "SP" }, phone: null, cnpj: "11222333000181",
  fiscal_series: 2, default_warehouse_id: W2, default_warehouse_name: "Depósito do quiosque", warehouses: [{ id: W2, name: "Depósito do quiosque" }], accounts: [{ id: CASH, name: "Caixa do quiosque", kind: "cash" }], people: 1 };
const single = () => ({ role: "admin", admin: true, multi: false, me: { user_id: "a", limited: false, allowed: null, selected_store_id: null, default_store_id: MAIN }, stores: [main],
  warehouses: [{ id: W1, name: "Depósito da matriz", store_id: MAIN }, { id: W2, name: "Depósito do quiosque", store_id: MAIN }],
  accounts: [{ id: CASH, name: "Caixa do quiosque", kind: "cash", store_id: MAIN }], people: [{ user_id: VENDAS, name: "Pessoa vendas", role: "vendas", store_ids: [] }] });
const multi = () => ({ ...single(), multi: true, stores: [{ ...main, warehouses: [main.warehouses[0]], accounts: [] }, kiosk],
  warehouses: [{ id: W1, name: "Depósito da matriz", store_id: MAIN }, { id: W2, name: "Depósito do quiosque", store_id: KIOSK }],
  accounts: [{ id: CASH, name: "Caixa do quiosque", kind: "cash", store_id: KIOSK }] });
const compared = (a, b) => ({ by_store: { [MAIN]: a, [KIOSK]: b }, total: String(Number(a) + Number(b)) });

function fakePort(overview, overrides = {}) {
  const calls = [];
  let n = 0;
  const port = {
    access,
    overview: async () => { calls.push(["overview"]); return overview(); },
    save: async (input, command) => { calls.push(["save", input, command]); return { store: kiosk }; },
    setPerson: async (user, stores, command) => { calls.push(["person", user, stores, command]); return {}; },
    select: async (store) => { calls.push(["select", store]); return { selected_store_id: store }; },
    report: async (q) => { calls.push(["report", q]); return { from: "2026-11-01", to: "2026-11-19", basis: "cash", unavailable: ["dre"],
      stores: [{ id: MAIN, name: "Ensaio Comercial", is_main: true }, { id: KIOSK, name: "Quiosque do shopping", is_main: false }],
      sales: { orders: compared("3", "2"), total: compared("300.00", "120.00"), average_ticket: compared("100.00", "60.00"), pos_orders: compared("0", "2"), pos_total: compared("0.00", "120.00") },
      stock: { quantity: compared("10", "5"), cost_hidden: true } }; },
    operations: async (q) => { calls.push(["operations", q]); return { kind: "sales_orders", page: 1, limit: 50, total: 0, stores: [], items: [] }; },
    assign: async () => ({}),
    command: () => `cmd-${++n}`,
    ...overrides,
  };
  return { port, calls };
}
const button = (view, label) => view.find((node) => node.type === "button" && JSON.stringify(node.props.children ?? "").includes(label));

test("uma loja só: a loja principal, o botão da segunda loja e nenhuma aba nem barra de loja em uso", async () => {
  const { port } = fakePort(single);
  const view = await mount(port);
  try {
    assert.match(view.text(), /Sua empresa tem uma loja só/);
    assert.match(view.text(), /Ensaio Comercial/);
    assert.match(view.text(), /Loja principal/);
    assert.ok(button(view, "Cadastrar a segunda loja"));
    assert.doesNotMatch(view.text(), /Comparar lojas|Operações por loja/);
  } finally { view.unmount(); }
  const bar = await mount(fakePort(single).port, "/estoque-empresa", "StoreSwitcher");
  try { assert.doesNotMatch(bar.text(), /Loja em uso/); } finally { bar.unmount(); }
});

test("segunda loja: o administrador escolhe depósito, caixa e depósito padrão e salva", async () => {
  const { port, calls } = fakePort(single);
  const view = await mount(port);
  try {
    await button(view, "Cadastrar a segunda loja").props.onClick();
    await view.flush();
    assert.match(view.text(), /Nova loja/);
    view.find((n) => n.type === "input" && n.props.maxLength === 80).props.onChange({ target: { value: "Quiosque do shopping" } });
    await view.flush();
    const checks = () => view.nodes().filter((n) => n.type === "input" && n.props.type === "checkbox");
    // Depósito do quiosque (2º depósito) e o caixa.
    checks()[1].props.onChange();
    await view.flush();
    checks()[2].props.onChange();
    await view.flush();
    view.find((n) => n.type === "select" && JSON.stringify(n.props.children ?? "").includes("Nenhum (o padrão da empresa)")).props.onChange({ target: { value: W2 } });
    await view.flush();
    await button(view, "Salvar loja").props.onClick();
    await view.flush();
    const saved = calls.find((c) => c[0] === "save");
    assert.equal(saved[1].nome, "Quiosque do shopping");
    assert.deepEqual(saved[1].depositos, [W2]);
    assert.deepEqual(saved[1].contas, [CASH]);
    assert.equal(saved[1].deposito_padrao, W2);
    assert.equal(saved[2], "cmd-1");
    assert.match(view.text(), /Loja cadastrada/);
  } finally { view.unmount(); }
});

test("duas lojas: a barra 'Loja em uso' aparece; abas de comparação, operações e pessoas", async () => {
  const bar = await mount(fakePort(multi).port, "/estoque-empresa", "StoreSwitcher");
  try {
    assert.match(bar.text(), /Loja em uso/);
    assert.match(bar.text(), /Todas as lojas/);
    assert.match(bar.text(), /Quiosque do shopping/);
  } finally { bar.unmount(); }
  const { port, calls } = fakePort(multi);
  const people = await mount(port, "/lojas?aba=pessoas");
  try {
    assert.match(people.text(), /Limite uma pessoa a uma ou mais lojas/);
    people.find((n) => n.type === "input" && n.props["aria-label"] === "Pessoa vendas em Quiosque do shopping").props.onChange();
    await people.flush();
    await button(people, "Salvar").props.onClick();
    await people.flush();
    assert.deepEqual(calls.find((c) => c[0] === "person").slice(1, 3), [VENDAS, [KIOSK]]);
  } finally { people.unmount(); }
  const compare = await mount(port, "/lojas?aba=comparar");
  try {
    await compare.flush();
    assert.ok(calls.some((c) => c[0] === "report"));
    assert.match(compare.text(), /Quiosque do shopping/);
    assert.match(compare.text(), /Vendas no período/);
    assert.match(compare.text(), /R\$\s?420,00/, "o total das lojas");
    assert.match(compare.text(), /O custo do estoque não aparece para o seu papel/);
    assert.match(compare.text(), /Fora desta comparação: DRE/);
  } finally { compare.unmount(); }
});
