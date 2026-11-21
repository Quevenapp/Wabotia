// Tela Financeiro › Régua de cobrança (web/erp/ReguaCobranca.tsx) no harness
// do painel: componentes e handlers reais, porta simulada, nenhuma rede.
// Prova a recusa com o Financeiro desligado (dizendo o que ligar), o que vai
// sair hoje, o que saiu e o que não saiu (com o motivo), ligar só com o aviso
// confirmado, os dias da régua e quem não é administrador só vendo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesText } from "../../../web/erp/regua-api.ts";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const modules = { "./ports": "export const erpPorts=()=>null;" };
const mount = (port) => mountComponent("../../ReguaCobranca.tsx", { port }, { expandChildren: true, location: "/regua-cobranca", modules });

const TITLE = "8b3d0c74-8f20-4e90-9c55-3b2f9f3c4d5e";
const access = (parts = {}, role = "admin") => ({ ready: true, role, admin: role === "admin", demo: false, parts: { finance: true, ...parts } });
const step = (changes = {}) => ({
  id: "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c", title_id: TITLE, stage: "before", stage_label: "2 dias antes do vencimento", channel: "whatsapp", channel_label: "WhatsApp",
  origin: "regua", planned_on: "2026-11-23", due_on: "2026-11-25", amount_cents: 15000, status: "pending", status_label: "A enviar", attempts: 0, reason: null,
  sent_at: null, updated_at: null, contact: { id: "c1", name: "Maria do Ensaio" }, description: "Mensalidade de novembro", ...changes,
});
const overview = (changes = {}, regua = {}) => ({
  regua: { ligada: false, whatsapp: true, email: false, pagamento: "auto", hora_inicio: 8, hora_fim: 18, so_dias_uteis: true, dias_antes: null, no_vencimento: null, dias_depois: null,
    ligada_em: null, ligada_por: null, remetente_ativo: null, ultima_rodada: null, ultimo_erro: null, ...regua },
  email_disponivel: false, pode_mudar: true, aviso: "Com a régua ligada, o sistema manda mensagens de cobrança aos seus clientes sozinho.",
  today: "2026-11-23", now: "2026-11-23T15:00:00.000Z", in_hours: true, next_opening: "2026-11-23T15:00:00.000Z",
  rules: { before: 2, on_due: true, after: 3, source: "preference", grace_days: 3 }, preference_rules: { before: 2, on_due: true, after: 3, source: "preference" },
  today_items: [step()],
  sent: [step({ id: "s2", status: "sent", status_label: "Enviada", sent_at: "2026-11-20T13:00:00.000Z", contact: { id: "c2", name: "João Enviado" } })],
  not_sent: [step({ id: "s3", stage: "after", stage_label: "3 dias depois do vencimento", status: "failed", status_label: "Falhou", contact: { id: "c3", name: "Ana Sem Autorização" },
    reason: "O cliente não escreve há mais de 24 horas. Fora da janela de 24 horas o modelo só vai a quem autorizou avisos de cobrança." })],
  counts: { sent: 1, failed: 1, skipped: 0, cancelled: 0 }, can_write: true, ...changes,
});

function fakePort(overrides = {}) {
  const calls = [];
  const port = {
    access: () => access(),
    overview: async () => { calls.push(["overview"]); return overview(); },
    configure: async (input) => { calls.push(["configure", input]); return overview({}, { ligada: input.ligada, ligada_por: "Pessoa admin", ligada_em: 1, remetente_ativo: true }); },
    recurrences: async () => ({ items: [], runs: [] }),
    setRecurrence: async () => ({ item: {} }),
    ...overrides,
  };
  return { port, calls };
}

test("texto dos dias da régua", () => {
  assert.equal(rulesText({ before: 2, on_due: true, after: 3 }), "2 dias antes, no dia e 3 dias depois do vencimento.");
  assert.equal(rulesText({ before: 1, on_due: false, after: 0 }), "1 dia antes do vencimento.");
  assert.equal(rulesText({ before: 0, on_due: false, after: 0 }), "Nenhum aviso marcado ainda.");
});

test("Financeiro desligado: a tela diz o que ligar e não chama o servidor", async () => {
  const { port, calls } = fakePort({ access: () => access({ finance: false }) });
  const view = await mount(port);
  try {
    assert.match(view.text(), /faz parte do Financeiro, que está desligado/);
    assert.match(view.text(), /Gestão → Módulos/);
  } finally { view.unmount(); }
  assert.equal(calls.length, 0);
});

test("o que vai sair hoje, o que saiu e o que não saiu, com o motivo", async () => {
  const { port } = fakePort();
  const view = await mount(port);
  try {
    const text = view.text();
    assert.match(text, /Desligada/);
    assert.match(text, /2 dias antes, no dia e 3 dias depois do vencimento\. \(os dias de Preferências › Contas a receber\)/);
    assert.match(text, /Das 8h às 18h, só em dia útil/);
    assert.match(text, /Maria do Ensaio/);
    assert.match(text, /R\$ 150,00/);
    assert.match(text, /25\/11\/2026/);
    await view.click("Enviadas (1)");
    assert.match(view.text(), /João Enviado/);
    await view.click("Não saíram (1)");
    assert.match(view.text(), /Ana Sem Autorização/);
    assert.match(view.text(), /autorizou avisos de cobrança/);
  } finally { view.unmount(); }
});

test("ligar: o aviso aparece e precisa ser confirmado; os dias da régua vão junto", async () => {
  const { port, calls } = fakePort();
  const view = await mount(port);
  try {
    await view.click("Ligar e ajustar");
    await view.change("regua-ligada", true);
    assert.match(view.text(), /manda mensagens de cobrança aos seus clientes sozinho/);
    assert.equal(view.button("Ligar a régua").disabled, true);
    await view.change("regua-antes", "1");
    await view.change("regua-confirmo", true);
    assert.equal(view.button("Ligar a régua").disabled, false);
    await view.submit();
    const [, input] = calls.find((c) => c[0] === "configure");
    assert.equal(input.ligada, true);
    assert.equal(input.confirmo, true);
    assert.equal(input.dias_antes, 1);
    assert.equal(input.dias_depois, null);
    assert.match(view.text(), /Régua ligada/);
  } finally { view.unmount(); }
});

test("rodada que não conseguiu falar com o ERP: a tela diz o motivo", async () => {
  const { port } = fakePort({ overview: async () => overview({}, { ligada: true, remetente_ativo: true, ultima_rodada: Date.parse("2026-11-23T14:00:00Z"),
    ultimo_erro: "A régua não conseguiu falar com o ERP: O ERP desta área pede o segundo fator para o seu papel." }) });
  const view = await mount(port);
  try { assert.match(view.text(), /pede o segundo fator.*o sistema tenta de novo sozinho/); } finally { view.unmount(); }
});

test("quem não é administrador vê a configuração, mas não muda; remetente inativo é avisado", async () => {
  const { port, calls } = fakePort({
    access: () => access({}, "financeiro"),
    overview: async () => overview({ pode_mudar: false }, { ligada: true, ligada_por: "Pessoa admin", remetente_ativo: false }),
  });
  const view = await mount(port);
  try {
    assert.match(view.text(), /não é mais administrador ativo/);
    await view.click("Configuração");
    assert.match(view.text(), /Só o administrador da área liga, desliga ou muda a régua/);
    assert.equal(view.nodes().some((n) => n.type === "button" && /Salvar|Ligar a régua/.test(JSON.stringify(n.props.children ?? ""))), false);
  } finally { view.unmount(); }
  assert.equal(calls.length, 0);
});
