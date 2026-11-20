import type { Actor, Env } from "../types";
import type { ModuleContext } from "../modules/api";
import type {
  ContactMergeAvailability, CustomerChannelView, OtherChannelConversation,
} from "../channel-contracts";
import type {
  CustomerTarget, MaintenanceBudget, MaintenanceResult
} from "./contracts";

export type Json =
  | null | boolean | number | string
  | Json[] | { [key: string]: Json };

export interface ContactContribution {
  id: string;
  kind: "section" | "collection";
  title: string;
  titleKey?: "customers" | "works";
  component: "table" | "condominio.units" | "private.navigation" | "erp";
  source: string;
  policy: string;
  enabledWith?: readonly string[];
  columns?: readonly {
    key: string;
    label: string;
    format: "text" | "date" | "datetime" | "money" | "moneyCents" | "status";
  }[];
}

export interface ContactProfileDeclaration {
  contributions: readonly ContactContribution[];
  personTypes?: readonly {
    key: string;
    label: string;
    projection: "profile" | "private";
  }[];
}

export interface ContactProfileView {
  profileId: string;
  contactId: string;
  erpContactId: string | null;
  depth: "simple" | "full";
  vocabulary: { singular: string; plural: string };
  writable: boolean;
  /** false: acesso somente pelas contribuições autorizadas da extensão. */
  readable?: boolean;
  /** Namespace de integrações; ausência conserva o contrato team anterior. */
  namespace?: string;
  /** Edição local é independente da autorização de escrita no ERP. */
  localWritable?: boolean;
  /** Opcionais para compatibilidade com fichas/servidores anteriores à base de canais. */
  channels?: readonly CustomerChannelView[];
  /** Somente históricos que o ator pode ler; não amplia prova de identidade do cliente. */
  other_conversations?: readonly OtherChannelConversation[];
  merge?: ContactMergeAvailability;
  contributions: readonly (
    ContactContribution & { moduleId: string; writable: boolean }
  )[];
}

export interface ContactPage {
  items: {
    id: string;
    cells: Record<string, string | number | null>;
    target: CustomerTarget;
  }[];
  nextCursor: string | null;
  incomplete: boolean;
}

/** Linha do tempo da ficha: GET contacts/:id/timeline?limit=20&before=<ms>&key=<chave>. */
export type TimelineSource =
  | "conversation" | "ticket" | "queue" | "form" | "checkin"
  | "os" | "agenda" | "pedido" | "mensalidade" | "payment" | "erp";
export type TimelineFailureSource = "history" | "os" | "agenda" | "pedido" | "mensalidade" | "payment" | "erp";
export interface TimelineItem {
  source: TimelineSource;
  /** opened | stage | delivered | appointment | order | subscription | installment_paid | charge | paid | sale | kind do histórico. */
  event: string;
  /** Única e estável entre fontes; desempate do cursor. */
  key: string;
  occurredAt: number;
  /** Fonte com data sem hora (ERP): mostrar só o dia. */
  dateOnly?: boolean;
  title: string;
  status: string | null;
  statusLabel: string | null;
  /** Decimal em texto ("123.45"), nunca arredondado. */
  amount?: string | null;
  /** Horário marcado do agendamento. */
  scheduledAt?: number | null;
  target: CustomerTarget | null;
}
export interface TimelinePage {
  items: TimelineItem[];
  /** Próxima página: before=<ms>&key=<chave> do último item. */
  nextCursor: { before: number; key: string } | null;
  incomplete: boolean;
  /** Fontes que falharam agora; as demais vieram normalmente. */
  unavailable: { source: TimelineFailureSource; message: string }[];
}

export interface SectionView {
  version: number;
  writable: boolean;
  schema: "condominio.units.v1" | "private.navigation.v1";
  /** condominio.units.v1: snapshot {people,memberships,functions,subscriptions,personTypes}.
   * private.navigation.v1: {target:{module,resource:"home",id}}, sem conteúdo privado.
   * PUT de units recebe somente operações memberships/functions/subscriptions (até dez),
   * com expectedVersion por função; nunca reenvia o snapshot e seus rótulos. */
  data: Json;
}

export interface SectionWrite {
  commandId: string;
  expectedVersion: number;
  data: Json;
}

export interface CustomerModuleProvider {
  /** Valida acesso ao registro, sem devolver dados do domínio ao cadastro local. */
  authorizeProfile?(ctx: ModuleContext, actor: Actor, contactId: string): Promise<void>;
  /** Consulta de impedimentos sem conteúdo privado, inclusive com módulo desligado. */
  erasure?(env: Env, profileId: string, contactId: string): Promise<{ state: "retained"; reason: string } | null>;
  list?(
    ctx: ModuleContext, actor: Actor, contactId: string,
    collectionId: string, query: { limit: number; cursor?: string }
  ): Promise<ContactPage>;
  section?(
    ctx: ModuleContext, actor: Actor, contactId: string, sectionId: string
  ): Promise<SectionView>;
  saveSection?(
    ctx: ModuleContext, actor: Actor, contactId: string,
    sectionId: string, input: SectionWrite
  ): Promise<SectionView & { replayed: boolean }>;
  maintain?(
    env: Env, profileId: string, budget: MaintenanceBudget
  ): Promise<MaintenanceResult>;
}

export interface ProfilePort {
  view(
    env: Env, actor: Actor, profileId: string, contactId: string
  ): Promise<ContactProfileView>;
  collection(
    env: Env, actor: Actor, profileId: string, contactId: string,
    moduleId: string, collectionId: string,
    query: { limit: number; cursor?: string }
  ): Promise<ContactPage>;
  section(
    env: Env, actor: Actor, profileId: string, contactId: string,
    moduleId: string, sectionId: string
  ): Promise<SectionView>;
  saveSection(
    env: Env, actor: Actor, profileId: string, contactId: string,
    moduleId: string, sectionId: string, input: SectionWrite
  ): Promise<SectionView & { replayed: boolean }>;
}
