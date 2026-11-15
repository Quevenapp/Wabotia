// Horários livres da Agenda. `freeSlots` é puro (sem banco): recebe os
// cadastros, os agendamentos ativos e os bloqueios do dia e devolve os inícios
// possíveis no horário de Brasília. `availability` carrega o banco e chama.
import { all } from "../../db";
import { businessHours } from "../../business-time";
import type { ModuleContext } from "../api";
import {
  addDays,
  brasiliaDate,
  dayStart,
  DAY_MS,
  MINUTE_MS,
  type AgendaConfig,
  weekday,
} from "./config";
import {
  listProfessionals,
  listServices,
  type Block,
  type Professional,
  type Service,
} from "./catalog";

export const ACTIVE_STATUSES = ["booked", "confirmed"];

export interface Busy {
  id?: string;
  professional_id: string;
  starts: number;
  ends: number;
}
export interface Slot {
  starts: number;
  ends: number;
  /** Profissionais livres nesse início, na ordem do cadastro. */
  professional_ids: string[];
}
export interface SlotRules {
  /** Equipe ignora antecedência mínima e máxima. */
  staff?: boolean;
}

export interface FreeSlotsInput {
  date: string;
  service: Service;
  professionals: Professional[];
  busy: Busy[];
  blocks: Block[];
  config: AgendaConfig;
  holidays: string[];
  now: number;
  /** Só este profissional; sem ele, qualquer um que atenda o serviço. */
  professionalId?: string | null;
  rules?: SlotRules;
}

const overlaps = (a: { starts: number; ends: number }, s: number, e: number) =>
  a.starts < e && a.ends > s;

/** Profissionais ativos que atendem o serviço (todos, ou só o escolhido). */
export function eligible(
  service: Service,
  professionals: Professional[],
  professionalId?: string | null,
) {
  return professionals.filter(
    (p) =>
      p.active &&
      p.service_ids.includes(service.id) &&
      (!professionalId || p.id === professionalId),
  );
}

export function freeSlots(input: FreeSlotsInput): Slot[] {
  const { date, service, config, now } = input;
  if (!service.active) return [];
  const staff = !!input.rules?.staff;
  // A equipe ignora a antecedência mínima, mas horário que já passou não é
  // livre: só entra como encaixe (force), que não passa por aqui.
  const earliest = staff ? now : now + config.min_notice_minutes * MINUTE_MS;
  const latest = staff ? Infinity : now + config.max_days_ahead * DAY_MS;
  if (config.close_on_holidays && input.holidays.includes(date)) return [];
  const base = dayStart(date),
    day = weekday(date),
    duration = service.duration_minutes * MINUTE_MS,
    step = config.slot_step_minutes;
  const slots = new Map<number, Slot>();
  for (const professional of eligible(
    service,
    input.professionals,
    input.professionalId,
  )) {
    const busy = [
      ...input.busy.filter((b) => b.professional_id === professional.id),
      ...input.blocks.filter(
        (b) => !b.professional_id || b.professional_id === professional.id,
      ),
    ];
    for (const interval of professional.hours.filter(
      (h) => h.weekday === day,
    )) {
      const [sh, sm] = interval.start.split(":").map(Number),
        [eh, em] = interval.end.split(":").map(Number);
      const open = sh * 60 + sm,
        close = eh * 60 + em;
      for (
        let minute = open;
        minute + service.duration_minutes <= close;
        minute += step
      ) {
        const starts = base + minute * MINUTE_MS,
          ends = starts + duration;
        if (starts < earliest || starts > latest) continue;
        if (busy.some((b) => overlaps(b, starts, ends))) continue;
        const slot = slots.get(starts) || {
          starts,
          ends,
          professional_ids: [],
        };
        slot.professional_ids.push(professional.id);
        slots.set(starts, slot);
      }
    }
  }
  return [...slots.values()].sort((a, b) => a.starts - b.starts);
}

/** Bloqueios e agendamentos ativos que tocam o intervalo. */
export async function busyBetween(
  ctx: ModuleContext,
  from: number,
  to: number,
  ignore?: string,
) {
  const [busy, blocks] = await Promise.all([
    all<Busy>(
      ctx.env,
      `SELECT id,professional_id,starts,ends FROM agenda_appointments WHERE profile_id=? AND status IN ('booked','confirmed') AND starts<? AND ends>?${ignore ? " AND id<>?" : ""}`,
      ctx.profile,
      to,
      from,
      ...(ignore ? [ignore] : []),
    ),
    all(
      ctx.env,
      "SELECT * FROM agenda_blocks WHERE profile_id=? AND starts<? AND ends>?",
      ctx.profile,
      to,
      from,
    ),
  ]);
  return {
    busy,
    blocks: blocks.map((b) => ({
      ...b,
      professional_id: b.professional_id || null,
    })) as Block[],
  };
}

export interface AvailabilityQuery {
  serviceId: string;
  professionalId?: string | null;
  /** Dias AAAA-MM-DD a consultar. */
  dates: string[];
  now: number;
  rules?: SlotRules;
  /** Agendamento sendo remarcado: não conta como ocupado. */
  ignore?: string;
}

/** Horários livres por dia, carregando cadastros, ocupação e configuração. */
export async function availability(
  ctx: ModuleContext,
  config: AgendaConfig,
  query: AvailabilityQuery,
) {
  const [services, professionals, settings] = await Promise.all([
    listServices(ctx),
    listProfessionals(ctx),
    ctx.settings(),
  ]);
  const service = services.find((s) => s.id === query.serviceId) || null;
  if (!service || !query.dates.length)
    return {
      service,
      professionals,
      days: [] as { date: string; slots: Slot[] }[],
    };
  const dates = [...query.dates].sort();
  const { busy, blocks } = await busyBetween(
    ctx,
    dayStart(dates[0]),
    dayStart(addDays(dates.at(-1)!, 1)),
    query.ignore,
  );
  const holidays = businessHours(settings?.business_hours).holidays;
  return {
    service,
    professionals,
    days: dates.map((date) => ({
      date,
      slots: freeSlots({
        date,
        service,
        professionals,
        busy,
        blocks,
        config,
        holidays,
        now: query.now,
        professionalId: query.professionalId,
        rules: query.rules,
      }),
    })),
  };
}

/** Dias consultáveis pelo cliente, de hoje até a antecedência máxima. */
export function bookableDates(config: AgendaConfig, now: number) {
  const first = brasiliaDate(now + config.min_notice_minutes * MINUTE_MS);
  const last = brasiliaDate(now + config.max_days_ahead * DAY_MS);
  const dates: string[] = [];
  for (let d = first; d <= last && dates.length < 366; d = addDays(d, 1))
    dates.push(d);
  return dates;
}
