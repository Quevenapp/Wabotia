// Costura da erp-api do Fagoo (src/erp/fagoo/workers/erp-api, sem
// alteração): createHandler({ fetchImpl }) com um fetch local no lugar do
// Supabase. O mesmo truque das fixtures do Fagoo (pos-fixture.mjs), agora
// apontando para o motor:
//   /rest/v1/rpc/<nome>  → objeto erp:<área>, /erp-rpc/<nome>
//   /auth/v1/user        → o ator do Wabotia (já autenticado pelo Worker)
//   /storage/v1/…        → R2 (MEDIA), por área (src/erp-storage.ts)
// Fase 0, prova 6.
import { ApiError, type Actor, type Env } from "../../types";
import { admin } from "../../security";
import { moduleEnabled, requireModule } from "../../modules/registry";
import { FISCAL_MODULE_HEADER, type ErpModuleState } from "../engine/module-state.ts";
import { erpBlockOf } from "../blocks.ts";
import { GATE_DENIED_HEADER, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, encodeIdentity, type IdentityPort } from "../engine/identity.ts";
import { erpFetch } from "../hub.ts";
import { erpStorage, publicSignedUrls } from "../../erp-storage";
import { ErpUnavailable, rpcHasCommand, withStubRetry } from "./retry.ts";

/** Motivo de recusa do portão (x-erp-gate-denied) → código de erro da erp-api. */
const GATE_CODES: Record<string, string> = {
  outside_schedule: "ERP_ACCESS_OUTSIDE_SCHEDULE",
  mfa_required: "ERP_MFA_REQUIRED",
  // O código do Fagoo para o token de agente recusado (erp_access_agent_resolve 'denied').
  agent_out_of_scope: "ERP_AGENT_ACCESS_DENIED",
};

let erpApiModule: Promise<any> | null = null;

/** "Supabase" que só a costura enxerga; nunca recebe tráfego de rede. */
const LOCAL = "https://erp.wabotia.invalid";
const CONFIG = {
  SUPABASE_URL: LOCAL,
  SUPABASE_DEPLOYMENT: "self-hosted",
  SUPABASE_SERVICE_ROLE_KEY: "motor-local",
  ALLOWED_ORIGINS: "",
};

/**
 * Envelope de identidade (engine/identity.ts). Fase 0: só quem chama, sem
 * papel, sessão nem diretório de pessoas; a fase 3 preenche a partir do
 * núcleo (papel erp:<papel>, sessão aal, fator) e manda as pessoas da área.
 */
export function identityFor(actor: Actor): IdentityPort {
  const a = actor as Actor & { name?: string; email?: string };
  return {
    actor: {
      user_id: a.id,
      name: typeof a.name === "string" ? a.name : null,
      email: typeof a.email === "string" ? a.email : null,
      erp_role: null,
      verified_factor: false,
      session_id: null,
      aal: "aal1",
      is_agent: a.kind !== "user",
    },
    people: null,
  };
}

/**
 * `read`: o pedido de fora é leitura (GET/HEAD), e os RPCs dele podem ser
 * repetidos depois de um erro de stub (api/retry.ts). Escrita só se repete
 * com p_command_id.
 */
/** Uma ida ao objeto erp: na requisição (Server-Timing da erp-api). */
export interface ErpHop {
  rpc: string;
  ms: number;
}

export function localFetch(
  env: Env,
  profile: string,
  actor: Actor,
  identity: IdentityPort = identityFor(actor),
  { read = false, hops, gate, modules }: { read?: boolean; hops?: ErpHop[]; gate?: { denied: string | null }; modules?: ErpModuleState } = {},
) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== LOCAL) throw new Error("A erp-api tentou sair da costura local.");
    // O id de quem chama no ERP é o do envelope (aplicação: o uuid, sem "app:").
    if (url.pathname === "/auth/v1/user")
      return Response.json({ id: identity.actor?.user_id ?? actor.id, email: null, app_metadata: {}, user_metadata: { name: actor.name } });
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (rpc) {
      const state = modules ?? { fiscal: await moduleEnabled(env, profile, "erp-fiscal") };
      // Corpo em texto: a nova tentativa manda o mesmo de novo.
      const body = init.body == null ? undefined : typeof init.body === "string" ? init.body : await new Response(init.body).text();
      const route = `/erp-rpc/${rpc[1]}` as const;
      // Erro de stub sai como ErpUnavailable; a erp-api do Fagoo responde 503
      // ERP_UPSTREAM_UNAVAILABLE para qualquer exceção do fetch (upstream()).
      const started = Date.now();
      try {
        // O portão (horário, segundo fator) roda no objeto antes do RPC, na
        // mesma ida: a erp-api não chama mais o erp_access_gate_v2 à parte
        // (o /auth/v1/user responde sem a marca brufap_access_gate).
        const response = await withStubRetry(
          () =>
            erpFetch(env, profile, route, {
              method: "POST",
              // SYSTEM_HEADER: a costura é chamada interna (a rota da erp-api escolheu o RPC; rpc-endpoint.ts, SYSTEM_RPCS).
              headers: {
                "Content-Type": "application/json",
                [IDENTITY_HEADER]: encodeIdentity(identity),
                [SYSTEM_HEADER]: "1",
                [FISCAL_MODULE_HEADER]: state.fiscal ? "1" : "0",
                ...(gate ? { [GATE_HEADER]: "1" } : {}),
              },
              body,
            }),
          { idempotent: read || rpcHasCommand(body), route },
        );
        const denied = response.headers.get(GATE_DENIED_HEADER);
        if (gate && denied) gate.denied = denied;
        return response;
      } finally {
        hops?.push({ rpc: rpc[1], ms: Date.now() - started });
      }
    }
    // Arquivos no R2 (MEDIA), por área: src/erp-storage.ts.
    if (url.pathname.startsWith("/storage/v1/")) return erpStorage(env, profile, new Request(input, init));
    return Response.json({ message: "not found" }, { status: 404 });
  };
}

const PROBES = new Set([
  "setup", "stock-post", "load", "report", "limits", "bookmark-mark", "bookmark-at", "bookmark-restore",
  "bookmark-check", "location", "wipe",
]);

/**
 * POST /api/v1/profiles/:profile/erp-probe/<sonda>: roteiro da instalação de
 * teste (scripts/erp/staging-check.mjs). Só existe com a variável
 * ERP_PROBES=1 no deploy (`wrangler deploy --var ERP_PROBES:1`); sem ela, 404.
 * Administrador, módulo erp ligado na área (salvo "wipe", a limpeza).
 */
export async function erpProbe(env: Env, request: Request, profile: string, actor: Actor, name: string) {
  if ((env as unknown as Record<string, unknown>).ERP_PROBES !== "1" || !PROBES.has(name))
    throw new ApiError(404, "not_found", "Rota não encontrada.");
  admin(actor);
  if (name !== "wipe") await requireModule(env, profile, "erp");
  const body = { ...(await request.json<Record<string, unknown>>().catch(() => ({}))), user: actor.id };
  const t0 = Date.now();
  const route = `/erp-probe/${name}` as const;
  // Sondas não se repetem (carga, restauração): erro de stub → 503, não 500.
  const response = await withStubRetry(
    () => erpFetch(env, profile, route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { idempotent: false, route },
  ).catch((error) => {
    if (error instanceof ErpUnavailable) throw new ApiError(503, error.code, error.message);
    throw error;
  });
  const result = await response.json<Record<string, unknown>>().catch(() => ({ error: "resposta sem JSON" }));
  return Response.json(
    { probe: name, status: response.status, worker_colo: (request as any).cf?.colo ?? null, wall_ms: Date.now() - t0, result },
    { status: response.ok ? 200 : 502 },
  );
}

/**
 * /api/v1/profiles/:profile/erp/<rota da erp-api> → handler do Fagoo. Fase 0:
 * só pessoas com acesso à área; o motor confere o vínculo (erp_access) como
 * no Fagoo. Papéis erp:<papel> e escopos de aplicação vêm na fase 3.
 */
/**
 * `identity`: o envelope montado pelo núcleo (papel erp:<papel>, sessão e aal,
 * fator, agente, pessoas da área). Sem ele, o envelope mínimo do identityFor.
 */
export async function erpApi(env: Env, request: Request, profile: string, actor: Actor, identity: IdentityPort = identityFor(actor)) {
  // Pessoa, ou aplicação com erp:read/erp:write (o núcleo já conferiu o
  // escopo e o papel no envelope; src/modules/erp/identity.ts).
  if (actor.kind !== "user" && !(actor.kind === "app" && identity.actor?.is_agent && `app:${identity.actor.user_id}` === actor.id))
    throw new ApiError(403, "erp_user_required", "O ERP atende pessoas e aplicações com escopo do ERP.");
  const url = new URL(request.url);
  const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/erp`;
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || "/" : "/";
  // Portão dos blocos (src/erp/blocks.ts): opcional desligado → 409 antes do
  // objeto; o que saiu da instalação principal (Origin, MCP, autoatualização
  // do Fagoo) → 404. O módulo `erp` em si já passou pelo portão comum.
  const block = erpBlockOf(path);
  if (block === "externo")
    throw new ApiError(404, "erp_route_removed", "Esta rota do ERP não faz parte da instalação principal.");
  if (block !== "erp") await requireModule(env, profile, block);
  // Estado efetivo da área nesta requisição, sem depender do wake do agendador.
  // Só a costura monta este metadado; cabeçalhos e campos do cliente não o definem.
  const modules: ErpModuleState = { fiscal: await moduleEnabled(env, profile, "erp-fiscal") };
  // Token em forma de JWT, sem assinatura (alg none), com sessão e aal do
  // envelope: o accessGate e a rota de segurança da erp-api leem session_id e
  // aal das claims (tokenSession). Nunca é conferido como JWT: o /auth/v1/user
  // responde pela costura, e o motor só aceita a sessão que bate com o
  // envelope (sessionAal2). Achado da sessão A: com "Bearer wabotia-session" o
  // session_id ia null e o aal2 nunca passava.
  const claims = { sub: identity.actor?.user_id ?? actor.id, session_id: identity.actor?.session_id ?? null, aal: identity.actor?.aal ?? "aal1" };
  const part = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headers = new Headers({ Authorization: `Bearer ${part({ alg: "none", typ: "JWT" })}.${part(claims)}.wabotia` });
  const type = request.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  const inner = new Request(new URL(path + url.search, "https://erp-api.wabotia.invalid"), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
  // A erp-api (3 MB) só é avaliada na primeira chamada do ERP (prova 7).
  // @ts-ignore módulo JavaScript do Fagoo, sem tipos (allowJs desligado).
  const { createHandler } = await (erpApiModule ??= import("../fagoo/workers/erp-api/src/index.mjs"));
  const read = ["GET", "HEAD"].includes(request.method);
  const hops: ErpHop[] = [];
  const gate = { denied: null as string | null };
  const started = Date.now();
  const handler = createHandler({ fetchImpl: localFetch(env, profile, actor, identity, { read, hops, gate, modules }) });
  let response = (await handler(inner, CONFIG)) as Response;
  // Portão fechado no objeto: o erro que o accessGate da erp-api daria, no formato dela.
  if (gate.denied) {
    const requestId = ((await response.json().catch(() => null)) as { error?: { request_id?: string } } | null)?.error?.request_id;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    response = Response.json(
      { error: { code: GATE_CODES[gate.denied] ?? "ERP_ACCESS_OUTSIDE_SCHEDULE", ...(requestId ? { request_id: requestId } : {}) } },
      { status: 403, headers },
    );
  }
  // URL assinada do Storage (exportação): o endereço local da costura vira a
  // rota pública do Worker, na origem em que a pessoa chamou.
  if (/^application\/json/i.test(response.headers.get("Content-Type") || "")) {
    const text = await response.text();
    const rewritten = publicSignedUrls(text, LOCAL, url.origin, profile);
    const headers = new Headers(response.headers);
    if (rewritten !== text) headers.delete("content-length");
    response = new Response(rewritten, { status: response.status, headers });
  }
  // Idas ao objeto erp: nesta requisição, para medir no navegador e na
  // Observabilidade: Server-Timing: erp;desc="hops=N";dur=…, erp-rpc-1;desc="<rpc>";dur=…
  const out = new Response(response.body, response);
  out.headers.set(
    "Server-Timing",
    [`erp;desc="hops=${hops.length}";dur=${Date.now() - started}`, ...hops.map((h, i) => `erp-rpc-${i + 1};desc="${h.rpc}";dur=${h.ms}`)].join(", "),
  );
  return out;
}
