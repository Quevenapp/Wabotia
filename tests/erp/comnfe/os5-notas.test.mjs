// OS, parte 5: nota de serviço (NFS-e) e nota de peças (NF-e modelo 55) a
// partir do documento comercial que a fase 3 gerou para a ordem de serviço,
// pela mesma máquina da NF-e comercial (tabelas service_* para a NFS-e), com
// cofre simulado em memória. Sem rede, sem governo, sem cofre real.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { canonical, hash, uuid5, F3_NAMESPACES } from "../../../src/integrations/keys.ts";
import { ORIGIN_POLICY } from "../../../src/erp/engine/module-origin.ts";
import { com1Fixture, COM1_DATE } from "./fixtures.mjs";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { createOsNotesService } from "../../../src/erp/commercial-nfe/os-notes-service.ts";
import { parseCancellationXml } from "../../../src/erp/commercial-nfe/artifacts.ts";
import { installCommercialConnectionResolver } from "../../../src/erp/domains/fiscal/comnfe/settings.ts";
import { com1Hash } from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { fakeNfeValue } from "../emissor/fake-vault-value.ts";

const PROFILE = "area-os5";
const fingerprint = com1Hash("cofre-local-os5");
// cUF 35, 2611, CNPJ do emitente, modelo 55, série 001, número 7.
const nfeKey = "35261111222333000181550010000000071000000070";
// Chave nacional da NFS-e (50 caracteres).
const nfseKey = "35503082111222333000181000000000000000012600000001";
const justification = "Nota emitida com o valor errado do serviço.";
const row = (f, sql, ...params) => f.db.exec(sql, ...params).rows[0];
const count = (f, table, where = "1=1", ...params) => row(f, `SELECT count(*) n FROM ${table} WHERE ${where}`, ...params).n;

/** Âncora da fase 3: documento da origem os/<ordem>/main (como writeOriginAnchor). */
function anchor(f, orderId, documentId) {
  const source = { profile: PROFILE, module: "os", source_id: orderId, component: "main" };
  const value = { policy: ORIGIN_POLICY, type: "anchor", source, slot: "document", target: { kind: "document", id: documentId },
    actor: f.people.admin.user_id, command_id: randomUUID() };
  for (const key of [uuid5(F3_NAMESPACES.origin, canonical([PROFILE, "os", orderId, "main", "document"])),
    uuid5(F3_NAMESPACES.reverse_origin, canonical([PROFILE, "document", documentId]))])
    f.db.exec("INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,?,?)",
      key, f.people.admin.user_id, hash(value), canonical(value), String(f.clock.next()));
}

function setup(t, options = {}) {
  const f = com1Fixture(t, options);
  t.after(installCommercialConnectionResolver(() => ({ fingerprint, provider: "nfapi", origin: "https://cofre.invalid",
    issuer_cnpj: f.company.cnpj, version: "0.12.0", checked_at: String(f.clock.next()), compatible: true,
    company_matches: true, company_complete: true, environments: ["homologacao", "producao"],
    series: [{ environment: "homologacao", series: 1 }] })));
  f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: 1, environment: "homologacao",
    stock_timing: "existing", finance_timing: "existing", acknowledge_tax_limits: true } });
  f.service = f.catalog("products", { name: "Troca de tela", unit: "UN", kind: "S", format: "S", price: "150.00" });
  f.part = f.catalog("products", { name: "Tela de reposição", code: "TELA-1", unit: "UN", kind: "P", format: "S", price: "25.50", ncm: "85177900", origin: "0" });
  f.orderId = randomUUID();
  const items = options.items ? options.items(f) : [
    ...(options.noParts ? [] : [{ id: randomUUID(), product_id: f.part.id, description: "Tela nova", unit: "UN", quantity: "1", unit_price: "25.50", group: "part", quote: false, done: false }]),
    ...(options.noServices ? [] : [{ id: randomUUID(), product_id: f.service.id, description: "Troca de tela", unit: "UN", quantity: "1", unit_price: "150.00", group: "service", quote: false, done: false }]),
  ];
  const total = options.total ?? (options.noParts ? 0 : 2550) + (options.noServices ? 0 : 15000) - 1000;
  f.document = f.rpc("erp_document_save", { p_kind: "service_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: COM1_DATE, contact_id: f.customer.id, discount_mode: "amount", discount_value: options.items ? "0.00" : "10.00", freight: "0.00", items,
    installments: [{ amount: (total / 100).toFixed(2), due_date: COM1_DATE, payment_method_id: null }] } }).document;
  anchor(f, f.orderId, f.document.id);
  const state = { role: "admin", parts: {}, order: { found: true, status: "approved", title: "Ordem de serviço 12", authorized: true, eligible: true, reason: null, require_invoice_to_deliver: false },
    vault: { configured: true, checked_at: 1, nfse: true, environments: ["homologacao", "producao"] },
    remote: {}, calls: [], bodies: {}, mode: { nfse: "authorized", nfe: "authorized" }, lost: { nfse: false, nfe: false } };
  const output = (kind, body, status) => kind === "nfse"
    ? { kind, status, provider_ref: `nfs_${body.referencia.replace(/[^A-Za-z0-9]/g, "_")}`, reference: body.referencia, environment: body.ambiente, series: "1", number: 12,
      access_key: ["authorized", "cancelled"].includes(status) ? nfseKey : null, protocol: null,
      nfse_number: ["authorized", "cancelled"].includes(status) ? "126" : null, issued_at: null, authorized_at: null, total: null,
      qr_code: null, consult_url: null, corrections: 0, messages: status === "rejected" ? [{ code: "E0310", description: "Código de tributação nacional inexistente" }] : [],
      xml_available: true, replayed: false, event_repeated: null, contingency: null }
    : { kind, status, provider_ref: `nfe_${body.referencia.replace(/[^A-Za-z0-9]/g, "_")}`, reference: body.referencia, environment: body.ambiente, series: "1", number: 7,
      access_key: status === "rejected" ? null : nfeKey, protocol: ["authorized", "cancelled"].includes(status) ? "135260000000007" : null,
      nfse_number: null, issued_at: "2026-11-19T12:00:00Z", authorized_at: ["authorized", "cancelled"].includes(status) ? "2026-11-19T12:00:01Z" : null,
      total: fakeNfeValue(body), qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true,
      replayed: false, event_repeated: null, contingency: null };
  const provider = {
    async emit(_ctx, kind, body) {
      state.calls.push(`emit:${kind}`); state.bodies[kind] = structuredClone(body);
      state.remote[kind] = output(kind, body, state.mode[kind]);
      if (state.lost[kind]) { state.lost[kind] = false; throw new Error("resposta perdida no caminho do cofre"); }
      return structuredClone(state.remote[kind]);
    },
    async find(_ctx, kind) { state.calls.push(`find:${kind}`); return structuredClone(state.remote[kind] ?? null); },
    async get(_ctx, kind) { state.calls.push(`get:${kind}`); return structuredClone(state.remote[kind]); },
    async reconcile(_ctx, kind) { state.calls.push(`reconcile:${kind}`); return structuredClone(state.remote[kind]); },
    async cancel(_ctx, kind, _ref, input) {
      state.calls.push(`cancel:${kind}`); state.cancelInput = input;
      state.remote[kind] = { ...state.remote[kind], status: "cancelled", event_repeated: false };
      return structuredClone(state.remote[kind]);
    },
    async cancellationXml(_ctx, kind) {
      state.calls.push(`cancel_xml:${kind}`);
      return kind === "nfse"
        ? `<evento><chNFSe>${nfseKey}</chNFSe><tpAmb>2</tpAmb><nProt>NFSE-EVT-1</nProt><dhRegEvento>2026-11-19T12:05:00Z</dhRegEvento></evento>`
        : `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><chNFe>${nfeKey}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>135</cStat><nProt>135260000000008</nProt><dhRegEvento>2026-11-19T12:05:00Z</dhRegEvento></infEvento></retEvento></procEventoNFe>`;
    },
    async xml(_ctx, kind) { state.calls.push(`xml:${kind}`); return kind === "nfse" ? `<NFSe><infNFSe Id="NFS${nfseKey}"><ambGer>2</ambGer></infNFSe></NFSe>`
      : `<nfeProc><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${nfeKey}"><ide><tpAmb>2</tpAmb></ide></infNFe></NFe></nfeProc>`; },
    async danfe() { state.calls.push("danfe"); const body = new TextEncoder().encode("%PDF-1.4\nnfe\n%%EOF"); return { body, size: body.length, content_type: "application/pdf" }; },
  };
  const bridge = { async call(name, input) {
    const evidence = ["erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record"].includes(name);
    if (evidence) return callRpc(f.db, name, { p_input: input }, f.clock, f.env({ role: state.role, parts: state.parts }));
    return f.rpc(name, ["erp_com1_config_get", "erp_com1_nfce_config_get", "erp_com1_nfse_config_get"].includes(name) ? {} : { p_input: input }, { role: state.role, parts: state.parts });
  } };
  const base = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  const notes = createOsNotesService({ bridge, base, order: async () => structuredClone(state.order), vaultStatus: async () => structuredClone(state.vault) });
  const configure = (data = {}) => {
    const current = f.rpc("erp_com1_nfse_config_get", {});
    return f.rpc("erp_com1_nfse_config_save", { p_input: { command_id: randomUUID(), expected_version: current.version, national_code: "140101", ...data } });
  };
  return Object.assign(f, { state, provider, base, notes, configure });
}
const note = (overview, kind) => overview.notes.find(item => item.kind === kind);

test("esquema v15: irmãs da NFS-e com os limites próprios e o cadastro fiscal do serviço", () => {
  const service = ERP_ENGINE_TABLES.filter(table => table.table.startsWith("erp_fiscal_vault__service_"));
  assert.deepEqual(service.map(table => table.table).sort(), ["audit", "cancel", "command", "effect", "emission", "revision", "settings"].map(name => `erp_fiscal_vault__service_${name}`));
  assert.ok(service.every(table => table.since === 15));
  const emission = service.find(table => table.table === "erp_fiscal_vault__service_emission").ddl[0];
  assert.match(emission, /series BETWEEN 0 AND 99999/);
  assert.match(emission, /length\(access_key\) BETWEEN 44 AND 50/);
  assert.doesNotMatch(emission, /substr\(access_key,21,2\)/);
});

test("Simples Nacional: a ordem aprovada emite a NFS-e dos serviços e a NF-e das peças, cada uma com os seus itens", async t => {
  const f = setup(t);
  let view = await f.notes.overview(f.orderId);
  assert.deepEqual(view.notes.map(item => item.kind), ["nfse", "nfe"]);
  // Sem código de tributação nacional, a nota de serviço diz o que falta.
  assert.equal(note(view, "nfse").actions.includes("emitir"), false);
  assert.match(note(view, "nfse").reason, /código de tributação nacional/);
  assert.ok(note(view, "nfe").actions.includes("emitir"), JSON.stringify(note(view, "nfe").blockers));
  f.configure();
  view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfse").actions.includes("emitir"), JSON.stringify(note(view, "nfse").blockers));
  // Desconto de R$ 10,00 da ordem repartido pelo valor das linhas: 1,45 nas peças, 8,55 nos serviços.
  assert.equal(note(view, "nfe").total_cents, "2405");
  assert.equal(note(view, "nfse").total_cents, "14145");

  const service = await f.notes.emit(f.orderId, "nfse", randomUUID());
  assert.equal(service.blocked, false);
  const nfse = f.state.bodies.nfse;
  assert.equal(nfse.prestador.regimeTributario.simplesNacional, "me_epp");
  assert.equal(nfse.prestador.regimeTributario.apuracaoSimples, 1);
  assert.equal(nfse.prestador.codigoMunicipio, "3550308");
  assert.equal(nfse.prestador.inscricaoMunicipal, undefined, "a inscrição municipal fica no cofre");
  assert.equal(nfse.serie, undefined, "a série da DPS fica no cofre");
  assert.equal(nfse.servico.codigoTributacaoNacional, "140101");
  assert.equal(nfse.servico.codigoMunicipioPrestacao, "3550308");
  assert.match(nfse.servico.descricao, /Troca de tela/);
  assert.doesNotMatch(nfse.servico.descricao, /Tela nova/, "a peça não entra na nota de serviço");
  assert.deepEqual(nfse.valores, { servico: 150, descontoIncondicionado: 8.55 });
  assert.deepEqual(nfse.tributacao.issqn, { tipo: "tributavel", retencao: "nao_retido" }, "Simples Nacional sem alíquota exigida");
  assert.equal(nfse.tomador.cnpj, "19131243000197");
  assert.equal(nfse.ibs ?? nfse.tributacao.ibs, undefined);
  const s = note(service.overview, "nfse").emission;
  assert.equal(s.status, "autorizada");
  assert.equal(s.protocol, "126", "o número da NFS-e fica no lugar do protocolo");
  assert.equal(s.number, 12);
  assert.equal(s.access_key, nfseKey);

  const parts = await f.notes.emit(f.orderId, "nfe", randomUUID());
  assert.equal(parts.blocked, false, JSON.stringify(note(parts.overview, "nfe").blockers));
  const nfe = f.state.bodies.nfe;
  assert.deepEqual(nfe.itens.map(item => item.descricao), ["Tela nova"]);
  assert.equal(nfe.pagamentos.reduce((sum, p) => sum + p.valor, 0), 24.05);
  assert.equal(note(parts.overview, "nfe").emission.status, "autorizada");
  assert.equal(parts.overview.authorized, true);

  // Efeitos: os da fase 3. A nota não lança estoque nem financeiro.
  for (const family of ["service", "order"])
    for (const effect of f.db.exec(`SELECT state,reason FROM erp_fiscal_vault__${family}_effect`).rows)
      assert.deepEqual({ ...effect }, { state: "pulado", reason: "module_origin_effects" });
  assert.equal(count(f, "erp_stock__document_posting", "document_id=?", f.document.id), 0);
  assert.equal(count(f, "erp_finance__document_posting", "document_id=?", f.document.id), 0);
  // Repetir o pedido não envia de novo.
  await assert.rejects(f.notes.emit(f.orderId, "nfse", randomUUID()), error => error.code === "fiscal_emission_open");
  assert.equal(f.state.calls.filter(call => call === "emit:nfse").length, 1);
});

test("NFS-e sem resposta: a retomada repete a mesma referência (o contrato não tem consulta) e não cria outra emissão", async t => {
  const f = setup(t);
  f.configure();
  f.state.lost.nfse = true;
  const first = await f.notes.emit(f.orderId, "nfse", randomUUID());
  assert.equal(note(first.overview, "nfse").emission.status, "incerta");
  assert.ok(note(first.overview, "nfse").actions.includes("consultar"));
  const reference = f.state.bodies.nfse.referencia;
  // Durante a reivindicação (60 s) a emissão segue ocupada: a consulta vem depois.
  f.clock.advance(61_000);
  const after = await f.notes.consult(f.orderId, "nfse", randomUUID());
  assert.equal(note(after, "nfse").emission.status, "autorizada", JSON.stringify({ emission: note(after, "nfse").emission, calls: f.state.calls,
    commands: f.db.exec("SELECT action,state,error FROM erp_fiscal_vault__service_command").rows }));
  assert.equal(f.state.calls.includes("reconcile:nfse"), false, "a NFS-e não usa a consulta da SEFAZ");
  assert.equal(f.state.bodies.nfse.referencia, reference);
  assert.equal(count(f, "erp_fiscal_vault__service_emission"), 1);
});

test("cancelar a NFS-e: motivo e justificativa vão ao cofre, o evento é guardado e a ordem continua lançada", async t => {
  const f = setup(t);
  f.configure();
  await f.notes.emit(f.orderId, "nfse", randomUUID());
  const done = await f.notes.cancel(f.orderId, "nfse", randomUUID(), justification, "erro_emissao");
  assert.deepEqual(f.state.cancelInput, { justification, reason: "erro_emissao" });
  const s = note(done, "nfse");
  assert.equal(s.emission.status, "cancelada");
  assert.equal(s.emission.cancellation.state, "registrado");
  assert.equal(s.emission.cancellation.xml_status, "disponivel");
  assert.match(s.effects_note, /não desfaz a ordem/);
  assert.ok(s.actions.includes("emitir_de_novo"));
  for (const effect of f.db.exec("SELECT state,reason,compensation_state FROM erp_fiscal_vault__service_effect").rows)
    assert.deepEqual({ ...effect }, { state: "pulado", reason: "module_origin_effects", compensation_state: null });
  // Emitir de novo cria a versão fiscal seguinte, na mesma ordem.
  const again = await f.notes.emit(f.orderId, "nfse", randomUUID());
  assert.equal(note(again.overview, "nfse").emission.fiscal_version, 2);
  assert.equal(note(again.overview, "nfse").emission.status, "autorizada");
});

test("XML da NFS-e sai do cofre; o PDF da NFS-e não existe no contrato e a tela diz isso", async t => {
  const f = setup(t);
  f.configure();
  await f.notes.emit(f.orderId, "nfse", randomUUID());
  const xml = await f.notes.file(f.orderId, "nfse", "xml");
  assert.equal(xml.headers.get("Content-Type"), "application/xml; charset=utf-8");
  await assert.rejects(f.notes.file(f.orderId, "nfse", "pdf"), error => error.code === "fiscal_nfse_pdf_unavailable" && /Portal Nacional/.test(error.message));
  await f.notes.emit(f.orderId, "nfe", randomUUID());
  const pdf = await f.notes.file(f.orderId, "nfe", "pdf");
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
});

test("o que falta, em palavras: aprovação, cofre sem NFS-e, regime normal sem alíquota, IBS/CBS e peça sem produto", async t => {
  const f = setup(t);
  f.configure();
  f.state.order = { ...f.state.order, status: "analyzing", authorized: false, eligible: false, reason: "Falta aprovar o orçamento (ou autorizar o preço fixo) antes de emitir a nota." };
  let view = await f.notes.overview(f.orderId);
  assert.match(note(view, "nfse").reason, /Falta aprovar/);
  await assert.rejects(f.notes.emit(f.orderId, "nfse", randomUUID()), error => error.code === "os_note_not_allowed");
  f.state.order = { ...f.state.order, status: "approved", authorized: true, eligible: true, reason: null };
  f.state.vault = { ...f.state.vault, nfse: false };
  view = await f.notes.overview(f.orderId);
  assert.match(note(view, "nfse").reason, /não emite NFS-e/);
  await assert.rejects(f.notes.emit(f.orderId, "nfse", randomUUID()), error => error.code === "fiscal_nfse_not_supported");
  f.state.vault = { ...f.state.vault, nfse: true, configured: false };
  view = await f.notes.overview(f.orderId);
  assert.match(note(view, "nfse").reason, /cofre não está configurado/);
  f.state.vault = { ...f.state.vault, configured: true };
  // Regime normal (CRT 3): a alíquota do ISS passa a ser exigida, com mensagem clara.
  f.db.exec("UPDATE erp_company__fiscal SET crt='3'");
  view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfse").blockers.some(b => b.code === "nfse_iss_rate_missing" && /fora do Simples Nacional/.test(b.message)));
  f.configure({ iss_rate: "2,50" });
  view = await f.notes.overview(f.orderId);
  assert.equal(note(view, "nfse").blockers.some(b => b.code === "nfse_iss_rate_missing"), false);
  f.db.exec("UPDATE erp_company__fiscal SET crt='1'");
  // Classificação de IBS/CBS no serviço: bloqueado com explicação.
  f.db.exec("INSERT INTO erp_fiscal_reform__product_class (product_id,cst,cclasstrib,nbs,version,updated_by,updated_at) VALUES (?,?,?,?,1,?,?)",
    f.service.id, "000", "000001", null, f.people.admin.user_id, String(f.clock.next()));
  view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfse").blockers.some(b => b.code === "fiscal_reform_unsupported" && /IBS, CBS e IS/.test(b.message)));
});

test("peça sem vínculo com produto e serviços com códigos diferentes ficam bloqueados com o motivo", async t => {
  const f = setup(t, { total: 18500, items: f => {
    f.other = f.catalog("products", { name: "Limpeza", unit: "UN", kind: "S", format: "S", price: "30.00" });
    return [
      { id: randomUUID(), product_id: null, description: "Parafuso avulso", unit: "UN", quantity: "1", unit_price: "5.00", group: "part", quote: false, done: false },
      { id: randomUUID(), product_id: f.service.id, description: "Troca de tela", unit: "UN", quantity: "1", unit_price: "150.00", group: "service", quote: false, done: false },
      { id: randomUUID(), product_id: f.other.id, description: "Limpeza", unit: "UN", quantity: "1", unit_price: "30.00", group: "service", quote: false, done: false }];
  } });
  f.configure({ items: { [f.service.id]: { national_code: "010101" } } });
  const view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfe").blockers.some(b => b.code === "os_part_without_product" && /Parafuso avulso/.test(b.message)));
  assert.ok(note(view, "nfse").blockers.some(b => b.code === "nfse_service_code_mixed"));
});

test("sem natureza de venda possível, a nota de peças pede o cadastro e a de serviço segue", async t => {
  const f = setup(t);
  f.configure();
  f.db.exec("UPDATE erp_fiscal_invoices__nature SET active=0");
  const view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfe").blockers.some(b => b.code === "fiscal_nature_missing" && /Cadastre uma natureza/.test(b.message)), JSON.stringify(note(view, "nfe").blockers));
  assert.ok(note(view, "nfse").actions.includes("emitir"));
});

test("partes: sem Fiscal a ordem não fala de nota; sem Vendas/Produtos só a nota de peças para", async t => {
  const f = setup(t);
  f.configure();
  f.state.parts = { fiscal: false };
  // A rota recusa antes (module_disabled); o motor também recusa, sem nada gravar.
  await assert.rejects(f.notes.overview(f.orderId), error => /parte desligada|module_disabled/.test(String(error.message)));
  assert.equal(count(f, "erp_fiscal_vault__service_emission"), 0);
  f.state.parts = { sales: false };
  const view = await f.notes.overview(f.orderId);
  assert.ok(note(view, "nfe").blockers.some(b => b.code === "module_disabled" && /Vendas e Produtos/.test(b.message)));
  assert.ok(note(view, "nfse").actions.includes("emitir"), "a nota de serviço não depende de Vendas");
  const done = await f.notes.emit(f.orderId, "nfse", randomUUID());
  assert.equal(note(done.overview, "nfse").emission.status, "autorizada");
});

test("estorno direto do documento da ordem recusa com nota vigente (guarda da nota)", async t => {
  const f = setup(t);
  f.configure();
  await f.notes.emit(f.orderId, "nfse", randomUUID());
  const { com1DirectReverseBlocker } = await import("../../../src/erp/domains/fiscal/comnfe/effect-policy.ts");
  const blocker = f.transaction(ctx => com1DirectReverseBlocker(ctx, f.document.id, "finance"));
  assert.equal(blocker, "fiscal_order_effect_locked");
});

test("evento de cancelamento da NFS-e: chave, ambiente, número e data conferidos", () => {
  const emission = { model: "nfse", access_key: nfseKey, environment: "homologacao" };
  const event = parseCancellationXml(`<evento><chNFSe>${nfseKey}</chNFSe><tpAmb>2</tpAmb><nProt>NFSE-EVT-1</nProt><dhRegEvento>2026-11-19T12:05:00Z</dhRegEvento></evento>`, emission);
  assert.equal(event.protocol, "NFSE-EVT-1");
  assert.throws(() => parseCancellationXml(`<evento><chNFSe>${nfseKey}</chNFSe><tpAmb>1</tpAmb><nProt>1</nProt><dhRegEvento>2026-11-19T12:05:00Z</dhRegEvento></evento>`, emission));
});
