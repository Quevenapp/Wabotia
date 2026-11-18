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
}
export interface WorkLabels {
  singular: string;
  plural: string;
  item: string;
  problem: string;
  customer_singular: string;
  customer_plural: string;
}
export interface CustomWorkType {
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
  os_vocabulary?: OsVocabulary;
}
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
  description: string;
  quantity: number;
  unit_cents: number;
}
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
  } | null;
  decision: {
    decision: "approved" | "declined";
    at: number;
    by: string;
    via: string;
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
export interface WorkTypeCatalog {
  data: WorkTypeView[];
  settings_revision: string;
}
export interface CreateOrderRequest {
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
  items: QuoteItem[];
  note?: string;
  valid_days?: number;
}
export interface QuoteSendRequest {
  notify?: boolean;
}
export interface DecisionRequest {
  decision: "approve" | "decline";
  note?: string;
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
