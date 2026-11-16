// Costura da erp-api do Fagoo (src/erp/fagoo/workers/erp-api, sem
// alteração): createHandler({ fetchImpl }) com um fetch local no lugar do
// Supabase. O mesmo truque das fixtures do Fagoo (pos-fixture.mjs), agora
// apontando para o motor:
//   /rest/v1/rpc/<nome>  → objeto erp:<área>, /erp-rpc/<nome>
//   /auth/v1/user        → o ator do Wabotia (já autenticado pelo Worker)
//   /storage/v1/…        → ainda não (R2 na fase 3): 501
// Fase 0, prova 6.
import { ApiError, type Actor, type Env } from "../../types";
import { admin } from "../../security";
import { requireModule } from "../../modules/registry";
import { erpBlockOf } from "../blocks.ts";
import { erpFetch } from "../hub.ts";

let erpApiModule: Promise<any> | null = null;

/** "Supabase" que só a costura enxerga; nunca recebe tráfego de rede. */
const LOCAL = "https://erp.wabotia.invalid";
const CONFIG = {
  SUPABASE_URL: LOCAL,
  SUPABASE_DEPLOYMENT: "self-hosted",
  SUPABASE_SERVICE_ROLE_KEY: "motor-local",
  ALLOWED_ORIGINS: "",
};

export function localFetch(env: Env, profile: string, actor: Actor) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== LOCAL) throw new Error("A erp-api tentou sair da costura local.");
    if (url.pathname === "/auth/v1/user")
      return Response.json({ id: actor.id, email: null, app_metadata: {}, user_metadata: { name: actor.name } });
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (rpc)
      return erpFetch(env, profile, `/erp-rpc/${rpc[1]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: init.body as BodyInit,
      });
    if (url.pathname.startsWith("/storage/v1/"))
      return Response.json({ code: "0A000", message: "erp_storage_not_ported" }, { status: 501 });
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
  const response = await erpFetch(env, profile, `/erp-probe/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
export async function erpApi(env: Env, request: Request, profile: string, actor: Actor) {
  if (actor.kind !== "user")
    throw new ApiError(403, "erp_user_required", "O ERP atende só pessoas nesta fase.");
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
  const headers = new Headers({ Authorization: "Bearer wabotia-session" });
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
  const handler = createHandler({ fetchImpl: localFetch(env, profile, actor) });
  return handler(inner, CONFIG) as Promise<Response>;
}
