// Decimal exato: BigInt na escala da coluna. Nada de multiplicar ou arredondar
// valor escalado no SQL (PLANO-FAGOO-MOTOR.md, seção 3). Arredondamento
// metade para longe do zero, como o numeric do Postgres.

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** "1.5" na escala 6 → 1500000n (arredonda como numeric(…,6)). */
export function toScaled(text: string, scale: number): bigint {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new RangeError(`Decimal inválido: ${text}`);
  const frac = (m[3] || "") + "0".repeat(scale + 1);
  let v = BigInt(m[2] + frac.slice(0, scale));
  if (Number(frac[scale]) >= 5) v += 1n;
  return m[1] && v !== 0n ? -v : v;
}

/** 1500000n na escala 6 → "1.500000" (como numeric(…,6)::text). */
export function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const out = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return (neg ? "-" : "") + out;
}

/** Valor lido da coluna (número ≤ 2^53 ou texto i64) → BigInt. */
export const fromColumn = (value: unknown): bigint =>
  typeof value === "bigint" ? value : BigInt(value as number | string);

/** BigInt → parâmetro do SQLite (texto; a coluna STRICT vira inteiro). */
export const toParam = (value: bigint): string => value.toString();

/**
 * Muda a escala de um valor escalado, arredondando metade para longe do zero
 * (round/::numeric(p,s) do Postgres): 1234567n na escala 6 → escala 2 = 123n.
 */
export function rescale(v: bigint, from: number, to: number): bigint {
  if (to >= from) return v * 10n ** BigInt(to - from);
  const d = 10n ** BigInt(from - to);
  const neg = v < 0n;
  const a = neg ? -v : v;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/** numeric sem escala fixa, só para comparar com zero e somar: escala 30. */
export const exact = (text: string) => toScaled(text, 30);

/**
 * Coluna dec_text (decimal acima do i64, em TEXT): o mesmo texto que
 * numeric::text do Postgres. Com escala fixa (numeric(p,s)) arredonda e
 * completa até s casas; sem ela (numeric puro) conserva as casas de entrada.
 * Mesma regra de scripts/erp/gen-sqlite-lib.mjs decText.
 */
export function decText(text: string, scale: number, fixed: boolean): string {
  const m = /^\s*([-+])?(\d*)(?:\.(\d*))?\s*$/.exec(text);
  if (!m || (m[2] === "" && !m[3])) throw new RangeError(`Decimal inválido: ${text}`);
  if (fixed) return formatScaled(toScaled(text.trim().replace(/^\+/, "").replace(/^(-?)\./, "$10."), scale), scale);
  const int = m[2].replace(/^0+(?=\d)/, "") || "0";
  const frac = m[3] ?? "";
  const zero = /^0*$/.test(int + frac);
  return (m[1] === "-" && !zero ? "-" : "") + int + (frac ? "." + frac : "");
}

/** Compara dois decimais em texto (dec_text): -1, 0 ou 1. */
export function compareDec(a: string, b: string): number {
  const x = exact(a),
    y = exact(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
