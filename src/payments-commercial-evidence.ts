// Ponte local: cada gancho consome seu fato imutável, não o estado corrente.
import { one } from "./db";
import type { Env } from "./types";
import { hash } from "./integrations/keys";
import { PaymentEvidenceError, readPaymentEvidence, parsePaymentEvidence, type PaymentEvidence } from "./integrations/payment-evidence";
import { providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "./integrations/receipts";
import type { CommercialSnapshot, IntegrationEvent, Statement, SourceRef } from "./integrations/contracts";
import { integrationStatements, sourceBindings } from "./integrations/outbox";
import { commandId, localEventId } from "./integrations/keys";
import { readIntegrationActivation } from "./integrations/activation";
import { IntegrationError } from "./integrations/privacy";

export async function commercialPaymentEvidence(env: Env, profile: string, module: string, id: string, ref: string,
  status: "paid" | "refunded", delivered?: PaymentEvidence | null, loaded?: any): Promise<PaymentEvidence> {
  const row = loaded ?? await one(env, "SELECT * FROM payments WHERE profile_id=? AND id=?", profile, id);
  if (!row || row.profile_id !== profile || row.id !== id || row.module_id !== module || row.ref_id !== ref ||
      row.currency !== "BRL" || !row.account_id || !row.provider_payment_id)
    throw new PaymentEvidenceError("payment_evidence_conflict");
  const original = providerReceiptKey(profile, row.provider, row.account_id, String(row.provider_payment_id));
  const key = status === "refunded" ? reverseReceiptKey(original) : original;
  const fact = loaded?.evidence_key === key
    ? parsePaymentEvidence(loaded.evidence_json, profile, key) : await readPaymentEvidence(env, profile, key);
  if (!fact) throw new PaymentEvidenceError("payment_evidence_missing");
  // Um estorno carrega também o recebimento original para a recuperação local.
  const claimed = status === "paid" && delivered?.kind === "reverse" && delivered.original
    ? { ...delivered.original, original: null } : delivered;
  // Tentativas locais da mesma cobrança remota compartilham o fato original.
  if (fact.module_id !== module || fact.ref_id !== ref || fact.amount_cents !== row.amount_cents ||
      fact.currency !== row.currency || fact.provider !== row.provider || fact.account_id !== row.account_id ||
      fact.provider_payment_id !== String(row.provider_payment_id) || fact.kind !== (status === "paid" ? "receive" : "reverse") ||
      claimed && hash(claimed) !== hash(fact)) throw new PaymentEvidenceError("payment_evidence_conflict");
  return fact;
}

/** Legado sem evidência não impede o gancho local. Divergência continua recusada. */
export async function optionalCommercialPaymentEvidence(...args: Parameters<typeof commercialPaymentEvidence>) {
  try { return await commercialPaymentEvidence(...args); }
  catch (error) {
    if (error instanceof PaymentEvidenceError && error.code === "payment_evidence_missing") return null;
    throw error;
  }
}

export const paymentPendingEventKey = (source: SourceRef, payment: string, status: string) =>
  `wb:payment-pending:${hash([source, payment, status])}`;
/** Fato local sem recibo inventado nem sequência remota. A consulta posterior
 * da evidência encerra esta pendência e cria o recebimento comprovado. */
export async function pendingPaymentStatements(env: Env, snapshot: CommercialSnapshot, payment: string,
  status: "paid" | "refunded", reason = "payment_evidence_required"): Promise<Statement[]> {
  const source = snapshot.source, key = paymentPendingEventKey(snapshot.source, payment, status);
  if (await one(env, "SELECT 1 FROM module_erp_events WHERE profile_id=? AND event_key=?", source.profile, key)) return [];
  const row = await one(env, "SELECT revision,enqueued_seq FROM module_erp_sources WHERE profile_id=? AND module_id=? AND source_id=?", ...sourceBindings(source));
  const revision = (row?.revision ?? 0) + 1, seq = (row?.enqueued_seq ?? 0) + 1;
  const event: IntegrationEvent = { id: commandId(source, seq), command_id: commandId(source, seq), event_key: key,
    source, seq, source_revision: revision, operation: status === "paid" ? "receive" : "reverse", occurred_ms: Date.now(),
    epochs: (await readIntegrationActivation(env, source.profile, source.module)).epochs,
    eligible: { document: false, stock: false, finance: false }, snapshot: { ...snapshot, source_revision: revision },
    receipt_key: null, reverses_receipt_key: null, actor_id: null, reason_code: reason };
  return [...integrationStatements({ source, expected_revision: revision - 1, events: [event], next_state: { snapshot: event.snapshot } }),
    ["UPDATE module_erp_delivery SET state='blocked',completed_ms=NULL,error_code=?,error_message=? WHERE event_id=?",
      [reason, new IntegrationError(reason).message, localEventId(source, key)]]];
}
export function resolvedPaymentStatements(snapshot: Pick<CommercialSnapshot, "source">, payment: string, status: string): Statement[] {
  return [["UPDATE module_erp_delivery SET state='done',completed_ms=?,error_code='payment_evidence_recovered',error_message=NULL WHERE event_id=? AND error_code='payment_evidence_required'",
    [Date.now(), localEventId(snapshot.source, paymentPendingEventKey(snapshot.source, payment, status))]]];
}

export function commercialReceiptFromEvidence(fact: PaymentEvidence, sourceId = fact.ref_id!): CommercialReceipt {
  return { profile_id: fact.profile_id, receipt_key: fact.receipt_key, owner_module: fact.module_id as CommercialReceipt["owner_module"], source_id: sourceId,
    kind: fact.kind, evidence: "provider", reverses_key: fact.reverses_key, amount_cents: fact.amount_cents,
    method: fact.method, occurred_ms: fact.occurred_ms, actor_id: null, evidence_hash: fact.evidence_hash };
}
