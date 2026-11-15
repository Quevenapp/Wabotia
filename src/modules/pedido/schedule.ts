// Tarefas de tempo do Pedido, ligadas ao gancho periódico do núcleo
// (onSchedule em ./pedido.ts). Função pura em relação ao relógio: recebe `at`.
import { all, exec } from "../../db";
import { ApiError } from "../../types";
import type { ModuleContext } from "../api";
import { ALERT_STATUSES } from "./model";
import { clearChat, loadOrder, moveOrder } from "./orders";
import { config } from "./store";

const BATCH = 50;

/**
 * - Aguardando pagamento sem forma escolhida (ou com a cobrança não gerada)
 *   depois do prazo para pagar: cancela e avisa o cliente. A cobrança online
 *   aberta vence pelo núcleo (onPaymentUpdated cancela o pedido).
 * - Parado no mesmo estado além do alerta configurado: evento pedido.stale
 *   para a equipe (quadro da cozinha, webhooks, apps), uma vez por estado.
 * Cada registro é marcado com UPDATE condicionado; uma rodada repetida não
 * repete nada.
 */
export async function runDue(ctx: ModuleContext, at: number) {
  const cfg = await config(ctx);
  let expired = 0,
    stale = 0;
  const unpaid = await all(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE profile_id=? AND status='awaiting_payment' AND ((payment_status IN ('choosing','failed') AND created<=?) OR (payment_status='awaiting' AND payment_id IS NULL AND coalesce(payment_due_at,0)<=?)) ORDER BY created LIMIT ?",
    ctx.profile,
    at - cfg.payment_minutes * 60_000,
    at,
    BATCH,
  );
  for (const row of unpaid) {
    try {
      await moveOrder(
        ctx,
        row,
        "cancelled",
        "system",
        "Pagamento não definido no prazo.",
        { cancel_reason: "Pagamento não definido no prazo." },
      );
      if (row.conversation_id) await clearChat(ctx, row.conversation_id);
      expired++;
    } catch (error) {
      // Mudou no meio (cliente escolheu agora): a próxima rodada decide.
      if (!(error instanceof ApiError)) throw error;
    }
  }
  for (const status of ALERT_STATUSES) {
    const minutes = cfg.alerts[status];
    if (!minutes) continue;
    const idle = await all(
      ctx.env,
      "SELECT * FROM pedido_orders WHERE profile_id=? AND status=? AND stale_notified_at IS NULL AND status_at<=? ORDER BY status_at LIMIT ?",
      ctx.profile,
      status,
      at - minutes * 60_000,
      BATCH,
    );
    for (const order of idle) {
      const claimed = await exec(
        ctx.env,
        "UPDATE pedido_orders SET stale_notified_at=? WHERE id=? AND status=? AND status_at=? AND stale_notified_at IS NULL",
        at,
        order.id,
        status,
        order.status_at,
      );
      if (!claimed.meta.changes) continue;
      await ctx.publish(
        "pedido.stale",
        order.id,
        {
          order_id: order.id,
          number: order.number,
          status,
          since: order.status_at,
          minutes: Math.floor((at - order.status_at) / 60_000),
          limit_minutes: minutes,
          fulfillment: order.fulfillment,
          conversation_id: order.conversation_id,
        },
        { key: `stale:${order.id}:${order.status_at}` },
      );
      stale++;
    }
  }
  return { expired, stale };
}

export { loadOrder };
