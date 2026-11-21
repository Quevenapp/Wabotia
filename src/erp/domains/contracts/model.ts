// Contratos de serviço (parte Contratos): as contas puras, sem banco. Valores
// em centavos (inteiros, como o Financeiro), quantidades na escala 6 (como o
// Estoque) e percentuais na escala 4. Datas civis "AAAA-MM-DD" em UTC (sem
// fuso: são dias, não instantes). Arredondamento metade para longe do zero.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export const QTY = 6;
export const PCT = 4;

export const STATUSES = ["draft", "active", "suspended", "ended"] as const;
export type ContractStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Readonly<Record<ContractStatus, string>> = Object.freeze({
  draft: "Rascunho", active: "Ativo", suspended: "Suspenso", ended: "Encerrado",
});

export const PERIODICITIES = ["monthly", "bimonthly", "quarterly", "semiannual", "annual"] as const;
export type Periodicity = (typeof PERIODICITIES)[number];
export const PERIOD_MONTHS: Readonly<Record<Periodicity, number>> = Object.freeze({ monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, annual: 12 });
export const PERIODICITY_LABELS: Readonly<Record<Periodicity, string>> = Object.freeze({
  monthly: "Mensal", bimonthly: "Bimestral", quarterly: "Trimestral", semiannual: "Semestral", annual: "Anual",
});

export const INDICES = ["ipca", "igpm", "inpc", "fixed"] as const;
export type AdjustmentIndex = (typeof INDICES)[number];
export const INDEX_LABELS: Readonly<Record<AdjustmentIndex, string>> = Object.freeze({
  ipca: "IPCA", igpm: "IGP-M", inpc: "INPC", fixed: "Percentual fixo",
});
/** Índices que a pessoa informa na tabela de índices (o fixo fica no próprio contrato). */
export const TABLE_INDICES: readonly AdjustmentIndex[] = ["ipca", "igpm", "inpc"];

/** Ações de situação: de onde cada uma parte e para onde vai. */
export const STATUS_ACTIONS: Readonly<Record<string, { from: readonly ContractStatus[]; to: ContractStatus }>> = Object.freeze({
  activate: { from: ["draft"], to: "active" },
  suspend: { from: ["active"], to: "suspended" },
  resume: { from: ["suspended"], to: "active" },
  end: { from: ["draft", "active", "suspended"], to: "ended" },
});

// ---------------------------------------------------------------------------
// Números

const QTY_TEXT = /^(0|[1-9][0-9]{0,11})([.,][0-9]{1,6})?$/;
const MONEY_TEXT = /^(0|[1-9][0-9]{0,10})([.,][0-9]{1,2})?$/;
const PCT_TEXT = /^-?(0|[1-9][0-9]{0,2})([.,][0-9]{1,4})?$/;

function scaled(text: string, scale: number): bigint {
  const negative = text.startsWith("-");
  const [int, frac = ""] = text.replace(/^-/, "").replace(",", ".").split(".");
  const value = BigInt(int) * 10n ** BigInt(scale) + BigInt((frac + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -value : value;
}
function formatted(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const frac = (abs % base).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${abs / base}${scale ? "." + frac : ""}`;
}
const asText = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(value) : value);

/** "12,5" ou "12.5" (até 12 inteiros e 6 casas) → escala 6; inválido: null. */
export function parseQuantity(value: unknown): bigint | null {
  const text = asText(value);
  if (typeof text !== "string" || !QTY_TEXT.test(text.trim())) return null;
  return scaled(text.trim(), QTY);
}
/** "1.234,56" não; "1234.56" ou "1234,56" (até 2 casas) → centavos; inválido: null. */
export function parseMoney(value: unknown): number | null {
  const text = asText(value);
  if (typeof text !== "string" || !MONEY_TEXT.test(text.trim())) return null;
  return Number(scaled(text.trim(), 2));
}
/** Percentual com até 4 casas (−999,9999 a 999,9999) → escala 4; inválido: null. */
export function parsePercent(value: unknown): bigint | null {
  const text = asText(value);
  if (typeof text !== "string" || !PCT_TEXT.test(text.trim())) return null;
  return scaled(text.trim(), PCT);
}
export const qtyText = (v: bigint) => formatted(v, QTY);
export const pctText = (v: bigint) => formatted(v, PCT);
export const moneyText = (cents: number) => formatted(BigInt(cents), 2);

/** round(n/d) com metade para longe do zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  const negative = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n, b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return negative ? -q : q;
}

/** Total de uma linha: quantidade (escala 6) × valor unitário (centavos) → centavos. */
export const lineTotal = (quantity: bigint, unitCents: number) => Number(roundDiv(quantity * BigInt(unitCents), 10n ** BigInt(QTY)));

/** Valor reajustado: centavos × (1 + percentual/100), arredondado ao centavo. */
export function adjusted(cents: number, percent: bigint): number {
  const hundred = 100n * 10n ** BigInt(PCT);
  return Number(roundDiv(BigInt(cents) * (hundred + percent), hundred));
}

// ---------------------------------------------------------------------------
// Datas civis

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const addDays = (d: string, n: number) => fmt(new Date(toDate(d).getTime() + n * 86_400_000));
/** Mesmo dia `n` meses depois; o dia que não existe no mês vira o último (31/01 + 1 mês = 28 ou 29/02). */
export function addMonths(d: string, n: number, day = Number(d.slice(8, 10))): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12), month = ((m % 12) + 12) % 12;
  return fmt(new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month + 1)))));
}
/** Meses inteiros de `from` até `to` (o dia de `to` ainda não alcançado não conta). */
export function monthsBetween(from: string, to: string): number {
  let months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  if (addMonths(from, months) > to) months -= 1;
  return months;
}
const MONTH_NAMES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "2027-03-10" → "mar/2027". */
export const monthLabel = (d: string) => `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]}/${d.slice(0, 4)}`;
/** "10/03/2027". */
export const dateLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Início do período `index` (0 = o primeiro), contado do início da vigência, no dia do início. */
export const periodStart = (anchor: string, periodicity: Periodicity, index: number) => addMonths(anchor, index * PERIOD_MONTHS[periodicity], Number(anchor.slice(8, 10)));
/** Último dia do período que começa em `start`. */
export const periodEnd = (anchor: string, periodicity: Periodicity, start: string) =>
  addDays(periodStart(anchor, periodicity, periodIndex(anchor, periodicity, start) + 1), -1);
/** Índice do período que contém `day` (o primeiro, se `day` vier antes do início). */
export function periodIndex(anchor: string, periodicity: Periodicity, day: string): number {
  if (day <= anchor) return 0;
  const months = PERIOD_MONTHS[periodicity];
  let index = Math.floor(monthsBetween(anchor, day) / months);
  while (periodStart(anchor, periodicity, index + 1) <= day) index += 1;
  while (index > 0 && periodStart(anchor, periodicity, index) > day) index -= 1;
  return index;
}
/**
 * Vencimento do período: o dia de vencimento no mês em que o período começa;
 * se esse dia já passou no começo do período, o do mês seguinte. Dia que não
 * existe no mês (31 em abril) vira o último dia do mês.
 */
export function dueDate(start: string, dueDay: number): string {
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const inMonth = `${start.slice(0, 7)}-${String(Math.min(dueDay, daysInMonth(y, m))).padStart(2, "0")}`;
  return inMonth >= start ? inMonth : addMonths(`${start.slice(0, 7)}-01`, 1, dueDay);
}
/** Dia em que a conta do período é gerada: o começo do período ou o vencimento, o que vier antes. */
export const billingDate = (start: string, due: string) => (due < start ? due : start);

/**
 * Vigência renovada: o novo fim é o fim atual mais o prazo (em meses). Sem
 * prazo informado, o prazo é a duração atual (do início ao fim, em meses
 * inteiros; pelo menos 1).
 */
export function renewedEnd(startsOn: string, endsOn: string, termMonths: number | null): string {
  const term = termMonths && termMonths > 0 ? termMonths : Math.max(1, monthsBetween(startsOn, addDays(endsOn, 1)));
  return addDays(addMonths(addDays(endsOn, 1), term), -1);
}

/** Primeiro mês de aniversário (AAAA-MM) em que o contrato pode ser reajustado: 12 meses depois do início. */
export function firstAdjustmentMonth(startsOn: string, month: number): string {
  const earliest = addMonths(`${startsOn.slice(0, 7)}-01`, 12);
  const year = Number(earliest.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, "0")}`;
  return candidate >= earliest.slice(0, 7) ? candidate : `${year + 1}-${String(month).padStart(2, "0")}`;
}
/**
 * Mês de referência do próximo reajuste (AAAA-MM): o primeiro aniversário
 * depois do último reajuste aplicado (ou a partir de 12 meses do início).
 */
export function nextAdjustmentMonth(startsOn: string, month: number, last: string | null): string {
  const first = firstAdjustmentMonth(startsOn, month);
  if (!last || last < first) return first;
  return `${Number(last.slice(0, 4)) + 1}-${String(month).padStart(2, "0")}`;
}
