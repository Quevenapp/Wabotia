// Disponibilidade da Reserva, no horário de Brasília. O período de uma
// reserva vira um intervalo de ocupação [starts, ends):
// - por diária: da meia-noite do dia de entrada à meia-noite do dia de saída
//   (a saída de um hóspede e a entrada do próximo no mesmo dia não colidem);
// - por hora: do início ao fim.
// As regras (antecedência, estadia mínima, horário) são funções puras; a
// sobreposição com reservas e bloqueios lê o banco, e a gravação confere de
// novo na própria instrução (bookings.ts).
import { all } from "../../db";
import { ApiError, requireValue } from "../../types";
import type { ModuleContext } from "../api";
import {
  addDays,
  atClock,
  brasiliaDate,
  daysBetween,
  dayStart,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  minuteOf,
  validDate,
  type ReservaConfig,
} from "./config";
import type { Unit } from "./units";

/** Estados que ocupam a unidade (o sinal pendente segura até o prazo). */
export const ACTIVE = ["pending_payment", "confirmed"];
export const ACTIVE_SQL = "('pending_payment','confirmed')";

export interface Period {
  mode: "daily" | "hourly";
  /** Dia de entrada e dia de saída (por hora: o mesmo dia). */
  start_date: string;
  end_date: string;
  starts: number;
  ends: number;
  arrival_at: number;
  departure_at: number;
  nights: number | null;
  duration_minutes: number | null;
  price_cents: number;
}

export interface PeriodInput {
  start_date?: unknown;
  end_date?: unknown;
  nights?: unknown;
  starts?: unknown;
  duration_minutes?: unknown;
}

/** Diárias de start_date a end_date (dia de saída). */
export function dailyPeriod(
  config: ReservaConfig,
  unit: Unit,
  start: string,
  end: string,
): Period {
  const nights = daysBetween(start, end);
  return {
    mode: "daily",
    start_date: start,
    end_date: end,
    starts: dayStart(start),
    ends: dayStart(end),
    arrival_at: atClock(start, config.checkin_time),
    departure_at: atClock(end, config.checkout_time),
    nights,
    duration_minutes: null,
    price_cents: unit.price_cents * nights,
  };
}

/** Uso por hora: início e duração em minutos. */
export function hourlyPeriod(
  unit: Unit,
  starts: number,
  duration: number,
): Period {
  const ends = starts + duration * MINUTE_MS;
  return {
    mode: "hourly",
    start_date: brasiliaDate(starts),
    end_date: brasiliaDate(ends - 1),
    starts,
    ends,
    arrival_at: starts,
    departure_at: ends,
    nights: null,
    duration_minutes: duration,
    price_cents: Math.round((unit.price_cents * duration) / 60),
  };
}

/** Período pedido (corpo da API ou do chat), conforme o modo da unidade. */
export function periodOf(
  config: ReservaConfig,
  unit: Unit,
  input: PeriodInput,
): Period {
  if (unit.mode === "daily") {
    requireValue(
      validDate(input.start_date),
      "Informe start_date (dia de entrada) no formato AAAA-MM-DD.",
    );
    let end = input.end_date;
    if (end === undefined && input.nights !== undefined) {
      requireValue(
        Number.isInteger(input.nights) && (input.nights as number) >= 1,
        "nights: número inteiro de diárias.",
      );
      end = addDays(input.start_date, input.nights as number);
    }
    requireValue(
      validDate(end) && end > input.start_date,
      "Informe end_date (dia de saída), depois do dia de entrada.",
    );
    requireValue(
      daysBetween(input.start_date, end) <= 365,
      "Reserve até 365 diárias por vez.",
    );
    return dailyPeriod(config, unit, input.start_date, end);
  }
  requireValue(
    Number.isInteger(input.starts) &&
      (input.starts as number) > 0 &&
      (input.starts as number) % MINUTE_MS === 0,
    "Informe starts (início) em milissegundos, num minuto exato.",
  );
  requireValue(
    Number.isInteger(input.duration_minutes) &&
      (input.duration_minutes as number) >= 15 &&
      (input.duration_minutes as number) <= 24 * 60 &&
      (input.duration_minutes as number) % 15 === 0,
    "Informe duration_minutes de 15 a 1440, em múltiplos de 15.",
  );
  return hourlyPeriod(
    unit,
    input.starts as number,
    input.duration_minutes as number,
  );
}

export type Refusal =
  | "inactive"
  | "past"
  | "notice"
  | "ahead"
  | "min_stay"
  | "max_stay"
  | "hours"
  | "step"
  | "capacity"
  | "booked"
  | "blocked";

export function refusalMessage(
  refusal: Refusal,
  config: ReservaConfig,
  unit: Unit,
) {
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  switch (refusal) {
    case "inactive":
      return "Esta unidade não está disponível para reserva.";
    case "past":
      return "Esse período já começou ou já passou.";
    case "notice":
      return `As reservas precisam de pelo menos ${plural(config.min_notice_hours, "hora", "horas")} de antecedência.`;
    case "ahead":
      return `As reservas abrem com até ${plural(config.max_days_ahead, "dia", "dias")} de antecedência.`;
    case "min_stay":
      return unit.mode === "daily"
        ? `A estadia mínima é de ${plural(config.min_nights, "diária", "diárias")}.`
        : `O tempo mínimo é de ${plural(config.min_hours, "hora", "horas")}.`;
    case "max_stay":
      return unit.mode === "daily"
        ? `Pelo WhatsApp, a estadia máxima é de ${plural(config.max_nights, "diária", "diárias")}. Fale com a equipe para estadias maiores.`
        : `O tempo máximo é de ${plural(config.max_hours, "hora", "horas")}.`;
    case "hours":
      return `${unit.name} funciona das ${config.hourly_open} às ${config.hourly_close}.`;
    case "step":
      return `Os horários começam a cada ${config.hourly_step_minutes} minutos a partir das ${config.hourly_open}.`;
    case "capacity":
      return `${unit.name} comporta até ${plural(unit.capacity, "pessoa", "pessoas")}.`;
    case "booked":
      return "Essa unidade já está reservada nesse período.";
    case "blocked":
      return "Essa unidade está bloqueada nesse período.";
  }
}

/** Erro da API para uma recusa. */
export function refusalError(
  refusal: Refusal,
  config: ReservaConfig,
  unit: Unit,
) {
  const code =
    refusal === "booked"
      ? "unit_unavailable"
      : refusal === "blocked"
        ? "unit_blocked"
        : "outside_rules";
  return new ApiError(409, code, refusalMessage(refusal, config, unit));
}

/**
 * Regras da área para o período (sem olhar o banco). A equipe (`staff`) não
 * esbarra em antecedência, estadia máxima nem no passo dos horários; ainda
 * vale o horário de funcionamento e a capacidade.
 */
export function ruleRefusal(
  config: ReservaConfig,
  unit: Unit,
  period: Period,
  at: number,
  options: { guests?: number; staff?: boolean } = {},
): Refusal | null {
  const staff = !!options.staff;
  if (!unit.active && !staff) return "inactive";
  if (options.guests !== undefined && options.guests > unit.capacity)
    return "capacity";
  if (period.mode === "hourly") {
    const open = minuteOf(config.hourly_open)!,
      close = minuteOf(config.hourly_close)!;
    const day = dayStart(period.start_date);
    if (
      period.starts < day + open * MINUTE_MS ||
      period.ends > day + close * MINUTE_MS
    )
      return "hours";
  }
  if (staff) {
    // Equipe registra a partir de hoje (inclusive quem chega sem reserva).
    if (period.ends <= at) return "past";
    return null;
  }
  if (period.arrival_at <= at) return "past";
  if (period.arrival_at - at < config.min_notice_hours * HOUR_MS)
    return "notice";
  if (period.start_date > addDays(brasiliaDate(at), config.max_days_ahead))
    return "ahead";
  if (period.mode === "daily") {
    if (period.nights! < config.min_nights) return "min_stay";
    if (period.nights! > config.max_nights) return "max_stay";
  } else {
    if (period.duration_minutes! < config.min_hours * 60) return "min_stay";
    if (period.duration_minutes! > config.max_hours * 60) return "max_stay";
    const offset =
      (period.starts -
        (dayStart(period.start_date) +
          minuteOf(config.hourly_open)! * MINUTE_MS)) /
      MINUTE_MS;
    if (offset % config.hourly_step_minutes !== 0) return "step";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ocupação (reservas ativas e bloqueios)

export interface Occupancy {
  bookings: {
    id: string;
    unit_id: string;
    starts: number;
    ends: number;
    status: string;
  }[];
  blocks: {
    id: string;
    unit_id: string | null;
    starts: number;
    ends: number;
  }[];
}

export async function occupancy(
  ctx: ModuleContext,
  from: number,
  to: number,
  options: { unitId?: string | null; ignore?: string } = {},
): Promise<Occupancy> {
  const unitFilter = options.unitId ? " AND unit_id=?" : "";
  const [bookings, blocks] = await Promise.all([
    all(
      ctx.env,
      `SELECT id,unit_id,starts,ends,status FROM reserva_bookings WHERE profile_id=? AND status IN ${ACTIVE_SQL} AND starts<? AND ends>?${unitFilter} LIMIT 5000`,
      ctx.profile,
      to,
      from,
      ...(options.unitId ? [options.unitId] : []),
    ),
    all(
      ctx.env,
      `SELECT id,unit_id,starts,ends FROM reserva_blocks WHERE profile_id=? AND starts<? AND ends>?${options.unitId ? " AND (unit_id IS NULL OR unit_id=?)" : ""} LIMIT 2000`,
      ctx.profile,
      to,
      from,
      ...(options.unitId ? [options.unitId] : []),
    ),
  ]);
  return {
    bookings: bookings.filter((b) => b.id !== options.ignore) as any,
    blocks: blocks as any,
  };
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
  a0 < b1 && a1 > b0;

/** Reserva ou bloqueio no intervalo da unidade (`force` ignora bloqueios). */
export function spanRefusal(
  unitId: string,
  starts: number,
  ends: number,
  occ: Occupancy,
  force = false,
): "booked" | "blocked" | null {
  if (
    occ.bookings.some(
      (b) => b.unit_id === unitId && overlaps(starts, ends, b.starts, b.ends),
    )
  )
    return "booked";
  if (
    !force &&
    occ.blocks.some(
      (b) =>
        (!b.unit_id || b.unit_id === unitId) &&
        overlaps(starts, ends, b.starts, b.ends),
    )
  )
    return "blocked";
  return null;
}

/** Recusa completa do período (regras e ocupação), ou null se está livre. */
export async function periodRefusal(
  ctx: ModuleContext,
  config: ReservaConfig,
  unit: Unit,
  period: Period,
  at: number,
  options: {
    guests?: number;
    staff?: boolean;
    force?: boolean;
    ignore?: string;
  } = {},
): Promise<Refusal | null> {
  const rule = ruleRefusal(config, unit, period, at, options);
  if (rule) return rule;
  const occ = await occupancy(ctx, period.starts, period.ends, {
    unitId: unit.id,
    ignore: options.ignore,
  });
  return spanRefusal(unit.id, period.starts, period.ends, occ, options.force);
}

// ---------------------------------------------------------------------------
// Consultas para o chat e o painel

/**
 * Noites livres de uma unidade por diária: para cada dia de `from` a
 * `from + days - 1`, se a noite que começa nele está livre (sem reserva nem
 * bloqueio). Não olha as regras.
 */
export async function freeNights(
  ctx: ModuleContext,
  unit: Unit,
  from: string,
  days: number,
  ignore?: string,
) {
  const starts = dayStart(from),
    ends = starts + days * DAY_MS;
  const occ = await occupancy(ctx, starts, ends, { unitId: unit.id, ignore });
  const out: { date: string; free: boolean }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const s = dayStart(date);
    out.push({ date, free: !spanRefusal(unit.id, s, s + DAY_MS, occ) });
  }
  return out;
}

/** Horários de início livres de uma unidade por hora, num dia. */
export async function hourlySlots(
  ctx: ModuleContext,
  config: ReservaConfig,
  unit: Unit,
  date: string,
  duration: number,
  at: number,
  options: { staff?: boolean; ignore?: string; occ?: Occupancy } = {},
) {
  const open = minuteOf(config.hourly_open)!,
    close = minuteOf(config.hourly_close)!;
  const day = dayStart(date);
  const occ =
    options.occ ||
    (await occupancy(ctx, day + open * MINUTE_MS, day + close * MINUTE_MS, {
      unitId: unit.id,
      ignore: options.ignore,
    }));
  const slots: { starts: number; ends: number; price_cents: number }[] = [];
  for (
    let minute = open;
    minute + duration <= close;
    minute += config.hourly_step_minutes
  ) {
    const period = hourlyPeriod(unit, day + minute * MINUTE_MS, duration);
    if (ruleRefusal(config, unit, period, at, options)) continue;
    if (spanRefusal(unit.id, period.starts, period.ends, occ)) continue;
    slots.push({
      starts: period.starts,
      ends: period.ends,
      price_cents: period.price_cents,
    });
  }
  return slots;
}

/** Horários livres de vários dias com uma só leitura da ocupação. */
export async function hourlyDays(
  ctx: ModuleContext,
  config: ReservaConfig,
  unit: Unit,
  dates: string[],
  duration: number,
  at: number,
  options: { ignore?: string } = {},
) {
  if (!dates.length) return [];
  const occ = await occupancy(
    ctx,
    dayStart(dates[0]),
    dayStart(addDays(dates[dates.length - 1], 1)),
    { unitId: unit.id, ignore: options.ignore },
  );
  const out: {
    date: string;
    slots: Awaited<ReturnType<typeof hourlySlots>>;
  }[] = [];
  for (const date of dates)
    out.push({
      date,
      slots: await hourlySlots(ctx, config, unit, date, duration, at, { occ }),
    });
  return out;
}

/** Primeiro dia que o cliente pode escolher (antecedência mínima). */
export function firstDay(config: ReservaConfig, at: number) {
  return brasiliaDate(at + config.min_notice_hours * HOUR_MS);
}
/** Último dia de entrada aceito (antecedência máxima). */
export const lastDay = (config: ReservaConfig, at: number) =>
  addDays(brasiliaDate(at), config.max_days_ahead);
