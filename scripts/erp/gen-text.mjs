#!/usr/bin/env node
// Semântica de texto do Postgres do oráculo (ctype C.UTF-8) para o motor:
// lower/upper caractere a caractere (mapeamento simples, sem sigma final,
// com a tabela Unicode do Postgres) e as classes \s e [[:cntrl:]].
//   node --no-warnings scripts/erp/gen-text.mjs  → src/erp/engine/text.generated.ts
// Guarda só as exceções em relação ao toLowerCase/toUpperCase de um caractere
// do JS (resultado de mais de um caractere conta como exceção).
import { writeFileSync } from "node:fs";
import { oracleDb } from "./oracle-db.mjs";

const db = await oracleDb();
const lower = {},
  upper = {};
for (let start = 1; start <= 0x10ffff; start += 0x10000) {
  const end = Math.min(start + 0xffff, 0x10ffff);
  const rows = (
    await db.query(
      `select c, 'x'||lower(chr(c)) l, 'x'||upper(chr(c)) u from generate_series($1::int,$2::int) c where c not between 55296 and 57343`,
      [start, end],
    )
  ).rows;
  for (const r of rows) {
    // 'x'|| na frente: o decodificador do cliente tira U+FEFF do começo do texto.
    r.l = r.l.slice(1);
    r.u = r.u.slice(1);
    const ch = String.fromCodePoint(r.c);
    if (ch.toLowerCase() !== r.l) lower[r.c] = r.l.codePointAt(0);
    if (ch.toUpperCase() !== r.u) upper[r.c] = r.u.codePointAt(0);
  }
}
const ranges = async (re) => {
  const cs = (await db.query(`select array_agg(c order by c) v from generate_series(1,65535) c where c not between 55296 and 57343 and chr(c) ~ '${re}'`)).rows[0].v;
  const out = [];
  for (const c of cs) {
    const last = out[out.length - 1];
    if (last && last[1] === c - 1) last[1] = c;
    else out.push([c, c]);
  }
  return out;
};
const space = await ranges("\\s");
const cntrl = await ranges("[[:cntrl:]]");
await db.close();
const cls = (rs) =>
  "[" + rs.map(([a, b]) => (a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join("") + "]";
writeFileSync(
  "src/erp/engine/text.generated.ts",
  `// Gerado por scripts/erp/gen-text.mjs a partir do oráculo. Não edite.
/** Exceções do lower() do Postgres em relação ao toLowerCase() de um caractere do JS. */
export const PG_LOWER: Record<number, number> = ${JSON.stringify(lower)};
/** Exceções do upper(). */
export const PG_UPPER: Record<number, number> = ${JSON.stringify(upper)};
/** \\s e [[:space:]] do Postgres (sem NBSP, U+1680, U+2007, U+202F, U+FEFF; com U+0085). */
export const PG_SPACE_CLASS = ${JSON.stringify(cls(space))};
/** [[:cntrl:]] do Postgres (C0, DEL e C1). */
export const PG_CNTRL_CLASS = ${JSON.stringify(cls(cntrl))};
`,
);
console.log({ lower: Object.keys(lower).length, upper: Object.keys(upper).length, space: cls(space), cntrl: cls(cntrl) });
