import { setErpModuleContext } from "./blocks.ts";
import { requirementsEnabled } from "./modules.ts";
type PanelContext = { modules: Readonly<Record<string, boolean>>; lifetime: AbortController; owners: number };
const panelContexts = new Map<string, PanelContext>();
/** Fotografia explícita da área, compartilhada pela casa e pela ficha de cliente. */
export function setPanelPartsContext(apiUrl: string, modules: Readonly<Record<string, boolean>>) {
  const base=apiUrl.replace(/\/$/, ''),previous=panelContexts.get(base);
  const same=previous&&!previous.lifetime.signal.aborted&&JSON.stringify(previous.modules)===JSON.stringify(modules);
  if(!same)previous?.lifetime.abort();
  const entry: PanelContext=same?previous:{modules:Object.freeze({...modules}),lifetime:new AbortController(),owners:0};
  entry.owners++;panelContexts.set(base,entry);setErpModuleContext(entry.modules);
  let released=false;
  return () => {
    if(released)return;released=true;
    if(--entry.owners>0)return;
    entry.lifetime.abort();
    // A lápide impede que callbacks da área anterior recuperem a compatibilidade "tudo ligado".
    if(panelContexts.get(base)===entry)setErpModuleContext({});
  };
}
export async function panelRequestAllowed(path: string, method: string, body: unknown, modules: Readonly<Record<string, boolean>>) {
  const { erpRouteRequirement } = await import("../../src/erp/parts-requirements.ts");
  const requirement = erpRouteRequirement(method, new URL(path, "https://erp.invalid"), body);
  return requirement !== "externo" && requirementsEnabled(requirement, modules);
}
// fetch do ERP: o controlador do Fagoo (app/lib/real-access.ts) chama
// fetcher(`${apiUrl}${path}`, { headers: { Authorization: "Bearer …" },
// credentials: "omit" }). Aqui a sessão é o cookie do Wabotia: o Bearer sai,
// o cookie entra, e toda escrita leva Idempotency-Key (web/lib/api.ts).
// Só a API desta área é alcançável; qualquer outro destino (gateway A1,
// Storage do Supabase) é recusado antes de sair do navegador.

/** Base da API do ERP de uma área de atendimento. */
export const erpApiUrl = (profile: string) =>
  `/api/v1/profiles/${encodeURIComponent(profile)}/erp`;

/**
 * API simulada (demonstração e desenvolvimento sem ?erp-real): a casca não
 * antecipa o /v1/me, que nesse caso nem vai à rede.
 */
export const erpSimulated = (demo: boolean) =>
  demo ||
  Boolean(
    import.meta.env?.DEV &&
    !new URLSearchParams(location.search).has("erp-real"),
  );

/** Quanto tempo o /v1/me antecipado espera o controlador do ERP pedir o dele. */
export const ME_PREFETCH_WINDOW_MS = 10_000;
type MePrefetch = {
  url: string;
  actor: string;
  at: number;
  response: Promise<Response>;
};
let mePrefetch: MePrefetch | null = null;

/**
 * Primeira visita: o GET /v1/me sai quando a casca decide montar o ERP
 * (ErpArea), em paralelo com o download dos arquivos do ERP. O primeiro
 * GET /v1/me do controlador, do mesmo ator e dentro da janela, recebe esta
 * resposta (uma vez só); fora disso, ou se ela falhou, vai para a rede.
 */
export function prefetchErpMe(
  apiUrl: string,
  actor: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/v1/me`, location.origin)
    .pathname;
  if (
    mePrefetch &&
    mePrefetch.url === url &&
    mePrefetch.actor === actor &&
    Date.now() - mePrefetch.at < ME_PREFETCH_WINDOW_MS
  )
    return;
  const response = fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  // Quem não for usado não vira rejeição solta.
  response.catch(() => undefined);
  mePrefetch = { url, actor, at: Date.now(), response };
}

/** Entrega o /v1/me antecipado uma única vez; null quando não serve. */
function takeMePrefetch(url: string, actor: string | undefined) {
  const taken = mePrefetch;
  mePrefetch = null;
  if (
    !taken ||
    !actor ||
    taken.url !== url ||
    taken.actor !== actor ||
    Date.now() - taken.at >= ME_PREFETCH_WINDOW_MS
  )
    return null;
  return taken.response;
}

/** A resposta antecipada, se chegar bem; null manda o pedido para a rede. */
async function prefetchedResponse(
  response: Promise<Response>,
  signal: AbortSignal | null | undefined,
): Promise<Response | null> {
  if (signal?.aborted)
    throw new DOMException("Request cancelled", "AbortError");
  let stop: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () =>
      reject(new DOMException("Request cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    stop = () => signal?.removeEventListener("abort", abort);
  });
  try {
    const value = await Promise.race([
      response.then(
        (item) => (item.ok ? item : null),
        () => null,
      ),
      cancelled,
    ]);
    return value;
  } finally {
    stop();
  }
}

export type FetchPortOptions = {
  apiUrl: string;
  /** Ator da sessão do ERP: o /v1/me antecipado só serve ao mesmo ator. */
  actor?: string;
  /** Resposta simulada (desenvolvimento e demonstração); null segue para a rede. */
  simulate?: (
    path: string,
    init: RequestInit & { method: string },
  ) => Promise<Response | null> | Response | null;
  /** 401 da API: a sessão do Wabotia terminou (a casca volta para a entrada). */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
};

export function createFetchPort(options: FetchPortOptions): typeof fetch {
  const base = options.apiUrl.replace(/\/$/, "");
  const network = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const parsed = new URL(url, location.origin);
    if (
      parsed.origin !== location.origin ||
      (parsed.pathname !== base && !parsed.pathname.startsWith(base + "/"))
    )
      throw new TypeError("ERP_FETCH_OUTSIDE_API");
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    const method = (init.method || "GET").toUpperCase();
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      !headers.has("Idempotency-Key")
    )
      headers.set("Idempotency-Key", crypto.randomUUID());
    const request = {
      ...init,
      method,
      headers,
      credentials: "same-origin" as const,
    };
    const path = parsed.pathname.slice(base.length) + parsed.search;
    const context = panelContexts.get(base);
    if (context) {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      if (!await panelRequestAllowed(path, method, body, context.modules))
        return Response.json({ error: { code: "module_disabled", message: "Esta rotina depende de uma parte desligada." } }, { status: 409 });
      request.signal = AbortSignal.any([context.lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      if (request.signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
    }
    const simulated = options.simulate
      ? await options.simulate(path || "/", request)
      : null;
    const early =
      !options.simulate && method === "GET" && path === "/v1/me"
        ? takeMePrefetch(parsed.pathname, options.actor)
        : null;
    const handed = early ? await prefetchedResponse(early, request.signal) : null;
    const response =
      simulated ??
      handed ??
      (await network(parsed.pathname + parsed.search, request));
    if (context?.lifetime.signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
    if (response.status === 401) options.onUnauthorized?.();
    return context ? contextBoundResponse(response, context.lifetime.signal) : response;
  };
}

/** Mesmo um prefetch já respondido perde seu corpo quando a autorização muda. */
export async function contextBoundResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
  if (!response.body) return response;
  const reader = response.body.getReader();
  let active = true, stop = () => {};
  const finish = () => { active = false; stop(); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        if (!active) return;
        finish();
        controller.error(new DOMException("Contexto alterado", "AbortError"));
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      stop = () => signal.removeEventListener("abort", abort);
    },
    async pull(controller) {
      try {
        if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
        const next = await reader.read();
        if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
        if (!active) return;
        if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { if (active) { finish(); controller.error(error); } }
    },
    cancel() { finish(); return reader.cancel(); },
  });
  const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // fetch-port descarta antecipações não utilizáveis e refaz /v1/me. Isso
  // também vale se o cache já recebeu os cabeçalhos antes da revogação.
  Object.defineProperty(guarded, "ok", { get: () => !signal.aborted && response.ok });
  return guarded;
}
