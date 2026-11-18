import { ApiError } from "../../types";

export function invalid(field: string): never {
  throw new ApiError(400, "invalid_request", `Confira o campo ${field}.`);
}
export function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k))) invalid("dados");
  return value as Record<string, any>;
}
export function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value.trim();
}
export const id = (v: unknown) => text(v, "identificador", 100);
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function number(value: unknown, field: string, min: number, max: number, scale = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max ||
      Math.abs(value * 10 ** scale - Math.round(value * 10 ** scale)) > 1e-7) invalid(field);
  return value;
}
export function choice<T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (!options.includes(value as T)) invalid(field);
  return value as T;
}
export function date(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) invalid("data");
  return v;
}
export function time(v: unknown): string {
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) invalid("horário");
  return v;
}
export interface Period { id: string; name: string; start: string; end: string }
export interface Slot { day: number; start: string; end: string }
export interface Rule {
  method: "simple" | "weighted";
  decimals: number;
  rounding: "half_up" | "truncate" | "ceil";
  recovery: { mode: "none" | "best" | "weighted"; base_weight: number; recovery_weight: number; cap: number };
}
export const defaultRule: Rule = {
  method: "simple", decimals: 1, rounding: "half_up",
  recovery: { mode: "none", base_weight: 1, recovery_weight: 1, cap: 10 },
};
export function rule(v: unknown): Rule {
  const r = object(v, ["method", "decimals", "rounding", "recovery"]);
  const recovery = object(r.recovery, ["mode", "base_weight", "recovery_weight", "cap"]);
  return {
    method: choice(r.method, "média", ["simple", "weighted"]),
    decimals: number(r.decimals, "casas decimais", 0, 2),
    rounding: choice(r.rounding, "arredondamento", ["half_up", "truncate", "ceil"]),
    recovery: {
      mode: choice(recovery.mode, "recuperação", ["none", "best", "weighted"]),
      base_weight: number(recovery.base_weight, "peso da média", 0.01, 100, 2),
      recovery_weight: number(recovery.recovery_weight, "peso da recuperação", 0.01, 100, 2),
      cap: number(recovery.cap, "limite da recuperação", 0, 10, 2),
    },
  };
}
export function periods(v: unknown, start: string, end: string): Period[] {
  if (!Array.isArray(v) || !v.length || v.length > 8) invalid("períodos (1 a 8)");
  const out = v.map(x => {
    const p = object(x, ["id", "name", "start", "end"]);
    return { id: id(p.id), name: text(p.name, "período", 80), start: date(p.start), end: date(p.end) };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (new Set(out.map(p => p.id)).size !== out.length || out.some((p, i) =>
    p.start < start || p.end > end || p.start > p.end || (i > 0 && out[i - 1].end >= p.start))) invalid("períodos sobrepostos ou fora da vigência");
  return out;
}
export function schedule(v: unknown): Slot[] {
  if (!Array.isArray(v) || !v.length || v.length > 20) invalid("horários (1 a 20)");
  const out = v.map(x => {
    const s = object(x, ["day", "start", "end"]);
    return { day: number(s.day, "dia da semana", 0, 6), start: time(s.start), end: time(s.end) };
  });
  if (out.some((s, i) => s.start >= s.end || out.some((t, j) => i !== j && overlaps(s, t)))) invalid("horários sobrepostos");
  return out;
}
export const overlaps = (a: Slot, b: Slot) => a.day === b.day && a.start < b.end && b.start < a.end;
export function page(query: Record<string, string>, scope: string) {
  if (Object.keys(query).some(k => !["cursor", "limit"].includes(k))) invalid("filtro");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  number(limit, "limite", 1, 100);
  let after = "";
  if (query.cursor) {
    try {
      const parts = JSON.parse(atob(query.cursor));
      if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== scope) throw Error();
      after = id(parts[1]);
    } catch { invalid("cursor"); }
  }
  return { limit, after, cursor: (last: string) => btoa(JSON.stringify([scope, last])) };
}

export interface Mark {
  id: string; title: string; max_score: number; weight: number; kind: "regular" | "recovery";
  status: "graded" | "absent" | "exempt" | "pending"; score: number | null;
}
// Aritmética racional: nem normalização nem média são arredondadas antes do final.
type Fraction = [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
const f = (n: bigint, d = 1n): Fraction => { const g = gcd(n, d); return [n / g, d / g]; };
const decimal = (n: number) => f(BigInt(Math.round(n * 100)), 100n);
const add = (a: Fraction, b: Fraction) => f(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const mul = (a: Fraction, b: Fraction) => f(a[0] * b[0], a[1] * b[1]);
const div = (a: Fraction, b: Fraction) => f(a[0] * b[1], a[1] * b[0]);
const compare = (a: Fraction, b: Fraction) => a[0] * b[1] - b[0] * a[1];
const show = (a: Fraction) => `${a[0]}/${a[1]}`;

export function calculate(input: Mark[], config: Rule) {
  rule(config);
  if (input.length > 100) invalid("avaliações");
  for (const m of input) {
    number(m.max_score, "escala", 0.01, 10000, 2);
    number(m.weight, "peso", 0.01, 100, 2);
    if (m.status === "graded") number(m.score, "nota", 0, m.max_score, 2);
  }
  const regular = input.filter(m => m.kind === "regular" && m.status !== "exempt");
  const recovery = input.filter(m => m.kind === "recovery" && m.status !== "exempt");
  if (recovery.length > 1 || (recovery.length && config.recovery.mode === "none")) invalid("recuperação");
  if (!regular.length || [...regular, ...recovery].some(m => m.status !== "graded"))
    return { final: null, exact: null, explanation: "Pendente: nota ausente ou falta em avaliação não equivale a zero.", inputs: input, rule: config };
  const normalized = (m: Mark) => div(mul(decimal(m.score!), f(10n)), decimal(m.max_score));
  let sum = f(0n), weights = f(0n);
  for (const m of regular) {
    const weight = config.method === "weighted" ? decimal(m.weight) : f(1n);
    sum = add(sum, mul(normalized(m), weight)); weights = add(weights, weight);
  }
  let result = div(sum, weights);
  const parts = ["Escala final: 0 a 10.", ...regular.map(m => `${m.title}: ${m.score} / ${m.max_score} × 10; peso ${config.method === "weighted" ? m.weight : 1}.`),
    `Média ${config.method === "simple" ? "simples" : "ponderada"}: soma das notas normalizadas × pesos / soma dos pesos = ${show(result)}.`];
  if (recovery.length) {
    const r = normalized(recovery[0]);
    if (config.recovery.mode === "best") {
      parts.push(`Recuperação: maior entre ${show(result)} e ${show(r)}.`);
      if (compare(r, result) > 0n) result = r;
    } else {
      const a = decimal(config.recovery.base_weight), b = decimal(config.recovery.recovery_weight);
      parts.push(`Recuperação: (${show(result)} × ${config.recovery.base_weight} + ${show(r)} × ${config.recovery.recovery_weight}) / ${config.recovery.base_weight + config.recovery.recovery_weight}.`);
      result = div(add(mul(result, a), mul(r, b)), add(a, b));
    }
    if (compare(result, decimal(config.recovery.cap)) > 0n) result = decimal(config.recovery.cap);
    parts.push(`Limite após recuperação: ${config.recovery.cap}.`);
  }
  const scale = 10n ** BigInt(config.decimals), scaled = result[0] * scale;
  let rounded = scaled / result[1];
  const rest = scaled % result[1];
  if ((config.rounding === "half_up" && rest * 2n >= result[1]) || (config.rounding === "ceil" && rest > 0n)) rounded++;
  const final = Number(rounded) / Number(scale);
  parts.push(`Valor exato: ${show(result)}. Arredondamento somente ao final: ${{ half_up: "metade para cima", truncate: "truncar", ceil: "para cima" }[config.rounding]}, ${config.decimals} casa(s) = ${final.toFixed(config.decimals)}.`);
  if (input.some(m => m.status === "exempt")) parts.push("Avaliações dispensadas foram excluídas do denominador.");
  return { final, exact: show(result), explanation: parts.join(" "), inputs: input, rule: config };
}

export function frequency(rows: { status: string; attendance: string | null }[], justifiedCounts: boolean) {
  const held = rows.filter(r => r.status === "held");
  const present = held.filter(r => r.attendance === "present").length;
  const justified = held.filter(r => r.attendance === "justified").length;
  const absent = held.filter(r => r.attendance === "absent").length;
  const pending = held.length - present - justified - absent;
  const numerator = present + (justifiedCounts ? justified : 0);
  return { held: held.length, present, absent, justified, pending,
    percent: pending || !held.length ? null : Math.round(numerator / held.length * 10000) / 100,
    explanation: `(${present} presenças${justifiedCounts ? ` + ${justified} justificadas` : ""}) / ${held.length} aulas realizadas × 100. Canceladas e previstas não contam; ${pending} chamada(s) pendente(s).` };
}
