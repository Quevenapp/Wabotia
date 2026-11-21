import type { RpcContext } from "../../../engine/registry.ts";
import { raise } from "../../../engine/errors.ts";
import type {
  CancelClaimInput, CancelClaimResult, CancelRecordInput, CancellationXmlInput, ClaimInput,
  ClaimResult, CommercialNfeSlots, EmissionView, FiscalResult, ImmutableRevision, JsonObject, JsonValue, RecordInput,
} from "../../../commercial-nfe/contracts.ts";
import { parseCancellationXml } from "../../../commercial-nfe/artifacts.ts";
import { requireCom1Access } from "./access.ts";
import { com1Model } from "./model.ts";
import { COM1_MODULE_EFFECTS, com1ModuleDocument } from "./effect-policy.ts";
import { requireCommercialEmissionVisible, requireCommercialReadParts } from "./reads.ts";
import { readCommercialSettings } from "./settings.ts";
import {
  COM1_TABLES as T, appendCom1Audit, claimStoredCancellation, claimStoredOperation, com1Hash, com1Json,
  com1Sha256, com1Uuid, finishCommand, getCommand, getEmissionView, getStoredEmission, getStoredRevision,
  recordCancellationEvidence, recordExternalEvidence, replayCommand, requireClaimedCommand,
  saveCancellationXml, startCommand,
} from "./store.ts";

export interface CommercialNfeLifecycleOptions {
  /** Releitura síncrona das fontes do preparo, na mesma transação do claim.
   * A integração instala a implementação de preparo; ausência bloqueia envio. */
  sourceFingerprint?: (ctx: RpcContext, revision: ImmutableRevision) => string;
  leaseMicros?: bigint;
}
type LifecycleSlots = Pick<CommercialNfeSlots, "claim" | "record" | "cancelClaim" | "cancelRecord" | "recordCancellationXml">;
const sha = /^[0-9a-f]{64}$/;
const conclusive = new Set(["autorizada", "cancelada", "denegada", "rejeitada", "arquivada"]);
const positive = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) > 0;

/** Resultado do provedor é entrada não confiável. Malformação conserva a
 * evidência restrita e fica incerta, sem quebrar o commit por TypeError. */
export function normalizeCommercialResult(value: unknown): FiscalResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  // NFS-e: série de até 5 dígitos, número da DPS de até 15, chave nacional de
  // até 50 caracteres e o número da NFS-e no lugar do protocolo (model.ts).
  const service = com1Model() === "nfse";
  const protocol = service ? r.nfse_number : r.protocol;
  if (r.kind !== com1Model() || !["authorized", "rejected", "denied", "processing", "error", "undetermined", "cancelled", ...(com1Model() === "nfce" ? ["contingency"] : [])].includes(String(r.status)) ||
      typeof r.provider_ref !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(r.provider_ref) ||
      typeof r.reference !== "string" || !r.reference || !["homologacao", "producao"].includes(String(r.environment)) ||
      typeof r.series !== "string" || !(service ? /^\d{0,5}$/ : /^\d{0,3}$/).test(r.series) || !Number.isSafeInteger(r.number) || Number(r.number) < 0 ||
      Number(r.number) > (service ? 999999999999999 : 999999999) ||
      !Array.isArray(r.messages) || r.messages.length > 1000 || r.messages.some(message => !message || typeof message !== "object" ||
        typeof message.code !== "string" || typeof message.description !== "string" || message.code.length > 200 || message.description.length > 10000) ||
      (r.access_key != null && (typeof r.access_key !== "string" || !(service ? /^[0-9A-Z]{44,50}$/ : /^[0-9A-Z]{44}$/).test(r.access_key))) ||
      (protocol != null && (typeof protocol !== "string" || protocol.length > 100 || /[\u0000-\u001f\u007f]/.test(protocol))) ||
      ["issued_at", "authorized_at"].some(field => r[field] != null && (typeof r[field] !== "string" || !Number.isFinite(Date.parse(String(r[field]))))) ||
      (r.total != null && (typeof r.total !== "number" || !Number.isFinite(r.total) || r.total < 0 || !Number.isSafeInteger(Math.round(r.total * 100))))) return null;
  return {
    kind: com1Model(), status: r.status as FiscalResult["status"], provider_ref: r.provider_ref,
    reference: r.reference, environment: r.environment as FiscalResult["environment"], series: r.series, number: Number(r.number),
    access_key: r.access_key as string | null ?? null, protocol: protocol as string | null ?? null,
    nfse_number: service ? protocol as string | null ?? null : null, issued_at: r.issued_at as string | null ?? null, authorized_at: r.authorized_at as string | null ?? null,
    total: r.total as number | null ?? null, qr_code: null, consult_url: null,
    corrections: Number.isSafeInteger(r.corrections) ? Number(r.corrections) : 0,
    messages: r.messages.map(m => ({ code: m.code, description: m.description })), xml_available: r.xml_available === true,
    replayed: r.replayed === true, event_repeated: typeof r.event_repeated === "boolean" ? r.event_repeated : null, contingency: null,
  };
}

const secret = /(?:authorization|api.?key|password|senha|certificate|certificado|secret|credential|token)/i;
function safeEvidence(value: unknown, depth = 0): JsonValue {
  if (depth > 20) return "[limite]";
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 20000);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 1000).map(v => safeEvidence(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !secret.test(k)).slice(0, 1000).map(([k,v]) => [k, safeEvidence(v, depth + 1)]));
  return null;
}
function safeInput<T extends RecordInput | CancelRecordInput>(input: T): T {
  const result = normalizeCommercialResult(input.result);
  const evidence: JsonObject = { provider: safeEvidence(input.evidence ?? null), provider_result: safeEvidence(input.result) };
  if (input.result !== null && !result) evidence.malformed_result = safeEvidence(input.result);
  const error = input.result !== null && !result
    ? { code: "fiscal_malformed_result", message: "O cofre devolveu um resultado incompleto. Consulte a mesma emissão." }
    : input.error ? { code: /^[a-zA-Z0-9_.-]{1,160}$/.test(input.error.code) ? input.error.code : "fiscal_provider_error", message: "A operação precisa de consulta no mesmo cofre." } : undefined;
  return { ...input, result, evidence, ...(error ? { error } : {}) };
}

function firstSendConfiguration(ctx: RpcContext, view: EmissionView): void {
  const settings = readCommercialSettings(ctx);
  if (!settings.connection_fingerprint) raise("55000", "fiscal_provider_not_configured");
  if (settings.connection_fingerprint !== view.connection_fingerprint) raise("40001", "fiscal_connection_changed");
  if (settings.environment !== view.environment) raise("40001", "fiscal_environment_conflict");
  const connection = settings.connection_public;
  if (!connection || connection.compatible !== true) raise("55000", "fiscal_provider_incompatible");
  if (!Array.isArray(connection.environments) || !connection.environments.includes(view.environment)) raise("55000", "fiscal_environment_not_allowed");
  if (view.environment === "producao" && !settings.production_enabled_at) raise("55000", "fiscal_production_not_enabled");
}

function rememberParts(ctx: RpcContext, claim: ClaimResult | CancelClaimResult): void {
  if (!["send", "resume"].includes(claim.disposition) || !claim.command.request) return;
  const result = { ...claim.command.result, effect_parts: { stock: ctx.parts.stock, finance: ctx.parts.finance } };
  ctx.db.exec(`UPDATE ${T.command} SET result=? WHERE id=?`, com1Json(result), claim.command.id);
  claim.command = getCommand(ctx, claim.command.id)!;
}

function preserveParts(ctx: RpcContext, commandId: string, parts: JsonValue | undefined): void {
  if (parts !== undefined) ctx.db.exec(`UPDATE ${T.command} SET result=json_set(COALESCE(result,'{}'),'$.effect_parts',json(?)) WHERE id=?`, com1Json(parts), commandId);
}

function receiptRequest(view: EmissionView): JsonObject {
  return { kind: com1Model(), environment: view.environment, reference: view.reference, connection_fingerprint: view.connection_fingerprint,
    body_text: view.revision.body ? com1Json(view.revision.body) : null, body_hash: view.revision.body_hash,
    provider_id: view.provider_id, fiscal_version: view.fiscal_version, document_id: view.document_id };
}

/** Registra somente pendências; nunca aplica estoque/títulos durante commit
 * fiscal nem usa os privilégios da capacidade para realizar efeitos locais. */
function initializeEffectPendencies(ctx: RpcContext, input: RecordInput | CancelRecordInput): EmissionView {
  const view = getEmissionView(ctx, input.emission_id);
  if (!["autorizada", "cancelada"].includes(view.status)) return view;
  const command = requireClaimedCommand(ctx, input);
  const parts = command.result?.effect_parts as JsonObject | undefined;
  // Nota da ordem de serviço: os efeitos são os da fase 3. Nada fica
  // pendente nem pede compensação quando a nota é cancelada.
  const module = com1ModuleDocument(ctx, view.document_id);
  for (const axis of ["stock", "finance"] as const) {
    const disabled = parts?.[axis] === false, at = String(ctx.clock.next());
    const state = module || disabled ? "pulado" : "pendente";
    const reason = module ? COM1_MODULE_EFFECTS : disabled ? "part_disabled" : "awaiting_local_effect";
    const inserted = ctx.db.exec(`INSERT INTO ${T.effect} (emission_id,axis,state,reason,responsible_role,ids,updated_at)
      VALUES (?,?,?,?,?,'{}',?) ON CONFLICT(emission_id,axis) DO NOTHING`, view.id, axis,
      state, reason, axis === "stock" ? "estoque" : "financeiro", at);
    if (inserted.rowsWritten) appendCom1Audit(ctx, { command, emission: view, action: "effect_pending", after: { axis, state, reason } });
    if (view.status === "cancelada" && !module) {
      const updated = ctx.db.exec(`UPDATE ${T.effect} SET compensation_state='compensacao_pendente',
      compensation_result=?,updated_at=? WHERE emission_id=? AND axis=? AND compensation_state IS NULL
      AND (compensation_result IS NULL OR json_extract(compensation_result,'$.state') IS NOT 'transferido')`,
      com1Json({ reason: axis === "stock" ? "physical_return_confirmation_required" : "awaiting_financial_reconciliation" }), at, view.id, axis);
      if (updated.rowsWritten) appendCom1Audit(ctx, { command, emission: view, action: "compensation_pending", after: { axis, state: "compensacao_pendente" } });
    }
  }
  return getEmissionView(ctx, view.id);
}

export function createCommercialNfeLifecycle(options: CommercialNfeLifecycleOptions = {}): LifecycleSlots {
  const lease = options.leaseMicros ?? 60_000_000n;
  return {
    claim(ctx, input: ClaimInput): ClaimResult {
      requireCom1Access(ctx, input.action);
      requireCommercialReadParts(ctx);
      com1Uuid(input.emission_id); com1Uuid(input.command_id);
      if (!["emit", "resume"].includes(input.action) || !positive(input.expected_version) || !positive(input.body_revision) ||
          !sha.test(input.body_hash) || !sha.test(input.connection_fingerprint)) raise("22023", "com1_input_invalid");
      const view = getEmissionView(ctx, input.emission_id);
      requireCommercialEmissionVisible(ctx, view);
      // A origem é calculada no motor. Este campo só entra no recibo de forma
      // estável: reexecutar um comando não recalcula seu hash de argumentos.
      const normalized: ClaimInput = { ...input, ...(input.action === "emit" ? { source_fingerprint: getStoredRevision(ctx, view.id, input.body_revision).source_fingerprint } : {}) };
      const replay = replayCommand(ctx, { command_id: input.command_id, action: input.action, args: normalized });
      if (replay) return { emission: view, revision: view.revision, command: replay, disposition: "replay" };
      if (view.connection_fingerprint !== input.connection_fingerprint) raise("40001", "fiscal_connection_changed");
      if (input.body_revision !== view.current_body_revision || input.body_hash !== view.revision.body_hash) raise("40001", "com1_version_conflict");
      if (conclusive.has(view.status) || (input.action === "emit" && ["enviando", "incerta", "processando"].includes(view.status))) {
        const command = startCommand(ctx, { command_id: input.command_id, action: input.action, args: normalized, emission_id: view.id, body_revision: view.current_body_revision, request: receiptRequest(view) });
        const completed = conclusive.has(view.status);
        const receipt = finishCommand(ctx, command.id, completed ? "completed" : "pending", { emission_id: view.id, status: view.status });
        appendCom1Audit(ctx, { command, emission: view, action: "operation_replay", after: { status: view.status } });
        return { emission: view, revision: view.revision, command: receipt, disposition: completed ? "replay" : "busy" };
      }
      if (input.action === "emit") {
        // A nota de serviço da ordem exige só Base e Fiscal; a NF-e (também a
        // das peças da ordem) exige Vendas e Produtos; o cupom, o Caixa / PDV.
        if (com1Model() !== "nfse" && (!ctx.parts.sales || !ctx.parts.products)) raise("55000", "module_disabled");
        if (com1Model() === "nfce" && !ctx.parts.pos) raise("55000", "module_disabled");
        if (view.status !== "preparada" || !view.revision.body || view.revision.blockers.length) raise("55000", "com1_preparation_blocked");
        firstSendConfiguration(ctx, view);
        if (!options.sourceFingerprint) raise("0A000", "com1_not_ready");
        const fingerprint = options.sourceFingerprint(ctx, view.revision);
        if (fingerprint !== view.revision.source_fingerprint) {
          const command = startCommand(ctx, { command_id: input.command_id, action: input.action, args: normalized, emission_id: view.id, body_revision: view.current_body_revision, request: receiptRequest(view) });
          ctx.db.exec(`UPDATE ${T.emission} SET status='bloqueada',version=version+1,messages=?,updated_at=? WHERE id=?`,
            com1Json([{ code: "fiscal_source_changed", description: "O pedido ou os dados fiscais mudaram. Atualize a preparação e confira novamente." }]), String(ctx.clock.next()), view.id);
          const receipt = finishCommand(ctx, command.id, "failed", { emission_id: view.id, status: "bloqueada" }, { code: "fiscal_source_changed" });
          appendCom1Audit(ctx, { command, emission: view, action: "source_changed", after: { status: "bloqueada", source_changed: true } });
          return { emission: getStoredEmission(ctx, view.id), revision: view.revision, command: receipt, disposition: "replay" };
        }
      }
      const result = claimStoredOperation(ctx, normalized, lease);
      rememberParts(ctx, result);
      return result;
    },
    record(ctx, input: RecordInput) {
      const command = requireClaimedCommand(ctx, input, ["emit", "resume"]);
      const view = getEmissionView(ctx, input.emission_id);
      const safe = safeInput(input), result = safe.result;
      const body = getStoredRevision(ctx, view.id, command.body_revision ?? undefined).body;
      // A nota cancelada direto no cofre também traz a identidade da autorização.
      // A NFS-e não tem emitente no corpo nem série numérica até 889: a
      // identidade dela é conferida pela referência, ambiente e vínculo.
      if (com1Model() !== "nfse" && (result?.status === "authorized" || result?.status === "cancelled") && result.access_key &&
          ((body?.emitente?.cnpj && result.access_key.slice(6, 20) !== body.emitente.cnpj) ||
           Number(result.series) > 889 || (body?.serie != null && Number(result.series) !== body.serie))) {
        safe.evidence = { ...safe.evidence, inconsistent_result: safeEvidence(result) };
        safe.result = null;
        safe.error = { code: "fiscal_authorization_identity_mismatch", message: "A identificação retornada precisa de conciliação no mesmo cofre." };
      }
      if (view.status === "rejeitada" && command.body_revision === view.current_body_revision && !["authorized", "cancelled"].includes(safe.result?.status ?? "")) {
        const entry = { result: safe.result, evidence: safe.evidence ?? null, error: safe.error ?? null };
        const hash = com1Hash(entry);
        const previous = Array.isArray(command.result?.evidence) ? command.result!.evidence : [];
        const entries = previous.some(e => e && typeof e === "object" && !Array.isArray(e) && e.hash === hash) ? previous : [...previous, { hash, ...entry }];
        finishCommand(ctx, command.id, "completed", { evidence: entries as JsonValue[], status: "rejeitada" },
          safe.result?.status === "rejected" ? null : { code: "com1_late_conflicting_evidence" });
        preserveParts(ctx, command.id, command.result?.effect_parts);
        appendCom1Audit(ctx, { command, emission: view, action: "record_late", after: { status: view.status, evidence_hash: hash } });
        return view;
      }
      recordExternalEvidence(ctx, safe);
      preserveParts(ctx, command.id, command.result?.effect_parts);
      return initializeEffectPendencies(ctx, input);
    },
    cancelClaim(ctx, input: CancelClaimInput): CancelClaimResult {
      requireCom1Access(ctx, "cancel"); requireCommercialReadParts(ctx);
      com1Uuid(input.emission_id); com1Uuid(input.command_id);
      if (!positive(input.expected_version) || !sha.test(input.connection_fingerprint)) raise("22023", "com1_input_invalid");
      const view = getEmissionView(ctx, input.emission_id);
      requireCommercialEmissionVisible(ctx, view);
      const result = claimStoredCancellation(ctx, input, lease);
      // Um novo recibo de repetição não tem token. Para arquivar XML pendente,
      // a ponte recebe a capacidade original, somente no transporte interno.
      if (result.disposition === "replay" && result.cancellation.state === "registrado" && result.cancellation.xml_status === "pendente") {
        const original = getCommand(ctx, result.cancellation.command_id);
        if (original?.token) result.command = original;
      }
      rememberParts(ctx, result);
      return result;
    },
    cancelRecord(ctx, input: CancelRecordInput) {
      const command = requireClaimedCommand(ctx, input, ["cancel"]);
      if (!["incerto", "recusado", "registrado"].includes(input.state)) raise("22023", "com1_input_invalid");
      recordCancellationEvidence(ctx, safeInput(input));
      preserveParts(ctx, command.id, command.result?.effect_parts);
      return initializeEffectPendencies(ctx, input);
    },
    recordCancellationXml(ctx, input: CancellationXmlInput) {
      requireClaimedCommand(ctx, input, ["cancel"]);
      if (typeof input.xml !== "string" || new TextEncoder().encode(input.xml).byteLength > 10 * 1024 * 1024 || com1Sha256(input.xml) !== input.xml_hash)
        raise("22023", "com1_cancellation_xml_invalid");
      const view = getEmissionView(ctx, input.emission_id);
      const event = parseCancellationXml(input.xml, view);
      if (event.protocol !== view.cancellation?.protocol || event.event_at !== view.cancellation?.event_at) raise("40001", "com1_cancellation_xml_conflict");
      return saveCancellationXml(ctx, input);
    },
  };
}

export const createCommercialNfeLifecycleSlots = createCommercialNfeLifecycle;
