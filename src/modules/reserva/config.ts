// Regras da Reserva na área (chave "reserva" de PUT /settings) e horário de
// Brasília. Tudo aqui é puro: sem banco, testável com qualquer `now`.
import { BRASILIA_OFFSET_MS } from "../../business-time";
import { requireValue } from "../../types";

export const DAY_MS = 86400000;
export const HOUR_MS = 3600000;
export const MINUTE_MS = 60000;

export type DepositType = "none" | "percent" | "fixed";

export interface CheckinFields {
  /** Documento (CPF, RG ou passaporte). */
  document: boolean;
  /** Nomes dos acompanhantes. */
  companions: boolean;
  /** Horário previsto de chegada. */
  arrival_time: boolean;
  /** Aceite das regras da casa (texto em house_rules). */
  rules: boolean;
}

export interface ReservaConfig {
  /** Antecedência mínima entre o pedido e a entrada, em horas. */
  min_notice_hours: number;
  /** Até quantos dias à frente o cliente pode reservar. */
  max_days_ahead: number;
  /** Estadia mínima das unidades por diária. */
  min_nights: number;
  /** Estadia máxima das unidades por diária (pelo WhatsApp). */
  max_nights: number;
  /** Horário de entrada e de saída das unidades por diária ("HH:MM"). */
  checkin_time: string;
  checkout_time: string;
  /** Funcionamento das unidades por hora ("HH:MM"; fechamento até "24:00"). */
  hourly_open: string;
  hourly_close: string;
  /** Intervalo entre os horários de início oferecidos, em minutos. */
  hourly_step_minutes: number;
  /** Duração mínima e máxima das unidades por hora, em horas. */
  min_hours: number;
  max_hours: number;
  /** Sinal: nenhum, percentual do total ou valor fixo. */
  deposit_type: DepositType;
  deposit_percent: number;
  deposit_cents: number;
  deposit_method: "pix" | "link";
  /** Prazo para pagar o sinal; a unidade fica segura até lá. */
  deposit_deadline_minutes: number;
  /** Política de cancelamento mostrada ao cliente. */
  cancellation_policy: string;
  /** O cliente cancela pelo WhatsApp até N horas antes da entrada. */
  customer_cancel_hours: number;
  /** Check-in online pelo link (passo web). */
  checkin_enabled: boolean;
  /** Envia o link N horas antes da entrada. */
  checkin_hours_before: number;
  checkin_fields: CheckinFields;
  /** Perguntas a mais no check-in (texto livre). */
  checkin_questions: string[];
  /** Regras da casa, mostradas no check-in. */
  house_rules: string;
  /** Lembrete N horas antes da entrada (0 desliga). */
  reminder_hours: number;
  /** Mensagem de saída N minutos antes do horário de saída. */
  checkout_message: boolean;
  checkout_minutes_before: number;
  /**
   * Textos; {numero}, {unidade}, {entrada}, {saida}, {nome}, {valor},
   * {sinal} e {prazo} são trocados.
   */
  intro_text: string;
  confirmed_text: string;
  pending_text: string;
  expired_text: string;
  cancelled_text: string;
  reminder_text: string;
  checkout_text: string;
}

export const defaultReservaConfig: ReservaConfig = {
  min_notice_hours: 2,
  max_days_ahead: 365,
  min_nights: 1,
  max_nights: 30,
  checkin_time: "14:00",
  checkout_time: "12:00",
  hourly_open: "08:00",
  hourly_close: "22:00",
  hourly_step_minutes: 60,
  min_hours: 1,
  max_hours: 4,
  deposit_type: "none",
  deposit_percent: 30,
  deposit_cents: 0,
  deposit_method: "pix",
  deposit_deadline_minutes: 120,
  cancellation_policy: "",
  customer_cancel_hours: 48,
  checkin_enabled: true,
  checkin_hours_before: 48,
  checkin_fields: {
    document: true,
    companions: true,
    arrival_time: true,
    rules: false,
  },
  checkin_questions: [],
  house_rules: "",
  reminder_hours: 24,
  checkout_message: true,
  checkout_minutes_before: 60,
  intro_text: "Vamos fazer a sua reserva. O que você quer reservar?",
  confirmed_text:
    "Reserva {numero} confirmada! {unidade}: entrada {entrada}, saída {saida}. Para ver ou cancelar, use Minhas reservas no menu.",
  pending_text:
    "Reserva {numero} feita! {unidade}: entrada {entrada}, saída {saida}. Para garantir, pague o sinal de {sinal} até {prazo}. Sem o pagamento, a reserva é liberada.",
  expired_text:
    "O prazo para pagar o sinal da reserva {numero} ({unidade}) acabou e a reserva foi liberada. Se ainda quiser, faça uma nova reserva pelo menu.",
  cancelled_text:
    "A reserva {numero} ({unidade}, entrada {entrada}) foi cancelada.",
  reminder_text:
    "Lembrete da sua reserva {numero}: {unidade}, entrada {entrada}. Até breve!",
  checkout_text:
    "Sua saída de {unidade} é {saida}. Obrigado pela estadia e volte sempre!",
};

const NUMBERS: [keyof ReservaConfig, number, number, string][] = [
  ["min_notice_hours", 0, 720, "Antecedência mínima de 0 a 720 horas."],
  ["max_days_ahead", 1, 730, "Antecedência máxima de 1 a 730 dias."],
  ["min_nights", 1, 60, "Estadia mínima de 1 a 60 diárias."],
  ["max_nights", 1, 90, "Estadia máxima de 1 a 90 diárias."],
  [
    "hourly_step_minutes",
    15,
    240,
    "Intervalo entre horários de 15 a 240 minutos.",
  ],
  ["min_hours", 1, 24, "Duração mínima de 1 a 24 horas."],
  ["max_hours", 1, 24, "Duração máxima de 1 a 24 horas."],
  ["deposit_percent", 1, 100, "Sinal percentual de 1 a 100."],
  ["deposit_cents", 0, 100_000_00, "Sinal fixo até R$ 100.000,00."],
  [
    "deposit_deadline_minutes",
    30,
    10080,
    "Prazo do sinal de 30 minutos a 7 dias.",
  ],
  [
    "customer_cancel_hours",
    0,
    720,
    "Prazo de cancelamento pelo cliente de 0 a 720 horas.",
  ],
  [
    "checkin_hours_before",
    1,
    336,
    "Envio do check-in de 1 a 336 horas antes da entrada.",
  ],
  ["reminder_hours", 0, 168, "Lembrete de 0 (desligado) a 168 horas antes."],
  [
    "checkout_minutes_before",
    0,
    1440,
    "Mensagem de saída de 0 a 1440 minutos antes.",
  ],
];
const CLOCKS: [keyof ReservaConfig, string][] = [
  ["checkin_time", "Horário de entrada no formato HH:MM."],
  ["checkout_time", "Horário de saída no formato HH:MM."],
  ["hourly_open", "Abertura no formato HH:MM."],
  ["hourly_close", "Fechamento no formato HH:MM (até 24:00)."],
];
const FLAGS: [keyof ReservaConfig, string][] = [
  ["checkin_enabled", "Check-in: informe verdadeiro ou falso."],
  ["checkout_message", "Mensagem de saída: informe verdadeiro ou falso."],
];
const TEXTS: [keyof ReservaConfig, number, string, boolean][] = [
  ["cancellation_policy", 1500, "a política de cancelamento", true],
  ["house_rules", 1400, "as regras da casa", true],
  ["intro_text", 600, "o texto de abertura", false],
  ["confirmed_text", 900, "a mensagem de reserva confirmada", false],
  ["pending_text", 900, "a mensagem de reserva aguardando sinal", false],
  ["expired_text", 900, "a mensagem de sinal vencido", false],
  ["cancelled_text", 900, "a mensagem de cancelamento", false],
  ["reminder_text", 900, "a mensagem de lembrete", false],
  ["checkout_text", 900, "a mensagem de saída", false],
];
const CHECKIN_FIELDS: (keyof CheckinFields)[] = [
  "document",
  "companions",
  "arrival_time",
  "rules",
];

/** Leitura tolerante do que está salvo: o que estiver ruim volta ao padrão. */
export function reservaConfig(value: any): ReservaConfig {
  const config: any = {
    ...defaultReservaConfig,
    checkin_fields: { ...defaultReservaConfig.checkin_fields },
  };
  if (!value || typeof value !== "object") return config;
  for (const [key, min, max] of NUMBERS)
    if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max)
      config[key] = value[key];
  for (const [key] of CLOCKS)
    if (
      minuteOf(value[key]) !== null &&
      (value[key] !== "24:00" || key === "hourly_close")
    )
      config[key] = value[key];
  for (const [key] of FLAGS)
    if (typeof value[key] === "boolean") config[key] = value[key];
  for (const [key, max, , empty] of TEXTS)
    if (
      typeof value[key] === "string" &&
      (empty || value[key].trim()) &&
      Array.from(value[key]).length <= max
    )
      config[key] = value[key].trim();
  if (["none", "percent", "fixed"].includes(value.deposit_type))
    config.deposit_type = value.deposit_type;
  if (["pix", "link"].includes(value.deposit_method))
    config.deposit_method = value.deposit_method;
  if (value.checkin_fields && typeof value.checkin_fields === "object")
    for (const key of CHECKIN_FIELDS)
      if (typeof value.checkin_fields[key] === "boolean")
        config.checkin_fields[key] = value.checkin_fields[key];
  if (Array.isArray(value.checkin_questions))
    config.checkin_questions = value.checkin_questions
      .filter(
        (q: unknown) =>
          typeof q === "string" && q.trim() && Array.from(q).length <= 200,
      )
      .slice(0, 5)
      .map((q: string) => q.trim());
  if (config.max_nights < config.min_nights)
    config.max_nights = config.min_nights;
  if (config.max_hours < config.min_hours) config.max_hours = config.min_hours;
  if (minuteOf(config.hourly_close)! <= minuteOf(config.hourly_open)!) {
    config.hourly_open = defaultReservaConfig.hourly_open;
    config.hourly_close = defaultReservaConfig.hourly_close;
  }
  return config;
}

/** Validação estrita da chave "reserva" em PUT /settings. */
export function validateReservaConfig(value: unknown): ReservaConfig {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Regras da Reserva inválidas.",
  );
  const raw = value as any;
  const config: any = {
    ...defaultReservaConfig,
    checkin_fields: { ...defaultReservaConfig.checkin_fields },
  };
  for (const [key, min, max, message] of NUMBERS)
    if (raw[key] !== undefined) {
      requireValue(
        Number.isInteger(raw[key]) && raw[key] >= min && raw[key] <= max,
        message,
      );
      config[key] = raw[key];
    }
  for (const [key, message] of CLOCKS)
    if (raw[key] !== undefined) {
      requireValue(
        minuteOf(raw[key]) !== null &&
          (raw[key] !== "24:00" || key === "hourly_close"),
        message,
      );
      config[key] = raw[key];
    }
  for (const [key, message] of FLAGS)
    if (raw[key] !== undefined) {
      requireValue(typeof raw[key] === "boolean", message);
      config[key] = raw[key];
    }
  for (const [key, max, what, empty] of TEXTS)
    if (raw[key] !== undefined && (empty || raw[key] !== "")) {
      requireValue(
        typeof raw[key] === "string" &&
          (empty || raw[key].trim()) &&
          Array.from(raw[key] as string).length <= max,
        `Reserva: ${what} com até ${max} caracteres.`,
      );
      config[key] = raw[key].trim();
    }
  if (raw.deposit_type !== undefined) {
    requireValue(
      ["none", "percent", "fixed"].includes(raw.deposit_type),
      "Sinal: use none (sem sinal), percent ou fixed.",
    );
    config.deposit_type = raw.deposit_type;
  }
  if (raw.deposit_method !== undefined) {
    requireValue(
      ["pix", "link"].includes(raw.deposit_method),
      "Forma do sinal: pix ou link.",
    );
    config.deposit_method = raw.deposit_method;
  }
  requireValue(
    config.deposit_type !== "fixed" || config.deposit_cents >= 100,
    "Informe o valor fixo do sinal (a partir de R$ 1,00).",
  );
  if (raw.checkin_fields !== undefined) {
    requireValue(
      raw.checkin_fields && typeof raw.checkin_fields === "object",
      "Campos do check-in inválidos.",
    );
    for (const key of CHECKIN_FIELDS)
      if (raw.checkin_fields[key] !== undefined) {
        requireValue(
          typeof raw.checkin_fields[key] === "boolean",
          "Campos do check-in: verdadeiro ou falso.",
        );
        config.checkin_fields[key] = raw.checkin_fields[key];
      }
  }
  if (raw.checkin_questions !== undefined) {
    requireValue(
      Array.isArray(raw.checkin_questions) &&
        raw.checkin_questions.length <= 5 &&
        raw.checkin_questions.every(
          (q: unknown) =>
            typeof q === "string" && q.trim() && Array.from(q).length <= 200,
        ),
      "Perguntas do check-in: até 5, com até 200 caracteres cada.",
    );
    config.checkin_questions = raw.checkin_questions.map((q: string) =>
      q.trim(),
    );
  }
  requireValue(
    config.max_nights >= config.min_nights,
    "A estadia máxima precisa ser maior ou igual à mínima.",
  );
  requireValue(
    config.max_hours >= config.min_hours,
    "A duração máxima precisa ser maior ou igual à mínima.",
  );
  requireValue(
    minuteOf(config.hourly_close)! > minuteOf(config.hourly_open)!,
    "O fechamento precisa ser depois da abertura.",
  );
  requireValue(
    !config.checkin_fields.rules || config.house_rules,
    "Escreva as regras da casa para pedir o aceite no check-in.",
  );
  return config;
}

/** Valor do sinal para um total (0 = sem sinal). */
export function depositFor(config: ReservaConfig, total: number) {
  if (config.deposit_type === "percent")
    return Math.round((total * config.deposit_percent) / 100);
  if (config.deposit_type === "fixed")
    return Math.min(config.deposit_cents, total);
  return 0;
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
export const weekday = (date: string) =>
  new Date(date + "T00:00:00Z").getUTCDay();
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date + "T00:00:00Z") + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
/** Diferença em dias entre duas datas AAAA-MM-DD. */
export const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS,
  );

const two = (value: number) => String(value).padStart(2, "0");
/** "14:30" em Brasília. */
export function clockOf(at: number) {
  const date = new Date(at - BRASILIA_OFFSET_MS);
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}
/** "HH:MM" → minutos desde a meia-noite; "24:00" vale como fim do dia. */
export function minuteOf(value: unknown) {
  if (value === "24:00") return 1440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
    typeof value === "string" ? value : "",
  );
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
/** Instante de Brasília: dia AAAA-MM-DD e "HH:MM". */
export const atClock = (date: string, clock: string) =>
  dayStart(date) + (minuteOf(clock) ?? 0) * MINUTE_MS;

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
/** "sex 20/11" */
export function shortDay(date: string) {
  const [, month, day] = date.split("-");
  return `${WEEKDAYS[weekday(date)]} ${day}/${month}`;
}
/** "sex 20/11 às 14:00" */
export const moment = (at: number) =>
  `${shortDay(brasiliaDate(at))} às ${clockOf(at)}`;

/**
 * Data digitada pelo cliente: "20/11", "20/11/2026", "20/11/26" ou
 * "2026-11-20". Sem ano, a próxima ocorrência a partir de `today`.
 */
export function parseDate(text: string, today: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (iso) return validDate(text.trim()) ? text.trim() : null;
  const match = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const day = two(Number(match[1])),
    month = two(Number(match[2]));
  if (match[3]) {
    const year =
      match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = `${year}-${month}-${day}`;
    return validDate(date) ? date : null;
  }
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const date = `${y}-${month}-${day}`;
    if (validDate(date) && date >= today) return date;
  }
  return null;
}

/** Troca {numero}, {unidade}, {entrada}, {saida}, {nome}, {valor}, {sinal}, {prazo}. */
export function fill(template: string, values: Record<string, string>) {
  return template.replace(
    /\{(numero|unidade|entrada|saida|nome|valor|sinal|prazo)\}/g,
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
