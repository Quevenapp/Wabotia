// Contrato público congelado por F0. Só tipos e constantes; regras ficam em M.
export type BaseStatus =
  | "received"
  | "analyzing"
  | "quoted"
  | "approved"
  | "declined"
  | "in_progress"
  | "ready"
  | "delivered"
  | "cancelled";

export type FieldValue = string | number | boolean | null;
export type ExtraValues = Record<string, FieldValue>;
export interface FieldBase {
  id: string;
  label: string;
  help: string;
  required: boolean;
  client_visible: boolean;
  sensitive: boolean;
}
export type WorkField =
  | (FieldBase & { kind: "text"; multiline: boolean; max_length: number })
  | (FieldBase & { kind: "integer"; min: number; max: number })
  | (FieldBase & { kind: "decimal"; min: number; max: number; scale: number })
  | (FieldBase & { kind: "boolean" })
  | (FieldBase & { kind: "date"; min: string | null; max: string | null })
  | (FieldBase & {
      kind: "choice";
      options: Array<{ id: string; label: string }>;
    });
export interface ServiceObjectType {
  schema_version: 1;
  id: string;
  revision: number;
  archived: boolean;
  labels: { singular: string; plural: string };
  identifier_field_id: string;
  fields: WorkField[];
  retired_field_ids: string[];
}
export interface FieldRef {
  scope: "order" | "object";
  field_id: string;
}
export interface StageFieldRule {
  field_id: string;
  required_from_stage?: string;
  required_on_exit?: string[];
}
export interface ListFieldRule {
  ref: FieldRef;
  column?: boolean;
  filter?: boolean;
}
export interface Os2WorkTypeAdditions {
  object_type_id?: string;
  stage_field_rules?: StageFieldRule[];
  list_fields?: ListFieldRule[];
}
export interface ServiceObjectSnapshot {
  schema_version: 1;
  object_id: string;
  object_version: number;
  captured_at: number;
  origin: "opening" | "legacy_link";
  type: ServiceObjectType;
  values: ExtraValues;
}
/** Definição e valores já filtrados para a audiência; nunca uma linha D1. */
export interface ServiceObjectSnapshotView {
  schema_version: 1;
  object_id: string;
  object_version: number;
  captured_at: number;
  origin: "opening" | "legacy_link";
  type: Pick<ServiceObjectType, "schema_version" | "id" | "revision" | "labels" | "fields"> & { identifier_field_id?: string };
  values: ExtraValues;
  identifier: string;
}
export interface ServiceObject {
  id: string;
  profile_id: string;
  contact_id: string;
  type_id: string;
  type_revision: number;
  type: ServiceObjectType;
  values: ExtraValues;
  archived: boolean;
  version: number;
  identifier: string;
  created_by: string;
  updated_by: string;
  created: number;
  updated: number;
}
export interface ServiceObjectView {
  id: string;
  contact_id?: string;
  type_id: string;
  type_revision: number;
  type: ServiceObjectSnapshotView["type"];
  values: ExtraValues;
  archived: boolean;
  version: number;
  identifier: string;
  created: number;
  updated: number;
  latest_completed?: { id: string; number: number; delivered_at: number | null } | null;
}
export type ObjectOpeningRequest =
  | { mode: "existing"; id: string; version: number }
  | { mode: "new"; type_id: string; values: ExtraValues };
export interface CreateServiceObjectRequest {
  contact_id: string;
  type_id: string;
  values: ExtraValues;
}
export interface UpdateServiceObjectRequest {
  version: number;
  values?: ExtraValues;
  /** Adoção explícita da revisão atual, com validação dos valores resultantes. */
  adopt_revision?: number;
}
export interface ArchiveServiceObjectRequest { version: number; archived: boolean }
export interface LegacyObjectLinkRequest { version: number; object: ObjectOpeningRequest }
export interface ObjectTypeCatalog { data: ServiceObjectType[]; settings_revision: string }
export interface ObjectQuery extends PageQuery {
  contact_id: string;
  type_id?: string;
  include_archived?: "1" | "0";
}
export interface ObjectPrivateFields { id: string; version: number; fields: WorkField[]; values: ExtraValues }
export interface ObjectPrivateFieldsRequest { version: number; values: ExtraValues }
export interface OrderRequirements {
  id: string;
  version: number;
  transition_id?: string;
  required: Array<{ field_id: string; label: string }>;
  missing: Array<{ field_id: string; label: string }>;
  internal_missing: boolean;
}
export type OrderFieldFilter =
  | { ref: FieldRef; operator: "eq"; value: Exclude<FieldValue, null> }
  | { ref: FieldRef; operator: "range"; from: string | number; to: string | number };
export interface FieldIndexState {
  type_id: string;
  generation: string;
  status: "building" | "ready";
  cursor_number: number;
  ceiling_number: number;
  excluded_count: number;
  updated: number;
}
export interface FieldIndexRebuildRequest { generation?: string; cursor_number?: number }
export interface WorkStage {
  id: string;
  label: string;
  base_status: BaseStatus;
  message: string;
}
export interface TransitionBase {
  id: string;
  from: string;
  to: string;
  label: string;
}
export type WorkTransition =
  | (TransitionBase & { kind: "manual" })
  | (TransitionBase & {
      kind: "customer_approval";
      valid_hours: number;
      request_text: string;
    });
export interface WorkQuotePolicy {
  default_valid_days: number;
  source_stages: string[];
  sent_stage: string;
  approved_stage: string;
  declined_stage: string;
  edited_stage: string;
}
export interface WorkFeatures {
  customer_open: boolean;
  tasks: boolean;
  people: boolean;
  documents: boolean;
  entries: boolean;
  quote: WorkQuotePolicy | null;
  warranty_days: number;
  pickup_reminder_days: number;
  stale_days: number;
  /** OS5: só entrega com nota fiscal autorizada (de serviço ou de peças). Ausente: a ordem nunca espera a nota. */
  require_invoice_to_deliver?: boolean;
}
export interface WorkLabels {
  singular: string;
  plural: string;
  item: string;
  problem: string;
  customer_singular: string;
  customer_plural: string;
}
export interface CustomWorkType extends Os2WorkTypeAdditions {
  schema_version: 1;
  kind: "custom";
  id: string;
  revision: number;
  archived: boolean;
  labels: WorkLabels;
  number_prefix: string;
  terms: string | null;
  fields: WorkField[];
  retired_field_ids: string[];
  stages: WorkStage[];
  retired_stage_ids: string[];
  initial_stage: string;
  transitions: WorkTransition[];
  features: WorkFeatures;
  pickup_reminder_text: string;
}
export interface BuiltinWorkType {
  schema_version: 1;
  kind: "builtin";
  id: "service_order";
  revision: 1;
}
export type WorkType = BuiltinWorkType | CustomWorkType;
export const BUILTIN_WORK_TYPE: BuiltinWorkType = {
  schema_version: 1,
  kind: "builtin",
  id: "service_order",
  revision: 1,
};
export interface WorkTypeSnapshot {
  schema_version: 1;
  type: CustomWorkType;
}
export interface OsVocabulary {
  collection_label: string;
  customer_singular: string;
  customer_plural: string;
}
export interface WorkTypeSettings {
  os_work_types?: CustomWorkType[];
  os_object_types?: ServiceObjectType[];
  os2_ai_access?: Os2AiAccess;
  os_vocabulary?: OsVocabulary;
}
/** Concessão administrativa explícita; todas as opções começam desligadas. */
export interface Os2AiAccess { enabled: boolean; internal: boolean; sensitive: boolean }
export interface PendingStageApproval {
  version: number;
  transition_id: string;
  from_stage: string;
  to_stage: string;
  state: "pending" | "approved" | "declined" | "expired" | "cancelled";
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
}
export interface WorkOrderAdditions {
  object?: ServiceObjectSnapshotView;
  type_id: string;
  type_revision: number;
  type_number: number;
  type_label: string;
  type_plural_label: string;
  display_number: string;
  stage: string;
  stage_label: string;
  labels: WorkLabels;
  extra: ExtraValues;
  fields: WorkField[];
  version: number;
  features?: WorkFeatures;
  next_task?: { id: string; title: string; due_at: number | null } | null;
  next_stages: Array<{
    transition_id: string;
    stage: string;
    stage_label: string;
    base_status: BaseStatus;
    kind: WorkTransition["kind"];
  }>;
  stage_approval: PendingStageApproval | null;
}

// Seção 5. As tabelas especificam os campos; estes nomes completam os DTOs.
export type WorkTypeView =
  | CustomWorkType
  | (BuiltinWorkType & Omit<CustomWorkType, "kind" | "id" | "revision">);
export interface MutationRef {
  id: string;
  order_id: string;
  version: number;
}
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}
export interface VersionRequest {
  version: number;
}
export interface PageQuery {
  cursor?: string;
  limit?: number;
}
export interface QuoteItem {
  /** Omitido por clientes legados; atribuído uma vez ao persistir a linha. */
  id?: string;
  description: string;
  quantity: number;
  unit_cents: number;
  unit?: string;
  kind?: "material" | "service" | "free";
  /** Associação explícita já existente na tabela auxiliar de catálogo. */
  product_id?: string | null;
  /** OS3: desconto da linha em centavos (até o valor bruto da linha). */
  discount_cents?: number;
  /** OS3: código do catálogo, só para mostrar e imprimir; nunca prova vínculo. */
  code?: string | null;
  /** OS4: item coberto pelo contrato de manutenção (sempre com valor zero). */
  covered?: boolean;
}
/** OS3: condições combinadas no orçamento (pagador, forma e parcelas). */
export interface QuoteTerms {
  /** Contato do cadastro que paga; null usa o cliente da ordem. */
  payer_contact_id: string | null;
  payer_name: string;
  /** Forma escolhida: lista do ERP (payment_method_id) ou uma das genéricas. */
  method: "cash" | "pix" | "card" | "boleto" | "transfer" | "other" | null;
  payment_method_id: string | null;
  method_label: string;
  /** Sem Financeiro ligado o servidor guarda só o total, sem parcelas. */
  installments: { count: number; first_due_on: string; interval_days: number } | null;
}
/** OS3: aprovação ou recusa registrada pela equipe, com quem e quando. */
export interface DecisionDetail {
  /** Nome de quem respondeu (cliente, responsável) como a pessoa informou. */
  by_name: string;
  /** Instante informado da resposta, em milissegundos. */
  at: number;
  channel: "whatsapp" | "phone" | "counter" | "email" | "other";
  reason: string;
}
export interface QuoteInstallmentView { number: number; due_on: string; amount_cents: number }
export interface OrderHistory {
  id: string;
  kind: string;
  from_status: BaseStatus | null;
  to_status: BaseStatus | null;
  actor: string;
  note?: string;
  created: number;
  from_stage?: string | null;
  to_stage?: string | null;
  entity_kind?: ChildKind | null;
  entity_id?: string | null;
  entity_version?: number | null;
  mutation_key?: string | null;
  changed_fields?: string[];
}
export interface Order extends WorkOrderAdditions {
  id: string;
  number: number;
  status: BaseStatus;
  status_label: string;
  customer: {
    name: string;
    phone?: string;
    contact_id?: string | null;
    conversation_id?: string | null;
  };
  item: string;
  problem: string;
  notes?: string;
  assignee?: string | null;
  due_at: number | null;
  /** OS4: só na lista, horário efetivo da execução agendada (ou null). */
  scheduled_at?: number | null;
  source: "agent" | "panel" | "customer" | "api";
  terms: { text: string; accepted_at: number } | null;
  quote: {
    items: QuoteItem[];
    total_cents: number;
    note: string;
    valid_days: number;
    valid_until: number | null;
    sent_at: number | null;
    version: number;
    expired: boolean;
    /** OS3: soma bruta das linhas, descontos das linhas e desconto no total. */
    subtotal_cents?: number;
    items_discount_cents?: number;
    discount_cents?: number;
    terms?: QuoteTerms | null;
    /** OS3: parcelas calculadas das condições (vazio sem parcelas). */
    installments?: QuoteInstallmentView[];
    /** OS3: aprovado e ainda não reaberto; mudar exige reabrir com motivo. */
    locked?: boolean;
  } | null;
  decision: {
    decision: "approved" | "declined";
    at: number;
    by: string;
    via: string;
    detail?: DecisionDetail | null;
  } | null;
  ready_at: number | null;
  delivered_at: number | null;
  warranty_until: number | null;
  next_statuses: BaseStatus[];
  created_by?: string;
  created: number;
  updated: number;
  history?: OrderHistory[];
}
export interface OrderList extends Page<Order> {
  counts: Partial<Record<BaseStatus, number>>;
  facets?: { types: Record<string, number>; stages?: Record<string, number> };
}
/** Opt-in: somente consultas com field_filter recebem contagem não calculada. */
export interface FieldFilteredOrderList extends Page<Order> {
  counts: null;
  counts_scope: "not_computed";
  order_by: "number_desc" | "field_value_asc";
}
export interface WorkTypeCatalog {
  data: WorkTypeView[];
  settings_revision: string;
}
export interface CreateOrderRequest {
  contact_id?: string;
  object?: ObjectOpeningRequest;
  conversation_id?: string | null;
  customer_name?: string;
  phone?: string;
  item: string;
  problem: string;
  notes?: string;
  assignee?: string | null;
  due_at?: number | null;
  notify?: boolean;
  type_id?: string;
  extra?: ExtraValues;
}
export interface UpdateOrderRequest {
  customer_name?: string;
  phone?: string;
  item?: string;
  problem?: string;
  notes?: string;
  assignee?: string | null;
  due_at?: number | null;
  extra?: ExtraValues;
  version?: number;
}
export interface StatusRequest {
  status: BaseStatus;
  note?: string;
}
export interface StageRequest extends VersionRequest {
  transition_id: string;
  note?: string;
}
export interface QuoteRequest {
  version?: number;
  items: QuoteItem[];
  note?: string;
  valid_days?: number;
  /** OS3: desconto no total, em centavos. */
  discount_cents?: number;
  /** OS3: condições; ausente preserva as anteriores, null apaga. */
  terms?: Partial<QuoteTerms> | null;
  /** OS3: pessoa confirma que o pagador é adulto (modelos reservados). */
  adult_payer_confirmed?: boolean;
}
export interface QuoteSendRequest {
  notify?: boolean;
}
export interface DecisionRequest {
  decision: "approve" | "decline";
  note?: string;
  quote_version?: number;
  /** OS3: quem respondeu, quando e por onde (registro à mão pela equipe). */
  detail?: { by_name: string; at?: number; channel?: DecisionDetail["channel"] };
}
/** OS3: reabrir o orçamento aprovado (com motivo, fica no histórico). */
export interface QuoteReopenRequest { version: number; reason: string }
export type ReceiptMethod = "cash" | "pix" | "card" | "other" | "unknown";
export interface ReceiptRequest { amount_cents: number; method: ReceiptMethod; occurred_at?: number; note?: string }
export interface ChargeRequestInput { method: "pix" | "link"; amount_cents?: number }
export interface OrderReceipt {
  receipt_key: string; kind: "receive" | "reverse"; evidence: "provider" | "manual";
  amount_cents: number; method: ReceiptMethod; occurred_ms: number; actor_id: string | null;
}
export interface OrderCharge {
  id: string; method: string; status: string; amount_cents: number; url: string | null;
  pix_code: string | null; expires_at: number | null; created: number;
}
export interface OrderPayments {
  id: string; version: number; total_cents: number; received_cents: number; balance_cents: number;
  receipts: OrderReceipt[]; charges: OrderCharge[];
  /** Cobrança pela área: pronta, motivo e meios (Pix, link). */
  provider: { ready: boolean; message: string; methods: string[] };
  /** ERP: Financeiro ligado e conta a receber criada para esta ordem. */
  finance: { enabled: boolean; obligation: boolean };
  /** Partes do ERP em uso pela ordem (Produtos e serviços, Financeiro). */
  parts: { products: boolean; finance: boolean };
  /** Vínculo de catálogo de cada linha do orçamento (id da linha → produto). */
  catalog_links: Record<string, { erp_item_id: string; version: number }>;
  /** reserved: modelo de área sensível; documento e impressão genéricos. */
  privacy: "commercial" | "reserved";
}
export interface StageApprovalRequest extends VersionRequest {
  transition_id: string;
}
export interface StageApprovalDecisionRequest extends VersionRequest {
  decision: "approve" | "decline";
  approval_version: number;
}
export interface PrivateFields extends VersionRequest {
  id: string;
  extra: ExtraValues;
  fields: WorkField[];
}
export interface PrivateFieldsRequest extends VersionRequest {
  extra: ExtraValues;
}
export interface PrivateFieldsResult extends VersionRequest {
  id: string;
  changed_fields: string[];
}

export type ChildKind = "task" | "person" | "document" | "entry";
export interface ChildVisibility {
  client_visible: boolean;
  sensitive: boolean;
}
export interface ChildRecord extends MutationRef, ChildVisibility {
  created_by?: string;
  created: number;
  updated: number;
  archived_at: number | null;
}
export interface CreateTaskRequest extends ChildVisibility {
  title: string;
  description?: string;
  assignee?: string | null;
  audience: "staff" | "customer";
  due_at?: number | null;
  remind_at?: number | null;
}
export type TaskState = "open" | "done" | "cancelled";
export interface Task extends ChildRecord {
  title: string;
  description: string;
  assignee: string | null;
  audience: "staff" | "customer";
  due_at: number | null;
  remind_at: number | null;
  state: TaskState;
  notified_at: number | null;
  completed_at: number | null;
}
export interface UpdateTaskRequest
  extends Partial<CreateTaskRequest>, VersionRequest {
  state?: TaskState;
}
export interface TaskQuery extends PageQuery {
  state?: TaskState;
}
export interface CreatePersonRequest extends ChildVisibility {
  role: string;
  name: string;
  contact_id?: string | null;
  phone?: string;
  email?: string;
  note?: string;
}
export interface LinkedPerson extends ChildRecord {
  role: string;
  name: string;
  contact_id?: string | null;
  phone?: string;
  email?: string;
  note?: string;
}
export interface UpdatePersonRequest
  extends Partial<CreatePersonRequest>, VersionRequest {}
export interface CreateDocumentRequest extends ChildVisibility {
  name: string;
  mime_type: string;
  expected_bytes: number;
}
export interface DocumentMetadata extends ChildRecord {
  name: string;
  mime_type: string;
  expected_bytes: number;
  byte_length: number | null;
  sha256: string | null;
  state: "pending" | "ready" | "aborted";
  upload_expires_at: number;
}
export interface DocumentReservation extends MutationRef {
  upload_url: string;
  expires_at: number;
}
export interface DocumentUploadResult extends VersionRequest {
  id: string;
  upload_attempt: string;
  byte_length: number;
  sha256: string;
}
export interface CompleteDocumentRequest extends VersionRequest {
  upload_attempt: string;
}
export interface SendDocumentResult {
  id: string;
  message_id: string;
}
export interface CreateEntryRequest extends ChildVisibility {
  kind: string;
  text: string;
  quantity_milli?: number | null;
  unit?: string;
  occurred_at: number;
}
export interface Entry extends ChildRecord {
  kind: string;
  text: string;
  quantity_milli: number | null;
  unit: string;
  occurred_at: number;
  replaces_id: string | null;
}
export interface ReviseEntryRequest
  extends CreateEntryRequest, VersionRequest {}
export interface EntryQuery extends PageQuery {
  kind?: string;
  include_archived?: boolean;
}
/** Query HTTP: flags 1/0 e filtros de estado separados por vírgulas. */
export interface OrderQuery {
  /** JSON de OrderFieldFilter, validado pelo servidor. */
  field_filter?: string;
  assignee?: string;
  due_from?: string;
  due_to?: string;
  status?: string;
  open?: "1" | "0";
  conversation_id?: string;
  phone?: string;
  q?: string;
  cursor?: string;
  before?: string;
  limit?: string;
  type_id?: string;
  stage?: string;
  facets?: "1" | "0";
  /** Filtro aditivo da lista do painel; IDs separados por vírgula. */
  type_ids?: string;
  /** OS4: "Agendado para" (ms Unix, inclusivos) e só as agendadas. */
  scheduled_from?: string;
  scheduled_to?: string;
  scheduled?: "1";
}
export interface OrderDetailQuery {
  history?: "legacy" | "none";
}
export interface WorkTypeQuery {
  include_archived?: "1" | "0";
}
export interface ConversationOrdersQuery {
  open?: "1" | "0";
  type_id?: string;
}
export interface ConversationOrders {
  data: Order[];
}
export interface DocumentUploadHeaders {
  "Idempotency-Key": string;
  "Upload-Version": string;
}

// Seção 7: manifesto e DTOs administrativos (independentes de os ligado).
export type AreaModuleId =
  | "os"
  | "queue"
  | "forms"
  | "agenda"
  | "reserva"
  | "pedido"
  | "mensalidade"
  | "suporte"
  | "mesas"
  | "entrega"
  | "payments"
  | "erp";
export type TemplateMenu =
  | { id: string; label: string; type: "os_open" | "os_track"; type_id: string }
  | { id: string; label: string; type: "human"; department_id: string | null }
  | { id: string; label: string; type: "message"; content: string };
export interface AreaBotSuggestion {
  instructions: string;
  allowed_operations: string[];
  denied_operations: string[];
  suggested_roles: string[];
}
export interface AreaSetup {
  template_id: string;
  bot: AreaBotSuggestion;
  manual_steps: string[];
}
export interface AreaTemplate {
  schema_version: 1;
  id: string;
  version: number;
  name: string;
  description: string;
  work_types: CustomWorkType[];
  object_types?: ServiceObjectType[];
  modules: Partial<Record<AreaModuleId, boolean>>;
  vocabulary: OsVocabulary;
  departments: Array<{ id: string; name: string; members: []; enabled: true }>;
  ticket_categories: Array<{ id: string; name: string; enabled: true }>;
  menus: TemplateMenu[];
  texts: {
    instructions?: string;
    menu_greeting?: string;
    protocol_confirmation?: string;
  };
  bot: AreaBotSuggestion;
  manual_steps: string[];
}
export type AreaTemplateSource =
  | { template_id: string; manifest?: never }
  | { manifest: AreaTemplate; template_id?: never };
export interface AreaTemplateSelection {
  work_type_ids: string[];
  module_ids: AreaModuleId[];
  menus: boolean;
  departments: boolean;
  ticket_categories: boolean;
  vocabulary: boolean;
  texts: boolean;
  bot_suggestions: boolean;
}
export interface TemplateChange {
  path: string;
  action: "add" | "set" | "keep" | "skip";
  reason: string;
}
export interface AreaTemplatePreview {
  preview_hash: string;
  template_id: string;
  template_version: number;
  changes: TemplateChange[];
  conflicts: Array<{ path: string; code: string; message: string }>;
  manual_steps: string[];
  can_apply: boolean;
}
export type AreaTemplatePreviewRequest = AreaTemplateSource & {
  selection: AreaTemplateSelection;
};
export type AreaTemplateApplyRequest = AreaTemplatePreviewRequest & {
  preview_hash: string;
};
export interface AreaTemplateApplyResult {
  applied: boolean;
  changes: TemplateChange[];
  manual_steps: string[];
  settings_revision: string;
}
export interface AreaTemplateExportRequest {
  id: string;
  name: string;
  type_ids: string[];
}
export type AreaTemplateSummary = Pick<
  AreaTemplate,
  "id" | "version" | "name" | "description"
>;
export interface AreaTemplateCatalog {
  data: AreaTemplateSummary[];
}
