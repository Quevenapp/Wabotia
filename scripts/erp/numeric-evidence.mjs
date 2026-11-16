#!/usr/bin/env node
// Evidência da escala das colunas numeric sem precisão: em cada função do
// oráculo que cita a tabela e a coluna, as linhas com a coluna e as
// conversões numeric(p,s) próximas. Saída para revisão humana; a decisão
// fica em scripts/erp/overrides.mjs.
//   node scripts/erp/numeric-evidence.mjs > output/numeric-evidence.txt
import { readFileSync } from "node:fs";
import { oracleDb } from "./oracle-db.mjs";

const catalog = JSON.parse(readFileSync("src/erp/schema/catalog.json", "utf8"));
const db = await oracleDb();
const fns = (
  await db.query(
    "select n.nspname s, p.proname f, p.prosrc src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and p.prokind='f'",
  )
).rows;
for (const t of catalog.tables)
  for (const c of t.columns) {
    if (c.base !== "numeric" || c.typmod >= 0) continue;
    console.log(`\n===== ${t.schema}.${t.name}.${c.name}`);
    const col = new RegExp(`\\b${c.name}\\b`);
    for (const f of fns) {
      const src = f.src || "";
      if (!src.includes(t.name) || !col.test(src)) continue;
      const lines = src
        .split(/\n|;/)
        .filter((l) => col.test(l) && (/numeric|::|insert|update|set |values|round|trunc/i.test(l)))
        .map((l) => l.trim().slice(0, 220))
        .slice(0, 6);
      if (lines.length) console.log(`-- ${f.s}.${f.f}\n   ` + lines.join("\n   "));
    }
  }
await db.close();
