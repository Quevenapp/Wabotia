/** Contratos puros. IDs/decimais são texto; nenhuma avaliação deste módulo faz I/O. */
import type { IdentityPort } from "../engine/identity.ts";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type SourceId = string;
export type ExactDecimal = string;
export type Revision = string;
export type Generation = string;
export type Fence = string;
export type Sha256 = string;
export type Timestamp = string;
export const BLING_LEGACY_ENTITIES = ["contacts", "products", "sales_orders", "sales_proposals", "purchase_orders", "receivables", "payables", "nfe", "nfce", "payment_methods", "sellers", "service_orders", "warehouses", "product_categories", "financial_categories", "ledger_accounts", "cash_entries", "stock_balances"] as const;
export const BLING_EXTRA_ENTITIES = ["contracts", "production_orders", "price_lists", "operation_natures", "custom_fields", "bordereaux", "service_invoices", "product_structures", "product_suppliers", "product_lots", "product_lot_movements", "product_variations", "product_groups", "contact_types", "statuses", "status_modules", "status_transitions", "logistics", "logistics_services", "logistics_objects", "logistics_shipments", "companies", "users"] as const;
export const BLING_ENTITIES = [...BLING_LEGACY_ENTITIES, ...BLING_EXTRA_ENTITIES] as const;
export type BlingEntity = typeof BLING_ENTITIES[number];
export const BLING_GLOBAL_STATES = ["off", "needs_authorization", "ready", "running", "waiting_rate", "waiting_retry", "blocked_scope", "blocked_capacity", "purging"] as const;
export type BlingGlobalState = typeof BLING_GLOBAL_STATES[number];
export const BLING_UNIT_PHASES = ["queued", "reserved", "fetching", "committed", "waiting", "blocked", "superseded"] as const;
export type BlingUnitPhase = typeof BLING_UNIT_PHASES[number];
export const BLING_UNIT_KINDS = ["list", "detail", "stock", "finance_refresh", "reference", "capture_repair", "xml_fetch", "xml_store", "xml_verify", "xml_commit", "r2_delete", "purge", "oauth_state", "oauth_exchange", "oauth_refresh"] as const;
export type BlingUnitKind = typeof BLING_UNIT_KINDS[number];
export const BLING_ERROR_CODES = ["BLING_DISABLED", "BLING_ADMIN_REQUIRED", "BLING_RESOURCE_UNCONFIRMED", "BLING_AUTH_REQUIRED", "BLING_ACCOUNT_MISMATCH", "BLING_SCOPE_REQUIRED", "BLING_RATE_WAIT", "BLING_RETRY_WAIT", "BLING_LEASE_LOST", "BLING_REVISION_CONFLICT", "BLING_COMMAND_CONFLICT", "BLING_CAPACITY_STOP", "BLING_RESPONSE_INVALID", "BLING_ARCHIVE_REFERENCED", "BLING_GENERATION_RETIRED"] as const;
export type BlingErrorCode = typeof BLING_ERROR_CODES[number];
const ERROR_MESSAGES: Record<BlingErrorCode, string> = {
  BLING_DISABLED: "O recebimento de dados do Bling está indisponível ou desligado.",
  BLING_ADMIN_REQUIRED: "Esta operação exige autorização administrativa.",
  BLING_RESOURCE_UNCONFIRMED: "A referência oficial deste recurso precisa ser conferida.",
  BLING_AUTH_REQUIRED: "Autorize novamente a conta do Bling.",
  BLING_ACCOUNT_MISMATCH: "A conta autorizada não corresponde ao acervo desta área.",
  BLING_SCOPE_REQUIRED: "Esta operação exige uma permissão ainda não concedida.",
  BLING_RATE_WAIT: "Aguarde o próximo horário permitido para coleta.",
  BLING_RETRY_WAIT: "A operação aguarda uma nova tentativa.",
  BLING_LEASE_LOST: "A reserva desta tentativa não está mais vigente.",
  BLING_REVISION_CONFLICT: "O estado mudou. Consulte a revisão atual.",
  BLING_COMMAND_CONFLICT: "Este comando já identifica outra solicitação.",
  BLING_CAPACITY_STOP: "A coleta está suspensa pelo limite de espaço.",
  BLING_RESPONSE_INVALID: "Os dados recebidos não atendem ao contrato esperado.",
  BLING_ARCHIVE_REFERENCED: "Este conteúdo ainda possui referências que impedem sua exclusão.",
  BLING_GENERATION_RETIRED: "Esta geração do acervo foi encerrada.",
};
export interface BlingFailure { code: BlingErrorCode; message: string; retry_at?: number }
/** Mensagens enumeradas locais, nunca corpo/URL/header/exceção remota. */
export class BlingError extends Error {
  readonly code: BlingErrorCode;
  readonly status: 403 | 409 | 503;
  readonly retry_at?: number;
  constructor(code: BlingErrorCode, options: { status?: 403 | 409 | 503; retry_at?: number } = {}) {
    super(ERROR_MESSAGES[code]); this.name = "BlingError"; this.code = code;
    this.status = options.status ?? (["BLING_ADMIN_REQUIRED", "BLING_SCOPE_REQUIRED"].includes(code) ? 403 : ["BLING_DISABLED", "BLING_RATE_WAIT", "BLING_RETRY_WAIT"].includes(code) ? 503 : 409);
    if (Number.isSafeInteger(options.retry_at) && options.retry_at! >= 0) this.retry_at = options.retry_at;
  }
  toJSON(): BlingFailure { return { code: this.code, message: this.message, ...(this.retry_at === undefined ? {} : { retry_at: this.retry_at }) }; }
}
export const BLING_OPERATION_NAMES = ["erp_bling_status", "erp_bling_resources", "erp_bling_configure", "erp_bling_app_save", "erp_bling_enable", "erp_bling_disable", "erp_bling_oauth_start", "erp_bling_oauth_callback", "erp_bling_disconnect", "erp_bling_collect_request", "erp_bling_records_list", "erp_bling_record_get", "erp_bling_versions_list", "erp_bling_xml_list", "erp_bling_xml_get", "erp_bling_purge_preview", "erp_bling_purge_apply", "erp_bling_command_get"] as const;
export type BlingOperationName = typeof BLING_OPERATION_NAMES[number];
export type BlingDataScope = "public" | "personal" | "sensitive" | "raw" | "xml";
export interface BlingClock { now(): number }
export interface BlingAuthorizationContext {
  /** Contexto comprovado pelo núcleo; nunca recebido como argumento público. */
  read_granted?: boolean;
  request_hash?: Sha256;
  bot?: { id: string; allowed_operations: BlingOperationName[]; allowed_entities: BlingEntity[]; data_scopes: BlingDataScope[]; allow_sensitive: boolean };
  confirmation?: { operation: BlingOperationName; command_id: string; request_hash: Sha256; confirmed_by: string; expires_at: number };
}
export interface BlingContext {
  profile: string; clock: BlingClock; identity: IdentityPort; origin: "app" | "external" | "internal"; authorization?: BlingAuthorizationContext;
  /** Efeito HTTP privado: o nonce nunca integra o DTO serializado. */
  response?: { setCookie(cookie: { name: `__Host-${string}`; value: string; max_age: number }): void };
}
export interface RecordIdentity { profile: string; account_id: string; entity: BlingEntity; source_id: SourceId; parent_id?: SourceId }
export interface BlingCommand { command_id: string; expected_revision: Revision }
export interface BlingSelection { key: string; selected: boolean; from: string | null; to: string | null }
export interface BlingAccessPolicy {
  reader_user_ids: string[];
  bots: { bot_id: string; operations: BlingOperationName[]; entities: BlingEntity[]; data_scopes: BlingDataScope[]; allow_sensitive: boolean; mask_personal: boolean }[];
  customer_delivery: { enabled: boolean; entities: BlingEntity[]; require_verified_identity: true };
}
export const DEFAULT_BLING_ACCESS_POLICY: Readonly<BlingAccessPolicy> = Object.freeze({ reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true as const } });
export interface BlingPublicAccount { id: string; name: string | null; confirmed_at: Timestamp | null }
export interface BlingCredentialPublic { configured: boolean; authorized: boolean; revision: Revision; expires_at: number | null; scopes: string[]; uncertain: boolean }
export interface BlingPublicConfiguration {
  revision: Revision; generation: Generation; authorization_revision: Revision; collect_enabled: boolean;
  account: BlingPublicAccount | null; selections: BlingSelection[]; daily_call_limit: number; min_interval_ms: number;
  access: BlingAccessPolicy; approval: { approved_at: Timestamp; approved_by: string; checklist_hash: Sha256 } | null; credential: BlingCredentialPublic;
}
export interface BlingCoverage { complete: false; observed: number; changed: number; pending: number; last_pass_started_at: Timestamp | null; last_pass_completed_at: Timestamp | null; freshness_at: Timestamp | null; limitations: string[] }
export interface BlingOccupancy { database_bytes: number; archive_estimated_bytes: number; xml_bytes: number; ceiling_bytes: 10000000000; warning_ratio: 0.7; stop_ratio: 0.8; projected_bytes: number | null }
export interface BlingStatus { state: BlingGlobalState; configuration: BlingPublicConfiguration; next_wake: number | null; capabilities: { configured: boolean; collect: boolean; archive: boolean; xml: boolean; purge: boolean }; coverage: BlingCoverage; occupancy: BlingOccupancy; last_error: BlingFailure | null }
export interface ResourceDescriptor {
  key: string; entity: BlingEntity; path: string | null;
  pagination: { strategy: "page" | "source_page" | "stock" | "source"; page_size: number; limit_parameter: boolean; short_page_ends: boolean } | null;
  detail: { path: string; required: boolean } | null;
  dateFilter: { kind: "M" | "D" | "E" | "EH" | "U"; from: string | null; to: string | null; time_zone: "America/Sao_Paulo"; overlap_minutes: 15 } | null;
  variants: { key: string; params: Record<string, string | number | boolean | (string | number)[]>; deleted: boolean }[];
  deletedEvidence: "explicit_deleted_variant" | "explicit_payload" | "none" | null;
  identityRule: { kind: "global" | "parental" | "unconfirmed"; parent_entity: BlingEntity | null };
  parser: "json" | "price" | "sales_price" | "purchase_price" | "stock" | "service" | "xml" | null;
  scopeRequirements: string[]; confirmation: "original_conferido" | "oficial_confirmado" | "nao_confirmado";
  officialEvidence: { url: string; checked_at: Timestamp; scopes_checked: boolean; identity_checked: boolean; limits_checked: boolean } | null;
  defaultSelected: boolean;
}
export interface BlingCheckpoint { revision: Revision; cursor: JsonObject; pass_started_at: Timestamp | null; pass_completed_at: Timestamp | null }
export interface BlingLease { owner: string; fence: Fence; expires_at: number }
export interface BlingExpectedState { generation: Generation; authorization_revision: Revision; credential_revision: Revision; configuration_revision: Revision; account_id: string; parts_revision: Revision }
export interface BlingUnit {
  work_id: string; attempt_id: string; command_id: string; request_hash: Sha256; kind: BlingUnitKind;
  entity: BlingEntity | null; source_id: SourceId | null; resource_key: string | null; phase: BlingUnitPhase;
  expected: BlingExpectedState; checkpoint: BlingCheckpoint; lease: BlingLease | null; not_before: number;
  plan: JsonObject; page: { ids: SourceId[]; fingerprint: Sha256; subcursor: number } | null; progress: JsonObject;
}
export interface BlingReceipt { command_id: string; request_hash: Sha256; generation: Generation; operation: string; state: "committed" | "rejected" | "superseded"; committed_at: Timestamp; references: JsonObject; counts: Record<string, number>; error: BlingFailure | null }
export interface BlingCapture { revision: Revision; profile: string; source: "detail" | "deleted_without_detail" | "stock_product"; bytes_sha256: Sha256; semantic_hash: Sha256; semantic_version: Revision; values: { path: string; lexeme: ExactDecimal }[] }
export interface BlingRawRecord {
  identity: RecordIdentity; version: Revision; semantic_hash: Sha256;
  /** Texto lexical completo; capturar a precisão ANTES de materializar números. */
  payload_text: string; document_links: JsonObject[]; observed_at: Timestamp; source_updated_at: string | null;
  source_time_quality: "remote" | "observed" | "unknown" | "invalid"; deleted: boolean; deletion_evidence: string | null; capture: BlingCapture | null;
}
export interface BlingRecordMetadata { identity: RecordIdentity; version: Revision; semantic_hash: Sha256; payload_bytes: number; first_observed_at: Timestamp; last_observed_at: Timestamp; source_updated_at: string | null; source_time_quality: BlingRawRecord["source_time_quality"]; deleted: boolean; mapper_version: string | null; capture_revision: Revision | null }
export interface BlingHistoricalDto { label: "Consulta histórica — não opera no ERP"; kind: string; fields: JsonObject; unresolved_references: JsonObject[]; unmapped_fields: string[]; coverage: BlingCoverage }
export interface BlingRecordView { raw: BlingRawRecord; metadata: BlingRecordMetadata; historical: BlingHistoricalDto; existing_links: JsonObject[] }
export interface BlingPage<T> { items: T[]; next_cursor: string | null }
export interface BlingXmlSummary { object_id: string; entity: "nfe" | "nfce"; source_id: SourceId; access_key: string; model: "55" | "65"; environment: "production" | "test" | "unknown"; version: Revision; sha256: Sha256; bytes: number; available: boolean; coverage: string[] }
export interface BlingXmlDownload { bytes: Uint8Array; sha256: Sha256; filename: string; content_type: "application/xml" }
export interface BlingPurgeScope { entities: BlingEntity[]; all: boolean }
export interface BlingPurgePreview { generation: Generation; preview_hash: Sha256; counts: Record<string, number>; files: number; blocked_references: number }
export interface BlingCallbackInput { state?: string; code?: string; error?: string; browser_nonce?: string; callback_url: string }
export interface BlingCallbackResult { redirect: string; state: "authorized" | "denied" | "unavailable"; clear_cookie: true; error?: BlingFailure }
export interface BlingAdminResult { configuration: BlingPublicConfiguration; receipt: BlingReceipt }
export interface BlingOperationMap {
  erp_bling_status: { input: Record<string, never>; output: BlingStatus };
  erp_bling_resources: { input: Record<string, never>; output: { version: string; resources: ResourceDescriptor[]; selections: BlingSelection[]; limitations: string[] } };
  erp_bling_configure: { input: BlingCommand & { selections: BlingSelection[]; daily_call_limit: number; access: BlingAccessPolicy; ai_disclosure_acknowledged: boolean }; output: BlingAdminResult };
  erp_bling_app_save: { input: BlingCommand & { client_id: string; client_secret: string }; output: { configured: boolean; revision: Revision; callback_url: string; receipt: BlingReceipt } };
  erp_bling_enable: { input: BlingCommand & { warning_confirmed: true; checklist_hash: Sha256 }; output: BlingAdminResult };
  erp_bling_disable: { input: BlingCommand; output: BlingAdminResult };
  erp_bling_oauth_start: { input: BlingCommand; output: { authorization_url: string; expires_at: number } };
  erp_bling_oauth_callback: { input: BlingCallbackInput; output: BlingCallbackResult };
  erp_bling_disconnect: { input: BlingCommand; output: BlingAdminResult & { revocation_guidance: string } };
  erp_bling_collect_request: { input: BlingCommand & { resource_keys: string[] }; output: { run_id: string; next_wake: number | null; receipt: BlingReceipt } };
  erp_bling_records_list: { input: { entity: BlingEntity; cursor?: string; limit?: number; deleted?: boolean; from?: string; to?: string }; output: BlingPage<BlingRecordMetadata> };
  erp_bling_record_get: { input: { entity: BlingEntity; id: SourceId; version?: Revision }; output: BlingRecordView };
  erp_bling_versions_list: { input: { entity: BlingEntity; id: SourceId; cursor?: string; limit?: number }; output: BlingPage<BlingRecordMetadata> };
  erp_bling_xml_list: { input: { entity?: "nfe" | "nfce"; cursor?: string; limit?: number; from?: string; to?: string }; output: BlingPage<BlingXmlSummary> };
  erp_bling_xml_get: { input: { object_id: string }; output: BlingXmlDownload };
  erp_bling_purge_preview: { input: { scope: BlingPurgeScope; generation: Generation }; output: BlingPurgePreview };
  erp_bling_purge_apply: { input: BlingCommand & { scope: BlingPurgeScope; generation: Generation; preview_hash: Sha256; confirmed: true }; output: { work_id: string; receipt: BlingReceipt | null } };
  erp_bling_command_get: { input: { id: string }; output: { phase: BlingUnitPhase; receipt: BlingReceipt | null } };
}
export interface BlingWakeResult { worked: boolean; nextWake: number | null; requests: 0 | 1; error?: BlingFailure }
export const BLING_BUDGET = Object.freeze({ max_units: 1, max_gets: 1, wall_ms: 4000, http_ms: 3000, operational_reserve_ms: 250, minimum_available_ms: 1000, sql_batch: 10, stock_ids: 25, sql_parameters: 100, daily_calls: 20000, min_interval_ms: 700, database_ceiling_bytes: 10000000000, warning_ratio: 0.7, stop_ratio: 0.8 });
