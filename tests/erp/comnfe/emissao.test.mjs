import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCommercialNfeService, freezeCommercialVaultSession } from "../../../src/erp/commercial-nfe/service.ts";
import { CommercialNfeError } from "../../../src/erp/commercial-nfe/artifacts.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { com1Fixture } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { createCommercialNfeLifecycle } from "../../../src/erp/domains/fiscal/comnfe/lifecycle.ts";
import { commercialNfeReadSlots, readCommercialEmission, listCommercialEmissions } from "../../../src/erp/domains/fiscal/comnfe/reads.ts";
import { bindCom1Authority } from "../../../src/erp/domains/fiscal/comnfe/access.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { COM1_TABLES as T, com1Hash, com1Reference, com1Sha256, savePreparation, getCommand, getEmissionView } from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const fingerprint = com1Sha256("https://cofre.invalid|11222333000181");
const accessKey = "35261111222333000181550010000000011000000010";
const error = message => e => e.message === message;
const reason = "Pedido cancelado antes da saída física";
function setup(t, options = {}) {
  const f = com1Fixture(t);
  const restoreConnection = installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: "1795089600000000", compatible: true, company_matches: true,
    company_complete: true, environments: ["homologacao", "producao"], series: [{ environment: "homologacao", series: 1 }] }));
  t.after(restoreConnection);
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  const slots = createCommercialNfeLifecycle({ sourceFingerprint: (_ctx, revision) => revision.source_fingerprint, ...options });
  t.after(installCommercialNfeSlots({ ...commercialNfeReadSlots, ...slots }));
  const input = {
    command_id: randomUUID(), args: { order: f.order.id }, document_id: f.order.id, expected_document_version: f.order.version,
    environment: "homologacao", connection_fingerprint: fingerprint,
    snapshot: { document: { ...f.orderBody, id: f.order.id }, items: f.orderBody.items, company: f.company,
      recipient: { id: f.customer.id, cnpj: "19131243000197", name: "Cliente do Ensaio" }, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: {}, commercial_hash: com1Hash(f.orderBody), source_fingerprint: com1Hash({ order: f.order.id }),
    body: { ambiente: "homologacao", referencia: com1Reference(f.order.id, 1), naturezaOperacao: "Venda de mercadorias", emitente: { cnpj: f.company.cnpj },
      destinatario: { cnpj: "19131243000197" }, itens: [{ codigo: "P1", quantidade: 2, valorUnitario: 25.5 }], pagamentos: [{ forma: "15", valor: 51 }] },
    calculation: { total_cents: "5100" }, blockers: [],
  };
  const view = f.transaction(ctx => savePreparation(ctx, input)).emission;
  const rpc = (name, args = {}, environment) => ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name)
    ? callRpc(f.db, name, args, f.clock, { ...f.env(environment), identity: { actor: null, people: null } })
    : f.rpc(name, args, environment);
  return { ...f, rpc, slots, input, view };
}
function claimInput(view, changes = {}) {
  return { emission_id: view.id, command_id: randomUUID(), action: "emit", expected_version: view.version,
    body_revision: view.current_body_revision, body_hash: view.revision.body_hash, connection_fingerprint: fingerprint, ...changes };
}
const claim = (f, view = f.view, changes = {}, environment) => f.rpc("erp_com1_claim", { p_input: claimInput(view, changes) }, environment);
const read = f => f.rpc("erp_com1_get", { p_input: { emission_id: f.view.id } });
function result(view, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: "nfe_simulada", reference: view.reference, environment: view.environment,
    series: "1", number: 1, access_key: accessKey, protocol: "135260000000001", nfse_number: null, issued_at: "2026-11-19T12:00:00Z",
    authorized_at: "2026-11-19T12:00:01Z", total: 51, qr_code: null, consult_url: null, corrections: 0, messages: [],
    xml_available: true, replayed: false, event_repeated: null, contingency: null, ...changes };
}
const capability = c => ({ emission_id: c.emission.id, command_id: c.command.id, claim_token: c.command.token });
const evidence = (c, output, extra = {}) => ({ ...capability(c), connection_fingerprint: fingerprint, result: output, ...extra });
const record = (f, c, output, extra) => f.rpc("erp_com1_record", { p_input: evidence(c, output, extra) });
const authorize = f => record(f, claim(f), result(f.view));
const cancelInput = (view, changes = {}) => ({ emission_id: view.id, command_id: randomUUID(), expected_version: view.version, justification: reason, connection_fingerprint: fingerprint, ...changes });
const cancelClaim = (f, view, changes = {}) => f.rpc("erp_com1_cancel_claim", { p_input: cancelInput(view, changes) });
const cancelRecord = (f, c, extra = {}) => f.rpc("erp_com1_cancel_record", { p_input: { ...evidence(c, result(c.emission, { status: "cancelled", event_repeated: false })), state: "registrado", event_protocol: "135260000000002", event_at: "1795089720000000", ...extra } });
const count = (f, table) => f.lite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const cancellationXml = () => `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>135260000000002</nProt><dhRegEvento>2026-11-19T12:02:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;

/** Porta assíncrona sobre RPC/transações SQLite reais, sem importar Vitest. */
function serviceSetup(t) {
  const f = setup(t), calls = [], external = [], remote = { value: null }, control = { failCommit: false, revoked: false };
  const provider = {
    async emit(_ctx, kind, body, key) {
      external.push({ action: "emit", kind, body, key });
      assert.equal(f.transaction(ctx => getEmissionView(ctx, f.view.id)).status === "enviando" || read(f).status === "incerta", true);
      remote.value ??= result(f.view);
      return structuredClone(remote.value);
    },
    async find() { external.push({ action: "find" }); return structuredClone(remote.value); },
    async get() { external.push({ action: "get" }); return structuredClone(remote.value); },
    async reconcile() { external.push({ action: "reconcile" }); return structuredClone(remote.value); },
    async cancel() {
      external.push({ action: "cancel" });
      assert.equal(read(f).cancellation.state, "enviando");
      remote.value = result(f.view, { status: "cancelled" });
      return structuredClone(remote.value);
    },
    async cancellationXml() { external.push({ action: "cancel_xml" }); return cancellationXml(); },
    async danfe() { external.push({ action: "danfe" }); const body = new TextEncoder().encode("%PDF-1.4\nEnsaio de bytes\n%%EOF"); return { body, size: body.length, content_type: "application/pdf" }; },
  };
  const bridge = { async call(name, input) {
    calls.push({ name, input });
    const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name);
    if (control.revoked && !evidence) throw new CommercialNfeError(403, "fiscal_forbidden", "Acesso revogado.");
    if (control.failCommit && name === "erp_com1_record") { control.failCommit = false; throw new Error("queda_commit"); }
    return f.rpc(name, name === "erp_com1_config_get" ? {} : { p_input: input });
  } };
  const service = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  const emitInput = (id = randomUUID()) => ({ emission_id: f.view.id, command_id: id, expected_version: read(f).version,
    body_revision: 1, body_hash: f.view.revision.body_hash });
  const resumeInput = () => ({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read(f).version, body_revision: 1 });
  const cancellationInput = () => ({ emission_id: f.view.id, command_id: randomUUID(), expected_version: read(f).version, justification: reason });
  return { ...f, calls, external, remote, control, provider, bridge, service, emitInput, resumeInput, cancellationInput };
}

test("serviço real: duas abas e recibo repetido não duplicam envio nem tentativa automática de efeitos", async t => {
  const f = serviceSetup(t), original = f.provider.emit;
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.provider.emit = async (...args) => { entered(); await barrier; return original(...args); };
  const input = f.emitInput(), pending = f.service.emit(input);
  await started;
  assert.equal((await f.service.emit(f.emitInput())).status, "enviando");
  release();
  assert.equal((await pending).status, "autorizada");
  assert.equal((await f.service.emit(input)).status, "autorizada");
  assert.equal(f.external.filter(c => c.action === "emit").length, 1);
  assert.deepEqual(f.calls.filter(c => c.name === "erp_com1_effect_apply").map(c => c.input.axis), ["stock", "finance"]);
  assert.deepEqual(read(f).effects.map(e => e.state), ["pendente", "pendente"]);
});

for (const accepted of [false, true]) test(`serviço real: resposta perdida ${accepted ? "depois" : "antes"} do aceite retoma a mesma referência`, async t => {
  const f = serviceSetup(t), original = f.provider.emit;
  f.provider.emit = async (...args) => { if (accepted) await original(...args); throw new Error("sem resposta"); };
  assert.equal((await f.service.emit(f.emitInput())).status, "incerta");
  f.provider.emit = original;
  f.clock.advance(61_000);
  assert.equal((await f.service.resume(f.resumeInput())).status, "autorizada");
  assert.equal(f.external.filter(c => c.action === "emit").length, 1);
  assert.equal(count(f, T.emission), 1);
  for (const receipt of f.calls.filter(c => c.name === "erp_com1_claim")) assert.equal(receipt.input.body_hash, f.view.revision.body_hash);
});

test("serviço real: falha antes do commit conserva operação retomável sem nova nota", async t => {
  const f = serviceSetup(t);
  f.control.failCommit = true;
  await assert.rejects(f.service.emit(f.emitInput()), /queda_commit/);
  assert.equal(read(f).status, "enviando");
  assert.equal(f.remote.value.status, "authorized");
  f.clock.advance(61_000);
  assert.equal((await f.service.resume(f.resumeInput())).status, "autorizada");
  assert.equal(f.external.filter(c => c.action === "emit").length, 1);
});

test("serviço real: preparação bloqueada não chega a resolver conexão externa", async t => {
  const f = serviceSetup(t);
  f.transaction(ctx => ctx.db.exec(`UPDATE ${T.emission} SET status='bloqueada' WHERE id=?`, f.view.id));
  const service = createCommercialNfeService({}, { bridge: f.bridge, vault: async () => { throw new Error("conexão indevida"); } });
  await assert.rejects(service.emit(f.emitInput()), e => e.status === 422 && e.code === "com1_preparation_blocked");
  assert.equal(f.external.length, 0);
});

test("serviço real: revogação durante consulta conserva evidência e impede chamada seguinte", async t => {
  const f = serviceSetup(t);
  f.provider.emit = async () => result(f.view, { status: "processing", protocol: null, access_key: null, authorized_at: null });
  await f.service.emit(f.emitInput());
  f.clock.advance(61_000);
  f.provider.get = async () => { f.control.revoked = true; return result(f.view, { status: "processing", protocol: null, access_key: null, authorized_at: null }); };
  await assert.rejects(f.service.resume(f.resumeInput()), e => e.status === 403);
  assert.equal(read(f).status, "processando");
  assert.equal(f.external.filter(c => c.action === "reconcile").length, 0);
});

test("serviço real: cancelamento, XML e compensações ficam separados e arquivamento não cancela novamente", async t => {
  const f = serviceSetup(t);
  await f.service.emit(f.emitInput());
  f.provider.cancellationXml = async () => { throw new Error("download indisponível"); };
  const cancelled = await f.service.cancel(f.cancellationInput());
  assert.equal(cancelled.status, "cancelada");
  assert.equal(cancelled.cancellation.xml_status, "pendente");
  assert.ok(cancelled.effects.every(e => e.compensation_state === "compensacao_pendente"));
  assert.equal((await f.service.cancellationXml({ emission_id: f.view.id })).status, 202);
  f.clock.advance(61_000);
  f.provider.cancellationXml = async () => cancellationXml();
  const archived = await f.service.cancel(f.cancellationInput());
  assert.equal(archived.cancellation.state, "registrado");
  assert.equal(archived.cancellation.xml_status, "disponivel");
  assert.equal(f.external.filter(c => c.action === "cancel").length, 1);
  assert.equal(await (await f.service.cancellationXml({ emission_id: f.view.id })).text(), cancellationXml());
});

test("serviço real: XML registrado pendente dispensa consulta e segundo cancelamento", async t => {
  const f = serviceSetup(t);
  const authorized = authorize(f), c = cancelClaim(f, authorized);
  cancelRecord(f, c);
  f.provider.get = async () => { throw new Error("não deve consultar evento conclusivo"); };
  f.provider.cancel = async () => { throw new Error("não deve recancelar"); };
  const archived = await f.service.cancel(f.cancellationInput());
  assert.equal(archived.cancellation.xml_status, "disponivel");
  assert.equal(f.external.filter(c => c.action === "cancel_xml").length, 1);
});

test("serviço real: DANFE mantém bytes privados da emissão vinculada", async t => {
  const f = serviceSetup(t);
  await f.service.emit(f.emitInput());
  const response = await f.service.danfe({ emission_id: f.view.id });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "%PDF-1.4\nEnsaio de bytes\n%%EOF");
});

test("sessão congelada fixa credencial, ambiente e origem e recusa redirecionamento", async t => {
  const f = serviceSetup(t), seen = [];
  const connection = { url: "https://cofre.invalid", api_key: "credencial-original" };
  const session = freezeCommercialVaultSession({ env: {}, profile: "ensaio" }, f.view, {
    provider: f.provider, connection, fingerprint,
    fetch: async request => { seen.push(request); return new Response("{}", { status: seen.length === 1 ? 200 : 302 }); },
  });
  connection.api_key = "credencial-nova";
  await session.context.fetch("https://cofre.invalid/v1/nfe?referencia=pedido", { headers: { Authorization: "Bearer outra" } });
  assert.equal(seen[0].headers.get("authorization"), "Bearer credencial-original");
  assert.equal(new URL(seen[0].url).searchParams.get("ambiente"), "homologacao");
  assert.equal(seen[0].redirect, "manual");
  await assert.rejects(session.context.fetch("https://cofre-alterado.invalid/v1/nfe"), e => e.code === "fiscal_connection_changed");
  await assert.rejects(session.context.fetch("https://cofre.invalid/v1/nfe"), e => e.code === "fiscal_connection_changed");
  assert.equal(seen.length, 2);
});

test("intenção persiste bytes, hash e identidade antes da chamada; repetição não cria envio", t => {
  const f = setup(t), input = claimInput(f.view);
  const c = f.rpc("erp_com1_claim", { p_input: input });
  assert.equal(c.disposition, "send");
  assert.equal(c.emission.status, "enviando");
  assert.equal(com1Sha256(c.command.request.body_text), c.command.request.body_hash);
  assert.equal(JSON.parse(c.command.request.body_text).referencia, f.view.reference);
  assert.deepEqual(c.command.result.effect_parts, { stock: true, finance: true });
  assert.equal(f.rpc("erp_com1_claim", { p_input: input }).disposition, "replay");
  const other = claim(f);
  assert.equal(other.disposition, "busy");
  assert.equal(other.command.token, null);
  assert.equal(count(f, T.emission), 1);
  assert.equal(f.lite.prepare(`SELECT count(*) n FROM ${T.command} WHERE token IS NOT NULL`).get().n, 1);
  const authorized = record(f, c, result(f.view));
  assert.equal(claim(f, authorized).disposition, "replay");
  assert.equal(count(f, T.effect), 2);
});

test("mesmo comando com outra pessoa ou outros argumentos conflita", t => {
  const f = setup(t), input = claimInput(f.view);
  f.rpc("erp_com1_claim", { p_input: input });
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: { ...input, expected_version: 90 } }), error("fiscal_command_conflict"));
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: input }, { role: "fiscal" }), error("fiscal_command_conflict"));
});

for (const [status, expected] of [["authorized", "autorizada"], ["rejected", "rejeitada"], ["denied", "denegada"], ["processing", "processando"], ["undetermined", "incerta"]]) {
  test(`resultado ${status} é persistido como ${expected}`, t => {
    const f = setup(t), c = claim(f);
    const view = record(f, c, result(f.view, { status }));
    assert.equal(view.status, expected);
    assert.equal(f.transaction(ctx => getCommand(ctx, c.command.id)).result.evidence.length, 1);
    assert.equal(count(f, T.effect), status === "authorized" ? 2 : 0);
  });
}

test("timeout, resposta malformada e autorização incompleta conservam incerteza e evidência", t => {
  const f = setup(t), c = claim(f);
  assert.equal(record(f, c, null, { error: { code: "fiscal_timeout", message: "Timeout secreto" } }).status, "incerta");
  assert.equal(record(f, c, { status: "authorized", provider_ref: 7, api_key: "nao-persistir" }).status, "incerta");
  const stored = f.transaction(ctx => getCommand(ctx, c.command.id));
  assert.equal(stored.result.evidence.length, 2);
  assert.ok(!JSON.stringify(stored).includes("nao-persistir"));
  assert.equal(record(f, c, result(f.view, { protocol: null })).status, "incerta");
  assert.equal(count(f, T.effect), 0);
});

test("resposta perdida e queda antes do commit retomam corpo e referência após lease", t => {
  const f = setup(t), original = claim(f), before = read(f);
  const busy = claim(f, before, { action: "resume" });
  assert.equal(busy.disposition, "busy");
  f.clock.advance(61_000);
  const resumed = claim(f, read(f), { action: "resume" });
  assert.equal(resumed.disposition, "resume");
  assert.equal(resumed.command.request.body_text, original.command.request.body_text);
  assert.equal(resumed.emission.reference, original.emission.reference);
  assert.equal(record(f, resumed, result(f.view)).status, "autorizada");
  assert.equal(record(f, original, result(f.view, { status: "rejected" })).status, "autorizada");
  assert.equal(count(f, T.emission), 1);
  assert.equal(count(f, T.effect), 2);
});

test("inconsistência de provedor, ambiente e chave não substitui evidência autorizada", t => {
  const f = setup(t), c = claim(f);
  assert.equal(record(f, c, result(f.view, { environment: "producao" })).status, "incerta");
  const view = record(f, c, result(f.view));
  const late = record(f, c, result(f.view, { provider_ref: "outro_cofre", access_key: accessKey.replace(/.$/, "9") }));
  assert.equal(late.status, "autorizada");
  assert.equal(late.provider_id, view.provider_id);
  assert.equal(late.access_key, view.access_key);
});

test("fontes mudadas bloqueiam antes do cofre e preparação sem dados não reivindica", t => {
  const f = setup(t, { sourceFingerprint: () => com1Sha256("mudou") });
  const c = claim(f);
  assert.equal(c.disposition, "replay");
  assert.equal(c.emission.status, "bloqueada");
  assert.equal(c.command.token, null);
  assert.equal(c.command.error.code, "fiscal_source_changed");
  assert.equal(f.lite.prepare(`SELECT count(*) n FROM ${T.command} WHERE token IS NOT NULL`).get().n, 0);
});

test("ausência de implementação de fontes fecha primeiro envio", t => {
  const f = setup(t, { sourceFingerprint: undefined });
  assert.throws(() => claim(f), error("com1_not_ready"));
  assert.equal(read(f).status, "preparada");
});

test("partes vizinhas desligadas permitem nota e persistem skip; Fiscal desligada só permite commit anterior", t => {
  const f = setup(t);
  const c = claim(f, f.view, {}, { parts: { stock: false, finance: false, billing: false, purchases: false, pos: false } });
  const view = f.transaction(ctx => f.slots.record(ctx, evidence(c, result(f.view))), { actor: { erp_role: null, session_id: null }, parts: { customers: false, fiscal: false } });
  assert.equal(view.status, "autorizada");
  assert.deepEqual(view.effects.map(e => [e.state, e.reason]), [["pulado", "part_disabled"], ["pulado", "part_disabled"]]);
  assert.throws(() => claim(f, view, {}, { parts: { fiscal: false } }));
});

test("papel fiscal e política sensível aceitam confirmação, recusam bot sem concessão e origem externa", t => {
  const f = setup(t);
  assert.throws(() => claim(f, f.view, {}, { role: "vendas" }), error("fiscal_forbidden"));
  assert.throws(() => claim(f, f.view, {}, { actor: { is_agent: true } }), error("fiscal_confirmation_required"));
  for (const actor of [{ is_technical: true }, { is_agent: true, session_id: null }])
    assert.throws(() => claim(f, f.view, {}, { actor }), error("fiscal_confirmation_required"));
  assert.throws(() => f.transaction(ctx => {
    bindCom1Authority(ctx, { origin: "external", autonomous: true });
    return f.slots.claim(ctx, claimInput(f.view));
  }), error("fiscal_external_origin_forbidden"));
  const c = f.transaction(ctx => {
    bindCom1Authority(ctx, { origin: "application", proposed_by: "bot-equipe", confirmed_by: ctx.identity.actor.user_id, confirmation_id: "proposta-confirmada" });
    return f.slots.claim(ctx, claimInput(f.view));
  }, { actor: { is_agent: true } });
  assert.equal(c.disposition, "send");
  assert.equal(c.command.proposed_by, "bot-equipe");
  assert.equal(c.command.confirmed_by, f.identity.actor.user_id);
});

test("retomada usa conexão congelada e não depende de Vendas ligada", t => {
  const f = setup(t), c = claim(f);
  record(f, c, null);
  f.clock.advance(61_000);
  assert.throws(() => claim(f, read(f), { action: "resume", connection_fingerprint: com1Sha256("outro") }), error("fiscal_connection_changed"));
  const resumed = claim(f, read(f), { action: "resume" }, { parts: { sales: false, products: false } });
  assert.equal(resumed.disposition, "resume");
  assert.equal(resumed.emission.environment, "homologacao");
});

test("leitura paginada filtra privacidade antes de total e não inclui recibo/capacidade/XML", t => {
  const f = setup(t), c = claim(f);
  record(f, c, result(f.view));
  const page = f.rpc("erp_com1_list", { p_input: { environment: "homologacao", page: 1, per_page: 1 } });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].command, undefined);
  assert.equal(page.items[0].claim_token, undefined);
  assert.equal(page.items[0].cancellation_xml, undefined);
  assert.equal(f.rpc("erp_com1_list", { p_input: { environment: "producao" } }).total, 0);
  assert.throws(() => f.rpc("erp_com1_list", { p_input: { environment: "homologacao", per_page: 101 } }), error("com1_invalid_page"));
  f.transaction(ctx => {
    ctx.identity.customer_privacy = { restricted_contact_ids: [f.customer.id] };
    assert.throws(() => readCommercialEmission(ctx, { emission_id: f.view.id }), error("com1_emission_not_found"));
    assert.deepEqual(listCommercialEmissions(ctx, { environment: "homologacao" }), { items: [], page: 1, per_page: 50, total: 0 });
  });
});

test("cancelamento persiste intenção e resultado antes da compensação; XML tem estado independente", t => {
  const f = setup(t), authorized = authorize(f), c = cancelClaim(f, authorized);
  assert.equal(c.disposition, "send");
  assert.equal(c.cancellation.state, "enviando");
  assert.equal(JSON.parse(c.command.request.body_text).justificativa, reason);
  const cancelled = cancelRecord(f, c);
  assert.equal(cancelled.status, "cancelada");
  assert.equal(cancelled.cancellation.state, "registrado");
  assert.equal(cancelled.cancellation.xml_status, "pendente");
  assert.ok(cancelled.effects.every(effect => effect.compensation_state === "compensacao_pendente"));
  const repeat = cancelClaim(f, cancelled);
  assert.equal(repeat.disposition, "replay");
  assert.equal(repeat.command.id, c.command.id);
  assert.equal(repeat.command.token, c.command.token);
  const xml = cancellationXml();
  f.rpc("erp_com1_cancel_xml_record", { p_input: { ...capability(repeat), xml, xml_hash: com1Sha256(xml) } });
  const current = read(f);
  assert.equal(current.cancellation.xml_status, "disponivel");
  assert.equal(current.cancellation_xml, xml);
  assert.equal(count(f, T.cancel), 1);
});

test("cancelamento aceito sem metadados do evento mantém nota cancelada e permite retomada", t => {
  const f = setup(t), c = cancelClaim(f, authorize(f));
  const view = f.rpc("erp_com1_cancel_record", { p_input: { ...evidence(c, result(c.emission, { status: "cancelled" })), state: "registrado" } });
  assert.equal(view.status, "cancelada");
  assert.equal(view.cancellation.state, "incerto");
  f.clock.advance(61_000);
  const resumed = cancelClaim(f, read(f));
  assert.equal(resumed.disposition, "resume");
  assert.equal(resumed.command.request.body_text, c.command.request.body_text);
  assert.equal(cancelRecord(f, resumed).cancellation.state, "registrado");
});

test("cancelamento recusado permite tentativa auditada; timeout conserva justificativa", t => {
  const f = setup(t), c = cancelClaim(f, authorize(f));
  const refused = cancelRecord(f, c, { state: "recusado", result: null, error: { code: "fiscal_cancellation_rejected", message: "Recusa conhecida" } });
  assert.equal(refused.status, "autorizada");
  assert.equal(refused.cancellation.state, "recusado");
  const retry = cancelClaim(f, refused, { justification: "Nova justificativa para cancelar a nota" });
  assert.equal(retry.disposition, "send");
  cancelRecord(f, retry, { state: "incerto", result: null, error: { code: "fiscal_timeout", message: "Tempo esgotado" } });
  f.clock.advance(61_000);
  assert.throws(() => cancelClaim(f, read(f)), error("com1_cancellation_resume_required"));
  const resumed = cancelClaim(f, read(f), { justification: "Nova justificativa para cancelar a nota" });
  assert.equal(resumed.disposition, "resume");
  assert.equal(count(f, T.cancel), 1);
});

test("commit interno exige token durável; XML de outra nota ou hash não confere", t => {
  const f = setup(t), c = claim(f);
  assert.throws(() => record(f, c, result(f.view), { claim_token: randomUUID() }), error("com1_claim_required"));
  const cancel = cancelClaim(f, record(f, c, result(f.view)));
  cancelRecord(f, cancel);
  const xml = cancellationXml();
  assert.throws(() => f.rpc("erp_com1_cancel_xml_record", { p_input: { ...capability(cancel), xml, xml_hash: com1Sha256("errado") } }), error("com1_cancellation_xml_invalid"));
  const foreign = xml.replaceAll(accessKey, accessKey.replace(/.$/, "9"));
  assert.throws(() => f.rpc("erp_com1_cancel_xml_record", { p_input: { ...capability(cancel), xml: foreign, xml_hash: com1Sha256(foreign) } }));
  assert.equal(read(f).cancellation.xml_status, "pendente");
  assert.equal(read(f).status, "cancelada");
});

test("falha local deixa duas pendências e nunca regride autorização/cancelamento", t => {
  const f = setup(t), view = authorize(f);
  assert.ok(view.effects.every(effect => effect.state === "pendente"));
  const c = cancelClaim(f, view);
  const cancelled = cancelRecord(f, c);
  assert.equal(cancelled.status, "cancelada");
  assert.ok(cancelled.effects.every(effect => effect.state === "pendente" && effect.compensation_state === "compensacao_pendente"));
  assert.equal(cancelRecord(f, c, { state: "recusado", result: result(c.emission) }).status, "cancelada");
});
