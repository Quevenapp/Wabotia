// Interface pública da Agenda para a Ordem de Serviço (OS4: agendar a
// execução da ordem). Como a fachada da Mensalidade, cada função age como o
// módulo "agenda": a reserva, a remarcação e o cancelamento são os mesmos de
// sempre (book/move/cancel), com os eventos agenda.* e os avisos ao cliente
// (confirmação pelo texto de agendamento e lembrete pela rodada da Agenda).
// Nenhum comportamento da Agenda muda; o dependente confere agendaAvailable.
import type { Conversation, Env } from "../../types";
import { modulesApi } from "../api";
import { agendaConfig, brasiliaDate, addDays } from "./config";
import { availability } from "./availability";
import { listProfessionals, listServices } from "./catalog";
import { book, cancel, getAppointment, move, type Appointment } from "./appointments";

const ctxOf = (env: Env, profile: string) => modulesApi(env, profile, "agenda");
const configOf = async (env: Env, profile: string) => agendaConfig((await ctxOf(env, profile).settings())?.agenda);

/** Agenda ligada na área. */
export const agendaAvailable = (env: Env, profile: string) => ctxOf(env, profile).enabled();

/** Serviços e profissionais ativos, para escolher ao agendar a ordem. */
export async function agendaCatalog(env: Env, profile: string) {
  const ctx = ctxOf(env, profile);
  const [services, professionals] = await Promise.all([listServices(ctx, true), listProfessionals(ctx, true)]);
  return {
    services: services.map(s => ({ id: s.id, name: s.name, duration_minutes: s.duration_minutes })),
    professionals: professionals.map(p => ({ id: p.id, name: p.name, user_id: p.user_id, service_ids: p.service_ids })),
  };
}

/**
 * Horários livres de um serviço (e profissional, opcional) entre duas datas
 * AAAA-MM-DD, até 14 dias, pela regra da equipe (sem antecedência mínima,
 * nunca no passado). `ignore`: agendamento sendo remarcado.
 */
export async function agendaSlots(env: Env, profile: string, query: { service_id: string; professional_id?: string | null; from: string; days?: number; now: number; ignore?: string }) {
  const ctx = ctxOf(env, profile);
  const count = Math.min(Math.max(query.days ?? 7, 1), 14);
  const dates = Array.from({ length: count }, (_, i) => addDays(query.from, i));
  const result = await availability(ctx, await configOf(env, profile), {
    serviceId: query.service_id, professionalId: query.professional_id || null, dates,
    now: query.now, rules: { staff: true }, ignore: query.ignore,
  });
  return { service: result.service, days: result.days };
}

/** Data de hoje em Brasília (AAAA-MM-DD), como a Agenda calcula. */
export const agendaToday = (at: number) => brasiliaDate(at);

export interface OrderBooking {
  id: string;
  service_id: string;
  professional_id?: string | null;
  starts: number;
  conversation?: Conversation | null;
  customer_name?: string;
  customer_phone?: string;
  notes?: string;
  actor: string;
}

/** Reserva pela Agenda (o mesmo id não reserva duas vezes). Avisa o cliente da conversa. */
export async function bookForOrder(env: Env, profile: string, input: OrderBooking): Promise<Appointment> {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  const { appointment } = await book(ctx, await configOf(env, profile), {
    id: input.id, service_id: input.service_id, professional_id: input.professional_id || null, starts: input.starts,
    conversation: input.conversation ?? null, customer_name: input.customer_name, customer_phone: input.customer_phone,
    notes: input.notes, source: "panel", actor: input.actor, rules: { staff: true },
  });
  return appointment;
}

/** Remarca pela Agenda (mesma regra de conflito e aviso de remarcação). */
export async function moveForOrder(env: Env, profile: string, input: { id: string; starts: number; professional_id?: string | null; actor: string }) {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  return move(ctx, await configOf(env, profile), { ...input, rules: { staff: true } });
}

/** Cancela pela Agenda (o cliente recebe o texto de cancelamento da Agenda). */
export async function cancelForOrder(env: Env, profile: string, input: { id: string; actor: string; reason?: string; notify?: boolean }) {
  const ctx = ctxOf(env, profile);
  return cancel(ctx, await configOf(env, profile), input);
}

/** Agendamento atual (reflete o que mudou pelo lado da Agenda); null se não existe. */
export async function appointmentForOrder(env: Env, profile: string, id: string): Promise<Appointment | null> {
  try { return await getAppointment(ctxOf(env, profile), id); }
  catch { return null; }
}
