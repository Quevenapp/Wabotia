#!/usr/bin/env node
// Lê o pg_catalog do oráculo (scripts/erp/oracle-db.mjs) e grava
// src/erp/schema/catalog.json: tabelas, colunas, chaves, FKs, CHECKs,
// índices, gatilhos, tipos enumerados e domínios dos schemas do ERP, e um
// resumo das funções. Versionado: o gerador e o teste de paridade partem
// dele.
import { writeFileSync } from "node:fs";
import { oracleDb } from "./oracle-db.mjs";

const SYSTEM = ["pg_catalog", "information_schema", "pg_toast", "auth", "storage"];
const db = await oracleDb();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const notSystem = `n.nspname not in (${SYSTEM.map((s) => `'${s}'`).join(",")}) and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast%'`;

const tables = await q(`
  select c.oid, n.nspname schema, c.relname name, c.relkind kind
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p') and ${notSystem}
  order by 2,3`);

const columns = await q(`
  select a.attrelid oid, a.attname name, a.attnum num,
    format_type(a.atttypid,a.atttypmod) type,
    t.typname base, t.typtype typtype, t.typcategory category,
    coalesce(et.typname, null) elem,
    a.attndims dims, a.atttypmod typmod, a.attnotnull not_null,
    pg_get_expr(d.adbin,d.adrelid) "default",
    a.attgenerated generated, a.attidentity identity,
    tn.nspname type_schema
  from pg_attribute a
  join pg_type t on t.oid=a.atttypid
  join pg_namespace tn on tn.oid=t.typnamespace
  left join pg_type et on et.oid=t.typelem and t.typcategory='A'
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attnum>0 and not a.attisdropped and a.attrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and ${notSystem})
  order by a.attrelid,a.attnum`);

const constraints = await q(`
  select con.conrelid oid, con.conname name, con.contype type,
    pg_get_constraintdef(con.oid) def,
    con.condeferrable deferrable, con.condeferred deferred,
    (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum) cols,
    rn.nspname ref_schema, rc.relname ref_table,
    (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.attnum) ref_cols,
    con.confdeltype on_delete, con.confupdtype on_update, con.confmatchtype match
  from pg_constraint con
  left join pg_class rc on rc.oid=con.confrelid
  left join pg_namespace rn on rn.oid=rc.relnamespace
  where con.conrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and ${notSystem})
  order by con.conrelid, con.conname`);

const indexes = await q(`
  select i.indrelid oid, ic.relname name, i.indisunique unique, i.indisprimary primary,
    pg_get_indexdef(i.indexrelid) def,
    pg_get_expr(i.indpred,i.indrelid) predicate,
    (select array_agg(case when k.attnum=0 then null else a.attname end order by k.ord) from unnest(i.indkey) with ordinality k(attnum,ord) left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum) cols,
    pg_get_expr(i.indexprs,i.indrelid) expressions,
    am.amname method,
    exists(select 1 from pg_constraint c where c.conindid=i.indexrelid) constraint_backed
  from pg_index i
  join pg_class ic on ic.oid=i.indexrelid
  join pg_am am on am.oid=ic.relam
  where i.indrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and ${notSystem})
  order by i.indrelid, ic.relname`);

const triggers = await q(`
  select tg.tgrelid oid, tg.tgname name, pg_get_triggerdef(tg.oid) def,
    pn.nspname function_schema, p.proname function_name,
    length(p.prosrc) function_bytes, p.prosrc function_source
  from pg_trigger tg
  join pg_proc p on p.oid=tg.tgfoid
  join pg_namespace pn on pn.oid=p.pronamespace
  where not tg.tgisinternal and tg.tgrelid in (select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and ${notSystem})
  order by tg.tgrelid, tg.tgname`);

const enums = await q(`
  select n.nspname schema, t.typname name, array_agg(e.enumlabel order by e.enumsortorder) labels
  from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
  where ${notSystem} group by 1,2 order by 1,2`);

const domains = await q(`
  select n.nspname schema, t.typname name, format_type(t.typbasetype,t.typtypmod) base, t.typnotnull not_null,
    (select array_agg(pg_get_constraintdef(c.oid)) from pg_constraint c where c.contypid=t.oid) checks
  from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where t.typtype='d' and ${notSystem} order by 1,2`);

const functions = await q(`
  select n.nspname schema, p.proname name, pg_get_function_identity_arguments(p.oid) args,
    pg_get_function_result(p.oid) returns, l.lanname language, p.provolatile volatility,
    p.prosecdef security_definer, length(p.prosrc) bytes
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where ${notSystem} and p.prokind='f'
  order by 1,2,3`);

const byOid = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.oid, [...(m.get(r.oid) || []), r]);
  return m;
};
const cols = byOid(columns),
  cons = byOid(constraints),
  idx = byOid(indexes),
  trg = byOid(triggers);
const strip = ({ oid: _oid, ...rest }) => rest;
// Corpo da função do gatilho só quando curto (basta para reconhecer os que só
// lançam erro); os longos vão por SHA-256, para o catálogo não carregar 4 MB
// de PL/pgSQL. O corpo inteiro continua nas migrações congeladas.
const { createHash } = await import("node:crypto");
for (const t of triggers) {
  t.function_sha256 = createHash("sha256").update(t.function_source || "").digest("hex");
  if ((t.function_source || "").length > 600) t.function_source = null;
}
const catalog = {
  generated_by: "scripts/erp/introspect.mjs",
  source: "tests/erp/oracle/migrations (MANIFEST.json)",
  schemas: [...new Set(tables.map((t) => t.schema))],
  tables: tables.map((t) => ({
    schema: t.schema,
    name: t.name,
    partitioned: t.kind === "p",
    columns: (cols.get(t.oid) || []).map(strip),
    // NOT NULL ('n') já está em columns[].not_null.
    constraints: (cons.get(t.oid) || []).filter((k) => k.type !== "n").map(strip),
    indexes: (idx.get(t.oid) || []).map(strip),
    triggers: (trg.get(t.oid) || []).map(strip),
  })),
  enums,
  domains,
  functions,
};
writeFileSync("src/erp/schema/catalog.json", JSON.stringify(catalog, null, 1) + "\n");
console.log(
  JSON.stringify(
    {
      schemas: catalog.schemas.length,
      tables: catalog.tables.length,
      columns: columns.length,
      constraints: constraints.length,
      indexes: indexes.length,
      triggers: triggers.length,
      enums: enums.length,
      domains: domains.length,
      functions: functions.length,
    },
    null,
    1,
  ),
);
await db.close();
