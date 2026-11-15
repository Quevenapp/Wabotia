// Avisos de tempo da Ordem de Serviço, ligados ao gancho periódico do núcleo
// (onSchedule em ./os.ts). Função pura em relação ao relógio: recebe `at`.
import { all, exec } from "../../db";
import type { ModuleContext } from "../api";
import { osSettings } from "./model";
import { notify } from "./store";

const DAY = 86_400_000;
const BATCH = 50;

/**
 * - Pronta e não retirada há `pickup_reminder_days`: um lembrete ao cliente
 *   por período em "Pronta" (pickup_reminded_at).
 * - Aberta sem mudança há `stale_days`: evento os.stale para a equipe e
 *   integrações, uma vez até a próxima mudança (stale_notified_at).
 * Cada registro é marcado antes do envio com UPDATE condicionado, e a chave
 * de envio vem do registro: uma rodada repetida não repete nada.
 */
export async function runDue(ctx: ModuleContext, at: number) {
  const cfg = osSettings(await ctx.settings());
  let reminded = 0,
    stale = 0;
  if (cfg.pickup_reminder_days > 0) {
    const due = await all(
      ctx.env,
      "SELECT * FROM os_orders WHERE profile_id=? AND status='ready' AND pickup_reminded_at IS NULL AND ready_at<=? ORDER BY ready_at LIMIT ?",
      ctx.profile,
      at - cfg.pickup_reminder_days * DAY,
      BATCH,
    );
    for (const order of due) {
      const claimed = await exec(
        ctx.env,
        "UPDATE os_orders SET pickup_reminded_at=? WHERE id=? AND status='ready' AND pickup_reminded_at IS NULL",
        at,
        order.id,
      );
      if (!claimed.meta.changes) continue;
      await notify(
        ctx,
        order,
        "pickup_reminder",
        `pickup:${order.id}:${order.ready_at}`,
      );
      reminded++;
    }
  }
  const idle = await all(
    ctx.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND status NOT IN ('delivered','cancelled') AND stale_notified_at IS NULL AND updated<=? ORDER BY updated LIMIT ?",
    ctx.profile,
    at - cfg.stale_days * DAY,
    BATCH,
  );
  for (const order of idle) {
    const claimed = await exec(
      ctx.env,
      "UPDATE os_orders SET stale_notified_at=? WHERE id=? AND stale_notified_at IS NULL AND updated=?",
      at,
      order.id,
      order.updated,
    );
    if (!claimed.meta.changes) continue;
    await ctx.publish("os.stale", order.id, {
      order_id: order.id,
      number: order.number,
      status: order.status,
      since: order.updated,
      days: Math.floor((at - order.updated) / DAY),
      assignee: order.assignee,
    });
    stale++;
  }
  return { reminded, stale };
}
