import type { Actor, Conversation, Env } from "../types";

export type Namespace = "team" | `app:${string}`;
export type Statement = [sql: string, params: unknown[]];
export type LinkState =
  | "ready" | "pending" | "ambiguous" | "blocked" | "excluded";

export interface CustomerRef {
  profileId: string;
  namespace: Namespace;
  state: LinkState;
  contactId: string | null;
  verifiedPhone: string | null;
  version: number | null;
  erp: { id: string; version: number } | null;
}

export interface CustomerMirror {
  name: string;
  phones: readonly string[];
  email: string;
  document: string | null;
  personType: "F" | "J" | "E" | null;
}

export interface CustomerAddress {
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface CustomerPatch {
  name?: string;
  phones?: readonly string[];
  email?: string;
  document?: string | null;
  personType?: "F" | "J" | "E" | null;
  address?: CustomerAddress;
}

export interface CustomerWrite {
  commandId: string;
  expectedVersion: number;
  expectedErpVersion: number | null;
  patch: CustomerPatch;
  mode: "fill_empty" | "replace_confirmed";
}

export type JobState =
  | "pending" | "running" | "paused" | "conflict"
  | "done" | "retained" | "cancelled";

export interface CustomerWriteResult {
  contactId: string;
  version: number;
  jobId: string | null;
  state: JobState;
  pending: boolean;
}

export interface CustomerJobView {
  id: string;
  contactId: string | null;
  state: JobState;
  errorCode: string | null;
  missingFields: readonly string[];
  reason?: string | null;
  updated?: number;
  progress?: { processed: number; imported: number; skipped: number; total: number };
}

export interface InboundEvidence {
  provider: "zernio" | "qr" | "meta";
  phone: string | null;
  phoneJid?: string;
}

export interface IdentityPlan {
  statements: Statement[];
  state: LinkState;
  verifiedPhone: string | null;
}

export interface MaintenanceBudget {
  remainingStatements: number;
  remainingItems: number;
}

export interface MaintenanceResult {
  pending: boolean;
  statements: number;
  items: number;
}

export interface IdentityPort {
  /** Plano sem I/O, confirmado no mesmo lote da origem. null pede o adaptador de leitura. */
  recordLink?(conversation: Conversation, link: Omit<CustomerRecordLink, "contactId">): Statement[];
  resolve(env: Env, conversation: Conversation): Promise<CustomerRef>;
  prepareInbound(
    env: Env, conversation: Conversation, evidence: InboundEvidence
  ): Promise<IdentityPlan>;
  indexContact(
    env: Env,
    input: {
      profileId: string;
      namespace: Namespace;
      contactId: string;
      phones: readonly string[];
      origin: "local" | "observed" | "mirror";
    }
  ): Promise<Statement[]>;
  maintain(
    env: Env, profileId: string, budget: MaintenanceBudget
  ): Promise<MaintenanceResult>;
}

export interface CustomerRecordLink {
  profileId: string;
  contactId: string;
  moduleId: string;
  kind: string;
  recordId: string;
  conversationId: string | null;
  linkedBy: string;
  occurredAt: number;
}

export interface HistoryQuery {
  limit?: number;
  cursor?: string;
}

export interface CustomerTarget {
  module: string;
  resource: string;
  id: string;
}

export interface HistoryItem {
  kind: "conversation" | "ticket" | "queue" | "form" | "checkin";
  sourceKey: string;
  occurredAt: number;
  status: string;
  topicCode: "previous_service" | "pending_action" | null;
  target: CustomerTarget | null;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
  incomplete: boolean;
}

export interface CustomerMemory {
  previousInteractions: number;
  pendingActions: number;
  lastInteractionAt: number | null;
  topicCode: "previous_service" | null;
}

export interface HistoryPort {
  read(
    env: Env, actor: Actor, profileId: string,
    target: { contactId: string } | { conversationId: string },
    query: HistoryQuery
  ): Promise<HistoryPage>;
  memory(
    env: Env, actor: Actor, conversation: Conversation
  ): Promise<CustomerMemory>;
  maintain(
    env: Env, profileId: string, budget: MaintenanceBudget
  ): Promise<MaintenanceResult>;
}

export interface WritePort {
  enrich(
    env: Env, actor: Actor, profileId: string,
    contactId: string, input: CustomerWrite
  ): Promise<CustomerWriteResult>;
  maintain(
    env: Env, profileId: string, budget: MaintenanceBudget
  ): Promise<MaintenanceResult>;
}

export interface BridgeSnapshot {
  erpId: string;
  erpVersion: number;
  mirror: CustomerMirror;
}

export interface BridgeCommand {
  profileId: string;
  namespace: Namespace;
  contactId: string;
  commandId: string;
  requestHash: string;
  actor: Actor;
  operation: "promote" | "patch" | "bind";
  erpId: string | null;
  expectedErpVersion: number | null;
  patch: CustomerPatch;
  /** Versão do espelho usado na comparação de três versões; não é o CAS remoto. */
  baseErpVersion?: number | null;
  expectedVersion?: number;
}

export type BridgeResult =
  | { status: "applied"; snapshot: BridgeSnapshot; replayed: boolean }
  | { status: "needs_data"; fields: readonly string[] }
  | { status: "conflict"; candidateIds: readonly string[] }
  | { status: "paused"; reason: "module_disabled" | "awaiting_proof" };

export interface CustomerErpBridge {
  apply(env: Env, command: BridgeCommand): Promise<BridgeResult>;
  read(
    env: Env, actor: Actor, profileId: string, erpId: string
  ): Promise<BridgeSnapshot>;
  scan(
    env: Env, profileId: string, cursor: string | null, limit: number
  ): Promise<{ items: BridgeSnapshot[]; nextCursor: string | null }>;
}

export interface CustomerModuleApi {
  customer(conversation: Conversation): Promise<CustomerRef>;
  enrichCustomer(
    actor: Actor, conversation: Conversation, input: CustomerWrite
  ): Promise<CustomerWriteResult>;
}
