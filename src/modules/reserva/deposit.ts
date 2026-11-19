// Sinal da Reserva pela Cobrança do núcleo (docs/COBRANCA.md). Com sinal nas
// regras, a reserva nasce "aguardando pagamento" (pending_payment) e segura a
// unidade até payment_due_at. Só o webhook do provedor confirma
// (onPaymentUpdated); uma mensagem do cliente nunca confirma. Vencido o prazo
// (gancho periódico) ou a cobrança, a reserva expira e a unidade é liberada.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, now as clock } from "../../types";
import type { Payment } from "../../payments";
import type { ModuleContext } from "../api";
import { fill, money, type ReservaConfig } from "./config";
import { commitDepositReceipt, depositReceipt, rawBooking, recordReplacedDeposit, reservaNative } from "./integration";
import { commercialSource, receiptBalance } from "../agenda/integration";
import { IntegrationError, sanitizedError } from "../../integrations/privacy";
import {
  announceCancel,
  describe,
  getBooking,
  notifyCustomer,
  publish,
  type Booking,
} from "./bookings";

const REFUND_REASON = "Sinal estornado pelo provedor de pagamento";

export interface DepositStatus {
  /** O sinal pode ser cobrado nesta área. */
  available: boolean;
  /** payments_disabled (módulo Cobrança desligado) ou payments_not_configured. */
  reason: "payments_disabled" | "payments_not_configured" | null;
  message: string | null;
}

/**
 * Se a Cobrança está pronta para o sinal. Lê o estado do módulo e a conta da
 * área (sem segredos); o teste das credenciais fica em Gestão → Cobrança.
 */
export async function depositStatus(
  ctx: ModuleContext,
): Promise<DepositStatus> {
  const ready = await ctx.paymentsReady();
  if (ready.reason === "payments_disabled")
    return {
      available: false,
      reason: "payments_disabled",
      message:
        "O módulo Cobrança está desligado: o sinal não pode ser cobrado. Ligue-o em Gestão → Módulos e configure a conta em Gestão → Cobrança.",
    };
  if (ready.reason === "payments_not_configured")
    return {
      available: false,
      reason: "payments_not_configured",
      message:
        "Nenhuma conta de pagamento configurada: o sinal não pode ser cobrado. Configure o Mercado Pago em Gestão → Cobrança.",
    };
  return { available: true, reason: null, message: null };
}

/**
 * Cobra o sinal de uma reserva aguardando pagamento. Repetir não cobra de
 * novo (sourceKey da reserva). Sem conta ou com erro do provedor, a reserva
 * continua aguardando, com `payment_error`, e a equipe pode confirmar à mão.
 */
export async function requestDeposit(
  ctx: ModuleContext,
  config: ReservaConfig,
  booking: Booking,
  c: Conversation,
  options: { actor?: string; notification?: boolean; at?: number } = {},
): Promise<{
  booking: Booking;
  payment: Payment | null;
  error: ApiError | null;
}> {
  if (booking.status !== "pending_payment" || booking.deposit_cents <= 0)
    return { booking, payment: null, error: null };
  // Recebimentos locais não exigem Cobrança/ERP e reduzem o sinal a pedir.
  const balance = await receiptBalance(ctx, commercialSource(ctx, "reserva", booking.id));
  const outstanding = Math.max(0, booking.deposit_cents - balance.allocated_cents);
  if (!outstanding) return { booking, payment: null, error: null };
  const at = options.at ?? clock();
  const minutes = Math.max(
    30,
    Math.round(((booking.payment_due_at ?? at) - at) / 60000),
  );
  try {
    const currentCharge = booking.payment_id ? await one(ctx.env, "SELECT amount_cents,status FROM payments WHERE profile_id=? AND id=?", ctx.profile, booking.payment_id) : null;
    if (currentCharge?.status === "created" && currentCharge.amount_cents !== outstanding)
      throw new IntegrationError("charge_adjustment_required", 409);
    const payment = await ctx.charge(c, {
      method: config.deposit_method,
      amount_cents: outstanding,
      description: "Sinal de serviço contratado",
      ref: booking.id,
      sourceKey: `deposit:${booking.id}`,
      expiresMinutes: Math.min(minutes, 30 * 24 * 60),
      actor: options.actor,
      notification: options.notification,
    });
    const raw = await rawBooking(ctx, booking.id);
    if (!raw.payment_status || raw.payment_status === "created") await reservaNative(
      ctx, raw, raw, { actor: options.actor ?? null },
      "UPDATE reserva_bookings SET payment_id=?,payment_status=?,payment_error=NULL,updated=? WHERE id=? AND profile_id=?",
      payment.id, payment.status, clock(), booking.id, ctx.profile,
    );
    return { booking: await getBooking(ctx, booking.id), payment, error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const safe = ["payments_disabled", "payments_not_configured", "module_disabled"].includes(error.code)
      ? new ApiError(error.status, error.code, "A cobrança do sinal está indisponível. Confira a configuração de Cobrança.") : sanitizedError(error);
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_error=?,updated=? WHERE id=? AND profile_id=?",
      safe.code,
      clock(),
      booking.id,
      ctx.profile,
    );
    console.error(
      JSON.stringify({
        component: "reserva-deposit",
        profile: ctx.profile,
        booking: booking.id,
        error: safe.code,
      }),
    );
    // A mensagem bruta do provedor não sai para o cliente.
    return { booking: await getBooking(ctx, booking.id), payment: null, error: safe };
  }
}

/** Texto ao cliente quando o sinal não pôde ser gerado. */
export const depositFallbackText = (b: Booking) =>
  `Não consegui gerar o pagamento do sinal (${money(b.deposit_cents)}) agora. A equipe vai falar com você para combinar; a reserva fica guardada até ${describe(b).prazo}.`;

/** Libera uma reserva que esperava o sinal (prazo ou cobrança vencidos). */
export async function expireBooking(
  ctx: ModuleContext,
  config: ReservaConfig,
  id: string,
  options: {
    reason: "deadline" | "payment_expired" | "payment_cancelled";
    paymentStatus?: string;
    at?: number;
    /**
     * Gancho de pagamento repetido (segunda conferência, A3): a reserva já
     * liberada por esta cobrança refaz o evento e o aviso (com chave), que a
     * primeira vez pode ter perdido numa falha depois da gravação.
     */
    repeat?: boolean;
  },
) {
  const at = options.at ?? clock();
  const before = await rawBooking(ctx, id);
  if (before.status === "pending_payment" && before.deposit_cents > 0 &&
    (await receiptBalance(ctx, commercialSource(ctx, "reserva", id))).allocated_cents >= before.deposit_cents) {
    // Sinal recebido à mão sustenta a reserva, mesmo antes da confirmação
    // operacional. Vencer uma cobrança antiga não desfaz esse recebimento.
    if (options.paymentStatus) await reservaNative(ctx, before, before, { actor: "system" },
      "UPDATE reserva_bookings SET payment_status=?,updated=? WHERE profile_id=? AND id=?", options.paymentStatus, at, ctx.profile, id);
    return null;
  }
  if (before.status !== "pending_payment") {
    if (!options.repeat || before.status !== "expired" || before.cancelled_by !== "system") return null;
  } else await reservaNative(
    ctx, before, { ...before, status: "expired" }, { actor: "system", cancel: true, reason: "booking_expired" },
    "UPDATE reserva_bookings SET status='expired',payment_status=coalesce(?,payment_status),cancelled_at=?,cancelled_by='system',cancel_reason=?,updated=? WHERE id=? AND profile_id=? AND status='pending_payment'",
    options.paymentStatus ?? null,
    at,
    options.reason === "deadline"
      ? "Sinal não pago no prazo"
      : "Cobrança do sinal vencida ou cancelada",
    at,
    id,
    ctx.profile,
  );
  const b = await getBooking(ctx, id);
  await publish(
    ctx,
    "reserva.expired",
    b,
    "system",
    { reason: options.reason },
    `expired:${b.id}`,
  );
  await notifyCustomer(
    ctx,
    b,
    fill(config.expired_text, describe(b)),
    `expired:${b.id}`,
  );
  return b;
}

/** Reservas aguardando sinal com o prazo vencido (gancho periódico). */
export async function expireDue(
  ctx: ModuleContext,
  config: ReservaConfig,
  now: number,
) {
  const rows = await all(
    ctx.env,
    `SELECT b.id FROM reserva_bookings b WHERE b.profile_id=? AND b.status='pending_payment' AND b.payment_due_at<=?
      AND coalesce((SELECT sum(CASE WHEN r.kind='receive' THEN a.amount_cents ELSE -a.amount_cents END)
        FROM module_erp_allocations a JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key
        WHERE a.profile_id=b.profile_id AND a.module_id='reserva' AND a.source_id=b.id AND a.component='main'),0)<b.deposit_cents
      ORDER BY b.payment_due_at LIMIT 50`,
    ctx.profile,
    now,
  );
  const expired: string[] = [];
  for (const row of rows)
    if (
      await expireBooking(ctx, config, row.id, { reason: "deadline", at: now })
    )
      expired.push(row.id);
  return expired;
}

/**
 * Cobrança do sinal mudou (gancho onPaymentUpdated do núcleo, uma vez por
 * mudança, depois do webhook assinado e da consulta ao provedor).
 */
export async function paymentUpdated(
  ctx: ModuleContext,
  config: ReservaConfig,
  payment: Payment,
  previous: string,
) {
  if (!payment.ref_id) return;
  const row = await one(
    ctx.env,
    "SELECT * FROM reserva_bookings WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!row) return;
  // A cobrança faltante é vinculada no mesmo lote do recebimento.
  const sameRemote = row.payment_id && row.payment_id !== payment.id && await one(ctx.env, `SELECT 1 FROM payments p1 JOIN payments p2
    ON p2.profile_id=p1.profile_id AND p2.provider=p1.provider AND p2.account_id=p1.account_id AND p2.provider_payment_id=p1.provider_payment_id
    WHERE p1.profile_id=? AND p1.id=? AND p2.id=? AND p1.provider_payment_id IS NOT NULL`, ctx.profile, row.payment_id, payment.id);
  // Só a cobrança atual do sinal mexe na reserva. Uma substituída e paga
  // depois (conferência N-11) vira pendência: dinheiro a mais para estornar.
  if (row.payment_id && row.payment_id !== payment.id && !sameRemote) {
    if (payment.status === "paid" || payment.status === "refunded") await recordReplacedDeposit(ctx, row, payment);
    if (payment.status === "paid") {
      const b = await getBooking(ctx, row.id);
      await publish(
        ctx,
        "reserva.payment_late",
        b,
        "system",
        { reason: "replaced", payment_id: payment.id, needs_refund: true },
        `replaced:${payment.id}`,
      );
      if (b.conversation_id)
        try {
          await ctx.note(
            await ctx.conversation(b.conversation_id),
            `Uma cobrança antiga do sinal da reserva nº ${b.number} foi paga depois de substituída (${money(payment.amount_cents)}). Confira e estorne o valor a mais pelo Mercado Pago.`,
            { key: `replaced:${payment.id}` },
          );
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
    }
    return;
  }
  const at = clock();
  if (payment.status === "paid")
    return depositPaid(ctx, config, row.id, at, previous, payment);
  if (payment.status === "expired" || payment.status === "cancelled") {
    if (row.status !== "pending_payment") await reservaNative(ctx, row, row, { actor: "system" },
      "UPDATE reserva_bookings SET payment_status=?,updated=? WHERE id=? AND profile_id=?", payment.status, at, row.id, ctx.profile);
    await expireBooking(ctx, config, row.id, {
      reason:
        payment.status === "expired" ? "payment_expired" : "payment_cancelled",
      paymentStatus: payment.status,
      at,
      repeat: true,
    });
    return;
  }
  if (payment.status === "refunded") {
    const receipt = await depositReceipt(ctx, payment);
    // Legado ou queda anterior ao primeiro gancho: preserva a evidência do
    // recebimento original sem fabricar dívida/baixa para poder estorná-lo.
    if (!await one(ctx.env, "SELECT 1 FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", ctx.profile, receipt.reverses_key))
      await recordReplacedDeposit(ctx, row, { ...payment, status: "paid" });
    const notStarted = ["pending_payment", "confirmed"].includes(row.status) && row.checkin_status !== "completed" && row.arrival_at > at;
    await commitDepositReceipt(ctx, row, { ...row, status: notStarted ? "cancelled" : row.status }, receipt, [
      `UPDATE reserva_bookings SET payment_id=coalesce(payment_id,?),payment_status='refunded',updated=?,
       status=CASE WHEN ? THEN 'cancelled' ELSE status END,
       cancelled_at=CASE WHEN ? THEN ? ELSE cancelled_at END,
       cancelled_by=CASE WHEN ? THEN 'system' ELSE cancelled_by END,
       cancel_reason=CASE WHEN ? THEN ? ELSE cancel_reason END WHERE profile_id=? AND id=?`,
      [payment.id, at, notStarted ? 1 : 0, notStarted ? 1 : 0, at, notStarted ? 1 : 0, notStarted ? 1 : 0, REFUND_REASON, ctx.profile, row.id],
    ], { cancel: notStarted });
    // Estorno ou contestação do sinal (revisão M8): reserva que ainda não
    // começou é cancelada e a unidade volta a ficar livre; com o hóspede já
    // na casa (ou o check-in feito), vira pendência para a equipe.
    const b = await getBooking(ctx, row.id);
    // Já cancelada por este estorno: refaz evento e aviso (com chave), que
    // uma falha depois da gravação pode ter perdido (segunda conferência, A3).
    if (
      b.status === "cancelled" &&
      b.cancelled_by === "system" &&
      b.cancel_reason === REFUND_REASON
    )
      return announceCancel(ctx, config, b, "system", REFUND_REASON);
    if (["cancelled", "expired"].includes(b.status)) return;
    await publish(
      ctx,
      "reserva.changed",
      b,
      "system",
      { payment_status: "refunded", needs_review: true },
      `refunded:${b.id}`,
    );
    if (b.conversation_id)
      try {
        await ctx.note(
          await ctx.conversation(b.conversation_id),
          `Sinal da reserva nº ${b.number} estornado ou contestado depois do início. Confira com o hóspede e com o Mercado Pago.`,
          { key: `refunded:${b.id}` },
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
  }
}

async function depositPaid(
  ctx: ModuleContext,
  config: ReservaConfig,
  id: string,
  at: number,
  previous: string,
  payment: Payment,
) {
  const row = await rawBooking(ctx, id), receipt = await depositReceipt(ctx, payment);
  if (row.payment_status === "refunded") return;
  const balance = await receiptBalance(ctx, commercialSource(ctx, "reserva", id));
  const free = `NOT EXISTS (SELECT 1 FROM reserva_bookings o WHERE o.profile_id=reserva_bookings.profile_id AND o.unit_id=reserva_bookings.unit_id AND o.id<>reserva_bookings.id AND o.status IN ('pending_payment','confirmed') AND o.starts<reserva_bookings.ends AND o.ends>reserva_bookings.starts)
    AND NOT EXISTS (SELECT 1 FROM reserva_blocks k WHERE k.profile_id=reserva_bookings.profile_id AND (k.unit_id IS NULL OR k.unit_id=reserva_bookings.unit_id) AND k.starts<reserva_bookings.ends AND k.ends>reserva_bookings.starts)`;
  // Sem reabertura comercial no motor, sinal tardio exige devolução/conferência.
  // Nem a unidade livre autoriza reviver a reserva com títulos cancelados.
  const canRevive = false;
  const signalPaid = balance.allocated_cents + receipt.amount_cents >= row.deposit_cents;
  const confirm = signalPaid && (row.status === "pending_payment" || canRevive);
  const changed = await commitDepositReceipt(ctx, row, { ...row, status: confirm ? "confirmed" : row.status }, receipt, [
    `UPDATE reserva_bookings SET payment_id=coalesce(payment_id,?),payment_status='paid',paid_at=coalesce(paid_at,?),updated=?,
      status=CASE WHEN ? THEN 'confirmed' ELSE status END,
      confirmed_at=CASE WHEN ? THEN ? ELSE confirmed_at END,confirmed_by=CASE WHEN ? THEN 'payment' ELSE confirmed_by END,
      cancelled_at=CASE WHEN ? THEN NULL ELSE cancelled_at END,cancelled_by=CASE WHEN ? THEN NULL ELSE cancelled_by END,
      cancel_reason=CASE WHEN ? THEN '' ELSE cancel_reason END
      WHERE profile_id=? AND id=? AND (?=0 OR (${free}))`,
    [payment.id, at, at, confirm ? 1 : 0, confirm ? 1 : 0, at, confirm ? 1 : 0, confirm ? 1 : 0, confirm ? 1 : 0, confirm ? 1 : 0, ctx.profile, id, canRevive ? 1 : 0],
  ], { allowAllocation: !["cancelled", "expired"].includes(row.status) });
  if (changed && confirm) {
    const b = await getBooking(ctx, id);
    await publish(
      ctx,
      "reserva.confirmed",
      b,
      "system",
      {
        by: "payment",
        ...(canRevive ? { late: true, previous } : {}),
      },
      `confirmed:${b.id}`,
    );
    await notifyCustomer(
      ctx,
      b,
      fill(config.confirmed_text, describe(b)),
      `confirmed:${b.id}`,
    );
    return;
  }
  // Já confirmada pela equipe, cancelada, ou liberada e ocupada por outro.
  const b = await getBooking(ctx, id);
  // Repetição do gancho (conferência A3): já confirmada pelo pagamento numa
  // tentativa que falhou depois; refaz evento e aviso, os dois com chave.
  if (b.status === "confirmed" && b.confirmed_by === "payment") {
    await publish(
      ctx,
      "reserva.confirmed",
      b,
      "system",
      { by: "payment" },
      `confirmed:${b.id}`,
    );
    await notifyCustomer(
      ctx,
      b,
      fill(config.confirmed_text, describe(b)),
      `confirmed:${b.id}`,
    );
    return;
  }
  if (b.status === "confirmed" || b.status === "completed" || b.status === "pending_payment") return;
  await publish(ctx, "reserva.payment_late", b, "system", {
    reason: "late_payment_refund_required",
    needs_refund: true,
  });
  await notifyCustomer(
    ctx,
    b,
    `Recebemos o pagamento do sinal da reserva #${b.number}, mas ela já tinha sido ${b.status === "cancelled" ? "cancelada" : "liberada"}. A equipe vai falar com você para remarcar ou devolver o valor.`,
    `payment-late:${b.id}`,
  );
}
