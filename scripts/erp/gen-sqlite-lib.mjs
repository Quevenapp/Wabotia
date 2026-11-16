// Funções puras do gerador, usadas também pelo harness do diferencial.

const q = (id) => `"${id.replace(/"/g, '""')}"`;

/** "12.5" na escala 2 → "1250" (metade para longe do zero). */
export function scaled(text, scale) {
  const neg = String(text).startsWith("-");
  const [i, f = ""] = String(text).replace("-", "").split(".");
  const digits = (f + "0".repeat(scale + 1)).slice(0, scale + 1);
  let v = BigInt((i || "0") + digits.slice(0, scale));
  if (Number(digits[scale]) >= 5) v += 1n;
  return (neg && v !== 0n ? "-" : "") + v.toString();
}

/**
 * Texto canônico de um numeric do Postgres (o mesmo que numeric::text):
 * zeros à esquerda fora, sem "-0". Com escala fixa (numeric(p,s)) arredonda e
 * completa até s casas; sem ela conserva as casas de entrada. Mesma regra de
 * src/erp/engine/dec.ts decText.
 */
export function decText(text, scale, fixed) {
  const m = /^\s*([-+])?(\d*)(?:\.(\d*))?\s*$/.exec(String(text));
  if (!m || (m[2] === "" && !m[3])) throw new RangeError(`Decimal inválido: ${text}`);
  if (fixed) {
    const v = scaled(String(text).trim().replace(/^\+/, ""), scale);
    const neg = v.startsWith("-");
    const digits = v.replace("-", "").padStart(scale + 1, "0");
    return (neg ? "-" : "") + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
  }
  const int = m[2].replace(/^0+(?=\d)/, "") || "0";
  const frac = m[3] ?? "";
  const zero = /^0*$/.test(int + frac);
  return (m[1] === "-" && !zero ? "-" : "") + int + (frac ? "." + frac : "");
}

/**
 * SELECT do Postgres que já devolve cada coluna na forma do SQLite: tempo em
 * microssegundos (texto exato), decimais e inteiros como texto. ±infinity
 * viram os extremos do i64.
 */
/**
 * SELECT do Postgres na forma do SQLite. `normalized`: também as colunas que
 * o motor calcula (__fold e calculadas), pela expressão do índice do Fagoo
 * (generated_by) avaliada no próprio Postgres; é o que a escrita do motor grava.
 */
export function pgSelect(info, { normalized = false } = {}) {
  const select = Object.entries(info.columns)
    .filter(([, c]) => normalized || !["fold", "computed"].includes(c.codec))
    .map(([name, c]) => {
      if (["fold", "computed"].includes(c.codec)) return `(${c.generated_by})::text as ${q(name)}`;
      const col = q(name);
      if (c.codec === "timestamp_us")
        return `case when ${col} = 'infinity' then '9223372036854775807' when ${col} = '-infinity' then '-9223372036854775808' else (extract(epoch from ${col} - 'epoch'::timestamptz)::numeric * 1000000)::bigint::text end as ${col}`;
      if (["dec", "dec_i64", "dec_text", "int53", "int"].includes(c.codec)) return `${col}::text as ${col}`;
      if (c.codec === "date") return `${col}::text as ${col}`;
      return col;
    });
  return `select ${select.join(",")} from ${q(info.schema)}.${q(info.table)}`;
}

/** Valor do Postgres (pela consulta de pgSelect) → valor do SQLite. */
export function pgToLite(v, col) {
  if (v === null || v === undefined) return null;
  switch (col.codec) {
    case "bool":
      return v ? 1 : 0;
    case "timestamp_us":
      return String(v);
    case "json":
      return JSON.stringify(v);
    case "date":
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    case "dec":
    case "dec_i64":
      return scaled(String(v), col.scale);
    case "dec_text":
      return String(v);
    case "int53":
    case "int":
      return String(v);
    default:
      if (col.codec.startsWith("array:")) return JSON.stringify(v);
      return typeof v === "object" ? JSON.stringify(v) : v;
  }
}
