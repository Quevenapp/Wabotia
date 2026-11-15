// Check-in online da Reserva: um passo web (formulário do núcleo) com os
// campos escolhidos nas regras (documento, acompanhantes, horário previsto,
// perguntas a mais e aceite das regras da casa). Sai pelo gancho periódico
// antes da entrada, por ação da equipe ou a pedido do cliente (CHECKIN ou
// "Fazer check-in" em Minhas reservas). As respostas ficam na reserva.
//
// Janela de 24 horas: fora dela, numa linha oficial, o núcleo só envia o
// link quando o cliente acabou de escrever. Por isso o envio automático,
// com a janela fechada, manda pelo modelo de notificação um convite
// ("responda CHECKIN") e o link sai quando o cliente responde.
import { exec } from "../../db";
import { ApiError, type Conversation, now as clock } from "../../types";
import type { ModuleContext, WebStepRequest } from "../api";
import type { Answers } from "../../web-steps";
import { moment, shortDay, type ReservaConfig } from "./config";
import { getBooking, publish, type Booking } from "./bookings";

export function checkinSpec(
  config: ReservaConfig,
  b: Booking,
): WebStepRequest["spec"] {
  const f = config.checkin_fields;
  const fields: WebStepRequest["spec"]["fields"] = [];
  const document = () =>
    fields.push({
      id: "documento",
      type: "text",
      label: "Documento do responsável (CPF, RG ou passaporte)",
      required: true,
    });
  if (f.document) document();
  if (f.companions && b.guests > 1)
    fields.push({
      id: "acompanhantes",
      type: "text",
      multiline: true,
      label: `Nome dos acompanhantes (${b.guests - 1})`,
      help: "Um por linha.",
      required: false,
    });
  if (f.arrival_time)
    fields.push({
      id: "chegada",
      type: "text",
      label: "Horário previsto de chegada",
      help:
        b.mode === "daily"
          ? `A entrada é a partir das ${b.arrival_time}.`
          : `A reserva começa às ${b.arrival_time}.`,
      required: true,
    });
  config.checkin_questions.forEach((label, i) =>
    fields.push({
      id: `pergunta_${i + 1}`,
      type: "text",
      label,
      required: false,
    }),
  );
  if (f.rules && config.house_rules)
    fields.push({
      id: "regras",
      type: "accept",
      label: "Li e aceito as regras da casa",
      required: true,
    });
  if (!fields.length) document();
  const intro = [
    `${b.unit_name} · entrada ${moment(b.arrival_at)}, saída ${moment(b.departure_at)}.`,
    ...(f.rules && config.house_rules
      ? [`Regras da casa:\n${config.house_rules}`]
      : []),
  ].join("\n\n");
  return {
    title: `Check-in da reserva #${b.number}`,
    intro: Array.from(intro).slice(0, 1500).join(""),
    fields,
    submit_label: "Enviar check-in",
    done_text: "Check-in recebido. Até breve!",
    return_text: `Check-in da reserva #${b.number} recebido. Até ${shortDay(b.start_date)}!`,
    ticket: "none",
  };
}

/** O check-in ainda faz sentido para a reserva. */
export const checkinOpen = (config: ReservaConfig, b: Booking, at: number) =>
  config.checkin_enabled &&
  b.status === "confirmed" &&
  !!b.conversation_id &&
  b.checkin_status !== "completed" &&
  b.departure_at > at;

export const INVITE_WORDS = [
  "checkin",
  "check-in",
  "check in",
  "fazer check-in",
  "fazer checkin",
];

/**
 * Envia o link do check-in. `trigger: "module"` (automático) com a janela de
 * 24 horas fechada numa linha oficial manda o convite pelo modelo de
 * notificação; `agent` (equipe) recebe o erro do núcleo nesse caso.
 */
export async function sendCheckin(
  ctx: ModuleContext,
  config: ReservaConfig,
  b: Booking,
  options: {
    trigger: "module" | "agent" | "menu";
    actor: string;
    sourceKey: string;
    at?: number;
    conversation?: Conversation;
  },
): Promise<{
  status: "sent" | "invited";
  booking: Booking;
  url: string | null;
}> {
  const at = options.at ?? clock();
  if (!config.checkin_enabled)
    throw new ApiError(
      409,
      "checkin_disabled",
      "O check-in online está desligado nas regras da Reserva.",
    );
  if (b.status !== "confirmed")
    throw new ApiError(
      409,
      "booking_not_confirmed",
      "O check-in só é enviado para reservas confirmadas.",
    );
  if (b.checkin_status === "completed")
    throw new ApiError(
      409,
      "checkin_done",
      "O check-in desta reserva já foi feito.",
    );
  if (!b.conversation_id)
    throw new ApiError(
      409,
      "no_conversation",
      "Esta reserva não está ligada a uma conversa do WhatsApp.",
    );
  const c = options.conversation || (await ctx.conversation(b.conversation_id));
  const ttl = Math.min(
    7 * 24 * 60,
    Math.max(60, Math.round((b.departure_at - at) / 60000)),
  );
  // Com a janela de 24 h fechada o núcleo recusa o link com window_closed:
  // pelo gancho periódico, vira convite pelo modelo de notificação.
  let opened: Awaited<ReturnType<ModuleContext["openWebStep"]>> | null = null;
  try {
    opened = await ctx.openWebStep(c, {
      kind: "checkin",
      ref: b.id,
      trigger: options.trigger,
      actor: options.actor,
      sourceKey: options.sourceKey,
      ttlMinutes: ttl,
      text: `Faça o check-in online da reserva #${b.number} (${b.unit_name}, entrada ${moment(b.arrival_at)}):`,
      button: "Fazer check-in",
      spec: checkinSpec(config, b),
    });
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.code !== "window_closed" ||
      options.trigger !== "module"
    )
      throw error;
  }
  if (!opened) {
    await ctx.sendMessage(
      c,
      {
        text: `Sua reserva #${b.number} em ${b.unit_name} começa ${moment(b.arrival_at)}. Para fazer o check-in online e ganhar tempo na chegada, responda CHECKIN.`,
      },
      { key: `checkin-invite:${b.id}:${b.changes}`, notification: true },
    );
    await exec(
      ctx.env,
      "UPDATE reserva_bookings SET checkin_status='invited',checkin_sent_at=?,updated=? WHERE id=? AND profile_id=? AND checkin_status IN ('none','invited')",
      at,
      at,
      b.id,
      ctx.profile,
    );
    return {
      status: "invited",
      booking: await getBooking(ctx, b.id),
      url: null,
    };
  }
  await exec(
    ctx.env,
    "UPDATE reserva_bookings SET checkin_status='sent',checkin_step_id=?,checkin_sent_at=?,updated=? WHERE id=? AND profile_id=? AND checkin_status<>'completed'",
    opened.step.id,
    at,
    at,
    b.id,
    ctx.profile,
  );
  const after = await getBooking(ctx, b.id);
  if (opened.created)
    await publish(ctx, "reserva.checkin_sent", after, options.actor, {
      web_step_id: opened.step.id,
      trigger: options.trigger,
    });
  return { status: "sent", booking: after, url: opened.url };
}

/** Cliente concluiu o passo web do check-in (onWebStepCompleted). */
export async function completeCheckin(
  ctx: ModuleContext,
  bookingId: string,
  stepId: string,
  answers: Answers,
) {
  const at = clock();
  const done = await exec(
    ctx.env,
    "UPDATE reserva_bookings SET checkin_status='completed',checkin_step_id=?,checkin_at=?,checkin_answers=?,updated=? WHERE id=? AND profile_id=? AND checkin_status<>'completed'",
    stepId,
    at,
    JSON.stringify(answers),
    at,
    bookingId,
    ctx.profile,
  );
  if (!done.meta?.changes) return null;
  const b = await getBooking(ctx, bookingId);
  await publish(ctx, "reserva.checkin_completed", b, "customer", {
    web_step_id: stepId,
    answers,
  });
  return b;
}
