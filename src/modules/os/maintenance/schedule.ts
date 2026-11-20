// OS4: agendar a execução da ordem (docs/ORDEM-DE-SERVICO.md, "Agendar a
// execução"). Com a Agenda ligada, a ordem reserva pelos horários livres da
// Agenda (src/modules/agenda/public.ts): a confirmação e o lembrete ao
// cliente são os da própria Agenda, e o horário mostrado é sempre o do
// agendamento (mexer pela Agenda reflete aqui). Sem a Agenda, a ordem guarda
// só a data e a hora combinadas, sem conflito de horário; a confirmação e o
// lembrete saem pela conversa da ordem, como os outros avisos da ordem.
import { all, batch, one } from "../../../db";
import { ApiError, type Actor, now, uid } from "../../../types";
import type { ModuleContext } from "../../api";
import {
  agendaAvailable,
  agendaCatalog,
  agendaSlots,
  agendaToday,
  appointmentForOrder,
  bookForOrder,
  cancelForOrder,
  moveForOrder,
} from "../../agenda/public";
import { authorizedOrder } from "../public";
import { conversationOf, loadOrder } from "../store";
import { STATUS_LABELS, type OsStatus } from "../model";
import { workOrderAdditions } from "../work-types";
import { SCHEDULED_AT_SQL, civilDate, requireInstant, whenText } from "./model";

type Row = Record<string, any>;
const ACTIVE = ["booked", "confirmed"];
const APPOINTMENT_LABELS: Record<string, string> = { booked: "Agendado", confirmed: "Confirmado pelo cliente", cancelled: "Cancelado", no_show: "Cliente não compareceu" };
const NO_WHATSAPP = "Esta ordem não está ligada a uma conversa do WhatsApp: a confirmação e o lembrete não serão enviados ao cliente.";
const AGENDA_OFF = "Para agendar pelos horários livres, ligue o módulo Agenda em Gestão → Módulos. Sem a Agenda, informe a data e a hora combinadas.";
/** Lembrete da data combinada (sem Agenda): horas antes da execução. */
export const MANUAL_REMINDER_HOURS = 24;


function displayOf(order: Row) {
  if (order.type_id === "service_order") return `nº ${order.number}`;
  try { return workOrderAdditions(order as any).display_number || `nº ${order.number}`; } catch { return `nº ${order.number}`; }
}

async function scheduleRow(ctx: ModuleContext, orderId: string) {
  return one(ctx.env, "SELECT * FROM os_order_schedules WHERE profile_id=? AND order_id=?", ctx.profile, orderId);
}

/** Leitura da execução marcada, com o agendamento atual da Agenda. */
export async function scheduleView(ctx: ModuleContext, order: Row) {
  const [row, agenda, c] = await Promise.all([scheduleRow(ctx, order.id), agendaAvailable(ctx.env, ctx.profile), conversationOf(ctx, order)]);
  const whatsapp = c && c.chat_type !== "group" ? { ready: true, reason: null } : { ready: false, reason: NO_WHATSAPP };
  const base = { order_id: order.id, agenda: { enabled: agenda, message: agenda ? null : AGENDA_OFF }, whatsapp };
  if (!row) return { ...base, schedule: null };
  let state: "active" | "cancelled" = row.state, starts = row.starts as number, ends = row.ends as number | null;
  let appointment: Row | null = null, changedByAgenda = false, service = row.service_id ? { id: row.service_id, name: "" } : null, professional = row.professional_id ? { id: row.professional_id, name: "" } : null;
  if (row.mode === "agenda" && row.appointment_id) {
    const a = await appointmentForOrder(ctx.env, ctx.profile, row.appointment_id);
    if (a) {
      appointment = { id: a.id, status: a.status, status_label: APPOINTMENT_LABELS[a.status] ?? a.status, confirmed_at: a.confirmed_at };
      service = { id: a.service_id, name: a.service_name };
      professional = { id: a.professional_id, name: a.professional_name };
      changedByAgenda = state === "active" && (a.starts !== row.starts || !ACTIVE.includes(a.status));
      starts = a.starts; ends = a.ends;
      if (!ACTIVE.includes(a.status)) state = "cancelled";
    }
  }
  return {
    ...base,
    schedule: {
      mode: row.mode as "agenda" | "manual", state, starts, ends, when_text: whenText(starts),
      service, professional, appointment, note: row.note ?? "",
      changed_by_agenda: changedByAgenda,
      agenda_off: row.mode === "agenda" && !agenda,
      updated: row.updated,
    },
  };
}

export async function getSchedule(ctx: ModuleContext, actor: Actor, orderId: string) {
  const { row } = await authorizedOrder(ctx, actor, orderId);
  return scheduleView(ctx, row);
}

/** GET service-orders/schedule-options: Agenda ligada, serviços e profissionais. */
export async function scheduleOptions(ctx: ModuleContext, actor: Actor) {
  ctx.access(actor, "conversations:read");
  await ctx.requireEnabled();
  const enabled = await agendaAvailable(ctx.env, ctx.profile);
  return { agenda: { enabled, message: enabled ? null : AGENDA_OFF }, ...(enabled ? await agendaCatalog(ctx.env, ctx.profile) : { services: [], professionals: [] }) };
}

/** GET service-orders/schedule-slots: horários livres da Agenda (serviço, profissional, a partir de uma data). */
export async function scheduleSlots(ctx: ModuleContext, actor: Actor, query: Record<string, string>) {
  ctx.access(actor, "conversations:read");
  await ctx.requireEnabled();
  if (!(await agendaAvailable(ctx.env, ctx.profile))) throw new ApiError(409, "module_disabled", AGENDA_OFF);
  if (!query.service_id) throw new ApiError(400, "invalid_request", "Escolha o serviço da Agenda.");
  const at = now();
  const from = query.from && civilDate(query.from) ? query.from : agendaToday(at);
  let ignore: string | undefined;
  if (query.order_id) {
    const row = await scheduleRow(ctx, query.order_id);
    if (row?.mode === "agenda" && row.appointment_id) ignore = row.appointment_id;
  }
  return agendaSlots(ctx.env, ctx.profile, { service_id: query.service_id, professional_id: query.professional_id || null, from, days: Number(query.days) || 7, now: at, ignore });
}

function historyStatement(ctx: ModuleContext, order: Row, actor: string, note: string, at: number): [string, unknown[]] {
  return ["INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) VALUES(?,?,?,'schedule',?,?,?,?,?)",
    [uid(), ctx.profile, order.id, order.status, order.status, actor, note.slice(0, 500), at]];
}

/** Mensagem pela conversa da ordem, como os outros avisos da ordem (fora da janela, modelo de notificação). */
async function orderNotice(ctx: ModuleContext, order: Row, text: string, key: string) {
  const c = await conversationOf(ctx, order);
  if (!c || c.chat_type === "group") return false;
  const sent = await ctx.sendMessage(c, { text }, { key, notification: true });
  return sent !== null;
}

/**
 * PUT service-orders/:id/schedule: agenda ou reagenda. mode="agenda" reserva
 * (ou remarca) pela Agenda; mode="manual" guarda a data combinada.
 */
export async function setSchedule(ctx: ModuleContext, actor: Actor, orderId: string, input: Row, requestId: string) {
  const { row: order } = await authorizedOrder(ctx, actor, orderId, { write: true });
  if (["delivered", "cancelled"].includes(order.status)) throw new ApiError(409, "order_closed", "Ordem encerrada não pode ser agendada.");
  const mode = input.mode === "manual" ? "manual" : input.mode === "agenda" ? "agenda" : null;
  if (!mode) throw new ApiError(400, "invalid_request", "Informe mode: agenda (horários livres da Agenda) ou manual (data e hora combinadas).");
  const starts = requireInstant(input.starts, "Início da execução");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  const current = await scheduleRow(ctx, orderId);
  const at = now(), warnings: string[] = [];
  const notify = await ctx.mayNotify(actor, order.conversation_id ?? null);
  const conversation = notify ? await conversationOf(ctx, order) : null;
  if (!conversation) warnings.push(notify ? NO_WHATSAPP : "Você não atende a conversa desta ordem: o cliente não foi avisado.");
  let values: Row;
  if (mode === "agenda") {
    if (!(await agendaAvailable(ctx.env, ctx.profile))) throw new ApiError(409, "module_disabled", AGENDA_OFF);
    if (typeof input.service_id !== "string" || !input.service_id) throw new ApiError(400, "invalid_request", "Escolha o serviço da Agenda.");
    const professional = typeof input.professional_id === "string" && input.professional_id ? input.professional_id : null;
    const previous = current?.mode === "agenda" && current.appointment_id && current.state === "active" ? await appointmentForOrder(ctx.env, ctx.profile, current.appointment_id) : null;
    let appointment;
    if (previous && ACTIVE.includes(previous.status) && previous.service_id === input.service_id) {
      appointment = previous.starts === starts && (!professional || professional === previous.professional_id) ? previous
        : await moveForOrder(ctx.env, ctx.profile, { id: previous.id, starts, professional_id: professional ?? previous.professional_id, actor: actor.id });
    } else {
      if (previous && ACTIVE.includes(previous.status))
        await cancelForOrder(ctx.env, ctx.profile, { id: previous.id, actor: actor.id, reason: "Reagendado pela ordem de serviço", notify: false });
      appointment = await bookForOrder(ctx.env, ctx.profile, {
        id: await stableId(`os-schedule:${ctx.profile}:${orderId}:${actor.id}:${requestId}`), service_id: input.service_id, professional_id: professional, starts,
        conversation, customer_name: String(order.customer_name || "") || undefined, customer_phone: String(order.phone || "") || undefined,
        notes: `Ordem de serviço ${displayOf(order)}: ${order.item}`.slice(0, 1000), actor: actor.id,
      });
    }
    values = { mode, appointment_id: appointment.id, service_id: appointment.service_id, professional_id: appointment.professional_id, starts: appointment.starts, ends: appointment.ends };
  } else {
    const ends = input.ends === undefined || input.ends === null ? null : requireInstant(input.ends, "Fim da execução");
    if (ends !== null && ends <= starts) throw new ApiError(400, "invalid_request", "O fim precisa ser depois do início.");
    if (current?.mode === "agenda" && current.appointment_id && current.state === "active") {
      const previous = await appointmentForOrder(ctx.env, ctx.profile, current.appointment_id);
      if (previous && ACTIVE.includes(previous.status)) {
        if (!(await agendaAvailable(ctx.env, ctx.profile))) throw new ApiError(409, "module_disabled", "Esta ordem tem um agendamento na Agenda. Ligue o módulo Agenda para cancelá-lo antes de combinar outra data.");
        await cancelForOrder(ctx.env, ctx.profile, { id: previous.id, actor: actor.id, reason: "Data combinada pela ordem de serviço", notify: false });
      }
    }
    values = { mode, appointment_id: null, service_id: null, professional_id: null, starts, ends };
  }
  const label = `${current?.state === "active" ? "Reagendado" : "Agendado"} para ${whenText(values.starts)}${mode === "agenda" ? " pela Agenda" : " (data combinada)"}${note ? ` · ${note}` : ""}`;
  await batch(ctx.env, [
    [`INSERT INTO os_order_schedules(profile_id,order_id,mode,appointment_id,service_id,professional_id,starts,ends,state,note,notified_at,reminded_at,created_by,created,updated)
      VALUES(?,?,?,?,?,?,?,?,'active',?,NULL,NULL,?,?,?)
      ON CONFLICT(profile_id,order_id) DO UPDATE SET mode=excluded.mode,appointment_id=excluded.appointment_id,service_id=excluded.service_id,professional_id=excluded.professional_id,
        starts=excluded.starts,ends=excluded.ends,state='active',note=excluded.note,notified_at=NULL,reminded_at=NULL,updated=excluded.updated`,
      [ctx.profile, orderId, values.mode, values.appointment_id, values.service_id, values.professional_id, values.starts, values.ends, note, actor.id, at, at]],
    historyStatement(ctx, order, actor.id, label, at),
  ]);
  // Sem a Agenda, a confirmação sai pela conversa da ordem (com a Agenda, a própria Agenda avisa).
  if (mode === "manual" && conversation) {
    const sent = await orderNotice(ctx, order, `Ordem de serviço ${displayOf(order)} (${order.item}): execução combinada para ${whenText(values.starts)}.`, `os-schedule:${orderId}:${values.starts}`);
    if (sent) await batch(ctx.env, [["UPDATE os_order_schedules SET notified_at=? WHERE profile_id=? AND order_id=? AND starts=?", [now(), ctx.profile, orderId, values.starts]]]);
  }
  await ctx.publish("os.scheduled", orderId, { order_id: orderId, mode, starts: values.starts, appointment_id: values.appointment_id }, { key: `schedule:${orderId}:${values.starts}:${at}` });
  return { ...(await scheduleView(ctx, await loadOrder(ctx, orderId))), warnings };
}

/** Id estável (formato UUID) para a reserva: repetir o pedido não reserva duas vezes. */
async function stableId(seed: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  const hex = [...digest.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** POST service-orders/:id/schedule/cancel: cancela a execução marcada (e o agendamento na Agenda). */
export async function cancelSchedule(ctx: ModuleContext, actor: Actor, orderId: string, input: Row) {
  const { row: order } = await authorizedOrder(ctx, actor, orderId, { write: true });
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (Array.from(reason).length > 300) throw new ApiError(400, "invalid_request", "Motivo: até 300 caracteres.");
  const current = await scheduleRow(ctx, orderId);
  if (!current || current.state !== "active") return { ...(await scheduleView(ctx, order)), warnings: [] };
  const notify = await ctx.mayNotify(actor, order.conversation_id ?? null);
  const warnings: string[] = [];
  if (current.mode === "agenda" && current.appointment_id) {
    const a = await appointmentForOrder(ctx.env, ctx.profile, current.appointment_id);
    if (a && ACTIVE.includes(a.status)) {
      if (!(await agendaAvailable(ctx.env, ctx.profile))) throw new ApiError(409, "module_disabled", "Ligue o módulo Agenda para cancelar o agendamento desta ordem.");
      await cancelForOrder(ctx.env, ctx.profile, { id: a.id, actor: actor.id, reason: reason || "Cancelado pela ordem de serviço", notify });
    }
  }
  const at = now();
  await batch(ctx.env, [
    ["UPDATE os_order_schedules SET state='cancelled',updated=? WHERE profile_id=? AND order_id=?", [at, ctx.profile, orderId]],
    historyStatement(ctx, order, actor.id, `Agendamento de ${whenText(current.starts)} cancelado${reason ? `: ${reason}` : ""}`, at),
  ]);
  if (current.mode === "manual" && notify) {
    const sent = await orderNotice(ctx, order, `Ordem de serviço ${displayOf(order)} (${order.item}): o horário combinado para ${whenText(current.starts)} foi cancelado. Vamos combinar outro com você.`, `os-schedule-cancel:${orderId}:${current.starts}`);
    if (!sent) warnings.push(NO_WHATSAPP);
  }
  await ctx.publish("os.scheduled", orderId, { order_id: orderId, mode: current.mode, starts: null, appointment_id: current.appointment_id }, { key: `schedule-cancel:${orderId}:${at}` });
  return { ...(await scheduleView(ctx, await loadOrder(ctx, orderId))), warnings };
}

/** Ordem cancelada: o agendamento da Agenda é cancelado junto (sem novo aviso além do da Agenda). */
export async function orderCancelled(ctx: ModuleContext, orderId: string, actor = "system") {
  const current = await scheduleRow(ctx, orderId);
  if (!current || current.state !== "active") return;
  if (current.mode === "agenda" && current.appointment_id && await agendaAvailable(ctx.env, ctx.profile)) {
    const a = await appointmentForOrder(ctx.env, ctx.profile, current.appointment_id);
    if (a && ACTIVE.includes(a.status)) await cancelForOrder(ctx.env, ctx.profile, { id: a.id, actor, reason: "Ordem de serviço cancelada" });
  }
  await batch(ctx.env, [["UPDATE os_order_schedules SET state='cancelled',updated=? WHERE profile_id=? AND order_id=? AND state='active'", [now(), ctx.profile, orderId]]]);
}

/** Rodada periódica: lembrete da data combinada e agendamentos de ordens canceladas. */
export async function runScheduleDue(ctx: ModuleContext, at: number) {
  const cancelled = await all(ctx.env, `SELECT s.order_id FROM os_order_schedules s JOIN os_orders o ON o.profile_id=s.profile_id AND o.id=s.order_id
    WHERE s.profile_id=? AND s.state='active' AND o.status='cancelled' LIMIT 20`, ctx.profile);
  for (const row of cancelled) await orderCancelled(ctx, row.order_id);
  const window = MANUAL_REMINDER_HOURS * 3_600_000;
  const due = await all(ctx.env, `SELECT s.* FROM os_order_schedules s JOIN os_orders o ON o.profile_id=s.profile_id AND o.id=s.order_id
    WHERE s.profile_id=? AND s.mode='manual' AND s.state='active' AND s.reminded_at IS NULL AND s.starts>? AND s.starts<=? AND s.updated<=s.starts-?
      AND o.status NOT IN ('delivered','cancelled') AND o.conversation_id IS NOT NULL ORDER BY s.starts LIMIT 50`, ctx.profile, at, at + window, window);
  for (const row of due) {
    const order = await loadOrder(ctx, row.order_id);
    // Marca antes de enviar: no máximo um lembrete por data combinada.
    const claimed = await batch(ctx.env, [["UPDATE os_order_schedules SET reminded_at=? WHERE profile_id=? AND order_id=? AND reminded_at IS NULL AND starts=?", [at, ctx.profile, row.order_id, row.starts]]]);
    if (!claimed[0]?.meta?.changes) continue;
    try {
      await orderNotice(ctx, order, `Lembrete: ordem de serviço ${displayOf(order)} (${order.item}) com execução combinada para ${whenText(row.starts)}.`, `os-schedule-reminder:${row.order_id}:${row.starts}`);
    } catch (error) {
      console.warn("os4: lembrete da data combinada falhou", row.order_id, error);
    }
  }
}

/** GET service-orders/my-schedule: execuções agendadas das ordens da pessoa ("Meus prazos"). */
export async function mySchedule(ctx: ModuleContext, actor: Actor, query: Record<string, string>) {
  ctx.access(actor, "conversations:read");
  await ctx.requireEnabled();
  if (actor.kind !== "user" || actor.via || actor.module || actor.credential || actor.id.startsWith("bot:"))
    throw new ApiError(403, "forbidden", "Meus prazos é da pessoa autenticada.");
  const at = now();
  const from = query.from && Number.isSafeInteger(Number(query.from)) ? Number(query.from) : at - 86_400_000;
  const to = query.to && Number.isSafeInteger(Number(query.to)) ? Number(query.to) : at + 30 * 86_400_000;
  if (from > to) throw new ApiError(400, "invalid_filter", "Intervalo inválido.");
  const rows = await all(ctx.env, `SELECT * FROM (SELECT o.*,s.mode schedule_mode,${SCHEDULED_AT_SQL} scheduled_at FROM os_order_schedules s
      JOIN os_orders o ON o.profile_id=s.profile_id AND o.id=s.order_id
      WHERE s.profile_id=? AND s.state='active' AND o.status NOT IN ('delivered','cancelled')
        AND (o.assignee=? OR (s.mode='agenda' AND EXISTS(SELECT 1 FROM agenda_professionals p WHERE p.profile_id=s.profile_id AND p.id=s.professional_id AND p.user_id=?))))
    WHERE scheduled_at IS NOT NULL AND scheduled_at>=? AND scheduled_at<=? ORDER BY scheduled_at LIMIT 100`, ctx.profile, actor.id, actor.id, from, to);
  return {
    data: rows.map(row => ({
      id: row.id, type_id: row.type_id, display_number: displayOf(row), item: row.item, customer_name: row.customer_name,
      status: row.status, status_label: STATUS_LABELS[row.status as OsStatus] ?? row.status,
      scheduled_at: row.scheduled_at, when_text: whenText(row.scheduled_at), mode: row.schedule_mode, overdue: row.scheduled_at < at,
    })),
  };
}
