/** Contrato comum da fatia comercial, modelo 55. Nenhuma operação aqui chama o cofre.
 *
 * Instalação em testes (restaurar no finally/t.after):
 *   installCommercialNfeSlots({ prepare: (ctx, input) => ... })
 *   installCommercialNfeHttp(async context => new Response(...))
 * Configuração e autoridade dos testes são portas igualmente explícitas:
 *   installCommercialConnectionResolver((ctx) => publicConnectionCheck | null)
 *   installCom1AuthorityResolver((ctx) => trustedAuthority)
 * Ambas devolvem () => void para restaurar. Alternativamente,
 * bindCom1Authority(ctx, authority) vale apenas naquele contexto transacional.
 * A ponte usa COM1_AUTHORITY_HEADER com SYSTEM_HEADER, nunca valores do browser;
 * runWithCom1Authority(authority, () => callRpc(...)) é estritamente síncrono.
 * O hub existente ainda exige snapshot atual de partes antes do endpoint:
 * a ponte precisa renová-lo no commit; Base desligada requer ajuste estreito
 * no hub pela integração final (arquivo fora da propriedade desta base).
 * Cada slot do motor é síncrono e termina na transação de callRpc. A costura
 * HTTP aguarda o provedor FORA dela e usa outro RPC para gravar evidência.
 * As implementações paralelas importam estes contratos e store.ts; somente
 * com1-fecha instala implementações no registro/entrada de produção.
 */
import type { RpcContext } from "../engine/registry.ts";
import type { FiscalEnvironment, FiscalFile, FiscalMessage, FiscalProvider, FiscalResult } from "../emissor/provider.ts";
import type { PedidoNfe } from "../emissor/contract/types.generated.ts";
export type { FiscalEnvironment, FiscalFile, FiscalMessage, FiscalResult, PedidoNfe };

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Instantes persistidos em microssegundos UTC, decimal exato, nunca Number(i64). */
export type Timestamp = string;
export type Sha256 = string;
export type EmissionState = "bloqueada" | "preparada" | "enviando" | "processando" | "incerta" | "rejeitada" | "autorizada" | "denegada" | "cancelada" | "arquivada";
export type CancellationState = "pedido" | "enviando" | "incerto" | "recusado" | "registrado";
export type EffectAxis = "stock" | "finance";
export type EffectTiming = "existing" | "on_authorization";
export type EffectState = "aplicado" | "reconhecido" | "pendente" | "pulado" | "revertido" | "compensacao_pendente";
export type EffectApplicationState = "aplicado" | "reconhecido" | "pendente" | "pulado";
export type CommandAction = "config_save" | "prepare" | "emit" | "resume" | "cancel" | "cancel_xml" | "effect_apply" | "effect_reverse";
export type CommandState = "claimed" | "pending" | "completed" | "failed";

export interface FiscalBlocker {
  code: string;
  field: string;
  item_id?: string;
  entity_id?: string;
  message: string;
  correction: { screen: string; id?: string; field?: string };
}
export interface CommercialSettings {
  id: 1;
  version: number;
  environment: FiscalEnvironment;
  stock_timing: EffectTiming;
  finance_timing: EffectTiming;
  series_homologacao: number | null;
  series_producao: number | null;
  connection_fingerprint: string | null;
  connection_public: Record<string, unknown> | null;
  production_enabled_at: Timestamp | null;
  production_enabled_by: string | null;
  tax_limits_acknowledged_at: Timestamp | null;
  tax_limits_acknowledged_by: string | null;
  updated_at: Timestamp | null;
  updated_by: string | null;
}
export interface ConfigSaveInput {
  command_id: string;
  expected_version: number;
  environment: FiscalEnvironment;
  stock_timing: EffectTiming;
  finance_timing: EffectTiming;
  series_homologacao?: number | null;
  series_producao?: number | null;
  acknowledge_tax_limits?: boolean;
  enable_production?: boolean;
}
/** Fontes preservam os dados originais e suas versões; não são dados do browser. */
export interface CommercialSnapshot {
  document: JsonObject;
  items: JsonObject[];
  company: JsonObject;
  recipient: JsonObject;
  products: JsonObject[];
  nature: JsonObject;
  payments: JsonObject[];
  transport: JsonObject;
  sources: { entity: string; id: string; version: string | number | null; fields: string[] }[];
}
export interface FiscalChoices {
  nature_id: string;
  presence: string;
  final_consumer: boolean;
  series?: number | null;
}
export interface PrepareInput {
  document_id: string;
  expected_document_version: number;
  command_id: string;
  choices: FiscalChoices;
  /** Só após cancelamento/denegação; timeout/rejeição nunca avançam. */
  new_fiscal_version?: boolean;
  expected_emission_version?: number;
}
export interface ImmutableRevision {
  emission_id: string;
  body_revision: number;
  /** Versão técnica observada; postagens locais podem aumentá-la sem nova nota. */
  source_document_version: number;
  snapshot: CommercialSnapshot;
  tax_sources: JsonObject;
  commercial_hash: Sha256;
  source_fingerprint: Sha256;
  /** Null somente se bloqueada antes de existir um PedidoNfe válido. */
  body: PedidoNfe | null;
  body_hash: Sha256 | null;
  calculation: JsonObject;
  blockers: FiscalBlocker[];
  prepared_by: string;
  prepared_at: Timestamp;
}
export interface StoredEmission {
  id: string;
  document_id: string;
  /** Independente da versão do documento e da revisão do corpo. 1..9999. */
  fiscal_version: number;
  environment: FiscalEnvironment;
  environment_confirmed: boolean;
  connection_fingerprint: Sha256 | null;
  reference: string;
  current_body_revision: number;
  status: EmissionState;
  version: number;
  provider_id: string | null;
  provider_status: string | null;
  messages: FiscalMessage[];
  series: number | null;
  number: number | null;
  access_key: string | null;
  protocol: string | null;
  issued_at: Timestamp | null;
  authorized_at: Timestamp | null;
  /** Centavos exatos como texto. */
  total: string | null;
  created_at: Timestamp;
  created_by: string;
  updated_at: Timestamp;
}
export interface EffectView {
  emission_id: string;
  axis: EffectAxis;
  state: EffectApplicationState;
  origin: string | null;
  ids: JsonObject;
  fingerprint: Sha256 | null;
  reason: string | null;
  responsible_role: "estoque" | "financeiro" | "admin";
  person_id: string | null;
  command_id: string | null;
  result: JsonObject | null;
  /** Aplicação não é apagada pela compensação. */
  compensation_state: "pendente" | "revertido" | "compensacao_pendente" | null;
  compensation_command_id: string | null;
  compensation_result: JsonObject | null;
  updated_at: Timestamp;
}
export interface CancellationView {
  emission_id: string;
  justification: string;
  command_id: string;
  state: CancellationState;
  messages: FiscalMessage[];
  protocol: string | null;
  event_at: Timestamp | null;
  repeated: boolean;
  xml_status: "pendente" | "disponivel";
  xml_hash: Sha256 | null;
}
export interface EmissionView extends StoredEmission {
  revision: ImmutableRevision;
  effects: EffectView[];
  cancellation: CancellationView | null;
}
export interface PreparationResult {
  emission: EmissionView;
  blockers: FiscalBlocker[];
  effects_preview: EffectView[];
  replayed: boolean;
}
export interface ReadInput { emission_id: string }
export interface ListInput {
  environment: FiscalEnvironment;
  document_id?: string;
  status?: EmissionState;
  page?: number;
  per_page?: number;
}
export interface EmissionPage { items: EmissionView[]; page: number; per_page: number; total: number }
/** A listagem HTTP não multiplica snapshots nem corpos fiscais por página. */
export interface PublicEmissionSummary extends Omit<EmissionView, "revision"> {
  revision: Omit<ImmutableRevision, "snapshot" | "tax_sources" | "body" | "calculation">;
}
export interface PublicEmissionPage extends Omit<EmissionPage, "items"> { items: PublicEmissionSummary[] }
export interface CommandReceipt {
  id: string;
  action: CommandAction;
  person_id: string;
  session_id: string | null;
  args_hash: Sha256;
  emission_id: string | null;
  body_revision: number | null;
  state: CommandState;
  token: string | null;
  lease_until: Timestamp | null;
  /** Bytes exatos para recuperação ficam em request.body_text. */
  request: JsonObject | null;
  result: JsonObject | null;
  error: JsonObject | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface ClaimInput extends ReadInput {
  command_id: string;
  action: "emit" | "resume";
  expected_version: number;
  body_revision: number;
  body_hash: Sha256;
  connection_fingerprint: Sha256;
  /** Recalculado pelo servidor antes do primeiro envio; não confiável no HTTP. */
  source_fingerprint?: Sha256;
}
export interface ClaimResult {
  emission: StoredEmission;
  revision: ImmutableRevision;
  command: CommandReceipt;
  disposition: "send" | "resume" | "replay" | "busy";
}
/** Capacidade interna: só o servidor recebe claim_token; nunca em EmissionView. */
export interface EvidenceCapability extends ReadInput { command_id: string; claim_token: string }
export interface RecordInput extends EvidenceCapability {
  connection_fingerprint: Sha256;
  result: FiscalResult | null;
  /** Evidência retornada em erro também é preservada. Sem segredo/certificado. */
  evidence?: JsonObject;
  error?: { code: string; message: string };
}
export interface CancelClaimInput extends ReadInput {
  command_id: string;
  expected_version: number;
  justification: string;
  connection_fingerprint: Sha256;
}
export interface CancelClaimResult { emission: StoredEmission; cancellation: CancellationView; command: CommandReceipt; disposition: "send" | "resume" | "replay" | "busy" }
export interface CancelRecordInput extends EvidenceCapability {
  connection_fingerprint: Sha256;
  state: "incerto" | "recusado" | "registrado";
  result: FiscalResult | null;
  /** Metadados do EVENTO conferidos no cofre/XML, nunca protocolo/data da
   * autorização da NF-e. Cancelamento conclusivo sem estes campos preserva
   * a emissão cancelada e o evento incerto até completar o arquivamento. */
  event_protocol?: string;
  event_at?: Timestamp;
  evidence?: JsonObject;
  error?: { code: string; message: string };
}
export interface CancellationXmlInput extends EvidenceCapability { xml: string; xml_hash: Sha256 }
export interface EffectInput extends ReadInput {
  command_id: string;
  expected_version: number;
  axis: EffectAxis;
  intent: "reconcile" | "apply" | "apply_skipped" | "reverse";
  physical_return_confirmed?: boolean;
}
/** Slots nunca devolvem Promise: SQLite não permanece aberto aguardando I/O. */
export interface CommercialNfeSlots {
  prepare(ctx: RpcContext, input: PrepareInput): PreparationResult;
  read(ctx: RpcContext, input: ReadInput): EmissionView;
  list(ctx: RpcContext, input: ListInput): EmissionPage;
  claim(ctx: RpcContext, input: ClaimInput): ClaimResult;
  record(ctx: RpcContext, input: RecordInput): EmissionView;
  cancelClaim(ctx: RpcContext, input: CancelClaimInput): CancelClaimResult;
  cancelRecord(ctx: RpcContext, input: CancelRecordInput): EmissionView;
  recordCancellationXml(ctx: RpcContext, input: CancellationXmlInput): CancellationView;
  applyEffects(ctx: RpcContext, input: EffectInput): EffectView;
  reverseEffects(ctx: RpcContext, input: EffectInput): EffectView;
}
export interface CommercialNfeDependencies {
  provider: FiscalProvider;
  fetch: typeof fetch;
  clock: { now(): number; sleep(milliseconds: number): Promise<void> };
  uuid(): string;
}
