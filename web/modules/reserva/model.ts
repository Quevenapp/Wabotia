// Reserva no painel: tipos das respostas de /reserva e horário de Brasília
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
  new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
export const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS,
  );
export const at = (date: string, clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return brStart(date) + (h * 60 + m) * 60_000;
};
const SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const weekdayOf = (date: string) =>
  new Date(date + "T00:00:00Z").getUTCDay();
/** "sex 20/11" */
export function dayLabel(date: string) {
  const [, month, day] = date.split("-");
  return `${SHORT[weekdayOf(date)]} ${day}/${month}`;
}
/** "sex 20/11 às 14:00" */
export const moment = (ms: number) =>
  `${dayLabel(brDate(ms))} às ${brClock(ms)}`;

export function money(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}
/** "300" ou "300,00" → 30000; vazio → null. */
export function cents(value: string): number | null {
  const clean = String(value)
    .replace(/[^\d,.]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!clean) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}
export const reais = (value: number | null | undefined) =>
  value === null || value === undefined
    ? ""
    : (value / 100).toFixed(2).replace(".", ",");

export type Tone = "brand" | "ok" | "warn" | "muted" | "danger";
export const statusInfo: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: "Aguardando sinal", tone: "warn" },
  confirmed: { label: "Confirmada", tone: "ok" },
  cancelled: { label: "Cancelada", tone: "muted" },
  expired: { label: "Sinal vencido", tone: "danger" },
  completed: { label: "Encerrada", tone: "muted" },
};
export const paymentInfo: Record<string, string> = {
  created: "Cobrança enviada",
  paid: "Sinal pago",
  expired: "Cobrança vencida",
  cancelled: "Cobrança cancelada",
  refunded: "Sinal estornado",
};
export const checkinInfo: Record<string, string> = {
  none: "Check-in não enviado",
  invited: "Convite de check-in enviado",
  sent: "Link de check-in enviado",
  completed: "Check-in feito",
};
export const paymentErrors: Record<string, string> = {
  payments_not_configured:
    "Sem conta de cobrança configurada (Gestão → Cobrança).",
  module_disabled: "O módulo Cobrança está desligado.",
  window_closed:
    "O cliente não escreveu nas últimas 24 horas na linha oficial.",
};
export const active = (b: Row) =>
  ["pending_payment", "confirmed"].includes(b.status);

export const KINDS: [string, string][] = [
  ["room", "Quarto ou suíte"],
  ["house", "Chalé ou casa"],
  ["court", "Quadra"],
  ["hall", "Salão"],
  ["other", "Outro"],
];
export const kindLabel = (kind: string) =>
  KINDS.find(([id]) => id === kind)?.[1] || "Unidade";

/** Período legível: "sex 20/11 14:00 → dom 22/11 12:00 · 2 diárias". */
export function stayLabel(b: Row) {
  return b.mode === "daily"
    ? `${dayLabel(b.start_date)} ${b.arrival_time} → ${dayLabel(b.end_date)} ${b.departure_time} · ${b.nights} ${b.nights === 1 ? "diária" : "diárias"}`
    : `${dayLabel(b.start_date)} · ${b.arrival_time} às ${b.departure_time}`;
}

export interface Overview {
  config: Row;
  units: Row[];
  deposit: {
    available: boolean;
    reason: string | null;
    message: string | null;
  };
}
