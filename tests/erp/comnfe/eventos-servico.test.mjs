// Serviço da carta de correção, inutilização e devolução com cofre simulado
// (sem rede) sobre os RPCs reais do motor: resposta perdida nunca gera outra
// carta, outra inutilização ou outra nota, e o efeito da devolução não se repete.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accessKey, authorizedResult, balance, connection, count, eventsFixture, returnKey } from "./eventos-fixture.mjs";
import { createNfeEventsService } from "../../../src/erp/commercial-nfe/events-service.ts";
import { CommercialNfeError } from "../../../src/erp/commercial-nfe/artifacts.ts";
import { parseCorrectionXml } from "../../../src/erp/commercial-nfe/correction-pdf.ts";

const correctionXml = (sequence, text, key = accessKey) => `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><evento versao="1.00"><infEvento Id="ID110110${key}0${sequence}"><tpAmb>2</tpAmb><chNFe>${key}</chNFe><tpEvento>110110</tpEvento><nSeqEvento>${sequence}</nSeqEvento><detEvento versao="1.00"><descEvento>Carta de Correcao</descEvento><xCorrecao>${text}</xCorrecao><xCondUso>A Carta de Correcao e disciplinada...</xCondUso></detEvento></infEvento></evento><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><chNFe>${key}</chNFe><tpEvento>110110</tpEvento><nSeqEvento>${sequence}</nSeqEvento><cStat>135</cStat><nProt>13526000000010${sequence}</nProt><dhRegEvento>2026-11-19T13:00:0${sequence}-03:00</dhRegEvento></infEvento></retEvento></procEventoNFe>`;

function serviceSetup(t, options = {}) {
  const f = eventsFixture(t, options);
  const calls = [], letters = [], emitted = new Map(), control = { loseCorrection: false, loseEmit: false };
  const base = () => authorizedResult(f.emission.reference, { corrections: letters.length });
  const provider = {
    async get(_ctx, _kind, ref) {
      calls.push("get");
      const found = [...emitted.values()].find(r => r.provider_ref === ref);
      return structuredClone(found ?? base());
    },
    async correct(_ctx, _ref, text) {
      calls.push("correct");
      letters.push(text);
      if (control.loseCorrection) { control.loseCorrection = false; throw new Error("resposta perdida"); }
      return { ...base(), event_repeated: false };
    },
    async correctionXml(_ctx, _ref, sequence) { calls.push("correction_xml"); return correctionXml(sequence, letters[sequence - 1]); },
    async voidRange(_ctx, input) {
      calls.push("void");
      return { provider_ref: "inut_servico", kind: input.kind, environment: input.environment, series: input.series, first: input.first, last: input.last,
        protocol: "135260000000040", created_at: null, justification: input.justification, xml_available: true, repeated: false };
    },
    async emit(_ctx, kind, body, key) {
      calls.push("emit");
      assert.equal(kind, "nfe");
      assert.equal(body.finalidade, "devolucao");
      const reference = `wb.${key.document_id}.v${key.version}`;
      const result = authorizedResult(reference, { provider_ref: `dev_${emitted.size + 1}`, number: 2, access_key: returnKey, protocol: "135260000000050", total: body.itens.reduce((s, i) => s + i.valorTotal, 0) });
      emitted.set(reference, result);
      if (control.loseEmit) { control.loseEmit = false; throw new Error("resposta perdida"); }
      return structuredClone(result);
    },
    async find(_ctx, _kind, key) { calls.push("find"); const found = emitted.get(`wb.${key.document_id}.v${key.version}`); return found ? structuredClone(found) : null; },
    async reconcile(_ctx, _kind, ref) { calls.push("reconcile"); return structuredClone([...emitted.values()].find(r => r.provider_ref === ref)); },
    async danfe() { calls.push("danfe"); const body = new TextEncoder().encode("%PDF-1.4\nensaio\n%%EOF"); return { body, size: body.length, content_type: "application/pdf" }; },
    async xml() { calls.push("xml"); return `<nfeProc><NFe><infNFe Id="NFe${returnKey}"/></NFe></nfeProc>`; },
  };
  const bridge = { async call(name, input) { return f.rpc(name, { p_input: input }); } };
  const status = { configured: true, version: "0.12.0", nfe: ["SP"], nfce: ["SP"], environments: ["homologacao"] };
  const service = createNfeEventsService({ bridge, vault: async () => ({ provider, context: {}, fingerprint: connection }),
    vaultStatus: async () => status, fingerprint: async () => connection });
  return { ...f, calls, letters, emitted, control, provider, service, status };
}
const n = (calls, name) => calls.filter(c => c === name).length;

test("carta de correção: registra com XML, mesmo comando não reenvia e resposta perdida é consultada sem outra carta", async t => {
  const f = serviceSetup(t, { effects: false });
  const command = randomUUID(), text = "Endereço de entrega: Rua das Acácias, 45, sala 2";
  const view = await f.service.correct(f.emission.id, command, text);
  assert.equal(view.corrections[0].state, "registrado");
  assert.equal(view.corrections[0].sequence, 1);
  assert.equal(view.corrections[0].xml_available, true);
  await f.service.correct(f.emission.id, command, text);
  assert.equal(n(f.calls, "correct"), 1);
  // Segunda carta com a resposta perdida: fica incerta; a consulta acha a carta e só arquiva.
  f.control.loseCorrection = true;
  const second = await f.service.correct(f.emission.id, randomUUID(), `${text}; CEP 01001-000`);
  const lost = second.corrections.find(c => c.expected_sequence === 2);
  assert.equal(lost.state, "incerto");
  assert.equal(second.rules.correction.code, "nfe_correction_in_flight");
  const consulted = await f.service.correctionConsult(f.emission.id, lost.id);
  assert.equal(consulted.corrections.find(c => c.id === lost.id).state, "registrado");
  assert.equal(n(f.calls, "correct"), 2);
  assert.equal(f.letters.length, 2);
  assert.equal(count(f, "erp_fiscal_vault__order_correction"), 2);
  // PDF montado no servidor a partir do XML do cofre.
  const pdf = await f.service.correctionFile(f.emission.id, 2, "pdf");
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
  const bytes = new Uint8Array(await pdf.arrayBuffer()), content = new TextDecoder("latin1").decode(bytes);
  assert.equal(content.slice(0, 5), "%PDF-");
  assert.match(content, /CARTA DE CORRE/);
  assert.match(content, /Rua das Ac/);
  const xml = await f.service.correctionFile(f.emission.id, 1, "xml");
  assert.equal(parseCorrectionXml(await xml.text(), { access_key: accessKey, environment: "homologacao", sequence: 1 }).text, text);
});

test("inutilização: só se o cofre oferecer, com a recusa em palavras, e sem repetir", async t => {
  const f = serviceSetup(t, { effects: false });
  f.status.nfce = [];
  const input = { command_id: randomUUID(), model: "nfce", environment: "homologacao", series: 1, first: 5, last: 6, justification: "Números pulados por queda de energia no caixa" };
  await assert.rejects(f.service.voidRange(input), e => e instanceof CommercialNfeError && e.code === "nfe_void_not_offered" && /não emite NFC-e/.test(e.message));
  assert.equal((await f.service.voids("homologacao")).capability.nfce.offered, false);
  f.status.nfce = ["SP"];
  const done = await f.service.voidRange(input);
  assert.equal(done.void.state, "registrado");
  assert.equal(done.void.provider_ref, "inut_servico");
  await f.service.voidRange(input);
  assert.equal(n(f.calls, "void"), 1);
});

test("devolução pelo serviço: emite uma vez, lança estoque e contas e não duplica ao retomar ou com resposta perdida", async t => {
  const f = serviceSetup(t);
  f.control.loseEmit = true;
  const command = randomUUID();
  const first = await f.service.createReturn(f.emission.id, { command_id: command, items: [{ item: 0, quantity: "1" }], finance_option: "credito" });
  assert.equal(first.status, "incerta");
  // Retomada: acha a mesma referência no cofre, não emite de novo.
  const resumed = await f.service.resumeReturn(first.id, randomUUID());
  assert.equal(resumed.status, "autorizada");
  assert.equal(resumed.stock.state, "aplicado");
  assert.equal(resumed.finance.state, "aplicado", JSON.stringify(resumed.finance.result));
  assert.equal(n(f.calls, "emit"), 1);
  assert.equal(balance(f), "99.000000");
  // Mesmo comando de criação e retomadas repetidas (aviso do cofre duas vezes): nada se repete.
  await f.service.createReturn(f.emission.id, { command_id: command, items: [{ item: 0, quantity: "1" }], finance_option: "credito" });
  await f.service.resumeReturn(first.id, randomUUID());
  assert.equal(n(f.calls, "emit"), 1);
  assert.equal(balance(f), "99.000000");
  assert.equal(count(f, "erp_finance__settlement"), 1);
  assert.equal(count(f, "erp_fiscal_vault__order_return"), 1);
  const danfe = await f.service.returnFile(first.id, "danfe");
  assert.equal(danfe.headers.get("Content-Type"), "application/pdf");
  const events = await f.service.events(f.emission.id);
  assert.equal(events.returns[0].number, 2);
  assert.equal(events.lines[0].remaining, "1");
});
