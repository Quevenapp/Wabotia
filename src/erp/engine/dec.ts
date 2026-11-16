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

/** numeric sem escala fixa, só para comparar com zero e somar: escala 30. */
export const exact = (text: string) => toScaled(text, 30);
