// fetch do ERP: o controlador do Fagoo (app/lib/real-access.ts) chama
// fetcher(`${apiUrl}${path}`, { headers: { Authorization: "Bearer …" },
// credentials: "omit" }). Aqui a sessão é o cookie do Wabotia: o Bearer sai,
// o cookie entra, e toda escrita leva Idempotency-Key (web/lib/api.ts).
// Só a API desta área é alcançável; qualquer outro destino (gateway A1,
// Storage do Supabase) é recusado antes de sair do navegador.

/** Base da API do ERP de uma área de atendimento. */
export const erpApiUrl = (profile: string) =>
  `/api/v1/profiles/${encodeURIComponent(profile)}/erp`;

export type FetchPortOptions = {
  apiUrl: string;
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
    const simulated = options.simulate
      ? await options.simulate(path || "/", request)
      : null;
    const response =
      simulated ?? (await network(parsed.pathname + parsed.search, request));
    if (response.status === 401) options.onUnauthorized?.();
    return response;
  };
}
