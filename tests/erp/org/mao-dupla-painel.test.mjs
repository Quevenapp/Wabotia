// Mão dupla na tela: interruptores desligados, ligar só com o aviso confirmado,
// fila de saída, conflitos com os dois lados e as ações, sem corte a tela diz o
// que fazer. Cliente simulado: nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountComponent } from "../../../web/erp/test/helpers/component-recovery-harness.mjs";
import { adoptionInputs, adoptionOutputs } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_TWO_WAY_ENTITIES, BLING_TWO_WAY_LABELS, BLING_TWO_WAY_TEXTS } from "../../../src/erp/bling/two-way-contracts.ts";

const controller = { getSnapshot: () => ({ phase: "ready", membership: { user_id: "pessoa-teste", role: "admin", resources: [] } }), subscribe: () => () => {} };

function service({ cutover = true, stockOn = true, issues = [] } = {}) {
  const calls = [];
  const switches = new Map();
  const client = { async execute(name, input) {
    adoptionInputs[name].parse(input); calls.push({ name, input: structuredClone(input) });
    const receipt = { command_id: input.command_id ?? "x", operation: name, replayed: false };
    let value;
    if (name === "erp_bling_twoway_status") value = {
      available: true, unavailable_message: null, cutover: { confirmed: cutover, cutover_on: cutover ? "2026-11-15" : null }, pace_minutes: 15,
      entities: BLING_TWO_WAY_ENTITIES.map(entity => {
        const off = entity === "stock_balances" && !stockOn;
        const side = direction => ({ enabled: switches.get(`${entity}:${direction}`) === true, since: switches.get(`${entity}:${direction}`) ? "2026-11-20T15:00:00.000Z" : null });
        return { entity, label: BLING_TWO_WAY_LABELS[entity], module_name: off ? "Estoque" : "Cadastros", enabled: !off,
          part_off_message: off ? "Para a mão dupla de saldos de estoque, ligue o módulo Estoque em Gestão → Módulos." : null,
          inbound: side("inbound"), outbound: side("outbound"), queued: entity === "contacts" ? 1 : 0, uncertain: 0, failed: 0, issues: 0 };
      }),
      last_in: { at: "2026-11-20T15:00:00.000Z", counts: { applied: 3, conflicts: 1 } }, last_out: { at: null, counts: {} },
      queue: { pending: 1, sending: 0, uncertain: 0, held: 0, done: 0, failed: 0, superseded: 0 }, issues: { open: issues.length, conflicts: issues.filter(i => i.kind === "conflict").length },
      audit: [...switches].filter(([, on]) => on).map(([key]) => ({ at: "2026-11-20T15:00:00.000Z", by: "Dona da loja", entity: key.split(":")[0], direction: key.split(":")[1], enabled: true, detail: `Ligou "${key.endsWith("outbound") ? "Escrever no Bling" : "Receber do Bling"}" para contatos (aviso confirmado).` })),
      texts: { ...BLING_TWO_WAY_TEXTS } };
    else if (name === "erp_bling_twoway_queue") value = { items: [{ id: "update.contacts.r1.abcd", entity: "contacts", label: "Contato Ana Souza Lima", op: "update", op_text: "Atualizar no Bling",
      state: "done", state_text: "Gravado no Bling", attempts: 1, checks: 1, not_before: null, sent_at: "2026-11-20T15:00:00.000Z", updated_at: "2026-11-20T15:00:00.000Z", remote_id: null,
      error_text: "O Bling não respondeu a tempo. Antes de tentar de novo, o sistema confere no Bling se a mudança entrou." }], next_cursor: null };
    else if (name === "erp_bling_twoway_issues") value = { items: issues, next_cursor: null, total: issues.length };
    else if (name === "erp_bling_twoway_switch") { switches.set(`${input.entity}:${input.direction}`, input.enabled); value = { entity: input.entity, direction: input.direction, enabled: input.enabled, since: input.enabled ? "2026-11-20T15:00:00.000Z" : null, receipt }; }
    else if (name === "erp_bling_twoway_pace") value = { minutes: input.minutes, receipt };
    else if (name === "erp_bling_twoway_resolve") value = { outcome: input.action === "use_erp" ? "queued" : "confirmed", message: input.action === "use_erp" ? "Usada a versão do ERP: ela foi para a fila de saída e vai ser gravada no Bling." : "Marcado como gravado no Bling. Nada vai ser reenviado.", receipt };
    else throw new Error("operação inesperada " + name);
    return adoptionOutputs[name].parse(value);
  } };
  return { client, calls };
}
const mount = (server, administrator = true) => mountComponent("TwoWayBling.tsx", { client: server.client, controller, administrator, onCutover: () => {} }, { componentName: "TwoWayBling", expandChildren: true });

test("interruptores começam desligados; ligar só com o aviso confirmado; desligar é direto", async () => {
  const server = service();
  const view = await mount(server);
  try {
    const text = view.text();
    assert.match(text, /todos começam desligados/);
    assert.match(text, /Notas fiscais e ordens de serviço nunca são escritas no Bling/);
    assert.match(text, /bruto.*espelho histórico.*adotado/s);
    for (const entity of BLING_TWO_WAY_ENTITIES) for (const direction of ["inbound", "outbound"]) assert.equal(view.input(`twoway-${direction}-${entity}`).props.checked, false);
    await view.change("twoway-outbound-contacts", true);
    assert.equal(server.calls.filter(c => c.name === "erp_bling_twoway_switch").length, 0, "marcar só abre o aviso");
    assert.match(view.text(), /mudanças feitas daqui para a frente nos registros escolhidos serão gravadas na sua conta do Bling/);
    assert.equal(view.button("Ligar").disabled, true, "sem o aceite");
    await view.change("twoway-ack", true);
    await view.click("Ligar");
    const on = server.calls.find(c => c.name === "erp_bling_twoway_switch");
    assert.deepEqual([on.input.entity, on.input.direction, on.input.enabled, on.input.acknowledged], ["contacts", "outbound", true, true]);
    assert.match(view.text(), /Ficou registrado com seu nome e a hora/);
    assert.match(view.text(), /Dona da loja: Ligou "Escrever no Bling"/);
    assert.equal(view.input("twoway-outbound-contacts").props.checked, true);
    await view.change("twoway-outbound-contacts", false);
    const off = server.calls.filter(c => c.name === "erp_bling_twoway_switch").at(-1);
    assert.deepEqual([off.input.enabled, off.input.acknowledged], [false, undefined]);
    assert.match(view.text(), /O que já estava na fila fica parado/);
    assert.match(view.text(), /Contato Ana Souza Lima/); assert.match(view.text(), /Gravado no Bling/);
    assert.match(view.text(), /3 mudança\(s\) aplicada\(s\) no ERP, 1 conflito\(s\)/);
    assert.doesNotMatch(view.text(), /Fagoo|Origin/);
  } finally { view.unmount(); }
});

test("conflito mostra os dois lados e as escolhas; envio sem confirmação pede o id para dizer que entrou", async () => {
  const issues = [
    { key: "conflict:contacts:r1", kind: "conflict", kind_text: "Mudou nos dois lados", entity: "contacts", label: "Contato Ana Souza", state: "open",
      reason: "Este registro mudou no ERP e no Bling desde a última sincronização. Nada foi sobrescrito: escolha qual versão vale.",
      erp: { "Nome": "Ana Souza (ERP)", "E-mail": "ana@exemplo.com" }, bling: { "Nome": "Ana Souza (Bling)", "E-mail": "ana@exemplo.com" },
      actions: [{ action: "use_bling", label: "Usar a do Bling" }, { action: "use_erp", label: "Usar a do ERP" }], created_at: "2026-11-20T15:00:00.000Z", resolution: null },
    { key: "out:create.contacts.r2.abcd", kind: "uncertain", kind_text: "Não deu para confirmar no Bling", entity: "contacts", label: "Contato Bruno Novo", state: "open",
      reason: "O Bling não respondeu a tempo e este registro não tem código, documento ou número para conferir lá.", erp: { "Nome": "Bruno Novo" }, bling: null,
      actions: [{ action: "confirm_sent", label: "Entrou no Bling" }, { action: "resend", label: "Não entrou: enviar de novo" }], created_at: "2026-11-20T15:00:00.000Z", resolution: null },
  ];
  const server = service({ issues });
  const view = await mount(server);
  try {
    const text = view.text();
    assert.match(text, /Mudou nos dois lados: Contato Ana Souza/);
    assert.match(text, /Ana Souza \(ERP\)/); assert.match(text, /Ana Souza \(Bling\)/);
    assert.match(text, /No ERP/); assert.match(text, /No Bling/);
    await view.click("Usar a do ERP");
    assert.deepEqual(server.calls.find(c => c.name === "erp_bling_twoway_resolve").input.action, "use_erp");
    assert.match(view.text(), /foi para a fila de saída/);
    await view.change("twoway-remote-out:create.contacts.r2.abcd", "900123");
    await view.click("Entrou no Bling");
    const confirm = server.calls.filter(c => c.name === "erp_bling_twoway_resolve").at(-1);
    assert.deepEqual([confirm.input.action, confirm.input.remote_id], ["confirm_sent", "900123"]);
  } finally { view.unmount(); }
});

test("sem a data de corte a tela diz o que fazer; parte desligada diz qual módulo ligar; ritmo validado", async () => {
  const server = service({ cutover: false, stockOn: false });
  const view = await mount(server);
  try {
    assert.match(view.text(), /A mão dupla só funciona depois do corte\. Confirme a data de corte em Passar a operar aqui/);
    assert.equal(view.input("twoway-outbound-contacts").disabled, true);
    assert.match(view.text(), /ligue o módulo Estoque em Gestão → Módulos/);
    await view.change("twoway-pace", "3");
    assert.match(view.text(), /Use um número inteiro de 5 a 1440 minutos/);
    assert.equal(view.button("Salvar ritmo").disabled, true);
    await view.change("twoway-pace", "30");
    await view.click("Salvar ritmo");
    assert.equal(server.calls.find(c => c.name === "erp_bling_twoway_pace").input.minutes, 30);
  } finally { view.unmount(); }
  const visitor = await mount(service(), false);
  try { assert.match(visitor.text(), /configurada por um administrador do ERP/); } finally { visitor.unmount(); }
});
