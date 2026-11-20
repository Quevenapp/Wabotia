// Achado 6 da revisão de dinheiro, estoque e nota: a nota autorizada cuja
// resposta se perdeu e que foi cancelada diretamente no cofre antes da
// retomada. Serviço real sobre RPC/SQLite, cofre simulado e sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { com1Fixture } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { createCommercialNfeLifecycle } from "../../../src/erp/domains/fiscal/comnfe/lifecycle.ts";
import { commercialNfeReadSlots } from "../../../src/erp/domains/fiscal/comnfe/reads.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { applyEffects, reverseEffects } from "../../../src/erp/domains/fiscal/comnfe/effects.ts";
import { COM1_TABLES as T, COM1_EXTERNAL_CANCELLATION_JUSTIFICATION, com1Hash, com1Reference, com1Sha256, savePreparation } from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const fingerprint = com1Sha256("https://cofre.invalid|11222333000181");
const accessKey = "35261111222333000181550010000000011000000010";
const cancellationXml = () => `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento></infEvento></evento><retEvento><infEvento><tpAmb>2</tpAmb><chNFe>${accessKey}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>135260000000002</nProt><dhRegEvento>2026-11-19T12:02:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;
function result(view, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: "nfe_simulada", reference: view.reference, environment: view.environment,
    series: "1", number: 1, access_key: accessKey, protocol: "135260000000001", nfse_number: null, issued_at: "2026-11-19T12:00:00Z",
    authorized_at: "2026-11-19T12:00:01Z", total: 51, qr_code: null, consult_url: null, corrections: 0, messages: [],
    xml_available: true, replayed: false, event_repeated: null, contingency: null, ...changes };
}

function setup(t) {
  const f = com1Fixture(t);
  t.after(installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: "1795089600000000", compatible: true, company_matches: true,
    company_complete: true, environments: ["homologacao", "producao"], series: [{ environment: "homologacao", series: 1 }] })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "on_authorization", finance_timing: "on_authorization", acknowledge_tax_limits: true } });
  const slots = createCommercialNfeLifecycle({ sourceFingerprint: (_ctx, revision) => revision.source_fingerprint });
  t.after(installCommercialNfeSlots({ ...commercialNfeReadSlots, ...slots, applyEffects, reverseEffects }));
  const view = f.transaction(ctx => savePreparation(ctx, {
    command_id: randomUUID(), args: { order: f.order.id }, document_id: f.order.id, expected_document_version: f.order.version,
    environment: "homologacao", connection_fingerprint: fingerprint,
    snapshot: { document: { ...f.orderBody, id: f.order.id }, items: f.orderBody.items, company: f.company,
      recipient: { id: f.customer.id, cnpj: "19131243000197", name: "Cliente do Ensaio" }, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: {}, commercial_hash: com1Hash(f.orderBody), source_fingerprint: com1Hash({ order: f.order.id }),
    body: { ambiente: "homologacao", referencia: com1Reference(f.order.id, 1), naturezaOperacao: "Venda de mercadorias", emitente: { cnpj: f.company.cnpj },
      destinatario: { cnpj: "19131243000197" }, itens: [{ codigo: "P1", quantidade: 2, valorUnitario: 25.5 }], pagamentos: [{ forma: "15", valor: 51 }] },
    calculation: { total_cents: "5100" }, blockers: [],
  })).emission;
  const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"];
  const rpc = (name, args = {}) => evidence.includes(name)
    ? callRpc(f.db, name, args, f.clock, { ...f.env(), identity: { actor: null, people: null } }) : f.rpc(name, args);
  const read = () => rpc("erp_com1_get", { p_input: { emission_id: view.id } });
  const external = [], remote = { value: null };
  const provider = {
    async emit() { external.push("emit"); throw new Error("sem resposta"); },
    async find() { external.push("find"); return structuredClone(remote.value); },
    async get() { external.push("get"); return structuredClone(remote.value); },
    async reconcile() { external.push("reconcile"); return structuredClone(remote.value); },
    async cancel() { external.push("cancel"); throw new Error("não deve pedir outro cancelamento"); },
    async cancellationXml() { external.push("cancel_xml"); return cancellationXml(); },
  };
  const bridge = { async call(name, input) { return rpc(name, name === "erp_com1_config_get" ? {} : { p_input: input }); } };
  const service = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  return { ...f, view, read, external, remote, provider, service };
}

test("achado 6: retomada reconhece a nota cancelada no cofre, registra o cancelamento, recupera evento e XML e abre as compensações", async t => {
  const f = setup(t);
  assert.equal((await f.service.emit({ emission_id: f.view.id, command_id: randomUUID(), expected_version: f.read().version,
    body_revision: 1, body_hash: f.view.revision.body_hash })).status, "incerta");
  // O cofre autorizou e, antes da retomada no ERP, um operador cancelou a nota lá.
  f.remote.value = result(f.view, { status: "cancelled" });
  f.clock.advance(61_000);
  const resumed = await f.service.resume({ emission_id: f.view.id, command_id: randomUUID(), expected_version: f.read().version, body_revision: 1 });
  assert.equal(resumed.status, "cancelada");
  assert.equal(resumed.access_key, accessKey);
  assert.equal(resumed.protocol, "135260000000001");
  assert.equal(resumed.cancellation.state, "registrado");
  assert.equal(resumed.cancellation.justification, COM1_EXTERNAL_CANCELLATION_JUSTIFICATION);
  assert.equal(resumed.cancellation.protocol, "135260000000002");
  assert.equal(resumed.cancellation.xml_status, "disponivel");
  assert.deepEqual(resumed.effects.map(e => [e.axis, e.compensation_state]), [["finance", "compensacao_pendente"], ["stock", "compensacao_pendente"]]);
  assert.ok(!f.external.includes("cancel"), "nenhum novo pedido de cancelamento");
  assert.deepEqual(f.external, ["emit", "find", "get", "cancel_xml"]);
  assert.equal(f.lite.prepare(`SELECT count(*) n FROM ${T.emission}`).get().n, 1);
  assert.equal(f.lite.prepare(`SELECT count(*) n FROM ${T.audit} WHERE action='cancel_external'`).get().n, 1);
});

test("achado 6: XML indisponível na retomada deixa a nota cancelada e o evento retoma pela mesma justificativa, sem novo cancelamento", async t => {
  const f = setup(t);
  await f.service.emit({ emission_id: f.view.id, command_id: randomUUID(), expected_version: f.read().version, body_revision: 1, body_hash: f.view.revision.body_hash });
  f.remote.value = result(f.view, { status: "cancelled" });
  f.clock.advance(61_000);
  f.provider.cancellationXml = async () => { f.external.push("cancel_xml"); throw new Error("download indisponível"); };
  const resumed = await f.service.resume({ emission_id: f.view.id, command_id: randomUUID(), expected_version: f.read().version, body_revision: 1 });
  assert.equal(resumed.status, "cancelada");
  assert.equal(resumed.cancellation.state, "incerto");
  f.clock.advance(61_000);
  f.provider.cancellationXml = async () => { f.external.push("cancel_xml"); return cancellationXml(); };
  const finished = await f.service.cancel({ emission_id: f.view.id, command_id: randomUUID(), expected_version: f.read().version,
    justification: COM1_EXTERNAL_CANCELLATION_JUSTIFICATION });
  assert.equal(finished.cancellation.state, "registrado");
  assert.equal(finished.cancellation.xml_status, "disponivel");
  assert.ok(!f.external.includes("cancel"));
});
