#!/usr/bin/env node
// Fecho de chamadas de um RPC no oráculo: funções PL/pgSQL que ele chama
// (direta ou indiretamente) e os gatilhos das tabelas em que escreve, com
// bytes. Serve para medir o tamanho do porte de cada RPC.
//   node scripts/erp/call-graph.mjs erp_stock_post [--source]
import { oracleDb } from "./oracle-db.mjs";

const root = process.argv[2];
const showSource = process.argv.includes("--source");
const db = await oracleDb();
const fns = (
  await db.query(`
  select n.nspname schema, p.proname name, p.oid::int oid, p.prosrc src, l.lanname lang
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname not in ('pg_catalog','information_schema') and p.prokind='f'`)
).rows;
const trig = (
  await db.query(`
  select n.nspname schema, c.relname tbl, t.tgname name, pn.nspname fschema, p.proname fname
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace where not t.tgisinternal`)
).rows;
const byName = new Map();
for (const f of fns) {
  for (const key of [`${f.schema}.${f.name}`, f.schema === "public" ? f.name : null])
    if (key) byName.set(key, [...(byName.get(key) || []), f]);
}
const seen = new Map();
const tablesWritten = new Set();
const queue = byName.get(root) || byName.get("public." + root) || [];
while (queue.length) {
  const f = queue.shift();
  const id = `${f.schema}.${f.name}`;
  if (seen.has(id)) continue;
  seen.set(id, f);
  const src = f.src || "";
  for (const m of src.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/g))
    for (const g of byName.get(`${m[1]}.${m[2]}`) || []) queue.push(g);
  for (const m of src.matchAll(/(?<![.\w])(erp_[a-z0-9_]+)\s*\(/g))
    for (const g of byName.get(m[1]) || []) queue.push(g);
  for (const m of src.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi))
    tablesWritten.add(`${m[1]}.${m[2]}`);
  // Gatilhos das tabelas escritas também entram.
  for (const t of trig)
    if (tablesWritten.has(`${t.schema}.${t.tbl}`))
      for (const g of byName.get(`${t.fschema}.${t.fname}`) || []) queue.push(g);
}
const list = [...seen.values()].map((f) => ({ id: `${f.schema}.${f.name}`, lang: f.lang, bytes: (f.src || "").length }));
list.sort((a, b) => b.bytes - a.bytes);
console.log(
  JSON.stringify(
    {
      root,
      functions: list.length,
      plpgsql: list.filter((f) => f.lang === "plpgsql").length,
      bytes: list.reduce((s, f) => s + f.bytes, 0),
      tables_written: tablesWritten.size,
      largest: list.slice(0, 15),
    },
    null,
    1,
  ),
);
if (showSource) for (const f of seen.values()) console.log(`\n-- ${f.schema}.${f.name}\n${f.src}`);
await db.close();
