// Outros dados do Bling na tela (fatia D): prévia antes de adotar, só os
// conferidos vão para a adoção, módulo desligado diz qual ligar, contrato sem
// a Ordem de Serviço avisa, mão dupla começa desligada e ligar pede o aviso.
// Cliente simulado: nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountComponent } from "../../../web/erp/test/helpers/component-recovery-harness.mjs";
import { adoptionInputs, adoptionOutputs } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_EXTRAS_ENTITIES, BLING_EXTRAS_LABELS, BLING_EXTRAS_TEXTS, BLING_EXTRAS_TWO_WAY, BLING_EXTRAS_TWO_WAY_LABELS } from "../../../src/erp/bling/extras-contracts.ts";

const controller = { getSnapshot: () => ({ phase: "ready", membership: { user_id: "pessoa-teste", role: "admin", resources: [] } }), subscribe: () => () => {} };

function service({ os = false } = {}) {
  const calls = [], switches = new Map();
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input: structuredClone(input) });
    const receipt = { command_id: input.command_id ?? "x", operation: name, replayed: false };
    let value;
    if (name === "erp_bling_extras_status") value = {
      available: true, unavailable_message: null, cutover_on: "2026-11-01",
      entities: BLING_EXTRAS_ENTITIES.map(entity => {
        const off = entity === "operation_natures";
        return { entity, label: BLING_EXTRAS_LABELS[entity], module_names: [off ? "Fiscal" : "Cadastros"], enabled: !off,
          part_off_message: off ? "Para adotar naturezas de operação, ligue o módulo Fiscal em Gestão → Módulos." : null,
          proposed_path: "/caminho-proposto", doubt: "Conferir numa coleta real.", collected: 2, adopted: 0, pending: 0, ignored: 0, waiting: 2 };
      }),
      two_way: BLING_EXTRAS_TWO_WAY.map(entity => {
        const side = direction => ({ enabled: switches.get(`${entity}:${direction}`) === true, since: switches.get(`${entity}:${direction}`) ? "2026-11-20T15:00:00.000Z" : null });
        return { entity, label: BLING_EXTRAS_TWO_WAY_LABELS[entity], enabled: true, part_off_message: null, inbound: side("inbound"), outbound: side("outbound"), queued: 0, uncertain: 0, failed: 0 };
      }),
      audit: [], texts: { ...BLING_EXTRAS_TEXTS } };
    else if (name === "erp_bling_extras_outbox") value = { items: [] };
    else if (name === "erp_bling_extras_preview") value = { items: [
      { source_id: "8001", label: "Atacado", outcome: "create", outcome_text: "Vai criar no ERP", reason_text: null, bling: { "Nome": "Atacado", "Produtos": "1" }, erp: null, record_id: null },
      { source_id: "8002", label: "Formato estranho", outcome: "pending", outcome_text: "Fica pendente de revisão", reason_text: "O registro veio do Bling num formato que ainda não foi conferido.", bling: { "Nome": "Formato estranho" }, erp: null, record_id: null },
    ], next_cursor: null, notice: BLING_EXTRAS_TEXTS.collect };
    else if (name === "erp_bling_extras_reviews") value = { items: [], next_cursor: null };
    else if (name === "erp_bling_extras_adopt") value = { counts: { processed: input.source_ids?.length ?? 0, adopted: input.source_ids?.length ?? 0, linked: 0, pending: 0, skipped: 0 }, more: false, messages: [], receipt };
    else if (name === "erp_bling_extras_contracts") value = { items: [{ source_id: "9701", version: "1", number: "15", description: "Manutenção", customer: { name: "Cliente Bling", document: null, phone: "11999990000", email: null },
      starts_on: "2026-01-01", ends_on: null, value: "150.00", periodicity: "Mensal", period: "month", situation: "Ativo", problems: [], link: null }], next_cursor: null };
    else if (name === "erp_bling_extras_contract_options") value = { draft: (await client.execute("erp_bling_extras_contracts", {})).items[0], modules: { os, mensalidade: os },
      missing: os ? null : "Ligue o módulo Ordem de Serviço em Gestão → Módulos para criar o contrato de manutenção.", plans: [], contacts: [] };
    else if (name === "erp_bling_extras_switch") { switches.set(`${input.entity}:${input.direction}`, input.enabled); value = { entity: input.entity, direction: input.direction, enabled: input.enabled, since: input.enabled ? "2026-11-20T15:00:00.000Z" : null, receipt }; }
    else throw new Error("operação inesperada " + name);
    return adoptionOutputs[name].parse(value);
  } };
  return { client, calls };
}
const mount = (server, administrator = true) => mountComponent("ExtrasBling.tsx", { client: server.client, controller, administrator, onCutover: () => {}, onAdopt: () => {} }, { componentName: "ExtrasBling", expandChildren: true });

test("prévia antes de adotar; só os conferidos vão para a adoção; formato não conferido fica pendente", async () => {
  const server = service();
  const view = await mount(server);
  try {
    assert.match(view.text(), /desligados e não confirmados até o dono conferir/);
    assert.match(view.text(), /ligue o módulo Fiscal/);
    await view.change("extras-entity", "price_lists");
    await view.click("Ver a prévia");
    assert.equal(server.calls.filter(call => call.name === "erp_bling_extras_adopt").length, 0, "prévia não grava");
    assert.match(view.text(), /Atacado — Vai criar no ERP/);
    assert.match(view.text(), /formato que ainda não foi conferido/);
    await view.click("Adotar os conferidos nesta prévia");
    const adopt = server.calls.find(call => call.name === "erp_bling_extras_adopt");
    assert.deepEqual(adopt.input.source_ids, ["8001"]);
    assert.equal(adopt.input.entity, "price_lists");
  } finally { view.unmount(); }
});

test("contrato sem a Ordem de Serviço diz qual módulo ligar; mão dupla começa desligada e ligar pede o aviso", async () => {
  const server = service({ os: false });
  const view = await mount(server);
  try {
    await view.click("Ver os contratos coletados");
    assert.match(view.text(), /Contrato 15/);
    await view.click("Conferir e preparar o contrato de manutenção");
    assert.match(view.text(), /Ligue o módulo Ordem de Serviço/);
    for (const entity of BLING_EXTRAS_TWO_WAY) for (const direction of ["inbound", "outbound"]) assert.equal(view.input(`extras-${direction}-${entity}`).props.checked, false);
    await view.change("extras-outbound-price_lists", true);
    assert.equal(server.calls.filter(call => call.name === "erp_bling_extras_switch").length, 0, "marcar só abre o aviso");
    assert.equal(view.button("Ligar").disabled, true);
    await view.change("extras-ack", true);
    await view.click("Ligar");
    const call = server.calls.find(item => item.name === "erp_bling_extras_switch");
    assert.deepEqual([call.input.entity, call.input.direction, call.input.enabled, call.input.acknowledged], ["price_lists", "outbound", true, true]);
  } finally { view.unmount(); }
});

test("sem administrador a aba só explica quem configura", async () => {
  const view = await mount(service(), false);
  try { assert.match(view.text(), /feita por um administrador do ERP/); } finally { view.unmount(); }
});
