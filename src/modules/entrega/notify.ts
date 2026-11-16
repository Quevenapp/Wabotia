// Mensagens ao cliente da Entrega e a rodada periódica (onSchedule). Regras
// para não inundar: atualizações só com a janela de 24 h aberta, no intervalo
// e no máximo configurados, nunca com posição velha e nunca depois do aviso
// "chegando"; fora da janela, só os avisos (saída, chegada, entrega), pelo
// modelo de notificação e com o consentimento de pedido. Uso em docs/ENTREGA.md.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, json, now } from "../../types";
import type { ModuleContext, TrackView } from "../api";
import { fill, type EntregaConfig } from "./config";
import {
  config,
  deliveryView,
  eventPayload,
  hhmm,
  MAX_ROUTE_MS,
  openFor,
  signalOf,
  STATUS_LABELS,
  type DeliveryRow,
  type DeliveryStatus,
} from "./store";

const DAY_MS = 86400000;
/** Janela de 24 h: o cliente escreveu nas últimas 24 horas. */
export const windowOpen = (c: Conversation, at = now()) =>
  at - (c.last_customer || 0) < DAY_MS;

async function conversationOf(ctx: ModuleContext, row: DeliveryRow) {
  if (!row.conversation_id) return null;
  try {
    return await ctx.conversation(row.conversation_id);
  } catch {
    return null;
  }
}

/** Fora da janela: só no modo "milestones" e com o consentimento de pedido. */
async function closedAllowed(
  ctx: ModuleContext,
  cfg: EntregaConfig,
  c: Conversation,
) {
  if (cfg.outside_window !== "milestones") return false;
  const consent = await ctx.consent(c, "order");
  return !!consent && consent.status === "granted";
}

/** Valores dos textos: {rotulo}, {entregador}, {minutos}, {horario}… */
export function values(row: DeliveryRow, at = now()) {
  const minutes = row.eta_at
    ? Math.max(1, Math.ceil((row.eta_at - at) / 60000))
    : null;
  return {
    rotulo: row.label,
    entregador: row.courier_name || "O entregador",
    ...(minutes !== null
      ? { minutos: minutes, horario: hhmm(row.eta_at) }
      : {}),
    ...(row.distance_m !== null && row.distance_m !== undefined
      ? {
          distancia:
            row.distance_m >= 1000
              ? `${(row.distance_m / 1000).toFixed(1).replace(".", ",")} km`
              : `${row.distance_m} m`,
        }
      : {}),
    ...(row.last_at ? { hora_posicao: hhmm(row.last_at) } : {}),
  };
}

/** Frase da previsão, ou "" sem previsão ou com posição velha. */
function etaSentence(row: DeliveryRow, cfg: EntregaConfig, at: number) {
  if (!row.eta_at || signalOf(row, cfg, at) !== "ok") return "";
  return fill(cfg.texts.eta, values(row, at));
}

/**
 * Aviso (saída, chegada, entrega, interrupção): com a janela aberta, texto;
 * fechada, pelo modelo de notificação com o consentimento de pedido.
 */
export async function milestone(
  ctx: ModuleContext,
  cfg: EntregaConfig,
  c: Conversation | null,
  text: string,
  key: string,
) {
  if (!c || !text.trim()) return false;
  if (!windowOpen(c) && !(await closedAllowed(ctx, cfg, c))) return false;
  try {
    await ctx.sendMessage(
      c,
      { text },
      { key, notification: true, purpose: "order" },
    );
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return false;
  }
}

async function setNotified(
  ctx: ModuleContext,
  id: string,
  flag: string,
  at = now(),
) {
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET notified=json_set(notified,?,?) WHERE id=?",
    `$.${flag}`,
    at,
    id,
  );
}

/** Link de acompanhamento (passo web "track"); o anterior é cancelado. */
async function openTrack(
  ctx: ModuleContext,
  cfg: EntregaConfig,
  c: Conversation,
  row: DeliveryRow,
  text: string,
  key: string,
) {
  try {
    const { step } = await ctx.openWebStep(c, {
      kind: "track",
      ref: row.id,
      trigger: "module",
      actor: "system",
      sourceKey: key,
      ttlMinutes: cfg.link_hours * 60,
      text: text || "Acompanhe a entrega pelo link:",
      button: "Acompanhar",
      spec: { page: "track", title: row.label, fields: [] },
    });
    if (row.track_step_id && row.track_step_id !== step.id)
      await ctx.cancelWebStep(row.track_step_id).catch(() => undefined);
    await exec(
      ctx.env,
      "UPDATE entrega_deliveries SET track_step_id=? WHERE id=?",
      step.id,
      row.id,
    );
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Sem endereço público ou janela fechada: só o texto, se houver.
    if (text) await milestone(ctx, cfg, c, text, `${key}:text`);
    return false;
  }
}

/**
 * Saída: no Pedido, o próprio Pedido já avisou "saiu para entrega"; aqui vão
 * só o link (e a previsão). Nos demais, o aviso de saída com o link. Sem
 * destino, pede a localização ao cliente (janela aberta).
 */
export async function announceStart(ctx: ModuleContext, row: DeliveryRow) {
  const cfg = await config(ctx);
  const c = await conversationOf(ctx, row);
  if (!c) return;
  const at = now();
  const parts = [
    row.source !== "pedido" && cfg.notices.started
      ? fill(cfg.texts.started, values(row, at))
      : "",
    etaSentence(row, cfg, at),
  ].filter(Boolean);
  if (windowOpen(c, at)) {
    if (cfg.tracking_link)
      await openTrack(ctx, cfg, c, row, parts.join(" "), `start:${row.id}`);
    else if (parts.length)
      await milestone(ctx, cfg, c, parts.join(" "), `start:${row.id}`);
    if (cfg.ask_location && (row.dest_lat === null || row.dest_lat === undefined))
      await ctx
        .sendInteractive(
          c,
          {
            type: "location_request",
            body: "Para calcular a previsão de chegada, envie a sua localização (opcional).",
          },
          { key: `ask-location:${row.id}` },
        )
        .catch((error) => {
          if (!(error instanceof ApiError)) throw error;
        });
  } else if (parts.length && row.source !== "pedido")
    await milestone(ctx, cfg, c, parts.join(" "), `start:${row.id}`);
  await setNotified(ctx, row.id, "started", at);
}

/** Entregue: no Pedido, o Pedido avisa; nos demais, o aviso de entrega. */
export async function announceDelivered(ctx: ModuleContext, row: DeliveryRow) {
  const cfg = await config(ctx);
  if (row.source === "pedido" || !cfg.notices.delivered) return;
  await milestone(
    ctx,
    cfg,
    await conversationOf(ctx, row),
    fill(cfg.texts.delivered, values(row)),
    `delivered:${row.id}`,
  );
}

/** Cancelada depois de sair: avisa quem já recebeu o aviso de saída. */
export async function announceCancelled(ctx: ModuleContext, row: DeliveryRow) {
  const cfg = await config(ctx);
  if (row.track_step_id)
    await ctx.cancelWebStep(row.track_step_id).catch(() => undefined);
  if (!json(row.notified, {}).started) return;
  await milestone(
    ctx,
    cfg,
    await conversationOf(ctx, row),
    fill(cfg.texts.cancelled, values(row)),
    `cancelled:${row.id}`,
  );
}

/**
 * Atualização periódica: previsão em texto, a localização (mensagem de
 * localização do WhatsApp) ou as duas. Sem destino não há previsão: vai a
 * localização. Linha que não manda localização: só a previsão.
 */
async function sendUpdate(
  ctx: ModuleContext,
  cfg: EntregaConfig,
  c: Conversation,
  row: DeliveryRow,
  at: number,
) {
  const eta = etaSentence(row, cfg, at);
  const key = `update:${row.id}:${row.updates_sent + 1}`;
  const wantsPin =
    cfg.updates.mode === "location" ||
    cfg.updates.mode === "eta_and_location" ||
    !eta;
  if (wantsPin && row.last_lat !== null && row.last_lat !== undefined) {
    const caption = [
      cfg.updates.mode === "eta_and_location" ? eta : "",
      fill(cfg.texts.location, values(row, at)),
    ]
      .filter(Boolean)
      .join(" ");
    try {
      await ctx.sendMessage(
        c,
        {
          text: caption,
          content: {
            type: "location",
            location: {
              latitude: row.last_lat,
              longitude: row.last_lng,
              name: `${row.courier_name || "Entregador"} · ${row.label}`.slice(0, 100),
              address: `Posição às ${hhmm(row.last_at)}`,
            },
          },
        },
        { key },
      );
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  if (!eta) return false;
  await ctx.sendMessage(c, { text: eta }, { key: `${key}:text` });
  return true;
}

/** Rodada periódica: avisos, atualizações, sinal perdido e retenção. */
export async function runDue(ctx: ModuleContext, at: number) {
  const cfg = await config(ctx);
  const rows = await all(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE profile_id=? AND status='en_route' ORDER BY started_at LIMIT 50",
    ctx.profile,
  );
  for (const row of rows) {
    // Rota esquecida aberta: encerra sem avisar o cliente.
    if (row.started_at && at - row.started_at > MAX_ROUTE_MS) {
      const reason = "Rota encerrada automaticamente depois de 8 horas sem conclusão.";
      const done = await exec(
        ctx.env,
        "UPDATE entrega_deliveries SET status='cancelled',cancelled_at=?,ended_at=?,cancel_reason=?,updated=? WHERE id=? AND status='en_route'",
        at,
        at,
        reason,
        at,
        row.id,
      );
      if (done.meta?.changes) {
        await exec(
          ctx.env,
          "INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,'cancelled','system',?,?)",
          crypto.randomUUID(),
          ctx.profile,
          row.id,
          reason,
          at,
        );
        if (row.track_step_id)
          await ctx.cancelWebStep(row.track_step_id).catch(() => undefined);
        await ctx.publish(
          "entrega.cancelled",
          row.id,
          eventPayload(deliveryView({ ...row, status: "cancelled" }, cfg, at)),
          { key: `${row.id}:cancelled` },
        );
      }
      continue;
    }
    const notified = json(row.notified, {});
    const c = await conversationOf(ctx, row);
    // Sem posição: avisa a equipe uma vez (nota na conversa e evento).
    const seen = row.last_at || row.started_at || at;
    if (at - seen > cfg.app.stale_minutes * 60000 && !notified.signal) {
      await setNotified(ctx, row.id, "signal", at);
      await ctx.publish(
        "entrega.signal_lost",
        row.id,
        { ...eventPayload(deliveryView(row, cfg, at)), last_at: row.last_at },
        { key: `${row.id}:signal:${seen}` },
      );
      if (c)
        await ctx
          .note(
            c,
            `Entrega: sem posição de ${row.courier_name || "o entregador"} desde ${hhmm(seen)} (${row.label}).`,
            { key: `signal:${row.id}:${seen}` },
          )
          .catch(() => undefined);
    }
    if (row.arriving_at && !notified.arriving) {
      await setNotified(ctx, row.id, "arriving", at);
      if (cfg.notices.arriving)
        await milestone(
          ctx,
          cfg,
          c,
          fill(cfg.texts.arriving, values(row, at)),
          `arriving:${row.id}`,
        );
      await ctx.publish(
        "entrega.arriving",
        row.id,
        eventPayload(deliveryView(row, cfg, at)),
        { key: `${row.id}:arriving` },
      );
      continue;
    }
    if (
      row.arriving_at ||
      cfg.updates.mode === "off" ||
      row.updates_sent >= cfg.updates.max ||
      !row.next_update_at ||
      row.next_update_at > at
    )
      continue;
    // Só com posição recente e a janela aberta; senão pula esta vez.
    const sent =
      !!c &&
      windowOpen(c, at) &&
      signalOf(row, cfg, at) === "ok" &&
      (await sendUpdate(ctx, cfg, c, row, at));
    await exec(
      ctx.env,
      "UPDATE entrega_deliveries SET updates_sent=updates_sent+?,next_update_at=? WHERE id=?",
      sent ? 1 : 0,
      at + cfg.updates.every_minutes * 60000,
      row.id,
    );
  }
  await purge(ctx, cfg, at);
}

/**
 * Retenção: depois de `retention_hours` do fim, apaga a posição, o rastro e as
 * coordenadas do destino, e fecha o link de acompanhamento. Fica o registro
 * (quem entregou, horários) para o histórico do pedido.
 */
export async function purge(ctx: ModuleContext, cfg: EntregaConfig, at: number) {
  const rows = await all(
    ctx.env,
    "SELECT id,track_step_id FROM entrega_deliveries WHERE profile_id=? AND purged_at IS NULL AND ended_at IS NOT NULL AND ended_at<? LIMIT 50",
    ctx.profile,
    at - cfg.retention_hours * 3600000,
  );
  for (const row of rows) {
    await exec(
      ctx.env,
      "UPDATE entrega_deliveries SET last_lat=NULL,last_lng=NULL,last_accuracy=NULL,last_speed=NULL,last_battery=NULL,trail='[]',dest_lat=NULL,dest_lng=NULL,purged_at=? WHERE id=?",
      at,
      row.id,
    );
    if (row.track_step_id)
      await ctx.cancelWebStep(row.track_step_id).catch(() => undefined);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Página de acompanhamento e WhatsApp

/** O que a página de acompanhamento mostra (só a entrega deste link). */
export async function trackView(
  ctx: ModuleContext,
  step: { ref_id: string | null; conversation_id: string },
): Promise<TrackView | null> {
  if (!step.ref_id) return null;
  const row = await one(
    ctx.env,
    "SELECT * FROM entrega_deliveries WHERE id=? AND profile_id=? AND conversation_id=?",
    step.ref_id,
    ctx.profile,
    step.conversation_id,
  );
  if (!row) return null;
  const cfg = await config(ctx);
  const at = now();
  const label = STATUS_LABELS[row.status as DeliveryStatus];
  if (row.status === "delivered")
    return {
      title: row.label,
      status_label: label,
      headline: `Entregue às ${hhmm(row.delivered_at)}.`,
      refresh_seconds: null,
    };
  if (row.status === "cancelled")
    return {
      title: row.label,
      status_label: label,
      headline: "A entrega foi interrompida. Fale com a gente pelo WhatsApp.",
      refresh_seconds: null,
    };
  if (row.status !== "en_route")
    return {
      title: row.label,
      status_label: "Preparando a saída",
      headline: "Assim que sair para a entrega, você acompanha por aqui.",
      refresh_seconds: 60,
    };
  const signal = signalOf(row, cfg, at);
  const v = values(row, at);
  const destination =
    row.dest_lat !== null ? { lat: row.dest_lat, lng: row.dest_lng } : null;
  return {
    title: row.label,
    status_label: label,
    headline: row.arriving_at
      ? fill(cfg.texts.arriving, v)
      : signal === "ok" && row.eta_at
        ? fill(cfg.texts.eta, v)
        : "A caminho.",
    notice:
      signal === "stale"
        ? `Sem sinal do entregador desde ${hhmm(row.last_at)}. A posição volta a aparecer quando o sinal voltar.`
        : signal === "none"
          ? "Aguardando a primeira posição do entregador."
          : null,
    lines: [
      row.courier_name ? `Entregador: ${row.courier_name}` : "",
      row.last_at ? `Posição de ${hhmm(row.last_at)}` : "",
    ],
    map: {
      courier:
        row.last_lat !== null ? { lat: row.last_lat, lng: row.last_lng } : null,
      destination,
    },
    refresh_seconds: 30,
  };
}

/** Menu "Onde está minha entrega": situação e link de cada entrega aberta. */
export async function whereIs(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  const cfg = await config(ctx);
  const rows = await openFor(ctx, c);
  if (!rows.length) {
    await ctx.sendMessage(
      c,
      {
        text: "Você não tem entregas em andamento agora. Envie MENU para ver as opções.",
      },
      { key: `onde:${rowId}` },
    );
    return;
  }
  const at = now();
  for (const row of rows.slice(0, 3)) {
    const text =
      row.status === "en_route"
        ? [
            `${row.label}: a caminho com ${row.courier_name || "o entregador"}.`,
            row.arriving_at
              ? fill(cfg.texts.arriving, values(row, at))
              : etaSentence(row, cfg, at),
          ]
            .filter(Boolean)
            .join(" ")
        : `${row.label}: ${STATUS_LABELS[row.status as DeliveryStatus].toLowerCase()}. Avisamos quando sair para a entrega.`;
    if (row.status === "en_route" && cfg.tracking_link)
      await openTrack(ctx, cfg, c, row, text, `onde:${rowId}:${row.id}`);
    else
      await ctx.sendMessage(c, { text }, { key: `onde:${rowId}:${row.id}` });
  }
}

/**
 * Localização enviada pelo cliente: vira o destino da entrega aberta da
 * conversa que ainda não tem destino. Com destino já marcado, não é nossa.
 */
export async function customerLocation(
  ctx: ModuleContext,
  c: Conversation,
  content: any,
  rowId: string,
) {
  const loc = content?.location;
  if (
    !loc ||
    typeof loc.latitude !== "number" ||
    typeof loc.longitude !== "number"
  )
    return false;
  const row = (await openFor(ctx, c)).find(
    (r) => r.dest_lat === null || r.dest_lat === undefined,
  );
  if (!row) return false;
  await exec(
    ctx.env,
    "UPDATE entrega_deliveries SET dest_lat=?,dest_lng=?,dest_source='customer',updated=? WHERE id=? AND dest_lat IS NULL",
    loc.latitude,
    loc.longitude,
    now(),
    row.id,
  );
  await exec(
    ctx.env,
    "INSERT INTO entrega_history(id,profile_id,delivery_id,status,actor,note,created) VALUES(?,?,?,'destination','customer','customer',?)",
    crypto.randomUUID(),
    ctx.profile,
    row.id,
    now(),
  );
  await ctx.sendMessage(
    c,
    {
      text: `Obrigado! Usamos a sua localização para calcular a chegada de ${row.label}.`,
    },
    { key: `location:${rowId}` },
  );
  return true;
}
