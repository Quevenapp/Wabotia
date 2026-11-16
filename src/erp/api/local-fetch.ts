// Costura da erp-api do Fagoo (src/erp/fagoo/workers/erp-api, sem
// alteração): createHandler({ fetchImpl }) com um fetch local no lugar do
// Supabase. O mesmo truque das fixtures do Fagoo (pos-fixture.mjs), agora
// apontando para o motor:
//   /rest/v1/rpc/<nome>  → objeto erp:<área>, /erp-rpc/<nome>
//   /auth/v1/user        → o ator do Wabotia (já autenticado pelo Worker)
//   /storage/v1/…        → ainda não (R2 na fase 3): 501
// Fase 0, prova 6.
// @ts-ignore módulo JavaScript do Fagoo, sem tipos (allowJs desligado).
import { createHandler } from "../fagoo/workers/erp-api/src/index.mjs";
import { ApiError, type Actor, type Env } from "../../types";
import { erpFetch } from "../hub.ts";

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
  const headers = new Headers({ Authorization: "Bearer wabotia-session" });
  const type = request.headers.get("Content-Type");
  if (type) headers.set("Content-Type", type);
  const inner = new Request(new URL(path + url.search, "https://erp-api.wabotia.invalid"), {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
  });
  const handler = createHandler({ fetchImpl: localFetch(env, profile, actor) });
  return handler(inner, CONFIG) as Promise<Response>;
}
