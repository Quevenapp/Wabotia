/** OAuth protocolar separado do transporte GET do acervo. Sem montagem/rede implícita. */
import { BlingError, type BlingContext, type BlingExpectedState, type BlingCredentialPublic, type BlingPublicAccount, type BlingCallbackInput, type BlingLease } from "./contracts.ts";
import type { AuthorizationPort, BlingOAuthProvider, BlingPrivateCredential, BlingCredentialCas } from "./ports.ts";
import { authorizeBlingOperation, parseBlingOperationInput } from "./schema.ts";
import type { IdentityPort } from "../engine/identity.ts";
import { BlingAuthStore, type AuthAttempt } from "./auth-store.ts";
import type { BlingVault, VaultSnapshot, VaultValue } from "./vault.ts";

export interface BlingAccountProof {
  /** A montagem real fornece referência oficial conferida. Não há endpoint padrão. */
  evidence: { url: string; checked_at: string; read_only: true } | null;
  identify(ctx: BlingContext, credential: BlingPrivateCredential): Promise<BlingPublicAccount>;
}
export interface BlingAuthorizationDependencies {
  store: BlingAuthStore;
  vault: BlingVault;
  provider: BlingOAuthProvider;
  accountProof: BlingAccountProof;
  /** Origem canônica confiável da instalação, nunca Host/Forwarded da requisição. */
  publicOrigin: string;
  authorizationEndpoint: string;
  /** Somente escopos de leitura conferidos pela montagem; não aceitar input do painel. */
  readScopes: readonly string[];
  /** Relê sessão/papel no núcleo, inclusive depois das esperas. */
  session(ctx: BlingContext): Promise<IdentityPort>;
  /** Relê partes/aprovação e atualiza o snapshot de partes do contexto antes do CAS. */
  revalidate(ctx: BlingContext, expected: BlingExpectedState): Promise<void>;
}

const encoder = new TextEncoder();
const safeError = (error: unknown) => error instanceof BlingError ? new BlingError(error.code, { status: error.status, retry_at: error.retry_at }) : new BlingError("BLING_AUTH_REQUIRED");
const opaque = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, "0")).join("");
export async function oauthHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), v => v.toString(16).padStart(2, "0")).join("");
}
function httpsUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw 0;
    return url;
  } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
}
export function blingCallbackUrl(publicOrigin: string, profile: string): string {
  const url = httpsUrl(publicOrigin);
  if (url.pathname !== "/" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(profile)) throw new BlingError("BLING_RESPONSE_INVALID");
  url.pathname = `/api/public/erp-bling/${encodeURIComponent(profile)}/callback`;
  return url.href;
}
/** Nome derivado do hash inteiro da área; não colide por pontuação/truncamento. */
export const blingOAuthCookieName = async (profile: string): Promise<`__Host-${string}`> => `__Host-bling-${await oauthHash(profile)}`;
const nextRevision = (revision: string) => {
  const value = Number(revision) + 1;
  if (!Number.isSafeInteger(value)) throw new BlingError("BLING_REVISION_CONFLICT");
  return String(value);
};
function validateCredential(value: BlingPrivateCredential, allowed: readonly string[], now: number): BlingPrivateCredential {
  if (!value || [value.client_id, value.client_secret, value.access_token, value.refresh_token].some(v => typeof v !== "string" || !v || v.length > 16384) ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at <= now || !Array.isArray(value.scopes) || value.scopes.length > 100 ||
      value.scopes.some(v => typeof v !== "string" || !allowed.includes(v))) throw new BlingError("BLING_SCOPE_REQUIRED");
  // Seleção explícita: campos extras da resposta remota não chegam ao cofre/DTO.
  return { client_id: value.client_id, client_secret: value.client_secret, access_token: value.access_token, refresh_token: value.refresh_token, expires_at: value.expires_at, scopes: [...new Set(value.scopes)] };
}
function credentialPublic(snapshot: VaultSnapshot, uncertain = false): BlingCredentialPublic {
  const credential = snapshot.value.credential;
  return { configured: !!snapshot.value.application, authorized: !!credential && !snapshot.value.disconnected && !uncertain,
    revision: snapshot.revision, expires_at: credential?.expires_at ?? null, scopes: credential?.scopes ?? [], uncertain };
}

/** Uma tentativa POST, com fetch explicitamente injetado; redirects e retries proibidos. */
export function createBlingOAuthProvider(options: {
  tokenEndpoint: string;
  fetch: typeof fetch;
  clock: { now(): number };
  readScopes: readonly string[];
  timeout?: () => { signal: AbortSignal; dispose(): void };
}): BlingOAuthProvider {
  const endpoint = httpsUrl(options.tokenEndpoint).href;
  async function request(application: { client_id: string; client_secret: string }, body: URLSearchParams, previousScopes: string[] = []): Promise<BlingPrivateCredential> {
    if ([application.client_id, application.client_secret].some(v => typeof v !== "string" || !v || v.length > 16384)) throw new BlingError("BLING_AUTH_REQUIRED");
    const timer = options.timeout?.() ?? (() => { const controller = new AbortController(); const id = setTimeout(() => controller.abort(), 3000); return { signal: controller.signal, dispose: () => clearTimeout(id) }; })();
    try {
      const bytes = encoder.encode(`${application.client_id}:${application.client_secret}`);
      const basic = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
      const response = await options.fetch(endpoint, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "enable-jwt": "1" }, body: body.toString(), redirect: "manual", signal: timer.signal });
      if (!response.ok || response.redirected || !response.body) throw new BlingError("BLING_AUTH_REQUIRED");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > 65536) throw new BlingError("BLING_RESPONSE_INVALID");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const joined = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
      if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0 ||
          data.scope !== undefined && typeof data.scope !== "string") throw new BlingError("BLING_RESPONSE_INVALID");
      return validateCredential({ ...application, access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: options.clock.now() + data.expires_in * 1000, scopes: data.scope === undefined ? previousScopes : data.scope.split(/\s+/).filter(Boolean) }, options.readScopes, options.clock.now());
    } catch (error) { throw safeError(error); } finally { timer.dispose(); }
  }
  return {
    exchange: input => {
      httpsUrl(input.callback_url);
      if (typeof input.code !== "string" || !input.code || input.code.length > 16384) return Promise.reject(new BlingError("BLING_AUTH_REQUIRED"));
      return request(input, new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.callback_url }));
    },
    refresh: input => {
      if (typeof input.refresh_token !== "string" || !input.refresh_token || input.refresh_token.length > 16384) return Promise.reject(new BlingError("BLING_AUTH_REQUIRED"));
      return request(input, new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refresh_token }), input.scopes);
    },
  };
}

/** Portas privadas não são rotas. Descritores públicos/política bot vêm só de schema.ts. */
export function createBlingAuthorization(deps: BlingAuthorizationDependencies): AuthorizationPort {
  const { store, vault } = deps;
  const authorizationEndpoint = httpsUrl(deps.authorizationEndpoint).href;
  const callbackUrl = (ctx: BlingContext) => blingCallbackUrl(deps.publicOrigin, ctx.profile);
  const redirect = () => new URL("/receber-bling", httpsUrl(deps.publicOrigin)).href;
  const lease = (ctx: BlingContext): BlingLease => ({ owner: crypto.randomUUID(), fence: crypto.randomUUID(), expires_at: ctx.clock.now() + 30000 });
  async function admin(ctx: BlingContext, operation: "erp_bling_app_save" | "erp_bling_oauth_start" | "erp_bling_disconnect", input: unknown) {
    authorizeBlingOperation(ctx, operation, input);
    const fresh = await deps.session(ctx);
    const prior = ctx.identity.actor;
    if (!fresh.actor || !prior || fresh.actor.user_id !== prior.user_id || fresh.actor.session_id !== prior.session_id || fresh.actor.is_agent !== prior.is_agent) throw new BlingError("BLING_ADMIN_REQUIRED");
    ctx.identity = fresh;
    authorizeBlingOperation(ctx, operation, input);
  }
  async function current(ctx: BlingContext, expected: BlingExpectedState, enabled = true) {
    await deps.revalidate(ctx, expected);
    store.recoverExpired(ctx);
    return store.assert(ctx, expected, { enabled });
  }
  function evidence() {
    const proof = deps.accountProof.evidence;
    if (!proof || proof.read_only !== true || !Number.isFinite(Date.parse(proof.checked_at))) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
    httpsUrl(proof.url);
  }
  async function account(ctx: BlingContext, credential: BlingPrivateCredential): Promise<BlingPublicAccount> {
    evidence();
    const value = await deps.accountProof.identify(ctx, credential);
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id) || value.name !== null && (typeof value.name !== "string" || value.name.length > 300)) throw new BlingError("BLING_RESPONSE_INVALID");
    const existing = store.control(ctx).account;
    if (existing && existing.id !== value.id) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    return { id: value.id, name: value.name, confirmed_at: new Date(ctx.clock.now()).toISOString() };
  }
  async function custody(ctx: BlingContext, attempt: AuthAttempt, previous: VaultSnapshot, value: VaultValue, boundAccount: BlingPublicAccount | null, enabled: boolean, appChanged = false, reauthorize?: () => Promise<void>) {
    // Restore da base pode avançar só o SQLite. Não baixar revisão nem escrever
    // uma credencial que o controle não conseguirá reconhecer; reconciliar na montagem.
    if (Number(previous.revision) < Number(attempt.expected.credential_revision)) throw new BlingError("BLING_REVISION_CONFLICT");
    await current(ctx, attempt.expected, enabled);
    if (reauthorize) await reauthorize();
    store.assertAttempt(ctx, attempt, enabled);
    const saved = await vault.compareAndSwap(ctx.profile, previous, value);
    await current(ctx, attempt.expected, enabled);
    if (reauthorize) await reauthorize();
    store.assertAttempt(ctx, attempt, enabled);
    const credential = credentialPublic(saved);
    const receipt = store.finish(ctx, attempt, { credential, account: boundAccount, appChanged });
    return { credential, receipt };
  }
  async function privateCredential(ctx: BlingContext, expected: BlingExpectedState) {
    if (ctx.origin !== "internal") throw new BlingError("BLING_ADMIN_REQUIRED");
    store.recoverExpired(ctx);
    const state = await current(ctx, expected);
    if (!state.credential.authorized || state.credential.uncertain || !state.account?.confirmed_at) throw new BlingError("BLING_AUTH_REQUIRED");
    const snapshot = await vault.read(ctx.profile);
    store.recoverExpired(ctx);
    const refreshedState = await current(ctx, expected);
    if (!refreshedState.credential.authorized || refreshedState.credential.uncertain || !refreshedState.account?.confirmed_at) throw new BlingError("BLING_AUTH_REQUIRED");
    if (snapshot.revision !== expected.credential_revision || snapshot.value.disconnected || !snapshot.value.credential) throw new BlingError("BLING_AUTH_REQUIRED");
    return validateCredential(snapshot.value.credential, deps.readScopes, ctx.clock.now());
  }
  const implementation: AuthorizationPort = {
    async publicState(ctx) {
      if (ctx.origin !== "internal") authorizeBlingOperation(ctx, "erp_bling_status", {});
      store.recoverExpired(ctx);
      return store.control(ctx).credential;
    },
    async saveApplication(ctx, rawInput) {
      let attempt: AuthAttempt | null = null;
      try {
        const input = parseBlingOperationInput("erp_bling_app_save", rawInput);
        await admin(ctx, "erp_bling_app_save", input);
        const requestHash = await oauthHash(JSON.stringify([ctx.profile, ctx.identity.actor!.user_id, ctx.identity.actor!.session_id, input]));
        const replay = store.receipt(ctx, input.command_id, requestHash);
        if (replay) {
          if (replay.state !== "committed") throw new BlingError("BLING_AUTH_REQUIRED");
          return { configured: true, revision: String(replay.references.configuration_revision), callback_url: callbackUrl(ctx), receipt: replay };
        }
        const state = store.control(ctx);
        if (state.expected.configuration_revision !== input.expected_revision) throw new BlingError("BLING_REVISION_CONFLICT");
        await current(ctx, state.expected, false);
        const start = store.begin(ctx, { command_id: input.command_id, request_hash: requestHash, operation: "erp_bling_app_save", kind: "oauth_exchange", expected: state.expected, lease: lease(ctx), allowDisabled: true });
        attempt = start.attempt;
        if (!attempt) throw new BlingError("BLING_COMMAND_CONFLICT");
        const previous = await vault.read(ctx.profile);
        await admin(ctx, "erp_bling_app_save", input);
        const result = await custody(ctx, attempt, previous, { revision: nextRevision(previous.revision), application: { client_id: input.client_id, client_secret: input.client_secret }, credential: null, disconnected: false }, state.account, false, true, () => admin(ctx, "erp_bling_app_save", input));
        return { configured: true, revision: String(result.receipt.references.configuration_revision), callback_url: callbackUrl(ctx), receipt: result.receipt };
      } catch (error) { if (attempt) store.fail(ctx, attempt, safeError(error).code, true); throw safeError(error); }
    },
    async authorize(ctx, rawInput) {
      try {
        const input = parseBlingOperationInput("erp_bling_oauth_start", rawInput);
        await admin(ctx, "erp_bling_oauth_start", input);
        const state = store.control(ctx);
        if (input.expected_revision !== state.expected.configuration_revision) throw new BlingError("BLING_REVISION_CONFLICT");
        await current(ctx, state.expected);
        evidence();
        if (!ctx.response) throw new BlingError("BLING_RESPONSE_INVALID");
        const snapshot = await vault.read(ctx.profile);
        await admin(ctx, "erp_bling_oauth_start", input);
        await current(ctx, state.expected);
        if (!state.credential.configured || !snapshot.value.application || snapshot.value.disconnected || Number(snapshot.revision) < Number(state.expected.credential_revision)) throw new BlingError("BLING_AUTH_REQUIRED");
        const stateValue = opaque(), nonce = opaque();
        const [stateHash, browserHash] = await Promise.all([oauthHash(stateValue), oauthHash(nonce)]);
        const expiresAt = ctx.clock.now() + 600000;
        store.reserveOAuth(ctx, { command_id: input.command_id, state_hash: stateHash, browser_hash: browserHash, session_id: ctx.identity.actor!.session_id!, actor_id: ctx.identity.actor!.user_id,
          config_revision: input.expected_revision, generation: state.expected.generation, expires_at: expiresAt }, callbackUrl(ctx));
        const url = new URL(authorizationEndpoint);
        url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", snapshot.value.application.client_id);
        url.searchParams.set("redirect_uri", callbackUrl(ctx)); url.searchParams.set("state", stateValue);
        if (deps.readScopes.length) url.searchParams.set("scope", deps.readScopes.join(" "));
        ctx.response.setCookie({ name: await blingOAuthCookieName(ctx.profile), value: nonce, max_age: 600 });
        return { authorization_url: url.href, expires_at: expiresAt };
      } catch (error) { throw safeError(error); }
    },
    reserveOAuth(ctx, input) { store.reserveOAuth(ctx, input, callbackUrl(ctx)); },
    consumeOAuth(ctx, input) { return store.consumeOAuth(ctx, input, callbackUrl(ctx)); },
    async callback(ctx, input: BlingCallbackInput) {
      let attempt: AuthAttempt | null = null, sent = false;
      try {
        if (input.callback_url !== callbackUrl(ctx) || !input.state || !input.browser_nonce || input.state.length > 4096 || input.browser_nonce.length > 4096) throw new BlingError("BLING_AUTH_REQUIRED");
        const actor = ctx.identity.actor;
        if (ctx.origin !== "app" || !actor?.session_id || actor.erp_role !== "admin") throw new BlingError("BLING_ADMIN_REQUIRED");
        // A confirmação do início foi vinculada ao comando; callback usa esse mesmo comando.
        const fresh = await deps.session(ctx);
        if (fresh.actor?.user_id !== actor.user_id || fresh.actor?.session_id !== actor.session_id || fresh.actor?.erp_role !== "admin" || fresh.actor?.is_agent !== actor.is_agent) throw new BlingError("BLING_ADMIN_REQUIRED");
        ctx.identity = fresh;
        const [stateHash, browserHash] = await Promise.all([oauthHash(input.state), oauthHash(input.browser_nonce)]);
        const reservation = store.consumeOAuth(ctx, { state_hash: stateHash, browser_hash: browserHash, session_id: actor.session_id }, callbackUrl(ctx));
        const commandInput = { command_id: reservation.command_id, expected_revision: reservation.config_revision };
        await admin(ctx, "erp_bling_oauth_start", commandInput);
        await current(ctx, reservation.expected);
        if (input.error) return { redirect: redirect(), state: "denied", clear_cookie: true };
        if (!input.code || input.code.length > 16384) throw new BlingError("BLING_AUTH_REQUIRED");
        evidence();
        const begin = store.begin(ctx, { command_id: `exchange:${stateHash}`, request_hash: stateHash, operation: "erp_bling_oauth_callback", kind: "oauth_exchange", expected: reservation.expected, lease: lease(ctx) });
        attempt = begin.attempt;
        if (!attempt) throw new BlingError("BLING_AUTH_REQUIRED");
        const previous = await vault.read(ctx.profile);
        if (!previous.value.application || previous.value.disconnected || Number(previous.revision) < Number(attempt.expected.credential_revision)) throw new BlingError("BLING_AUTH_REQUIRED");
        await current(ctx, attempt.expected); store.markFetching(ctx, attempt); sent = true;
        const credential = validateCredential(await deps.provider.exchange({ ...previous.value.application, code: input.code, callback_url: callbackUrl(ctx) }), deps.readScopes, ctx.clock.now());
        await current(ctx, attempt.expected); store.assertAttempt(ctx, attempt);
        const boundAccount = await account(ctx, credential);
        await admin(ctx, "erp_bling_oauth_start", commandInput);
        await custody(ctx, attempt, previous, { ...previous.value, revision: nextRevision(previous.revision), credential, disconnected: false }, boundAccount, true, false, () => admin(ctx, "erp_bling_oauth_start", commandInput));
        return { redirect: redirect(), state: "authorized", clear_cookie: true };
      } catch (error) {
        const failure = safeError(error);
        if (attempt) store.fail(ctx, attempt, failure.code, sent);
        return { redirect: redirect(), state: "unavailable", clear_cookie: true, error: failure.toJSON() };
      }
    },
    async renew(ctx, input) {
      let attempt: AuthAttempt | null = null, sent = false;
      try {
        if (ctx.origin !== "internal") throw new BlingError("BLING_ADMIN_REQUIRED");
        const command = `refresh:${await oauthHash(JSON.stringify([ctx.profile, input.expected, input.lease.owner, input.lease.fence]))}`;
        const requestHash = await oauthHash(command);
        const replay = store.receipt(ctx, command, requestHash);
        if (replay) {
          if (replay.state !== "committed") throw new BlingError("BLING_AUTH_REQUIRED");
          const state = store.control(ctx);
          if (!state.enabled || state.credential.revision !== replay.references.credential_revision) throw new BlingError("BLING_AUTH_REQUIRED");
          await current(ctx, state.expected);
          return state.credential;
        }
        await current(ctx, input.expected);
        const begin = store.begin(ctx, { command_id: command, request_hash: requestHash, operation: "erp_bling_oauth_refresh", kind: "oauth_refresh", expected: input.expected, lease: input.lease });
        attempt = begin.attempt;
        if (!attempt) throw new BlingError("BLING_AUTH_REQUIRED");
        const previous = await vault.read(ctx.profile);
        if (previous.revision !== input.expected.credential_revision || !previous.value.credential || previous.value.disconnected || store.control(ctx).credential.uncertain) throw new BlingError("BLING_AUTH_REQUIRED");
        await current(ctx, input.expected); store.markFetching(ctx, attempt); sent = true;
        const credential = validateCredential(await deps.provider.refresh(previous.value.credential), deps.readScopes, ctx.clock.now());
        const boundAccount = store.control(ctx).account;
        if (!boundAccount?.confirmed_at) throw new BlingError("BLING_AUTH_REQUIRED");
        return (await custody(ctx, attempt, previous, { ...previous.value, revision: nextRevision(previous.revision), credential }, boundAccount, true)).credential;
      } catch (error) { if (attempt) store.fail(ctx, attempt, safeError(error).code, sent); throw safeError(error); }
    },
    async custodyCas(ctx, input: BlingCredentialCas) {
      // Porta privada para a montagem; nunca expor como operação pública.
      if (ctx.origin !== "internal") throw new BlingError("BLING_ADMIN_REQUIRED");
      if (input.expected_revision !== input.expected.credential_revision) throw new BlingError("BLING_REVISION_CONFLICT");
      const command = `custody:${await oauthHash(JSON.stringify([input.expected, input.lease]))}`;
      const requestHash = await oauthHash(JSON.stringify([command, input.expected_revision, input.previous_ciphertext,
        input.credential?.client_id, input.credential?.client_secret, input.credential?.access_token, input.credential?.refresh_token,
        input.credential?.expires_at, input.credential?.scopes, input.account?.id, input.account?.name, input.account?.confirmed_at]));
      const begin = store.begin(ctx, { command_id: command, request_hash: requestHash, operation: "erp_bling_oauth_callback", kind: "oauth_exchange", expected: input.expected, lease: input.lease });
      if (!begin.attempt) {
        const state = store.control(ctx);
        if (begin.receipt?.state !== "committed" || state.credential.revision !== begin.receipt.references.credential_revision) throw new BlingError("BLING_AUTH_REQUIRED");
        await current(ctx, state.expected);
        return state.credential;
      }
      try {
        const previous = await vault.read(ctx.profile);
        if (previous.revision !== input.expected_revision || previous.ciphertext !== input.previous_ciphertext || !input.credential || !input.account?.confirmed_at) throw new BlingError("BLING_REVISION_CONFLICT");
        const credential = validateCredential(input.credential, deps.readScopes, ctx.clock.now());
        await current(ctx, input.expected); store.markFetching(ctx, begin.attempt);
        const boundAccount = await account(ctx, credential);
        if (boundAccount.id !== input.account.id) throw new BlingError("BLING_ACCOUNT_MISMATCH");
        return (await custody(ctx, begin.attempt, previous, { ...previous.value, revision: nextRevision(previous.revision), credential }, boundAccount, true)).credential;
      }
      catch (error) { store.fail(ctx, begin.attempt, safeError(error).code, true); throw safeError(error); }
    },
    privateCredential,
    async disconnect(ctx, expected) {
      try {
        // A operação pública já vincula confirmação/recibo ao comando. Esta porta
        // recebe apenas expected; usa o comando autenticado da confirmação, se houver.
        const commandId = ctx.authorization?.confirmation?.command_id;
        await admin(ctx, "erp_bling_disconnect", { command_id: commandId });
        const state = store.control(ctx);
        // credential_status=disconnected é a intenção durável. Uma queda antes
        // do tombstone pode retomar com o expected original, sem nova revisão.
        const retry = state.disconnected && state.expected.generation === expected.generation && state.expected.account_id === expected.account_id &&
          state.expected.authorization_revision === nextRevision(expected.authorization_revision) && state.expected.configuration_revision === nextRevision(expected.configuration_revision);
        await current(ctx, retry ? state.expected : expected, false);
        const invalidated = retry ? state : store.invalidate(ctx, expected);
        for (let remaining = 3; remaining > 0; remaining--) {
          const previous = await vault.read(ctx.profile);
          if (store.control(ctx).expected.authorization_revision !== invalidated.expected.authorization_revision) throw new BlingError("BLING_REVISION_CONFLICT");
          try {
            const saved = await vault.compareAndSwap(ctx.profile, previous, { revision: nextRevision(previous.revision), application: null, credential: null, disconnected: true });
            store.finalizeDisconnect(ctx, invalidated.expected.authorization_revision, saved.revision);
            return credentialPublic(saved);
          } catch (error) { if (!(error instanceof BlingError) || error.code !== "BLING_REVISION_CONFLICT" || remaining === 1) throw error; }
        }
        throw new BlingError("BLING_REVISION_CONFLICT");
      } catch (error) { throw safeError(error); }
    },
  };
  // A porta inteira saneia falhas de cofre, sessão, prova de conta e driver;
  // consumidores internos também nunca recebem exceção remota ou SQL bruto.
  return Object.fromEntries(Object.entries(implementation).map(([key, method]) => [key, (...args: unknown[]) => {
    try {
      const result = Reflect.apply(method, undefined, args);
      return result instanceof Promise ? result.catch(error => { throw safeError(error); }) : result;
    } catch (error) { throw safeError(error); }
  }])) as unknown as AuthorizationPort;
}

/** Desligar é operação de control.ts: não apaga acervo/cofre. Revogar é ato no provedor. */
export const BLING_REVOCATION_GUIDANCE = "A desconexão remove as credenciais desta instalação e preserva o acervo. Para revogar o acesso no Bling, remova a autorização do aplicativo na sua conta.";
