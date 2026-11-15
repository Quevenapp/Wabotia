// Configuração da Agenda na área (chave "agenda" de PUT /settings) e horário
// de Brasília. Tudo aqui é puro: sem banco, testável com qualquer `now`.
import { BRASILIA_OFFSET_MS } from "../../business-time";
import { requireValue } from "../../types";

export const DAY_MS = 86400000;
export const MINUTE_MS = 60000;

export interface AgendaConfig {
  /** Antecedência mínima para o cliente marcar, em minutos. */
  min_notice_minutes: number;
  /** Até quantos dias à frente o cliente pode marcar. */
  max_days_ahead: number;
  /** Intervalo entre os horários oferecidos, em minutos. */
  slot_step_minutes: number;
  /** Lembrete N horas antes (0 desliga). */
  reminder_hours: number;
  /** O cliente pode cancelar ou remarcar até N horas antes. */
  customer_change_hours: number;
  /** Feriados de Horário de atendimento (Configurações) fecham a agenda. */
  close_on_holidays: boolean;
  /** Textos; {servico}, {profissional}, {data}, {hora} e {nome} são trocados. */
  intro_text: string;
  booked_text: string;
  reminder_text: string;
  cancelled_text: string;
}

export const defaultAgendaConfig: AgendaConfig = {
  min_notice_minutes: 60,
  max_days_ahead: 30,
  slot_step_minutes: 30,
  reminder_hours: 24,
  customer_change_hours: 2,
  close_on_holidays: true,
  intro_text: "Vamos agendar o seu horário. Qual serviço você quer?",
  booked_text:
    "Agendado! {servico} com {profissional}, {data} às {hora}. Para ver, remarcar ou cancelar, use Meus agendamentos no menu.",
  reminder_text:
    "Lembrete: {servico} com {profissional}, {data} às {hora}. Você confirma?",
  cancelled_text:
    "Seu agendamento de {servico} em {data} às {hora} foi cancelado.",
};

const NUMBERS: [keyof AgendaConfig, number, number, string][] = [
  ["min_notice_minutes", 0, 10080, "Antecedência mínima de 0 a 10080 minutos."],
  ["max_days_ahead", 1, 365, "Antecedência máxima de 1 a 365 dias."],
  ["slot_step_minutes", 5, 240, "Intervalo entre horários de 5 a 240 minutos."],
  ["reminder_hours", 0, 168, "Lembrete de 0 (desligado) a 168 horas antes."],
  [
    "customer_change_hours",
    0,
    168,
    "Prazo para o cliente cancelar ou remarcar de 0 a 168 horas.",
  ],
];
const TEXTS: [keyof AgendaConfig, number, string][] = [
  ["intro_text", 600, "o texto de abertura"],
  ["booked_text", 900, "a mensagem de agendamento"],
  ["reminder_text", 900, "a mensagem de lembrete"],
  ["cancelled_text", 900, "a mensagem de cancelamento"],
];

/** Leitura tolerante do que está salvo: o que estiver ruim volta ao padrão. */
export function agendaConfig(value: any): AgendaConfig {
  const config: any = { ...defaultAgendaConfig };
  if (!value || typeof value !== "object") return config;
  for (const [key, min, max] of NUMBERS)
    if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max)
      config[key] = value[key];
  if (typeof value.close_on_holidays === "boolean")
    config.close_on_holidays = value.close_on_holidays;
  for (const [key, max] of TEXTS)
    if (
      typeof value[key] === "string" &&
      value[key].trim() &&
      Array.from(value[key]).length <= max
    )
      config[key] = value[key].trim();
  return config;
}

/** Validação estrita da chave "agenda" em PUT /settings. */
export function validateAgendaConfig(value: unknown): AgendaConfig {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Configuração da Agenda inválida.",
  );
  const raw = value as any;
  const config: any = { ...defaultAgendaConfig };
  for (const [key, min, max, message] of NUMBERS)
    if (raw[key] !== undefined) {
      requireValue(
        Number.isInteger(raw[key]) && raw[key] >= min && raw[key] <= max,
        message,
      );
      config[key] = raw[key];
    }
  if (raw.close_on_holidays !== undefined) {
    requireValue(
      typeof raw.close_on_holidays === "boolean",
      "Feriados: informe verdadeiro ou falso.",
    );
    config.close_on_holidays = raw.close_on_holidays;
  }
  for (const [key, max, what] of TEXTS)
    if (raw[key] !== undefined && raw[key] !== "") {
      requireValue(
        typeof raw[key] === "string" &&
          raw[key].trim() &&
          Array.from(raw[key] as string).length <= max,
        `Agenda: ${what} com até ${max} caracteres.`,
      );
      config[key] = raw[key].trim();
    }
  return config;
}

// ---------------------------------------------------------------------------
// Horário de Brasília (UTC-3 fixo, como src/business-time.ts)

/** "AAAA-MM-DD" do dia de Brasília que contém `at`. */
export function brasiliaDate(at: number) {
  return new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
/** Meia-noite de Brasília do dia, em ms Unix. */
export const dayStart = (date: string) =>
  Date.parse(date + "T00:00:00Z") + BRASILIA_OFFSET_MS;
/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
export const weekday = (date: string) =>
  new Date(date + "T00:00:00Z").getUTCDay();
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const two = (value: number) => String(value).padStart(2, "0");
/** "14:30" em Brasília. */
export function clockOf(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS);
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAYS_LONG = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];
/** "seg 17/11" */
export function shortDay(date: string) {
  const [, month, day] = date.split("-");
  return `${WEEKDAYS[weekday(date)]} ${day}/${month}`;
}
/** "segunda-feira, 17/11" */
export function longDay(date: string) {
  const [, month, day] = date.split("-");
  return `${WEEKDAYS_LONG[weekday(date)]}, ${day}/${month}`;
}

/** "HH:MM" → minutos desde a meia-noite; "24:00" vale como fim do dia. */
export function minuteOf(value: unknown) {
  if (value === "24:00") return 1440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    typeof value === "string" ? value : "",
  );
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
export const clockOfMinute = (minute: number) =>
  `${two(Math.floor(minute / 60))}:${two(minute % 60)}`;

/** Troca {servico}, {profissional}, {data}, {hora} e {nome}. */
export function fill(template: string, values: Record<string, string>) {
  return template.replace(
    /\{(servico|profissional|data|hora|nome)\}/g,
    (_, k) => values[k] ?? "",
  );
}

export function money(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "";
  return (
    "R$ " +
    (cents / 100)
      .toFixed(2)
      .replace(".", ",")
      .replace(/\B(?=(\d{3})+,)/g, ".")
  );
}
