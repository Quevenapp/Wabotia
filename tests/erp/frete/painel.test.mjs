// Tela do frete (web/erp/Frete.tsx) no harness do painel: componentes e
// handlers reais, porta simulada, nenhuma rede. No pedido: cotar, escolher o
// serviço (o aviso diz se o valor entrou no pedido), contratar o envio e a
// resposta incerta que pede "Confirmar com o provedor"; a linha do tempo do
// rastreio. Na aba de provedores: só o administrador configura; a credencial
// digitada vai para o servidor e nunca volta para a tela.
import { test } from "node:test";
import assert from "node:assert/strict";

const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
globalThis.window ??= { confirm: () => true, prompt: () => "" };
const ORDER = "6f1b8a52-6d0e-4c7e-9a33-1f0d7d1a2b3c";
const mount = (componentName, props) => mountComponent("../../Frete.tsx", props, { componentName, expandChildren: true });
const button = (view, label) => view.find((n) => n.type === "button" && JSON.stringify(n.props.children ?? "").includes(label));

const freight = (changes = {}) => ({
  can_write: true, order: { id: ORDER, number: 12, ship_status: "packed", freight: "0.00", delivery_days: null, freight_editable: true, tracking_code: null },
  choice: null, shipment: null, events: [], providers: [{ id: "correios", name: "Correios" }], notify_whatsapp: false, ...changes,
});
const quote = {
  id: "q1", order: { id: ORDER, number: 12 }, from_postal_code: "01001000", to_postal_code: "20040002", volumes: 1, weight_g: 900, declared_cents: 6000,
  options: [{ option: "correios:03298", provider: "correios", provider_name: "Correios", sandbox: true, service_code: "03298", service_name: "PAC", company: "Correios", price_cents: 2140, delivery_days: 6 }],
  errors: [{ provider: "melhorenvio", provider_name: "Melhor Envio", message: "O Melhor Envio não respondeu. Tente de novo em instantes." }], expires: 0, freight_editable: true,
};
const choice = { quote_id: "q1", provider: "correios", sandbox: true, service_code: "03298", service_name: "PAC", company: "Correios", price_cents: 2140, delivery_days: 6, applied: true, apply_message: null, chosen: 1 };
const shipment = (changes = {}) => ({ id: "s1", provider: "correios", provider_name: "Correios", sandbox: true, service_code: "03298", service_name: "PAC", price_cents: 2140,
  status: "contracted", status_label: "Contratado", tracking_code: "AB123456789BR", label_ready: true, tracking_status: "posted", tracking_label: "Postado", tracking_at: null,
  shipped_at: null, delivered_at: null, error: null, created: 1, ...changes });

function fakePort(overrides = {}) {
  const calls = [];
  const port = {
    order: async () => freight(),
    quote: async (id) => { calls.push(["quote", id]); return quote; },
    choose: async (id, input) => { calls.push(["choose", id, input]); return { ...freight({ choice }), applied: true, message: null }; },
    contract: async (id) => { calls.push(["contract", id]); return { ...freight({ choice, shipment: shipment() }), repeated: false, notes: [] }; },
    cancel: async () => freight({ choice, shipment: shipment({ status: "cancelled", status_label: "Cancelado", label_ready: false }) }),
    track: async () => ({ ...freight({ choice, shipment: shipment() }), added: 0 }),
    label: async () => new Uint8Array([0x25, 0x50]),
    providers: async () => ({ providers: [], settings: { notify_whatsapp: false, origin_postal_code: null, updated: null } }),
    ...overrides,
  };
  return { port, calls };
}

test("no pedido: cota, escolhe o serviço e contrata o envio com a etiqueta oficial", async () => {
  const { port, calls } = fakePort();
  const view = await mount("FreteDoPedido", { port, order: ORDER, role: "vendas" });
  try {
    assert.match(view.text(), /Frete e etiqueta oficial/);
    await button(view, "Cotar frete").props.onClick();
    await view.flush();
    assert.match(view.text(), /PAC/);
    assert.match(view.text(), /R\$\s?21,40/);
    assert.match(view.text(), /6 dias úteis/);
    assert.match(view.text(), /O Melhor Envio não respondeu/, "o provedor que falhou aparece com o motivo");
    await button(view, "Usar este serviço").props.onClick();
    await view.flush();
    assert.deepEqual(calls.find((c) => c[0] === "choose")[2], { cotacao: "q1", servico: "correios:03298" });
    assert.match(view.text(), /O valor do frete e o prazo foram para o pedido/);
    await button(view, "Contratar envio e gerar etiqueta").props.onClick();
    await view.flush();
    assert.ok(calls.some((c) => c[0] === "contract"));
    assert.match(view.text(), /Envio contratado. Rastreio AB123456789BR/);
    assert.ok(button(view, "Baixar etiqueta oficial (PDF)"));
    assert.ok(button(view, "Cancelar envio"));
  } finally { view.unmount(); }
});

test("no pedido: resposta incerta pede para confirmar com o provedor; o rastreio aparece na linha do tempo", async () => {
  const { port, calls } = fakePort({
    order: async () => freight({ choice, shipment: shipment({ status: "uncertain", status_label: "Confirmando com o provedor", tracking_code: null, label_ready: false,
      error: "Os Correios não responderam. O envio pode ter sido feito lá: o Wabotia consulta antes de tentar de novo." }) }),
  });
  const view = await mount("FreteDoPedido", { port, order: ORDER, role: "admin" });
  try {
    assert.match(view.text(), /A resposta do provedor não chegou/);
    assert.throws(() => button(view, "Contratar envio e gerar etiqueta"), "não oferece contratar às cegas");
    await button(view, "Confirmar com o provedor").props.onClick();
    await view.flush();
    assert.ok(calls.some((c) => c[0] === "contract"));
  } finally { view.unmount(); }
  const tracked = fakePort({ order: async () => freight({ choice, shipment: shipment({ shipped_at: 1 }), notify_whatsapp: true,
    events: [{ id: "e1", at: Date.parse("2026-11-21T12:00:00Z"), code: "PO", status: "posted", status_label: "Postado", description: "Objeto postado", location: "São Paulo/SP", notified: true }] }) });
  const second = await mount("FreteDoPedido", { port: tracked.port, order: ORDER, role: "consulta" });
  try {
    assert.match(second.text(), /Rastreio/);
    assert.match(second.text(), /Postado: Objeto postado \(São Paulo\/SP\)/);
    assert.match(second.text(), /cliente avisado/);
    assert.throws(() => button(second, "Cancelar envio"), "o papel consulta só consulta");
  } finally { second.unmount(); }
});

test("sem provedor ligado: a tela diz quem liga e onde", async () => {
  const { port } = fakePort({ order: async () => freight({ providers: [] }) });
  const view = await mount("FreteDoPedido", { port, order: ORDER, role: "admin" });
  try {
    assert.match(view.text(), /Nenhum provedor de frete está ligado. O administrador liga os Correios ou o Melhor Envio em Expedição › Frete e transportadoras/);
  } finally { view.unmount(); }
});

test("provedores: só o administrador; a credencial digitada vai para o servidor e a tela mostra só que está guardada", async () => {
  const provider = (saved) => ({ id: "melhorenvio", name: "Melhor Envio", enabled: false, sandbox: true, sandbox_available: true, options: { email: "t@e.com" },
    secret_fields: [{ key: "token", label: "Token da conta", hint: "Gerado no Melhor Envio.", saved }], option_fields: [{ key: "email", label: "E-mail técnico", hint: "Contato.", required: true }],
    ready: saved, check: null, updated: null });
  const saves = [];
  const { port } = fakePort({
    providers: async () => ({ providers: [provider(false)], settings: { notify_whatsapp: false, origin_postal_code: null, updated: null } }),
    saveProvider: async (id, input) => { saves.push([id, input]); return { providers: [provider(true)], settings: { notify_whatsapp: false, origin_postal_code: null, updated: null } }; },
  });
  const denied = await mount("FreteProvedores", { port, role: "vendas" });
  try { assert.match(denied.text(), /Só o administrador do ERP liga e configura os provedores/); } finally { denied.unmount(); }
  const view = await mount("FreteProvedores", { port, role: "admin" });
  try {
    assert.match(view.text(), /Melhor Envio/);
    assert.match(view.text(), /desligado/);
    view.find((n) => n.type === "input" && n.props.type === "password").props.onChange({ target: { value: "token-secreto" } });
    await view.flush();
    await button(view, "Gravar").props.onClick();
    await view.flush();
    assert.deepEqual(saves[0], ["melhorenvio", { credenciais: { token: "token-secreto" }, opcoes: { email: "t@e.com" } }]);
    const field = view.find((n) => n.type === "input" && n.props.type === "password");
    assert.equal(field.props.value, "", "a credencial não volta para a tela");
    assert.equal(field.props.placeholder, "guardado no cofre");
    assert.ok(!view.text().includes("token-secreto"));
  } finally { view.unmount(); }
});
