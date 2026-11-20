/**
 * Suporte Worker sem cofre real e sem relógio curto. Cada teste instala a
 * implementação própria com installCommercialNfeHttp/Slots e a restaura no
 * finally. Para transporte NFapi, use createFakeVault de erp/emissor/fake-vault.
 */
import type { Actor, Env } from "../src/types";
import { normalizeErpParts, type ErpParts } from "../src/erp/parts.ts";
import type { IdentityPort } from "../src/erp/engine/identity.ts";
import type { CommercialNfeOperation, CommercialNfeRouteDependencies } from "../src/erp/commercial-nfe/routes.ts";
import type { Com1Authority } from "../src/erp/domains/fiscal/comnfe/access.ts";
import type { CommercialNfeDependencies } from "../src/erp/commercial-nfe/contracts.ts";
import type { FiscalProvider } from "../src/erp/emissor/provider.ts";

export const COM1_TEST_IDS = {
  user: "11111111-1111-4111-8111-111111111111", session: "22222222-2222-4222-8222-222222222222",
  document: "33333333-3333-4333-8333-333333333333", emission: "44444444-4444-4444-8444-444444444444",
  command: "55555555-5555-4555-8555-555555555555", nature: "66666666-6666-4666-8666-666666666666",
};

export function com1Actor(overrides: Partial<Actor> = {}): Actor {
  return { id: COM1_TEST_IDS.user, name: "Pessoa de ensaio", kind: "user", role: "admin", profiles: ["com1"],
    scopes: [], bots: [], rate: 100, runLimit: 100, sessionId: COM1_TEST_IDS.session, aal: 2, ...overrides };
}

export function com1Identity(actor = com1Actor(), parts: Partial<ErpParts> = {}): IdentityPort {
  const person = { user_id: actor.id, name: actor.name, email: null, erp_role: "admin" as const,
    verified_factor: true, session_id: actor.sessionId ?? null, aal: "aal2" as const, is_agent: !!actor.via };
  return { actor: person, people: [person], parts: normalizeErpParts(parts), customer_privacy: { restricted_contact_ids: [] } };
}

export function com1RouteDependencies(options: {
  identity?: IdentityPort;
  authority?: Com1Authority;
  fetch?: typeof fetch;
} = {}): CommercialNfeRouteDependencies {
  return {
    resolveIdentity: async (_env, actor) => options.identity ?? com1Identity(actor),
    checkGate: async () => {}, privacy: async () => ({ restricted_contact_ids: [] }), fetch: options.fetch,
    ...(options.authority ? { authority: async () => options.authority! } : {}),
  };
}

export function com1Request(operation: CommercialNfeOperation, overrides: Record<string, unknown> = {}): Request {
  const base: Record<string, unknown> = {
    command_id: COM1_TEST_IDS.command, expected_version: 1, expected_document_version: 1,
    environment: "homologacao", stock_timing: "existing", finance_timing: "existing", body_revision: 1, body_hash: "a".repeat(64),
    choices: { nature_id: COM1_TEST_IDS.nature, presence: "outros", final_consumer: true },
    axis: "stock", intent: "apply", justification: "Cancelamento de operação de ensaio.",
  };
  const input = { ...Object.fromEntries(operation.required.map(key => [key, base[key]])), ...overrides };
  const path = operation.path.replace(":id", COM1_TEST_IDS.emission);
  const query = operation.name === "com1.list" ? "?environment=homologacao" : "";
  return new Request(`https://wabotia.invalid/api/v1/profiles/com1/erp-comercial-nfe/${path}${query}`, {
    method: operation.method,
    ...(operation.method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  });
}

/** O stub HTTP de base não toca Env; dependências injetáveis tornam isso verificável. */
export const com1NoIoEnv = new Proxy({} as Env, { get() { throw new Error("com1_unexpected_io"); } });

export function com1WorkerClock(initial = Date.parse("2026-11-19T12:00:00.000Z")) {
  let current = initial;
  return { now: () => current, advance: (milliseconds: number) => { current += milliseconds; },
    sleep: async (milliseconds: number) => { current += milliseconds; } };
}

/** Recebe o provedor sob teste e o fetch do fake-vault; nunca escolhe fetch real. */
export function com1WorkerDependencies(provider: FiscalProvider, fetch: typeof globalThis.fetch): CommercialNfeDependencies {
  let sequence = 0;
  return { provider, fetch, clock: com1WorkerClock(),
    uuid: () => `77777777-7777-4777-8777-${String(++sequence).padStart(12, "0")}` };
}
