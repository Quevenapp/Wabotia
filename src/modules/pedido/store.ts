// Pedido: estado da loja (aberta, pausada, fora do horário) e se a Cobrança
// do núcleo está pronta para cobrar online (ctx.paymentsReady).
import { exec, one } from "../../db";
import { type Actor, now, requireValue } from "../../types";
import type { ModuleContext } from "../api";
import {
  ONLINE_METHODS,
  PAYMENT_METHODS,
  etaText,
  fill,
  hoursText,
  pedidoConfig,
  storeState,
  whenLabel,
  type PaymentMethod,
  type PedidoConfig,
} from "./model";

export async function config(ctx: ModuleContext): Promise<PedidoConfig> {
  return pedidoConfig(await ctx.settings());
}

export async function loadPause(ctx: ModuleContext) {
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_store WHERE profile_id=?",
    ctx.profile,
  );
  return {
    paused: !!row?.paused,
    message: (row?.message as string) || "",
    updated: (row?.updated as number) || null,
    updated_by: (row?.updated_by as string) || null,
  };
}

/** Cobrança ligada na área e conta do provedor ativa (ctx.paymentsReady). */
export async function paymentsReady(ctx: ModuleContext) {
  return (await ctx.paymentsReady()).ready;
}

/** Formas de pagamento oferecidas agora (online só com a Cobrança pronta). */
export async function offeredMethods(
  ctx: ModuleContext,
  cfg: PedidoConfig,
): Promise<PaymentMethod[]> {
  const online = await paymentsReady(ctx);
  return PAYMENT_METHODS.filter(
    (method) =>
      cfg.payments[method] && (online || !ONLINE_METHODS.includes(method)),
  );
}

/** Situação da loja em `at`, com o texto ao cliente quando fechada. */
export async function storeSituation(
  ctx: ModuleContext,
  cfg: PedidoConfig,
  at: number,
) {
  const pause = await loadPause(ctx);
  const state = storeState(cfg, at, pause.paused);
  const message =
    state.reason === "paused"
      ? [cfg.texts.paused, pause.message].filter(Boolean).join("\n\n")
      : state.reason === "closed"
        ? fill(cfg.texts.closed, {
            abre: state.opens_at
              ? `Abrimos ${whenLabel(state.opens_at, at)}.`
              : "",
            horario: hoursText(cfg),
            loja: cfg.store_name,
          })
        : "";
  return {
    ...state,
    paused: pause.paused,
    pause_message: pause.message,
    // Texto apagado nas mensagens: o cliente ainda recebe um aviso.
    message: message || (state.open ? "" : "A loja está fechada agora."),
    hours_text: hoursText(cfg),
    eta: etaText(cfg),
  };
}

/** GET pedido: regras, situação da loja e pagamentos para o painel e os apps. */
export async function overview(ctx: ModuleContext, at: number) {
  const cfg = await config(ctx);
  const [store, ready, methods, counts, pause] = await Promise.all([
    storeSituation(ctx, cfg, at),
    paymentsReady(ctx),
    offeredMethods(ctx, cfg),
    one(
      ctx.env,
      "SELECT (SELECT count(*) FROM pedido_categories WHERE profile_id=?1) categories,(SELECT count(*) FROM pedido_items WHERE profile_id=?1) items,(SELECT count(*) FROM pedido_items WHERE profile_id=?1 AND available=1) available",
      ctx.profile,
    ),
    loadPause(ctx),
  ]);
  return {
    config: cfg,
    store: {
      open: store.open,
      reason: store.reason,
      paused: store.paused,
      pause_message: store.pause_message,
      paused_at: pause.paused ? pause.updated : null,
      paused_by: pause.paused ? pause.updated_by : null,
      closes_at: store.closes_at,
      opens_at: store.opens_at,
      message: store.message,
      hours_text: store.hours_text,
      eta: store.eta,
    },
    payments: { online_ready: ready, offered: methods },
    menu: {
      categories: counts?.categories || 0,
      items: counts?.items || 0,
      available_items: counts?.available || 0,
    },
  };
}

/**
 * POST pedido/store/pause {paused, message?}: "loja fechada agora" e a volta.
 * Qualquer pessoa da equipe pode pausar (aplicações: conversations:write).
 */
export async function setPause(ctx: ModuleContext, actor: Actor, data: any) {
  ctx.access(actor, "conversations:write");
  requireValue(
    typeof data.paused === "boolean",
    "Informe paused como verdadeiro ou falso.",
  );
  const message =
    data.message === undefined || data.message === null
      ? ""
      : String(data.message).trim();
  requireValue(
    Array.from(message).length <= 300,
    "Mensagem da pausa: até 300 caracteres.",
  );
  const before = await loadPause(ctx);
  await exec(
    ctx.env,
    "INSERT INTO pedido_store(profile_id,paused,message,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET paused=excluded.paused,message=excluded.message,updated=excluded.updated,updated_by=excluded.updated_by",
    ctx.profile,
    data.paused ? 1 : 0,
    data.paused ? message : "",
    now(),
    actor.id,
  );
  if (before.paused !== data.paused)
    await ctx.publish("pedido.store_changed", ctx.profile, {
      paused: data.paused,
      message: data.paused ? message : "",
      actor: actor.id,
    });
  return (await overview(ctx, now())).store;
}
