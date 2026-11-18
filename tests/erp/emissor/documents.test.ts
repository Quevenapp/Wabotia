// Cliente NFapi, operações de 0.4.1 a 0.8.0: XML dos eventos, inutilizações
// registradas, cupom, DANFE, DANFE NFC-e e logotipo; o modo binário (tipo e
// tamanho do cofre, limite), a versão mínima por operação (vault_outdated) e
// a trava que impede POST para cofre de verdade em processo de teste.
import { describe, expect, it } from "vitest";
import {
  MAX_PDF_BYTES,
  NfapiClient,
  NfapiError,
  NfapiOutdatedError,
  NfapiTestGuardError,
  NfapiTransportError,
  OPERATION_MIN_VERSION,
  TEST_PROCESS,
  isFakeVaultHost,
  olderThan,
} from "../../../src/erp/emissor/nfapi.ts";
import { fiscalError } from "../../../src/erp/emissor/nfapi-provider.ts";
import { createFakeVault, FAKE_PDF, FAKE_PNG, type FakeVaultOptions } from "./fake-vault";
import { requestExample } from "./schema";
import { VAULT_URL } from "./helpers";

function setup(options: FakeVaultOptions = {}) {
  const vault = createFakeVault(options);
  const api = new NfapiClient({ url: VAULT_URL, apiKey: vault.apiKey, fetch: vault.fetch });
  return { vault, api };
}

describe("trava de evento fiscal em teste", () => {
  it("o processo de teste é reconhecido pelo ambiente do executor", () => {
    expect(TEST_PROCESS).toBe(true);
    expect(isFakeVaultHost("nfapi-cofre.fake-vault.test")).toBe(true);
    expect(isFakeVaultHost("x.invalid")).toBe(true);
    for (const real of ["nfapi-cofre.minha-conta.workers.dev", "cofre.empresa.com.br", "test.com", "cofre.test.com"])
      expect(isFakeVaultHost(real), real).toBe(false);
  });

  it("nenhum POST sai para cofre que não é o simulado; leitura sai", async () => {
    let sent = 0;
    const spy: typeof fetch = async () => {
      sent++;
      return Response.json({ versao: "0.9.0" });
    };
    const real = new NfapiClient({ url: "https://nfapi-cofre.minha-conta.workers.dev", apiKey: "nfapi_real_0123456789", fetch: spy });
    const id = "nfe_00000000000000000001";
    const attempts: [string, () => Promise<unknown>][] = [
      ["emitir", () => real.emitir("nfe", requestExample("POST", "/v1/nfe"))],
      ["consultar", () => real.consultar("nfe", id)],
      ["cancelar", () => real.cancelar("nfe", id, { justificativa: "Cancelamento de teste sintético" })],
      ["carta-correcao", () => real.cartaCorrecao(id, requestExample("POST", "/v1/nfe/{id}/carta-correcao"))],
      ["inutilizar", () => real.inutilizar({ ...requestExample("POST", "/v1/inutilizacoes"), uf: "RJ" })],
      ["manifestar", () => real.manifestar("rec_1", { tipo: "ciencia" })],
      ["manifestar por chave", () => real.manifestarPorChave({ tipo: "ciencia", chaveAcesso: "3".repeat(44) })],
      ["consultar-chave", () => real.consultarChave({ chaveAcesso: "3".repeat(44) })],
      ["sincronizar", () => real.sincronizar({})],
    ];
    for (const [name, run] of attempts) {
      const error = await run().catch((e) => e);
      expect(error, name).toBeInstanceOf(NfapiTestGuardError);
      expect(error.message, name).toContain("nada foi enviado");
    }
    expect(sent).toBe(0);
    // Pelo provedor, a recusa sobe como está: não vira erro fiscal que o ERP trate e repita.
    const guard = new NfapiTestGuardError("POST /v1/nfe", "cofre.empresa.com.br");
    expect(fiscalError(guard)).toBe(guard);
    // Leitura não é evento: sai.
    await real.cofre();
    expect(sent).toBe(1);
  });
});

describe("versão mínima por operação", () => {
  it("tabela coerente com o histórico do canal estável", () => {
    expect(OPERATION_MIN_VERSION["GET /v1/nfe/{id}/danfe"]).toBe("0.8.0");
    expect(OPERATION_MIN_VERSION["GET /v1/nfce/{id}/cupom"]).toBe("0.7.0");
    expect(OPERATION_MIN_VERSION["GET /v1/nfe-recebidas"]).toBe("0.9.0");
    expect(OPERATION_MIN_VERSION["POST /v1/nfe"]).toBeUndefined();
    expect(olderThan("0.7.0", "0.8.0")).toBe(true);
    expect(olderThan("0.10.0", "0.9.0")).toBe(false);
    expect(olderThan("0.9.0", "0.9.0")).toBe(false);
  });

  it("cofre antigo: NfapiOutdatedError com a mínima e a instalada, nunca o 404 cru", async () => {
    const cases: [string, string, (api: NfapiClient, ids: { nfe: string; nfce: string }) => Promise<unknown>][] = [
      ["0.3.2", "0.4.1", (api, ids) => api.cancelamentoXml("nfe", ids.nfe)],
      ["0.3.2", "0.4.1", (api) => api.inutilizacoes()],
      ["0.6.0", "0.7.0", (api, ids) => api.cupom(ids.nfce)],
      ["0.7.0", "0.8.0", (api, ids) => api.danfe(ids.nfe)],
      ["0.7.0", "0.8.0", (api, ids) => api.danfce(ids.nfce)],
      ["0.7.0", "0.8.0", (api) => api.logotipo()],
      ["0.8.0", "0.9.0", (api) => api.recebidas()],
      ["0.8.0", "0.9.0", (api) => api.distribuicao()],
      ["0.8.0", "0.9.0", (api) => api.manifestar("rec_1", { tipo: "ciencia" })],
      ["0.8.0", "0.9.0", (api) => api.consultarChave({ chaveAcesso: "3".repeat(44) })],
    ];
    for (const [version, min, run] of cases) {
      const { api } = setup({ version });
      const ids = {
        nfe: (await api.emitir("nfe", requestExample("POST", "/v1/nfe"))).body.id,
        nfce: (await api.emitir("nfce", requestExample("POST", "/v1/nfce"))).body.id,
      };
      const error = await run(api, ids).catch((e) => e);
      expect(error, `${version} → ${min}`).toBeInstanceOf(NfapiOutdatedError);
      expect(error, `${version} → ${min}`).toMatchObject({ codigo: "vault_outdated", minVersion: min, vaultVersion: version });
    }
  });

  it("cofre em dia: 404 de id inexistente continua 404", async () => {
    const { api, vault } = setup();
    const error = await api.danfe("nfe_naoexiste").catch((e) => e);
    expect(error).toBeInstanceOf(NfapiError);
    expect(error).toMatchObject({ status: 404, codigo: "nao_encontrado" });
    // O 404 levou a uma leitura da versão (que confirmou o cofre em dia).
    expect(vault.calls.map((c) => c.path)).toEqual(["/v1/nfe/nfe_naoexiste/danfe", "/v1/cofre"]);
  });
});

describe("documentos impressos e arquivos", () => {
  it("DANFE e DANFE NFC-e: PDF com tipo e tamanho do cofre, bytes intactos", async () => {
    const { api, vault } = setup();
    const nfe = (await api.emitir("nfe", requestExample("POST", "/v1/nfe"))).body;
    const nfce = (await api.emitir("nfce", requestExample("POST", "/v1/nfce"))).body;
    const danfe = await api.danfe(nfe.id);
    expect(danfe).toMatchObject({ status: 200, contentType: "application/pdf", size: FAKE_PDF.byteLength });
    expect(danfe.body).toEqual(FAKE_PDF);
    const danfce = await api.danfce(nfce.id, { largura: "58", via: "estabelecimento" });
    expect(danfce.body).toEqual(FAKE_PDF);
    expect(vault.calls.at(-1)!.query).toBe("?largura=58&via=estabelecimento");
    // Erros do 0.8.0.
    vault.plan.push("reject");
    const rejected = (await api.emitir("nfe", { ...requestExample("POST", "/v1/nfe"), referencia: "rej-1" }).catch((e) => e)).emissao;
    expect(await api.danfe(rejected.id).catch((e) => e)).toMatchObject({ status: 409, codigo: "nfe_nao_autorizada" });
    expect(await api.danfe(nfce.id).catch((e) => e)).toMatchObject({ status: 404, codigo: "nao_encontrado" });
    expect(await api.danfce(nfce.id, { largura: "99" as never }).catch((e) => e)).toMatchObject({ status: 400, codigo: "requisicao_invalida" });
  });

  it("cupom da NFC-e em JSON e logotipo PNG ou JPEG", async () => {
    const { api } = setup({ logo: "jpeg" });
    const nfce = (await api.emitir("nfce", requestExample("POST", "/v1/nfce"))).body;
    expect((await api.cupom(nfce.id, { via: "estabelecimento" })).body).toMatchObject({ modelo: "nfce", via: "estabelecimento", secoes: expect.any(Array) });
    const logo = await api.logotipo();
    expect(logo).toMatchObject({ contentType: "image/jpeg", size: FAKE_PNG.byteLength });
    const none = setup({ logo: null });
    expect(await none.api.logotipo().catch((e) => e)).toMatchObject({ status: 404, codigo: "nao_encontrado" });
  });

  it("arquivo acima do limite: recusa clara, sem ler o resto", async () => {
    const big = new NfapiClient({
      url: VAULT_URL,
      apiKey: "nfapi_x_0123456789",
      fetch: async () => new Response("x", { headers: { "Content-Type": "application/pdf", "Content-Length": String(MAX_PDF_BYTES + 1) } }),
    });
    expect(await big.danfe("nfe_1").catch((e) => e)).toMatchObject({ name: "NfapiTransportError", kind: "too_large" });
    // Sem Content-Length: conta enquanto lê e para no limite.
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const streaming = new NfapiClient({
      url: VAULT_URL,
      apiKey: "nfapi_x_0123456789",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(chunk);
              if (pulled > 50) controller.close();
            },
          }),
          { headers: { "Content-Type": "application/pdf" } },
        ),
    });
    const error = await streaming.danfe("nfe_1").catch((e) => e);
    expect(error).toBeInstanceOf(NfapiTransportError);
    expect(error.kind).toBe("too_large");
    expect(pulled).toBeLessThanOrEqual(12);
    // Tipo inesperado (página HTML com 200): fora do contrato.
    const html = new NfapiClient({
      url: VAULT_URL,
      apiKey: "nfapi_x_0123456789",
      fetch: async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    });
    expect(await html.danfe("nfe_1").catch((e) => e)).toMatchObject({ kind: "bad_response" });
  });
});

describe("XML dos eventos e inutilizações registradas", () => {
  it("cancelamento, carta de correção por sequência e inutilização", async () => {
    const { api } = setup();
    const nfe = (await api.emitir("nfe", requestExample("POST", "/v1/nfe"))).body;
    await api.cartaCorrecao(nfe.id, requestExample("POST", "/v1/nfe/{id}/carta-correcao"));
    await api.cancelar("nfe", nfe.id, requestExample("POST", "/v1/nfe/{id}/cancelar"));
    expect((await api.cancelamentoXml("nfe", nfe.id)).body).toContain("110111");
    expect((await api.cartaCorrecaoXml(nfe.id, 1)).body).toContain('nSeqEvento="1"');
    expect(await api.cartaCorrecaoXml(nfe.id, 2).catch((e) => e)).toMatchObject({ status: 404 });

    const pedido = { ...requestExample("POST", "/v1/inutilizacoes"), uf: "RJ" };
    const first = await api.inutilizar(pedido);
    expect(first).toMatchObject({ status: 201, body: { repetido: false, xmlDisponivel: true, justificativa: pedido.justificativa } });
    // Repetir é seguro: 200 com repetido, nada vai ao governo.
    const again = await api.inutilizar(pedido);
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, repetido: true } });
    expect((await api.inutilizacoes({ modelo: pedido.modelo })).body.map((v) => v.id)).toEqual([first.body.id]);
    expect((await api.inutilizacao(first.body.id!)).body.id).toBe(first.body.id);
    expect((await api.inutilizacaoXml(first.body.id!)).body).toContain("procInutNFe");
  });
});
