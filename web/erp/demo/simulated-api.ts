// API simulada do ERP: responde no navegador o que /api/v1/profiles/<área>/erp
// responderá quando o motor existir (sessão N, src/erp). Serve ao
// desenvolvimento da casca (`npm run web`) e à demonstração `?demo`, que é
// somente leitura. Chunk próprio: só carrega nesses dois casos (mount.tsx).
//
// Dados fictícios de uma papelaria. Cada resposta segue o validador da tela
// (web/erp/app/lib/*-model.ts); o que ainda não foi simulado responde 404 com
// ERP_SIMULATED_MISSING e a tela mostra o próprio aviso de indisponível.
import { demoData, type DemoData } from "./data";
import type { ErpPerson } from "../people";

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
  const people = simulatedPeople(options.actor);
  return async (path: string, init: Init): Promise<Response> => {
    const url = new URL(path, "https://erp.invalid");
    // Rotas de usuários que o motor não porta (308e227): pessoas, convite,
    // sessões e fator são do núcleo do Wabotia.
    if (NOT_PORTED.some((route) => route.test(url.pathname)))
      return refuse(501, "ERP_NOT_PORTED");
    if (init.method !== "GET") {
      // A vitrine não grava; no desenvolvimento, as escritas esperam o motor.
      return refuse(
        403,
        options.readOnly ? "ERP_DEMO_READ_ONLY" : "ERP_SIMULATED_READ_ONLY",
      );
    }
    const controls = /^\/v1\/usuarios\/([0-9a-f-]{36})\/controles$/.exec(
      url.pathname,
    );
    if (controls) {
      const person = people.find((p) => p.user_id === controls[1]);
      return person
        ? json(200, accessControls(person))
        : refuse(404, "ERP_USER_NOT_FOUND");
    }
    if (url.pathname === "/v1/seguranca/politica")
      return json(200, securityPolicy(people));
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

// ---------------------------------------------------------------- Pessoas

/** Rotas de usuários do Fagoo que respondem 501 no motor (src/erp/schema/structural.ts). */
const NOT_PORTED = [
  /^\/v1\/usuarios$/,
  /^\/v1\/usuarios\/convites$/,
  /^\/v1\/usuarios\/comandos\/[^/]+$/,
  /^\/v1\/usuarios\/[0-9a-f-]{36}$/,
  /^\/v1\/sistema\/usuarios\/[^/]+\/seguranca$/,
  /^\/v1\/seguranca\/usuarios\/[^/]+\/redefinir-mfa$/,
];

/**
 * Pessoas fictícias da área com papel no ERP, como o núcleo responde em
 * GET /api/v1/profiles/<área>/people já lido por web/erp/people.ts. A pessoa
 * da demonstração é a administradora.
 */
export function simulatedPeople(actor: string): ErpPerson[] {
  const others: ErpPerson[] = [
    {
      user_id: "d3e00000-0000-4000-8000-000000000002",
      name: "Beatriz Lima",
      role: "consulta",
    },
    {
      user_id: "d3e00000-0000-4000-8000-000000000003",
      name: "Carlos Mendes",
      role: "estoque",
    },
    {
      user_id: "d3e00000-0000-4000-8000-000000000004",
      name: "Juliana Prado",
      role: "financeiro",
    },
    {
      user_id: "d3e00000-0000-4000-8000-000000000005",
      name: "Rafael Souza",
      role: "vendas",
    },
  ];
  return [
    { user_id: actor, name: "Marina Albuquerque", role: "admin" as const },
    ...others.filter((person) => person.user_id !== actor),
  ];
}

/** GET /v1/usuarios/:id/controles (user_controls_get, que fica no ERP). */
function accessControls(person: ErpPerson) {
  const admin = person.role === "admin";
  return {
    scope: "access_user_controls",
    data_mode: "erp_native",
    target: person.user_id,
    role: person.role,
    version: 0,
    user_type: "normal",
    // O vendedor só entra no horário comercial; o administrador nunca é bloqueado.
    schedule:
      person.role === "vendas"
        ? {
            enabled: true,
            windows: [
              { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] },
            ],
          }
        : { enabled: false, windows: [] },
    permissions: null,
    seller: null,
    updated_at: null,
    gate_required: admin || person.role === "financeiro",
  };
}

/** GET /v1/seguranca/politica (security_policy_get, que fica no ERP). */
function securityPolicy(people: ErpPerson[]) {
  return {
    scope: "access_security_policy",
    data_mode: "erp_native",
    policy: {
      mfa_required: false,
      version: 0,
      updated_at: null,
      members: people
        .filter(
          (person) => person.role === "admin" || person.role === "financeiro",
        )
        .map((person) => ({
          user_id: person.user_id,
          name: person.name,
          role: person.role,
          factor: false,
        })),
    },
    self: { factor: false, aal2: false },
  };
}
