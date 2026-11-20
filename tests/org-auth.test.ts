import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createBlingVault, type VaultValue } from "../src/erp/bling/vault.ts";
import { BlingError, type BlingContext, type BlingOperationName } from "../src/erp/bling/contracts.ts";
import { authorizeBlingOperation } from "../src/erp/bling/schema.ts";
import { normalizeErpParts } from "../src/erp/parts.ts";
import { createBlingOAuthProvider } from "../src/erp/bling/oauth.ts";

const fixedNow = Date.UTC(2026, 10, 19, 15);
const opaque = () => crypto.randomUUID() + crypto.randomUUID();
const area = () => "auth-" + crypto.randomUUID();
const value = (revision = "1"): VaultValue => {
  const application = { client_id: opaque(), client_secret: opaque() };
  return { revision, application, credential: { ...application, access_token: opaque(), refresh_token: opaque(), expires_at: fixedNow + 3_600_000, scopes: [] }, disconnected: false };
};
const privateValues = (v: VaultValue) => [v.application?.client_id, v.application?.client_secret, v.credential?.access_token, v.credential?.refresh_token].filter((s): s is string => !!s);
const noPrivateText = (text: string, v: VaultValue) => {
  for (const secret of privateValues(v)) expect(text.includes(secret)).toBe(false);
};
const row = (profile: string) => env.DB.prepare("SELECT value FROM secrets WHERE id=?").bind(`erp-bling:${profile}`).first<{ value: string }>();

describe("custódia da conta no cofre do núcleo", () => {
  it("usa AES-GCM em secrets por área e lê o material somente pela porta privada", async ({ task }) => {
    const profile = area(), vault = createBlingVault(env), credential = value();
    const empty = await vault.read(profile);
    expect(empty).toEqual({ revision: "0", ciphertext: null, value: { revision: "0", application: null, credential: null, disconnected: false } });
    const written = await vault.compareAndSwap(profile, empty, credential);
    const stored = await row(profile);
    expect(stored).not.toBeNull();
    noPrivateText(stored!.value, credential);
    const encrypted = JSON.parse(stored!.value);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.data.length).toBeGreaterThan(16);
    const read = await vault.read(profile);
    expect(read.revision).toBe("1");
    expect(read.ciphertext === written.ciphertext).toBe(true);
    expect(read.value.credential?.refresh_token === credential.credential?.refresh_token).toBe(true);
    expect(read.value.application?.client_secret === credential.application?.client_secret).toBe(true);
    expect((await vault.read(area())).revision).toBe("0");
    task.meta.orgAuth = { encrypted: true, isolatedByArea: true, externalCalls: 0 };
  });

  it("CAS concorrente aceita um vencedor e não avança duas vezes a revisão", async () => {
    const profile = area(), vault = createBlingVault(env), first = value();
    const before = await vault.compareAndSwap(profile, await vault.read(profile), first);
    const next = { ...first, revision: "2", credential: { ...first.credential!, access_token: opaque(), refresh_token: opaque() } };
    const results = await Promise.allSettled([vault.compareAndSwap(profile, before, next), vault.compareAndSwap(profile, before, next)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BlingError);
    expect(rejected.reason.code).toBe("BLING_REVISION_CONFLICT");
    noPrivateText(JSON.stringify(rejected.reason), next);
    expect((await vault.read(profile)).revision).toBe("2");
  });

  it("o tombstone remove todo material e recusa escrita atrasada após desconexão", async () => {
    const profile = area(), vault = createBlingVault(env), first = value();
    const before = await vault.compareAndSwap(profile, await vault.read(profile), first);
    const tombstone = { revision: "2", application: null, credential: null, disconnected: true };
    await vault.compareAndSwap(profile, before, tombstone);
    await expect(vault.compareAndSwap(profile, before, { ...first, revision: "2" })).rejects.toMatchObject({ code: "BLING_REVISION_CONFLICT" });
    const read = await vault.read(profile);
    expect(read.value).toEqual(tombstone);
    expect(read.ciphertext).not.toBeNull();
    noPrivateText((await row(profile))!.value, first);
    const replacement = value("3");
    await vault.compareAndSwap(profile, read, replacement);
    expect((await vault.read(profile)).revision).toBe("3");
    await expect(vault.compareAndSwap(profile, before, { ...first, revision: "2" })).rejects.toMatchObject({ code: "BLING_REVISION_CONFLICT" });
  });

  it("não permite copiar ciphertext entre áreas ou forjar sua revisão", async () => {
    const source = area(), target = area(), vault = createBlingVault(env), first = value();
    const original = await vault.compareAndSwap(source, await vault.read(source), first);
    await env.DB.prepare("INSERT INTO secrets(id,value) VALUES(?,?)").bind(`erp-bling:${target}`, original.ciphertext).run();
    await expect(vault.read(target)).rejects.toMatchObject({ code: "BLING_AUTH_REQUIRED" });
    await expect(vault.compareAndSwap(target, original, { ...first, revision: "2" })).rejects.toMatchObject({ code: "BLING_AUTH_REQUIRED" });
    await expect(vault.compareAndSwap(source, { ...original, revision: "7", value: { ...original.value, revision: "7" } }, { ...first, revision: "8" })).rejects.toMatchObject({ code: "BLING_REVISION_CONFLICT" });
    expect((await vault.read(source)).revision).toBe("1");
  });

  it("só aceita incremento único e tombstone sem aplicativo nem tokens", async () => {
    const profile = area(), vault = createBlingVault(env), before = await vault.read(profile), first = value();
    await expect(vault.compareAndSwap(profile, before, { ...first, revision: "2" })).rejects.toMatchObject({ code: "BLING_REVISION_CONFLICT" });
    await expect(vault.compareAndSwap(profile, before, { ...first, disconnected: true })).rejects.toMatchObject({ code: "BLING_AUTH_REQUIRED" });
    expect(await row(profile)).toBeNull();
  });

  it("falhas de D1 e cifra saem como erro local sem material privado", async () => {
    const profile = area(), privateValue = value(), secret = privateValue.application!.client_secret;
    const broken = createBlingVault({ ...env, DB: { prepare() { throw new Error(secret); } } as unknown as D1Database });
    const readFailure = await broken.read(profile).catch(error => error);
    expect(readFailure).toBeInstanceOf(BlingError);
    expect(readFailure.code).toBe("BLING_AUTH_REQUIRED");
    noPrivateText(JSON.stringify(readFailure), privateValue);
    noPrivateText(String(readFailure), privateValue);
    const brokenCipher = createBlingVault(env, { seal: async () => { throw new Error(secret); }, unseal: async () => { throw new Error(secret); } });
    const before = await brokenCipher.read(profile);
    const writeFailure = await brokenCipher.compareAndSwap(profile, before, privateValue).catch(error => error);
    expect(writeFailure).toBeInstanceOf(BlingError);
    noPrivateText(JSON.stringify(writeFailure), privateValue);
    expect(await row(profile)).toBeNull();
  });
});

const person = "b6100000-0000-4000-8000-000000000001";
const session = "b6100000-0000-4000-8000-000000000002";
function context(): BlingContext {
  return {
    profile: "auth-policy", clock: { now: () => fixedNow }, origin: "app",
    identity: {
      actor: { user_id: person, name: "Pessoa", email: null, erp_role: "admin", verified_factor: true, session_id: session, aal: "aal2", is_agent: true },
      people: [], parts: normalizeErpParts({}), partsControl: { profile: "auth-policy", revision: "1", expires_at: fixedNow + 600_000 },
    },
  };
}
const authOperations: BlingOperationName[] = ["erp_bling_app_save", "erp_bling_oauth_start", "erp_bling_disconnect"];
describe("operações de autorização usam a política comum de bots", () => {
  for (const operation of authOperations) {
    it(`${operation}: permite configuração explícita, exige confirmação no padrão e recusa origem externa`, () => {
      const input = { command_id: "auth-command", expected_revision: "0" }, allowed = context();
      allowed.authorization = { request_hash: "a".repeat(64), bot: { id: "bot-equipe", allowed_operations: [operation], allowed_entities: [], data_scopes: [], allow_sensitive: true } };
      expect(() => authorizeBlingOperation(allowed, operation, input)).not.toThrow();
      expect(() => authorizeBlingOperation(context(), operation, input)).toThrow(BlingError);
      expect(() => authorizeBlingOperation({ ...allowed, origin: "external" }, operation, input)).toThrow(BlingError);
      allowed.authorization.bot!.allow_sensitive = false;
      expect(() => authorizeBlingOperation(allowed, operation, input)).toThrow(BlingError);
      allowed.authorization.confirmation = { operation, command_id: input.command_id, request_hash: "a".repeat(64), confirmed_by: person, expires_at: fixedNow + 60_000 };
      expect(() => authorizeBlingOperation(allowed, operation, input)).not.toThrow();
      allowed.identity.actor!.erp_role = "consulta";
      expect(() => authorizeBlingOperation(allowed, operation, input)).toThrow(BlingError);
    });
  }
});

describe("adaptador OAuth protocolar com transporte falso separado", () => {
  it("constrói os POSTs de troca e renovação com Basic, retorno exato e redirect manual", async ({ task }) => {
    const application = { client_id: opaque(), client_secret: opaque() }, code = opaque();
    const initial = { access_token: opaque(), refresh_token: opaque() }, renewed = { access_token: opaque(), refresh_token: opaque() };
    const callbackUrl = "https://installation.invalid/api/public/erp-bling/area/callback";
    const calls: { method: string; grant: string; redirect: string }[] = [];
    let disposed = 0;
    const actualFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("HTTP externo não permitido no teste."); });
    const transport = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth.invalid/token");
      const headers = new Headers(init?.headers), form = new URLSearchParams(String(init?.body));
      const expectedBasic = btoa(`${application.client_id}:${application.client_secret}`);
      expect(headers.get("authorization") === `Basic ${expectedBasic}`).toBe(true);
      expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(headers.get("accept")).toBe("application/json");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const grant = form.get("grant_type")!;
      if (!calls.length) {
        expect(grant).toBe("authorization_code");
        expect(form.get("code") === code).toBe(true);
        expect(form.get("redirect_uri")).toBe(callbackUrl);
        expect(form.has("refresh_token")).toBe(false);
      } else {
        expect(grant).toBe("refresh_token");
        expect(form.get("refresh_token") === initial.refresh_token).toBe(true);
        expect(form.has("code")).toBe(false);
      }
      expect(form.has("client_secret")).toBe(false);
      calls.push({ method: init!.method!, grant, redirect: init!.redirect! });
      return Response.json({ ...(calls.length === 1 ? initial : renewed), token_type: "Bearer", expires_in: 3600,
        ...(calls.length === 1 ? { scope: "simulated.read" } : {}), unexpected_private_field: opaque() });
    }) as typeof fetch;
    try {
      const provider = createBlingOAuthProvider({ tokenEndpoint: "https://oauth.invalid/token", fetch: transport,
        clock: { now: () => fixedNow }, readScopes: ["simulated.read"],
        timeout: () => ({ signal: new AbortController().signal, dispose: () => { disposed++; } }) });
      const exchanged = await provider.exchange({ ...application, code, callback_url: callbackUrl });
      expect(exchanged.access_token === initial.access_token).toBe(true);
      expect(exchanged.refresh_token === initial.refresh_token).toBe(true);
      expect(exchanged.expires_at).toBe(fixedNow + 3_600_000);
      expect(exchanged.scopes).toEqual(["simulated.read"]);
      expect(Object.keys(exchanged).sort()).toEqual(["access_token", "client_id", "client_secret", "expires_at", "refresh_token", "scopes"]);
      const refreshed = await provider.refresh(exchanged);
      expect(refreshed.refresh_token === renewed.refresh_token).toBe(true);
      expect(refreshed.refresh_token !== exchanged.refresh_token).toBe(true);
      expect(refreshed.scopes).toEqual(["simulated.read"]);
      expect(calls).toEqual([{ method: "POST", grant: "authorization_code", redirect: "manual" }, { method: "POST", grant: "refresh_token", redirect: "manual" }]);
      expect(disposed).toBe(2);
      expect(actualFetch).not.toHaveBeenCalled();
      task.meta.orgAuthOAuth = { protocolPosts: 2, externalCalls: 0, entityWrites: 0, retries: 0 };
    } finally { actualFetch.mockRestore(); }
  });

  for (const scenario of ["redirect", "http_error", "truncated", "oversized", "transport", "unexpected_scope"] as const) {
    it(`${scenario}: falha saneada, sem repetição oculta e sem vazar resposta remota`, async () => {
      const privateValue = value(), credential = privateValue.credential!;
      let requests = 0, disposed = 0;
      const provider = createBlingOAuthProvider({ tokenEndpoint: "https://oauth.invalid/token", clock: { now: () => fixedNow }, readScopes: [],
        timeout: () => ({ signal: new AbortController().signal, dispose: () => { disposed++; } }),
        fetch: (async () => {
          requests++;
          if (scenario === "transport") throw new Error(credential.refresh_token);
          if (scenario === "redirect") return new Response(credential.access_token, { status: 302, headers: { Location: "https://elsewhere.invalid/token" } });
          if (scenario === "http_error") return Response.json({ error: "invalid_grant", error_description: credential.refresh_token }, { status: 400 });
          if (scenario === "truncated") return new Response('{"access_token":"' + credential.access_token);
          if (scenario === "oversized") return new Response(credential.access_token + "x".repeat(65537));
          return Response.json({ access_token: credential.access_token, refresh_token: credential.refresh_token, token_type: "Bearer", expires_in: 3600, scope: credential.client_secret });
        }) as typeof fetch,
      });
      const error = await provider.refresh(credential).catch(failure => failure);
      expect(error).toBeInstanceOf(BlingError);
      noPrivateText(JSON.stringify(error), privateValue);
      noPrivateText(String(error), privateValue);
      expect(requests).toBe(1);
      expect(disposed).toBe(1);
    });
  }
});
