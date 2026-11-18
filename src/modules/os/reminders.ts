// Avisos de tempo da Ordem de Serviço, ligados ao gancho periódico do núcleo
// (onSchedule em ./os.ts). Função pura em relação ao relógio: recebe `at`.
import { all, exec } from "../../db";
import type { ModuleContext } from "../api";
import { osSettings } from "./model";
import { snapshotType } from "./work-types";
import { notify } from "./store";

const DAY = 86_400_000;
const BATCH = 50;

/**
 * - Pronta e não retirada há `pickup_reminder_days`: um lembrete ao cliente
 *   por período em "Pronta" (pickup_reminded_at).
 * - Aberta sem mudança há `stale_days`: evento os.stale para a equipe e
 *   integrações, uma vez até a próxima mudança (stale_notified_at).
 * Cada registro é marcado depois da inclusão durável na fila, e a chave
 * de envio vem do registro: uma rodada repetida não repete nada.
 */
export async function runDue(ctx: ModuleContext, at: number) {
  const cfg = osSettings(await ctx.settings());
  let reminded = 0,
    stale = 0;
  let hasMore = false;
  // Cursor durável por fila: uma falha não prende os primeiros 50 registros.
  // Não muda a marca de entrega; o registro volta a ser tentado na próxima volta.
  const cursor = async (kind: string) => {
    const key = `os-reminders/${encodeURIComponent(ctx.profile)}/${kind}`;
    const saved = await ctx.env.MEDIA.get(key);
    return { key, value: saved ? await saved.json<[number, string] | null>() : null };
  };
  const checkpoint = async (state: Awaited<ReturnType<typeof cursor>>, rows: any[], column: string) => {
    const more = rows.length > BATCH;
    const last = rows[Math.min(rows.length, BATCH) - 1];
    if (more || state.value) await ctx.env.MEDIA.put(state.key, JSON.stringify(more ? [last[column], last.id] : null));
    hasMore ||= more || !!state.value;
  };
  {
    const state = await cursor("pickup");
    const due = await all(
      ctx.env,
      `SELECT * FROM os_orders WHERE profile_id=? AND status='ready' AND pickup_reminded_at IS NULL AND ((type_id='service_order' AND ?>0 AND ready_at<=?) OR (type_id<>'service_order' AND json_extract(type_snapshot_json,'$.type.features.pickup_reminder_days')>0 AND ready_at<=?-json_extract(type_snapshot_json,'$.type.features.pickup_reminder_days')*86400000)) ${state.value ? "AND (ready_at>? OR (ready_at=? AND id>?))" : ""} ORDER BY ready_at,id LIMIT ?`,
      ctx.profile,
      cfg.pickup_reminder_days,
      at - cfg.pickup_reminder_days * DAY,
      at,
      ...(state.value ? [state.value[0], state.value[0], state.value[1]] : []), BATCH + 1,
    );
    for (const order of due.slice(0, BATCH)) {
      try {
        await notify(ctx, order, "pickup_reminder", `pickup:${order.id}:${order.ready_at}`);
        const claimed = await exec(ctx.env,
          "UPDATE os_orders SET pickup_reminded_at=? WHERE profile_id=? AND id=? AND status='ready' AND pickup_reminded_at IS NULL AND ready_at=?",
          at, ctx.profile, order.id, order.ready_at);
        if (!claimed.meta.changes) continue;
        reminded++;
      } catch { hasMore = true; }
    }
    await checkpoint(state, due, "ready_at");
  }
  const state = await cursor("stale");
  const idle = await all(
    ctx.env,
    `SELECT * FROM os_orders WHERE profile_id=? AND status NOT IN ('delivered','cancelled') AND stale_notified_at IS NULL AND ((type_id='service_order' AND updated<=?) OR (type_id<>'service_order' AND json_extract(type_snapshot_json,'$.type.features.stale_days')>0 AND updated<=?-json_extract(type_snapshot_json,'$.type.features.stale_days')*86400000)) ${state.value ? "AND (updated>? OR (updated=? AND id>?))" : ""} ORDER BY updated,id LIMIT ?`,
    ctx.profile,
    at - cfg.stale_days * DAY,
    at,
    ...(state.value ? [state.value[0], state.value[0], state.value[1]] : []), BATCH + 1,
  );
  for (const order of idle.slice(0, BATCH)) {
    try {
      await ctx.publish("os.stale", order.id, snapshotType(order) ? { order_id: order.id, version: order.row_version, status: order.status, stage: order.stage } : {
        order_id: order.id,
        number: order.number,
        status: order.status,
        since: order.updated,
        days: Math.floor((at - order.updated) / DAY),
        assignee: order.assignee,
      }, { key: `stale:${order.id}:${order.updated}` });
      const claimed = await exec(ctx.env,
        "UPDATE os_orders SET stale_notified_at=? WHERE profile_id=? AND id=? AND stale_notified_at IS NULL AND updated=?",
        at, ctx.profile, order.id, order.updated);
      if (!claimed.meta.changes) continue;
      stale++;
    } catch { hasMore = true; }
  }
  await checkpoint(state, idle, "updated");
  if (hasMore) await ctx.wake({ modules: true });
  return { reminded, stale };
}
