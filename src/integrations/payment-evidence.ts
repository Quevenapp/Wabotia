import { one } from "../db";
import { ApiError, type Env } from "../types";
import type { ProviderPayment } from "../payments-provider";
import type { Statement } from "./contracts";
import { canonical, hash } from "./keys";
import { providerReceiptKey, reverseReceiptKey } from "./receipts";

export { providerReceiptKey, reverseReceiptKey, manualReceiptKey, allocationKey } from "./receipts";

export type VerifiedPaymentMethod = "cash" | "pix" | "card" | "other" | "unknown";

/** Extensão opcional do resultado consultado na API, nunca do webhook/cliente. */
export interface VerifiedProviderPayment extends ProviderPayment {
  verified_method?: VerifiedPaymentMethod;
  refunded_at?: number | null;
}

export interface PaymentEvidenceFact {
  schema: 1;
  evidence: "provider";
  event_key: string;
  receipt_key: string;
  kind: "receive" | "reverse";
  reverses_key: string | null;
  profile_id: string;
  provider: string;
  /** Identidade estável da conta configurada, não a credencial nem seu nome. */
  account_id: string;
  provider_payment_id: string;
  payment_id: string;
  module_id: string | null;
  ref_id: string | null;
  amount_cents: number;
  currency: string;
  method: VerifiedPaymentMethod;
  occurred_ms: number;
  time_source: "provider" | "observed";
  observed_ms: number;
  evidence_hash: string;
}

/** No estorno, o fato original permite ao produtor persistir ambos no seu lote. */
export interface PaymentEvidence extends PaymentEvidenceFact {
  original: PaymentEvidenceFact | null;
}

export interface PaymentHookEvent {
  id: string;
  status: string;
  previous: string;
  occurred_ms: number;
}

const messages = {
  payment_evidence_conflict: "A evidência deste pagamento diverge do registro confirmado.",
  payment_evidence_invalid: "A confirmação do pagamento está incompleta.",
  payment_evidence_missing: "A confirmação do provedor precisa ser consultada novamente.",
  payment_hook_missing: "O módulo ainda não está disponível para receber a confirmação.",
  payment_state_conflict: "O pagamento mudou durante a confirmação. Tente novamente.",
  provider_unavailable: "Não foi possível consultar o pagamento no provedor.",
} as const;
export class PaymentEvidenceError extends ApiError {
  constructor(code: keyof typeof messages) {
    super(code === "provider_unavailable" ? 502 : 409, code, messages[code]);
  }
}
const conflict = (): never => { throw new PaymentEvidenceError("payment_evidence_conflict"); };
const invalid = (): never => { throw new PaymentEvidenceError("payment_evidence_invalid"); };
const identifier = (v: unknown): string =>
  typeof v === "string" && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(v) ? v : invalid();
const cents = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : invalid();
const instant = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : invalid();
const methods: readonly unknown[] = ["cash", "pix", "card", "other", "unknown"];
/** O canal de cobrança (pix/link) não prova o meio usado para pagar. */
export const verifiedPaymentMethod = (value: unknown): VerifiedPaymentMethod =>
  methods.includes(value) ? value as VerifiedPaymentMethod : "unknown";

const evidenceEventKey = (key: string) => `payment.evidence:${key}`;
function fact(body: Omit<PaymentEvidenceFact, "evidence_hash">): PaymentEvidenceFact {
  return { ...body, evidence_hash: hash(body) };
}
function checkFact(value: PaymentEvidenceFact): void {
  const { evidence_hash, ...body } = value;
  if (evidence_hash !== hash(body)) conflict();
}

/** Somente projeção comercial permitida; nenhuma descrição, conversa ou resposta bruta. */
export async function readPaymentEvidence(
  env: Env, profile: string, receiptKey: string,
): Promise<PaymentEvidence | null> {
  const stored = await one(env,
    "SELECT payload FROM events WHERE profile_id=? AND kind='payment.evidence' AND source_key=?",
    profile, evidenceEventKey(receiptKey));
  if (!stored) return null;
  try {
    const value: PaymentEvidence = JSON.parse(stored.payload);
    const { original, ...current } = value;
    checkFact(current);
    if (original) checkFact(original);
    if (value.profile_id !== profile || value.receipt_key !== receiptKey || value.event_key !== evidenceEventKey(receiptKey)) conflict();
    if (value.kind === "reverse" ? !original || original.receipt_key !== value.reverses_key : original !== null) conflict();
    return value;
  } catch { return conflict(); }
}

/**
 * Preparação sem escrita. A primeira observação e seu proprietário são imutáveis.
 * O chamador persiste estas evidências no MESMO batch da mudança e do gancho.
 * Falta posterior de data/meio no provedor não apaga uma informação confirmada.
 */
export async function preparePaymentEvidence(
  env: Env,
  row: { id: string; profile_id: string; provider: string; account_id: string; module_id: string | null; ref_id: string | null; amount_cents: number; currency: string },
  remote: VerifiedProviderPayment,
  observedMs: number,
): Promise<PaymentEvidence> {
  if (remote.state !== "paid" && remote.state !== "refunded") invalid();
  const profile = identifier(row.profile_id), provider = identifier(row.provider);
  const account = identifier(row.account_id), remoteId = identifier(remote.id);
  const key = providerReceiptKey(profile, provider, account, remoteId);
  if (cents(remote.amount_cents) !== cents(row.amount_cents) || remote.currency !== row.currency || !/^[A-Z]{3}$/.test(remote.currency)) conflict();
  const method = verifiedPaymentMethod(remote.verified_method);
  const paidAt = remote.paid_at == null ? null : instant(remote.paid_at);
  const observed = instant(observedMs);
  let original = await readPaymentEvidence(env, profile, key);
  if (original) {
    if (original.kind !== "receive" || original.amount_cents !== remote.amount_cents || original.currency !== remote.currency ||
        (remote.verified_method !== undefined && original.method !== method) ||
        (paidAt !== null && original.time_source === "provider" && original.occurred_ms !== paidAt) ||
        original.module_id !== (row.module_id ?? null) || original.ref_id !== (row.ref_id ?? null)) conflict();
  } else {
    original = { ...fact({
      schema: 1, evidence: "provider", event_key: evidenceEventKey(key), receipt_key: key,
      kind: "receive", reverses_key: null, profile_id: profile, provider, account_id: account,
      provider_payment_id: remoteId, payment_id: identifier(row.id),
      module_id: row.module_id == null ? null : identifier(row.module_id),
      ref_id: row.ref_id == null ? null : identifier(row.ref_id),
      amount_cents: remote.amount_cents, currency: remote.currency, method,
      occurred_ms: paidAt ?? observed, time_source: paidAt === null ? "observed" : "provider", observed_ms: observed,
    }), original: null };
  }
  if (remote.state === "paid") return original;
  const reverseKey = reverseReceiptKey(key);
  const refundedAt = remote.refunded_at == null ? null : instant(remote.refunded_at);
  const previous = await readPaymentEvidence(env, profile, reverseKey);
  if (previous) {
    if (refundedAt !== null && previous.time_source === "provider" && previous.occurred_ms !== refundedAt) conflict();
    return previous;
  }
  const { original: _, evidence_hash: __, ...body } = original;
  const { original: ___, ...originalFact } = original;
  return { ...fact({ ...body, event_key: evidenceEventKey(reverseKey), receipt_key: reverseKey,
    kind: "reverse", reverses_key: key, occurred_ms: refundedAt ?? observed,
    time_source: refundedAt === null ? "observed" : "provider", observed_ms: observed,
  }), original: originalFact };
}

/**
 * events.source_key já é UNIQUE. O recibo comercial pertence ao produtor, não
 * ao núcleo de pagamentos. Estes eventos internos não disparam webhooks.
 * A guarda também impede que duas tentativas locais adotem o mesmo fato.
 */
export function paymentEvidenceStatements(evidence: PaymentEvidence): Statement[] {
  const values: PaymentEvidence[] = evidence.original
    ? [{ ...evidence.original, original: null }, evidence] : [evidence];
  return values.flatMap(value => {
    const payload = canonical(value);
    return [
      ["INSERT INTO events(profile_id,kind,resource_id,payload,created,source_key) VALUES(?,'payment.evidence',?,?,?,?) ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO NOTHING",
        [value.profile_id, value.payment_id, payload, value.observed_ms, value.event_key]],
      ["SELECT CASE WHEN EXISTS(SELECT 1 FROM events WHERE profile_id=? AND kind='payment.evidence' AND source_key=? AND payload=?) THEN 1 ELSE json('payment_evidence_conflict') END",
        [value.profile_id, value.event_key, payload]],
    ] as Statement[];
  });
}

/** Texto de exceção nunca vai para logs, notas, auditoria ou estado de entrega. */
export function paymentHookFailure(error: unknown): { code: string; message: string } {
  return error instanceof PaymentEvidenceError && Object.hasOwn(messages, error.code)
    ? { code: error.code, message: messages[error.code as keyof typeof messages] }
    : { code: "hook_failed", message: "falha transitória" };
}
