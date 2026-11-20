// Cliente fino: cada operação do contrato contra o cofre simulado (que confere
// pedido e resposta contra o contrato), erros e falhas de transporte.
import { describe, expect, it } from "vitest";
import { EMISSION_MIN_VERSION, NfapiClient, NfapiError, NfapiOutdatedError, NfapiTransportError } from "../../../src/erp/emissor/nfapi.ts";
import { createFakeVault } from "./fake-vault";
import { requestExample } from "./schema";
import { VAULT_URL } from "./helpers";

function setup(options = {}) {
  const vault = createFakeVault(options);
  const api = new NfapiClient({ url: VAULT_URL + "/", apiKey: vault.apiKey, fetch: vault.fetch });
  return { vault, api };
}

describe("cliente NFapi", () => {
  it("exige mínimo do recurso e mesma major antes de enviar", async () => {
    for (const [version, accepted] of [["0.7.9", false], ["0.8.0", true], ["0.12.0", true], ["0.13.0", true], ["1.0.0", false], ["0.12.0lixo", false]] as const) {
      const { vault, api } = setup({ version });
      const result = await api.exigirVersao("POST /v1/nfe", EMISSION_MIN_VERSION).catch(error => error);
      if (accepted) expect(result, version).toBe(version);
      else expect(result, version).toBeInstanceOf(NfapiOutdatedError);
      expect(vault.calls.map(call => `${call.method} ${call.path}`)).toEqual(["GET /v1/cofre"]);
    }
  });

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
      versao: "0.12.0",
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

  it("confere cancelamento externo de NFS-e e arquiva o evento, sem emitir nem cancelar", async () => {
    const { api, vault } = setup();
    const { body: note } = await api.emitir("nfse", requestExample("POST", "/v1/nfse"));
    const sends = vault.emissionSends.get(vault.sefazKey("nfse", note.ambiente, note.referencia!));
    expect(sends).toBe(1);
    expect((await api.conferir(note.id)).body).toMatchObject({ id: note.id, situacao: "autorizada", alterada: false });
    vault.cancelNfseExternally(note.id);
    expect((await api.obter("nfse", note.id)).body.situacao).toBe("autorizada");
    await expect(api.cancelamentoXml("nfse", note.id)).rejects.toMatchObject({ codigo: "nao_encontrado" });
    expect((await api.conferir(note.id)).body).toMatchObject({ id: note.id, situacao: "cancelada", alterada: true });
    const archived = (await api.cancelamentoXml("nfse", note.id)).body;
    expect(archived).toBe(vault.cancellationXml(note.id));
    expect(archived).toContain(note.chaveAcesso!);
    expect((await api.conferir(note.id)).body).toMatchObject({ id: note.id, situacao: "cancelada", alterada: false });
    expect((await api.cancelamentoXml("nfse", note.id)).body).toBe(archived);
    expect(vault.cancellations.size).toBe(1);
    expect(vault.emissions.size).toBe(1);
    expect(vault.emissionSends.get(vault.sefazKey("nfse", note.ambiente, note.referencia!))).toBe(sends);
    expect(vault.sefazSends.has(`cancelar:${note.id}`)).toBe(false);
    expect(vault.calls.filter(call => call.method === "POST").map(call => [call.path, call.body])).toEqual([
      ["/v1/nfse", requestExample("POST", "/v1/nfse")],
      ...Array.from({ length: 3 }, () => [`/v1/nfse/${note.id}/conferir`, undefined]),
    ]);
  });

  it("conferência perdida pode ser repetida e inconclusiva não confirma cancelamento", async () => {
    for (const behavior of ["lose", "inconclusive"] as const) {
      const { api, vault } = setup();
      const { body: note } = await api.emitir("nfse", requestExample("POST", "/v1/nfse"));
      vault.cancelNfseExternally(note.id);
      vault.plan.push(behavior);
      await expect(api.conferir(note.id)).rejects.toMatchObject(behavior === "lose"
        ? { name: "NfapiTransportError", kind: "network" }
        : { codigo: "sem_resposta_conclusiva", emissao: { id: note.id, situacao: "autorizada" } });
      expect(vault.cancellations.size).toBe(behavior === "lose" ? 1 : 0);
      expect((await api.obter("nfse", note.id)).body.situacao).toBe(behavior === "lose" ? "cancelada" : "autorizada");
      expect((await api.conferir(note.id)).body).toMatchObject({
        id: note.id, situacao: "cancelada", alterada: behavior === "inconclusive",
      });
      expect(vault.cancellations.size).toBe(1);
      expect((await api.cancelamentoXml("nfse", note.id)).body).toBe(vault.cancellationXml(note.id));
      expect(vault.sefazSends.has(`cancelar:${note.id}`)).toBe(false);
      expect(vault.emissions.size).toBe(1);
    }
  });

  it("conferir exige 0.12.0 da mesma major antes da operação e não recupera emissão incerta", async () => {
    for (const version of ["0.11.0", "1.0.0", "ilegível"]) {
      const { api, vault } = setup({ version });
      await expect(api.conferir("nfs_teste")).rejects.toMatchObject({
        name: "NfapiOutdatedError", minVersion: "0.12.0", vaultVersion: version,
      });
      expect(vault.calls.map(call => call.method)).toEqual(["GET"]);
    }
    for (const version of ["0.12.0", "0.13.0"]) {
      const { api, vault } = setup({ version });
      const { body: note } = await api.emitir("nfse", requestExample("POST", "/v1/nfse"));
      expect((await api.conferir(note.id)).body).toMatchObject({ alterada: false, situacao: "autorizada" });
      vault.emissions.get(note.id)!.situacao = "indefinida";
      await expect(api.conferir(note.id)).rejects.toMatchObject({ status: 409, codigo: "nfse_nao_autorizada" });
      expect(vault.emissions.get(note.id)!.situacao).toBe("indefinida");
      expect(vault.cancellations.size).toBe(0);
      expect(vault.emissions.size).toBe(1);
    }
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
    expect(rejected.emissionKind).toBe("nfce");

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

    const deadlines: number[] = [];
    const slow = new NfapiClient({
      url: VAULT_URL,
      apiKey: vault.apiKey,
      readTimeoutMs: 5,
      timeoutSignal: milliseconds => {
        deadlines.push(milliseconds);
        return AbortSignal.abort(new DOMException("Tempo simulado esgotado.", "TimeoutError"));
      },
      fetch: async (_input, init) => {
        init!.signal!.throwIfAborted();
        throw new Error("O timeout simulado deve interromper a chamada.");
      },
    });
    expect(await slow.cofre().catch((e) => e)).toMatchObject({ kind: "timeout" });
    expect(deadlines).toEqual([5]);
  });

  it("lista por referência e ambiente", async () => {
    const { api, vault } = setup();
    await api.emitir("nfce", requestExample("POST", "/v1/nfce"));
    expect((await api.listar("nfce", { referencia: "caixa1-venda-5001", ambiente: "producao" })).body).toEqual([]);
    expect((await api.listar("nfce", { referencia: "caixa1-venda-5001", ambiente: "homologacao" })).body).toHaveLength(1);
    expect(vault.calls.at(-1)!.path).toBe("/v1/nfce");
  });

  it("listagem malformada não vira ausência de nota", async () => {
    for (const body of [null, {}, [], { nfce: [] }, { nfe: null }, { nfe: {} }]) {
      const api = new NfapiClient({ url: VAULT_URL, apiKey: "nfapi_teste_0123456789",
        fetch: async () => Response.json(body) });
      await expect(api.listar("nfe", { referencia: "pedido-1001", ambiente: "homologacao" })).rejects.toMatchObject({
        name: "NfapiTransportError", kind: "bad_response",
      });
    }
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
