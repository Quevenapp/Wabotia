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
import { createFakeVault } from "./fake-vault";
import { actor, VAULT_URL } from "./helpers";

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
    const vault = createFakeVault({ apiKey: KEY, version: "0.3.1", published: "0.3.2", certificateUntil: "2026-12-01T03:00:00.000Z", openapi: contract });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(vault.calls.map((c) => c.path)).toEqual(["/v1/cofre", "/v1/series", "/v1/openapi.json"]);
    expect(view.checked).toMatchObject({
      ok: true,
      state: {
        version: "0.3.1",
        update: { published: "0.3.2", pending: true },
        certificate: { holder: "EMPRESA EXEMPLO LTDA", valid_until: "2026-12-01T03:00:00.000Z" },
        production_released: false,
        key: { scope: "completo", environments: ["homologacao", "producao"] },
      },
      contract: { pinned: "0.3.1", vault: "0.3.1", compatible: true, differences: [] },
    });
    expect(view.checked!.series).toHaveLength(2);
    expect(view.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(["vault_outdated", "certificate_expiring", "production_blocked"]));
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("contrato diferente no cofre vira alerta", async () => {
    const profile = uid();
    const changed = structuredClone(contract) as any;
    changed.info.version = "0.4.0";
    delete changed.paths["/v1/inutilizacoes"];
    const vault = createFakeVault({ apiKey: KEY, openapi: changed });
    await saveEmissor(env, actor(), profile, { url: VAULT_URL, api_key: KEY });
    const view = await testEmissor(env, actor(), profile, { fetch: vault.fetch });
    expect(view.checked!.contract).toMatchObject({
      vault: "0.4.0",
      compatible: false,
      differences: ["operação removida: POST /v1/inutilizacoes"],
    });
    expect(view.alerts.find((a) => a.code === "contract_incompatible")).toMatchObject({ level: "error", version: "0.4.0" });
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
      version: "0.3.1",
      update: { published: "0.3.1", pending: false },
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

  it("configura, testa, lê estado, séries e SEFAZ; erro fiscal com detalhes no corpo", async () => {
    const profile = uid();
    await setModule(profile, "erp", true, "teste");
    await setModule(profile, "erp-fiscal", true, "teste");
    const vault = createFakeVault({ apiKey: KEY, openapi: contract });
    const admin = actor();
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

    const operator = actor("operator", [profile]);
    const state = await (await call("GET", "", undefined, operator)).json<any>();
    expect(state).toMatchObject({ configured: true, contract_version: "0.3.1", checked: { ok: true } });
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
});
