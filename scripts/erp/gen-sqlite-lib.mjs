// Funções puras do gerador, usadas também pelos testes.

/** "12.5" na escala 2 → "1250" (metade para longe do zero). */
export function scaled(text, scale) {
  const neg = String(text).startsWith("-");
  const [i, f = ""] = String(text).replace("-", "").split(".");
  const digits = (f + "0".repeat(scale + 1)).slice(0, scale + 1);
  let v = BigInt((i || "0") + digits.slice(0, scale));
  if (Number(digits[scale]) >= 5) v += 1n;
  return (neg && v !== 0n ? "-" : "") + v.toString();
}
