import test from "node:test";
import assert from "node:assert/strict";
import { orderRecipient, carrierValues, parcelCard, withForma } from "../../../web/erp/app/lib/fiscal-invoice-form-model.ts";
import { sectionEntries } from "../../../web/erp/app/lib/preferences-model.ts";
import { preferencePage } from "../../../packages/erp-domain/src/preferences/catalog.mjs";
import { installErpPorts } from "../../../web/erp/ports.ts";
import {
  createCommercialNfePort, createCommandIntent, canCommercialNfe, checkEmission,
  emissionCanEmit, correctionTarget, CommercialNfeError,
} from "../../../web/erp/commercial-nfe.ts";

const orderId = "11111111-1111-4111-8111-111111111111";
const emissionId = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";
const personId = "44444444-4444-4444-8444-444444444444";
const natureId = "55555555-5555-4555-8555-555555555555";
const timestamp = "1795089600000000";
const bodyHash = "a".repeat(64);
const access = (changes = {}) => ({ ready: true, role: "admin", permissions: null,
  parts: { base: true, products: true, sales: true, fiscal: true, stock: true, finance: true }, ...changes });
const blocker = { code: "fiscal_product_incomplete", field: "ncm", item_id: "item-1", entity_id: "produto-1",
  message: "O produto Mercadoria está sem NCM, necessário para esta operação.",
  correction: { screen: "products", id: "produto-1", field: "ncm" } };
function effect(axis = "stock", changes = {}) {
  return { emission_id: emissionId, axis, state: "pendente", origin: null, ids: {}, fingerprint: null,
    reason: "Dados locais pendentes", responsible_role: axis === "stock" ? "estoque" : "financeiro",
    person_id: null, command_id: null, result: null, compensation_state: null,
    compensation_command_id: null, compensation_result: null, updated_at: timestamp, ...changes };
}
function emission(changes = {}) {
  return {
    id: emissionId, document_id: orderId, fiscal_version: 1, environment: "homologacao", environment_confirmed: false,
    connection_fingerprint: "b".repeat(64), reference: `wb.${orderId}.v1`, current_body_revision: 1,
    status: "preparada", version: 1, provider_id: null, provider_status: null, messages: [], series: null,
    number: null, access_key: null, protocol: null, issued_at: null, authorized_at: null, total: "5100",
    created_at: timestamp, created_by: personId, updated_at: timestamp,
    revision: { emission_id: emissionId, body_revision: 1, source_document_version: 1,
      snapshot: { document: { id: orderId, number: "PV-1" }, items: [{ description: "Mercadoria", quantity: "2" }],
        company: { name: "Empresa de ensaio" }, recipient: { name: "Cliente de ensaio" }, products: [], nature: {},
        payments: [], transport: {}, sources: [] }, tax_sources: {}, commercial_hash: bodyHash,
      source_fingerprint: bodyHash, body: { referencia: `wb.${orderId}.v1` }, body_hash: bodyHash,
      calculation: { total_cents: "5100" }, blockers: [], prepared_by: personId, prepared_at: timestamp },
    effects: [effect(), effect("finance")], cancellation: null, ...changes,
  };
}
function authorized(changes = {}) {
  return emission({ status: "autorizada", environment_confirmed: true, provider_id: "nfe-do-cofre",
    access_key: "35261111222333000181550010000000011000000010", protocol: "135260000000001",
    number: 1, series: 1, version: 2, ...changes });
}
const emitInput = () => ({ emission_id: emissionId, expected_version: 1, body_revision: 1, body_hash: bodyHash });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const portWith = (fetch, options = {}) => createCommercialNfePort("area-de-ensaio", { fetch, access: () => access(), ...options });

test("Preferências explicam o cofre sem alterar valores legados ou consultar numeração local", t => {
  t.after(installErpPorts({ commercialNfe: {} }));
  const page = preferencePage("notas-nfe"), original = structuredClone(page);
  const numbering = sectionEntries(page, "numeracao").find(entry => entry.id === "nfe.numeracao");
  assert.equal(numbering.source, undefined);
  assert.equal(numbering.link.to, "/certificado-a1");
  assert.match(numbering.text, /não mantém próximo número fiscal/);
  assert.match(sectionEntries(page, "emissao").find(entry => entry.id === "nfe.ambiente").text, /habilitar produção exige confirmação de administrador/);
  const stock = sectionEntries(page, "gerais").find(entry => entry.key === "nfe.lancar_estoque");
  assert.match(stock.note, /confirmação do retorno físico/);
  assert.equal(stock.default, page.fields.find(entry => entry.key === stock.key).default);
  assert.deepEqual(page, original);
  const certificate = sectionEntries(preferencePage("certificado-digital"), "tipos").find(entry => entry.id === "certificado.a1_servidor");
  assert.match(certificate.text, /diretamente no cofre NFapi/);
  assert.match(certificate.text, /não recebe o certificado nem assina/);
});

test("formulário preserva CNPJ alfanumérico do cadastro e valida seus dígitos verificadores", () => {
  const formatted = "12.abc.345/01de-35", normalized = "12ABC34501DE35";
  const contact = { contact_id: personId, name: "Cliente transportador", document: formatted, person_type: "J" };
  assert.equal(orderRecipient(contact).document, normalized);
  assert.equal(carrierValues(contact).document, normalized);
  assert.equal(parcelCard({ details: { acquirer_cnpj: formatted } }).cnpj, normalized);
  const method = { id: "forma", description: "Cartão", payment_type: "03", card_brand: "01", card_integration: "2", card_cnpj: formatted };
  assert.equal(withForma({}, "pm:forma", [method]).card.cnpj, normalized);
  for (const document of ["12ABC34501DE34", "12ABC34501DEAA", "00000000000000", "19131243000196"]) {
    assert.equal(orderRecipient({ ...contact, document }).document, undefined);
    assert.equal(carrierValues({ ...contact, document }).document, undefined);
    assert.equal(parcelCard({ details: { acquirer_cnpj: document } }), null);
    assert.equal(withForma({}, "pm:forma", [{ ...method, card_cnpj: document }]).card.cnpj, undefined);
  }
  assert.equal(orderRecipient({ ...contact, document: "19.131.243/0001-97" }).document, "19131243000197");
  assert.equal(orderRecipient({ ...contact, person_type: "F", document: "529.982.247-25" }).document, "52998224725");
});

test("listagem aceita o resumo público sem snapshot e exige detalhe completo para revisão", async () => {
  const summary = emission();
  for (const field of ["snapshot", "tax_sources", "body", "calculation"]) delete summary.revision[field];
  const port = portWith(async () => Response.json({ items: [summary], page: 1, per_page: 25, total: 1 }));
  const listed = await port.list({ environment: "homologacao" });
  assert.equal(listed.items[0].id, emissionId);
  assert.equal(Object.hasOwn(listed.items[0].revision, "snapshot"), false);
  assert.throws(() => checkEmission(summary), { code: "fiscal_invalid_response" });
  await assert.rejects(port.list({ environment: "producao" }), { code: "fiscal_invalid_response" });
});

test("preparação bloqueada HTTP 422 preserva revisão, correções e prévia dos efeitos", async () => {
  const blocked = emission({ status: "bloqueada" });
  Object.assign(blocked.revision, { body: null, body_hash: null, blockers: [blocker] });
  const result = { emission: blocked, blockers: [blocker], effects_preview: blocked.effects, replayed: false };
  const port = portWith(async () => Response.json(result, { status: 422 }));
  const prepared = await port.prepare({ document_id: orderId, expected_document_version: 1, command_id: commandId,
    choices: { nature_id: natureId, presence: "presencial", final_consumer: true } });
  assert.equal(prepared.emission.status, "bloqueada");
  assert.deepEqual(prepared.blockers, [blocker]);
  assert.equal(prepared.effects_preview.length, 2);
  assert.equal(emissionCanEmit(prepared.emission, access()), false);
});

test("o mesmo comando compartilha chamada e conserva UUID e argumentos após resposta perdida", async () => {
  const wait = deferred(), received = [];
  const intent = createCommandIntent(() => commandId);
  const send = async input => { received.push(input); return wait.promise; };
  const first = intent.run(emitInput(), send), second = intent.run(emitInput(), send);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(received.length, 1);
  const lost = assert.rejects(first, /resposta perdida/);
  wait.reject(new Error("resposta perdida"));
  await lost;
  assert.equal(intent.commandId, commandId);
  await intent.run(emitInput(), async input => { received.push(input); return authorized(); });
  assert.deepEqual(received[0], received[1]);
  assert.equal(received[1].command_id, commandId);
  await assert.rejects(intent.run({ ...emitInput(), body_hash: "c".repeat(64) }, send), { code: "fiscal_command_conflict" });
  intent.reset(); assert.equal(intent.commandId, null);
});

test("duas abas, retry e efeitos usam uma emissão e um lançamento no servidor simulado", async () => {
  const receipts = new Map(), references = new Set(), postings = new Set();
  let loseResponse = true;
  const port = portWith(async (url, init) => {
    const body = JSON.parse(init.body), route = new URL(url, "https://painel.invalid").pathname;
    assert.equal(init.headers["Idempotency-Key"], body.command_id);
    if (route.endsWith("/emitir")) {
      references.add(`wb.${orderId}.v1`);
      receipts.set(body.command_id, authorized());
      if (loseResponse) { loseResponse = false; throw new Error("resposta perdida depois do registro"); }
      return Response.json(receipts.get(body.command_id));
    }
    if (route.endsWith("/efeitos")) {
      postings.add(`${emissionId}:${body.axis}`);
      return Response.json(effect(body.axis, { state: "aplicado", ids: { posting_id: "posting-unico" } }));
    }
    if (route.endsWith("/retomar")) return Response.json(authorized());
    throw new Error(`Rota inesperada: ${route}`);
  });
  const intent = createCommandIntent(() => commandId);
  await assert.rejects(intent.run(emitInput(), input => port.emit(input)), { uncertain: true, code: "fiscal_response_lost" });
  const retry = await intent.run(emitInput(), input => port.emit(input));
  const otherTab = await port.emit({ ...emitInput(), command_id: "66666666-6666-4666-8666-666666666666" });
  const resumed = await port.resume({ emission_id: emissionId, command_id: "77777777-7777-4777-8777-777777777777", expected_version: 2, body_revision: 1 });
  assert.equal(retry.id, otherTab.id); assert.equal(retry.reference, resumed.reference); assert.equal(references.size, 1);
  const local = { emission_id: emissionId, command_id: "88888888-8888-4888-8888-888888888888", expected_version: 2, axis: "stock", intent: "apply" };
  await Promise.all([port.effects(local), port.effects(local)]);
  assert.equal(postings.size, 1);
});

test("dados fiscais faltantes conservam bloqueios exatos e o servidor simulado também recusa emissão", async () => {
  const blocked = emission({ status: "bloqueada" }); blocked.revision.blockers = [blocker]; blocked.revision.body = null; blocked.revision.body_hash = null;
  let sends = 0;
  const port = portWith(async (url) => {
    if (url.endsWith("/preparar")) return Response.json({ emission: blocked, blockers: [blocker], effects_preview: blocked.effects, replayed: false });
    sends++;
    return Response.json({ error: { code: "fiscal_blocked", message: "Corrija os dados fiscais.", blockers: [blocker] } }, { status: 422 });
  });
  const result = await port.prepare({ document_id: orderId, command_id: commandId, expected_document_version: 1,
    choices: { nature_id: natureId, presence: "presencial", final_consumer: true } });
  assert.deepEqual(result.blockers, [blocker]);
  if (emissionCanEmit(result.emission, port.access())) await port.emit({ ...emitInput(), command_id: commandId });
  assert.equal(sends, 0);
  await assert.rejects(port.emit({ ...emitInput(), command_id: commandId }), failure => {
    assert.deepEqual(failure.blockers, [blocker]); assert.equal(failure.uncertain, false); return failure.status === 422;
  });
});

test("a porta envia somente escolhas e recibo, nunca corpo fiscal, chave ou status do navegador", async () => {
  const calls = [];
  const port = portWith(async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return Response.json({ emission: emission(), blockers: [], effects_preview: [], replayed: false }); });
  await port.prepare({ document_id: orderId, command_id: commandId, expected_document_version: 1,
    choices: { nature_id: natureId, presence: "presencial", final_consumer: true, status: "autorizada" },
    body: { emitente: {} }, access_key: "inventada", status: "autorizada" });
  assert.deepEqual(calls[0].body, { command_id: commandId, expected_document_version: 1, choices: { nature_id: natureId, presence: "presencial", final_consumer: true } });
  assert.equal(calls[0].init.credentials, "same-origin"); assert.equal(calls[0].init.cache, "no-store");
  assert.ok(!Object.hasOwn(calls[0].init.headers, "Authorization"));
});

test("resposta 202 permanece incerta e referência original é preservada", async () => {
  const port = portWith(async () => Response.json(emission({ status: "incerta", version: 2 }), { status: 202 }));
  const result = await port.emit({ ...emitInput(), command_id: commandId });
  assert.equal(result.status, "incerta"); assert.equal(result.reference, `wb.${orderId}.v1`);
  assert.equal(emissionCanEmit(result, port.access()), false);
});

test("respostas inválidas nunca produzem autorização, inclusive vínculo e ambiente divergentes", async () => {
  for (const changes of [{ access_key: null }, { protocol: null }, { provider_id: null }, { environment_confirmed: false }, { number: null }, { series: null }, { environment: "outro" }, { reference: `wb.${orderId}.v2` }]) {
    const port = portWith(async () => Response.json(authorized(changes)));
    await assert.rejects(port.read(emissionId), { code: "fiscal_invalid_response", uncertain: true });
  }
  const port = portWith(async () => Response.json(authorized({ id: orderId })));
  await assert.rejects(port.read(emissionId), { code: "fiscal_invalid_response" });
  const wrongEnvironment = portWith(async () => Response.json({ items: [authorized()], total: 1, page: 1, per_page: 25 }));
  await assert.rejects(wrongEnvironment.list({ environment: "producao" }), { code: "fiscal_invalid_response" });
});

test("HTML ou JSON incompleto do servidor não é tratado como resultado fiscal", async () => {
  for (const reply of [() => new Response("<html>erro</html>", { status: 502 }), () => Response.json({ ok: true })]) {
    const port = portWith(async () => reply());
    await assert.rejects(port.emit({ ...emitInput(), command_id: commandId }), { code: "fiscal_invalid_response", uncertain: true });
  }
});

test("troca de área ou revisão descarta resposta tardia de leitura e escrita mesmo se fetch ignorar abort", async () => {
  for (const operation of ["read", "emit"]) {
    const life = new AbortController(), wait = deferred();
    const port = portWith(async () => wait.promise, { scope: () => life.signal, scopeKey: "area:ator:sessao" });
    const pending = operation === "read" ? port.read(emissionId) : port.emit({ ...emitInput(), command_id: commandId });
    life.abort(); wait.resolve(Response.json(authorized()));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(port.scopeKey, "area:ator:sessao");
  }
});

test("fechamento do componente e perda de permissão não publicam resposta antiga", async () => {
  const component = new AbortController(), wait = deferred();
  const port = portWith(async () => wait.promise);
  const pending = port.read(emissionId, component.signal);
  component.abort(); wait.resolve(Response.json(authorized()));
  await assert.rejects(pending, { name: "AbortError" });
  let grants = access(); const next = deferred();
  const changing = portWith(async () => next.promise, { access: () => grants });
  const read = changing.read(emissionId);
  grants = access({ role: "vendas" }); next.resolve(Response.json(authorized()));
  await assert.rejects(read, { name: "AbortError" });
});

test("DANFE, XML e evento usam endpoints por emissão e respeitam pendência de arquivamento", async () => {
  const paths = [];
  const port = portWith(async (url, init) => {
    paths.push(url); assert.equal(init.method, "GET"); assert.equal(init.credentials, "same-origin");
    if (url.endsWith("cancelamento/xml")) return Response.json({ code: "fiscal_cancel_xml_pending", message: "Nota cancelada; XML do evento pendente de arquivamento" }, { status: 202 });
    return new Response(url.endsWith("danfe") ? "%PDF-1.7 cofre" : "<nfeProc/>", { headers: { "Content-Type": url.endsWith("danfe") ? "application/pdf" : "application/xml" } });
  });
  assert.equal(await (await port.artifact(emissionId, "danfe")).text(), "%PDF-1.7 cofre");
  assert.equal(await (await port.artifact(emissionId, "xml")).text(), "<nfeProc/>");
  await assert.rejects(port.artifact(emissionId, "cancellation_xml"), { code: "fiscal_cancel_xml_pending", status: 202 });
  assert.deepEqual(paths.map(path => path.slice(path.indexOf("/emissoes/"))), [`/emissoes/${emissionId}/danfe`, `/emissoes/${emissionId}/xml`, `/emissoes/${emissionId}/cancelamento/xml`]);
});

test("perfis, permissões e partes controlam a oferta sem transformar efeito local em requisito fiscal", async () => {
  assert.equal(canCommercialNfe(access({ role: "vendas" }), "emit"), false);
  assert.equal(canCommercialNfe(access({ role: "fiscal", permissions: ["vendas.notas_fiscais.ie"] }), "emit"), false);
  assert.equal(canCommercialNfe(access({ role: "fiscal", permissions: ["vendas.notas_fiscais", "vendas.notas_fiscais.ie"] }), "emit"), true);
  assert.equal(canCommercialNfe(access({ role: "fiscal" }), "configure"), false);
  assert.equal(canCommercialNfe(access(), "configure"), true);
  assert.equal(canCommercialNfe(access({ demo: true }), "emit"), false);
  const localOff = access(); localOff.parts.stock = false; localOff.parts.finance = false;
  assert.equal(emissionCanEmit(emission(), localOff), true);
  const skipped = authorized({ effects: [effect("stock", { state: "pulado", reason: "part_disabled" }), effect("finance", { state: "pulado", reason: "part_disabled" })] });
  assert.equal(checkEmission(skipped).status, "autorizada");
  localOff.parts.fiscal = false; assert.equal(canCommercialNfe(localOff, "emit"), false);
});

test("recusa de servidor preserva a mensagem e não anuncia autorização", async () => {
  const port = portWith(async () => Response.json({ error: { code: "fiscal_forbidden", message: "Seu acesso não permite emitir ou cancelar notas fiscais." } }, { status: 403 }));
  await assert.rejects(port.emit({ ...emitInput(), command_id: commandId }), error => error instanceof CommercialNfeError && error.status === 403 && !error.uncertain && error.message === "Seu acesso não permite emitir ou cancelar notas fiscais.");
  let calls = 0; const denied = portWith(async () => { calls++; return Response.json(authorized()); }, { access: () => access({ role: "vendas" }) });
  await assert.rejects(denied.emit({ ...emitInput(), command_id: commandId }), { code: "fiscal_forbidden" }); assert.equal(calls, 0);
});

test("cancelamento fiscal preserva XML pendente e título recebido como compensação separada", async () => {
  const cancelled = authorized({ status: "cancelada", cancellation: { emission_id: emissionId, justification: "Venda cancelada a pedido do cliente", command_id: commandId,
    state: "registrado", messages: [], protocol: "135260000000002", event_at: timestamp, repeated: false, xml_status: "pendente", xml_hash: null },
    effects: [effect("finance", { state: "aplicado", ids: { title_ids: ["titulo-1"] }, compensation_state: "compensacao_pendente", compensation_result: { reason: "title_received", settled_cents: "5100" } })] });
  const port = portWith(async () => Response.json(cancelled));
  const result = await port.cancel({ emission_id: emissionId, command_id: commandId, expected_version: 2, justification: cancelled.cancellation.justification });
  assert.equal(result.status, "cancelada"); assert.equal(result.cancellation.xml_status, "pendente");
  assert.equal(result.effects[0].state, "aplicado"); assert.equal(result.effects[0].compensation_state, "compensacao_pendente");
  assert.equal(result.effects[0].compensation_result.reason, "title_received");
});

test("links de correção mantêm entidade/campo e recusam destinos externos", () => {
  assert.equal(correctionTarget(blocker), "/cadastros-reais?cadastro=products&registro=produto-1&campo=ncm");
  assert.equal(correctionTarget({ ...blocker, correction: { screen: "documents", id: orderId } }), `/documentos-empresa?tipo=sales_orders&documento=${orderId}`);
  assert.equal(correctionTarget({ ...blocker, correction: { screen: "natures", id: natureId } }), `/naturezas-operacao?natureza=${natureId}`);
  assert.equal(correctionTarget({ ...blocker, correction: { screen: "fiscal_natures", id: natureId } }), `/naturezas-operacao?natureza=${natureId}`);
  assert.equal(correctionTarget({ ...blocker, entity_id: undefined, correction: { screen: "fiscal_parameters", field: "settings.difal_default" } }), "/naturezas-operacao?tela=impostos&campo=settings.difal_default");
  assert.equal(correctionTarget({ ...blocker, entity_id: undefined, correction: { screen: "fiscal_settings" } }), "/certificado-a1");
  assert.equal(correctionTarget({ ...blocker, correction: { screen: "sales_orders", id: orderId } }), `/documentos-empresa?tipo=sales_orders&documento=${orderId}`);
  assert.equal(correctionTarget({ ...blocker, correction: { screen: "https://externo.invalid" } }), "/cadastros-reais?cadastro=products&registro=produto-1");
  assert.equal(correctionTarget({ ...blocker, code: "desconhecido", correction: { screen: "https://externo.invalid" } }), "/certificado-a1?registro=produto-1");
});

// O harness executa os componentes e handlers reais com promessas controladas;
// não representa renderização/layout de navegador nem acessa rede.
const { mountComponent } = await import("../../../web/erp/test/helpers/component-recovery-harness.mjs");
const uiModule = { canCommercialNfe, createCommandIntent, correctionTarget, emissionCanEmit, CommercialNfeError };
const uiModules = {
  "./commercial-nfe": Object.keys(uiModule).map(name => `export const ${name}=r.nfe.${name};`).join("\n"),
  "./ports": "export const erpPorts=()=>null;",
};
const settingsFixture = (changes = {}) => ({
  id: 1, version: 1, environment: "homologacao", stock_timing: "existing", finance_timing: "existing",
  series_homologacao: null, series_producao: null, connection_fingerprint: "b".repeat(64),
  connection_public: { issuer_cnpj: "11222333000181", version: "0.12.0", compatible: true,
    environments: ["homologacao", "producao"], series: [{ environment: "homologacao", series: 1 }, { environment: "producao", series: 2 }] },
  production_enabled_at: null, production_enabled_by: null, tax_limits_acknowledged_at: null,
  tax_limits_acknowledged_by: null, updated_at: null, updated_by: null, ...changes,
});
const connectedFixture = () => ({ configured: true, checked: { ok: true, state: { production_released: true } } });
const simulatedUiPort = (changes = {}) => ({
  scopeKey: "area-ensaio:ator:sessao", access: () => access(), config: async () => settingsFixture(),
  read: async () => emission(), list: async () => ({ items: [], page: 1, per_page: 25, total: 0 }),
  prepare: async () => ({ emission: emission(), blockers: [], effects_preview: [], replayed: false }),
  emit: async () => authorized(), resume: async () => authorized(),
  ...changes,
});
const uiController = {
  documents: async () => ({ document: { id: orderId, kind: "sales_orders", version: 1, number: "PV-1" } }),
  fiscalInvoices: async () => ({ items: [{ id: natureId, description: "Venda de mercadorias" }] }),
};
const mountSettings = (port, connection = connectedFixture()) => mountComponent("../../EmissorSettings.tsx", { port, connection }, {
  componentName: "CommercialNfeSettings", expandChildren: true, modules: uiModules, ports: { nfe: uiModule },
});
const mountCommercial = (port, query = `emissao=${emissionId}`) => mountComponent("../../CommercialNfe.tsx", { port, controller: uiController }, {
  expandChildren: true, location: `/historico-fiscal?modelo=55&${query}`, modules: uiModules, ports: { nfe: uiModule },
});
async function confirmProduction(screen, count = 3) {
  for (let index = 0; index < count; index++) {
    const controlled = screen.nodes().filter(node => node.type === "input" && node.props.type === "checkbox" && typeof node.props.checked === "boolean");
    controlled[index].props.onChange({ target: { checked: true } }); await screen.flush();
  }
}
async function choosePreparation(screen) {
  await screen.change("commercial-nature", natureId);
  await screen.change("commercial-presence", "presencial");
  await screen.change("commercial-consumer", "yes");
}

test("painel: pedido localizado pelo resumo carrega o detalhe antes de mostrar revisão", async () => {
  const summary = emission(), reads = [];
  for (const field of ["snapshot", "tax_sources", "body", "calculation"]) delete summary.revision[field];
  const port = simulatedUiPort({ list: async input => ({ items: input.environment === "homologacao" ? [summary] : [], page: 1, per_page: 100, total: input.environment === "homologacao" ? 1 : 0 }),
    read: async id => { reads.push(id); return emission(); } });
  const screen = await mountCommercial(port, `pedido=${orderId}`);
  try {
    assert.deepEqual(reads, [emissionId]);
    assert.match(screen.text(), /Preparada para revisão/);
    assert.match(screen.text(), /Mercadoria/);
  } finally { screen.unmount(); }
  const history = await mountCommercial(port, "");
  try { assert.match(history.text(), new RegExp(`Pedido ${orderId}`)); }
  finally { history.unmount(); }
});

test("configuração: produção exige administrador, conexão conferida e confirmação explícita", async () => {
  const writes = [], port = simulatedUiPort({ saveConfig: async input => { writes.push(structuredClone(input)); return settingsFixture({ ...input, version: 2, production_enabled_at: timestamp, production_enabled_by: personId }); } });
  const screen = await mountSettings(port);
  try {
    assert.match(screen.text(), /Homologação: NF-e e DANFE sem valor fiscal de produção/);
    assert.match(screen.text(), /estoque, títulos e recebimentos comerciais reais/);
    assert.equal(screen.button("Habilitar e usar produção").disabled, true);
    await confirmProduction(screen, 2);
    assert.equal(screen.button("Habilitar e usar produção").disabled, true);
    const acknowledgement = screen.nodes().filter(node => node.type === "input" && typeof node.props.checked === "boolean")[2];
    acknowledgement.props.onChange({ target: { checked: true } }); await screen.flush();
    await screen.click("Habilitar e usar produção");
    assert.equal(writes.length, 1); assert.equal(writes[0].environment, "producao");
    assert.equal(writes[0].enable_production, true); assert.equal(writes[0].acknowledge_tax_limits, true);
    assert.equal(writes[0].expected_version, 1); assert.match(writes[0].command_id, /^[a-f0-9-]{36}$/);
    assert.match(screen.text(), /Configuração salva em produção/);
    const series = screen.nodes().filter(node => node.type === "select").slice(1, 3);
    assert.ok(series.every(node => !node.props.children.flat().some(option => option?.props?.value === 999)));
  } finally { screen.unmount(); }
  for (const override of [{ access: () => access({ role: "fiscal" }) }, {}]) {
    const denied = await mountSettings(simulatedUiPort({ ...override, saveConfig: async () => { throw new Error("Não deve gravar"); } }), override.access ? connectedFixture() : { checked: { ok: false } });
    try {
      if (!override.access) await confirmProduction(denied);
      assert.equal(denied.button("Habilitar e usar produção").disabled, true);
      if (override.access) { await denied.submit(); assert.match(denied.text(), /alteração exige administrador/); }
    } finally { denied.unmount(); }
  }
});

test("configuração: perda de resposta e duplo clique preservam comando e argumentos", async () => {
  const wait = deferred(), writes = [];
  const port = simulatedUiPort({ saveConfig: async input => { writes.push(structuredClone(input)); if (writes.length === 1) return wait.promise; return settingsFixture({ ...input, version: 2 }); } });
  const screen = await mountSettings(port);
  try {
    await confirmProduction(screen);
    const button = screen.button("Habilitar e usar produção"); button.props.onClick(); button.props.onClick();
    await screen.flush(); assert.equal(writes.length, 1);
    wait.reject(new CommercialNfeError("Resposta perdida", { uncertain: true })); await screen.flush();
    assert.match(screen.text(), /Não foi possível confirmar a gravação/);
    assert.equal(screen.button("Habilitar e usar produção").disabled, true);
    await screen.click("Repetir o mesmo comando de configuração");
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  } finally { screen.unmount(); }
});

test("configuração: troca de porta e fechamento descartam resposta antiga", async () => {
  const wait = deferred(); let oldSignal, nextSignal;
  const portA = simulatedUiPort({ config: signal => { oldSignal = signal; return wait.promise; } });
  const portB = simulatedUiPort({ scopeKey: "outra-area", config: async signal => { nextSignal = signal; return settingsFixture({ connection_public: { issuer_cnpj: "EMPRESA NOVA" } }); } });
  const screen = await mountSettings(portA);
  try {
    await screen.updateProps({ port: portB });
    assert.equal(oldSignal.aborted, true); assert.match(screen.text(), /EMPRESA NOVA/);
    wait.resolve(settingsFixture({ connection_public: { issuer_cnpj: "EMPRESA ANTIGA" } })); await screen.flush();
    assert.doesNotMatch(screen.text(), /EMPRESA ANTIGA/); assert.match(screen.text(), /EMPRESA NOVA/);
  } finally { screen.unmount(); }
  assert.equal(nextSignal.aborted, true);
});

test("painel: bloqueios aparecem exatamente, com correção, e não oferecem emissão", async () => {
  const blocked = emission({ status: "bloqueada" }); blocked.revision.blockers = [blocker]; blocked.revision.body = null;
  let emits = 0;
  const screen = await mountCommercial(simulatedUiPort({ read: async () => blocked, emit: async () => { emits++; return authorized(); } }));
  try {
    assert.match(screen.text(), /O produto Mercadoria está sem NCM, necessário para esta operação\./);
    assert.ok(screen.nodes().some(node => node.props.to === correctionTarget(blocker)));
    assert.equal(screen.nodes().some(node => node.type === "button" && node.props.children === "Emitir NF-e"), false);
    assert.equal(emits, 0);
  } finally { screen.unmount(); }
});

test("painel: sem papel fiscal e com Fiscal desligada não oferece emissão e preserva venda", async () => {
  for (const grant of [access({ role: "vendas" }), access({ parts: { ...access().parts, fiscal: false } })]) {
    let reads = 0;
    const screen = await mountCommercial(simulatedUiPort({ access: () => grant, config: async () => { reads++; return settingsFixture(); } }));
    try {
      assert.match(screen.text(), /A venda pode continuar sem nota/); assert.equal(reads, 0);
      assert.ok(screen.nodes().some(node => node.props.to === "/documentos-empresa?tipo=sales_orders"));
      assert.equal(screen.nodes().some(node => node.type === "button"), false);
    } finally { screen.unmount(); }
  }
});

test("painel: resposta perdida retoma a mesma emissão e mantém autorização visível com efeitos pulados", async () => {
  const sent = [], resumed = [], wait = deferred();
  const done = authorized({ effects: [effect("stock", { state: "pulado", reason: "part_disabled" }), effect("finance", { state: "pulado", reason: "part_disabled" })] });
  const screen = await mountCommercial(simulatedUiPort({ emit: async input => { sent.push(input); return wait.promise; }, resume: async input => { resumed.push(input); return done; } }));
  try {
    await screen.change("commercial-reviewed", true);
    const button = screen.button("Emitir NF-e"); button.props.onClick(); button.props.onClick(); await screen.flush();
    assert.equal(sent.length, 1);
    wait.reject(new CommercialNfeError("Resposta perdida", { uncertain: true })); await screen.flush();
    assert.match(screen.text(), /Resultado incerto/);
    assert.equal(screen.nodes().some(node => node.type === "button" && node.props.children === "Emitir NF-e"), false);
    await screen.click("Consultar / retomar");
    assert.equal(resumed.length, 1); assert.equal(resumed[0].emission_id, sent[0].emission_id);
    assert.match(screen.text(), /Autorizada/); assert.match(screen.text(), /Parte desligada\. Religar não aplica o efeito automaticamente/);
    assert.ok(screen.button("Baixar DANFE do cofre")); assert.ok(screen.button("Baixar XML da NF-e"));
  } finally { screen.unmount(); }
});

test("painel: recusa conclusiva permite corrigir escolhas com novo comando de preparação", async () => {
  const calls = [];
  const screen = await mountCommercial(simulatedUiPort({ prepare: async input => {
    calls.push(structuredClone(input));
    if (calls.length === 1) throw new CommercialNfeError("Corrija a presença do comprador.", { status: 422, blockers: [blocker] });
    return { emission: emission(), blockers: [], effects_preview: [], replayed: false };
  } }), `pedido=${orderId}`);
  try {
    await choosePreparation(screen); await screen.click("Preparar NF-e");
    assert.match(screen.text(), /Corrija a presença do comprador/);
    await screen.change("commercial-presence", "internet"); await screen.click("Preparar NF-e");
    assert.equal(calls.length, 2); assert.notEqual(calls[0].command_id, calls[1].command_id);
    assert.equal(calls[1].choices.presence, "internet"); assert.match(screen.text(), /Preparada para revisão/);
  } finally { screen.unmount(); }
});

test("painel: preparação perdida sem registro encontrado repete exatamente a mesma intenção", async () => {
  const calls = [];
  const screen = await mountCommercial(simulatedUiPort({ prepare: async input => {
    calls.push(structuredClone(input));
    if (calls.length === 1) throw new CommercialNfeError("Resposta perdida", { uncertain: true });
    return { emission: emission(), blockers: [], effects_preview: [], replayed: true };
  } }), `pedido=${orderId}`);
  try {
    await choosePreparation(screen); await screen.click("Preparar NF-e");
    await screen.click("Localizar preparação do pedido");
    assert.match(screen.text(), /Resultado incerto/);
    await screen.click("Repetir a mesma preparação");
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.match(screen.text(), /Preparada para revisão/);
  } finally { screen.unmount(); }
});

test("painel: cancelamento incerto conserva comando, versão e justificativa e separa XML e compensação", async () => {
  const calls = [], justification = "Cancelamento solicitado pelo cliente da venda";
  const event = { emission_id: emissionId, justification, command_id: commandId, state: "incerto", messages: [], protocol: null, event_at: null, repeated: false, xml_status: "pendente", xml_hash: null };
  const screen = await mountCommercial(simulatedUiPort({ read: async () => authorized(), cancel: async input => {
    calls.push(structuredClone(input));
    return calls.length === 1 ? authorized({ version: 3, cancellation: event }) : authorized({ version: 4, status: "cancelada", cancellation: { ...event, state: "registrado", protocol: "evento-1" },
      effects: [effect("finance", { state: "aplicado", ids: { title_ids: ["titulo-1"] }, compensation_state: "compensacao_pendente", compensation_result: { reason: "Título recebido; não estornar automaticamente" } })] });
  } }));
  try {
    await screen.click("Cancelar NF-e"); await screen.change("commercial-justification", justification); await screen.change("commercial-cancel-confirmed", true);
    await screen.click("Confirmar cancelamento no cofre"); assert.match(screen.text(), /Resultado incerto/);
    await screen.click("Retomar cancelamento"); await screen.click("Confirmar cancelamento no cofre");
    assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].expected_version, 2);
    assert.match(screen.text(), /Nota cancelada; XML do evento pendente de arquivamento/);
    assert.match(screen.text(), /Título recebido; não estornar automaticamente/); assert.match(screen.text(), /Compensação pendente/);
    assert.doesNotMatch(screen.text(), /A autorização fiscal permanece válida/);
  } finally { screen.unmount(); }
});

test("painel: histórico distingue o ambiente selecionado do ambiente ativo da configuração", async () => {
  const filters = [];
  const screen = await mountCommercial(simulatedUiPort({ list: async input => { filters.push(input.environment); return { items: [], page: 1, per_page: 25, total: 0 }; } }), "");
  try {
    await screen.change("commercial-environment", "producao");
    assert.equal(filters.at(-1), "producao"); assert.match(screen.text(), /Produção · valor fiscal real/);
    assert.doesNotMatch(screen.text(), /Homologação pode movimentar estoque/);
  } finally { screen.unmount(); }
});

test("HTTP 408 continua inconclusivo e não libera uma intenção diferente", async () => {
  const port = portWith(async () => Response.json({ code: "request_timeout", message: "Tempo esgotado; consulte a mesma emissão." }, { status: 408 }));
  await assert.rejects(port.emit({ ...emitInput(), command_id: commandId }), { status: 408, uncertain: true });
});

test("painel: consulta não recebe ação fiscal e recusa do servidor é apresentada sem autorização", async () => {
  const reader = await mountCommercial(simulatedUiPort({ access: () => access({ role: "consulta" }) }));
  try {
    assert.match(reader.text(), /Preparada para revisão/);
    assert.equal(reader.nodes().some(node => node.type === "button" && node.props.children === "Emitir NF-e"), false);
  } finally { reader.unmount(); }
  const screen = await mountCommercial(simulatedUiPort({ emit: async () => { throw new CommercialNfeError("Seu acesso não permite emitir ou cancelar notas fiscais.", { status: 403, code: "fiscal_forbidden" }); } }));
  try {
    await screen.change("commercial-reviewed", true); await screen.click("Emitir NF-e");
    assert.match(screen.text(), /Seu acesso não permite emitir ou cancelar notas fiscais\./);
    assert.doesNotMatch(screen.text(), /Protocolo de autorização/);
  } finally { screen.unmount(); }
});

test("painel: troca de área e desmontagem cancelam leitura mesmo com porta simulada tardia", async () => {
  const wait = deferred(); let oldSignal, newSignal;
  const portA = simulatedUiPort({ scopeKey: "area-a", read: async (_, signal) => { oldSignal = signal; return wait.promise; } });
  const fromB = authorized(); fromB.revision.snapshot.company.name = "EMPRESA DA ÁREA B";
  const portB = simulatedUiPort({ scopeKey: "area-b", read: async (_, signal) => { newSignal = signal; return fromB; } });
  const screen = await mountCommercial(portA);
  try {
    await screen.updateProps({ port: portB }); assert.equal(oldSignal.aborted, true);
    const old = authorized(); old.revision.snapshot.company.name = "EMPRESA DA ÁREA A";
    wait.resolve(old); await screen.flush();
    assert.match(screen.text(), /EMPRESA DA ÁREA B/); assert.doesNotMatch(screen.text(), /EMPRESA DA ÁREA A/);
  } finally { screen.unmount(); }
  assert.equal(newSignal.aborted, true);
});

test("painel: botão DANFE baixa o arquivo da emissão pelo cofre", async () => {
  const calls = [], links = [], previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: tag => { assert.equal(tag, "a"); const link = { click() { this.clicked = true; }, remove() { this.removed = true; } }; links.push(link); return link; },
    body: { appendChild() {} },
  } });
  const screen = await mountCommercial(simulatedUiPort({ read: async () => authorized(), artifact: async (id, kind) => { calls.push({ id, kind }); return new Blob(["%PDF-1.7 arquivo do cofre"], { type: "application/pdf" }); } }));
  try {
    await screen.click("Baixar DANFE do cofre"); assert.deepEqual(calls, [{ id: emissionId, kind: "danfe" }]);
    assert.equal(links[0].clicked, true); assert.equal(links[0].removed, true);
    assert.equal(links[0].download, `danfe-${emissionId}.pdf`); assert.match(links[0].href, /^blob:/);
  } finally {
    screen.unmount(); if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  }
});
