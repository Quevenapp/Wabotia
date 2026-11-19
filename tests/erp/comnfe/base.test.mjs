import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_PEOPLE } from "./fixtures.mjs";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { bindCom1Authority, requireCom1Access } from "../../../src/erp/domains/fiscal/comnfe/access.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import {
  COM1_TABLES as T, com1Hash, com1Reference, com1Sha256, savePreparation, claimStoredOperation,
  recordExternalEvidence, getStoredEmission, getStoredRevision, getCommand, getEffects,
  saveEffect, startCommand, finishCommand, requireClaimedCommand,
  claimStoredCancellation, recordCancellationEvidence, saveCancellationXml,
} from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const connection = com1Sha256("https://cofre.invalid|11222333000181");
const error = message => e => e.message === message;
const key = "35261111222333000181550010000000011000000010";

function preparation(f, changes = {}) {
  const command = randomUUID();
  const body = {
    ambiente: "homologacao", referencia: com1Reference(f.order.id, 1), naturezaOperacao: "Venda de mercadorias",
    tipo: "saida", finalidade: "normal", presenca: "presencial", consumidorFinal: true,
    emitente: { cnpj: f.company.cnpj }, destinatario: { cnpj: "19131243000197" },
    itens: [{ codigo: "P1", descricao: "Mercadoria", unidade: "UN", quantidade: 2, valorUnitario: 25.5 }],
    pagamentos: [{ forma: "15", valor: 51 }],
  };
  // Fixture fiscal resumida: estes testes provam armazenamento, não o mapper.
  return {
    command_id: command, args: { document_id: f.order.id, command_id: command, expected_document_version: f.order.version },
    document_id: f.order.id, expected_document_version: f.order.version,
    environment: "homologacao", connection_fingerprint: connection,
    snapshot: { document: f.orderBody, items: f.orderBody.items, company: f.company, recipient: {}, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: { nature_version: 1 }, commercial_hash: com1Hash(f.orderBody), source_fingerprint: com1Hash({ order: f.order.id, nature: 1 }),
    body, calculation: { total_cents: "5100" }, blockers: [], ...changes,
  };
}
function prepared(f, changes = {}) {
  const input = preparation(f, changes);
  return { input, view: f.transaction(ctx => savePreparation(ctx, input)).emission };
}
function claimInput(view, changes = {}) {
  return { emission_id: view.id, command_id: randomUUID(), action: "emit", expected_version: view.version,
    body_revision: view.current_body_revision, body_hash: view.revision.body_hash,
    connection_fingerprint: connection, source_fingerprint: view.revision.source_fingerprint, ...changes };
}
function claimed(f, view) {
  const input = claimInput(view);
  return { input, claim: f.transaction(ctx => claimStoredOperation(ctx, input)) };
}
function result(view, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: "nfe_com1_test", reference: view.reference,
    environment: view.environment, series: "1", number: 1, access_key: key, protocol: "135260000000001",
    nfse_number: null, issued_at: "2026-11-19T12:00:00Z", authorized_at: "2026-11-19T12:00:01Z", total: 51,
    qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true,
    replayed: false, event_repeated: null, contingency: null, ...changes };
}
function evidence(claim, output, extra = {}) {
  return { emission_id: claim.emission.id, command_id: claim.command.id, claim_token: claim.command.token,
    connection_fingerprint: connection, result: output, ...extra };
}
function authorized(f) {
  const p = prepared(f), c = claimed(f, p.view);
  return f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view))));
}
const count = (f, table) => f.lite.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test("contratos: defaults conservadores e nenhum slot emite ou conclui efeito", t => {
  const f = com1Fixture(t), settings = f.rpc("erp_com1_config_get");
  assert.equal(settings.environment, "homologacao");
  assert.equal(settings.stock_timing, "existing");
  assert.equal(settings.finance_timing, "existing");
  assert.ok(settings.checklist.some(c => c.code === "homologation"));
  const p = prepared(f), c = claimInput(p.view);
  const calls = [
    ["erp_com1_prepare", { document_id: f.order.id, command_id: randomUUID(), expected_document_version: f.order.version, choices: { nature_id: f.nature.id, presence: "1", final_consumer: true } }],
    ["erp_com1_get", { emission_id: p.view.id }], ["erp_com1_list", { environment: "homologacao" }],
    ["erp_com1_claim", c], ["erp_com1_cancel_claim", { emission_id: p.view.id, command_id: randomUUID(), expected_version: 1, justification: "Cancelamento de teste", connection_fingerprint: connection }],
    ["erp_com1_effect_apply", { emission_id: p.view.id, command_id: randomUUID(), expected_version: 1, axis: "stock", intent: "apply" }],
    ["erp_com1_effect_reverse", { emission_id: p.view.id, command_id: randomUUID(), expected_version: 1, axis: "finance", intent: "reverse" }],
  ];
  for (const [name, input] of calls) assert.throws(() => f.rpc(name, { p_input: input }), error("com1_not_ready"), name);
  assert.equal(f.transaction(ctx => getStoredEmission(ctx, p.view.id)).status, "preparada");
  assert.equal(count(f, T.effect), 0);
});

test("preparo bloqueado conserva todos os bloqueios e não reivindica cofre", t => {
  const f = com1Fixture(t);
  const p = prepared(f, { body: null, connection_fingerprint: null, blockers: [
    { code: "fiscal_product_incomplete", field: "items.0.ncm", message: "Complete o NCM.", correction: { screen: "products", id: f.product.id, field: "ncm" } },
    { code: "fiscal_provider_not_configured", field: "connection", message: "Configure o cofre.", correction: { screen: "settings" } },
  ] });
  assert.equal(p.view.status, "bloqueada");
  assert.equal(p.view.revision.blockers[0].field, "connection");
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, claimInput(p.view, { connection_fingerprint: null }))), error("com1_preparation_blocked"));
  assert.equal(count(f, T.command), 1);
});

test("comando repetido não cria revisão; ator/argumentos diferentes conflitam", t => {
  const f = com1Fixture(t), p = prepared(f);
  const replay = f.transaction(ctx => savePreparation(ctx, p.input));
  assert.equal(replay.replayed, true);
  assert.equal(replay.emission.id, p.view.id);
  assert.equal(count(f, T.revision), 1);
  assert.throws(() => f.transaction(ctx => savePreparation(ctx, { ...p.input, args: { changed: true } })), error("fiscal_command_conflict"));
  assert.throws(() => f.transaction(ctx => savePreparation(ctx, p.input), { role: "fiscal" }), error("fiscal_command_conflict"));
});

test("duplo clique e duas abas só reivindicam uma operação", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  assert.equal(c.claim.disposition, "send");
  assert.equal(f.transaction(ctx => claimStoredOperation(ctx, c.input)).disposition, "replay");
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, { ...c.input, command_id: randomUUID() })), error("com1_version_conflict"));
  assert.equal(count(f, T.command), 2);
  assert.equal(count(f, T.emission), 1);
});

test("resposta perdida e lease vencida conservam corpo/referência; só retomada", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  const pending = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, null, { error: { code: "timeout", message: "Resposta perdida" } })));
  assert.equal(pending.status, "incerta");
  assert.throws(() => f.transaction(ctx => savePreparation(ctx, preparation(f, { expected_emission_version: pending.version }))), error("fiscal_emission_open"));
  f.clock.advance(120000);
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, claimInput(pending))), error("com1_resume_required"));
  const resumed = f.transaction(ctx => claimStoredOperation(ctx, claimInput(pending, { action: "resume" })));
  assert.equal(resumed.disposition, "resume");
  assert.equal(resumed.command.request.body_text, c.claim.command.request.body_text);
  assert.equal(resumed.command.request.reference, p.view.reference);
  assert.equal(resumed.command.request.body_hash, p.view.revision.body_hash);
  assert.equal(count(f, T.revision), 1);
  assert.equal(count(f, T.emission), 1);
});

test("evidência interna sobrevive a perda de pessoa e partes, sem autorizar outro envio", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  const undo = installCommercialNfeSlots({ record: recordExternalEvidence }); t.after(undo);
  const input = evidence(c.claim, result(p.view));
  const output = callRpc(f.db, "erp_com1_record", { p_input: input }, f.clock, { identity: { actor: null, people: null }, parts: Object.fromEntries(Object.keys(f.parts).map(k => [k, false])) });
  assert.equal(output.status, "autorizada");
  assert.equal(output.environment_confirmed, true);
  assert.equal(count(f, T.effect), 0);
  assert.throws(() => callRpc(f.db, "erp_com1_record", { p_input: { ...input, claim_token: randomUUID() } }, f.clock), error("com1_claim_required"));
});

test("resposta incompleta/divergente fica incerta e autorização não regride", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  let output = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { protocol: null }))));
  assert.equal(output.status, "incerta");
  output = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { series: "2" }))));
  assert.equal(output.status, "incerta");
  output = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { environment: "producao" }))));
  assert.equal(output.status, "incerta");
  output = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view))));
  assert.equal(output.status, "autorizada");
  output = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { status: "rejected" }))));
  assert.equal(output.status, "autorizada");
  const receipt = f.transaction(ctx => getCommand(ctx, c.claim.command.id));
  assert.equal(receipt.result.evidence.length, 5);
  assert.equal(receipt.error.code, "com1_late_conflicting_evidence");
  assert.equal(count(f, T.effect), 0);
});

test("rejeição conclusiva permite nova revisão na mesma referência; versão técnica é independente", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  const rejected = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { status: "rejected", protocol: null, access_key: null }))));
  f.db.exec("UPDATE erp_documents__document SET version=version+1 WHERE id=?", f.order.id);
  const next = preparation(f, { expected_document_version: f.order.version + 1, expected_emission_version: rejected.version });
  const updated = f.transaction(ctx => savePreparation(ctx, next)).emission;
  assert.equal(updated.reference, p.view.reference);
  assert.equal(updated.fiscal_version, 1);
  assert.equal(updated.current_body_revision, 2);
  assert.equal(updated.revision.source_document_version, f.order.version + 1);
  assert.equal(f.transaction(ctx => getStoredRevision(ctx, updated.id, 1)).source_document_version, f.order.version);
  assert.throws(() => f.db.exec(`UPDATE ${T.revision} SET blockers='[]' WHERE emission_id=?`, updated.id), /immutable/);
  assert.throws(() => f.db.exec(`DELETE FROM ${T.audit}`), /immutable/);
});

test("outra conexão, outro ambiente e fonte alterada não ganham reivindicação", t => {
  const f = com1Fixture(t), p = prepared(f);
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, claimInput(p.view, { connection_fingerprint: com1Hash("outra") }))), error("fiscal_connection_changed"));
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, claimInput(p.view, { source_fingerprint: com1Hash("mudou") }))), error("fiscal_source_changed"));
  assert.throws(() => f.transaction(ctx => savePreparation(ctx, preparation(f, { environment: "producao", expected_emission_version: 1 }))), error("fiscal_environment_conflict"));
  assert.equal(count(f, T.command), 1);
});

test("papéis, sessão indireta e agente sem confirmação recusam antes do slot", t => {
  const f = com1Fixture(t), p = prepared(f), input = claimInput(p.view);
  let claimedCount = 0;
  const undo = installCommercialNfeSlots({ claim() { claimedCount++; throw new Error("chegou"); } }); t.after(undo);
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: input }, { role: "vendas" }), error("fiscal_forbidden"));
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: input }, { actor: { session_id: null } }), error("fiscal_session_required"));
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: input }, { actor: { is_agent: true } }), error("fiscal_confirmation_required"));
  assert.equal(claimedCount, 0);
  assert.equal(count(f, T.command), 1);
});

test("bot confirmado e concessão futura usam a mesma política; origem externa sempre recusada", t => {
  const f = com1Fixture(t);
  const run = authority => f.transaction(ctx => { bindCom1Authority(ctx, authority); return requireCom1Access(ctx, "emit"); }, { actor: { is_agent: true } });
  assert.equal(run({ origin: "application", proposed_by: "bot-de-ensaio", confirmed_by: COM1_PEOPLE.admin.user_id, confirmation_id: "approval-1" }).user_id, COM1_PEOPLE.admin.user_id);
  assert.equal(run({ origin: "application", autonomous: true }).user_id, COM1_PEOPLE.admin.user_id);
  assert.throws(() => run({ origin: "external", autonomous: true }), error("fiscal_external_origin_forbidden"));
});

test("partes para primeiro envio e histórico têm exigências distintas", t => {
  const f = com1Fixture(t), p = prepared(f), input = claimInput(p.view);
  for (const part of ["customers", "products", "sales", "fiscal"]) {
    assert.throws(() => f.rpc("erp_com1_claim", { p_input: input }, { parts: { [part]: false } }), e => e.code === "module_disabled", part);
  }
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: { ...input, action: "resume" } }, { parts: { sales: false, products: false } }), error("com1_not_ready"));
  assert.throws(() => f.rpc("erp_com1_get", { p_input: { emission_id: p.view.id } }, { parts: { sales: false, stock: false, finance: false } }), error("com1_not_ready"));
  assert.equal(count(f, T.command), 1);
});

test("RPC público recusa resultado fiscal fabricado e não expõe capacidade no view", t => {
  const f = com1Fixture(t), p = prepared(f);
  assert.throws(() => f.rpc("erp_com1_prepare", { p_input: { document_id: f.order.id, command_id: randomUUID(), expected_document_version: 1, choices: {}, status: "autorizada" } }), error("com1_input_invalid"));
  assert.throws(() => f.rpc("erp_com1_get", { p_input: { emission_id: p.view.id, access_key: key } }), error("com1_input_invalid"));
  assert.equal(Object.hasOwn(p.view, "token"), false);
  assert.equal(Object.hasOwn(p.view, "claim_token"), false);
  assert.throws(() => f.transaction(ctx => requireClaimedCommand(ctx, { emission_id: p.view.id, command_id: p.input.command_id, claim_token: randomUUID() })), error("com1_claim_required"));
});

test("configuração tem recibo único, seleção conferida e produção explicitamente habilitada", t => {
  const f = com1Fixture(t);
  const save = { command_id: randomUUID(), expected_version: 1, environment: "homologacao", stock_timing: "on_authorization", finance_timing: "on_authorization" };
  const first = f.rpc("erp_com1_config_save", { p_input: save });
  assert.deepEqual(f.rpc("erp_com1_config_save", { p_input: save }), first);
  assert.equal(count(f, T.command), 1);
  assert.throws(() => f.rpc("erp_com1_config_save", { p_input: { ...save, finance_timing: "existing" } }), error("fiscal_command_conflict"));
  assert.throws(() => f.rpc("erp_com1_config_save", { p_input: { ...save, command_id: randomUUID(), expected_version: 2, environment: "producao" } }), error("fiscal_production_not_enabled"));
  const undo = installCommercialConnectionResolver(() => ({ fingerprint: connection, provider: "nfapi", origin: "https://cofre.invalid", issuer_cnpj: f.company.cnpj,
    version: "0.12.0", checked_at: "1795089600000000", compatible: true, company_matches: true, company_complete: true,
    environments: ["homologacao", "producao"], series: [{ environment: "homologacao", series: 1 }, { environment: "producao", series: 1 }] })); t.after(undo);
  const prod = f.rpc("erp_com1_config_save", { p_input: { ...save, command_id: randomUUID(), expected_version: 2, environment: "producao", enable_production: true, acknowledge_tax_limits: true, series_producao: 1 } });
  assert.equal(prod.production_enabled_by, COM1_PEOPLE.admin.user_id);
  assert.equal(prod.environment, "producao");
  assert.equal(JSON.stringify(prod).includes("api_key"), false);
  assert.equal(count(f, T.audit), 2);
});

test("efeito pulado é persistido e religar não o aplica; repetição não duplica IDs", t => {
  const f = com1Fixture(t), view = authorized(f);
  const effect = { emission_id: view.id, axis: "stock", state: "pulado", origin: null, ids: {}, fingerprint: null, reason: "part_disabled",
    responsible_role: "estoque", person_id: COM1_PEOPLE.admin.user_id, command_id: null, result: null,
    compensation_state: null, compensation_command_id: null, compensation_result: null, updated_at: "0" };
  f.transaction(ctx => saveEffect(ctx, effect), { parts: { stock: false } });
  const applied = { ...effect, state: "aplicado", origin: "order", ids: { posting_id: randomUUID() }, fingerprint: com1Hash("efeito"), reason: null };
  assert.throws(() => f.transaction(ctx => saveEffect(ctx, applied)), error("com1_effect_explicit_retry_required"));
  const command = f.transaction(ctx => startCommand(ctx, { command_id: randomUUID(), action: "effect_apply", args: { axis: "stock" }, emission_id: view.id }));
  applied.command_id = command.id;
  const output = f.transaction(ctx => { const value = saveEffect(ctx, applied, { apply_skipped: true }); finishCommand(ctx, command.id, "completed", { ids: applied.ids }); return value; });
  assert.deepEqual(f.transaction(ctx => saveEffect(ctx, applied)).ids, output.ids);
  assert.equal(count(f, T.effect), 1);
  assert.throws(() => f.transaction(ctx => saveEffect(ctx, { ...applied, ids: { posting_id: randomUUID() } })), error("com1_effect_reconciliation_required"));
  assert.equal(f.transaction(ctx => getStoredEmission(ctx, view.id)).status, "autorizada");
  assert.equal(f.transaction(ctx => getEffects(ctx, view.id)).length, 1);
});

test("autorização tardia de revisão antiga conserva evidência e exige reconciliação", t => {
  const f = com1Fixture(t), p = prepared(f), c = claimed(f, p.view);
  const rejected = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view, { status: "rejected", protocol: null, access_key: null }))));
  const revised = f.transaction(ctx => savePreparation(ctx, preparation(f, { expected_emission_version: rejected.version }))).emission;
  const late = f.transaction(ctx => recordExternalEvidence(ctx, evidence(c.claim, result(p.view))));
  assert.equal(late.status, "incerta");
  assert.equal(late.current_body_revision, revised.current_body_revision);
  assert.equal(f.transaction(ctx => getCommand(ctx, c.claim.command.id)).error.code, "com1_late_revision_evidence");
  assert.throws(() => f.transaction(ctx => claimStoredOperation(ctx, claimInput(late))), error("com1_resume_required"));
});

test("cancelamento perdido retoma o mesmo corpo; resultado fiscal sobrevive sem compensação", t => {
  const f = com1Fixture(t), view = authorized(f);
  const input = { emission_id: view.id, command_id: randomUUID(), expected_version: view.version,
    justification: "Venda cancelada no ensaio comercial", connection_fingerprint: connection };
  const claim = f.transaction(ctx => claimStoredCancellation(ctx, input));
  assert.equal(claim.disposition, "send");
  assert.equal(f.transaction(ctx => claimStoredCancellation(ctx, input)).disposition, "replay");
  const lost = f.transaction(ctx => recordCancellationEvidence(ctx, { ...evidence(claim, null), state: "incerto", error: { code: "timeout", message: "Resposta perdida" } }));
  assert.equal(lost.status, "autorizada");
  assert.equal(lost.cancellation.state, "incerto");
  f.clock.advance(120000);
  assert.throws(() => f.transaction(ctx => claimStoredCancellation(ctx, { ...input, command_id: randomUUID(), expected_version: lost.version, justification: "Outro motivo não confirmado" })), error("com1_cancellation_resume_required"));
  const resumed = f.transaction(ctx => claimStoredCancellation(ctx, { ...input, command_id: randomUUID(), expected_version: lost.version }));
  assert.equal(resumed.disposition, "resume");
  assert.equal(resumed.command.request.body_text, claim.command.request.body_text);
  const cancelled = inTransaction(f.db, ctx => recordCancellationEvidence(ctx, {
    ...evidence(resumed, result(view, { status: "cancelled", event_repeated: true })), state: "registrado",
    event_protocol: "135260000000099", event_at: "1795089660000000",
  }), f.clock, { identity: { actor: null, people: null }, parts: { customers: false, fiscal: false } });
  assert.equal(cancelled.status, "cancelada");
  assert.equal(cancelled.protocol, view.protocol);
  assert.equal(cancelled.cancellation.protocol, "135260000000099");
  assert.equal(cancelled.cancellation.repeated, true);
  assert.equal(cancelled.cancellation.xml_status, "pendente");
  assert.equal(count(f, T.cancel), 1);
  assert.equal(count(f, T.effect), 0);
  const xml = '<procEventoNFe versao="1.00"><evento>Ensaio</evento></procEventoNFe>';
  const xmlInput = { emission_id: view.id, command_id: resumed.command.id, claim_token: resumed.command.token, xml, xml_hash: com1Sha256(xml) };
  const archived = f.transaction(ctx => saveCancellationXml(ctx, xmlInput));
  assert.equal(archived.xml_status, "disponivel");
  assert.deepEqual(f.transaction(ctx => saveCancellationXml(ctx, xmlInput)), archived);
  assert.throws(() => f.transaction(ctx => saveCancellationXml(ctx, { ...xmlInput, xml: "outro", xml_hash: com1Sha256("outro") })), error("com1_cancellation_xml_conflict"));
});

test("cancelamento confirmado sem metadados próprios não inventa protocolo de evento", t => {
  const f = com1Fixture(t), view = authorized(f);
  const claim = f.transaction(ctx => claimStoredCancellation(ctx, { emission_id: view.id, command_id: randomUUID(), expected_version: view.version,
    justification: "Venda cancelada no ensaio comercial", connection_fingerprint: connection }));
  const output = f.transaction(ctx => recordCancellationEvidence(ctx, { ...evidence(claim, result(view, { status: "cancelled" })), state: "registrado" }));
  assert.equal(output.status, "cancelada");
  assert.equal(output.cancellation.state, "incerto");
  assert.equal(output.cancellation.protocol, null);
  assert.equal(output.cancellation.event_at, null);
  assert.equal(f.transaction(ctx => getCommand(ctx, claim.command.id)).error.code, "com1_cancellation_event_incomplete");
  const completed = f.transaction(ctx => recordCancellationEvidence(ctx, {
    ...evidence(claim, result(view, { status: "cancelled" })), state: "registrado", event_protocol: "135260000000099", event_at: "1795089660000000",
  }));
  assert.equal(completed.cancellation.state, "registrado");
});
