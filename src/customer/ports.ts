import { ApiError, type Actor, type Conversation, type Env } from "../types";
import { hasReadCache } from "../db";
import type {
  CustomerErpBridge, CustomerRecordLink, CustomerRef,
  CustomerWrite, CustomerWriteResult, HistoryPort,
  IdentityPort, MaintenanceBudget, MaintenanceResult,
  Namespace, Statement, WritePort,
} from "./contracts";
import type { CustomerModuleProvider, ProfilePort } from "./profile-contracts";

function unavailable(): never {
  throw new ApiError(503, "dependency_unavailable", "Cadastro de clientes indisponível.");
}

function registration<T>(name: string, previous: T | null, next: T): T {
  if (previous !== null && previous !== next)
    throw new Error(`Implementação de ${name} já registrada.`);
  return next;
}

// Implementações embutidas são defaults. Uma composição explícita pode substituí-las
// sem depender da ordem de importação; duas implementações explícitas continuam erro.
type Installation = { default: true };
const defaults = new Map<string, unknown>();
const overrides = new Map<string, unknown>();
function install<T>(name: string, next: T, options?: Installation): T {
  const registry = options?.default ? defaults : overrides;
  registry.set(name, registration(name, registry.get(name) as T ?? null, next));
  return (overrides.get(name) ?? defaults.get(name)) as T;
}

let identity: IdentityPort | null = null;
let writer: WritePort | null = null;
let history: HistoryPort | null = null;
let profile: ProfilePort | null = null;
let bridge: CustomerErpBridge | null = null;
const providers = new Map<string, CustomerModuleProvider>();

// Só guarda resultados no Env derivado por withReadCache, nunca no Env global.
let resolutions = new WeakMap<Env, Map<string, Promise<CustomerRef>>>();
const invalidate = (env: Env) => resolutions.delete(env);

export function installIdentityPort(port: IdentityPort, options?: Installation): void {
  identity = install("identidade", port, options);
  resolutions = new WeakMap();
}
export function installWritePort(port: WritePort, options?: Installation): void {
  writer = install("escrita cadastral", port, options);
}
export function installHistoryPort(port: HistoryPort, options?: Installation): void {
  history = install("histórico", port, options);
}
export function installProfilePort(port: ProfilePort, options?: Installation): void {
  profile = install("ficha", port, options);
}
export function installErpBridge(port: CustomerErpBridge, options?: Installation): void {
  bridge = install("ponte ERP", port, options);
}

const pendingMaintenance = (): MaintenanceResult => ({ pending: true, statements: 0, items: 0 });

/** Objetos permanentes: uma referência capturada antes do registro segue válida. */
export const identityPort: IdentityPort = {
  get recordLink() { return identity?.recordLink; },
  async resolve(env, conversation) {
    if (identity) return identity.resolve(env, conversation);
    return {
      profileId: conversation.profile_id,
      namespace: conversation.external_namespace.startsWith("app:")
        ? conversation.external_namespace as Namespace : "team",
      state: "pending", contactId: null, verifiedPhone: null, version: null, erp: null,
    };
  },
  async prepareInbound(env, conversation, evidence) {
    invalidate(env);
    try {
      return identity ? await identity.prepareInbound(env, conversation, evidence)
        : { statements: [], state: "pending", verifiedPhone: null };
    } finally { invalidate(env); }
  },
  async indexContact(env, input) {
    invalidate(env);
    try { return identity ? await identity.indexContact(env, input) : unavailable(); }
    finally { invalidate(env); }
  },
  async maintain(env, profileId, budget) {
    invalidate(env);
    try { return identity ? await identity.maintain(env, profileId, budget) : pendingMaintenance(); }
    finally { invalidate(env); }
  },
};

export const writePort: WritePort = {
  async enrich(env, actor, profileId, contactId, input) {
    invalidate(env);
    try { return writer ? await writer.enrich(env, actor, profileId, contactId, input) : unavailable(); }
    finally { invalidate(env); }
  },
  async maintain(env, profileId, budget) {
    invalidate(env);
    try { return writer ? await writer.maintain(env, profileId, budget) : unavailable(); }
    finally { invalidate(env); }
  },
};

export const historyPort: HistoryPort = {
  async read(...args) { return history ? history.read(...args) : unavailable(); },
  async memory(...args) { return history ? history.memory(...args) : unavailable(); },
  async maintain(...args) { return history ? history.maintain(...args) : unavailable(); },
};

export const profilePort: ProfilePort = {
  async view(...args) { return profile ? profile.view(...args) : unavailable(); },
  async collection(...args) { return profile ? profile.collection(...args) : unavailable(); },
  async section(...args) { return profile ? profile.section(...args) : unavailable(); },
  async saveSection(...args) { return profile ? profile.saveSection(...args) : unavailable(); },
};

export const erpBridge: CustomerErpBridge = {
  async apply(...args) {
    return bridge ? bridge.apply(...args) : { status: "paused", reason: "awaiting_proof" };
  },
  async read(...args) { return bridge ? bridge.read(...args) : unavailable(); },
  async scan(...args) { return bridge ? bridge.scan(...args) : unavailable(); },
};

export async function resolveCustomer(env: Env, conversation: Conversation): Promise<CustomerRef> {
  if (!hasReadCache(env)) return identityPort.resolve(env, conversation);
  let cache = resolutions.get(env);
  if (!cache) resolutions.set(env, cache = new Map());
  // Qualquer mudança observável da conversa invalida a chave, inclusive a sessão.
  const key = JSON.stringify(conversation);
  let result = cache.get(key);
  if (!result) {
    result = identityPort.resolve(env, conversation);
    cache.set(key, result);
    const captured = result;
    result.catch(() => { if (cache.get(key) === captured) cache.delete(key); });
  }
  const ref = await result;
  return { ...ref, erp: ref.erp ? { ...ref.erp } : null };
}

export async function enrichCustomer(
  env: Env, actor: Actor, conversation: Conversation, input: CustomerWrite,
): Promise<CustomerWriteResult> {
  if (!writer) return unavailable();
  const ref = await resolveCustomer(env, conversation);
  const namespace = conversation.external_namespace.startsWith("app:")
    ? conversation.external_namespace : "team";
  if (ref.profileId !== conversation.profile_id || ref.namespace !== namespace || ref.state === "excluded")
    throw new ApiError(404, "not_found", "Contato não encontrado.");
  if (ref.state === "ambiguous")
    throw new ApiError(409, "customer_ambiguous", "Resolva a identidade do contato antes de completar o cadastro.");
  if (ref.state !== "ready" || !ref.contactId)
    throw new ApiError(422, "contact_required", "Vincule um contato antes de completar o cadastro.");
  return writePort.enrich(env, actor, ref.profileId, ref.contactId, input);
}

/**
 * Executar TODAS as instruções no mesmo lote da gravação de origem.
 * Somente fontes sem contact_id próprio. Não resolve nem transfere vínculos.
 */
export function customerRecordStatements(link: CustomerRecordLink): Statement[] {
  const key = [link.profileId, link.moduleId, link.kind, link.recordId];
  // A origem estável identifica a operação; o sufixo identifica a etapa.
  const guard = `customer-record:${JSON.stringify(key)}:contact`;
  return [
    [
      `INSERT INTO customer_records
        (profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(profile_id,module_id,kind,record_id) DO NOTHING`,
      [...key, link.contactId, link.conversationId, link.linkedBy, link.occurredAt],
    ],
    [
      `INSERT INTO customer_assert(id,ok)
       VALUES(?,CASE WHEN EXISTS(
         SELECT 1 FROM customer_records
         WHERE profile_id=? AND module_id=? AND kind=? AND record_id=? AND contact_id=?
       ) THEN 1 ELSE 0 END)
       ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
      [guard, ...key, link.contactId],
    ],
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ];
}

export function registerCustomerProvider(moduleId: string, provider: CustomerModuleProvider): void {
  providers.set(moduleId, registration(`provedor ${moduleId}`, providers.get(moduleId) ?? null, provider));
}
export function customerProvider(moduleId: string): CustomerModuleProvider | null {
  return providers.get(moduleId) ?? null;
}
export async function customerRetention(env: Env, profileId: string, contactId: string) {
  const reasons = new Set<string>();
  for (const provider of providers.values()) {
    const impediment = await provider.erasure?.(env, profileId, contactId);
    if (impediment?.state === "retained") reasons.add(impediment.reason);
  }
  return [...reasons];
}

/**
 * Só a invocação dedicada do Coordinator deve chamar esta fachada. Participantes
 * recebem o saldo e retornam consumo efetivo; o orquestrador debita uma vez.
 * Não chama a ponte ERP nem importa implementações para completar registros.
 */
export async function maintainCustomers(
  env: Env, profileId: string, budget: MaintenanceBudget, startAt = 0,
): Promise<MaintenanceResult> {
  if (![budget.remainingStatements, budget.remainingItems].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new ApiError(400, "invalid_request", "Orçamento de manutenção inválido.");
  const remaining = {
    remainingStatements: Math.min(40, budget.remainingStatements),
    remainingItems: Math.min(20, budget.remainingItems),
  };
  const result: MaintenanceResult = { pending: !identity || !writer || !history, statements: 0, items: 0 };
  const participants = [
    ...(identity ? [identityPort] : []),
    ...(writer ? [writePort] : []),
    ...(history ? [historyPort] : []),
    ...[...providers.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, provider]) => provider).filter((provider) => provider.maintain),
  ];
  const offset = participants.length ? Math.abs(Math.trunc(startAt)) % participants.length : 0;
  for (const participant of [...participants.slice(offset), ...participants.slice(0, offset)]) {
    if (!remaining.remainingStatements || !remaining.remainingItems) {
      result.pending = true;
      break;
    }
    const consumed = await participant.maintain!(env, profileId, { ...remaining });
    if (!Number.isSafeInteger(consumed.statements) || consumed.statements < 0 ||
        !Number.isSafeInteger(consumed.items) || consumed.items < 0 ||
        consumed.statements > remaining.remainingStatements || consumed.items > remaining.remainingItems)
      throw new Error("Participante excedeu o orçamento de manutenção cadastral.");
    remaining.remainingStatements -= consumed.statements;
    remaining.remainingItems -= consumed.items;
    result.statements += consumed.statements;
    result.items += consumed.items;
    result.pending ||= consumed.pending;
  }
  return result;
}
