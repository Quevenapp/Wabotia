import { one } from "../../db";
import { ApiError, type Actor } from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
import type { Statement } from "../../integrations/contracts";
import type { IntegrationProducer } from "../../integrations/ports";
import { registerIntegrationProducer, registerReceiptReverser } from "../../integrations/ports";
import { integrationCasGuard } from "../../integrations/outbox";
import { IntegrationError } from "../../integrations/privacy";
import { hash } from "../../integrations/keys";
import { providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../../integrations/receipts";
import {
  authorizeBooking, bookingGuard, commercialAtomic, commercialRow, commercialSource, commercialState,
  receiptBalance, receiptPlan, reverseBookingReceipt, sourceProjection, titlePlan,
} from "../agenda/integration";

export const reservaProducer: IntegrationProducer = {
  module: "reserva",
  authorizeSource: (ctx, actor, source, write) => authorizeBooking(ctx, actor, source, write, "reserva"),
  project: (ctx, source) => sourceProjection(ctx, source, "reserva"),
};
async function reverseReserva(env: ModuleContext["env"], actor: Actor, original: CommercialReceipt, input: { reason_code: string; command: string }) {
  const { modulesApi } = await import("../api");
  return reverseBookingReceipt(modulesApi(env, original.profile_id, "reserva"), actor, original, input);
}
export function installReservaIntegration() {
  registerIntegrationProducer(reservaProducer);
  registerReceiptReverser("reserva", reverseReserva);
}

/** Reserva aceita reconhece o contrato inteiro; sinal não é outra venda. */
export async function insertCommercialBooking(ctx: ModuleContext, row: any, sql: string, ...bindings: unknown[]) {
  const plan = await titlePlan(ctx, "reserva", row, { recognize: true, actor: row.created_by });
  const results = await commercialAtomic(ctx, [[sql, bindings], integrationCasGuard, ...plan.statements]).catch(error => {
    if (error instanceof IntegrationError && error.code === "version_conflict")
      throw new ApiError(409, "unit_unavailable", "Esta unidade acabou de ser ocupada. Escolha outro período.");
    throw error;
  });
  return results[0];
}

export async function mutateCommercialBooking(ctx: ModuleContext, before: any, after: any, native: Statement, options: { cancel?: boolean; actor: string | null; reason?: string }) {
  const state = await commercialState(ctx, commercialSource(ctx, "reserva", before.id));
  const facts = options.cancel && state.snapshot?.lifecycle.authorized_at != null
    ? [{ operation: "cancel" as const, reason_code: options.reason ?? "booking_cancelled" }] : [];
  const plan = await titlePlan(ctx, "reserva", after, { actor: options.actor, facts });
  const results = await commercialAtomic(ctx, [bookingGuard(ctx, "reserva", before), native, integrationCasGuard, ...plan.statements]);
  return results[1];
}
export const reservaNative = (ctx: ModuleContext, before: any, after: any, options: { cancel?: boolean; actor: string | null; reason?: string }, sql: string, ...bindings: unknown[]) =>
  mutateCommercialBooking(ctx, before, after, [sql, bindings], options);

/** Um contrato reconhecido não muda de preço/cliente por remarcação. */
export async function guardBookingCommercialChange(ctx: ModuleContext, before: any, next: { price_cents: number; unit_id: string; customer_name: string; customer_phone: string }) {
  const state = await commercialState(ctx, commercialSource(ctx, "reserva", before.id));
  const frozen = state.seq > 0 || !!await one(ctx.env, "SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND owner_module='reserva' AND source_id=? LIMIT 1", ctx.profile, before.id);
  if (frozen && state.snapshot?.lifecycle.authorized_at != null &&
    (next.price_cents !== before.price_cents || next.unit_id !== before.unit_id || next.customer_name !== before.customer_name || next.customer_phone !== before.customer_phone))
    throw new IntegrationError("commercial_correction_required", 409);
}

/** Evidência local confirmada pelo núcleo. O DTO público sozinho não autoriza recebimento. */
export async function depositReceipt(ctx: ModuleContext, payment: Payment): Promise<CommercialReceipt> {
  const stored = await one(ctx.env, "SELECT * FROM payments WHERE profile_id=? AND id=?", ctx.profile, payment.id);
  if (!stored || stored.module_id !== "reserva" || stored.ref_id !== payment.ref_id || stored.amount_cents !== payment.amount_cents ||
    stored.currency !== "BRL" || !stored.account_id || !stored.provider_payment_id || !["paid", "refunded"].includes(stored.status) ||
    !["paid", "refunded"].includes(payment.status) || payment.status === "refunded" && stored.status !== "refunded")
    throw new IntegrationError("invalid_request", 422);
  const key = providerReceiptKey(ctx.profile, stored.provider, stored.account_id, String(stored.provider_payment_id));
  const method = stored.method === "pix" ? "pix" : "unknown";
  const base: CommercialReceipt = { profile_id: ctx.profile, receipt_key: key, owner_module: "reserva", source_id: stored.ref_id,
    kind: "receive", evidence: "provider", reverses_key: null, amount_cents: stored.amount_cents, method,
    occurred_ms: stored.paid_at ?? stored.updated, actor_id: null,
    evidence_hash: hash([ctx.profile, stored.provider, stored.account_id, String(stored.provider_payment_id), stored.ref_id, stored.amount_cents, method, "paid"]) };
  if (payment.status !== "refunded") return base;
  return { ...base, receipt_key: reverseReceiptKey(key), kind: "reverse", reverses_key: key, occurred_ms: stored.updated, evidence_hash: hash([base.evidence_hash, "reverse"]) };
}

/** Mutação do sinal e recibo/alocação/saída pertencem ao mesmo lote D1. */
export async function commitDepositReceipt(ctx: ModuleContext, before: any, after: any, receipt: CommercialReceipt, native: Statement, options: { cancel?: boolean; allowAllocation?: boolean } = {}) {
  const balance = await receiptBalance(ctx, commercialSource(ctx, "reserva", before.id));
  const limit = options.allowAllocation === false ? 0 : Math.max(0, before.deposit_cents - balance.allocated_cents);
  const plan = await receiptPlan(ctx, "reserva", after, receipt, { limit, cancel: options.cancel, reason: receipt.kind === "reverse" ? "provider_refund" : "deposit_payment" });
  if (!plan) return false;
  await commercialAtomic(ctx, [bookingGuard(ctx, "reserva", before), native, integrationCasGuard, ...plan.statements]);
  return true;
}

/** Cobrança antiga/substituída é dinheiro pendente, sem segunda obrigação. */
export async function recordReplacedDeposit(ctx: ModuleContext, row: any, payment: Payment) {
  const receipt = await depositReceipt(ctx, payment);
  if (receipt.kind === "reverse" && !await one(ctx.env, "SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, receipt.reverses_key))
    await recordReplacedDeposit(ctx, row, { ...payment, status: "paid" });
  const plan = await receiptPlan(ctx, "reserva", row, receipt, { limit: 0, reason: "replaced_payment" });
  if (plan) await commercialAtomic(ctx, [bookingGuard(ctx, "reserva", row), ...plan.statements]);
}

export const rawBooking = (ctx: ModuleContext, id: string) => commercialRow(ctx, "reserva", id);
