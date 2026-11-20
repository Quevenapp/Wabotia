import { batch, one } from "../../src/db";
import type { Env } from "../../src/types";
import { preparePaymentEvidence, paymentEvidenceStatements, readPaymentEvidence, providerReceiptKey } from "../../src/integrations/payment-evidence";

/** Confirmação consultada pelo núcleo, com o mesmo fato persistido de produção. */
export async function persistProviderEvidence(env: Env, id: string) {
  const row = await one(env, "SELECT * FROM payments WHERE id=?", id);
  if (!row || !["paid", "refunded"].includes(row.status)) throw new Error("fixture_payment_not_confirmed");
  // Repetir a consulta da mesma cobrança remota conserva data e meio,
  // mesmo quando a tentativa local usa outro canal (Pix/link).
  const original = await readPaymentEvidence(env, row.profile_id, providerReceiptKey(row.profile_id, row.provider, row.account_id, String(row.provider_payment_id)));
  const evidence = await preparePaymentEvidence(env, row, {
    id: String(row.provider_payment_id), state: row.status, raw_status: row.status, external_reference: row.id, amount_cents: row.amount_cents,
    currency: row.currency, paid_at: original?.occurred_ms ?? row.paid_at, verified_method: original?.method ?? "pix",
  }, row.updated);
  await batch(env, paymentEvidenceStatements(evidence));
  return evidence;
}
