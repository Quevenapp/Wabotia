// Regras puras da Mensalidade: periodicidade, datas de vencimento no horário
// de Brasília, configurações, valores e textos. Sem banco, para testar e para
// os apps lerem o contrato.
import { requireValue } from "../../types";
import { BRASILIA_OFFSET_MS } from "../../business-time";
// Funções puras do núcleo para CPF e CNPJ (mesma regra do estabelecimento).
import { formatDocument, validCnpj, validCpf } from "../../establishment";

export const DAY = 86_400_000;

export const PERIODS = ["monthly", "quarterly", "yearly"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_MONTHS: Record<Period, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};
export const PERIOD_LABELS: Record<Period, string> = {
  monthly: "Mensal",
  quarterly: "Trimestral",
  yearly: "Anual",
};
export const isPeriod = (value: unknown): value is Period =>
  typeof value === "string" && (PERIODS as readonly string[]).includes(value);

export const SUBSCRIPTION_STATUSES = ["active", "paused", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const SUBSCRIPTION_LABELS: Record<SubscriptionStatus, string> = {
  active: "Ativa",
  paused: "Pausada",
  ended: "Encerrada",
};

export const INSTALLMENT_STATUSES = [
  "open",
  "paid",
  "overdue",
  "cancelled",
  "waived",
] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];
export const INSTALLMENT_LABELS: Record<InstallmentStatus, string> = {
  open: "Aberta",
  paid: "Paga",
  overdue: "Vencida",
  cancelled: "Cancelada",
  waived: "Isenta",
};
/** Parcelas que ainda podem ser pagas. */
export const PAYABLE: readonly InstallmentStatus[] = ["open", "overdue"];
export const isInstallmentStatus = (
  value: unknown,
): value is InstallmentStatus =>
  typeof value === "string" &&
  (INSTALLMENT_STATUSES as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// Datas (AAAA-MM-DD no horário de Brasília)

const two = (n: number) => String(n).padStart(2, "0");

export const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export const ymd = (year: number, month: number, day: number) =>
  `${year}-${two(month)}-${two(day)}`;

export const isDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    y >= 2000 &&
    y <= 2200 &&
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= daysInMonth(y, mo)
  );
};

const parts = (date: string) =>
  date.split("-").map(Number) as [number, number, number];

/** Data de hoje (AAAA-MM-DD) em Brasília. */
export function today(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Soma dias a uma data AAAA-MM-DD. */
export function addDays(date: string, days: number) {
  const [y, m, d] = parts(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** Dias entre duas datas (b - a). */
export function daysBetween(a: string, b: string) {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY,
  );
}

/** Vencimento no mês (ano, mês 1-12) com o dia limitado ao fim do mês. */
export function dueIn(year: number, month: number, dueDay: number) {
  return ymd(year, month, Math.min(dueDay, daysInMonth(year, month)));
}

/** Mês somado (mês 1-12). */
export function addMonths(year: number, month: number, months: number) {
  const index = year * 12 + (month - 1) + months;
  return [Math.floor(index / 12), (index % 12) + 1] as const;
}

/** Fim do dia (23:59:59,999) de uma data em Brasília, em ms. */
export function endOfDay(date: string) {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d + 1) + BRASILIA_OFFSET_MS - 1;
}

/** "10/11/2026" */
export function dayLabel(date: string | null | undefined) {
  if (!date) return "";
  const [y, m, d] = parts(date);
  return `${two(d)}/${two(m)}/${y}`;
}

const MONTHS = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];
/** Competência "2026-11" → "nov/2026". */
export function periodLabel(periodKey: string) {
  const [y, m] = periodKey.split("-").map(Number);
  return `${MONTHS[m - 1]}/${y}`;
}

/** "08/11/2026 14:32" em Brasília. */
export function stamp(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/**
 * Vencimentos de uma assinatura de `from` até `until` (inclusive): o primeiro
 * é o dia de vencimento no mês do início (ou no mês seguinte, se já passou);
 * os demais, a cada 1, 3 ou 12 meses, sempre a partir do mês âncora, então o
 * dia 31 vira 28/29 em fevereiro e volta a 31 em março. A competência
 * (period_key, AAAA-MM) é o mês do vencimento: uma parcela por período.
 */
export function dueDates(
  sub: {
    start_date: string;
    due_day: number;
    period: Period;
    bill_from?: string | null;
    end_date?: string | null;
  },
  until: string,
  limit = 400,
) {
  const [sy, sm] = parts(sub.start_date);
  let [ay, am] = [sy, sm] as readonly [number, number];
  if (dueIn(ay, am, sub.due_day) < sub.start_date)
    [ay, am] = addMonths(ay, am, 1);
  const step = PERIOD_MONTHS[sub.period];
  const out: { period_key: string; due_date: string }[] = [];
  for (let k = 0; k < limit; k++) {
    const [y, m] = addMonths(ay, am, k * step);
    const due = dueIn(y, m, sub.due_day);
    if (due > until) break;
    if (sub.end_date && due > sub.end_date) break;
    if (sub.bill_from && due < sub.bill_from) continue;
    out.push({ period_key: `${y}-${two(m)}`, due_date: due });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Valores

/** "R$ 1.234,56" */
export function money(cents: number) {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

export const MAX_CENTS = 100_000_00;

export function cents(value: unknown, what: string, min = 0) {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= MAX_CENTS,
    `${what}: valor em centavos (inteiro, de ${money(min)} a ${money(MAX_CENTS)}).`,
  );
  return value as number;
}

/** Só dígitos, com 55 quando o número veio sem DDI (10 ou 11 dígitos). */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}

// ---------------------------------------------------------------------------
// Regras (chave "mensalidade" de PUT /settings)

export interface MensalidadeSettings {
  /** Forma de cobrança: Pix copia e cola ou link de pagamento. */
  method: "pix" | "link";
  /** Cobrança enviada este número de dias antes do vencimento (0: no dia). */
  days_before: number;
  /** Lembrete no dia do vencimento, com o código de novo. */
  due_today: boolean;
  /** Intervalo entre avisos de atraso, em dias. */
  overdue_every_days: number;
  /** Máximo de avisos de atraso por parcela (0: nenhum). */
  overdue_max: number;
  /** Instruções de pagamento sem cobrança configurada (secretaria, chave Pix…). */
  manual_instructions: string;
  /**
   * Carência: dias depois do vencimento em que o pagador ainda conta como em
   * dia para quem consulta a situação (módulo Suporte, por exemplo).
   */
  grace_days: number;
}

export const MENSALIDADE_DEFAULTS: MensalidadeSettings = {
  method: "pix",
  days_before: 3,
  due_today: true,
  overdue_every_days: 3,
  overdue_max: 3,
  manual_instructions: "",
  grace_days: 0,
};

export function mensalidadeSettings(cfg: any): MensalidadeSettings {
  const raw =
    cfg?.mensalidade && typeof cfg.mensalidade === "object"
      ? cfg.mensalidade
      : {};
  return { ...MENSALIDADE_DEFAULTS, ...raw };
}

const intIn = (value: unknown, min: number, max: number, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max,
    `Mensalidade: ${what} de ${min} a ${max}.`,
  );
  return value as number;
};

/** Validação estrita da chave "mensalidade" em PUT /settings. */
export function validateMensalidadeSettings(
  value: unknown,
): Partial<MensalidadeSettings> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Mensalidade: regras inválidas.",
  );
  const raw = value as any;
  const allowed = new Set(Object.keys(MENSALIDADE_DEFAULTS));
  for (const key of Object.keys(raw))
    requireValue(allowed.has(key), `Mensalidade: chave desconhecida ${key}.`);
  const out: Partial<MensalidadeSettings> = {};
  if (raw.method !== undefined) {
    requireValue(
      raw.method === "pix" || raw.method === "link",
      "Mensalidade: forma de cobrança pix ou link.",
    );
    out.method = raw.method;
  }
  if (raw.days_before !== undefined)
    out.days_before = intIn(raw.days_before, 0, 15, "dias de antecedência");
  if (raw.due_today !== undefined) {
    requireValue(
      typeof raw.due_today === "boolean",
      "Mensalidade: informe se avisa no dia do vencimento.",
    );
    out.due_today = raw.due_today;
  }
  if (raw.overdue_every_days !== undefined)
    out.overdue_every_days = intIn(
      raw.overdue_every_days,
      1,
      30,
      "intervalo entre avisos de atraso",
    );
  if (raw.overdue_max !== undefined)
    out.overdue_max = intIn(
      raw.overdue_max,
      0,
      10,
      "avisos de atraso por parcela",
    );
  if (raw.manual_instructions !== undefined) {
    requireValue(
      typeof raw.manual_instructions === "string" &&
        Array.from(raw.manual_instructions).length <= 500,
      "Mensalidade: instruções de pagamento com até 500 caracteres.",
    );
    out.manual_instructions = raw.manual_instructions.trim();
  }
  if (raw.grace_days !== undefined)
    out.grace_days = intIn(raw.grace_days, 0, 60, "dias de carência");
  return out;
}

// ---------------------------------------------------------------------------
// Documento do pagador

/**
 * CPF (11 dígitos) ou CNPJ (12 caracteres [0-9A-Z] + 2 dígitos, inclusive o
 * alfanumérico da Receita a partir de julho de 2026), com os dígitos
 * conferidos. Aceita pontuação. Devolve null quando não é um documento válido.
 */
export function parseDocument(value: unknown) {
  if (typeof value !== "string") return null;
  const document = value.toUpperCase().replace(/[\s./-]/g, "");
  if (document.length === 11 && validCpf(document))
    return {
      document,
      type: "cpf" as const,
      display: formatDocument(document),
    };
  if (document.length === 14 && validCnpj(document))
    return {
      document,
      type: "cnpj" as const,
      display: formatDocument(document),
    };
  return null;
}

/** Documento válido ou 400 com mensagem para quem digita. */
export function requireDocument(value: unknown) {
  const parsed = parseDocument(value);
  requireValue(parsed, "CPF ou CNPJ inválido: confira os números.");
  return parsed;
}

/** `limit` da listagem: inteiro entre 1 e `max` (fração ou texto vira o padrão). */
export function pageLimit(value: unknown, fallback: number, max: number) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
}

/** Valores de um filtro "a,b,c" sem repetição (listas IN dentro do D1). */
export const csv = (value: unknown, max = 20) =>
  [
    ...new Set(
      String(value || "")
        .split(",")
        .filter(Boolean),
    ),
  ].slice(0, max);

/** Cópia profunda sem as chaves dadas (dados sensíveis nas respostas da API). */
export function withoutKeys(value: any, keys: Set<string>): any {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, keys));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value))
      if (!keys.has(key)) out[key] = withoutKeys(item, keys);
    return out;
  }
  return value;
}

// Documento na listagem para atendentes: só os 2 primeiros e os 2 últimos
// dígitos do CPF (os 6 últimos do CNPJ: filial e verificadores) aparecem.
export function maskDocument(display: string | null | undefined) {
  if (!display) return display ?? null;
  const digits = Array.from(display);
  let seen = 0;
  const total = digits.filter((ch) => /[0-9A-Z]/.test(ch)).length;
  return digits
    .map((ch) => {
      if (!/[0-9A-Z]/.test(ch)) return ch;
      seen++;
      return seen <= 2 || seen > total - (total === 11 ? 2 : 6) ? ch : "*";
    })
    .join("");
}

/** Texto curto, aparado, com limite; vazio permitido quando não obrigatório. */
export function text(
  value: unknown,
  max: number,
  what: string,
  required = false,
): string {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what[0].toUpperCase()}${what.slice(1)}: até ${max} caracteres.`,
  );
  const out = (value as string).trim();
  requireValue(!required || out, `Informe ${what}.`);
  return out;
}
