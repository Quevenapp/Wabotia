/** Schemas/descritores públicos e guardas leves, sem importar o motor. */
import { z } from "zod";
import { BLING_ENTITIES, BLING_ERROR_CODES, BLING_GLOBAL_STATES, BLING_OPERATION_NAMES, BLING_UNIT_KINDS, BLING_UNIT_PHASES, BlingError, type BlingAuthorizationContext, type BlingContext, type BlingOperationMap, type BlingOperationName, type BlingWakeResult, type JsonValue, type ResourceDescriptor } from "./contracts.ts";
import type { BlingCommitInput, BlingDataRequest, BlingDataResult, BlingOAuthReservation, BlingReserveInput, BlingWakeBudget } from "./ports.ts";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v + "T00:00:00Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const entity = z.enum(BLING_ENTITIES);
const empty = z.object({}).strict();
const scopes = z.enum(["public", "personal", "sensitive", "raw", "xml"]);
export const sourceIdSchema = z.string().regex(/^\d{1,40}$/).refine(v => !/^0+$/.test(v));
/** Namespace parental somente quando o recurso confirmado exigir esta regra. */
export const canonicalSourceIdSchema = z.union([sourceIdSchema, z.string().regex(/^\d{1,40}:\d{1,40}$/).refine(v => v.split(":").every(p => !/^0+$/.test(p)))]);
export const decimalSchema = z.string().max(4096).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,5})?$/).refine(v => { const e = v.match(/[eE]([+-]?\d+)$/); return !e || (BigInt(e[1]) >= -10000n && BigInt(e[1]) <= 10000n); });
export const revisionSchema = z.string().regex(/^(0|[1-9]\d*)$/).max(16).refine(v => /^(0|[1-9]\d*)$/.test(v) && v.length <= 16 && BigInt(v) <= 9007199254740991n);
export const generationSchema = revisionSchema.refine(v => v !== "0");
export const contentVersionSchema = revisionSchema.refine(v => v !== "0");
export const fenceSchema = id;
export const sha256Schema = sha;
export const timestampSchema = timestamp;
export const entitySchema = entity;
export const globalStateSchema = z.enum(BLING_GLOBAL_STATES);
export const unitPhaseSchema = z.enum(BLING_UNIT_PHASES);
export const unitKindSchema = z.enum(BLING_UNIT_KINDS);
export const recordIdentitySchema = z.object({ profile: id, account_id: id, entity, source_id: canonicalSourceIdSchema, parent_id: sourceIdSchema.optional() }).strict().refine(v => !v.parent_id || v.source_id.startsWith(v.parent_id + ":"), "Identidade parental exige namespace explícito.");
/** Igualdade matemática exata, sem conversão do valor monetário para Number. */
export function exactDecimalEqual(a: string, b: string): boolean {
  const normalized = (input: string) => {
    const value = decimalSchema.parse(input); const [mantissa, exponent = "0"] = value.toLowerCase().split("e");
    const [whole, fraction = ""] = mantissa.split("."); let coefficient = BigInt(whole + fraction); let scale = BigInt(fraction.length) - BigInt(exponent);
    if (coefficient === 0n) return "0";
    while (coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1n; }
    return `${coefficient}:${scale}`;
  };
  return normalized(a) === normalized(b);
}
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]));
const jsonObject = z.record(z.string(), jsonValueSchema);
/** Referências/planos não são um segundo payload, e nunca custodiam autorização. */
const secretKey = /^(?:access_?token|refresh_?token|client_?secret|client_?id|token|secret|password|authorization|cookie|code|oauth_?state|payload|payload_text)$/i;
function safeMetadata(value: unknown): boolean { return !value || typeof value !== "object" || (Array.isArray(value) ? value.every(safeMetadata) : Object.entries(value).every(([k, v]) => !secretKey.test(k) && safeMetadata(v))); }
export const metadataSchema = jsonObject.refine(v => safeMetadata(v) && JSON.stringify(v).length <= 16384);
export const failureSchema = z.object({ code: z.enum(BLING_ERROR_CODES), message: z.string().max(256), retry_at: count.optional() }).strict().refine(v => v.message === new BlingError(v.code).message);
export const commandSchema = z.object({ command_id: id, expected_revision: revisionSchema }).strict();
export const selectionSchema = z.object({ key: id, selected: z.boolean(), from: date.nullable(), to: date.nullable() }).strict().refine(v => !v.from || !v.to || v.from <= v.to);
export const accessPolicySchema = z.object({
  reader_user_ids: z.array(id).max(1000),
  bots: z.array(z.object({ bot_id: id, operations: z.array(z.enum(BLING_OPERATION_NAMES)).max(18), entities: z.array(entity).max(BLING_ENTITIES.length), data_scopes: z.array(scopes).max(5), allow_sensitive: z.boolean(), mask_personal: z.boolean() }).strict()).max(1000),
  customer_delivery: z.object({ enabled: z.boolean(), entities: z.array(entity).max(BLING_ENTITIES.length), require_verified_identity: z.literal(true) }).strict(),
}).strict();
export const BlingAuthorizationContextSchema: z.ZodType<BlingAuthorizationContext> = z.object({
  delegation: z.object({ run_id: id, proposal_id: id.optional(), method: z.enum(["GET", "POST"]), path: z.string().min(1).max(2048) }).strict().optional(),
  read_granted: z.boolean().optional(), request_hash: sha.optional(),
  bot: z.object({ id, allowed_operations: z.array(z.enum(BLING_OPERATION_NAMES)).max(18), allowed_entities: z.array(entity).max(BLING_ENTITIES.length), data_scopes: z.array(scopes).max(5), allow_sensitive: z.boolean() }).strict().optional(),
  confirmation: z.object({ operation: z.enum(BLING_OPERATION_NAMES), command_id: id, request_hash: sha, confirmed_by: id, expires_at: count }).strict().optional(),
}).strict();
export const credentialPublicSchema = z.object({ configured: z.boolean(), authorized: z.boolean(), revision: revisionSchema, expires_at: count.nullable(), scopes: z.array(z.string().max(200)).max(100), uncertain: z.boolean() }).strict();
export const publicConfigurationSchema = z.object({
  revision: revisionSchema, generation: generationSchema, authorization_revision: revisionSchema, collect_enabled: z.boolean(),
  account: z.object({ id, name: z.string().max(300).nullable(), confirmed_at: timestamp.nullable() }).strict().nullable(),
  selections: z.array(selectionSchema).max(128), daily_call_limit: count.min(1).max(20000), min_interval_ms: count.min(700), access: accessPolicySchema,
  approval: z.object({ approved_at: timestamp, approved_by: id, checklist_hash: sha }).strict().nullable(), credential: credentialPublicSchema,
}).strict();
export const coverageSchema = z.object({ complete: z.literal(false), observed: count, changed: count, pending: count, last_pass_started_at: timestamp.nullable(), last_pass_completed_at: timestamp.nullable(), freshness_at: timestamp.nullable(), limitations: z.array(z.string().max(1000)).max(100) }).strict();
export const occupancySchema = z.object({ database_bytes: count, archive_estimated_bytes: count, xml_bytes: count, ceiling_bytes: z.literal(10000000000), warning_ratio: z.literal(0.7), stop_ratio: z.literal(0.8), projected_bytes: count.nullable() }).strict();
export const progressSchema = z.object({ calls_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), calls_today: count,
  lanes: z.array(z.object({ resource_key: id, entity, checkpoint_revision: revisionSchema, observed: count.nullable(), changed: count.nullable(), pass_started_at: timestamp.nullable(), pass_completed_at: timestamp.nullable(), freshness_at: timestamp.nullable(), next_attempt_at: count.nullable() }).strict()).max(4096) }).strict();
export const statusSchema = z.object({ state: globalStateSchema, configuration: publicConfigurationSchema, callback_url: z.url().optional(), progress: progressSchema.optional(), next_wake: count.nullable(), capabilities: z.object({ configured: z.boolean(), collect: z.boolean(), archive: z.boolean(), xml: z.boolean(), purge: z.boolean() }).strict(), coverage: coverageSchema, occupancy: occupancySchema, last_error: failureSchema.nullable() }).strict();
const resourcePath = z.string().max(256).regex(/^\/[A-Za-z0-9_{}\/-]+$/).refine(v => !v.includes("..") && !v.includes("//"));
export const resourceDescriptorSchema: z.ZodType<ResourceDescriptor> = z.object({
  key: id, entity, path: resourcePath.nullable(),
  pagination: z.object({ strategy: z.enum(["page", "source_page", "stock", "source"]), page_size: count.min(1).max(25), limit_parameter: z.boolean(), short_page_ends: z.boolean() }).strict().nullable(),
  detail: z.object({ path: resourcePath, required: z.boolean() }).strict().nullable(),
  dateFilter: z.object({ kind: z.enum(["M", "D", "E", "EH", "U"]), from: id.nullable(), to: id.nullable(), time_zone: z.literal("America/Sao_Paulo"), overlap_minutes: z.literal(15) }).strict().nullable(),
  variants: z.array(z.object({ key: id, params: z.record(id, z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.union([z.string(), z.number().finite()]))])), deleted: z.boolean() }).strict()).max(32),
  deletedEvidence: z.enum(["explicit_deleted_variant", "explicit_payload", "none"]).nullable(),
  identityRule: z.object({ kind: z.enum(["global", "parental", "unconfirmed"]), parent_entity: entity.nullable() }).strict(),
  parser: z.enum(["json", "price", "sales_price", "purchase_price", "stock", "service", "xml"]).nullable(), scopeRequirements: z.array(z.string().max(200)).max(100),
  confirmation: z.enum(["original_conferido", "oficial_confirmado", "nao_confirmado"]),
  officialEvidence: z.object({ url: z.url().refine(v => v.startsWith("https://")), checked_at: timestamp, scopes_checked: z.boolean(), identity_checked: z.boolean(), limits_checked: z.boolean() }).strict().nullable(), defaultSelected: z.boolean(),
}).strict().superRefine((v, ctx) => {
  const incomplete = !v.path || !v.pagination || !v.dateFilter || !v.parser || v.identityRule.kind === "unconfirmed";
  if ((incomplete || v.confirmation === "nao_confirmado") && v.defaultSelected) ctx.addIssue({ code: "custom", message: "Recurso não confirmado não pode ser selecionado." });
  if (v.confirmation === "oficial_confirmado" && (incomplete || !v.officialEvidence || !v.officialEvidence.scopes_checked || !v.officialEvidence.identity_checked || !v.officialEvidence.limits_checked)) ctx.addIssue({ code: "custom", message: "Confirmação oficial incompleta." });
  if (v.confirmation === "nao_confirmado" && (v.path !== null || v.pagination !== null || v.detail !== null || v.dateFilter !== null || v.deletedEvidence !== null)) ctx.addIssue({ code: "custom", message: "Recurso não confirmado deve manter acesso desconhecido." });
  if (v.dateFilter && (v.dateFilter.kind === "U" ? v.dateFilter.from !== null || v.dateFilter.to !== null : !v.dateFilter.from || !v.dateFilter.to)) ctx.addIssue({ code: "custom", message: "Filtro temporal incoerente." });
  if (v.pagination?.strategy === "source_page" && v.pagination.short_page_ends) ctx.addIssue({ code: "custom", message: "Página curta não encerra recurso de página persistida." });
  if (v.identityRule.kind === "parental" && !v.identityRule.parent_entity) ctx.addIssue({ code: "custom", message: "Namespace parental ausente." });
});
export const checkpointSchema = z.object({ revision: revisionSchema, cursor: metadataSchema, pass_started_at: timestamp.nullable(), pass_completed_at: timestamp.nullable() }).strict();
export const expectedStateSchema = z.object({ generation: generationSchema, authorization_revision: revisionSchema, credential_revision: revisionSchema, configuration_revision: revisionSchema, account_id: id, parts_revision: revisionSchema }).strict();
export const leaseSchema = z.object({ owner: id, fence: fenceSchema, expires_at: count }).strict();
export const unitSchema = z.object({ work_id: id, attempt_id: id, command_id: id, request_hash: sha, kind: unitKindSchema, entity: entity.nullable(), source_id: canonicalSourceIdSchema.nullable(), resource_key: id.nullable(), phase: unitPhaseSchema, expected: expectedStateSchema, checkpoint: checkpointSchema, lease: leaseSchema.nullable(), not_before: count, plan: metadataSchema, page: z.object({ ids: z.array(canonicalSourceIdSchema).max(25), fingerprint: sha, subcursor: count.max(25) }).strict().refine(v => new Set(v.ids).size === v.ids.length && v.subcursor <= v.ids.length).nullable(), progress: metadataSchema }).strict().refine(v => !["reserved", "fetching"].includes(v.phase) || v.lease !== null);
export const receiptSchema = z.object({ command_id: id, request_hash: sha, generation: generationSchema, operation: id, state: z.enum(["committed", "rejected", "superseded"]), committed_at: timestamp, references: metadataSchema, counts: z.record(id, count), error: failureSchema.nullable() }).strict().refine(v => (v.state === "rejected") === (v.error !== null));
export const captureSchema = z.object({ revision: revisionSchema, profile: id, source: z.enum(["detail", "deleted_without_detail", "stock_product"]), bytes_sha256: sha, semantic_hash: sha, semantic_version: contentVersionSchema, values: z.array(z.object({ path: z.string().min(1).max(1024), lexeme: decimalSchema }).strict()).max(10000) }).strict().refine(v => new Set(v.values.map(p => p.path)).size === v.values.length);
const timeQuality = z.enum(["remote", "observed", "unknown", "invalid"]);
export const rawRecordSchema = z.object({ identity: recordIdentitySchema, version: contentVersionSchema, semantic_hash: sha, payload_text: z.string().min(2).max(16000000), document_links: z.array(jsonObject).max(1000), observed_at: timestamp, source_updated_at: z.string().max(128).nullable(), source_time_quality: timeQuality, deleted: z.boolean(), deletion_evidence: z.string().max(1000).nullable(), capture: captureSchema.nullable() }).strict().refine(v => (!v.deleted || !!v.deletion_evidence) && (!v.capture || v.capture.semantic_hash === v.semantic_hash && v.capture.semantic_version === v.version));
export const recordMetadataSchema = z.object({ identity: recordIdentitySchema, version: contentVersionSchema, semantic_hash: sha, payload_bytes: count, first_observed_at: timestamp, last_observed_at: timestamp, source_updated_at: z.string().max(128).nullable(), source_time_quality: timeQuality, deleted: z.boolean(), mapper_version: id.nullable(), capture_revision: revisionSchema.nullable() }).strict();
export const historicalDtoSchema = z.object({ label: z.literal("Consulta histórica — não opera no ERP"), kind: id, fields: jsonObject, unresolved_references: z.array(jsonObject).max(1000), unmapped_fields: z.array(z.string()).max(10000), coverage: coverageSchema }).strict();
export const recordViewSchema = z.object({ raw: rawRecordSchema, metadata: recordMetadataSchema, historical: historicalDtoSchema, existing_links: z.array(jsonObject).max(1000) }).strict();
const xmlEntity = z.enum(["nfe", "nfce"]);
export const xmlSummarySchema = z.object({ object_id: id, entity: xmlEntity, source_id: canonicalSourceIdSchema, access_key: z.string().regex(/^\d{44}$/), model: z.enum(["55", "65"]), environment: z.enum(["production", "test", "unknown"]), version: revisionSchema, sha256: sha, bytes: count, available: z.boolean(), coverage: z.array(z.string()).max(100) }).strict();
export const xmlDownloadSchema = z.object({ bytes: z.instanceof(Uint8Array), sha256: sha, filename: z.string().max(128).regex(/^[A-Za-z0-9_.-]+\.xml$/), content_type: z.literal("application/xml") }).strict();
export const purgeScopeSchema = z.object({ entities: z.array(entity).max(BLING_ENTITIES.length), all: z.boolean() }).strict().refine(v => v.all ? v.entities.length === 0 : v.entities.length > 0);
export const purgePreviewSchema = z.object({ generation: generationSchema, preview_hash: sha, counts: z.record(id, count), files: count, blocked_references: count }).strict();
const pageParams = { cursor: z.string().min(1).max(2048).optional(), limit: count.min(1).max(50).optional() };
const dateParams = { from: date.optional(), to: date.optional() };
const page = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema).max(50), next_cursor: z.string().max(2048).nullable() }).strict();
const adminResult = z.object({ configuration: publicConfigurationSchema, receipt: receiptSchema }).strict();
const callbackInput = z.object({ state: z.string().max(4096).optional(), code: z.string().max(8192).optional(), error: z.string().max(200).optional(), browser_nonce: z.string().max(4096).optional(), callback_url: z.url() }).strict();
const callbackOutput = z.object({ redirect: z.string().max(2048).regex(/^\/(?!\/)(?:[A-Za-z0-9_.%~-]+\/)*receber-bling$/), state: z.enum(["authorized", "denied", "unavailable"]), clear_cookie: z.literal(true), error: failureSchema.optional() }).strict();

/** Envelopes privados das portas; não são rotas nem schemas publicados no OpenAPI. */
const countsMetadataSchema = z.record(id, count).refine(v => Object.keys(v).length <= 100 && metadataSchema.safeParse(v).success);
export const reserveInputSchema: z.ZodType<BlingReserveInput> = z.object({ unit: unitSchema, owner: id, lease_until: count }).strict();
const sourceExpectationSchema = z.object({ identity: recordIdentitySchema, version: contentVersionSchema.nullable(), semantic_hash: sha.nullable() }).strict().refine(v => (v.version === null) === (v.semantic_hash === null));
export const commitInputSchema: z.ZodType<BlingCommitInput> = z.object({
  unit: unitSchema, expected: expectedStateSchema, fence: fenceSchema, request_hash: sha,
  records: z.array(rawRecordSchema).max(10), next_checkpoint: checkpointSchema,
  source_expectations: z.array(sourceExpectationSchema).max(10), counts: countsMetadataSchema,
}).strict().superRefine((v, ctx) => {
  const refuse = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!v.unit.lease || v.unit.lease.fence !== v.fence) refuse("Fence não corresponde à unidade reservada.");
  if (v.request_hash !== v.unit.request_hash) refuse("Hash do comando não corresponde à tentativa.");
  if (Object.entries(v.expected).some(([key, value]) => value !== v.unit.expected[key as keyof typeof v.expected])) refuse("Geração ou revisão diverge da reserva.");
  const identityKey = (identity: BlingCommitInput["records"][number]["identity"]) => JSON.stringify([identity.profile, identity.account_id, identity.entity, identity.source_id, identity.parent_id ?? null]);
  const expected = new Set(v.source_expectations.map(entry => identityKey(entry.identity)));
  const records = new Set(v.records.map(record => identityKey(record.identity)));
  if (expected.size !== v.source_expectations.length || records.size !== v.records.length) refuse("Identidade duplicada no lote.");
  if (v.records.some(record => !expected.has(identityKey(record.identity)))) refuse("Falta a expectativa de presença ou ausência de uma fonte.");
  const identities = [...v.source_expectations.map(entry => entry.identity), ...v.records.map(record => record.identity)];
  if (identities.some(identity => identity.account_id !== v.expected.account_id) || new Set(identities.map(identity => identity.profile)).size > 1) refuse("Um lote não mistura contas ou áreas.");
  // Provas adicionais de testemunha podem constar em source_expectations. O
  // store valida o checkpoint contra o banco; este schema não presume avanço.
});
export const oauthReservationSchema: z.ZodType<BlingOAuthReservation> = z.object({
  command_id: id, state_hash: sha, browser_hash: sha, session_id: id, actor_id: id,
  config_revision: revisionSchema, generation: generationSchema, expires_at: count,
}).strict();
/** O contrato de entrada não carrega created_at: a janela é medida pelo relógio
 * injetado, nunca por Date.now ou por horário enviado pelo chamador.
 */
export function parseOAuthReservation(ctx: BlingContext, input: unknown): BlingOAuthReservation {
  const parsed = oauthReservationSchema.safeParse(input);
  if (!parsed.success) throw new BlingError("BLING_RESPONSE_INVALID");
  const actor = ctx.identity.actor;
  if (!actor || actor.erp_role !== "admin" || actor.session_id !== parsed.data.session_id || actor.user_id !== parsed.data.actor_id || ctx.origin !== "app") throw new BlingError("BLING_ADMIN_REQUIRED");
  authorizeBlingOperation(ctx, "erp_bling_oauth_start", { command_id: parsed.data.command_id, expected_revision: parsed.data.config_revision });
  const now = ctx.clock.now();
  if (!Number.isSafeInteger(now) || now < 0 || parsed.data.expires_at <= now || parsed.data.expires_at - now > 600000) throw new BlingError("BLING_RESPONSE_INVALID");
  return parsed.data;
}
const queryKeySchema = z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_.-]*(?:\[\])?$/).refine(v => !secretKey.test(v));
export const dataRequestSchema: z.ZodType<BlingDataRequest> = z.object({
  method: z.literal("GET"), resource_key: id, path: resourcePath.refine(v => !/[{}]/.test(v)),
  query: z.record(queryKeySchema, z.union([z.string().max(2048), z.array(z.string().max(2048)).max(25)])).refine(v => Object.keys(v).length <= 100 && JSON.stringify(v).length <= 16384),
  deadline: count, expected: expectedStateSchema,
}).strict();
export const dataResultSchema: z.ZodType<BlingDataResult> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), status: z.literal(200), bytes: z.instanceof(Uint8Array), received_at: count }).strict(),
  z.object({ kind: z.literal("retry"), error: failureSchema, retry_at: count }).strict(),
  z.object({ kind: z.literal("failure"), error: failureSchema, status: count.min(400).max(599) }).strict(),
]);
export const wakeBudgetSchema: z.ZodType<BlingWakeBudget> = z.object({ deadline: count, nextOperationalAt: count.nullable(), maxGets: z.literal(1) }).strict().refine(v => v.nextOperationalAt === null || v.deadline <= v.nextOperationalAt - 250);
export const wakeResultSchema: z.ZodType<BlingWakeResult> = z.object({ worked: z.boolean(), nextWake: count.nullable(), requests: z.union([z.literal(0), z.literal(1)]), error: failureSchema.optional() }).strict();

export interface BlingOperationDescriptor<K extends BlingOperationName = BlingOperationName> {
  name: K; method: "GET" | "POST"; path: string; summary: string; description: string;
  requirement: { all: readonly ["erp"] }; permission: "admin" | "archive_read" | "oauth_callback";
  sensitive: boolean; bot: { default: "propose" | "configured"; configurable: true };
  input: z.ZodType<BlingOperationMap[K]["input"]>; output: z.ZodType<BlingOperationMap[K]["output"]>;
}
export const sensitivitySchema = z.object({ sensitive: z.boolean(), bot: z.object({ default: z.enum(["propose", "configured"]), configurable: z.literal(true) }).strict() }).strict().refine(v => v.bot.default === (v.sensitive ? "propose" : "configured"));
export const operationDescriptorSchema = z.object({
  name: z.enum(BLING_OPERATION_NAMES), method: z.enum(["GET", "POST"]), path: z.string().regex(/^\/[^?#]*$/),
  summary: z.string().min(1).max(200), description: z.string().min(1).max(2000),
  requirement: z.object({ all: z.tuple([z.literal("erp")]) }).strict(),
  permission: z.enum(["admin", "archive_read", "oauth_callback"]), sensitive: z.boolean(),
  bot: z.object({ default: z.enum(["propose", "configured"]), configurable: z.literal(true) }).strict(),
  input: z.custom<z.ZodType>(value => value instanceof z.ZodType), output: z.custom<z.ZodType>(value => value instanceof z.ZodType),
}).strict().refine(v => sensitivitySchema.safeParse({ sensitive: v.sensitive, bot: v.bot }).success);
function operation<K extends BlingOperationName>(name: K, method: "GET" | "POST", path: string, summary: string, description: string, permission: BlingOperationDescriptor["permission"], sensitive: boolean, input: z.ZodType<BlingOperationMap[K]["input"]>, output: z.ZodType<BlingOperationMap[K]["output"]>): BlingOperationDescriptor<K> {
  return Object.freeze({ name, method, path, summary, description, requirement: { all: ["erp"] as const }, permission, sensitive, bot: { default: sensitive ? "propose" as const : "configured" as const, configurable: true as const }, input, output });
}
/** Fonte única para rotas, permissões, parâmetros, efeitos e futura documentação OpenAPI.
 * O catálogo atual do núcleo ainda não enumera o repasse ERP; a integração é externa a esta base.
 */
export const BLING_OPERATIONS = {
  erp_bling_status: operation("erp_bling_status", "GET", "/", "Consultar o estado do recebimento do Bling", "Retorna estado, revisões, capacidades, conta pública, cobertura e ocupação; não expõe credenciais.", "archive_read", false, empty, statusSchema),
  erp_bling_resources: operation("erp_bling_resources", "GET", "/recursos", "Consultar recursos disponíveis do Bling", "Lista seleção, confirmação oficial e limitações de cada recurso; não executa chamadas externas.", "archive_read", false, empty, z.object({ version: id, resources: z.array(resourceDescriptorSchema).max(128), selections: z.array(selectionSchema).max(128), limitations: z.array(z.string()).max(100) }).strict()),
  erp_bling_configure: operation("erp_bling_configure", "POST", "/configuracao", "Configurar o recebimento e o acesso ao acervo", "Altera seleção, datas, quota e permissões por pessoa/bot; habilitar dados para IA exige aviso e auditoria.", "admin", true, commandSchema.extend({ selections: z.array(selectionSchema).max(128), daily_call_limit: count.min(1).max(20000), access: accessPolicySchema, ai_disclosure_acknowledged: z.boolean() }).strict().refine(v => !(v.access.bots.some(b => b.data_scopes.length) || v.access.customer_delivery.enabled) || v.ai_disclosure_acknowledged), adminResult),
  erp_bling_app_save: operation("erp_bling_app_save", "POST", "/aplicativo", "Guardar a configuração do aplicativo do Bling", "Guarda identificador e segredo exclusivamente no cofre; devolve presença, revisão e retorno público.", "admin", true, commandSchema.extend({ client_id: z.string().min(1).max(1024).meta({ writeOnly: true }), client_secret: z.string().min(1).max(8192).meta({ writeOnly: true }) }).strict(), z.object({ configured: z.boolean(), revision: revisionSchema, callback_url: z.url(), receipt: receiptSchema }).strict()),
  erp_bling_enable: operation("erp_bling_enable", "POST", "/ligar", "Ligar o recebimento de dados do Bling", "Registra aprovação administrativa da seleção e avisos; ainda exige conta autorizada e referência oficial conferida.", "admin", true, commandSchema.extend({ warning_confirmed: z.literal(true), checklist_hash: sha }).strict(), adminResult),
  erp_bling_disable: operation("erp_bling_disable", "POST", "/desligar", "Desligar o recebimento de dados do Bling", "Impede novas chamadas e invalida commits em curso; preserva o acervo.", "admin", true, commandSchema, adminResult),
  erp_bling_oauth_start: operation("erp_bling_oauth_start", "POST", "/autorizar", "Iniciar a autorização da conta do Bling", "Reserva estado de uso único por até dez minutos e entrega URL efêmera; cookie protegido é produzido pelo servidor. URL não entra em recibo ou auditoria.", "admin", true, commandSchema, z.object({ authorization_url: z.url().refine(v => v.startsWith("https://")), expires_at: count }).strict()),
  erp_bling_oauth_callback: operation("erp_bling_oauth_callback", "GET", "/api/public/erp-bling/:profile/callback", "Concluir a autorização da conta do Bling", "Consome estado uma vez, confere cookie, sessão administrativa e revisões; custodia credenciais antes do redirecionamento fixo.", "oauth_callback", true, callbackInput, callbackOutput),
  erp_bling_disconnect: operation("erp_bling_disconnect", "POST", "/desconectar", "Desconectar a conta do Bling", "Remove segredo do cofre, mantém revisão tombstone e acervo e orienta revogação no aplicativo autorizado.", "admin", true, commandSchema, adminResult.extend({ revocation_guidance: z.string().max(2000) }).strict()),
  erp_bling_collect_request: operation("erp_bling_collect_request", "POST", "/coletar", "Pedir uma nova passagem de coleta", "Agenda recursos já selecionados respeitando quota, partes, revisão e rate limit; não modifica registros operacionais.", "admin", true, commandSchema.extend({ resource_keys: z.array(id).min(1).max(128) }).strict(), z.object({ run_id: id, next_wake: count.nullable(), receipt: receiptSchema }).strict()),
  erp_bling_records_list: operation("erp_bling_records_list", "GET", "/acervo", "Listar registros do acervo recebido", "Consulta resumos por entidade e cursor, com no máximo cinquenta registros e permissões de leitura/IA configuradas.", "archive_read", false, z.object({ entity, ...pageParams, deleted: z.boolean().optional(), ...dateParams }).strict(), page(recordMetadataSchema)),
  erp_bling_record_get: operation("erp_bling_record_get", "GET", "/acervo/:entity/:id", "Consultar uma versão de registro recebido", "Resolve versão corrente ou histórica e devolve bruto, espelho, metadados, vínculos existentes e cobertura; não opera no ERP.", "archive_read", false, z.object({ entity, id: canonicalSourceIdSchema, version: contentVersionSchema.optional() }).strict(), recordViewSchema),
  erp_bling_versions_list: operation("erp_bling_versions_list", "GET", "/acervo/:entity/:id/versoes", "Listar versões de um registro recebido", "Consulta versões e hashes sem presumir que o arquivo histórico contém a versão corrente.", "archive_read", false, z.object({ entity, id: canonicalSourceIdSchema, ...pageParams }).strict(), page(recordMetadataSchema)),
  erp_bling_xml_list: operation("erp_bling_xml_list", "GET", "/xml", "Listar o histórico fiscal recebido", "Lista notas e XML com identidade NF-e/NFC-e separada, disponibilidade e cobertura; não certifica assinatura criptográfica.", "archive_read", false, z.object({ entity: xmlEntity.optional(), ...pageParams, ...dateParams }).strict(), page(xmlSummarySchema)),
  erp_bling_xml_get: operation("erp_bling_xml_get", "GET", "/xml/:objectId", "Baixar um XML do acervo recebido", "Lê bytes autenticados por referência opaca, hash e nome seguro, com as mesmas permissões do acervo.", "archive_read", false, z.object({ object_id: id }).strict(), xmlDownloadSchema),
  erp_bling_purge_preview: operation("erp_bling_purge_preview", "POST", "/apagar/previa", "Conferir a prévia de apagamento do acervo", "Calcula contagens, arquivos e referências impeditivas e vincula a prévia ao hash e à geração; não apaga conteúdo.", "admin", true, z.object({ scope: purgeScopeSchema, generation: generationSchema }).strict(), purgePreviewSchema),
  erp_bling_purge_apply: operation("erp_bling_purge_apply", "POST", "/apagar", "Apagar o acervo recebido após confirmação", "Confere hash da prévia, recusa referências operacionais, aposenta geração e agenda exclusão SQL/R2 limitada e retomável.", "admin", true, commandSchema.extend({ scope: purgeScopeSchema, generation: generationSchema, preview_hash: sha, confirmed: z.literal(true) }).strict(), z.object({ work_id: id, receipt: receiptSchema.nullable() }).strict()),
  erp_bling_command_get: operation("erp_bling_command_get", "GET", "/comandos/:id", "Consultar o resultado de um comando de coleta", "Retorna fase e recibo saneado; absent indica comando sem reserva nem recibo. Consultar não repete chamada externa nem avança checkpoint.", "archive_read", false, z.object({ id }).strict(), z.object({ phase: unitPhaseSchema.or(z.literal("absent")), receipt: receiptSchema.nullable() }).strict()),
} as const;
/** Escritas administrativas que gravam recibo por command_id. Depois de
 * gravadas, a resposta é o próprio recibo: a fotografia de partes conferida no
 * começo autoriza o efeito, e uma revisão que chega depois só impede trabalho
 * novo (repetir o comando devolve o mesmo recibo, sem executar de novo). */
export const BLING_RECEIPTED_OPERATIONS: ReadonlySet<BlingOperationName> = new Set<BlingOperationName>([
  "erp_bling_configure", "erp_bling_app_save", "erp_bling_enable", "erp_bling_disable",
  "erp_bling_disconnect", "erp_bling_collect_request", "erp_bling_purge_apply",
]);
export function getBlingOperation(name: string): BlingOperationDescriptor | null { return Object.hasOwn(BLING_OPERATIONS, name) ? BLING_OPERATIONS[name as BlingOperationName] as BlingOperationDescriptor : null; }
export function parseBlingOperationInput<K extends BlingOperationName>(name: K, input: unknown): BlingOperationMap[K]["input"] {
  const parsed = BLING_OPERATIONS[name].input.safeParse(input);
  if (!parsed.success) throw new BlingError("BLING_RESPONSE_INVALID");
  return parsed.data as BlingOperationMap[K]["input"];
}
/** Somente contexto autenticado do núcleo pode conceder ou confirmar. Origem
 * externa conserva o teto de cliente, mesmo se usar telefone de pessoa da equipe.
 * O callback público usa a porta própria de OAuth, nunca este despachante.
 */
export function authorizeBlingOperation<K extends BlingOperationName>(ctx: BlingContext, name: K, input: unknown): void {
  const definition = BLING_OPERATIONS[name];
  const actor = ctx.identity.actor;
  if (ctx.origin !== "app" || !actor || !actor.erp_role || definition.permission === "oauth_callback") throw new BlingError("BLING_ADMIN_REQUIRED");
  if (!ctx.identity.parts?.customers) throw new BlingError("BLING_DISABLED", { status: 409 });
  const contextAuthorization = BlingAuthorizationContextSchema.safeParse(ctx.authorization ?? {});
  if (!contextAuthorization.success) throw new BlingError("BLING_SCOPE_REQUIRED");
  const authorization = contextAuthorization.data;
  if (definition.permission === "admin" && (actor.erp_role !== "admin" || !actor.session_id && !(actor.is_agent && authorization.delegation && authorization.bot?.allow_sensitive))) throw new BlingError("BLING_ADMIN_REQUIRED");
  if (definition.permission === "archive_read" && actor.erp_role !== "admin" && !authorization?.read_granted) throw new BlingError("BLING_SCOPE_REQUIRED");
  if (!actor.is_agent) return;
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const bot = authorization?.bot;
  if (!bot?.allowed_operations.includes(name)) throw new BlingError("BLING_SCOPE_REQUIRED");
  if (definition.permission === "archive_read") {
    const selectedEntity = entity.safeParse(body.entity).success ? body.entity as typeof BLING_ENTITIES[number] : undefined;
    if (!bot.data_scopes.includes("public")) throw new BlingError("BLING_SCOPE_REQUIRED");
    if (selectedEntity && !bot.allowed_entities.includes(selectedEntity)) throw new BlingError("BLING_SCOPE_REQUIRED");
    if (name === "erp_bling_record_get" && !bot.data_scopes.includes("raw")) throw new BlingError("BLING_SCOPE_REQUIRED");
    if (name === "erp_bling_xml_get" || name === "erp_bling_xml_list") {
      if (!bot.data_scopes.includes("xml") || !selectedEntity && !(bot.allowed_entities.includes("nfe") && bot.allowed_entities.includes("nfce"))) throw new BlingError("BLING_SCOPE_REQUIRED");
    }
  }
  if (definition.sensitive && !bot.allow_sensitive) {
    const confirmation = authorization?.confirmation;
    // Prévia não cria comando durável: a confirmação fica vinculada ao hash
    // integral do pedido, além de operação, pessoa e prazo da confirmação.
    const command = typeof body.command_id === "string" ? body.command_id : name === "erp_bling_purge_preview" ? authorization.request_hash : undefined;
    if (!confirmation || !command || confirmation.command_id !== command || confirmation.operation !== name || !authorization?.request_hash || confirmation.request_hash !== authorization.request_hash || confirmation.expires_at <= ctx.clock.now() || confirmation.confirmed_by !== actor.user_id) throw new BlingError("BLING_SCOPE_REQUIRED");
  }
}

/** Contrato do módulo pronto para o catálogo. Nenhuma rota é instalada aqui. */
function moduleOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, Record<string, unknown>> = {};
  const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
  const reference = (name: string) => `#/components/schemas/${pointer(name)}`;
  /** Cada conversão do Zod tem sua própria raiz e nomes locais de definições.
   * Promovemos essas definições, com namespace da operação, para que nenhuma
   * referência seja interpretada relativamente à raiz errada do OpenAPI.
   */
  const register = (type: z.ZodType, name: string) => {
    const generated = z.toJSONSchema(type, { target: "openapi-3.0" }) as Record<string, unknown>;
    const definitions = new Map<string, { name: string; schema: Record<string, unknown> }>();
    for (const container of ["definitions", "$defs"]) {
      const entries = generated[container];
      if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        for (const [key, value] of Object.entries(entries)) {
          definitions.set(`#/${container}/${pointer(key)}`, { name: `${name}_${container === "$defs" ? "Defs" : "Definitions"}_${key}`, schema: value as Record<string, unknown> });
        }
      }
    }
    const rewriteRef = (ref: string): string => {
      if (ref === "#") return reference(name);
      if (!ref.startsWith("#/")) return ref;
      for (const [local, promoted] of definitions) {
        if (ref === local || ref.startsWith(local + "/")) return reference(promoted.name) + ref.slice(local.length);
      }
      return reference(name) + ref.slice(1);
    };
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "$ref" && typeof item === "string" ? rewriteRef(item) : rewrite(item)]));
    };
    for (const promoted of definitions.values()) schemas[promoted.name] = rewrite(promoted.schema) as Record<string, unknown>;
    const { definitions: _definitions, $defs: _defs, ...root } = generated;
    const document = rewrite(root) as Record<string, unknown>;
    schemas[name] = document;
    return { document, ref: { $ref: reference(name) } };
  };
  const failure = register(z.object({ error: failureSchema }).strict(), "BlingFailureResponse");
  const errorResponse = { description: "Falha saneada, sem corpo remoto nem credenciais.", content: { "application/json": { schema: failure.ref } } };
  for (const definition of Object.values(BLING_OPERATIONS)) {
    const callback = definition.name === "erp_bling_oauth_callback";
    const path = callback ? definition.path.replace(":profile", "{profile}") : `/api/v1/profiles/{profile}/erp/v1/receber-bling${definition.path === "/" ? "" : definition.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")}`;
    // Browser nonce vem exclusivamente de cookie; retorno é derivado da instalação.
    const schema = register(callback ? callbackInput.pick({ state: true, code: true, error: true }) : definition.input, `${definition.name}_Input`);
    const parameters: Record<string, unknown>[] = [{ name: "profile", in: "path", required: true, schema: { type: "string" } }];
    if (definition.method === "GET") {
      const properties = (schema.document.properties ?? {}) as Record<string, unknown>;
      const required = (schema.document.required ?? []) as string[];
      for (const [key, property] of Object.entries(properties)) {
        const parameter = key === "object_id" ? "objectId" : key;
        const inPath = path.includes(`{${parameter}}`);
        parameters.push({ name: parameter, in: inPath ? "path" : "query", required: inPath || required.includes(key), schema: property });
      }
    }
    const success = definition.name === "erp_bling_xml_get" ? { description: definition.summary, content: { "application/xml": { schema: { type: "string", format: "binary" } } }, headers: { "X-Content-SHA256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } } } } : callback ? { description: "Redirecionamento fixo, sem código OAuth na URL final.", headers: { Location: { schema: { type: "string" } } } } : { description: definition.summary, content: { "application/json": { schema: register(definition.output, `${definition.name}_Output`).ref } } };
    paths[path] ??= {};
    paths[path][definition.method.toLowerCase()] = {
      operationId: definition.name, summary: definition.summary,
      description: `${definition.description} Permissão: erp:${definition.permission}. Requisito: Base.`, parameters,
      ...(definition.method === "POST" ? { requestBody: { required: true, content: { "application/json": { schema: schema.ref } } } } : {}),
      responses: { [callback ? "302" : "200"]: success, "403": errorResponse, "409": errorResponse, "503": errorResponse },
      "x-sensitive": definition.sensitive, "x-bot-default": definition.bot.default,
    };
  }
  return { openapi: "3.0.3", info: { title: "Receber dados do Bling", version: "1" }, paths, components: { schemas } };
}
export const BLING_MODULE_CONTRACT = Object.freeze({
  definition: {
    id: "erp", title: "Receber dados do Bling",
    bot: {
      sensitive: Object.values(BLING_OPERATIONS).filter(op => op.sensitive).map(op => op.name),
      hints: Object.fromEntries(Object.values(BLING_OPERATIONS).map(op => [op.name, op.summary])),
    },
  },
  openapi: moduleOpenApi(),
});
