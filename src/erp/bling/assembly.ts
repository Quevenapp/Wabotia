// Montagem da coleta no Coordinator. Importar o módulo não executa I/O.
import type { Actor, Env } from "../../types.ts";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { readErpPartsSnapshot, type ErpPartsSnapshot, type ErpParts } from "../parts.ts";
import { BLING_ENTITIES, BLING_ERROR_CODES, BlingError, type BlingContext, type BlingOperationName, type BlingExpectedState, type ResourceDescriptor } from "./contracts.ts";
import type { AuthorizationPort, CollectionStore, ArchivePort, BlingApiPort, BlingWakePort, BlingDataPort } from "./ports.ts";
import { BLING_OPERATIONS, BlingAuthorizationContextSchema, getBlingOperation, parseBlingOperationInput, xmlDownloadSchema } from "./schema.ts";

import { storageDriver, type SqlDriver } from "../engine/driver.ts";
import { BlingAuthStore } from "./auth-store.ts";
import { createBlingAuthorization, createBlingOAuthProvider, blingCallbackUrl, blingOAuthCookieName, type BlingAccountProof } from "./oauth.ts";
import { createBlingVault, type BlingVault } from "./vault.ts";
import { createCollectionStore } from "./repository.ts";
import { createBlingDataClient, sha256Bytes } from "./client.ts";
import { createBlingWake, createBlingArchiveWake } from "./wake.ts";
import { createXmlArchive, type BlingXmlMedia } from "./xml.ts";
import { createArchivePurge } from "./purge.ts";
import { createArchive } from "./archive.ts";
import { createBlingApi } from "./operations.ts";
import { createBlingControl } from "./control.ts";
import { assertBlingIdentity, authorizeOperation } from "./permissions.ts";
import { BLING_RESOURCES, BLING_XML_RESOURCE, BLING_RESOURCE_VERSION } from "./resources.ts";
import { handlePublicBlingCallback } from "./routes.ts";
import type { BlingOAuthProvider } from "./ports.ts";

export const BLING_AUTHORIZATION_HEADER = "x-erp-bling-authorization";
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const requestHash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export interface BlingAssemblyDependencies {
  env: Env;
  storage: DurableObjectStorage;
  readParts: () => Promise<Readonly<ErpParts> | null>;
  readSnapshot?: () => Promise<ErpPartsSnapshot | null>;
  profile?: string;
}
export interface BlingDispatch {
  context: BlingContext;
  name: BlingOperationName;
  input: ReturnType<typeof parseBlingOperationInput>;
}
class BoundaryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
const idle = () => ({ worked: false, nextWake: null, requests: 0 as const });
export interface BlingAssembly {
  authorization: AuthorizationPort;
  collection: CollectionStore;
  archive: ArchivePort;
  api: BlingApiPort;
  wake: BlingWakePort;
  data: BlingDataPort;
}
/** Somente meios externos são injetados. Todas as portas de negócio são reais. */
export interface MountedBlingOptions {
  profile: string;
  db: SqlDriver;
  databaseSize(): number;
  readParts(): Promise<ErpPartsSnapshot | null>;
  session(ctx: BlingContext): Promise<IdentityPort>;
  vault: BlingVault;
  provider: BlingOAuthProvider;
  accountProof: BlingAccountProof;
  publicOrigin: string;
  authorizationEndpoint: string;
  readScopes: readonly string[];
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  media: BlingXmlMedia & { delete(key: string): Promise<unknown> };
  resources?: readonly ResourceDescriptor[];
  baseUrl?: string;
  randomId?(): string;
}
export function createMountedBlingAssembly(options: MountedBlingOptions): BlingAssembly {
  const { db, profile } = options;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const resources = options.resources ?? [...BLING_RESOURCES, BLING_XML_RESOURCE];
  const hash = sha256Bytes;
  async function requireBase(ctx: BlingContext) {
    if (ctx.profile !== profile) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    const snapshot = readErpPartsSnapshot(await options.readParts(), profile, ctx.clock.now());
    if (!snapshot?.parts.customers) throw new BlingError("BLING_DISABLED");
    const { parts, ...partsControl } = snapshot;
    ctx.identity = { ...ctx.identity, parts, partsControl };
  }
  async function revalidate(ctx: BlingContext, expected: BlingExpectedState) {
    await requireBase(ctx);
    if (ctx.identity.partsControl!.revision !== expected.parts_revision) throw new BlingError("BLING_REVISION_CONFLICT");
    // OAuth também opera desligado/sem conta. Cada store confere aprovação,
    // seleção, conta e revisões adequadas à sua fase.
  }
  const authorization = createBlingAuthorization({ store: new BlingAuthStore(db, profile), vault: options.vault,
    provider: options.provider, accountProof: options.accountProof, publicOrigin: options.publicOrigin,
    authorizationEndpoint: options.authorizationEndpoint, readScopes: options.readScopes, session: options.session, revalidate });
  const control = createBlingControl({ db, profile, databaseSize: options.databaseSize, randomId });
  const xml = createXmlArchive({ db, profile, media: options.media, hash, randomId, revalidate,
    requireRead(ctx, operation, input) {
      const effective = authorizeOperation(ctx, operation, input as never, control.configuration(ctx), ctx.authorization?.request_hash ?? "0".repeat(64));
      ctx.authorization = effective.authorization;
    } });
  const purge = createArchivePurge({ db, profile, media: options.media, randomId, requireBase });
  const archive = createArchive({ db, profile, xml, purge });
  const collection = createCollectionStore({ db, randomId, databaseSize: options.databaseSize });
  const data = createBlingDataClient({ fetch: options.fetch, authorization, resources, baseUrl: options.baseUrl,
    revalidate: async (ctx, expected) => { await revalidate(ctx, expected); collection.assertExpected(ctx, expected); } });
  const deps = { db, profile, collection, data, authorization, archive, readParts: options.readParts, revalidate,
    randomId, hash, resources, databaseSize: options.databaseSize };
  const archiveWake = createBlingArchiveWake({ ...deps, xml, purge, media: options.media });
  const wake = createBlingWake({ ...deps, archiveWake });
  const api = createBlingApi(deps, { profile, resources, resource_version: BLING_RESOURCE_VERSION,
    callback_url: options.publicOrigin ? blingCallbackUrl(options.publicOrigin, profile) : undefined,
    session: options.session, beforeApplicationSave: authorization.recoverRestoredApplication });
  return { authorization, collection, archive, data, wake, api };
}

async function installationOrigin(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM instance_settings WHERE key='public_origin'").first<{ value: string }>();
  return row?.value ?? "";
}
/** Revalidação privada por id público da sessão; nenhum bearer entra no ERP. */
async function currentSession(env: Env, ctx: BlingContext): Promise<IdentityPort> {
  const person = ctx.identity.actor;
  if (!person?.session_id) throw new BlingError("BLING_ADMIN_REQUIRED");
  const [{ actorForUser, canProfile }, { erpIdentity }, { sessionAal, requireSchedule }] = await Promise.all([
    import("../../security"), import("../../modules/erp/identity"), import("../../mfa")]);
  const row = await env.DB.prepare("SELECT s.kind,s.aal,s.mfa_at,u.role,u.schedule FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires>? AND u.disabled=0")
    .bind(person.session_id, person.user_id, ctx.clock.now()).first<{ kind: string; aal: number; mfa_at: number; role: string; schedule: unknown }>();
  const actor = row && await actorForUser(env, person.user_id);
  if (!row || !actor || !canProfile(actor, ctx.profile)) throw new BlingError("BLING_ADMIN_REQUIRED");
  requireSchedule(row);
  actor.sessionId = person.session_id; actor.aal = sessionAal(row.kind, row.aal, row.mfa_at, ctx.clock.now());
  if (person.is_agent && ctx.authorization?.bot) actor.via = { bot_id: ctx.authorization.bot.id, kind: "bot", run_id: "bling-session", masked: true };
  return erpIdentity(env, actor, ctx.profile, "POST");
}
/** Produção usa apenas D1/R2 já existentes e o SQLite da mesma área. */
export async function createBlingAssembly(dependencies?: BlingAssemblyDependencies): Promise<BlingAssembly> {
  if (!dependencies?.profile || !dependencies.readSnapshot) throw new BlingError("BLING_DISABLED", { status: 503 });
  const { env, storage, profile } = dependencies;
  const publicOrigin = await installationOrigin(env);
  const readScopes: string[] = [];
  // Identidade e escopos oficiais ainda não foram conferidos. Não há endpoint
  // presumido de empresa, nem seleção capaz de contornar esta pendência.
  const accountProof: BlingAccountProof = { evidence: null, async identify() { throw new BlingError("BLING_RESOURCE_UNCONFIRMED"); } };
  return createMountedBlingAssembly({ profile, db: storageDriver(storage), databaseSize: () => storage.sql.databaseSize,
    readParts: dependencies.readSnapshot, session: ctx => currentSession(env, ctx), vault: createBlingVault(env),
    provider: createBlingOAuthProvider({ tokenEndpoint: "https://www.bling.com.br/Api/v3/oauth/token", fetch, clock: { now: () => Date.now() }, readScopes }),
    publicOrigin, authorizationEndpoint: "https://www.bling.com.br/Api/v3/oauth/authorize", readScopes, accountProof,
    fetch: (input, init) => fetch(input, init), media: env.MEDIA });
}

/** Falhas públicas são enumeradas; exceção, URL e corpo remotos nunca saem. */
export function blingFailureResponse(error: unknown): Response {
  if (error instanceof BoundaryError)
    return Response.json({ error: { code: error.code, message: error.status === 404 ? "Operação não encontrada." : "Entrada da operação inválida." } }, { status: error.status, headers: privateHeaders });
  const failure = error instanceof BlingError && BLING_ERROR_CODES.includes(error.code)
    ? new BlingError(error.code, { status: [403, 409, 503].includes(error.status) ? error.status : 503, retry_at: error.retry_at })
    : new BlingError("BLING_RESPONSE_INVALID", { status: 503 });
  return Response.json({ error: { code: failure.code, message: failure.message,
    ...(failure.retry_at === undefined ? {} : { retry_at: failure.retry_at }) } }, { status: failure.status, headers: privateHeaders });
}

/** Identidade antes do motor; concessões de leitura/bot só após ler política. */
function boundaryAuthorization(ctx: BlingContext, name: BlingOperationName) {
  assertBlingIdentity(ctx);
  if (BLING_OPERATIONS[name].permission !== "archive_read" && ctx.identity.actor?.erp_role !== "admin") throw new BlingError("BLING_ADMIN_REQUIRED");
}

/** Só o Worker monta a autoridade; nenhum cabeçalho do navegador é repassado. */
export async function prepareBlingDispatch(profile: string, path: string, request: Request, identity: IdentityPort): Promise<BlingDispatch> {
  const match = /^\/erp-bling\/operations\/(erp_bling_[a-z_]+)$/.exec(path);
  const operation = path === "/erp-bling/callback" ? getBlingOperation("erp_bling_oauth_callback") : match && getBlingOperation(match[1]);
  if (!operation || operation.name === "erp_bling_oauth_callback" && path !== "/erp-bling/callback") throw new BoundaryError(404, "not_found");
  if (request.method !== "POST") throw new BoundaryError(405, "method_not_allowed");
  const header = request.headers.get(BLING_AUTHORIZATION_HEADER);
  let authorization;
  try {
    if (header) {
      if (header.length > 16_384) throw new Error();
      authorization = BlingAuthorizationContextSchema.parse(JSON.parse(header));
    }
  } catch { throw new BoundaryError(403, "BLING_ADMIN_REQUIRED"); }
  const context: BlingContext = { profile, identity, origin: "app", clock: { now: () => Date.now() }, authorization };
  let raw: unknown;
  try { raw = await request.json(); } catch { throw new BoundaryError(400, "BLING_RESPONSE_INVALID"); }
  if (authorization?.request_hash && authorization.request_hash !== await requestHash(raw)) throw new BlingError("BLING_COMMAND_CONFLICT");
  // A autorização precede a validação de campos: a recusa não expõe entradas.
  boundaryAuthorization(context, operation.name);
  const input = parseBlingOperationInput(operation.name, raw);
  return { context, name: operation.name, input };
}

export async function handleBlingOperation(call: BlingDispatch, dependencies: BlingAssemblyDependencies, api?: BlingApiPort): Promise<Response> {
  try {
    if (!(await dependencies.readParts())?.customers) throw new BlingError("BLING_DISABLED");
    boundaryAuthorization(call.context, call.name);
    api ??= (await createBlingAssembly({ ...dependencies, profile: call.context.profile })).api;
    const input = parseBlingOperationInput(call.name, call.input);
    const cookies: string[] = [];
    const operationContext = { ...call.context, response: { setCookie(cookie) {
      if (call.name !== "erp_bling_oauth_start" || !/^__Host-[A-Za-z0-9_-]{1,100}$/.test(cookie.name) ||
          !/^[A-Za-z0-9_.-]{1,4096}$/.test(cookie.value) || !Number.isSafeInteger(cookie.max_age) ||
          cookie.max_age < 0 || cookie.max_age > 600 || cookies.length) throw new BlingError("BLING_RESPONSE_INVALID");
      cookies.push(`${cookie.name}=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie.max_age}`);
    } } } satisfies BlingContext;
    const result = call.name === "erp_bling_oauth_callback" ? await api.callback(operationContext, input as never) : await api.execute(operationContext, call.name, input as never);
    if (!(await dependencies.readParts())?.customers) throw new BlingError("BLING_DISABLED");
    // Inclui saída em esquema: o adaptador não pode devolver campos secretos.
    const output = getBlingOperation(call.name)!.output.parse(result);
    if (call.name === "erp_bling_xml_get") {
      const xml = xmlDownloadSchema.parse(output);
      return new Response(new Uint8Array(xml.bytes).buffer, { headers: { ...privateHeaders,
        "Content-Type": xml.content_type, "Content-Disposition": `attachment; filename="${xml.filename}"`, "X-Content-SHA256": xml.sha256 } });
    }
    const headers = new Headers(privateHeaders);
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return Response.json(output, { headers });
  } catch (error) { return blingFailureResponse(error); }
}

/** O retorno autentica a sessão do núcleo e encaminha só à área correspondente. */
export async function handleBlingCallback(env: Env, profile: string, request: Request): Promise<Response> {
  try {
    const [{ authenticate, canProfile }, { erpIdentity }, { erpFetch }] = await Promise.all([
      import("../../security"), import("../../modules/erp/identity"), import("../hub.ts")]);
    const actor = await authenticate(env, request, profile);
    if (!canProfile(actor, profile)) throw new BlingError("BLING_ADMIN_REQUIRED");
    const identity = await erpIdentity(env, actor, profile, "POST");
    const publicOrigin = await installationOrigin(env);
    const ctx: BlingContext = { profile, identity, origin: "app", clock: { now: () => Date.now() } };
    return await handlePublicBlingCallback(request, ctx, {
      async execute() { throw new BlingError("BLING_SCOPE_REQUIRED"); },
      async callback(_ctx, input) {
        const response = await erpFetch(env, profile, "/erp-bling/callback", { method: "POST",
          headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity) }, body: JSON.stringify(input) });
        if (!response.ok) { const body = await response.json<{ error?: { code?: string } }>();
          throw new BlingError(BLING_ERROR_CODES.includes(body.error?.code as never) ? body.error!.code as typeof BLING_ERROR_CODES[number] : "BLING_AUTH_REQUIRED"); }
        return response.json();
      },
    }, { callback_url: blingCallbackUrl(publicOrigin, profile), cookie_name: await blingOAuthCookieName(profile) });
  } catch (error) { return blingFailureResponse(error); }
}

/** Sem trabalho durável, o alarme não lê D1 nem monta clientes externos. */
function hasBlingWork(dependencies: BlingAssemblyDependencies): boolean {
  if (!dependencies.readSnapshot) throw new BlingError("BLING_DISABLED", { status: 503 });
  return dependencies.storage.sql.exec(`SELECT 1 AS pending WHERE
    EXISTS(SELECT 1 FROM wb_bling_control WHERE id=1 AND collect_enabled=1 AND state<>'blocked_capacity') OR
    EXISTS(SELECT 1 FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded','blocked')
      AND (kind IN ('purge','r2_delete') OR resource='fiscal_xml')) OR
    EXISTS(SELECT 1 FROM wb_bling_unit u WHERE resource='fiscal_xml' AND phase='superseded'
      AND json_array_length(json_extract(progress,'$.xml.documents'))>0
      AND NOT EXISTS(SELECT 1 FROM wb_bling_unit d WHERE d.kind='r2_delete' AND json_extract(d.plan,'$.orphan_work_id')=u.id)) LIMIT 1`).toArray().length > 0;
}

async function mountedWake(dependencies: BlingAssemblyDependencies, profile: string, milliseconds: number): Promise<BlingWakePort> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      createBlingAssembly({ ...dependencies, profile }).then(assembly => assembly.wake),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BlingError("BLING_RETRY_WAIT")), Math.max(1, milliseconds)); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Consulta barata para adiar a coleta quando esta acordada já operou o ERP. */
export async function nextBlingWake(profile: string, dependencies: BlingAssemblyDependencies, notBefore: number, clock = { now: () => Date.now() }, wake?: BlingWakePort): Promise<number | null> {
  if (!(await dependencies.readParts())?.customers) return null;
  if (!wake && !hasBlingWork(dependencies)) return null;
  wake ??= await mountedWake(dependencies, profile, 1000);
  const due = await wake.nextWake({ profile, clock, identity: { actor: null, people: null }, origin: "internal" });
  return due === null ? null : Math.max(notBefore, due);
}

/** Orçamento da costura; HTTP e transação continuarão nas portas próprias. */
export async function runBlingWake(profile: string, dependencies: BlingAssemblyDependencies, options: {
  eligible: boolean;
  nextOperationalAt: number | null;
  clock: { now(): number };
}, wake?: BlingWakePort) {
  const started = options.clock.now();
  const deadline = Math.min(started + 4_000, options.nextOperationalAt === null ? Infinity : options.nextOperationalAt - 250);
  if (!(await dependencies.readParts())?.customers) return idle();
  const context: BlingContext = { profile, clock: options.clock, identity: { actor: null, people: null }, origin: "internal" };
  if (!wake && !hasBlingWork(dependencies)) return idle();
  if (deadline - options.clock.now() < 1000) return { ...idle(), nextWake: options.clock.now() + 1000 };
  wake ??= await mountedWake(dependencies, profile, Math.min(1000, deadline - options.clock.now()));
  const due = await wake.nextWake(context);
  if (due === null) return idle();
  const now = options.clock.now();
  if (!options.eligible) return { ...idle(), nextWake: Math.max(due, now + 1_000) };
  if (due > now) return { ...idle(), nextWake: due };
  if (deadline - now < 1_000) return { ...idle(), nextWake: now + 1_000 };
  if (!(await dependencies.readParts())?.customers) return idle();
  const result = await wake.runOne(context, { deadline, nextOperationalAt: options.nextOperationalAt, maxGets: 1 });
  if (!(await dependencies.readParts())?.customers) return idle();
  return result;
}

/** Correspondência exata de método/caminho, derivada do descritor único. */
export function matchBlingOperation(method: string, pathname: string) {
  if (pathname !== "/v1/receber-bling" && !pathname.startsWith("/v1/receber-bling/")) return null;
  const relative = pathname.replace(/^\/v1\/receber-bling/, "") || "/";
  for (const operation of Object.values(BLING_OPERATIONS)) {
    if (operation.name === "erp_bling_oauth_callback" || operation.method !== method) continue;
    const keys: string[] = [];
    const pattern = operation.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, key => { keys.push(key.slice(1)); return "([^/]+)"; });
    const match = new RegExp(`^${pattern}/?$`).exec(relative);
    if (!match) continue;
    try { return { operation, params: Object.fromEntries(keys.map((key, i) => [key === "objectId" ? "object_id" : key, decodeURIComponent(match[i + 1])])) }; }
    catch { throw new BoundaryError(400, "BLING_RESPONSE_INVALID"); }
  }
  return null;
}

export async function forwardBlingOperation(env: Env, profile: string, actor: Actor, identity: IdentityPort, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/erp`;
    if (!url.pathname.startsWith(prefix + "/")) throw new BoundaryError(404, "not_found");
    const match = matchBlingOperation(request.method, url.pathname.slice(prefix.length));
    if (!match) throw new BoundaryError(404, "not_found");
    let raw: unknown;
    try { raw = request.method === "GET" ? { ...Object.fromEntries(url.searchParams), ...match.params } : await request.json(); }
    catch { throw new BoundaryError(400, "BLING_RESPONSE_INVALID"); }
    if (request.method === "GET") {
      const values = raw as Record<string, unknown>;
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw new BoundaryError(400, "BLING_RESPONSE_INVALID");
      if (values.limit !== undefined) {
        if (typeof values.limit !== "string" || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(values.limit)) throw new BoundaryError(400, "BLING_RESPONSE_INVALID");
        values.limit = Number(values.limit);
      }
      if (values.deleted !== undefined) {
        if (values.deleted !== "true" && values.deleted !== "false") throw new BoundaryError(400, "BLING_RESPONSE_INVALID");
        values.deleted = values.deleted === "true";
      }
    }
    const context: BlingContext = { profile, identity, origin: actor.kind === "user" || actor.kind === "app" && !actor.id.startsWith("bot:") && !actor.scopes.includes("conversations:bound") ? "app" : "external", clock: { now: () => Date.now() } };
    // actor.via é produzido pelo núcleo após aplicar pessoa ∩ bot. O envelope
    // permite somente esta operação; a instância cruza cada campo com a política
    // persistida da área antes de consultar qualquer dado ou efetuar comando.
    if (actor.kind === "user" && actor.via) context.authorization = { bot: {
      id: actor.via.bot_id, allowed_operations: [match.operation.name], allowed_entities: [...BLING_ENTITIES],
      data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: !actor.via.proposal_id,
    } };
    // A confirmação foi validada pelo núcleo e é limitada ao comando exato.
    // Leituras de dados por IA ainda exigem concessões persistentes próprias.
    if (actor.kind === "user" && actor.via?.proposal_id && match.operation.permission === "admin" && raw && typeof raw === "object" &&
        ("command_id" in raw || match.operation.name === "erp_bling_purge_preview")) {
      raw = parseBlingOperationInput(match.operation.name, raw);
      const hash = await requestHash(raw);
      context.authorization = { request_hash: hash,
        bot: { id: actor.via.bot_id, allowed_operations: [match.operation.name], allowed_entities: [...BLING_ENTITIES], data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: false },
        confirmation: { operation: match.operation.name, command_id: match.operation.name === "erp_bling_purge_preview" ? hash : String((raw as { command_id: string }).command_id),
          request_hash: hash, confirmed_by: actor.id, expires_at: context.clock.now() + 60_000 } };
    }
    boundaryAuthorization(context, match.operation.name);
    const input = parseBlingOperationInput(match.operation.name, raw);
    const { erpFetch } = await import("../hub.ts");
    return await erpFetch(env, profile, `/erp-bling/operations/${match.operation.name}`, {
      method: "POST", headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity),
        ...(context.authorization ? { [BLING_AUTHORIZATION_HEADER]: JSON.stringify(context.authorization) } : {}) },
      body: JSON.stringify(input),
    });
  } catch (error) { return blingFailureResponse(error); }
}
