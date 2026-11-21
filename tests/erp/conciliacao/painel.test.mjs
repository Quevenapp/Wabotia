// Telas Financeiro › Conciliação bancária e Conciliação de cartões
// (web/erp/Conciliacao.tsx) no harness do painel: componentes e handlers
// reais, porta simulada, nenhuma rede. Prova a recusa com o Financeiro
// desligado (dizendo o que ligar), a sugestão com o grau de confiança e a
// baixa com um clique, ignorar com motivo, o saldo do banco x sistema com a
// diferença, a taxa acima do contrato e o recebimento do cartão na conta.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port, screen, location) => mountComponent("../../Conciliacao.tsx", { port, screen }, { expandChildren: true, location: location ?? (screen === "bank" ? "/conciliacao-bancaria" : "/conciliacao-cartoes"), modules });
let promptAnswer = "Estorno do próprio banco";
globalThis.window ??= {};
globalThis.window.confirm = () => true;
globalThis.window.prompt = () => promptAnswer;

const ACCOUNT = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c", LINE = "7a2c9b63-7e1f-4d8f-8b44-2a1e8e2b3c4d", TITLE = "8b3d0c74-8f20-4e90-9c55-3b2f9f3c4d5e";
const CARD = "9c4e1d85-9031-4fa1-8d66-4c3a0a4d5e6f", BANK2 = "0d5f2e96-0142-4ab2-9e77-5d4b1b5e6f70";
const access = (parts = {}, role = "admin") => ({ ready: true, role, demo: false, parts: { finance: true, pos: true, sales: true, ...parts } });
const overview = {
  role: "admin", can_write: true, parts: { pos: true, sales: true },
  accounts: [{ id: ACCOUNT, name: "Banco do Ensaio", kind: "bank", account_type: "checking", pending: 2, reconciled: 0, ignored: 0, last_line_on: "2026-11-20" }],
  categories: [{ id: "c1", name: "Despesas bancárias", kind: "payable" }, { id: "c2", name: "Vendas", kind: "receivable" }],
  layouts: [], rules: [], rates: [], acquirers: [{ id: "cielo", name: "Cielo" }], brands: [{ id: "visa", label: "Visa" }],
};
const line = (changes = {}) => ({
  id: LINE, posted_on: "2026-11-18", amount_cents: "15000", memo: "PIX RECEBIDO MARIA", state: "pending", version: 1, source: "ofx", ignored_reason: null, links: [],
  suggestions: [{ type: "title", confidence: 95, level: "alta", label: "Receber Maria: 150,00, vence 18/11/2026", detail: "Venda 12", titles: [{ id: TITLE, version: 3, balance_cents: "15000" }] }],
  ...changes,
});
const bankPage = (lines = [line()]) => ({
  role: "admin", can_write: true, account: { id: ACCOUNT, name: "Banco do Ensaio" }, state: "pending", counts: { pending: lines.length, reconciled: 0, ignored: 0 },
  lines, truncated: false, period: { from: "2026-11-01", to: "2026-11-20" }, statements: [],
  balances: [{ day: "2026-11-17", system_cents: "0", bank_cents: "0", difference_cents: "0" }, { day: "2026-11-18", system_cents: "0", bank_cents: "15000", difference_cents: "15000" }],
});
const cardLine = (changes = {}) => ({
  id: CARD, kind: "receivable", acquirer: "cielo", acquirer_name: "Cielo", sold_on: "2026-10-18", expected_on: "2026-11-18", brand: "visa", brand_label: "Visa", product: "credit",
  installment: 1, installments: 3, gross_cents: "10000", fee_cents: "300", net_cents: "9700", nsu: "654321", authorization: null, state: "matched", version: 2, confidence: 92, level: "alta",
  title: { id: TITLE, version: 1, description: "Venda no cartão", contact_name: "Maria", issued_on: "2026-10-18", due_on: "2026-11-17", amount_cents: "10000", balance_cents: "10000", installment: 1, installments: 3, origin: "Venda do PDV nº 7" },
  group: null, fee: { charged_rate_bp: 300, contracted_rate_bp: 249, expected_cents: "249", difference_cents: "51", above_contract: true, contracted_day: "2026-11-17", late: true },
  received: null, ignored_reason: null, ...changes,
});
const cardPage = (lines = [cardLine()]) => ({
  role: "admin", can_write: true, lines, truncated: false, imports: [], rates: [], accounts: [{ id: ACCOUNT, name: "Banco do Ensaio" }],
  summary: { gross_cents: "10000", fee_cents: "300", expected_fee_cents: "249", above_contract: 1, coming: [{ day: "2026-12-18", count: 2, gross_cents: "20000", net_cents: "19400" }],
    late: { count: 0, net_cents: "0" }, open_titles: [] },
});

function fakePort(overrides = {}) {
  const calls = [];
  let n = 0;
  const port = {
    access: () => access(),
    overview: async () => { calls.push(["overview"]); return overview; },
    bankLines: async (account, query) => { calls.push(["bankLines", account, query]); return query.situacao === "pendentes" && account === ACCOUNT && calls.some((c) => c[0] === "cardLines")
      ? bankPage([line({ id: BANK2, memo: "CIELO CREDITO", amount_cents: "9700", suggestions: [] })]) : bankPage(); },
    bankCandidates: async () => ({ movements: [], titles: [] }),
    bankAction: async (id, input, command) => { calls.push(["bankAction", id, input, command]); return { line: line({ state: "reconciled" }) }; },
    preview: async () => ({ target: "bank", total: 0, header: null, mapped: null, lines: [] }),
    bankImport: async () => ({ new_lines: 0, skipped: 0, duplicate_file: false, balances: 0 }),
    saveRule: async (input, command) => { calls.push(["saveRule", input, command]); return { rule: {} }; },
    saveLayout: async () => ({ layout: {} }),
    cardLines: async (query) => { calls.push(["cardLines", query]); return cardPage(); },
    cardCandidates: async () => ({ candidates: [] }),
    cardImport: async () => ({ new_lines: 0, skipped: 0, duplicate_file: false, suggested: 0, ignored_rows: 0 }),
    cardAction: async (id, input, command) => { calls.push(["cardAction", id, input, command]); return { line: cardLine() }; },
    cardBatch: async (input, command) => { calls.push(["cardBatch", input, command]); return { confirmed: 1 }; },
    cardReceive: async (input, command) => { calls.push(["cardReceive", input, command]); return { received: 1, net_cents: "9700" }; },
    saveRate: async (input, command) => { calls.push(["saveRate", input, command]); return { rate: {} }; },
    command: () => `cmd-${++n}`,
    ...overrides,
  };
  return { port, calls };
}

test("Financeiro desligado: a tela diz o que ligar e não chama o servidor", async () => {
  const { port, calls } = fakePort({ access: () => access({ finance: false }) });
  for (const screen of ["bank", "card"]) {
    const view = await mount(port, screen);
    try {
      assert.match(view.text(), /faz parte do Financeiro, que está desligado/);
      assert.match(view.text(), /Gestão → Módulos/);
    } finally { view.unmount(); }
  }
  assert.equal(calls.length, 0);
  const denied = await mount(fakePort({ access: () => access({}, "vendas") }).port, "bank");
  try { assert.match(denied.text(), /Administrador, Financeiro ou Consulta/); } finally { denied.unmount(); }
});

test("bancária: sugestão com confiança, baixa com um clique, ignorar com motivo e o saldo do banco x sistema", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, "bank");
  try {
    assert.match(view.text(), /PIX RECEBIDO MARIA/);
    assert.match(view.text(), /alta · 95%/);
    assert.match(view.text(), /1 dia com diferença/);
    assert.match(view.text(), /R\$ 150,00/);
    assert.deepEqual(calls.find((c) => c[0] === "bankLines").slice(1), [ACCOUNT, { situacao: "pendentes", busca: undefined }]);
    await view.click("Baixar e conciliar");
    const settled = calls.find((c) => c[0] === "bankAction");
    assert.deepEqual(settled.slice(1), [LINE, { versao: 1, acao: "baixar", contas: [{ id: TITLE, versao: 3 }] }, "cmd-1"]);
    assert.match(view.text(), /Linha conciliada/);
    await view.click("Ignorar");
    const ignored = calls.filter((c) => c[0] === "bankAction")[1];
    assert.deepEqual(ignored[2], { versao: 1, acao: "ignorar", motivo: "Estorno do próprio banco" });
  } finally { view.unmount(); }
});

test("bancária: consulta vê as pendências mas não tem botões de gravar", async () => {
  const { port } = fakePort({ overview: async () => ({ ...overview, role: "consulta", can_write: false }), access: () => access({}, "consulta") });
  const view = await mount(port, "bank");
  try {
    assert.match(view.text(), /PIX RECEBIDO MARIA/);
    assert.equal(view.nodes().some((n) => n.type === "button" && /Baixar e conciliar|Importar|Salvar regra/.test(JSON.stringify(n.props.children ?? ""))), false);
  } finally { view.unmount(); }
});

test("cartões: taxa acima do contrato, o que vai cair e receber na conta com a linha do extrato", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port, "card");
  try {
    assert.match(view.text(), /Venda do PDV nº 7/);
    assert.match(view.text(), /3,00%/);
    assert.match(view.text(), /2,49%/);
    assert.match(view.text(), /fora do prazo/);
    assert.match(view.text(), /O que ainda vai cair: R\$ 194,00/);
    assert.deepEqual(calls.find((c) => c[0] === "cardLines")[1], { tipo: "recebivel", situacao: "abertas", adquirente: undefined, divergentes: undefined });
    view.find((n) => n.type === "input" && n.props["aria-label"] === "Escolher para receber").props.onChange();
    await view.flush();
    assert.match(view.text(), /Receber 1 venda: R\$ 97,00 líquido/);
    view.find((n) => n.type === "select" && JSON.stringify(n.props.children).includes("Conciliar depois")).props.onChange({ target: { value: BANK2 } });
    await view.flush();
    await view.click("Receber na conta");
    const received = calls.find((c) => c[0] === "cardReceive");
    assert.deepEqual(received[1], { linhas: [CARD], conta: ACCOUNT, linha_banco: BANK2, versao_linha_banco: 1 });
    await view.click("Confirmar as sugestões de confiança alta");
    assert.deepEqual(calls.find((c) => c[0] === "cardBatch")[1], { acao: "confirmar_sugestoes", confianca_minima: 90 });
  } finally { view.unmount(); }
});
