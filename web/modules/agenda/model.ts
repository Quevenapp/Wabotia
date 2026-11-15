// Agenda no painel: tipos das respostas de /agenda e horário de Brasília
// (UTC-3 fixo, como src/business-time.ts), sem depender do fuso do navegador.
import type { Row } from "../../lib/api";

export const DAY_MS = 86_400_000;
const OFFSET = 3 * 3_600_000;

/** "AAAA-MM-DD" do dia de Brasília. */
export const brDate = (ms: number) =>
  new Date(ms - OFFSET).toISOString().slice(0, 10);
/** Meia-noite de Brasília do dia. */
export const brStart = (date: string) =>
  Date.parse(date + "T00:00:00Z") + OFFSET;
/** "14:30" em Brasília. */
export const brClock = (ms: number) =>
  new Date(ms - OFFSET).toISOString().slice(11, 16);
export const addDays = (date: string, days: number) =>
  brDate(brStart(date) + days * DAY_MS + 12 * 3_600_000);
export const weekdayOf = (date: string) =>
  new Date(date + "T00:00:00Z").getUTCDay();
/** Segunda-feira da semana do dia. */
export const weekStart = (date: string) =>
  addDays(date, -((weekdayOf(date) + 6) % 7));
export const at = (date: string, clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return brStart(date) + (h * 60 + m) * 60_000;
};

export const WEEKDAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];
const SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function dayLabel(date: string, long = false) {
  const [, month, day] = date.split("-");
  return `${long ? WEEKDAYS[weekdayOf(date)] : SHORT[weekdayOf(date)]} ${day}/${month}`;
}

export function money(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}
/** "50" ou "50,00" → 5000; vazio → null. */
export function cents(value: string): number | null {
  const clean = value
    .replace(/[^\d,.]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!clean) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

export const statusInfo: Record<
  string,
  { label: string; tone: "brand" | "ok" | "muted" | "danger" }
> = {
  booked: { label: "Marcado", tone: "brand" },
  confirmed: { label: "Confirmado", tone: "ok" },
  cancelled: { label: "Cancelado", tone: "muted" },
  no_show: { label: "Faltou", tone: "danger" },
};
export const active = (a: Row) => ["booked", "confirmed"].includes(a.status);

export interface Overview {
  config: Row;
  services: Row[];
  professionals: Row[];
}
