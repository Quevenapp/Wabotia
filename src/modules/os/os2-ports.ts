// Portas da parte 2. Os adaptadores planejam SQL; só o chamador confirma o lote.
// Os stubs recusam recursos novos e não consultam D1 no caminho legado.
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError, type Actor, type Conversation } from "../../types";
import type { ModuleContext, WebStep } from "../api";
import type { Answers } from "../../web-steps";
import type { ContactPage } from "../../customer/profile-contracts";
import type { ChildStatement, WorkOrderRow, AuthorizedOrder } from "./public";
import type { CustomWorkType, ExtraValues, FieldRef, Order, Page, WorkField, WorkTypeView, ServiceObjectSnapshot, ServiceObjectSnapshotView } from "./contracts";
import type { CreateInput } from "./store";

export interface ObjectAudience {
  kind: "staff" | "customer" | "bot" | "commercial";
  /** Permissões efetivas do administrador; ausência conserva a projeção conservadora. */
  allowed_field_ids?: string[];
  /** Só a política administrativa efetiva habilita campos internos/privados na IA. */
  ai_access?: { enabled: boolean; internal: boolean; sensitive: boolean };
}
export interface AtomicPlan {
  /** Guardas e inserções executadas antes da escrita do pai. */
  before: ChildStatement[];
  /** Índices, históricos e recibo executados depois, no mesmo batch. */
  after: ChildStatement[];
}
export interface ObjectOpeningPlan extends AtomicPlan {
  contact_id: string;
  object_id: string;
  snapshot: ServiceObjectSnapshot;
}
export interface ObjectOpeningContext {
  input: CreateInput;
  type: WorkTypeView;
  order_id: string;
  at: number;
  contact_id: string | null;
}
export interface RulesMutationInput {
  row: WorkOrderRow;
  type: WorkTypeView;
  sets: Readonly<Record<string, unknown>>;
  actor: string;
  /** Quando ausente, erros usam texto genérico sem revelar rótulos internos;
   * a leitura requirements fornece rótulos mediante autorização completa. */
  authority?: Actor;
  opening?: boolean;
  /** Verifica destino sem ativar requisitos nem persistir a aprovação. */
  preview?: boolean;
}
export interface RulesMutationPlan extends AtomicPlan {
  /** IDs ativados de forma permanente, gravados junto ao CAS. */
  stage_required?: string[];
}
export interface OrderFieldIndexInput {
  /** Na abertura number=0 é provisório: INSERTs de índice devem selecionar
   * number/type_number da os_orders já inserida dentro do mesmo lote. */
  row: WorkOrderRow;
  type: WorkTypeView;
  previous?: WorkOrderRow;
  opening?: boolean;
}
export interface WorkObjectContext {
  object_id: string;
  type_id: string;
  object_version: number;
  captured_at: number;
  origin: "opening" | "legacy_link";
  identifier: string;
  allowed_fields: Array<{ field: WorkField; value: ExtraValues[string] }>;
  equipment_text: string;
}
export interface ObjectContactMergeInput {
  profile_id: string;
  source_contact_id: string;
  target_contact_id: string;
  namespace: "team";
  actor: Actor;
  merge_key: string;
}
export interface ObjectContactMergePlan extends AtomicPlan {
  object_ids: string[];
  audit_refs: string[];
}
export interface FilteredOrderPage extends Page<Order> {
  counts: null;
  counts_scope: "not_computed";
  order_by: "number_desc" | "field_value_asc";
}
export type Os2ReadOperation = "os.object_types.list" | "os.objects.list" | "os.objects.get"
  | "os.objects.private.read" | "os.objects.orders" | "os.requirements" | "os.field_index.get"
  | "os.conversation.objects.list" | "os.conversation.objects.get";
export type Os2CommandOperation = "os.objects.create" | "os.objects.update" | "os.objects.archive"
  | "os.objects.private.update" | "os.object.link" | "os.field_index.rebuild";
export interface Os2RouteInput {
  params: Record<string, string>;
  query: Record<string, string>;
}
export interface Os2Adapters {
  openObjectForm(ctx: ModuleContext, conversation: Conversation, type: CustomWorkType, options: { trigger: "menu" | "agent" | "bot"; actor: string; sourceKey: string }): ReturnType<ModuleContext["openWebStep"]>;
  prepareObjectOpening(ctx: ModuleContext, input: ObjectOpeningContext): Promise<ObjectOpeningPlan>;
  /** Também reautoriza repetição; recibo nunca é autorização. */
  reauthorizeObjectOpening(ctx: ModuleContext, row: WorkOrderRow, input: CreateInput): Promise<void>;
  prepareLegacyObjectLink(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder, data: Record<string, unknown>, requestId: string): Promise<ObjectOpeningPlan>;
  projectObjectSnapshot(row: WorkOrderRow, audience: ObjectAudience): ServiceObjectSnapshotView | undefined;
  /** Autoriza contato e resolve política antes de chamar a projeção pura. */
  projectObjectForActor(ctx: ModuleContext, actor: Actor, row: WorkOrderRow): Promise<ServiceObjectSnapshotView | undefined>;
  /** Página já lida, com os2_contact_active calculado na mesma consulta.
   * Não buscar objeto por linha: definição/valores vêm exclusivamente da cópia.
   * Política/autorização é resolvida uma vez para o conjunto. */
  projectObjectPage(ctx: ModuleContext, actor: Actor, rows: readonly WorkOrderRow[]): Promise<ReadonlyMap<string, ServiceObjectSnapshotView>>;
  prepareOrderRulesMutation(ctx: ModuleContext, input: RulesMutationInput): Promise<RulesMutationPlan>;
  planOrderFieldIndex(ctx: ModuleContext, input: OrderFieldIndexInput): Promise<ChildStatement[]>;
  queryOrdersByField(ctx: ModuleContext, query: Record<string, string>, actor: Actor): Promise<FilteredOrderPage>;
  objectCustomerContribution(ctx: ModuleContext, actor: Actor, contactId: string, query: { limit: number; cursor?: string }): Promise<ContactPage>;
  prepareObjectWebStepCompletion(ctx: ModuleContext, step: WebStep, answers: Answers, options?: { resumeOnly?: boolean; definition?: unknown }): Promise<{ replayed: boolean; answers?: Answers } | null>;
  resumeObjectWebStepCompletion(ctx: ModuleContext, step: WebStep): Promise<void | string | false>;
  publicObjectLabel(row: WorkOrderRow): string;
  getWorkObjectContext(row: WorkOrderRow, audience: ObjectAudience): WorkObjectContext | undefined;
  planObjectContactMerge(ctx: ModuleContext, input: ObjectContactMergeInput): Promise<ObjectContactMergePlan>;
  /** Reservado; não invocado nesta parte. */
  planStageTasks(ctx: ModuleContext, input: RulesMutationInput): Promise<AtomicPlan>;
  read(ctx: ModuleContext, actor: Actor, operation: Os2ReadOperation, input: Os2RouteInput): Promise<unknown>;
  command(ctx: ModuleContext, actor: Actor, operation: Os2CommandOperation, data: Record<string, unknown>, meta: { requestId: string }): Promise<unknown>;
}
const unavailable = (): never => { throw new ApiError(501, "not_implemented", "Recurso de objetos e formulários por etapa ainda não disponível."); };
const emptyPlan = (): AtomicPlan => ({ before: [], after: [] });
const stubs: Os2Adapters = {
  openObjectForm: async () => unavailable(),
  prepareObjectOpening: async () => unavailable(),
  reauthorizeObjectOpening: async () => unavailable(),
  prepareLegacyObjectLink: async () => unavailable(),
  projectObjectSnapshot: row => row.object_id ? unavailable() : undefined,
  projectObjectForActor: async (_ctx, _actor, row) => row.object_id ? unavailable() : undefined,
  projectObjectPage: async (_ctx, _actor, rows) => rows.some(row => row.object_id) ? unavailable() : new Map(),
  prepareOrderRulesMutation: async (_ctx, input) => {
    if ((input.type.stage_field_rules?.length ?? 0) || (input.row.stage_required_json && input.row.stage_required_json !== "[]")) unavailable();
    return emptyPlan();
  },
  planOrderFieldIndex: async (_ctx, input) => {
    if (input.type.list_fields?.some(rule => rule.filter)) unavailable();
    return [];
  },
  queryOrdersByField: async () => unavailable(),
  objectCustomerContribution: async () => unavailable(),
  prepareObjectWebStepCompletion: async () => unavailable(),
  resumeObjectWebStepCompletion: async () => unavailable(),
  publicObjectLabel: row => row.object_id ? unavailable() : "",
  getWorkObjectContext: row => row.object_id ? unavailable() : undefined,
  planObjectContactMerge: async () => unavailable(),
  planStageTasks: async () => unavailable(),
  read: async () => unavailable(),
  command: async () => unavailable(),
};
// Escopo assíncrono: um teste/invocação nunca substitui adaptadores de outro.
// A integração final conecta os adaptadores de produção neste arquivo.
const installed = new AsyncLocalStorage<Os2Adapters>();
export function withOs2Adapters<T>(adapters: Partial<Os2Adapters>, run: () => T): T {
  return installed.run({ ...stubs, ...adapters }, run);
}
const adapters = () => installed.getStore() ?? stubs;
export const openObjectForm: Os2Adapters["openObjectForm"] = (...args) => adapters().openObjectForm(...args);
export const prepareObjectOpening: Os2Adapters["prepareObjectOpening"] = (...args) => adapters().prepareObjectOpening(...args);
export const reauthorizeObjectOpening: Os2Adapters["reauthorizeObjectOpening"] = (...args) => adapters().reauthorizeObjectOpening(...args);
export const prepareLegacyObjectLink: Os2Adapters["prepareLegacyObjectLink"] = (...args) => adapters().prepareLegacyObjectLink(...args);
export const projectObjectSnapshot: Os2Adapters["projectObjectSnapshot"] = (...args) => adapters().projectObjectSnapshot(...args);
export const projectObjectForActor: Os2Adapters["projectObjectForActor"] = (...args) => adapters().projectObjectForActor(...args);
export const projectObjectPage: Os2Adapters["projectObjectPage"] = (...args) => adapters().projectObjectPage(...args);
export const prepareOrderRulesMutation: Os2Adapters["prepareOrderRulesMutation"] = (...args) => adapters().prepareOrderRulesMutation(...args);
export const planOrderFieldIndex: Os2Adapters["planOrderFieldIndex"] = (...args) => adapters().planOrderFieldIndex(...args);
export const queryOrdersByField: Os2Adapters["queryOrdersByField"] = (...args) => adapters().queryOrdersByField(...args);
export const objectCustomerContribution: Os2Adapters["objectCustomerContribution"] = (...args) => adapters().objectCustomerContribution(...args);
export const prepareObjectWebStepCompletion: Os2Adapters["prepareObjectWebStepCompletion"] = (...args) => adapters().prepareObjectWebStepCompletion(...args);
export const resumeObjectWebStepCompletion: Os2Adapters["resumeObjectWebStepCompletion"] = (...args) => adapters().resumeObjectWebStepCompletion(...args);
export const publicObjectLabel: Os2Adapters["publicObjectLabel"] = (...args) => adapters().publicObjectLabel(...args);
export const getWorkObjectContext: Os2Adapters["getWorkObjectContext"] = (...args) => adapters().getWorkObjectContext(...args);
export const planObjectContactMerge: Os2Adapters["planObjectContactMerge"] = (...args) => adapters().planObjectContactMerge(...args);
export const planStageTasks: Os2Adapters["planStageTasks"] = (...args) => adapters().planStageTasks(...args);
export const os2Read: Os2Adapters["read"] = (...args) => adapters().read(...args);
export const os2Command: Os2Adapters["command"] = (...args) => adapters().command(...args);
