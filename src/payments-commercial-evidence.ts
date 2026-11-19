// Ponte local: cada gancho consome seu fato imutável, não o estado corrente.
import { one } from "./db";
import type { Env } from "./types";
import { hash } from "./integrations/keys";
import { PaymentEvidenceError, readPaymentEvidence, parsePaymentEvidence, type PaymentEvidence } from "./integrations/payment-evidence";
import { providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "./integrations/receipts";

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
  if (fact.payment_id !== id || fact.module_id !== module || fact.ref_id !== ref || fact.amount_cents !== row.amount_cents ||
      fact.currency !== row.currency || fact.provider !== row.provider || fact.account_id !== row.account_id ||
      fact.provider_payment_id !== String(row.provider_payment_id) || fact.kind !== (status === "paid" ? "receive" : "reverse") ||
      claimed && hash(claimed) !== hash(fact)) throw new PaymentEvidenceError("payment_evidence_conflict");
  return fact;
}

export function commercialReceiptFromEvidence(fact: PaymentEvidence, sourceId = fact.ref_id!): CommercialReceipt {
  return { profile_id: fact.profile_id, receipt_key: fact.receipt_key, owner_module: fact.module_id as CommercialReceipt["owner_module"], source_id: sourceId,
    kind: fact.kind, evidence: "provider", reverses_key: fact.reverses_key, amount_cents: fact.amount_cents,
    method: fact.method, occurred_ms: fact.occurred_ms, actor_id: null, evidence_hash: fact.evidence_hash };
}
