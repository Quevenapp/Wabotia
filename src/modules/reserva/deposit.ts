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
import { ACTIVE_SQL } from "./availability";
import {
  announceCancel,
  cancelBooking,
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
  const at = options.at ?? clock();
  const minutes = Math.max(
    30,
    Math.round(((booking.payment_due_at ?? at) - at) / 60000),
  );
  try {
    const payment = await ctx.charge(c, {
      method: config.deposit_method,
      amount_cents: booking.deposit_cents,
      description:
        `Sinal da reserva #${booking.number} - ${booking.unit_name}`.slice(
          0,
          120,
        ),
      ref: booking.id,
      sourceKey: `deposit:${booking.id}`,
      expiresMinutes: Math.min(minutes, 30 * 24 * 60),
      actor: options.actor,
      notification: options.notification,
    });
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_id=?,payment_status=?,payment_error=NULL,updated=? WHERE id=? AND profile_id=?",
      payment.id,
      payment.status,
      clock(),
      booking.id,
      ctx.profile,
    );
    return { booking: await getBooking(ctx, booking.id), payment, error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_error=?,updated=? WHERE id=? AND profile_id=?",
      error.code,
      clock(),
      booking.id,
      ctx.profile,
    );
    console.error(
      JSON.stringify({
        component: "reserva-deposit",
        profile: ctx.profile,
        booking: booking.id,
        error: error.code,
      }),
    );
    return { booking: await getBooking(ctx, booking.id), payment: null, error };
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
  const done = await exec(
    ctx.env,
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
  if (!done.meta?.changes) {
    if (!options.repeat) return null;
    const already = await getBooking(ctx, id);
    if (already.status !== "expired" || already.cancelled_by !== "system")
      return null;
  }
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
    "SELECT id FROM reserva_bookings WHERE profile_id=? AND status='pending_payment' AND payment_due_at<=? ORDER BY payment_due_at LIMIT 50",
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
  // Reserva sem cobrança gravada (falha entre criar a cobrança e gravá-la):
  // esta é a atual, como no Pedido (segunda conferência, N2-3).
  if (!row.payment_id) {
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_id=? WHERE id=? AND profile_id=? AND payment_id IS NULL",
      payment.id,
      row.id,
      ctx.profile,
    );
    row.payment_id = (
      await one(
        ctx.env,
        "SELECT payment_id FROM reserva_bookings WHERE id=? AND profile_id=?",
        row.id,
        ctx.profile,
      )
    )?.payment_id;
  }
  // Só a cobrança atual do sinal mexe na reserva. Uma substituída e paga
  // depois (conferência N-11) vira pendência: dinheiro a mais para estornar.
  if (row.payment_id !== payment.id) {
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
    return depositPaid(ctx, config, row.id, at, previous);
  if (payment.status === "expired" || payment.status === "cancelled") {
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_status=?,updated=? WHERE id=? AND profile_id=?",
      payment.status,
      at,
      row.id,
      ctx.profile,
    );
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
    const marked = await exec(
      ctx.env,
      "UPDATE reserva_bookings SET payment_status='refunded',updated=? WHERE id=? AND profile_id=? AND coalesce(payment_status,'')<>'refunded'",
      at,
      row.id,
      ctx.profile,
    );
    // Repetição do gancho (conferência A3): já marcado, refaz os passos
    // seguintes (cancelamento, evento e nota com chave).
    if (!marked.meta?.changes && row.payment_status !== "refunded") return;
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
    const notStarted =
      ["pending_payment", "confirmed"].includes(b.status) &&
      b.checkin_status !== "completed" &&
      b.arrival_at > at;
    if (notStarted) {
      await cancelBooking(ctx, config, {
        id: b.id,
        actor: "system",
        reason: REFUND_REASON,
      });
      return;
    }
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
) {
  // Aguardando: confirma.
  const confirmed = await exec(
    ctx.env,
    "UPDATE reserva_bookings SET status='confirmed',payment_status='paid',paid_at=?,confirmed_at=?,confirmed_by='payment',updated=? WHERE id=? AND profile_id=? AND status='pending_payment'",
    at,
    at,
    at,
    id,
    ctx.profile,
  );
  // Pago depois de liberada por prazo: volta se a unidade ainda está livre.
  const revived = confirmed.meta?.changes
    ? confirmed
    : await exec(
        ctx.env,
        `UPDATE reserva_bookings SET status='confirmed',payment_status='paid',paid_at=?,confirmed_at=?,confirmed_by='payment',cancelled_at=NULL,cancelled_by=NULL,cancel_reason='',updated=?
         WHERE id=? AND profile_id=? AND status='expired'
           AND NOT EXISTS (SELECT 1 FROM reserva_bookings o WHERE o.profile_id=reserva_bookings.profile_id AND o.unit_id=reserva_bookings.unit_id AND o.id<>reserva_bookings.id AND o.status IN ${ACTIVE_SQL} AND o.starts<reserva_bookings.ends AND o.ends>reserva_bookings.starts)
           AND NOT EXISTS (SELECT 1 FROM reserva_blocks k WHERE k.profile_id=reserva_bookings.profile_id AND (k.unit_id IS NULL OR k.unit_id=reserva_bookings.unit_id) AND k.starts<reserva_bookings.ends AND k.ends>reserva_bookings.starts)
           AND ends>?`,
        at,
        at,
        at,
        id,
        ctx.profile,
        at,
      );
  if (revived.meta?.changes) {
    const b = await getBooking(ctx, id);
    await publish(
      ctx,
      "reserva.confirmed",
      b,
      "system",
      {
        by: "payment",
        ...(confirmed.meta?.changes ? {} : { late: true, previous }),
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
  await exec(
    ctx.env,
    "UPDATE reserva_bookings SET payment_status='paid',paid_at=?,updated=? WHERE id=? AND profile_id=?",
    at,
    at,
    id,
    ctx.profile,
  );
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
  if (b.status === "confirmed" || b.status === "completed") return;
  await publish(ctx, "reserva.payment_late", b, "system", {
    reason: b.status === "cancelled" ? "cancelled" : "unit_taken",
    needs_refund: true,
  });
  await notifyCustomer(
    ctx,
    b,
    `Recebemos o pagamento do sinal da reserva #${b.number}, mas ela já tinha sido ${b.status === "cancelled" ? "cancelada" : "liberada"}. A equipe vai falar com você para remarcar ou devolver o valor.`,
    `payment-late:${b.id}`,
  );
}
