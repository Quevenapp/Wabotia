/** Portas injetadas; SQLite síncrono e I/O assíncrono nunca compartilham transação.
 * Adaptadores traduzem revisões safe INTEGER em texto decimal e timestamps de
 * parede INTEGER (ms UTC) em ISO. Datas remotas lexicais continuam no payload.
 * authorization_url é transitória: nunca copiar URL/state/nonce para recibo,
 * plano, auditoria ou backup. O cookie sai por ctx.response.setCookie.
 */
import type {
  BlingCallbackInput, BlingCallbackResult, BlingCapture, BlingCheckpoint, BlingContext,
  BlingCredentialPublic, BlingExpectedState, BlingFailure, BlingHistoricalDto, BlingLease,
  BlingOperationMap, BlingOperationName, BlingPublicAccount, BlingPurgePreview, BlingPurgeScope,
  BlingRawRecord, BlingReceipt, BlingRecordMetadata, BlingUnit, BlingWakeResult,
  BlingXmlDownload, BlingXmlSummary, Generation, JsonObject, RecordIdentity, Revision, Sha256,
} from "./contracts.ts";
import type { SqlDriver } from "../engine/driver.ts";
import type { ErpPartsSnapshot } from "../parts.ts";

/** Só o adaptador privado recebe estes campos; nunca devolver em DTO/erro/recibo/log. */
export interface BlingPrivateCredential { client_id: string; client_secret: string; access_token: string; refresh_token: string; expires_at: number; scopes: string[] }
export interface BlingCredentialCas { expected_revision: Revision; previous_ciphertext: string | null; credential: BlingPrivateCredential | null; account: BlingPublicAccount | null; lease: BlingLease; expected: BlingExpectedState }
export interface BlingOAuthReservation { command_id: string; state_hash: Sha256; browser_hash: Sha256; session_id: string; actor_id: string; config_revision: Revision; generation: Generation; expires_at: number }
export interface AuthorizationPort {
  saveApplication(ctx: BlingContext, input: BlingOperationMap["erp_bling_app_save"]["input"]): Promise<BlingOperationMap["erp_bling_app_save"]["output"]>;
  renew(ctx: BlingContext, input: { expected: BlingExpectedState; lease: BlingLease }): Promise<BlingCredentialPublic>;
  publicState(ctx: BlingContext): Promise<BlingCredentialPublic>;
  authorize(ctx: BlingContext, input: BlingOperationMap["erp_bling_oauth_start"]["input"]): Promise<BlingOperationMap["erp_bling_oauth_start"]["output"]>;
  callback(ctx: BlingContext, input: BlingCallbackInput): Promise<BlingCallbackResult>;
  reserveOAuth(ctx: BlingContext, input: BlingOAuthReservation): void;
  consumeOAuth(ctx: BlingContext, input: { state_hash: Sha256; browser_hash: Sha256; session_id: string }): BlingOAuthReservation;
  /** Exclusão mútua no Coordinator + CAS sobre ciphertext no cofre D1 existente. */
  custodyCas(ctx: BlingContext, input: BlingCredentialCas): Promise<BlingCredentialPublic>;
  privateCredential(ctx: BlingContext, expected: BlingExpectedState): Promise<BlingPrivateCredential>;
  disconnect(ctx: BlingContext, expected: BlingExpectedState): Promise<BlingCredentialPublic>;
}
export interface BlingReserveInput { unit: BlingUnit; owner: string; lease_until: number }
export interface BlingCommitInput {
  unit: BlingUnit; expected: BlingExpectedState; fence: string; request_hash: Sha256;
  records: BlingRawRecord[]; next_checkpoint: BlingCheckpoint;
  /** CAS de presença/ausência e versão da fonte; conferir recibo ANTES deste CAS. */
  source_expectations: { identity: RecordIdentity; version: Revision | null; semantic_hash: Sha256 | null }[];
  counts: Record<string, number>;
}
export interface CollectionStore {
  requestCollection(ctx: BlingContext, input: BlingOperationMap["erp_bling_collect_request"]["input"]): BlingOperationMap["erp_bling_collect_request"]["output"];
  reserve(ctx: BlingContext, input: BlingReserveInput): { unit: BlingUnit; receipt: BlingReceipt | null };
  renew(ctx: BlingContext, input: { work_id: string; attempt_id: string; owner: string; fence: string; lease_until: number }): BlingLease;
  release(ctx: BlingContext, input: { work_id: string; owner: string; fence: string }): void;
  receipt(ctx: BlingContext, input: { command_id: string; request_hash: Sha256; generation: Generation }): BlingReceipt | null;
  /** Gravar fetching antes de qualquer HTTP. */
  markFetching(ctx: BlingContext, unit: BlingUnit): BlingUnit;
  /** Atômicos: fonte/histórico/índice/inbox/checkpoint/contadores/recibo. */
  commitBatch(ctx: BlingContext, input: BlingCommitInput): BlingReceipt;
  reschedule(ctx: BlingContext, input: { unit: BlingUnit; not_before: number; error: BlingFailure; blocked: boolean }): void;
}
export interface BlingXmlArchiveInput { unit: BlingUnit; identity: RecordIdentity; access_key: string; model: "55" | "65"; fingerprint: Sha256; bytes: Uint8Array; expected_sha256: Sha256 }
export interface ArchivePort {
  listRecords(ctx: BlingContext, input: BlingOperationMap["erp_bling_records_list"]["input"]): BlingOperationMap["erp_bling_records_list"]["output"];
  listVersions(ctx: BlingContext, input: BlingOperationMap["erp_bling_versions_list"]["input"]): BlingOperationMap["erp_bling_versions_list"]["output"];
  listXml(ctx: BlingContext, input: BlingOperationMap["erp_bling_xml_list"]["input"]): BlingOperationMap["erp_bling_xml_list"]["output"];
  validateCapture(ctx: BlingContext, input: { record: BlingRawRecord; bytes: Uint8Array }): BlingCapture | null;
  project(ctx: BlingContext, record: BlingRawRecord): { historical: BlingHistoricalDto; metadata: BlingRecordMetadata };
  /** Única leitura consistente do corrente OU histórico, não só source_version. */
  readVersion(ctx: BlingContext, identity: RecordIdentity, version?: Revision): BlingRawRecord | null;
  archiveXml(ctx: BlingContext, input: BlingXmlArchiveInput): Promise<BlingXmlSummary>;
  readXml(ctx: BlingContext, object_id: string): Promise<BlingXmlDownload>;
  purgePreview(ctx: BlingContext, input: { scope: BlingPurgeScope; generation: Generation }): BlingPurgePreview;
  purge(ctx: BlingContext, input: BlingOperationMap["erp_bling_purge_apply"]["input"]): Promise<BlingOperationMap["erp_bling_purge_apply"]["output"]>;
}
export interface BlingApiPort {
  execute<K extends BlingOperationName>(ctx: BlingContext, name: K, input: BlingOperationMap[K]["input"]): Promise<BlingOperationMap[K]["output"]>;
  callback(ctx: BlingContext, input: BlingCallbackInput): Promise<BlingCallbackResult>;
}
export interface BlingWakeBudget { deadline: number; nextOperationalAt: number | null; maxGets: 1 }
export interface BlingWakePort {
  nextWake(ctx: BlingContext): Promise<number | null>;
  runOne(ctx: BlingContext, budget: BlingWakeBudget): Promise<BlingWakeResult>;
}
/** Transporte de dados: uma tentativa, sem sleep/retry interno, GET tipado. */
export interface BlingDataRequest { method: "GET"; resource_key: string; path: string; query: Record<string, string | string[]>; deadline: number; expected: BlingExpectedState }
export type BlingDataResult = { kind: "success"; status: 200; bytes: Uint8Array; received_at: number } | { kind: "retry"; error: BlingFailure; retry_at: number } | { kind: "failure"; error: BlingFailure; status: number };
export interface BlingDataPort { get(ctx: BlingContext, request: BlingDataRequest): Promise<BlingDataResult> }
/** Provedor protocolar separado do servidor GET de recursos. */
export interface BlingOAuthProvider { exchange(input: { code: string; callback_url: string; client_id: string; client_secret: string }): Promise<BlingPrivateCredential>; refresh(input: BlingPrivateCredential): Promise<BlingPrivateCredential> }
export interface BlingDependencies {
  db: SqlDriver;
  readParts(): Promise<ErpPartsSnapshot | null>;
  authorization: AuthorizationPort;
  collection: CollectionStore;
  archive: ArchivePort;
  data: BlingDataPort;
  /** Relógio vive em ctx; geração/revisões/partes são revalidadas antes e depois de I/O. */
  revalidate(ctx: BlingContext, expected: BlingExpectedState): Promise<void>;
  databaseSize(): number;
  randomId(): string;
  hash(bytes: Uint8Array): Promise<Sha256>;
}
export interface BlingAuditEntry { actor_id: string; operation: BlingOperationName | string; command_id: string | null; generation: Generation; before_revision: Revision; after_revision: Revision; at: string; counts: Record<string, number>; code: BlingFailure["code"] | null; references: JsonObject }
