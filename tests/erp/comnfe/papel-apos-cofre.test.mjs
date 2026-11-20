// Revisão de acesso, achado B3: DANFE e XML comerciais reconferem identidade,
// papel e partes depois da ida ao cofre, antes de entregar os bytes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommercialNfeService } from "../../../src/erp/commercial-nfe/service.ts";
import { CommercialNfeError } from "../../../src/erp/commercial-nfe/artifacts.ts";

const fingerprint = "f".repeat(64);
const accessKey = "35261111222333000181550010000000011000000010";
const emission = {
  id: "0b8e7f1c-2a34-4c56-8d78-9e0a1b2c3d4e", status: "autorizada", environment: "homologacao", environment_confirmed: true,
  reference: "pedido-1", provider_id: "nfe_ensaio_1", access_key: accessKey, connection_fingerprint: fingerprint,
};
const pdf = new TextEncoder().encode("%PDF-1.4\nEnsaio\n%%EOF");
const xml = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${accessKey}"><ide><tpAmb>2</tpAmb></ide></infNFe></NFe></nfeProc>`;

function setup() {
  const state = { revokeDuringDownload: false, revoked: false, reads: 0 };
  const provider = {
    async get() { return { kind: "nfe", environment: "homologacao", reference: emission.reference, provider_ref: emission.provider_id, access_key: accessKey, status: "authorized" }; },
    // O administrador retira o papel fiscal enquanto o arquivo vem do cofre.
    async danfe() { if (state.revokeDuringDownload) state.revoked = true; return { body: pdf.slice(), size: pdf.byteLength, content_type: "application/pdf" }; },
    async xml() { if (state.revokeDuringDownload) state.revoked = true; return xml; },
  };
  const bridge = { async call(name) {
    assert.equal(name, "erp_com1_get");
    state.reads++;
    // A ponte refaz erpIdentity e o motor confere papel e permissão atuais.
    if (state.revoked) throw new CommercialNfeError(403, "fiscal_forbidden", "Seu acesso não permite esta operação fiscal.");
    return structuredClone(emission);
  } };
  const service = createCommercialNfeService({}, { bridge, vault: async () => ({ provider, context: {}, fingerprint }) });
  return { state, service };
}

for (const kind of ["danfe", "xml"]) {
  test(`B3: ${kind} com o papel mantido sai depois de reconferir pela ponte`, async () => {
    const f = setup();
    const response = await f.service[kind]({ emission_id: emission.id });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
    assert.equal(f.state.reads, 2, "uma leitura antes e outra depois do cofre");
  });

  test(`B3: ${kind} não é entregue a quem perdeu o papel durante a ida ao cofre`, async () => {
    const f = setup();
    f.state.revokeDuringDownload = true;
    await assert.rejects(f.service[kind]({ emission_id: emission.id }), error => error.code === "fiscal_forbidden");
    assert.equal(f.state.reads, 2);
  });
}
