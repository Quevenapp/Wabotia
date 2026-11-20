// OS4: regras puras do contrato de manutenção e da execução agendada
// (docs/ORDEM-DE-SERVICO.md, "Contrato de manutenção"). Sem banco, para
// testar e para o painel ler o mesmo contrato.
import { ApiError, requireValue } from "../../../types";
import { BRASILIA_OFFSET_MS } from "../../../business-time";

export const CONTRACT_STATUSES = ["active", "suspended", "ended"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  active: "Vigente", suspended: "Suspenso", ended: "Encerrado",
};

export type CoverageUnit = "visits" | "hours";
export type CoveragePeriod = "month" | "quarter" | "year";
export type ExcessRule = "quote" | "approval";

export interface ContractCoverage {
  /** Modelos de ordem incluídos; vazio: todos. */
  type_ids: string[];
  /** Serviços incluídos, em texto, para mostrar e imprimir. */
  services: string;
  unit: CoverageUnit;
  /** Limite por período: visitas, ou minutos quando a unidade é horas. */
  limit: number;
  period: CoveragePeriod;
  /** Excedente: cobra pelo orçamento normal, ou avisa e pede aprovação. */
  excess: ExcessRule;
  /** Preço de cada visita (ou hora) excedente; null: a equipe dá o preço. */
  excess_unit_cents: number | null;
}

export type VisitRule =
  | { kind: "every_days"; days: number; lead_days: number; type_id: string; item: string; first_on?: string | null }
  | { kind: "month_day"; day: number; lead_days: number; type_id: string; item: string; first_on?: string | null };

export interface ContractInput {
  contact_id?: unknown;
  customer_name?: unknown;
  object_ids?: unknown;
  plan_id?: unknown;
  subscription_id?: unknown;
  coverage?: unknown;
  starts_on?: unknown;
  ends_on?: unknown;
  adjustment?: unknown;
  overdue_policy?: unknown;
  terms?: unknown;
  visits?: unknown;
}

export const PERIOD_LABELS: Record<CoveragePeriod, { label: string; current: string }> = {
  month: { label: "por mês", current: "neste mês" },
  quarter: { label: "por trimestre", current: "neste trimestre" },
  year: { label: "por ano", current: "neste ano" },
};
export const EXCESS_LABELS: Record<ExcessRule, string> = {
  quote: "O excedente entra no orçamento normal da ordem, com preço.",
  approval: "O excedente entra no orçamento com preço e o cliente precisa aprovar antes da execução.",
};

const invalid = (message: string) => new ApiError(400, "invalid_request", message);
export const civilDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const typeId = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const uuidLike = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f]/.test(value);
const text = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Array.from(value.trim()).length > max) throw invalid(`${what}: até ${max} caracteres.`);
  return value.trim();
};

/** Hoje em Brasília (AAAA-MM-DD). */
export function civilToday(at: number) {
  return new Date(at - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}
export function addCivilDays(date: string, days: number) {
  const at = new Date(date + "T12:00:00Z");
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
function lastDay(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/** Mesmo dia `months` meses depois (31 vira o último dia do mês). */
export function addCivilMonths(date: string, months: number, day = Number(date.slice(8, 10))) {
  const [y, m] = date.split("-").map(Number);
  const index = y * 12 + (m - 1) + months, year = Math.floor(index / 12), month = index % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay(year, month))).padStart(2, "0")}`;
}
export const brDate = (date: string | null | undefined) => date ? date.split("-").reverse().join("/") : "";

/** Chave do período de uso: 2026-11, 2026-T4 ou 2026. */
export function periodKey(period: CoveragePeriod, date: string) {
  const [y, m] = date.split("-");
  if (period === "year") return y;
  if (period === "quarter") return `${y}-T${Math.floor((Number(m) - 1) / 3) + 1}`;
  return `${y}-${m}`;
}

/** "2 visitas", "1 visita", "1,5 hora", "5 horas". */
export function unitsLabel(unit: CoverageUnit, units: number) {
  if (unit === "visits") return `${units} ${units === 1 ? "visita" : "visitas"}`;
  const hours = units / 60;
  const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/, "").replace(".", ",");
  return `${shown} ${hours < 2 ? "hora" : "horas"}`;
}
const unitsNumber = (unit: CoverageUnit, units: number) => unit === "visits" ? String(units)
  : (Number.isInteger(units / 60) ? String(units / 60) : (units / 60).toFixed(2).replace(/0+$/, "").replace(".", ","));

/** "1 de 2 visitas usadas neste mês". */
export function usageText(coverage: ContractCoverage, used: number) {
  const noun = coverage.unit === "visits" ? (coverage.limit === 1 ? "visita usada" : "visitas usadas") : "horas usadas";
  return `${unitsNumber(coverage.unit, Math.min(used, coverage.limit))} de ${unitsNumber(coverage.unit, coverage.limit)} ${noun} ${PERIOD_LABELS[coverage.period].current}`;
}

/** Parte coberta e excedente de um uso, dado o já usado no período. */
export function splitUsage(coverage: ContractCoverage, used: number, units: number) {
  const remaining = Math.max(0, coverage.limit - used);
  const covered = Math.min(units, remaining);
  return { covered, excess: units - covered, remaining };
}

/** Horas digitadas (até duas casas) em minutos. */
export function hoursToMinutes(value: unknown, what = "Horas") {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6)
    throw invalid(`${what}: número maior que zero, até 1000, com até duas casas.`);
  return Math.round(value * 60);
}

export function validateCoverage(value: unknown, typeIds: readonly string[]): ContractCoverage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Informe o que o contrato cobre.");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["type_ids", "services", "unit", "limit", "period", "excess", "excess_unit_cents"].includes(key)) throw invalid(`Cobertura: campo desconhecido ${key}.`);
  const ids = raw.type_ids === undefined || raw.type_ids === null ? [] : raw.type_ids;
  if (!Array.isArray(ids) || ids.length > 21 || !ids.every(typeId)) throw invalid("Cobertura: modelos inválidos.");
  for (const id of ids as string[]) if (!typeIds.includes(id)) throw invalid(`Cobertura: o modelo ${id} não existe nesta área.`);
  const unit = raw.unit ?? "visits";
  if (unit !== "visits" && unit !== "hours") throw invalid("Cobertura: unidade visits ou hours.");
  let limit: number;
  if (unit === "visits") {
    if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 999) throw invalid("Cobertura: limite de 1 a 999 visitas por período.");
    limit = raw.limit as number;
  } else limit = hoursToMinutes(raw.limit, "Cobertura: limite de horas");
  const period = raw.period ?? "month";
  if (!["month", "quarter", "year"].includes(period as string)) throw invalid("Cobertura: período month, quarter ou year.");
  const excess = raw.excess ?? "quote";
  if (excess !== "quote" && excess !== "approval") throw invalid("Cobertura: excedente quote ou approval.");
  const price = raw.excess_unit_cents ?? null;
  if (price !== null && (!Number.isInteger(price) || (price as number) < 0 || (price as number) > 100_000_000)) throw invalid("Cobertura: preço do excedente em centavos (inteiro, até R$ 1.000.000,00).");
  return { type_ids: [...new Set(ids as string[])], services: text(raw.services, 1000, "Serviços incluídos"), unit, limit,
    period: period as CoveragePeriod, excess, excess_unit_cents: price as number | null };
}

export function validateVisits(value: unknown, typeIds: readonly string[]): VisitRule | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Visitas programadas inválidas.");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!["kind", "days", "day", "lead_days", "type_id", "item", "first_on"].includes(key)) throw invalid(`Visitas programadas: campo desconhecido ${key}.`);
  const lead = raw.lead_days ?? 7;
  if (!Number.isInteger(lead) || (lead as number) < 0 || (lead as number) > 60) throw invalid("Visitas programadas: antecedência de 0 a 60 dias.");
  const type = raw.type_id ?? "service_order";
  if (!typeId(type) || !typeIds.includes(type as string)) throw invalid("Visitas programadas: escolha o modelo da ordem de manutenção.");
  const item = text(raw.item, 200, "Visitas programadas: descrição") || "Manutenção programada";
  const first = raw.first_on ?? null;
  if (first !== null && !civilDate(first)) throw invalid("Visitas programadas: primeira visita em AAAA-MM-DD.");
  const base = { lead_days: lead as number, type_id: type as string, item, first_on: first as string | null };
  if (raw.kind === "every_days") {
    if (!Number.isInteger(raw.days) || (raw.days as number) < 1 || (raw.days as number) > 365) throw invalid("Visitas programadas: a cada 1 a 365 dias.");
    return { kind: "every_days", days: raw.days as number, ...base };
  }
  if (raw.kind === "month_day") {
    if (!Number.isInteger(raw.day) || (raw.day as number) < 1 || (raw.day as number) > 31) throw invalid("Visitas programadas: dia do mês de 1 a 31.");
    return { kind: "month_day", day: raw.day as number, ...base };
  }
  throw invalid("Visitas programadas: escolha a cada N dias (every_days) ou todo dia D (month_day).");
}

/** Primeira visita: a data informada, ou o início (a cada N dias), ou o primeiro dia D a partir do início. */
export function firstVisit(rule: VisitRule, startsOn: string) {
  if (rule.first_on) return rule.first_on;
  if (rule.kind === "every_days") return startsOn;
  const sameMonth = addCivilMonths(startsOn, 0, rule.day);
  return sameMonth >= startsOn ? sameMonth : addCivilMonths(startsOn, 1, rule.day);
}
/** Visita seguinte a uma data da série (sem deslizar o calendário). */
export function nextVisit(rule: VisitRule, from: string) {
  return rule.kind === "every_days" ? addCivilDays(from, rule.days) : addCivilMonths(from, 1, rule.day);
}
/** A visita já entra em "Manutenções a abrir": dentro da antecedência e da vigência. */
export function visitDue(rule: VisitRule | null, nextOn: string | null, today: string, endsOn: string | null) {
  if (!rule || !nextOn) return false;
  if (endsOn && nextOn > endsOn) return false;
  return addCivilDays(nextOn, -rule.lead_days) <= today;
}
export function visitRuleText(rule: VisitRule | null) {
  if (!rule) return "";
  const when = rule.kind === "every_days" ? `A cada ${rule.days} ${rule.days === 1 ? "dia" : "dias"}` : `Todo dia ${rule.day}`;
  return `${when}, aberta para confirmar ${rule.lead_days ? `${rule.lead_days} ${rule.lead_days === 1 ? "dia" : "dias"} antes` : "no dia"}`;
}

export interface Adjustment { bp: number; on: string }
/** Reajuste anual informado: percentual (até duas casas) e data; padrão, um ano após o início. */
export function validateAdjustment(value: unknown, startsOn: string): Adjustment | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Reajuste inválido.");
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!["percent", "on"].includes(key)) throw invalid(`Reajuste: campo desconhecido ${key}.`);
  const percent = raw.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100 || Math.abs(percent * 100 - Math.round(percent * 100)) > 1e-6)
    throw invalid("Reajuste: percentual de 0 a 100, com até duas casas.");
  const on = raw.on ?? addCivilMonths(startsOn, 12);
  if (!civilDate(on)) throw invalid("Reajuste: data em AAAA-MM-DD.");
  return { bp: Math.round(percent * 100), on };
}
export const percentText = (bp: number) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",")}%`;

export interface ValidContract {
  contact_id: string;
  customer_name: string;
  object_ids: string[];
  plan_id: string;
  subscription_id: string | null;
  coverage: ContractCoverage;
  starts_on: string;
  ends_on: string | null;
  adjustment: Adjustment | null;
  overdue_policy: "warn" | "block";
  terms: string;
  visits: VisitRule | null;
}

/** Validação do corpo de criar (completo) ou editar (parcial sobre o atual). */
export function validateContract(input: ContractInput, typeIds: readonly string[], current?: ValidContract): ValidContract {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Contrato inválido.");
  const has = (key: keyof ContractInput) => Object.hasOwn(input, key) && input[key] !== undefined;
  const contact = has("contact_id") ? input.contact_id : current?.contact_id;
  if (!uuidLike(contact)) throw invalid("Escolha o cliente do contrato no cadastro.");
  if (current && contact !== current.contact_id) throw new ApiError(400, "immutable_field", "O cliente do contrato não muda. Encerre este e crie outro.");
  const plan = has("plan_id") ? input.plan_id : current?.plan_id;
  if (!uuidLike(plan)) throw invalid("Escolha o plano da Mensalidade.");
  const objects = has("object_ids") ? input.object_ids : current?.object_ids ?? [];
  if (!Array.isArray(objects) || objects.length > 20 || !objects.every(uuidLike)) throw invalid("Objetos do contrato: até 20.");
  const starts = has("starts_on") ? input.starts_on : current?.starts_on;
  if (!civilDate(starts)) throw invalid("Início da vigência em AAAA-MM-DD.");
  const ends = has("ends_on") ? input.ends_on ?? null : current?.ends_on ?? null;
  if (ends !== null && (!civilDate(ends) || ends < starts)) throw invalid("Fim da vigência em AAAA-MM-DD, depois do início (ou vazio: indeterminado).");
  const policy = has("overdue_policy") ? input.overdue_policy : current?.overdue_policy ?? "warn";
  if (policy !== "warn" && policy !== "block") throw invalid("Assinatura em atraso: warn (só avisa) ou block (bloqueia a cobertura).");
  const subscription = has("subscription_id") ? input.subscription_id ?? null : current?.subscription_id ?? null;
  if (subscription !== null && !uuidLike(subscription)) throw invalid("Assinatura inválida.");
  return {
    contact_id: contact as string,
    customer_name: has("customer_name") ? text(input.customer_name, 120, "Nome do cliente") : current?.customer_name ?? "",
    object_ids: [...new Set(objects as string[])],
    plan_id: plan as string,
    subscription_id: subscription as string | null,
    coverage: has("coverage") ? validateCoverage(input.coverage, typeIds) : current?.coverage ?? validateCoverage(undefined, typeIds),
    starts_on: starts as string,
    ends_on: ends as string | null,
    adjustment: Object.hasOwn(input, "adjustment") ? validateAdjustment(input.adjustment, starts as string) : current?.adjustment ?? null,
    overdue_policy: policy,
    terms: has("terms") ? text(input.terms, 4000, "Condições") : current?.terms ?? "",
    visits: Object.hasOwn(input, "visits") ? validateVisits(input.visits, typeIds) : current?.visits ?? null,
  };
}

/** Vigente na data: ativo, já começou e não terminou. */
export function inForce(row: { status: string; starts_on: string; ends_on: string | null }, today: string) {
  return row.status === "active" && row.starts_on <= today && (!row.ends_on || row.ends_on >= today);
}

// ---------------------------------------------------------------------------
// Execução agendada

/** Expressão SQL do horário efetivo da execução (alias s de os_order_schedules): o da Agenda, lido na hora, ou a data combinada. */
export const SCHEDULED_AT_SQL = `CASE WHEN s.mode='agenda' THEN (SELECT a.starts FROM agenda_appointments a WHERE a.profile_id=s.profile_id AND a.id=s.appointment_id AND a.status IN ('booked','confirmed')) ELSE s.starts END`;
/** Subconsulta do horário efetivo para a lista de ordens (tabela os_orders). */
export const ORDER_SCHEDULED_AT_SQL = `(SELECT ${SCHEDULED_AT_SQL} FROM os_order_schedules s WHERE s.profile_id=os_orders.profile_id AND s.order_id=os_orders.id AND s.state='active')`;

/** "22/11/2026 às 14:30", no horário de Brasília. */
export function whenText(at: number) {
  const d = new Date(at - BRASILIA_OFFSET_MS), two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} às ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function requireInstant(value: unknown, what: string) {
  requireValue(Number.isSafeInteger(value) && (value as number) > 0, `${what}: informe o instante em milissegundos.`);
  return value as number;
}
