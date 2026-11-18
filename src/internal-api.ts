// Chamadas em processo dos bots internos: o ator vem do servidor, nunca da requisição externa.
import type { Hono } from "hono";
import { ApiError, type Actor, type Env, type Bindings } from "./types";
import { refuseEngineActor } from "./security";
type Row = Record<string, any>;
type Call = { path: string; method?: string; body?: any; query?: Row };

const INTERNAL_HEADER = "X-Wabotia-Internal-Actor";
const internalActors = new Map<string, Actor>();
/** Consome o ator de uma chamada em processo; pedidos externos nunca encontram o nonce. */
export function takeInternalActor(request: Request): Actor | null {
  const nonce = request.headers.get(INTERNAL_HEADER);
  if (!nonce) return null;
  const actor = internalActors.get(nonce) || null;
  internalActors.delete(nonce);
  return actor;
}

let appRef: Hono<Bindings> | null = null;
/**
 * Chamada interna à API v1 com um ator já conferido, fora de uma requisição
 * (bot agindo pela pessoa, src/bot-actions). Passa pelos mesmos middlewares
 * de uma chamada HTTP: área, módulo desligado, acesso por pessoa, comando no
 * Coordinator com Idempotency-Key. Nunca grava a origem pública.
 */
export async function internalCall(
  env: Env,
  actor: Actor,
  call: Call,
  key?: string,
) {
  // O ator do motor de atendimento nunca chama a API (src/security.ts).
  refuseEngineActor(actor);
  // A entrada do Worker monta o app (mountInternalApi) ao carregar; fora dela
  // (Coordinator, testes que importam o motor), carregar a entrada basta.
  if (!appRef) await import("./index");
  if (!appRef) throw new Error("API interna indisponível.");
  const url = new URL("/api/v1" + call.path, "https://wabotia.internal");
  if (url.pathname !== "/api/v1" + call.path || url.search || url.hash)
    throw new ApiError(400, "invalid_request", "Caminho inválido.");
  for (const [k, v] of Object.entries(call.query || {}))
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  const method = call.method || "GET";
  const nonce = crypto.randomUUID();
  const headers: Row = { [INTERNAL_HEADER]: nonce, Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = key || crypto.randomUUID();
  }
  internalActors.set(nonce, actor);
  try {
    return await appRef!.request(
      url.toString(),
      {
        method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      },
      env,
    );
  } finally {
    internalActors.delete(nonce);
  }
}

export function mountInternalApi(app: Hono<Bindings>) {
  appRef = app;
}
