// Ganchos do Pedido (src/modules/pedido/public.ts) registrados pela Entrega.
// O Pedido só os chama com a Entrega ligada na área, então a Entrega não
// declara `requires: ["pedido"]` e segue servindo entregas avulsas. Todos
// aguentam repetição: o Pedido pode anunciar a mesma mudança de novo.
import { all, exec, one } from "../../db";
import { now } from "../../types";
import { modulesApi } from "../api";
import {
  onOrderStatusChanged,
  onStatusNotice,
  provideDeliveryInfo,
  type DeliveryInfo,
} from "../pedido/public";
import {
  config,
  deliveryView,
  eventPayload,
  history,
  signalOf,
  STATUS_LABELS,
  type DeliveryStatus,
} from "./store";
import { etaSentence, openTrack, windowOpen } from "./notify";

const MODULE = "entrega";

const openForOrder = (env: any, profile: string, orderId: string) =>
  one(
    env,
    "SELECT * FROM entrega_deliveries WHERE profile_id=? AND source='pedido' AND source_ref=? AND status IN ('pending','assigned','en_route') ORDER BY created DESC LIMIT 1",
    profile,
    orderId,
  );

/**
 * A cozinha (ou o pagamento, ou a rodada do Pedido) marcou o pedido como
 * entregue ou cancelado: a entrega aberta acompanha, sem chamar o Pedido de
 * novo. Mudanças feitas pela própria Entrega chegam aqui já com a entrega no
 * estado final e são ignoradas.
 */
onOrderStatusChanged(MODULE, async (env, profile, { order, to, actor }) => {
  if (to !== "delivered" && to !== "cancelled") return;
  const row = await openForOrder(env, profile, order.id);
  if (!row) return;
  const ctx = modulesApi(env, profile, MODULE);
  const cfg = await config(ctx);
  const at = now();
  const delivered = to === "delivered";
  const reason = "Pedido cancelado no Pedido.";
  const done = await exec(
    env,
    delivered
      ? "UPDATE entrega_deliveries SET status='delivered',delivered_at=?,ended_at=?,updated=? WHERE id=? AND status IN ('pending','assigned','en_route')"
      : "UPDATE entrega_deliveries SET status='cancelled',cancelled_at=?,ended_at=?,updated=?,cancel_reason=? WHERE id=? AND status IN ('pending','assigned','en_route')",
    ...(delivered ? [at, at, at, row.id] : [at, at, at, reason, row.id]),
  );
  if (!done.meta?.changes) return;
  await history(
    ctx,
    row.id,
    to,
    actor || "system",
    delivered ? "Marcado como entregue no Pedido." : reason,
  );
  // O cliente já recebe o aviso do próprio Pedido; o link cancelado some só
  // quando a entrega foi cancelada (entregue, a página mostra "Entregue").
  if (!delivered && row.track_step_id)
    await ctx.cancelWebStep(row.track_step_id).catch(() => undefined);
  const view = deliveryView(
    (await one(env, "SELECT * FROM entrega_deliveries WHERE id=?", row.id))!,
    cfg,
    at,
  );
  await ctx.publish(
    delivered ? "entrega.delivered" : "entrega.cancelled",
    row.id,
    eventPayload(view),
    { key: `${row.id}:${to}` },
  );
});

/**
 * "Saiu para entrega" numa mensagem só: com a rota iniciada pelo entregador
 * (a Entrega grava a rota antes de mudar o Pedido) e a janela de 24 h
 * aberta, o texto do Pedido vira o corpo do botão Acompanhar. Fora disso
 * (cozinha marcou antes da saída, janela fechada, sem endereço público),
 * devolve false e o Pedido manda o aviso dele.
 */
onStatusNotice(MODULE, async (env, profile, notice) => {
  if (notice.status !== "out_for_delivery") return false;
  const row = await openForOrder(env, profile, notice.order.id);
  if (!row || row.status !== "en_route") return false;
  if (row.conversation_id !== notice.conversation_id) return false;
  const ctx = modulesApi(env, profile, MODULE);
  const cfg = await config(ctx);
  if (!cfg.tracking_link) return false;
  let c;
  try {
    c = await ctx.conversation(notice.conversation_id);
  } catch {
    return false;
  }
  if (!windowOpen(c)) return false;
  const text = [notice.text, etaSentence(row, cfg, now())]
    .filter(Boolean)
    .join(" ");
  return openTrack(ctx, cfg, c, row, text, `notice:${notice.key}`, false);
});

/**
 * Entregador e previsão no quadro da cozinha e no detalhe do pedido: as
 * entregas da área abertas ou encerradas nas últimas 24 h, filtradas pelos
 * pedidos pedidos (sem IN com centenas de ids). Sem posição nem endereço.
 */
provideDeliveryInfo(MODULE, async (env, profile, orderIds) => {
  const wanted = new Set(orderIds);
  const out = new Map<string, DeliveryInfo>();
  if (!wanted.size) return out;
  const ctx = modulesApi(env, profile, MODULE);
  const cfg = await config(ctx);
  const at = now();
  const rows = await all(
    env,
    "SELECT * FROM entrega_deliveries WHERE profile_id=? AND source='pedido' AND (status IN ('pending','assigned','en_route') OR ended_at>?) ORDER BY created DESC LIMIT 500",
    profile,
    at - 86400000,
  );
  for (const row of rows) {
    if (!wanted.has(row.source_ref) || out.has(row.source_ref)) continue;
    const enRoute = row.status === "en_route";
    const fresh = enRoute && signalOf(row, cfg, at) === "ok";
    out.set(row.source_ref, {
      status: row.status,
      status_label: STATUS_LABELS[row.status as DeliveryStatus] || row.status,
      courier_id: row.courier_id,
      courier_name: row.courier_name || null,
      eta_at: fresh && row.eta_at ? row.eta_at : null,
      eta_minutes:
        fresh && row.eta_at
          ? Math.max(0, Math.ceil((row.eta_at - at) / 60000))
          : null,
      position_at: enRoute ? row.last_at : null,
    });
  }
  return out;
});
