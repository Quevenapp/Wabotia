// Cliente fino: cada operação do contrato contra o cofre simulado (que confere
// pedido e resposta contra o contrato), erros e falhas de transporte.
import { describe, expect, it } from "vitest";
import { NfapiClient, NfapiError, NfapiTransportError } from "../../../src/erp/emissor/nfapi.ts";
import { createFakeVault } from "./fake-vault";
import { requestExample } from "./schema";
import { VAULT_URL } from "./helpers";

function setup(options = {}) {
  const vault = createFakeVault(options);
  const api = new NfapiClient({ url: VAULT_URL + "/", apiKey: vault.apiKey, fetch: vault.fetch });
  return { vault, api };
}

describe("cliente NFapi", () => {
  it("emite, lista pela referência, lê, baixa XML, consulta, corrige e cancela uma NF-e", async () => {
    const { vault, api } = setup();
    const pedido = requestExample("POST", "/v1/nfe");
    const created = await api.emitir("nfe", pedido);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ situacao: "autorizada", serie: 1, numero: 1, referencia: "pedido-1001" });
    const call = vault.calls.at(-1)!;
    expect(call).toMatchObject({ method: "POST", path: "/v1/nfe", auth: `Bearer ${vault.apiKey}` });
    expect(call.body).toEqual(pedido);

    const again = await api.emitir("nfe", pedido);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);

    const list = await api.listar("nfe", { referencia: "pedido-1001", limite: 5 });
    expect(list.body.map((e) => e.id)).toEqual([created.body.id]);
    expect(vault.calls.at(-1)!.path).toBe("/v1/nfe");

    expect((await api.obter("nfe", created.body.id)).body.chaveAcesso).toHaveLength(44);
    const xml = await api.xml("nfe", created.body.id);
    expect(xml.body).toMatch(/^<nfeProc>/);
    expect((await api.consultar("nfe", created.body.id)).body.situacao).toBe("autorizada");

    const carta = await api.cartaCorrecao(created.body.id, requestExample("POST", "/v1/nfe/{id}/carta-correcao"));
    expect(carta.body.cartasCorrecao).toBe(1);
    const cancel = await api.cancelar("nfe", created.body.id, requestExample("POST", "/v1/nfe/{id}/cancelar"));
    expect(cancel.body.situacao).toBe("cancelada");
    expect(vault.calls.map((c) => `${c.method} ${c.path.replace(created.body.id, "{id}")}`)).toEqual([
      "POST /v1/nfe",
      "POST /v1/nfe",
      "GET /v1/nfe",
      "GET /v1/nfe/{id}",
      "GET /v1/nfe/{id}/xml",
      "POST /v1/nfe/{id}/consultar",
      "POST /v1/nfe/{id}/carta-correcao",
      "POST /v1/nfe/{id}/cancelar",
    ]);
  });

  it("NFC-e e NFS-e pelos exemplos do contrato", async () => {
    const { api } = setup();
    const nfce = await api.emitir("nfce", requestExample("POST", "/v1/nfce"));
    expect(nfce.body).toMatchObject({ modelo: "nfce", situacao: "autorizada" });
    expect(nfce.body.qrCode).toBeTruthy();
    expect((await api.consultar("nfce", nfce.body.id)).body.id).toBe(nfce.body.id);
    expect((await api.xml("nfce", nfce.body.id)).body).toContain(nfce.body.chaveAcesso);
    expect((await api.listar("nfce")).body).toHaveLength(1);
    await api.cancelar("nfce", nfce.body.id, { justificativa: "Venda desfeita no caixa 1" });
    expect((await api.obter("nfce", nfce.body.id)).body.situacao).toBe("cancelada");

    const nfse = await api.emitir("nfse", requestExample("POST", "/v1/nfse"));
    expect(nfse.body).toMatchObject({ situacao: "autorizada", serie: "1" });
    expect((await api.obter("nfse", nfse.body.id)).body.idDps).toMatch(/^DPS/);
    expect((await api.xml("nfse", nfse.body.id)).body).toContain("<");
    expect((await api.listar("nfse", { referencia: "pedido-2001" })).body).toHaveLength(1);
    const cancelled = await api.cancelar("nfse", nfse.body.id, requestExample("POST", "/v1/nfse/{id}/cancelar"));
    expect(cancelled.body.situacao).toBe("cancelada");
  });

  it("séries, estado do cofre, status da SEFAZ, inutilização e o contrato servido", async () => {
    const { api, vault } = setup({ openapi: { openapi: "3.1.0" } });
    expect((await api.series()).body).toEqual([
      { modelo: "nfe", ambiente: "homologacao", serie: 1, proximoNumero: 1, descricao: null, cnpj: "99888777000166" },
      { modelo: "nfce", ambiente: "homologacao", serie: 1, proximoNumero: 1, descricao: null, cnpj: "99888777000166" },
    ]);
    expect((await api.cofre()).body).toMatchObject({
      versao: "0.11.0",
      certificado: { titular: "EMPRESA EXEMPLO LTDA" },
      contingencia: { notasPendentes: 0 },
      logotipo: true,
    });
    const status = await api.sefazStatus({ uf: "RS", modelo: "nfe", ambiente: "homologacao" }).catch((e) => e);
    expect(status).toBeInstanceOf(NfapiError);
    expect((await api.sefazStatus({ uf: "SC" })).body).toMatchObject({ emOperacao: true, autorizador: "SVRS" });
    expect(vault.calls.at(-1)!.path).toBe("/v1/sefaz/status");
    const inut = await api.inutilizar({ ...requestExample("POST", "/v1/inutilizacoes"), uf: "RJ" });
    expect(inut.status).toBe(201);
    expect(inut.body.protocolo).toBeTruthy();
    expect((await api.openapi()).body).toEqual({ openapi: "3.1.0" });
  });

  it("erro do cofre vira NfapiError com código, campo e mensagens", async () => {
    const { api, vault } = setup();
    const bad = requestExample("POST", "/v1/nfce");
    bad.naturezaOperacao = "";
    const invalid = await api.emitir("nfce", bad).catch((e) => e);
    expect(invalid).toBeInstanceOf(NfapiError);
    expect(invalid).toMatchObject({ status: 400, codigo: "requisicao_invalida", campo: "naturezaOperacao" });

    vault.plan.push("reject");
    const rejected = await api.emitir("nfce", requestExample("POST", "/v1/nfce")).catch((e) => e);
    expect(rejected).toMatchObject({
      status: 422,
      codigo: "nfe_rejeitada",
      mensagens: [{ codigo: "539", descricao: expect.stringContaining("Duplicidade") }],
    });
    expect(rejected.emissao).toMatchObject({ situacao: "rejeitada", referencia: "caixa1-venda-5001" });

    const wrongKey = new NfapiClient({ url: VAULT_URL, apiKey: "nfapi_outra_chave_00000", fetch: vault.fetch });
    expect(await wrongKey.cofre().catch((e) => e)).toMatchObject({ status: 401, codigo: "nao_autenticado" });
  });

  it("falhas de transporte: rede, tempo, página da Cloudflare e erro 1042", async () => {
    const { vault, api } = setup();
    vault.plan.push("drop");
    expect(await api.emitir("nfe", requestExample("POST", "/v1/nfe")).catch((e) => e)).toMatchObject({
      name: "NfapiTransportError",
      kind: "network",
    });
    vault.plan.push("gateway");
    expect(await api.emitir("nfe", requestExample("POST", "/v1/nfe")).catch((e) => e)).toMatchObject({
      kind: "bad_response",
      status: 502,
    });
    vault.plan.push("same-zone");
    const zone = await api.emitir("nfe", requestExample("POST", "/v1/nfe")).catch((e) => e);
    expect(zone).toBeInstanceOf(NfapiTransportError);
    expect(zone.kind).toBe("same_zone");

    const slow = new NfapiClient({
      url: VAULT_URL,
      apiKey: vault.apiKey,
      readTimeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)),
        ) as Promise<Response>,
    });
    expect(await slow.cofre().catch((e) => e)).toMatchObject({ kind: "timeout" });
  });

  it("lista por referência e ambiente", async () => {
    const { api, vault } = setup();
    await api.emitir("nfce", requestExample("POST", "/v1/nfce"));
    expect((await api.listar("nfce", { referencia: "caixa1-venda-5001", ambiente: "producao" })).body).toEqual([]);
    expect((await api.listar("nfce", { referencia: "caixa1-venda-5001", ambiente: "homologacao" })).body).toHaveLength(1);
    expect(vault.calls.at(-1)!.path).toBe("/v1/nfce");
  });

  it("aceita o formato antigo dos erros gerais ({ error: { code, message } }, cofre até 0.3.1)", async () => {
    const api = new NfapiClient({
      url: VAULT_URL,
      apiKey: "nfapi_x_0123456789",
      fetch: async () =>
        Response.json({ error: { code: "cofre_nao_configurado", message: "Instalação incompleta." } }, { status: 503 }),
    });
    const error = await api.cofre().catch((e) => e);
    expect(error).toBeInstanceOf(NfapiError);
    expect(error).toMatchObject({ status: 503, codigo: "cofre_nao_configurado", message: "Instalação incompleta." });
  });

  it("não segue redirecionamento nem manda o id sem codificar", async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const api = new NfapiClient({
      url: VAULT_URL,
      apiKey: "nfapi_x_0123456789",
      fetch: async (input, init) => {
        seen.push({ url: String(input), redirect: init?.redirect });
        return new Response(null, { status: 302, headers: { Location: "https://outro.example" } });
      },
    });
    expect(await api.obter("nfe", "a/b?c").catch((e) => e)).toMatchObject({ kind: "bad_response", status: 302 });
    expect(seen).toEqual([{ url: `${VAULT_URL}/v1/nfe/a%2Fb%3Fc`, redirect: "manual" }]);
  });
});
