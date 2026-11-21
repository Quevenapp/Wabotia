// Montagem da coleta no Coordinator. Importar o módulo não executa I/O.
import type { Actor, Env } from "../../types.ts";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { readErpPartsSnapshot, type ErpPartsSnapshot, type ErpParts } from "../parts.ts";
import { BLING_ENTITIES, BLING_ERROR_CODES, BlingError, type BlingContext, type BlingOperationName, type BlingExpectedState, type ResourceDescriptor } from "./contracts.ts";
import type { AuthorizationPort, CollectionStore, ArchivePort, BlingApiPort, BlingWakePort, BlingDataPort } from "./ports.ts";
import { BLING_OPERATIONS, BLING_RECEIPTED_OPERATIONS, BlingAuthorizationContextSchema, getBlingOperation, parseBlingOperationInput, xmlDownloadSchema } from "./schema.ts";

import { storageDriver, type SqlDriver } from "../engine/driver.ts";
import { BlingAuthStore } from "./auth-store.ts";
import { createBlingAuthorization, createBlingOAuthProvider, blingCallbackUrl, blingOAuthCookieName, type BlingAccountProof } from "./oauth.ts";
import { createBlingVault, type BlingVault } from "./vault.ts";
import { createCollectionStore } from "./repository.ts";
import { createBlingDataClient, sha256Bytes } from "./client.ts";
import { createBlingWriter } from "./writer.ts";
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
// Contrato leve; o motor da adoção (domínios do ERP) só entra por import dinâmico.
import { adoptionAuthorizationSchema, BlingAdoptionError, getAdoptionOperation, matchAdoptionRoute, parseAdoptionInput, type BlingAdoptionAuthorization, type BlingAdoptionOperationName } from "./adoption-contracts.ts";
import type { AdoptionDispatch } from "./adoption-api.ts";

function adoptionFailure(error: unknown): Response {
  const failure = error instanceof BlingAdoptionError ? error : new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE");
  return Response.json({ error: failure.toJSON() }, { status: failure.status, headers: privateHeaders });
}
/** Há lote de adoção em andamento? Sem tabela (esquema antigo), não há. */
function adoptionPending(storage: DurableObjectStorage): boolean {
  try {
    if (storage.sql.exec("SELECT 1 AS pending FROM wb_bling_adoption_job WHERE id=1 AND state='running'").toArray().length > 0) return true;
  } catch { return false; }
  // Fatia C: pacote do contador em montagem (tabela da versão 15).
  try { return storage.sql.exec("SELECT 1 AS pending FROM wb_bling_cutover_item WHERE kind='package' AND state='running' LIMIT 1").toArray().length > 0; }
  catch { return false; }
}
/** Mão dupla (versão 19): próxima varredura local, com algum interruptor ligado e o corte confirmado. Sem tabela, null. */
function twoWayScanAt(storage: DurableObjectStorage): number | null {
  try {
    const row = storage.sql.exec(`SELECT coalesce((SELECT CAST(json_extract(scan,'$.next_at') AS INTEGER) FROM wb_bling_twoway WHERE id=1), 0) AS next_at
      WHERE EXISTS(SELECT 1 FROM wb_bling_twoway_setting WHERE enabled=1) AND EXISTS(SELECT 1 FROM wb_bling_cutover WHERE id=1)`).toArray()[0] as { next_at?: number } | undefined;
    return row ? Number(row.next_at ?? 0) : null;
  } catch { return null; }
}
/** Mão dupla: próximo envio ou conferência da fila de saída. Desligado, pendente não conta. */
function twoWayOutboxAt(storage: DurableObjectStorage): number | null {
  try {
    const row = storage.sql.exec(`SELECT min(o.not_before) AS due FROM wb_bling_twoway_outbox o WHERE o.state IN ('sending','uncertain')
      OR (o.state='pending' AND EXISTS(SELECT 1 FROM wb_bling_twoway_setting s WHERE s.entity=o.entity AND s.direction='outbound' AND s.enabled=1))`).toArray()[0] as { due?: number | null } | undefined;
    return row?.due == null ? null : Number(row.due);
  } catch { return null; }
}
/** Ritmo da coleta contínua configurado na mão dupla (ms). Sem linha ou sem tabela, null (padrão de 15 min). */
function twoWayPace(db: SqlDriver): number | null {
  try { const row = db.exec("SELECT pace_minutes FROM wb_bling_twoway WHERE id=1").rows[0]; return row ? Number(row.pace_minutes) * 60_000 : null; }
  catch { return null; }
}
const earliest = (...values: (number | null | undefined)[]) => { const list = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)); return list.length ? Math.min(...list) : null; };

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
  name: BlingOperationName | BlingAdoptionOperationName;
  input: ReturnType<typeof parseBlingOperationInput> | unknown;
  /** Adoção dos cadastros (fatia B1): despacho próprio, sem montar a coleta. */
  adoption?: AdoptionDispatch;
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
  /** Mão dupla: um envio ou uma conferência da fila de saída (uma chamada HTTP). */
  twoWay(ctx: BlingContext, deadline: number): Promise<{ worked: boolean; nextWake: number | null; requests: 0 | 1 }>;
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
  const wake = createBlingWake({ ...deps, archiveWake, pace: () => twoWayPace(db) });
  const api = createBlingApi(deps, { profile, resources, resource_version: BLING_RESOURCE_VERSION,
    callback_url: options.publicOrigin ? blingCallbackUrl(options.publicOrigin, profile) : undefined,
    session: options.session, beforeApplicationSave: authorization.recoverRestoredApplication });
  // Escrita de volta: o token sai do cofre na hora, conferido contra o estado da conta.
  const authStore = new BlingAuthStore(db, profile);
  const writer = createBlingWriter({ fetch: options.fetch, baseUrl: options.baseUrl, async accessToken(ctx) {
    await requireBase(ctx);
    const expected = authStore.control(ctx).expected;
    return (await authorization.privateCredential(ctx, expected)).access_token;
  } });
  async function twoWay(ctx: BlingContext, deadline: number) {
    await requireBase(ctx);
    const { runTwoWayOutboundUnit } = await import("./two-way.ts");
    return runTwoWayOutboundUnit({ db, profile, now: ctx.clock.now, parts: ctx.identity.parts!, writer, ctx, deadline });
  }
  return { authorization, collection, archive, data, wake, api, twoWay };
}

async function installationOrigin(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM instance_settings WHERE key='public_origin'").first<{ value: string }>();
  return row?.value ?? "";
}
/** Revalidação privada por id público da sessão; nenhum bearer entra no ERP. */
async function currentSession(env: Env, ctx: BlingContext): Promise<IdentityPort> {
  const person = ctx.identity.actor;
  const delegation = ctx.authorization?.delegation;
  const team = person?.is_agent && delegation && ctx.authorization?.bot;
  if (!person || !person.session_id && !team) throw new BlingError("BLING_ADMIN_REQUIRED");
  const [{ actorForUser, canProfile }, { erpIdentity }, { sessionAal, requireSchedule }, { erpBotDelegation }] = await Promise.all([
    import("../../security"), import("../../modules/erp/identity"), import("../../mfa"), import("../../modules/erp/bot-access.ts")]);
  const row = person.session_id
    ? await env.DB.prepare("SELECT s.kind,s.aal,s.mfa_at,u.role,u.schedule FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.expires>? AND u.disabled=0")
      .bind(person.session_id, person.user_id, ctx.clock.now()).first<{ kind: string; aal: number; mfa_at: number; role: string; schedule: unknown }>()
    : await env.DB.prepare("SELECT role,schedule FROM users WHERE id=? AND disabled=0").bind(person.user_id)
      .first<{ kind: string; aal: number; mfa_at: number; role: string; schedule: unknown }>();
  const actor = row && await actorForUser(env, person.user_id);
  if (!row || !actor || !canProfile(actor, ctx.profile)) throw new BlingError("BLING_ADMIN_REQUIRED");
  requireSchedule(row);
  if (person.session_id) {
    actor.sessionId = person.session_id; actor.aal = sessionAal(row.kind, row.aal, row.mfa_at, ctx.clock.now());
  }
  if (person.is_agent) {
    if (!delegation || !ctx.authorization?.bot) throw new BlingError("BLING_SCOPE_REQUIRED");
    actor.via = { bot_id: ctx.authorization.bot.id, kind: "bot", run_id: delegation.run_id, proposal_id: delegation.proposal_id, masked: true };
    if (delegation.proposal_id && !await erpBotDelegation(env, actor, ctx.profile, delegation.method, delegation.path))
      throw new BlingError("BLING_SCOPE_REQUIRED");
  }
  return erpIdentity(env, actor, ctx.profile, delegation?.method ?? "POST", delegation?.path);
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
  if (error instanceof BlingAdoptionError) return adoptionFailure(error);
  if (error instanceof BoundaryError)
    return Response.json({ error: { code: error.code, message: error.status === 404 ? "Operação não encontrada." : "Entrada da operação inválida." } }, { status: error.status, headers: privateHeaders });
  const failure = error instanceof BlingError && BLING_ERROR_CODES.includes(error.code)
    ? new BlingError(error.code, { status: [403, 409, 503].includes(error.status) ? error.status : 503, retry_at: error.retry_at })
    : new BlingError("BLING_RESPONSE_INVALID", { status: 503 });
  return Response.json({ error: { code: failure.code, message: failure.message,
    ...(failure.retry_at === undefined ? {} : { retry_at: failure.retry_at }) } }, { status: failure.status, headers: privateHeaders });
}

/** Identidade antes do motor; concessões de leitura/bot só após ler política. */
const isAdoptionName = (name: string): name is BlingAdoptionOperationName => getAdoptionOperation(name) !== null;
function boundaryAuthorization(ctx: BlingContext, name: BlingOperationName) {
  assertBlingIdentity(ctx);
  if (BLING_OPERATIONS[name].permission !== "archive_read" && ctx.identity.actor?.erp_role !== "admin") throw new BlingError("BLING_ADMIN_REQUIRED");
}

/** Só o Worker monta a autoridade; nenhum cabeçalho do navegador é repassado. */
export async function prepareBlingDispatch(profile: string, path: string, request: Request, identity: IdentityPort): Promise<BlingDispatch> {
  const match = /^\/erp-bling\/operations\/(erp_bling_[a-z_]+)$/.exec(path);
  const adoption = match && getAdoptionOperation(match[1]);
  if (adoption) {
    if (request.method !== "POST") throw new BoundaryError(405, "method_not_allowed");
    const header = request.headers.get(BLING_AUTHORIZATION_HEADER);
    let authorization: BlingAdoptionAuthorization | null = null;
    try { if (header) { if (header.length > 16_384) throw new Error(); authorization = adoptionAuthorizationSchema.parse(JSON.parse(header)); } }
    catch { throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED"); }
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new BlingAdoptionError("BLING_ADOPTION_INVALID"); }
    // Identidade antes dos campos: a recusa não expõe entradas.
    if (!identity.actor || identity.actor.erp_role !== "admin") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
    const input = parseAdoptionInput(adoption.name, raw);
    const context: BlingContext = { profile, identity, origin: "app", clock: { now: () => Date.now() } };
    return { context, name: adoption.name, input, adoption: { name: adoption.name, identity, profile, input: raw, authorization } };
  }
  const operation = path ==="/erp-bling/callback" ? getBlingOperation("erp_bling_oauth_callback") : match && getBlingOperation(match[1]);
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
  if (call.adoption) {
    if (!dependencies.readSnapshot) return adoptionFailure(new BlingAdoptionError("BLING_ADOPTION_UNAVAILABLE"));
    const { handleAdoptionOperation } = await import("./adoption-api.ts");
    return handleAdoptionOperation(call.adoption, { storage: dependencies.storage, readSnapshot: dependencies.readSnapshot, media: dependencies.env?.MEDIA ?? null });
  }
  if (isAdoptionName(call.name)) return adoptionFailure(new BlingAdoptionError("BLING_ADOPTION_INVALID"));
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
    // Escrita com recibo já gravada sai como feita; a reconferência tardia só
    // protege o que é lido e o que ainda começaria trabalho.
    if (!BLING_RECEIPTED_OPERATIONS.has(call.name) && !(await dependencies.readParts())?.customers) throw new BlingError("BLING_DISABLED");
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
  // Lote de adoção em andamento volta logo, mas depois do trabalho operacional.
  if (adoptionPending(dependencies.storage)) return notBefore;
  // Mão dupla: varredura local e fila de saída têm horário próprio.
  const twoWay = earliest(twoWayScanAt(dependencies.storage), twoWayOutboxAt(dependencies.storage));
  if (!wake && !hasBlingWork(dependencies)) return twoWay === null ? null : Math.max(notBefore, twoWay);
  wake ??= await mountedWake(dependencies, profile, 1000);
  const due = earliest(await wake.nextWake({ profile, clock, identity: { actor: null, people: null }, origin: "internal" }), twoWay);
  return due === null ? null : Math.max(notBefore, due);
}

async function mountedTwoWay(dependencies: BlingAssemblyDependencies, profile: string, ctx: BlingContext, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const assembly = await Promise.race([
      createBlingAssembly({ ...dependencies, profile }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BlingError("BLING_RETRY_WAIT")), Math.max(1, Math.min(1000, deadline - ctx.clock.now()))); }),
    ]);
    return await assembly.twoWay(ctx, deadline);
  } finally { if (timer !== undefined) clearTimeout(timer); }
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
  // Adoção dos cadastros: uma unidade pequena, sem I/O externo, por acordada
  // elegível; a coleta segue na acordada seguinte.
  if (options.eligible && !wake && dependencies.readSnapshot && adoptionPending(dependencies.storage) && deadline - options.clock.now() >= 1_000) {
    const { runAdoptionWake } = await import("./adoption-api.ts");
    const adopted = await runAdoptionWake(profile, { storage: dependencies.storage, readSnapshot: dependencies.readSnapshot, now: options.clock.now, media: dependencies.env?.MEDIA ?? null });
    if (adopted.worked) return { worked: true, nextWake: options.clock.now() + 1_000, requests: 0 as const };
  }
  const context: BlingContext = { profile, clock: options.clock, identity: { actor: null, people: null }, origin: "internal" };
  // Mão dupla (versão 19): primeiro a parte local (aplicar o que veio do Bling e
  // varrer o ERP), depois um envio ou conferência da fila de saída.
  if (options.eligible && !wake && dependencies.readSnapshot && deadline - options.clock.now() >= 1_000) {
    const scanAt = twoWayScanAt(dependencies.storage);
    if (scanAt !== null && scanAt <= options.clock.now()) {
      const { runTwoWayWake } = await import("./adoption-api.ts");
      const local = await runTwoWayWake(profile, { storage: dependencies.storage, readSnapshot: dependencies.readSnapshot, now: options.clock.now });
      if (local.worked) return { worked: true, nextWake: options.clock.now() + 1_000, requests: 0 as const };
    }
    const outAt = twoWayOutboxAt(dependencies.storage);
    if (outAt !== null && outAt <= options.clock.now() && deadline - options.clock.now() >= 1_000) {
      const sent = await mountedTwoWay(dependencies, profile, context, deadline);
      if (sent.worked) return { worked: true, nextWake: earliest(sent.nextWake, options.clock.now() + 1_000), requests: sent.requests };
    }
  }
  // O que a coleta devolver ainda respeita o próximo horário da mão dupla.
  const twoWayNext = () => { const at = earliest(twoWayScanAt(dependencies.storage), twoWayOutboxAt(dependencies.storage)); return at === null ? null : Math.max(at, options.clock.now() + 1_000); };
  const withTwoWay = <T extends { nextWake: number | null }>(result: T): T => ({ ...result, nextWake: earliest(result.nextWake, twoWayNext()) });
  if (!wake && !hasBlingWork(dependencies)) return withTwoWay(idle());
  if (deadline - options.clock.now() < 1000) return { ...idle(), nextWake: options.clock.now() + 1000 };
  wake ??= await mountedWake(dependencies, profile, Math.min(1000, deadline - options.clock.now()));
  const due = await wake.nextWake(context);
  if (due === null) return withTwoWay(idle());
  const now = options.clock.now();
  if (!options.eligible) return withTwoWay({ ...idle(), nextWake: Math.max(due, now + 1_000) });
  if (due > now) return withTwoWay({ ...idle(), nextWake: due });
  if (deadline - now < 1_000) return { ...idle(), nextWake: now + 1_000 };
  if (!(await dependencies.readParts())?.customers) return idle();
  const result = await wake.runOne(context, { deadline, nextOperationalAt: options.nextOperationalAt, maxGets: 1 });
  if (!(await dependencies.readParts())?.customers) return idle();
  return withTwoWay(result);
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
    const relative = url.pathname.slice(prefix.length);
    // Adoção (B1 e B2), o corte (fatia C) e a mão dupla: mesmo despacho, mesmas regras.
    if (relative === "/v1/receber-bling/adotar" || relative.startsWith("/v1/receber-bling/adotar/")
      || relative === "/v1/receber-bling/corte" || relative.startsWith("/v1/receber-bling/corte/")
      || relative === "/v1/receber-bling/mao-dupla" || relative.startsWith("/v1/receber-bling/mao-dupla/"))
      return await forwardAdoption(env, profile, actor, identity, request, url, relative.slice("/v1/receber-bling".length));
    const match = matchBlingOperation(request.method, relative);
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
    // A fonte da concessão é a mesma do ERP. A marca de proposta só vale
    // depois de conferir pessoa/bot/área, execução reclamada e corpo integral.
    if (actor.kind === "user" && actor.via) {
      const { erpBotOperationGranted, erpBotDelegation } = await import("../../modules/erp/bot-access.ts");
      if (!identity.actor?.is_agent || !await erpBotOperationGranted(env, actor, profile, match.operation.name))
        throw new BlingError("BLING_SCOPE_REQUIRED");
      raw = parseBlingOperationInput(match.operation.name, raw);
      const hash = await requestHash(raw);
      const confirmed = !!actor.via.proposal_id && await erpBotDelegation(env, actor, profile, request.method, url.pathname, raw);
      if (actor.via.proposal_id && !confirmed) throw new BlingError("BLING_SCOPE_REQUIRED");
      context.authorization = { request_hash: hash,
        delegation: { run_id: actor.via.run_id, proposal_id: actor.via.proposal_id, method: match.operation.method, path: url.pathname },
        bot: { id: actor.via.bot_id, allowed_operations: [match.operation.name], allowed_entities: [...BLING_ENTITIES],
          data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: !confirmed },
        ...(confirmed ? { confirmation: { operation: match.operation.name,
          command_id: match.operation.name === "erp_bling_purge_preview" ? hash : String((raw as { command_id: string }).command_id),
          request_hash: hash, confirmed_by: actor.id, expires_at: context.clock.now() + 60_000 } } : {}),
      };
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

/** Adoção dos cadastros: mesmos nomes para tela e bot. O bot só chama a
 * operação concedida nas opções ERP dele; as sensíveis exigem a proposta já
 * confirmada pela própria pessoa (corpo integral conferido). */
async function forwardAdoption(env: Env, profile: string, actor: Actor, identity: IdentityPort, request: Request, url: URL, relative: string): Promise<Response> {
  const operation = matchAdoptionRoute(request.method, relative);
  if (!operation) throw new BoundaryError(404, "not_found");
  let raw: Record<string, unknown>;
  try {
    if (request.method === "GET") {
      raw = {};
      for (const key of url.searchParams.keys()) {
        if (url.searchParams.getAll(key).length !== 1) throw new Error();
        const value = url.searchParams.get(key)!;
        raw[key] = key === "limit" && /^[1-9]\d?$/.test(value) ? Number(value) : value;
      }
    } else {
      if (url.search) throw new Error();
      raw = await request.json();
    }
  } catch { throw new BlingAdoptionError("BLING_ADOPTION_INVALID"); }
  const app = actor.kind === "user" || actor.kind === "app" && !actor.id.startsWith("bot:") && !actor.scopes.includes("conversations:bound");
  if (!app) throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  if (identity.actor?.erp_role !== "admin") throw new BlingAdoptionError("BLING_ADOPTION_ADMIN_REQUIRED");
  const input = parseAdoptionInput(operation.name, raw);
  let authorization: BlingAdoptionAuthorization | null = null;
  if (actor.kind === "user" && actor.via) {
    const { erpBotOperationGranted, erpBotDelegation } = await import("../../modules/erp/bot-access.ts");
    if (!identity.actor?.is_agent || !await erpBotOperationGranted(env, actor, profile, operation.name)) throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
    if (!await erpBotDelegation(env, actor, profile, request.method, url.pathname, operation.method === "GET" ? undefined : input))
      throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
    authorization = { request_hash: await requestHash(input), bot: { id: actor.via.bot_id, operation: operation.name },
      delegation: { run_id: actor.via.run_id, ...(actor.via.proposal_id ? { proposal_id: actor.via.proposal_id } : {}) }, confirmed: !!actor.via.proposal_id };
  } else if (identity.actor?.is_agent) throw new BlingAdoptionError("BLING_ADOPTION_SCOPE_REQUIRED");
  const { erpFetch } = await import("../hub.ts");
  return erpFetch(env, profile, `/erp-bling/operations/${operation.name}`, {
    method: "POST", headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity),
      ...(authorization ? { [BLING_AUTHORIZATION_HEADER]: JSON.stringify(authorization) } : {}) },
    body: JSON.stringify(input),
  });
}
