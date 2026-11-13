import { requireValue, defaultBusinessHours } from "./types";
export { defaultBusinessHours };

// America/Sao_Paulo has been UTC-3 without daylight saving since 2019. The
// offset is fixed here so the result never depends on the runtime's tz data.
export const BRASILIA_OFFSET_MS = 3 * 3600000;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;

export interface BusinessHours {
  days: number[];
  start: string;
  end: string;
  holidays: string[];
}
export const responseUnits = ["hours", "business_days"];

/** Minutes since midnight for "HH:MM", or null when malformed. */
function clock(value: unknown) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    typeof value === "string" ? value : "",
  );
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
const validDays = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 7 &&
  value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
  new Set(value).size === value.length;

/** Tolerant reading of stored settings: a malformed part falls back to the default. */
export function businessHours(value: any): BusinessHours {
  const start = clock(value?.start),
    end = clock(value?.end),
    validClock = start !== null && end !== null && start < end;
  return {
    days: validDays(value?.days)
      ? [...value.days].sort((a, b) => a - b)
      : [...defaultBusinessHours.days],
    start: validClock ? value.start : defaultBusinessHours.start,
    end: validClock ? value.end : defaultBusinessHours.end,
    holidays: Array.isArray(value?.holidays)
      ? value.holidays.filter(validDate).slice(0, 100)
      : [],
  };
}

/** Strict validation used when an administrator saves the settings. */
export function validateBusinessHours(value: any): BusinessHours {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Horário de atendimento inválido.",
  );
  requireValue(
    validDays(value.days),
    "Escolha de um a sete dias de atendimento, de 0 (domingo) a 6 (sábado), sem repetir.",
  );
  const start = clock(value.start),
    end = clock(value.end);
  requireValue(
    start !== null && end !== null,
    "Informe o horário de atendimento no formato HH:MM.",
  );
  requireValue(
    start < end,
    "O fim do horário de atendimento precisa ser depois do início.",
  );
  requireValue(
    Array.isArray(value.holidays) &&
      value.holidays.length <= 100 &&
      value.holidays.every(validDate) &&
      new Set(value.holidays).size === value.holidays.length,
    "Informe até 100 feriados no formato AAAA-MM-DD, sem repetir.",
  );
  return {
    days: [...value.days].sort((a: number, b: number) => a - b),
    start: value.start,
    end: value.end,
    holidays: [...value.holidays].sort(),
  };
}

export function validResponseDays(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 60;
}

/**
 * Deadline of the first human response for a protocol opened at `at`.
 *
 * hours: `at` plus protocol_response_hours, or null without a deadline.
 * business_days: the starting point is `at` when it falls inside the service
 * hours of a working day, otherwise the next opening; the deadline is the
 * same wall-clock time N working days later (Brasília time).
 */
export function protocolDueAt(at: number, config: any): number | null {
  if (config?.protocol_response_unit !== "business_days") {
    const hours = Number(config?.protocol_response_hours);
    return config?.protocol_response_hours &&
      Number.isFinite(hours) &&
      hours > 0
      ? at + hours * 3600000
      : null;
  }
  const hours = businessHours(config.business_hours),
    count = validResponseDays(config.protocol_response_days)
      ? Number(config.protocol_response_days)
      : 3,
    open = clock(hours.start)! * MINUTE_MS,
    close = clock(hours.end)! * MINUTE_MS,
    holidays = new Set(hours.holidays);
  // Shifted so that the UTC fields of the value are the Brasília wall clock.
  const local = at - BRASILIA_OFFSET_MS;
  let day = Math.floor(local / DAY_MS),
    time = local - day * DAY_MS;
  const working = (index: number) => {
    const date = new Date(index * DAY_MS);
    return (
      hours.days.includes(date.getUTCDay()) &&
      !holidays.has(date.toISOString().slice(0, 10))
    );
  };
  // At most 100 holidays and at least one weekday: a working day always
  // exists within a few months. The bound only guards a corrupted setting.
  const next = (index: number) => {
    for (let step = 1; step <= 800; step++)
      if (working(index + step)) return index + step;
    return index + 1;
  };
  if (!working(day) || time >= close) {
    day = next(day);
    time = open;
  } else if (time < open) time = open;
  for (let passed = 0; passed < count; passed++) day = next(day);
  return day * DAY_MS + time + BRASILIA_OFFSET_MS;
}

/** "14/11/2026 às 14:00", always in Brasília time. */
export function formatBrasilia(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS),
    two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getUTCDate())}/${two(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} às ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}
