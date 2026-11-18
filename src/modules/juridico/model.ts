import { z } from "zod";
import { ApiError } from "../../types";

export const WARNING = "Cálculo auxiliar: confira o calendário, a regra e o resultado com o advogado antes de usar.";
export const SEED_WARNING = "Confira antes de usar: carga inicial somente de feriados nacionais fixos; cobertura e aplicabilidade não verificadas.";
export const civil = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "2000-01-01" && value <= "2100-12-31";
});
const short = (max: number) => z.string().trim().min(1).max(max).refine(v => !v.includes("\0"));
export const idSchema = short(256);
export const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const eventSchema = z.strictObject({
  id: short(80), name: short(160), from: civil, to: civil,
  kind: z.enum(["national", "state", "municipal", "court", "suspension", "recess"]),
  effect: z.enum(["count", "start", "due", "all"]), source: short(500),
}).refine(e => e.from <= e.to, { message: "Intervalo invertido." });
export const calendarSchema = z.strictObject({
  name: short(160), jurisdiction: short(240), from: civil, to: civil,
  timezone: short(80).refine(zone => { try { new Intl.DateTimeFormat("pt-BR", { timeZone: zone }); return true; } catch { return false; } }),
  weekend: z.array(z.number().int().min(0).max(6)).max(6).refine(v => new Set(v).size === v.length),
  events: z.array(eventSchema).max(300),
}).superRefine((c, ctx) => {
  if (c.from > c.to || dayNumber(c.to) - dayNumber(c.from) > 3660)
    ctx.addIssue({ code: "custom", message: "Cobertura deve ter até dez anos.", path: ["to"] });
  if (new Set(c.events.map(e => e.id)).size !== c.events.length)
    ctx.addIssue({ code: "custom", message: "Ocorrências repetidas.", path: ["events"] });
  if (c.events.some(e => e.from < c.from || e.to > c.to))
    ctx.addIssue({ code: "custom", message: "Ocorrência fora da cobertura.", path: ["events"] });
});
export const ruleSchema = z.strictObject({
  start_date: civil, days: z.number().int().min(1).max(366),
  include_start: z.boolean(), start_non_working: z.enum(["next", "previous", "reject"]),
  due_non_working: z.enum(["next", "previous", "reject"]),
  due_time: timeSchema, alert_days: z.number().int().min(0).max(60), alert_time: timeSchema,
});
export type Calendar = z.infer<typeof calendarSchema>;
export type CalendarEvent = z.infer<typeof eventSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "invalid_request", `Confira o campo ${result.error.issues[0]?.path.join(".") || "corpo"}.`);
  return result.data;
}
export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
export const moveDay = (date: string, days: number) => new Date((dayNumber(date) + days) * 86400000).toISOString().slice(0, 10);
export async function stableId(...parts: unknown[]) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

/** Lista explícita, sem datas móveis, estaduais, municipais ou de tribunal. */
export function nationalSeed(from: string, to: string): CalendarEvent[] {
  parse(civil, from); parse(civil, to);
  const dates = [["01-01", "Confraternização universal"], ["04-21", "Tiradentes"], ["05-01", "Dia do trabalho"],
    ["09-07", "Independência do Brasil"], ["10-12", "Nossa Senhora Aparecida"], ["11-02", "Finados"],
    ["11-15", "Proclamação da República"], ["11-20", "Consciência negra"], ["12-25", "Natal"]];
  const events: CalendarEvent[] = [];
  for (let year = +from.slice(0, 4); year <= +to.slice(0, 4); year++) for (const [day, name] of dates) {
    const date = `${year}-${day}`;
    if (date >= from && date <= to) events.push({ id: `national-${date}`, name, from: date, to: date, kind: "national", effect: "all", source: SEED_WARNING });
  }
  return events;
}
