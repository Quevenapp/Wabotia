import { ApiError } from "../../types";
import { calendarSchema, ruleSchema, parse, moveDay, dayNumber, WARNING, type Calendar, type Rule } from "./model";

export interface TraceDay { date: string; phase: "start" | "count" | "due" | "alert"; counted: boolean; reasons: string[]; sources: string[] }
export interface Calculation {
  schema_version: 1; algorithm: "business-days-v1"; calendar: Calendar; rule: Rule;
  effective_start: string; counted_end: string; due_date: string; due_at: number;
  alert_date: string; alert_at: number; trace: TraceDay[]; warning: string;
}

/** Datas civis nunca passam pelo fuso do servidor. Gaps e horas ambíguas são recusados. */
export function localInstant(date: string, time: string, timezone: string) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
  const target = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const at = target + delta, p = parts(at);
    offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - at);
  }
  const matches = [...offsets].map(offset => target - offset).filter(at => {
    const p = parts(at);
    return `${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time;
  });
  if (matches.length !== 1) throw new ApiError(422, "ambiguous_time", "Horário inexistente ou ambíguo neste fuso. Informe outro horário e confira a regra.");
  return matches[0];
}

export function calculate(calendarValue: Calendar, ruleValue: Rule): Calculation {
  const calendar = parse(calendarSchema, calendarValue), rule = parse(ruleSchema, ruleValue);
  const trace: TraceDay[] = [];
  let memoryBytes = new TextEncoder().encode(JSON.stringify({ calendar, rule })).length;
  function inspect(date: string, phase: TraceDay["phase"], record = true) {
    if (date < calendar.from || date > calendar.to) throw new ApiError(422, "calendar_coverage", "Calendário sem cobertura integral da contagem ou do aviso. Amplie a cobertura e confira as ocorrências.");
    const effects = phase === "alert" ? ["all", "count"] : ["all", phase];
    const events = calendar.events.filter(e => date >= e.from && date <= e.to && effects.includes(e.effect));
    const weekend = calendar.weekend.includes(new Date(dayNumber(date) * 86400000).getUTCDay());
    const day: TraceDay = { date, phase, counted: !weekend && !events.length,
      reasons: [...(weekend ? ["Dia da semana não útil"] : []), ...events.map(e => e.name)], sources: events.map(e => e.source) };
    if (record) {
      memoryBytes += new TextEncoder().encode(JSON.stringify(day)).length;
      if (memoryBytes > 750000) throw new ApiError(422, "calculation_limit", "Memória muito extensa. Reduza ocorrências sobrepostas e confira a cobertura.");
      trace.push(day);
    }
    return day.counted;
  }
  function adjust(date: string, phase: "start" | "due", policy: "next" | "previous" | "reject") {
    for (let n = 0; n < 3661; n++) {
      if (inspect(date, phase)) return date;
      if (policy === "reject") throw new ApiError(422, `${phase}_non_working`, "A regra rejeita início ou vencimento em dia não útil. Confira as datas.");
      date = moveDay(date, policy === "next" ? 1 : -1);
    }
    throw new ApiError(422, "calendar_coverage", "Não há dia útil na cobertura informada.");
  }
  const effective_start = adjust(rule.start_date, "start", rule.start_non_working);
  let cursor = rule.include_start ? effective_start : moveDay(effective_start, 1), count = 0;
  while (count < rule.days) {
    if (inspect(cursor, "count")) count++;
    if (count < rule.days) cursor = moveDay(cursor, 1);
  }
  const counted_end = cursor, due_date = adjust(cursor, "due", rule.due_non_working);
  if (due_date < effective_start) throw new ApiError(422, "due_before_start", "O ajuste de vencimento recua antes do início. Confira a regra.");
  let alert_date = due_date, remaining = rule.alert_days;
  while (remaining) { alert_date = moveDay(alert_date, -1); if (inspect(alert_date, "alert")) remaining--; }
  const due_at = localInstant(due_date, rule.due_time, calendar.timezone);
  const alert_at = localInstant(alert_date, rule.alert_time, calendar.timezone);
  if (alert_at > due_at) throw new ApiError(422, "alert_after_due", "O horário do aviso deve anteceder o vencimento.");
  return { schema_version: 1, algorithm: "business-days-v1", calendar, rule, effective_start, counted_end, due_date, due_at, alert_date, alert_at, trace, warning: WARNING };
}
