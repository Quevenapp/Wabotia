// Aritmética exata do numeric do Postgres que as listas de preço usam:
// soma, produto, divisão por potência de 10, round(x, 2) (metade para longe
// do zero), greatest(0, x) e numeric(18,2)::text. Valor = v / 10^s.
import { raise } from "../../../engine/errors.ts";

export interface Num {
  v: bigint;
  s: number;
}

const SHAPE = /^\s*([-+])?(\d*)(?:\.(\d*))?\s*$/;

/** Texto decimal (numeric::text, dec_text) → Num, com as casas que tem. */
export function num(text: string): Num {
  const m = SHAPE.exec(text);
  if (!m || (m[2] === "" && !m[3])) throw new RangeError(`Decimal inválido: ${text}`);
  const frac = m[3] ?? "";
  const v = BigInt((m[2] || "0") + frac);
  return { v: m[1] === "-" ? -v : v, s: frac.length };
}

const pow = (n: number) => 10n ** BigInt(n);
const rescale = (a: Num, s: number): bigint => a.v * pow(s - a.s);

export function add(a: Num, b: Num): Num {
  const s = Math.max(a.s, b.s);
  return { v: rescale(a, s) + rescale(b, s), s };
}
export const neg = (a: Num): Num => ({ v: -a.v, s: a.s });
export const mul = (a: Num, b: Num): Num => ({ v: a.v * b.v, s: a.s + b.s });
/** a / 10^k (exato). */
export const shift = (a: Num, k: number): Num => ({ v: a.v, s: a.s + k });

/** round(a, s): metade para longe do zero; a escala passa a ser s. */
export function round(a: Num, s: number): Num {
  if (a.s <= s) return { v: rescale(a, s), s };
  const d = pow(a.s - s);
  const abs = a.v < 0n ? -a.v : a.v;
  let q = abs / d;
  if ((abs % d) * 2n >= d) q += 1n;
  return { v: a.v < 0n ? -q : q, s };
}

export const sign = (a: Num) => (a.v > 0n ? 1 : a.v < 0n ? -1 : 0);

/** Comparação numérica (8.0000 = 8). */
export function compareNum(a: Num, b: Num) {
  const s = Math.max(a.s, b.s);
  const x = rescale(a, s),
    y = rescale(b, s);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** numeric::text: as casas da escala. */
export function text(a: Num): string {
  const negative = a.v < 0n;
  const digits = (negative ? -a.v : a.v).toString().padStart(a.s + 1, "0");
  const out = a.s ? `${digits.slice(0, -a.s)}.${digits.slice(-a.s)}` : digits;
  return (negative ? "-" : "") + out;
}

/** x::numeric(18,2)::text: arredonda a 2 casas; mais de 16 inteiros → 22003. */
export function numeric18_2(a: Num): string {
  const r = round(a, 2);
  const abs = r.v < 0n ? -r.v : r.v;
  if (abs >= 10n ** 18n) raise("22003", "numeric field overflow");
  return text(r);
}

/** greatest(0, x): o 0 vence o empate (o primeiro argumento fica). */
export const atLeastZero = (a: Num): Num => (sign(a) > 0 ? a : { v: 0n, s: 0 });
