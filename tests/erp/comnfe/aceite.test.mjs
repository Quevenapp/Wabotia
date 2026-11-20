import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { com1Fixture, COM1_DATE, COM1_PEOPLE } from "./fixtures.mjs";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { installCommercialConnectionResolver, runWithCommercialConnection } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { COM1_TABLES as T, com1Hash, com1Sha256 } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { fakeNfeValue } from "../emissor/fake-vault-value.ts";

const fingerprint = com1Hash("cofre-local-aceite");
const accessKey = "35261111222333000181550010000000011000000010";
const reason = "Cancelamento da venda de ensaio antes da entrega.";
const row = (f, sql, ...params) => f.db.exec(sql, ...params).rows[0];
const count = (f, table) => row(f, `SELECT count(*) n FROM ${table}`).n;
const version = f => row(f, "SELECT version FROM erp_documents__document WHERE id=?", f.order.id).version;
const eventXml = () => `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>135260000000002</nProt><dhRegEvento>2026-11-19T12:02:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;

test("evidência de identidade divergente fica restrita no recibo sem autorizar ou aplicar efeitos", async t => {
  const f = setup(t); await f.prepare();
  f.provider.emit = async () => { throw { code: "fiscal_response_identity_mismatch", details: {
    unverified_emission: { id: "emissao_divergente", ambiente: "producao", api_key: "segredo-que-nao-pode-ser-guardado" },
  } }; };
  const input = f.emitInput(), view = await f.service.emit(input);
  assert.equal(view.status, "incerta");
  assert.equal(view.provider_id, null);
  const receipt = row(f, `SELECT result FROM ${T.command} WHERE id=?`, input.command_id).result;
  assert.match(receipt, /emissao_divergente/);
  assert.doesNotMatch(receipt, /segredo-que-nao-pode-ser-guardado/);
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
  assert.doesNotMatch(JSON.stringify(view), /emissao_divergente/);
});

/** Prova do motor inteiro com transporte em memória. O fake-vault oficial,
 * que importa Vitest, é exercitado separadamente em com1-aceite.test.ts. */
function setup(t, options = {}) {
  const f = com1Fixture(t, options);
  t.after(installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: String(f.clock.next()), compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao", "producao"],
    series: [{ environment: "homologacao", series: 1 }, { environment: "producao", series: 1 }] })));
  f.warehouse = f.catalog("warehouses", { name: "Depósito do aceite" });
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas do aceite" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa do aceite", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.orderBody = { ...f.orderBody, warehouse_id: f.warehouse.id, category_id: f.category.id, payment_means: "15", payment_indicator: "1",
    commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
      transport: { freight_mode: "9", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } },
    items: f.orderBody.items.map((item, i) => ({ ...item, code: `P${i + 1}` })) };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(), p_body: f.orderBody }).document;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo para ensaio", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }] });
  f.order = f.rpc("erp_document_transition", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(), p_status: "verified", p_reason: "Pedido conferido" }).document;
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao", stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  const state = { role: "admin", parts: {}, remote: null, before: null, after: null, xmlMissing: false, lost: false, reject: false, downloads: [], calls: [], bodies: [] };
  const output = (body, status = "authorized") => ({ kind: "nfe", status, provider_ref: "nfe_aceite", reference: body.referencia, environment: body.ambiente,
    series: "1", number: 1, access_key: status === "rejected" ? null : accessKey, protocol: status === "rejected" ? null : "135260000000001",
    nfse_number: null, issued_at: "2026-11-19T12:00:00Z", authorized_at: status === "rejected" ? null : "2026-11-19T12:00:01Z", total: fakeNfeValue(body),
    qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true, replayed: false, event_repeated: null, contingency: null });
  const provider = {
    async emit(_ctx, kind, body) {
      state.calls.push("emit"); state.bodies.push(structuredClone(body));
      state.remote = output(body, state.reject ? "rejected" : "authorized");
      if (state.lost) { state.lost = false; throw new Error("resposta perdida após aceite"); }
      return structuredClone(state.remote);
    },
    async find() { state.calls.push("find"); return structuredClone(state.remote); },
    async get() { state.calls.push("get"); return structuredClone(state.remote); },
    async reconcile() { state.calls.push("reconcile"); return structuredClone(state.remote); },
    async cancel() { state.calls.push("cancel"); state.remote = { ...state.remote, status: "cancelled", event_repeated: false }; return structuredClone(state.remote); },
    async cancellationXml() { state.calls.push("cancel_xml"); if (state.xmlMissing) throw new Error("XML pendente"); return eventXml(); },
    async danfe(_ctx, id) { state.downloads.push(id); const body = new TextEncoder().encode(`%PDF-1.4\n${id}\n%%EOF`); return { body, size: body.length, content_type: "application/pdf" }; },
    async xml(_ctx, _kind, id) { state.downloads.push(id); return `<nfe id="${id}"/>`; },
  };
  const bridge = { async call(name, input) {
    if (state.before?.(name, input)) throw new Error(`queda antes de ${name}`);
    const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name);
    const output = evidence
      ? callRpc(f.db, name, { p_input: input }, f.clock, f.env({ role: state.role, parts: state.parts }))
      : f.rpc(name, name === "erp_com1_config_get" ? {} : { p_input: input }, { role: state.role, parts: state.parts });
    if (state.after?.(name, input)) throw new Error(`queda depois de ${name}`);
    return output;
  } };
  const service = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  const prepareInput = () => ({ document_id: f.order.id, expected_document_version: version(f), command_id: randomUUID(), choices: { nature_id: f.nature.id, presence: "presencial", final_consumer: true } });
  const prepare = async (input = prepareInput()) => { const result = await service.prepare(input); f.view = result.emission; return result; };
  const read = () => f.rpc("erp_com1_get", { p_input: { emission_id: f.view.id } });
  const emitInput = () => ({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read().version, body_revision: read().current_body_revision, body_hash: read().revision.body_hash });
  const cancelInput = () => ({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read().version, justification: reason });
  const resume = () => service.resume({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read().version, body_revision: read().current_body_revision });
  const effect = (axis, changes = {}) => service.effects({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read().version, axis, intent: "apply", ...changes });
  const settle = () => { const title = row(f, "SELECT * FROM erp_finance__title"); const args = { p_command_id: randomUUID(), p_action: "settle", p_data: { id: title.id, expected_version: title.version, account_id: f.account.id, posted_on: COM1_DATE, principal_cents: "5100" } }; f.rpc("erp_finance_execute", args); f.rpc("erp_finance_execute", args); };
  return Object.assign(f, { state, provider, service, prepareInput, prepare, read, emitInput, cancelInput, resume, effect, settle });
}
function unique(f) {
  assert.equal(count(f, T.emission), 1);
  assert.equal(count(f, "erp_stock__document_posting"), 1);
  assert.equal(count(f, "erp_finance__document_posting"), 1);
  assert.equal(count(f, "erp_finance__title"), 1);
  assert.equal(f.read().reference, `wb.${f.order.id}.v1`);
}
async function authorized(f) { const prepared = await f.prepare(); assert.deepEqual(prepared.blockers, []); const view = await f.service.emit(f.emitInput()); assert.equal(view.status, "autorizada"); return view; }

test("aceite integral: cadastro → pedido → preparo → autorização → DANFE → saída/título únicos → recebimento → cancelamento", async t => {
  const f = setup(t), input = f.prepareInput();
  assert.deepEqual((await f.prepare(input)).blockers, []);
  assert.equal((await f.prepare(input)).replayed, true);
  const emit = f.emitInput();
  const view = await f.service.emit(emit);
  assert.equal(view.status, "autorizada");
  assert.deepEqual(view.effects.map(e => e.state), ["aplicado", "aplicado"], JSON.stringify(view.effects));
  await f.service.emit(emit); await f.service.emit(f.emitInput());
  for (const axis of ["stock", "finance"]) await f.effect(axis);
  unique(f); assert.equal(f.state.calls.filter(c => c === "emit").length, 1);
  const danfe = await f.service.danfe({ emission_id: view.id });
  assert.equal(danfe.headers.get("cache-control"), "private, no-store");
  assert.ok((await danfe.text()).includes(view.provider_id));
  assert.deepEqual(f.state.downloads, [view.provider_id]);
  f.settle();
  const cancel = f.cancelInput(), cancelled = await f.service.cancel(cancel);
  assert.equal(cancelled.status, "cancelada");
  assert.equal(cancelled.cancellation.xml_status, "disponivel");
  assert.equal(cancelled.cancellation.xml_hash, com1Sha256(eventXml()));
  assert.equal(cancelled.effects.find(e => e.axis === "finance").compensation_state, "compensacao_pendente");
  assert.equal(cancelled.effects.find(e => e.axis === "stock").compensation_state, "compensacao_pendente");
  assert.equal(row(f, "SELECT settled_cents,cancelled FROM erp_finance__title").settled_cents, 5100);
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title").cancelled, 0);
  assert.equal(count(f, "erp_finance__settlement"), 1);
  assert.equal(await (await f.service.cancellationXml({ emission_id: view.id })).text(), eventXml());
  await f.service.cancel(cancel); unique(f);
  assert.equal(f.state.calls.filter(c => c === "cancel").length, 1);
});

test("cancelamento de título não recebido compensa financeiro; estoque exige confirmação física", async t => {
  const f = setup(t); await authorized(f);
  const cancelled = await f.service.cancel(f.cancelInput());
  assert.equal(cancelled.effects.find(e => e.axis === "finance").compensation_state, "revertido");
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title").cancelled, 1);
  assert.equal(count(f, "erp_finance__settlement"), 0);
  assert.equal((await f.effect("stock", { intent: "reverse", physical_return_confirmed: true })).compensation_state, "revertido");
  assert.equal(row(f, "SELECT quantity FROM erp_stock__balance WHERE product_id=?", f.product.id).quantity, 100000000);
  unique(f);
});

test("total divergente do cofre preserva autorização e deixa os dois efeitos pendentes sem lançamentos", async t => {
  const f = setup(t); await f.prepare();
  const emit = f.provider.emit;
  // Reproduz a causa do log externo: pedido de R$ 51,00 e resposta de R$ 100,00.
  // A correção do simulado não pode remover a conferência comercial do motor.
  f.provider.emit = async (...args) => ({ ...await emit(...args), total: 100 });
  const view = await f.service.emit(f.emitInput());
  assert.equal(view.status, "autorizada");
  assert.equal(view.total, "10000");
  assert.deepEqual(view.effects.map(({ state, reason }) => ({ state, reason })), [
    { state: "pendente", reason: "com1_effect_source_changed" },
    { state: "pendente", reason: "com1_effect_source_changed" },
  ]);
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
  assert.equal(f.state.calls.filter(call => call === "emit").length, 1);
});

test("bloqueio cadastral mantém contador de chamadas externas em zero", async t => {
  const f = setup(t, { product: { ncm: null } });
  const result = await f.prepare();
  assert.ok(result.blockers.some(b => b.code === "fiscal_product_incomplete"));
  await assert.rejects(f.service.emit(f.emitInput()), e => e.status === 422);
  assert.deepEqual(f.state.calls, []);
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
});

test("duas abas com comandos diferentes preservam uma nota e os dois efeitos", async t => {
  const f = setup(t); await f.prepare();
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const emit = f.provider.emit;
  f.provider.emit = async (...args) => { enter(); await held; return emit(...args); };
  const first = f.service.emit(f.emitInput()); await started;
  assert.equal((await f.service.emit(f.emitInput())).status, "enviando");
  release(); assert.equal((await first).status, "autorizada");
  unique(f); assert.equal(f.state.calls.filter(c => c === "emit").length, 1);
});

for (const boundary of ["erp_com1_claim", "erp_com1_record", "stock", "finance"]) test(`queda após persistência de ${boundary}: retomada conserva identidade e quantidades`, async t => {
  const f = setup(t); await f.prepare();
  let once = true;
  f.state.after = (name, input) => once && (name === boundary || name === "erp_com1_effect_apply" && input.axis === boundary) ? (once = false, true) : false;
  const first = await f.service.emit(f.emitInput()).catch(e => e);
  if (["erp_com1_claim", "erp_com1_record"].includes(boundary)) assert.ok(first instanceof Error);
  f.state.after = null; f.clock.advance(61_000);
  const resumed = await f.resume(); assert.equal(resumed.status, "autorizada");
  for (const axis of ["stock", "finance"]) await f.effect(axis);
  unique(f); assert.equal(f.state.calls.filter(c => c === "emit").length, 1);
});

for (const boundary of ["erp_com1_record", "stock", "finance"]) test(`queda antes de ${boundary}: efeito já confirmado não é repetido`, async t => {
  const f = setup(t); await f.prepare();
  let once = true;
  f.state.before = (name, input) => once && (name === boundary || name === "erp_com1_effect_apply" && input.axis === boundary) ? (once = false, true) : false;
  await f.service.emit(f.emitInput()).catch(e => assert.ok(e instanceof Error));
  f.state.before = null; f.clock.advance(61_000);
  assert.equal((await f.resume()).status, "autorizada");
  for (const axis of ["stock", "finance"]) await f.effect(axis);
  unique(f); assert.equal(f.state.calls.filter(c => c === "emit").length, 1);
});

test("aceite externo sem resposta e nova pessoa retomando conservam autoria e referência", async t => {
  const f = setup(t); await f.prepare(); f.state.lost = true;
  assert.equal((await f.service.emit(f.emitInput())).status, "incerta");
  f.clock.advance(61_000); f.state.role = "fiscal";
  assert.equal((await f.resume()).status, "autorizada");
  const actors = f.db.exec(`SELECT DISTINCT person_id FROM ${T.command} WHERE action IN ('emit','resume')`).rows.map(r => r.person_id);
  assert.deepEqual(new Set(actors), new Set([COM1_PEOPLE.admin.user_id, COM1_PEOPLE.fiscal.user_id]));
  f.state.role = "admin";
  for (const axis of ["stock", "finance"]) await f.effect(axis);
  unique(f); assert.equal(f.state.calls.filter(c => c === "emit").length, 1);
});

for (const boundary of ["erp_com1_cancel_claim", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"]) test(`cancelamento com queda após ${boundary}: evento e XML são recuperáveis`, async t => {
  const f = setup(t); await authorized(f);
  let once = true;
  f.state.after = name => once && name === boundary ? (once = false, true) : false;
  await f.service.cancel(f.cancelInput()).catch(e => assert.ok(e instanceof Error));
  f.state.after = null; f.clock.advance(61_000);
  const result = await f.service.cancel(f.cancelInput());
  assert.equal(result.status, "cancelada"); assert.equal(result.cancellation.xml_status, "disponivel");
  assert.equal(count(f, T.cancel), 1); unique(f);
  assert.equal(f.state.calls.filter(c => c === "cancel").length, 1);
});

test("evento persistido antes do XML conserva cancelamento e permite arquivamento posterior", async t => {
  const f = setup(t); await authorized(f); f.state.xmlMissing = true;
  const pending = await f.service.cancel(f.cancelInput());
  assert.equal(pending.status, "cancelada"); assert.equal(pending.cancellation.xml_status, "pendente");
  f.state.xmlMissing = false; f.clock.advance(61_000);
  const complete = await f.service.cancel(f.cancelInput());
  assert.equal(complete.cancellation.xml_status, "disponivel", JSON.stringify(complete.cancellation));
  assert.equal(f.state.calls.filter(c => c === "cancel").length, 1);
});

for (const parts of [{ stock: false }, { finance: false }, { stock: false, finance: false }, { billing: false, purchases: false, pos: false }]) test(`partes vizinhas ${JSON.stringify(parts)}: resultado explícito sem exigir PDV`, async t => {
  const f = setup(t); await f.prepare(); f.state.parts = parts;
  const result = await f.service.emit(f.emitInput()); assert.equal(result.status, "autorizada");
  for (const axis of ["stock", "finance"]) {
    const effect = result.effects.find(e => e.axis === axis);
    assert.equal(effect.state, parts[axis] === false ? "pulado" : "aplicado");
    if (parts[axis] === false) assert.equal(effect.reason, "part_disabled");
  }
  f.state.parts = {};
  await f.resume();
  assert.equal(count(f, "erp_stock__document_posting"), parts.stock === false ? 0 : 1);
  assert.equal(count(f, "erp_finance__title"), parts.finance === false ? 0 : 1);
});

for (const part of ["customers", "products", "sales", "fiscal"]) test(`${part} desligada bloqueia preparação antes do cofre`, async t => {
  const f = setup(t); f.state.parts = { [part]: false };
  await assert.rejects(f.prepare(), e => e.code === "module_disabled");
  assert.deepEqual(f.state.calls, []);
});

test("rejeição corrigida gera revisão imutável na mesma referência; produção requer outro pedido", async t => {
  const f = setup(t); await f.prepare(); f.state.reject = true;
  assert.equal((await f.service.emit(f.emitInput())).status, "rejeitada");
  const reference = f.read().reference, previousHash = f.read().revision.body_hash;
  f.rpc("erp_document_notes_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(),
    p_notes: "Observação fiscal corrigida após rejeição conclusiva.", p_internal_notes: null });
  f.state.reject = false;
  const input = { ...f.prepareInput(), expected_emission_version: f.read().version };
  const updated = await f.prepare(input);
  assert.deepEqual(updated.blockers, []); assert.equal(updated.emission.current_body_revision, 2);
  assert.notEqual(updated.emission.revision.body_hash, previousHash);
  assert.equal((await f.service.emit(f.emitInput())).status, "autorizada");
  assert.equal(f.read().reference, reference); assert.equal(count(f, T.revision), 2); unique(f);
  const settings = f.rpc("erp_com1_config_get");
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: settings.version, environment: "producao", stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true, enable_production: true } });
  await assert.rejects(f.prepare(), /fiscal_environment_conflict/);
  assert.equal(f.read().environment, "homologacao");
  assert.equal(f.rpc("erp_com1_list", { p_input: { environment: "producao" } }).total, 0);
});

test("registro padrão instala todos os encaixes; fiscal autoriza e registra pendências sem privilégio local", async t => {
  const f = setup(t); await f.prepare(); f.state.role = "fiscal";
  const view = await f.service.emit(f.emitInput());
  assert.equal(view.status, "autorizada");
  assert.ok(view.effects.every(effect => effect.state === "pendente" && effect.reason !== "awaiting_local_effect"), JSON.stringify(view.effects));
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
  f.state.role = "estoque";
  assert.equal((await f.effect("stock")).state, "aplicado");
  f.state.role = "financeiro";
  assert.equal((await f.effect("finance")).state, "aplicado");
  unique(f);
});

const productionInput = expected_version => ({ command_id: randomUUID(), expected_version, environment: "producao", stock_timing: "existing", finance_timing: "existing", acknowledge_tax_limits: true, enable_production: true });
const connectionCheck = f => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid", issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: String(f.clock.latest), compatible: true,
  company_matches: true, company_complete: true, environments: ["homologacao", "producao"], series: [{ environment: "producao", series: 1 }] });
test("conexão pública não substitui a identidade atual da empresa ao habilitar produção", t => {
  const f = com1Fixture(t), check = connectionCheck(f);
  const save = input => runWithCommercialConnection(check, () => f.rpc("erp_com1_config_save", { p_input: input }));
  check.issuer_cnpj = "19131243000197";
  assert.throws(() => save(productionInput(1)), /fiscal_issuer_mismatch/);
  check.issuer_cnpj = f.company.cnpj;
  f.db.exec("UPDATE erp_company__identity SET data=json_set(data,'$.ie',null) WHERE singleton=1");
  assert.throws(() => save(productionInput(1)), /fiscal_issuer_incomplete/);
  f.db.exec("UPDATE erp_company__identity SET data=json_set(data,'$.ie',?) WHERE singleton=1", f.company.ie);
  const valid = save(productionInput(1));
  assert.ok(valid.production_enabled_at); assert.equal(valid.production_enabled_by, COM1_PEOPLE.admin.user_id);
});

test("remoção da conexão limpa vínculo público e exige nova habilitação de produção", t => {
  const f = com1Fixture(t), check = connectionCheck(f);
  const enabled = runWithCommercialConnection(check, () => f.rpc("erp_com1_config_save", { p_input: productionInput(1) }));
  const removed = runWithCommercialConnection(null, () => f.rpc("erp_com1_config_save", { p_input: {
    command_id: randomUUID(), expected_version: enabled.version, environment: "homologacao", stock_timing: "existing", finance_timing: "existing",
  } }));
  assert.equal(removed.connection_fingerprint, null); assert.equal(removed.connection_public, null);
  assert.equal(removed.production_enabled_at, null); assert.equal(removed.production_enabled_by, null);
  assert.throws(() => runWithCommercialConnection(check, () => f.rpc("erp_com1_config_save", { p_input: {
    command_id: randomUUID(), expected_version: removed.version, environment: "producao", stock_timing: "existing", finance_timing: "existing",
  } })), /fiscal_production_not_enabled/);
});

test("preparação persistida com resposta perdida repete recibo sem segunda revisão", async t => {
  const f = setup(t), input = f.prepareInput();
  let once = true;
  f.state.after = name => once && name === "erp_com1_prepare" ? (once = false, true) : false;
  await assert.rejects(f.prepare(input), /queda depois de erp_com1_prepare/);
  f.state.after = null;
  const recovered = await f.prepare(input);
  assert.equal(recovered.replayed, true);
  assert.equal(count(f, T.emission), 1); assert.equal(count(f, T.revision), 1);
  assert.equal(recovered.emission.reference, `wb.${f.order.id}.v1`);
  assert.equal((await f.service.emit(f.emitInput())).status, "autorizada");
  unique(f);
});

test("observação fiscal enviada fica protegida com Fiscal desligada; anotação interna e replay não alteram o snapshot", async t => {
  const f = setup(t); await f.prepare(); f.state.parts = { stock: false, finance: false };
  await f.service.emit(f.emitInput());
  const frozen = structuredClone(f.read().revision), documentVersion = version(f);
  const input = { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: documentVersion, p_command_id: randomUUID(),
    p_notes: "Texto que mudaria o conteúdo fiscal.", p_internal_notes: "Separação em andamento." };
  for (let i = 0; i < 2; i++) assert.throws(() => f.rpc("erp_document_notes_save", input, { parts: { fiscal: false } }), /fiscal_order_commercial_locked/);
  assert.equal(version(f), documentVersion);
  const internal = { ...input, p_command_id: randomUUID(), p_notes: null };
  const changed = f.rpc("erp_document_notes_save", internal, { parts: { fiscal: false } });
  assert.equal(changed.document.internal_notes, "Separação em andamento.");
  assert.equal(f.rpc("erp_document_notes_save", internal, { parts: { fiscal: false } }).replayed, true);
  assert.equal(version(f), documentVersion + 1);
  assert.deepEqual(f.read().revision, frozen);
  f.state.parts = {};
  for (const axis of ["stock", "finance"]) assert.equal((await f.effect(axis, { intent: "apply_skipped" })).state, "aplicado");
  unique(f);
});

test("observações internas antes do envio não invalidam preparação nem efeitos", async t => {
  const f = setup(t); await f.prepare();
  const prepared = structuredClone(f.read().revision);
  f.rpc("erp_document_notes_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(),
    p_notes: null, p_internal_notes: "Instrução operacional que não vai ao XML." });
  assert.equal((await f.service.emit(f.emitInput())).status, "autorizada");
  assert.deepEqual(f.read().revision, prepared);
  unique(f);
});

for (const state of ["autorizada", "cancelada", "rejeitada"]) test(`lixeira mantém vínculo ${state} mesmo com efeitos pulados e Fiscal desligada`, async t => {
  const f = setup(t); await f.prepare(); f.state.parts = { stock: false, finance: false };
  if (state === "rejeitada") f.state.reject = true;
  await f.service.emit(f.emitInput());
  if (state === "cancelada") await f.service.cancel(f.cancelInput());
  assert.equal(f.read().status, state);
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
  const input = { p_kind: "sales_orders", p_action: "delete", p_command_id: randomUUID(), p_ids: [f.order.id], p_reason: "Ensaio de exclusão" };
  const result = f.rpc("erp_document_trash", input, { parts: { fiscal: false } });
  assert.deepEqual(result.results, [{ id: f.order.id, ok: false, reason: "invoice_linked" }]);
  assert.equal(f.rpc("erp_document_trash", input, { parts: { fiscal: false } }).replayed, true);
  assert.equal(row(f, "SELECT deleted_at FROM erp_documents__document WHERE id=?", f.order.id).deleted_at, null);
  assert.equal(f.read().status, state);
});
