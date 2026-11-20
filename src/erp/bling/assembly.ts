// Montagem deliberadamente inativa. org-fecha substituirá somente os stubs
// por implementações testadas; importar este módulo não executa I/O.
import type { Actor, Env } from "../../types.ts";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import type { ErpParts } from "../parts.ts";
import { BLING_ERROR_CODES, BlingError, type BlingContext, type BlingOperationName } from "./contracts.ts";
import type { AuthorizationPort, CollectionStore, ArchivePort, BlingApiPort, BlingWakePort, BlingDataPort } from "./ports.ts";
import { BLING_OPERATIONS, BlingAuthorizationContextSchema, authorizeBlingOperation, getBlingOperation, parseBlingOperationInput, xmlDownloadSchema } from "./schema.ts";

export const BLING_AUTHORIZATION_HEADER = "x-erp-bling-authorization";
const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const requestHash = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export interface BlingAssemblyDependencies {
  env: Env;
  storage: DurableObjectStorage;
  readParts: () => Promise<Readonly<ErpParts> | null>;
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
const unavailable = (): never => { throw new BlingError("BLING_DISABLED", { status: 503 }); };
const idle = () => ({ worked: false, nextWake: null, requests: 0 as const });
const inactiveApi: BlingApiPort = {
  async execute() { return unavailable(); },
  async callback() { return unavailable(); },
};
const inactiveWake: BlingWakePort = {
  async nextWake() { return null; },
  async runOne() { return idle(); },
};
export interface BlingAssembly {
  authorization: AuthorizationPort;
  collection: CollectionStore;
  archive: ArchivePort;
  api: BlingApiPort;
  wake: BlingWakePort;
  data: BlingDataPort;
}
const inactiveAssembly: BlingAssembly = {
  authorization: {
    async publicState() { return unavailable(); }, async authorize() { return unavailable(); },
    async saveApplication() { return unavailable(); }, async renew() { return unavailable(); },
    async callback() { return unavailable(); }, reserveOAuth: unavailable, consumeOAuth: unavailable,
    async custodyCas() { return unavailable(); }, async privateCredential() { return unavailable(); },
    async disconnect() { return unavailable(); },
  },
  collection: { reserve: unavailable, renew: unavailable, release: unavailable, receipt: unavailable,
    markFetching: unavailable, commitBatch: unavailable, reschedule: unavailable, requestCollection: unavailable },
  archive: { validateCapture: unavailable, project: unavailable, readVersion: unavailable,
    listRecords: unavailable, listVersions: unavailable, listXml: unavailable,
    async archiveXml() { return unavailable(); }, async readXml() { return unavailable(); },
    purgePreview: unavailable, async purge() { return unavailable(); } },
  api: inactiveApi, wake: inactiveWake, data: { async get() { return unavailable(); } },
};
/** Nenhuma dependência é acessada até que org-fecha monte as implementações. */
export function createBlingAssembly(_dependencies?: BlingAssemblyDependencies): BlingAssembly {
  return inactiveAssembly;
}
for (const port of Object.values(inactiveAssembly)) Object.freeze(port);
Object.freeze(inactiveAssembly);

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

/** Só o Worker monta a autoridade; nenhum cabeçalho do navegador é repassado. */
export async function prepareBlingDispatch(profile: string, path: string, request: Request, identity: IdentityPort): Promise<BlingDispatch> {
  const match = /^\/erp-bling\/operations\/(erp_bling_[a-z_]+)$/.exec(path);
  const operation = match && getBlingOperation(match[1]);
  if (!operation || operation.name === "erp_bling_oauth_callback") throw new BoundaryError(404, "not_found");
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
  authorizeBlingOperation(context, operation.name, raw);
  const input = parseBlingOperationInput(operation.name, raw);
  return { context, name: operation.name, input };
}

export async function handleBlingOperation(call: BlingDispatch, dependencies: BlingAssemblyDependencies, api: BlingApiPort = createBlingAssembly(dependencies).api): Promise<Response> {
  try {
    if (!(await dependencies.readParts())?.customers) throw new BlingError("BLING_DISABLED");
    authorizeBlingOperation(call.context, call.name, call.input);
    const input = parseBlingOperationInput(call.name, call.input);
    const cookies: string[] = [];
    const result = await api.execute({ ...call.context, response: { setCookie(cookie) {
      if (call.name !== "erp_bling_oauth_start" || !/^__Host-[A-Za-z0-9_-]{1,100}$/.test(cookie.name) ||
          !/^[A-Za-z0-9_.-]{1,4096}$/.test(cookie.value) || !Number.isSafeInteger(cookie.max_age) ||
          cookie.max_age < 0 || cookie.max_age > 600 || cookies.length) throw new BlingError("BLING_RESPONSE_INVALID");
      cookies.push(`${cookie.name}=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${cookie.max_age}`);
    } } }, call.name, input);
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

/** Encaixe OAuth separado: a base não consome estado nem faz troca HTTP. */
export async function handleBlingCallback(_env: Env, _profile: string, _request: Request): Promise<Response> {
  return blingFailureResponse(new BlingError("BLING_DISABLED", { status: 503 }));
}

/** Consulta barata para adiar a coleta quando esta acordada já operou o ERP. */
export async function nextBlingWake(profile: string, dependencies: BlingAssemblyDependencies, notBefore: number, clock = { now: () => Date.now() }, wake = createBlingAssembly(dependencies).wake): Promise<number | null> {
  if (!(await dependencies.readParts())?.customers) return null;
  const due = await wake.nextWake({ profile, clock, identity: { actor: null, people: null }, origin: "internal" });
  return due === null ? null : Math.max(notBefore, due);
}

/** Orçamento da costura; HTTP e transação continuarão nas portas próprias. */
export async function runBlingWake(profile: string, dependencies: BlingAssemblyDependencies, options: {
  eligible: boolean;
  nextOperationalAt: number | null;
  clock: { now(): number };
}, wake: BlingWakePort = createBlingAssembly(dependencies).wake) {
  if (!(await dependencies.readParts())?.customers) return idle();
  const context: BlingContext = { profile, clock: options.clock, identity: { actor: null, people: null }, origin: "internal" };
  const due = await wake.nextWake(context);
  if (due === null) return idle();
  const now = options.clock.now();
  if (!options.eligible) return { ...idle(), nextWake: Math.max(due, now + 1_000) };
  if (due > now) return { ...idle(), nextWake: due };
  const deadline = Math.min(now + 4_000, options.nextOperationalAt === null ? Infinity : options.nextOperationalAt - 250);
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
    // A confirmação foi validada pelo núcleo e é limitada ao comando exato.
    // Leituras de dados por IA ainda exigem concessões persistentes próprias.
    if (actor.kind === "user" && actor.via?.proposal_id && match.operation.permission === "admin" && raw && typeof raw === "object" &&
        ("command_id" in raw || match.operation.name === "erp_bling_purge_preview")) {
      raw = parseBlingOperationInput(match.operation.name, raw);
      const hash = await requestHash(raw);
      context.authorization = { request_hash: hash,
        bot: { id: actor.via.bot_id, allowed_operations: [match.operation.name], allowed_entities: [], data_scopes: [], allow_sensitive: false },
        confirmation: { operation: match.operation.name, command_id: match.operation.name === "erp_bling_purge_preview" ? hash : String((raw as { command_id: string }).command_id),
          request_hash: hash, confirmed_by: actor.id, expires_at: context.clock.now() + 60_000 } };
    }
    authorizeBlingOperation(context, match.operation.name, raw);
    const input = parseBlingOperationInput(match.operation.name, raw);
    const { erpFetch } = await import("../hub.ts");
    return await erpFetch(env, profile, `/erp-bling/operations/${match.operation.name}`, {
      method: "POST", headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(identity),
        ...(context.authorization ? { [BLING_AUTHORIZATION_HEADER]: JSON.stringify(context.authorization) } : {}) },
      body: JSON.stringify(input),
    });
  } catch (error) { return blingFailureResponse(error); }
}
