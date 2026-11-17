// Configuração do emissor (segredo do núcleo), "Testar conexão", alertas do
// painel e as rotas /erp-emissor.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../../../src/db";
import {
  certificateDaysLeft,
  emissorAlerts,
  emissorView,
  normalizeVaultUrl,
  saveEmissor,
  testEmissor,
} from "../../../src/erp/emissor/config.ts";
import contract from "../../../src/erp/emissor/contract/openapi.json";
import { erpEmissorRoute } from "../../../src/erp/emissor/routes.ts";
import { uid } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { NfapiClient } from "../../../src/erp/emissor/nfapi.ts";
import { createFakeVault, FAKE_PDF, FAKE_PNG } from "./fake-vault";
import { actor, member, VAULT_URL, vaultArea } from "./helpers";
import { requestExample } from "./schema";

const KEY = "nfapi_teste_0123456789";

describe("endereço do cofre", () => {
  it("aceita só a origem https", () => {
    expect(normalizeVaultUrl(" https://Cofre.Exemplo.workers.dev/ ")).toBe("https://cofre.exemplo.workers.dev");
    expect(normalizeVaultUrl("https://nfe.minhaempresa.com.br:8443")).toBe("https://nfe.minhaempresa.com.br:8443");
    for (const bad of [
      "http://cofre.exemplo.workers.dev",
      "https://user:pw@cofre.exemplo.workers.dev",
      "https://cofre.exemplo.workers.dev/v1",
      "https://cofre.exemplo.workers.dev/?a=1",
      "https://localhost",
      "cofre.exemplo.workers.dev",
      "",
      42,
    ])
      expect(() => normalizeVaultUrl(bad), String(bad)).toThrow();
  });
});

describe("configuração", () => {
  it("guarda a chave cifrada e nunca a devolve", async () => {
    const profile = uid();
    const view = await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    expect(view).toMatchObject({ configured: true, provider: "nfapi", url: VAULT_URL, api_key_set: true, checked: null });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(await emissorView(env, profile))).not.toContain(KEY);
    const row = await one(env, "SELECT value FROM secrets WHERE id=?", `erp-emissor:${profile}`);
    expect(row.value).not.toContain(KEY);
    expect(row.value).not.toContain("nfapi_");
  });

  it("só administrador; trocar o endereço exige a chave de novo", async () => {
    const profile = uid();
    expect(await saveEmissor(env, actor("operator", [profile]), profile, { url: VAULT_URL, api_key: KEY }).catch((e) => e)).toMatchObject({
      status: 403,
    });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    expect(await saveEmissor(env, actor(), profile, { url: "https://outro.exemplo.workers.dev" }).catch((e) => e)).toMatchObject({
      code: "fiscal_api_key_required",
    });
    // Mesmo endereço sem chave: mantém a chave guardada.
    expect((await saveEmissor(env, actor(), profile, { url: VAULT_URL })).api_key_set).toBe(true);
    expect(await saveEmissor(env, actor(), profile, { api_key: "segredo" }).catch((e) => e)).toMatchObject({
      code: "fiscal_invalid_api_key",
    });
    expect(await saveEmissor(env, actor(), profile, { provider: "outro" }).catch((e) => e)).toMatchObject({
      code: "fiscal_invalid_provider",
    });
  });

  it("sem configuração: visão vazia", async () => {
    expect(await emissorView(env, uid())).toMatchObject({ configured: false, url: null, api_key_set: false, alerts: [] });
  });
});

describe("Testar conexão", () => {
  it("mostra versão, atualização, certificado, ambiente e séries", async () => {
    const profile = uid();
    const vault = createFakeVault({ apiKey: KEY, published: "0.9.1", certificateUntil: "2026-12-01T03:00:00.000Z", openapi: contract });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(vault.calls.map((c) => c.path)).toEqual(["/v1/cofre", "/v1/series", "/v1/openapi.json"]);
    expect(view.checked).toMatchObject({
      ok: true,
      state: {
        version: "0.9.0",
        update: { published: "0.9.1", pending: true },
        certificate: { holder: "EMPRESA EXEMPLO LTDA", valid_until: "2026-12-01T03:00:00.000Z" },
        production_released: false,
        key: { scope: "completo", environments: ["homologacao", "producao"] },
        contingency: { pending_notes: 0 },
        logo: true,
      },
      contract: { pinned: "0.9.0", vault: "0.9.0", compatible: true, differences: [] },
    });
    expect(view.checked!.series).toHaveLength(2);
    expect(view.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(["vault_outdated", "certificate_expiring", "production_blocked"]));
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("contrato de minor mais nova no cofre vira alerta de incompatível", async () => {
    const profile = uid();
    const changed = structuredClone(contract) as any;
    changed.info.version = "0.10.0";
    delete changed.paths["/v1/inutilizacoes"];
    const vault = createFakeVault({ apiKey: KEY, openapi: changed });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(view.checked!.contract).toMatchObject({
      vault: "0.10.0",
      compatible: false,
      differences: ["operação removida: GET /v1/inutilizacoes", "operação removida: POST /v1/inutilizacoes"],
    });
    expect(view.alerts.find((a) => a.code === "contract_incompatible")).toMatchObject({ level: "error", version: "0.10.0" });
  });

  it("cofre mais antigo: atendido, com o alerta de desatualizado por recurso", async () => {
    for (const [version, features] of [
      ["0.7.0", ["documents", "received"]],
      ["0.8.0", ["received"]],
      ["0.9.0", []],
    ] as const) {
      const profile = uid();
      const served = structuredClone(contract) as any;
      served.info.version = version;
      const vault = createFakeVault({ apiKey: KEY, version, openapi: served });
      await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
      const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
      expect(view.checked!.contract, version).toMatchObject({ vault: version, compatible: true });
      expect(view.alerts.find((a) => a.code === "contract_incompatible"), version).toBeUndefined();
      const outdated = view.alerts.filter((a) => a.code === "vault_feature_outdated");
      expect(outdated.map((a) => a.feature), version).toEqual(features);
      for (const a of outdated) expect(a.message).toMatch(/^Cofre desatualizado para .+: precisa da versão 0\.[89]\.0/);
    }
  });

  it("NFC-e em contingência pendente e logotipo ausente viram alertas", async () => {
    const profile = uid();
    const vault = createFakeVault({ apiKey: KEY, logo: null, openapi: contract });
    vault.emissions.set("nfc_x", {
      id: "nfc_x", doc: "nfce", ambiente: "homologacao", referencia: "x", hash: "", serie: 1, numero: 9, situacao: "contingencia",
      chaveAcesso: null, protocolo: null, mensagens: [], uf: "SP", valor: 1, cartas: 0, waiting: false,
      contingencia: { pendente: true, desde: "2026-11-16T12:00:00.000Z", motivo: "SEFAZ fora", tentativas: 0, ultima: null },
      criadaEm: "2026-11-16T12:00:00.000Z", atualizadaEm: "2026-11-16T12:00:00.000Z",
    });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(view.checked!.state).toMatchObject({ contingency: { pending_notes: 1 }, logo: false });
    expect(view.alerts.find((a) => a.code === "contingency_pending")).toMatchObject({ level: "warning", pending_notes: 1 });
    expect(view.alerts.find((a) => a.code === "logo_missing")).toMatchObject({ level: "info" });
  });

  it("chave recusada: guarda a falha e mostra o motivo", async () => {
    const profile = uid();
    const vault = createFakeVault({ apiKey: "nfapi_outra_chave_000000" });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(view.checked).toMatchObject({
      ok: false,
      error: { code: "fiscal_provider_unauthorized", provider_code: "nao_autenticado" },
    });
    expect(view.alerts[0]).toMatchObject({ code: "check_failed", level: "error" });
  });

  it("sem configuração: fiscal_provider_not_configured", async () => {
    expect(await testEmissor(env, actor(), uid()).catch((e) => e)).toMatchObject({
      status: 409,
      code: "fiscal_provider_not_configured",
    });
  });
});

describe("alertas", () => {
  const at = Date.parse("2026-11-16T12:00:00Z");
  const check = (certificate: string | null, extra: any = {}) => ({
    at,
    ok: true,
    error: null,
    series: [],
    contract: null,
    state: {
      provider: "nfapi",
      version: "0.9.0",
      update: { published: "0.9.0", pending: false },
      certificate: certificate ? { holder: "X", document: null, valid_until: certificate, days_left: 999 } : null,
      production_released: true,
      key: { scope: "completo" as const, environments: ["homologacao" as const, "producao" as const] },
      documents: { nfse: true, nfe: [], nfce: [] },
    },
    ...extra,
  });

  it("dias do certificado pela data, não pelo número do teste", () => {
    expect(certificateDaysLeft("2026-11-26T12:00:00Z", at)).toBe(10);
    expect(emissorAlerts(check("2026-11-26T12:00:00Z"), at)).toEqual([
      { code: "certificate_expiring", level: "warning", message: "O certificado digital vence em 10 dias.", days_left: 10 },
    ]);
    expect(emissorAlerts(check("2026-11-15T12:00:00Z"), at)[0]).toMatchObject({ code: "certificate_expired", days_left: -1 });
    expect(emissorAlerts(check("2027-11-16T12:00:00Z"), at)).toEqual([]);
    expect(emissorAlerts(check(null), at)[0].code).toBe("certificate_missing");
    expect(emissorAlerts(null, at)[0].code).toBe("never_checked");
    expect(emissorAlerts(check("2027-11-16T12:00:00Z"), at + 2 * 86_400_000).map((a) => a.code)).toContain("check_stale");
  });
});

describe("rotas /erp-emissor", () => {
  const url = (profile: string, sub = "") => `https://wabotia.test/api/v1/profiles/${profile}/erp-emissor${sub}`;

  it("módulo erp-fiscal desligado: 409 module_disabled", async () => {
    const profile = uid();
    await setModule(profile, "erp", true, "teste");
    const error = await erpEmissorRoute(env, new Request(url(profile)), profile, actor()).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "module_disabled" });
  });

  // Tempo-limite próprio: salvar, testar e remover passam pelo portão do ERP
  // (uma ida ao objeto erp: cada, com o esquema subindo na primeira) e o teste
  // grava as pessoas no D1. Medido sozinho em 17/11: 19,5 s no tronco e 20,3 s
  // neste branch, com a máquina carregada; os 20 s de antes não bastavam.
  it("configura, testa, lê estado, séries e SEFAZ; erro fiscal com detalhes no corpo", { timeout: 45_000 }, async () => {
    const profile = uid();
    await setModule(profile, "erp", true, "teste");
    await setModule(profile, "erp-fiscal", true, "teste");
    const vault = createFakeVault({ apiKey: KEY, openapi: contract });
    // Pessoas gravadas no D1: a configuração passa pelo portão do ERP, que só
    // conhece quem está no envelope (src/modules/erp/identity.ts).
    const admin = await member("admin", profile);
    const call = (method: string, sub = "", body?: unknown, who = admin) =>
      erpEmissorRoute(
        env,
        new Request(url(profile, sub), { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        profile,
        who,
        { fetch: vault.fetch },
      );

    const notConfigured = await call("GET", "/series");
    expect(notConfigured.status).toBe(409);
    expect(await notConfigured.json()).toMatchObject({ error: { code: "fiscal_provider_not_configured" } });

    const saved = await call("PUT", "", { url: VAULT_URL, api_key: KEY });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(KEY);
    expect((await (await call("POST", "/test")).json<any>()).checked.ok).toBe(true);

    // Leitura pede papel do ERP (erp:*); configurar continua só do administrador.
    expect(await call("GET", "", undefined, actor("operator", [profile])).catch((e) => e)).toMatchObject({ status: 403, code: "erp_role_required" });
    const operator = await member("operator", profile, ["erp:consulta"]);
    const state = await (await call("GET", "", undefined, operator)).json<any>();
    expect(state).toMatchObject({ configured: true, contract_version: "0.9.0", checked: { ok: true } });
    expect(await call("PUT", "", { url: VAULT_URL }, operator).catch((e) => e)).toMatchObject({ status: 403 });
    expect(await call("POST", "/test", undefined, operator).catch((e) => e)).toMatchObject({ status: 403 });

    expect((await (await call("GET", "/series", undefined, operator)).json<any>()).series).toHaveLength(2);
    expect(await (await call("GET", "/sefaz?uf=sp&modelo=nfce")).json()).toMatchObject({ in_operation: true });
    const unsupported = await call("GET", "/sefaz?uf=RS");
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({
      error: { code: "fiscal_uf_not_supported", provider_code: "uf_nao_suportada", retryable: false },
    });
    expect((await call("GET", "/sefaz?uf=X")).status).toBe(400);

    const outsider = actor("operator", []);
    expect(await call("GET", "", undefined, outsider).catch((e) => e)).toMatchObject({ status: 404 });

    const removed = await (await call("DELETE")).json<any>();
    expect(removed.configured).toBe(false);
  });

  it("PDF, cupom, logotipo e XML dos eventos: leitura de qualquer papel erp:*, repassados como vieram", { timeout: 20_000 }, async () => {
    const { vault, profile } = await vaultArea({ apiKey: KEY });
    await setModule(profile, "erp", true, "teste");
    await setModule(profile, "erp-fiscal", true, "teste");
    const api = new NfapiClient({ url: VAULT_URL, apiKey: KEY, fetch: vault.fetch });
    const nfe = (await api.emitir("nfe", requestExample("POST", "/v1/nfe"))).body;
    const nfce = (await api.emitir("nfce", requestExample("POST", "/v1/nfce"))).body;
    await api.cartaCorrecao(nfe.id, requestExample("POST", "/v1/nfe/{id}/carta-correcao"));
    await api.cancelar("nfe", nfe.id, requestExample("POST", "/v1/nfe/{id}/cancelar"));
    vault.plan.push("reject");
    const rejected = await api.emitir("nfe", { ...requestExample("POST", "/v1/nfe"), referencia: "outra-1" }).catch((e) => e.emissao);
    const consulta = await member("operator", profile, ["erp:consulta"]);
    const vendas = await member("operator", profile, ["erp:vendas"]);
    const get = (sub: string, who = consulta) =>
      erpEmissorRoute(env, new Request(url(profile, sub)), profile, who, { fetch: vault.fetch });

    for (const who of [consulta, vendas]) {
      const danfe = await get(`/nfe/${nfe.id}/danfe`, who);
      expect(danfe.status).toBe(200);
      expect(danfe.headers.get("Content-Type")).toBe("application/pdf");
      expect(danfe.headers.get("Content-Length")).toBe(String(FAKE_PDF.byteLength));
      expect(danfe.headers.get("Cache-Control")).toBe("private, no-store");
      expect(new Uint8Array(await danfe.arrayBuffer())).toEqual(FAKE_PDF);
    }
    const danfce = await get(`/nfce/${nfce.id}/danfce?largura=58&via=estabelecimento`);
    expect(danfce.headers.get("Content-Type")).toBe("application/pdf");
    expect(vault.calls.at(-1)).toMatchObject({ path: `/v1/nfce/${nfce.id}/danfce`, query: "?largura=58&via=estabelecimento" });
    const before = vault.calls.length;
    for (const bad of ["?largura=99", "?via=cozinha"]) {
      const r = await get(`/nfce/${nfce.id}/danfce${bad}`);
      expect(r.status, bad).toBe(400);
      expect(await r.json(), bad).toMatchObject({ error: { code: "fiscal_invalid_request" } });
    }
    expect(vault.calls.length, "largura ou via desconhecida não chega ao cofre").toBe(before);
    expect(await (await get(`/nfce/${nfce.id}/cupom`)).json()).toMatchObject({ modelo: "nfce", via: "consumidor", contingencia: false });
    const logo = await get("/logotipo");
    expect(logo.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(FAKE_PNG);
    const cancel = await get(`/nfe/${nfe.id}/cancelamento/xml`);
    expect(cancel.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await cancel.text()).toContain("110111");
    expect(await (await get(`/nfe/${nfe.id}/carta-correcao/1/xml`)).text()).toContain('nSeqEvento="1"');

    // Erros do 0.8.0: id de outro modelo, nota sem XML autorizado.
    const otherModel = await get(`/nfe/${nfce.id}/danfe`);
    expect(otherModel.status).toBe(404);
    expect(await otherModel.json()).toMatchObject({ error: { code: "fiscal_document_not_found", provider_code: "nao_encontrado" } });
    const notAuthorized = await get(`/nfe/${rejected.id}/danfe`);
    expect(notAuthorized.status).toBe(409);
    expect(await notAuthorized.json()).toMatchObject({ error: { code: "fiscal_not_authorized", provider_code: "nfe_nao_autorizada" } });

    // Sem papel no ERP: nada.
    expect(await get(`/nfe/${nfe.id}/danfe`, actor("operator", [profile])).catch((e) => e)).toMatchObject({ status: 403, code: "erp_role_required" });
  });

  it("cofre antigo: vault_outdated com a versão mínima, nunca o 404 cru; sem logotipo: 404 próprio", { timeout: 20_000 }, async () => {
    const { vault, profile } = await vaultArea({ apiKey: KEY, version: "0.7.0", logo: null });
    await setModule(profile, "erp", true, "teste");
    await setModule(profile, "erp-fiscal", true, "teste");
    const api = new NfapiClient({ url: VAULT_URL, apiKey: KEY, fetch: vault.fetch });
    const nfe = (await api.emitir("nfe", requestExample("POST", "/v1/nfe"))).body;
    const nfce = (await api.emitir("nfce", requestExample("POST", "/v1/nfce"))).body;
    const consulta = await member("operator", profile, ["erp:consulta"]);
    const get = (sub: string) => erpEmissorRoute(env, new Request(url(profile, sub)), profile, consulta, { fetch: vault.fetch });
    const outdated = await get(`/nfe/${nfe.id}/danfe`);
    expect(outdated.status).toBe(409);
    expect(await outdated.json()).toMatchObject({
      error: { code: "vault_outdated", provider_code: "vault_outdated", min_version: "0.8.0", message: expect.stringContaining("0.7.0") },
    });
    // O cupom (0.7.0) esse cofre tem.
    expect((await get(`/nfce/${nfce.id}/cupom`)).status).toBe(200);
    const noLogo = await get("/logotipo");
    expect(noLogo.status).toBe(409);
    expect(await noLogo.json()).toMatchObject({ error: { code: "vault_outdated", min_version: "0.8.0" } });

    const current = await vaultArea({ apiKey: KEY, logo: null });
    await setModule(current.profile, "erp", true, "teste");
    await setModule(current.profile, "erp-fiscal", true, "teste");
    const reader = await member("operator", current.profile, ["erp:consulta"]);
    const missing = await erpEmissorRoute(env, new Request(url(current.profile, "/logotipo")), current.profile, reader, { fetch: current.vault.fetch });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "fiscal_logo_missing" } });
  });
});
