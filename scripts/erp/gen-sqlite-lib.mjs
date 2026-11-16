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
 * SELECT do Postgres que já devolve cada coluna na forma do SQLite: tempo em
 * microssegundos (texto exato), decimais e inteiros como texto. ±infinity
 * viram os extremos do i64.
 */
export function pgSelect(info) {
  const select = Object.entries(info.columns)
    .filter(([, c]) => !["fold", "computed"].includes(c.codec))
    .map(([name, c]) => {
      const col = q(name);
      if (c.codec === "timestamp_us")
        return `case when ${col} = 'infinity' then '9223372036854775807' when ${col} = '-infinity' then '-9223372036854775808' else (extract(epoch from ${col} - 'epoch'::timestamptz)::numeric * 1000000)::bigint::text end as ${col}`;
      if (["dec", "dec_i64", "int53", "int"].includes(c.codec)) return `${col}::text as ${col}`;
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
    case "int53":
    case "int":
      return String(v);
    default:
      if (col.codec.startsWith("array:")) return JSON.stringify(v);
      return typeof v === "object" ? JSON.stringify(v) : v;
  }
}
