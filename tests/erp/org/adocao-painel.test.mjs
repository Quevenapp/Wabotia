// Tela "Adotar cadastros" (fatia B1) com cliente simulado: nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountComponent } from "../../../web/erp/test/helpers/component-recovery-harness.mjs";
import { adoptionInputs, adoptionOutputs, BLING_ADOPTION_ENTITIES, BLING_ADOPTION_LABELS, BLING_ADOPTION_REASONS } from "../../../src/erp/bling/adoption-contracts.ts";

const controller = { getSnapshot: () => ({ phase: "ready", membership: { user_id: "pessoa-teste", role: "admin", resources: [] } }), subscribe: () => () => {} };
const off = new Set(["products", "product_categories"]);
const entities = BLING_ADOPTION_ENTITIES.map(entity => ({ entity, label: BLING_ADOPTION_LABELS[entity], module: off.has(entity) ? "erp-produtos" : "erp",
  module_name: off.has(entity) ? "Produtos e serviços" : "Cadastros", enabled: !off.has(entity),
  part_off_message: off.has(entity) ? `Para adotar ${BLING_ADOPTION_LABELS[entity].toLowerCase()}, ligue o módulo Produtos e serviços em Gestão → Módulos.` : null,
  updatable: entity === "contacts", collected: entity === "contacts" ? 3 : 0, waiting: entity === "contacts" ? 1 : 0, adopted: entity === "contacts" ? 1 : 0, pending: entity === "contacts" ? 1 : 0, ignored: 0 }));
const idle = { state: "idle", entities: [], current: null, counts: { processed: 0, adopted: 0, linked: 0, pending: 0, skipped: 0 }, revision: "0", started_at: null, updated_at: null, finished_at: null, stop: null };
const review = { entity: "contacts", source_id: "102", state: "pending", reason: "divergent", reason_text: BLING_ADOPTION_REASONS.divergent, detail: null, source_version: "1",
  bling: { "Nome": "Nome Novo", "CPF/CNPJ": "39053344705" }, erp: [{ record_id: "0b8f9d8e-1111-4222-8333-444455556666", summary: { "Nome": "Nome Antigo", "CPF/CNPJ": "390.533.447-05" } }] };

function service() {
  const calls = [];
  let job = idle;
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input: structuredClone(input) });
    const receipt = { command_id: input.command_id ?? "x", operation: name, replayed: false };
    let value;
    if (name === "erp_bling_adoption_status") value = { available: true, unavailable_message: null, job, entities };
    else if (name === "erp_bling_adoption_start") { job = { ...idle, state: "done", entities: input.entities, counts: { ...idle.counts, processed: 1 }, revision: "1", finished_at: "2026-11-20T15:00:00.000Z" }; value = { job, receipt }; }
    else if (name === "erp_bling_adoption_reviews") value = { items: [review], next_cursor: null };
    else if (name === "erp_bling_adoption_resolve") value = { outcome: "linked", record_id: input.record_id ?? null, receipt };
    else throw new Error("operação inesperada " + name);
    return adoptionOutputs[name].parse(value);
  } };
  return { client, calls };
}
const mount = (server, administrator = true) => mountComponent("AdoptBling.tsx", { client: server.client, controller, administrator }, { componentName: "AdoptBling", expandChildren: true });

test("mostra os três estados por entidade, avisa o módulo a ligar e adota em lote o que foi marcado", async () => {
  const server = service(), view = await mount(server);
  try {
    const text = view.text();
    assert.match(text, /Coletado/); assert.match(text, /Adotado/); assert.match(text, /Pendente de revisão/);
    assert.match(text, /ligue o módulo Produtos e serviços em Gestão → Módulos/);
    assert.doesNotMatch(text, /Fagoo|Origin|Não foi possível concluir a operação/);
    assert.equal(view.input("adopt-products").disabled, true);
    await view.change("adopt-contacts", true);
    await view.click("Adotar em lote as entidades marcadas");
    const start = server.calls.find(call => call.name === "erp_bling_adoption_start");
    assert.deepEqual(start.input.entities, ["contacts"]);
    assert.match(view.text(), /Lote concluído/);
  } finally { view.unmount(); }
});

test("pendência mostra o motivo e as duas versões lado a lado; manter a do ERP liga ao cadastro escolhido", async () => {
  const server = service(), view = await mount(server);
  try {
    await view.click(`Ver pendências de ${BLING_ADOPTION_LABELS.contacts}`);
    const text = view.text();
    assert.match(text, /Já existe um cadastro parecido no ERP/);
    assert.match(text, /No Bling/); assert.match(text, /No ERP/); assert.match(text, /Nome Novo/); assert.match(text, /Nome Antigo/);
    assert.ok(view.nodes().some(node => node.type === "button" && /Usar a do Bling neste cadastro/.test(JSON.stringify(node.props.children))));
    await view.click("Manter a do ERP e ligar");
    const resolve = server.calls.find(call => call.name === "erp_bling_adoption_resolve");
    assert.equal(resolve.input.action, "keep_erp"); assert.equal(resolve.input.record_id, review.erp[0].record_id); assert.equal(resolve.input.source_id, "102");
    assert.match(view.text(), /Ligado ao cadastro do ERP/);
  } finally { view.unmount(); }
});

test("sem administrador, explica e não chama o servidor", async () => {
  const server = service(), view = await mount(server, false);
  try {
    assert.match(view.text(), /exige um administrador/);
    assert.equal(server.calls.length, 0);
  } finally { view.unmount(); }
});
