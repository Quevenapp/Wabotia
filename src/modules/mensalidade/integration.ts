// Projeção comercial por lista permitida. Nunca exportar o interlocutor,
// nome do plano, observações, documento digitado ou conteúdo de atendimento.
import { all, batch as d1Batch, one } from "../../db";
import { type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { requireAccess } from "../../access";
import { modulesApi, type ModuleContext } from "../api";
import type { Payment } from "../../payments";
import { optionalCommercialPaymentEvidence, commercialPaymentEvidence, commercialReceiptFromEvidence } from "../../payments-commercial-evidence";
import type { CommercialSnapshot, IntegrationEvent, SourceRef, Statement } from "../../integrations/contracts";
import {
  aliasStatements, catalogLink, commandId, ensureCommercialPolicy, eventKey,
  integrationStatements, readIntegrationActivation,
} from "../../integrations/ports";
import { integrationCasGuard, sourceBindings } from "../../integrations/outbox";
import { localEventId, canonical, F3_NAMESPACES, hash, uuid5 } from "../../integrations/keys";
import { integer, IntegrationError, opaque, sanitizedError } from "../../integrations/privacy";
import {
  allocationKey, allocationStatements, commercialReceiptStatements, manualReceiptKey,
  providerReceiptKey, reverseReceiptKey, type CommercialReceipt,
} from "../../integrations/receipts";
import { today } from "./model";
import { humanReferenceRpc, requireIntegrationHuman } from "../../integrations/policy";
import { requireFinancialAal } from "../../mfa";
import { eventStatement } from "../../events";
import { notifyInstallmentRefunded } from "./listeners";

export { integrationCasGuard as mensalidadeCasGuard };
export async function commitMensalidade(env: Env, statements: Statement[]) {
  try { return await d1Batch(env, statements); }
  catch (error) {
    if (/malformed JSON|integration_version_conflict|mensalidade_.*conflict/i.test(String(error))) throw new IntegrationError("version_conflict", 409);
    throw sanitizedError(error);
  }
}
/** Mesmo identificador de ctx.publish: o lote grava; a publicação faz fan-out. */
export function mensalidadeHistory(ctx: ModuleContext, kind: string, id: string, payload: Record<string, unknown>, key: string): Statement {
  return eventStatement(ctx.profile, kind, id, { ...payload, module_id: "mensalidade" }, `module:mensalidade:${ctx.profile}:${kind}:${key}`);
}
type RecordKind = "installment" | "contract";
type Operation = "recognize" | "receive" | "cancel" | "reverse";

export async function mensalidadeSource(ctx: ModuleContext, kind: RecordKind, record: any): Promise<SourceRef> {
  if (record.profile_id !== ctx.profile) throw new IntegrationError("not_found", 404);
  const alias = await one(ctx.env, "SELECT source_id,component FROM module_erp_aliases WHERE profile_id=? AND module_id='mensalidade' AND record_kind=? AND record_id=?", ctx.profile, kind, record.id);
  let id = kind === "contract" ? `contract:${record.id}` : record.id;
  if (kind === "installment" && !alias) {
    const contract = await one(ctx.env, "SELECT id FROM mensalidade_contracts WHERE profile_id=? AND installment_id=?", ctx.profile, record.id);
    if (contract) id = `contract:${contract.id}`;
  }
  return { profile: ctx.profile, module: "mensalidade", source_id: alias?.source_id ?? id, component: alias?.component ?? "main" };
}

async function commercialSnapshot(ctx: ModuleContext, source: SourceRef, kind: RecordKind, record: any, revision: number, sub?: any): Promise<CommercialSnapshot> {
  sub ??= kind === "installment" ? await one(ctx.env, "SELECT * FROM mensalidade_subscriptions WHERE id=? AND profile_id=?", record.subscription_id, ctx.profile) : record;
  if (!sub) throw new IntegrationError("not_found", 404);
  // O cadastro único do pagador é distinto do contato da conversa (que pode
  // ser menor). Sem pagador confirmado a fila aguarda o cadastro humano.
  const payer = sub.payer_id ? await one(ctx.env, `SELECT c.id,c.erp_contact_id FROM mensalidade_payers p JOIN contacts c ON c.id=p.contact_id AND c.profile_id=p.profile_id
    WHERE p.id=? AND p.profile_id=? AND c.namespace='team' AND c.identity_state='active'`, sub.payer_id, ctx.profile) : null;
  const policy = await ensureCommercialPolicy(ctx.env, ctx.profile);
  const product = sub.plan_id ? await catalogLink(ctx.env, source, "plan", sub.plan_id) : null;
  const total = integer(record.amount_cents, 1);
  // Na geração o desconto é o contratado na assinatura. Em parcela antiga
  // não inferir o preço original a partir de uma assinatura já alterada.
  const discount = integer(record.contracted_discount_cents ?? record.discount_cents ?? 0);
  const gross = integer(total + discount, 1);
  return {
    schema: 1, source, source_revision: revision, contact_id: payer?.erp_contact_id ?? null,
    customer_ref: payer?.id ?? null, privacy: "adult_payer_only", description: "Serviço contratado",
    issued_on: today(record.obligation_ms ?? record.created),
    items: [{ id: uuid5(F3_NAMESPACES.internal, canonical([source, "service"])), description: "Serviço contratado", quantity: "1", unit_cents: gross, unit: "UN", kind: product ? "service" : "free", product_id: product }],
    total_cents: total, freight_cents: 0, discount_cents: discount,
    installments: [{ key: "main", due_on: record.due_date ?? today(record.obligation_ms ?? record.created), amount_cents: total, payment_method_id: policy.payment_method_id }],
    policy_version: policy.version,
    lifecycle: { base_status: record.status, stage_id: null, quote_version: null, authorization: "fixed_price", authorized_at: record.obligation_ms ?? record.created, first_execution_at: null, delivered_at: null, warranty_until: null },
    technical: null,
  };
}

export interface MensalidadeMutation {
  kind: RecordKind;
  record: any;
  subscription?: any;
  source?: SourceRef;
  operation: Operation | null;
  at: number;
  actor?: string | null;
  newObligation?: boolean;
  reason?: string;
  receipt?: CommercialReceipt | null;
  originalReceipt?: CommercialReceipt | null;
  receiptKey?: string | null;
  aliases?: { kind: RecordKind; id: string }[];
  correction?: boolean;
}

/** Apenas D1. O chamador junta a mutação nativa e suas guardas ao retorno. */
export async function mensalidadeStatements(ctx: ModuleContext, input: MensalidadeMutation) {
  const source = input.source ?? await mensalidadeSource(ctx, input.kind, input.record);
  if (source.profile !== ctx.profile || source.module !== "mensalidade" || source.component !== "main" || input.record.profile_id !== ctx.profile) throw new IntegrationError("not_found", 404);
  const row = await one(ctx.env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
  const before: CommercialSnapshot | undefined = row ? JSON.parse(row.state_json).snapshot : undefined;
  const revision = (row?.revision ?? 0) + 1;
  // Depois do reconhecimento, preço, vencimento e cliente não são reescritos.
  const snapshot = before ? { ...before, source_revision: revision, lifecycle: { ...before.lifecycle, base_status: input.record.status } }
    : await commercialSnapshot(ctx, source, input.kind, input.record, revision, input.subscription);
  const state = await readIntegrationActivation(ctx.env, ctx.profile, "mensalidade");
  const at = integer(input.at);
  const active = ["mensalidade", "erp", "erp-financeiro"].every(id => {
    const a = state.activations[id];
    return a?.enabled === 1 && a.enabled_since_ms !== null && at >= a.enabled_since_ms;
  }) && state.snapshot.parts.finance;
  const events: IntegrationEvent[] = [];
  let operation = input.operation;
  // A obrigação inicial é monotônica: reenvio de cobrança e alias não geram
  // outra dívida, mesmo se a primeira parcela já nasceu paga.
  if (operation === "recognize" && before) operation = null;
  const key = input.receipt?.receipt_key ?? input.receiptKey ?? null;
  const receiptEvent = key && await one(ctx.env, `SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id='mensalidade' AND source_id=? AND json_extract(payload_json,'$.receipt_key')=?`, ctx.profile, source.source_id, key);
  if (receiptEvent) operation = null;
  const recognized = await one(ctx.env, `SELECT 1 FROM module_erp_events WHERE profile_id=? AND module_id='mensalidade' AND source_id=?
    AND json_extract(payload_json,'$.operation')='recognize' AND json_extract(payload_json,'$.eligible.finance')=1 LIMIT 1`, ctx.profile, source.source_id);
  const historical = !recognized && !input.newObligation;
  if (input.correction && recognized) operation = "recognize";
  const maintenance = operation === "cancel" || operation === "reverse";
  const eligible = input.correction ? false : operation === "recognize" ? active && !!input.newObligation && !input.record.retroactive
    : maintenance ? !!before || !!row?.links_json && row.links_json !== "[]" : !!recognized;
  if (operation) {
    const seq = (row?.enqueued_seq ?? 0) + 1;
    events.push({ id: commandId(source, seq), command_id: commandId(source, seq), event_key: eventKey(source, operation, revision), source,
      seq, source_revision: revision, operation, occurred_ms: at, epochs: state.epochs,
      eligible: { document: false, stock: false, finance: eligible }, snapshot,
      receipt_key: key, reverses_receipt_key: input.receipt?.reverses_key ?? null,
      reason_code: input.reason ?? (historical ? "historical_origin_unlinked" : input.record.retroactive ? "retroactive_installment" : null), actor_id: input.actor ?? null });
  }
  const statements = integrationStatements({ source, expected_revision: revision - 1, events, next_state: { snapshot } });
  for (const alias of [{ kind: input.kind, id: input.record.id }, ...input.aliases ?? []]) statements.push(...aliasStatements(source, alias.kind, alias.id));
  if (input.receipt) {
    if (input.originalReceipt) {
      statements.push(...commercialReceiptStatements(input.originalReceipt));
      const pendingOriginal = await one(ctx.env, `SELECT e.id FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
        WHERE e.profile_id=? AND e.module_id='mensalidade' AND e.source_id=? AND json_extract(e.payload_json,'$.receipt_key')=?
          AND d.error_code='payment_evidence_required' AND e.seq IS NOT NULL`, ctx.profile, source.source_id, input.originalReceipt.receipt_key);
      if (pendingOriginal && input.originalReceipt.amount_cents === snapshot.total_cents) statements.push(
        ...allocationStatements(source, input.originalReceipt.receipt_key, allocationKey(input.originalReceipt.receipt_key, source, 0), input.originalReceipt.amount_cents),
        ["UPDATE module_erp_delivery SET state='pending',error_code=NULL,error_message=NULL,next_attempt_ms=? WHERE event_id=?", [at, pendingOriginal.id]]);
    }
    statements.push(...commercialReceiptStatements(input.receipt));
    const receiptAlias = await one(ctx.env, "SELECT source_id FROM module_erp_aliases WHERE profile_id=? AND module_id='mensalidade' AND record_kind IN ('installment','contract') AND record_id=? AND source_id=? AND component=?", ctx.profile, input.receipt.source_id, source.source_id, source.component);
    if (input.receipt.owner_module !== "mensalidade" || input.receipt.profile_id !== ctx.profile ||
      !receiptAlias && ![source.source_id, source.source_id.startsWith("contract:") ? source.source_id.slice(9) : source.source_id].includes(input.receipt.source_id)) throw new IntegrationError("idempotency_conflict", 409);
    // Excedente ou valor diferente requer conciliação; não inventar receita,
    // nem ajustar o título já reconhecido para encaixar o pagamento.
    if (input.receipt.amount_cents === snapshot.total_cents && input.record.amount_cents === snapshot.total_cents) {
      statements.push(...allocationStatements(source, input.receipt.receipt_key, allocationKey(input.receipt.receipt_key, source, 0), input.receipt.amount_cents));
      if (receiptEvent) statements.push(["UPDATE module_erp_delivery SET state='pending',error_code=NULL,error_message=NULL,next_attempt_ms=? WHERE event_id=? AND state='blocked' AND error_code='payment_evidence_required'", [at, JSON.parse(receiptEvent.payload_json).id]]);
    } else if (events[0]) {
      statements.push(blocked(events[0], "total_mismatch"));
    }
  }
  if (events[0] && ["receive", "reverse"].includes(events[0].operation) && !input.receipt) statements.push(blocked(events[0], "payment_evidence_required"));
  // A base mantém fatos inelegíveis pendentes. Eles não podem impedir a
  // visualização explícita de pagamento de uma obrigação histórica.
  if (events[0] && historical && operation === "receive") statements.push(blocked(events[0], "historical_origin_unlinked"));
  if (events[0] && input.correction) statements.push(blocked(events[0], "commercial_correction_required"));
  return { source, snapshot, events, statements, replayed: !!receiptEvent };
}

function blocked(event: IntegrationEvent, code: string): Statement {
  return ["UPDATE module_erp_delivery SET state='blocked',error_code=?,error_message=? WHERE event_id=?", [code,
    new IntegrationError(code).message, Object.values(event.eligible).some(Boolean) ? event.id : localEventId(event.source, event.event_key)]];
}

export async function requireMensalidadeChargeReconciled(ctx: ModuleContext, inst: any) {
  if (!inst.discount_ref) return;
  const source = await mensalidadeSource(ctx, "installment", inst);
  if (await one(ctx.env, `SELECT 1 FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
    WHERE e.profile_id=? AND e.module_id='mensalidade' AND e.source_id=? AND d.state='blocked'
      AND d.error_code='commercial_correction_required' LIMIT 1`, ctx.profile, source.source_id))
    throw new IntegrationError("commercial_correction_required", 409);
}

/** O gancho paid histórico reconcilia dinheiro, mas não libera um serviço devolvido. */
export async function mensalidadeCurrentlyRefunded(ctx: ModuleContext, payment: Payment) {
  const row = await one(ctx.env, "SELECT * FROM payments WHERE profile_id=? AND id=? AND module_id='mensalidade'", ctx.profile, payment.id);
  return row?.status === "refunded";
}

/** A frente de pagamentos é a única escritora da evidência de provedor. */
export async function mensalidadePaymentEvidence(ctx: ModuleContext, payment: Payment, required = false) {
  if (!payment.ref_id || !["paid", "refunded"].includes(payment.status)) throw new IntegrationError("invalid_request", 422);
  const fact = await (required ? commercialPaymentEvidence : optionalCommercialPaymentEvidence)(ctx.env, ctx.profile, "mensalidade", payment.id, payment.ref_id,
    payment.status as "paid" | "refunded", payment.evidence);
  if (!fact) {
    const row = await one(ctx.env, "SELECT * FROM payments WHERE profile_id=? AND id=?", ctx.profile, payment.id);
    const key = providerReceiptKey(ctx.profile, row.provider, row.account_id, String(row.provider_payment_id));
    return { receipt: null, receiptKey: payment.status === "refunded" ? reverseReceiptKey(key) : key };
  }
  if (fact.amount_cents !== payment.amount_cents) throw new IntegrationError("idempotency_conflict", 409);
  return { receipt: commercialReceiptFromEvidence(fact), receiptKey: fact.receipt_key,
    originalReceipt: fact.original ? commercialReceiptFromEvidence({ ...fact.original, original: null }) : null };
}

export async function manualMensalidadeReceipt(ctx: ModuleContext, inst: any, actor: string, request: string, at: number, method: CommercialReceipt["method"] = "unknown", paidAtProvided = false, note = "") {
  const source = await mensalidadeSource(ctx, "installment", inst);
  const key = manualReceiptKey(ctx.profile, "mensalidade", opaque(request));
  const evidence = hash([source, integer(inst.amount_cents, 1), actor, method, paidAtProvided ? at : null, hash(note)]);
  const old = await one<CommercialReceipt>(ctx.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, key);
  if (old && old.evidence_hash !== evidence) throw new IntegrationError("idempotency_conflict", 409);
  const receipt: CommercialReceipt = old ?? { profile_id: ctx.profile, receipt_key: key, owner_module: "mensalidade", source_id: source.source_id,
    kind: "receive", evidence: "manual", reverses_key: null, amount_cents: inst.amount_cents, method, occurred_ms: at, actor_id: actor, evidence_hash: evidence };
  return { receipt, statements: commercialReceiptStatements(receipt), replayed: !!old };
}

export const mensalidadeProducer = {
  module: "mensalidade" as const,
  async authorizeSource(ctx: ModuleContext, actor: Actor, source: SourceRef, write: boolean) {
    if (source.module !== "mensalidade" || source.profile !== ctx.profile || !canProfile(actor, ctx.profile)) throw new IntegrationError("not_found", 404);
    requireAccess(actor, "mensalidade");
    ctx.access(actor, write ? "conversations:write" : "conversations:read");
    let found;
    if (source.component.startsWith("catalog:plan:")) found = await one(ctx.env, "SELECT id FROM mensalidade_plans WHERE id=? AND profile_id=?", source.source_id, ctx.profile);
    else if (source.component !== "main") throw new IntegrationError("not_found", 404);
    else if (source.source_id.startsWith("contract:")) found = await one(ctx.env, "SELECT id FROM mensalidade_contracts WHERE id=? AND profile_id=?", source.source_id.slice(9), ctx.profile);
    else found = await one(ctx.env, "SELECT id FROM mensalidade_installments WHERE id=? AND profile_id=?", source.source_id, ctx.profile);
    if (!found) throw new IntegrationError("not_found", 404);
  },
  async project(ctx: ModuleContext, source: SourceRef): Promise<CommercialSnapshot> {
    const row = await one(ctx.env, "SELECT state_json FROM module_erp_sources WHERE profile_id=? AND module_id='mensalidade' AND source_id=?", ctx.profile, source.source_id);
    if (!row || source.profile !== ctx.profile || source.module !== "mensalidade" || source.component !== "main") throw new IntegrationError("not_found", 404);
    const snapshot: CommercialSnapshot = JSON.parse(row.state_json).snapshot;
    if (snapshot.customer_ref) return snapshot;
    // Correção preparada pela base fecha o comando anterior antes de enviar
    // outro corpo. Não trocar o contato de um negócio já identificado.
    const contract = source.source_id.startsWith("contract:");
    const record = await one(ctx.env, contract ? "SELECT * FROM mensalidade_contracts WHERE profile_id=? AND id=?" : "SELECT * FROM mensalidade_installments WHERE profile_id=? AND id=?", ctx.profile, contract ? source.source_id.slice(9) : source.source_id);
    if (!record) throw new IntegrationError("not_found", 404);
    const current = await commercialSnapshot(ctx, source, contract ? "contract" : "installment", record, snapshot.source_revision);
    return { ...snapshot, contact_id: current.contact_id, customer_ref: current.customer_ref };
  },
};

/** Reversão manual pela rota comum: mantém isenção/cancelamento anteriores. */
export async function reverseMensalidadeReceipt(env: Env, actor: Actor, original: CommercialReceipt, input: { reason_code: string; command: string }) {
  requireIntegrationHuman(actor, original.profile_id); requireFinancialAal(actor);
  if (original.owner_module !== "mensalidade" || original.kind !== "receive" || original.evidence !== "manual" || !/^[a-z][a-z0-9_]{0,79}$/.test(input.reason_code)) throw new IntegrationError("invalid_request", 400);
  const stored = await one<CommercialReceipt>(env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", original.profile_id, original.receipt_key);
  if (!stored || hash(stored) !== hash(original)) throw new IntegrationError("idempotency_conflict", 409);
  const ctx = modulesApi(env, original.profile_id, "mensalidade");
  const source: SourceRef = { profile: ctx.profile, module: "mensalidade", source_id: original.source_id, component: "main" };
  await mensalidadeProducer.authorizeSource(ctx, actor, source, true);
  const alias = await one(env, "SELECT record_id FROM module_erp_aliases WHERE profile_id=? AND module_id='mensalidade' AND source_id=? AND record_kind='installment'", ctx.profile, original.source_id);
  const inst = await one(env, "SELECT * FROM mensalidade_installments WHERE profile_id=? AND id=?", ctx.profile, alias?.record_id ?? original.source_id);
  if (!inst) throw new IntegrationError("not_found", 404);
  const key = reverseReceiptKey(original.receipt_key);
  const prior = await one<CommercialReceipt>(env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, key);
  if (prior) {
    if (prior.evidence_hash !== hash([original.evidence_hash, input.reason_code, actor.id])) throw new IntegrationError("idempotency_conflict", 409);
    await announceManualRefund(ctx, inst, original, key);
    return { id: inst.id, status: inst.status };
  }
  if (inst.status !== "paid" || inst.paid_via !== "manual" || inst.paid_by !== original.actor_id || inst.paid_at !== original.occurred_ms) throw new IntegrationError("version_conflict", 409);
  const latest = await one(env, `SELECT json_extract(payload_json,'$.receipt_key') receipt_key FROM module_erp_events
    WHERE profile_id=? AND module_id='mensalidade' AND source_id=? AND json_extract(payload_json,'$.operation') IN ('receive','reverse') ORDER BY seq DESC LIMIT 1`, ctx.profile, original.source_id);
  if (latest?.receipt_key !== original.receipt_key) throw new IntegrationError("version_conflict", 409);
  const at = Date.now();
  const status = refundStatus(inst, at);
  const receipt: CommercialReceipt = { ...original, receipt_key: key, kind: "reverse", reverses_key: original.receipt_key,
    actor_id: actor.id, occurred_ms: at, evidence_hash: hash([original.evidence_hash, input.reason_code, actor.id]) };
  const plan = await mensalidadeStatements(ctx, { kind: "installment", record: { ...inst, status }, operation: "reverse", at, actor: actor.id, receipt, reason: input.reason_code });
  await commitMensalidade(env, [
    ["UPDATE mensalidade_installments SET status=?,paid_at=NULL,paid_via=NULL,paid_by=NULL,updated=? WHERE id=? AND profile_id=? AND status='paid' AND paid_via='manual' AND paid_by=? AND paid_at=?", [status, at, inst.id, ctx.profile, original.actor_id, original.occurred_ms]], integrationCasGuard,
    mensalidadeHistory(ctx, "mensalidade.refunded", inst.id, { installment_id: inst.id, subscription_id: inst.subscription_id, receipt_key: key, amount_cents: original.amount_cents }, key),
    ...commercialReceiptStatements(receipt), ...plan.statements,
  ]);
  await announceManualRefund(ctx, inst, original, key);
  return { id: inst.id, status };
}

async function announceManualRefund(ctx: ModuleContext, inst: any, original: CommercialReceipt, key: string) {
  await ctx.publish("mensalidade.refunded", inst.id, { installment_id: inst.id, subscription_id: inst.subscription_id, receipt_key: key, amount_cents: original.amount_cents }, { key });
  await notifyInstallmentRefunded(ctx.env, ctx.profile, { id: inst.id, subscription_id: inst.subscription_id, payment_id: original.receipt_key, amount_cents: original.amount_cents }, { rethrow: true });
}

export function refundStatus(inst: any, at: number): string {
  return inst.waived_at ? "waived" : inst.cancelled_at ? "cancelled" : inst.due_date < today(at) ? "overdue" : "open";
}

/** Ligação opcional, explícita e humana; não consulta preço nem cria serviço. */
export async function planServiceStatements(ctx: ModuleContext, planId: string, data: any, actor?: Actor): Promise<Statement[]> {
  if (data.erp_service_id === undefined) return [];
  if (!actor) throw new IntegrationError("forbidden", 403);
  requireIntegrationHuman(actor, ctx.profile);
  const version = integer(data.erp_service_version ?? 0);
  const product = data.erp_service_id === null ? null : opaque(data.erp_service_id);
  if (product) {
    const response = await humanReferenceRpc(ctx.env, actor, ctx.profile, "erp_catalog_product_get", { p_id: product });
    const item = response.record ?? response;
    if (item.id !== product || item.active !== true || item.kind !== "S") throw new IntegrationError("invalid_request", 422);
  }
  const keys = [ctx.profile, planId];
  if (!product && version === 0) return [["SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM module_erp_catalog_links WHERE profile_id=? AND module_id='mensalidade' AND record_kind='plan' AND record_id=? AND component='') THEN 1 ELSE json('integration_version_conflict') END", keys]];
  if (!product) return [["DELETE FROM module_erp_catalog_links WHERE profile_id=? AND module_id='mensalidade' AND record_kind='plan' AND record_id=? AND component='' AND version=?", [...keys, version]], integrationCasGuard];
  return [version === 0
    ? ["INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,version,updated_ms,updated_by) VALUES(?,'mensalidade','plan',?,'',?,1,?,?)", [...keys, product, Date.now(), actor.id]]
    : ["UPDATE module_erp_catalog_links SET erp_item_id=?,version=version+1,updated_ms=?,updated_by=? WHERE profile_id=? AND module_id='mensalidade' AND record_kind='plan' AND record_id=? AND component='' AND version=?", [product, Date.now(), actor.id, ...keys, version]], integrationCasGuard];
}

export async function planServiceView(ctx: ModuleContext, planId: string) {
  const row = await one(ctx.env, "SELECT erp_item_id,version FROM module_erp_catalog_links WHERE profile_id=? AND module_id='mensalidade' AND record_kind='plan' AND record_id=? AND component=''", ctx.profile, planId);
  return { erp_service_id: row?.erp_item_id ?? null, erp_service_version: row?.version ?? 0 };
}

/** Retoma evidência que chegou depois da mutação local, sem outra baixa. */
export async function recoverMensalidadePayment(ctx: ModuleContext, kind: RecordKind, record: any, payment: Payment) {
  const evidence = await mensalidadePaymentEvidence(ctx, payment);
  if (!evidence.receipt) return;
  const source = await mensalidadeSource(ctx, kind, record);
  const pending = await one(ctx.env, `SELECT e.id FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
    WHERE e.profile_id=? AND e.module_id='mensalidade' AND e.source_id=? AND json_extract(e.payload_json,'$.receipt_key')=? AND d.error_code='payment_evidence_required'`, ctx.profile, source.source_id, evidence.receiptKey);
  if (!pending) return;
  const plan = await mensalidadeStatements(ctx, { kind, record, operation: payment.status === "paid" ? "receive" : "reverse", at: Date.now(), ...evidence });
  await commitMensalidade(ctx.env, plan.statements);
}

/** createContract (fora do trecho B5) já cancela a contratação substituída.
 * Reconciliar somente esse cancelamento persistido; expirar um Pix sozinho
 * não extingue a obrigação. O gancho periódico cobre queda antes do reenvio.
 */
export async function reconcileMensalidadeContracts(ctx: ModuleContext) {
  const rows = await all(ctx.env, `SELECT c.* FROM mensalidade_contracts c JOIN module_erp_sources s
    ON s.profile_id=c.profile_id AND s.module_id='mensalidade' AND s.source_id='contract:'||c.id
    WHERE c.profile_id=? AND c.status='cancelled' AND c.installment_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM module_erp_events e WHERE e.profile_id=s.profile_id AND e.module_id=s.module_id AND e.source_id=s.source_id AND json_extract(e.payload_json,'$.reason_code')='contract_replaced')
      AND EXISTS(SELECT 1 FROM mensalidade_contracts n WHERE n.profile_id=c.profile_id AND n.conversation_id=c.conversation_id AND n.id<>c.id AND n.created>=c.created)
    ORDER BY c.id LIMIT 50`, ctx.profile);
  for (const record of rows) {
    const plan = await mensalidadeStatements(ctx, { kind: "contract", record, operation: "cancel", at: record.updated, reason: "contract_replaced" });
    await commitMensalidade(ctx.env, [
      ["UPDATE mensalidade_contracts SET updated=updated WHERE id=? AND profile_id=? AND status='cancelled' AND payment_id IS ? AND installment_id IS NULL", [record.id, ctx.profile, record.payment_id]], integrationCasGuard,
      ...plan.statements,
    ]);
  }
}
