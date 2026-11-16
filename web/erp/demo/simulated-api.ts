// API simulada do ERP: responde no navegador o que /api/v1/profiles/<área>/erp
// responderá quando o motor existir (sessão N, src/erp). Serve ao
// desenvolvimento da casca (`npm run web`) e à demonstração `?demo`, que é
// somente leitura. Chunk próprio: só carrega nesses dois casos (mount.tsx).
//
// Dados fictícios de uma papelaria. Cada resposta segue o validador da tela
// (web/erp/app/lib/*-model.ts); o que ainda não foi simulado responde 404 com
// ERP_SIMULATED_MISSING e a tela mostra o próprio aviso de indisponível.
import { demoData, type DemoData } from "./data";

type Init = RequestInit & { method: string };
type Handler = (url: URL, data: DemoData, init: Init) => unknown | undefined;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const refuse = (status: number, code: string) =>
  json(status, { error: { code } });

export function createSimulatedApi(options: {
  actor: string;
  readOnly: boolean;
}) {
  const data = demoData(options.actor);
  return async (path: string, init: Init): Promise<Response> => {
    const url = new URL(path, "https://erp.invalid");
    if (init.method !== "GET") {
      // A vitrine não grava; no desenvolvimento, as escritas esperam o motor.
      return refuse(
        403,
        options.readOnly ? "ERP_DEMO_READ_ONLY" : "ERP_SIMULATED_READ_ONLY",
      );
    }
    for (const handler of handlers) {
      const body = handler(url, data, init);
      if (body !== undefined) return json(200, structuredClone(body));
    }
    if (import.meta.env.DEV)
      console.info(
        "[ERP simulado] rota sem resposta:",
        url.pathname + url.search,
      );
    return refuse(404, "ERP_SIMULATED_MISSING");
  };
}

const handlers: Handler[] = [
  (url, data) => (url.pathname === "/v1/me" ? data.me : undefined),
  (url, data) =>
    url.pathname === "/v1/inicio" ? data.home(url.searchParams) : undefined,
  (url, data) =>
    url.pathname === "/v1/inicio/atalhos" ? data.shortcuts : undefined,
  (url, data) => data.route(url),
];
