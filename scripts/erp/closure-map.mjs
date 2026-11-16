#!/usr/bin/env node
// Mapa de fechos dos RPCs que a erp-api chama (portão da fase 0, item b).
//   node scripts/erp/closure-map.mjs [--json saída.json]
// Para cada RPC: fecho de chamadas (como scripts/erp/call-graph.mjs) em duas
// versões:
//  - ingênuo: todo gatilho de toda tabela escrita entra;
//  - refinado: gatilho só entra se o evento bate (INSERT/UPDATE/DELETE; um
//    insert … on conflict do update conta como UPDATE).
// Agrupa por domínio do plano (PLANO-FAGOO.md) e lista as funções internas
// usadas por RPCs de mais de um domínio (precisam de um dono).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { oracleDb } from "./oracle-db.mjs";

const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

// Domínios do plano, na ordem proposta.
const DOMAINS = [
  "referencias", "empresa", "acesso", "catalogo", "documentos", "estoque", "financeiro", "pdv", "cnab", "fiscal",
  "preferencias", "origin",
];
const SCHEMA_DOMAIN = {
  erp_reference: "referencias",
  erp_company: "empresa",
  erp_access: "acesso", erp_activity: "acesso",
  erp_catalog: "catalogo", erp_pricing: "catalogo",
  erp_documents: "documentos",
  erp_stock: "estoque", erp_purchase_receipts: "estoque",
  erp_finance: "financeiro",
  erp_pos: "pdv",
  erp_cnab: "cnab",
  erp_dfe: "fiscal", erp_a1: "fiscal",
  erp_preferences: "preferencias", erp_list_preferences: "preferencias", erp_home: "preferencias",
  erp_platform: "preferencias", erp_attachments: "preferencias", erp_integration: "preferencias",
  erp_sync: "origin", erp_cutover: "origin", erp_document_mirror: "origin", erp_stock_mirror: "origin",
  erp_warehouse_import: "origin", erp_sales_history: "origin", erp_sales_history_continuation: "origin",
};
const schemaDomain = (s) => SCHEMA_DOMAIN[s] ?? (s.startsWith("erp_fiscal") ? "fiscal" : null);
// Nome do RPC → domínio (o prefixo mais longo vence).
const PREFIX = [
  ["erp_reference", "referencias"], ["erp_company", "empresa"],
  ["erp_access", "acesso"], ["erp_activity", "acesso"], ["erp_security", "acesso"], ["erp_user", "acesso"],
  ["erp_catalog", "catalogo"], ["erp_contact", "catalogo"], ["erp_product", "catalogo"], ["erp_price", "catalogo"],
  ["erp_pricing", "catalogo"], ["erp_seller", "catalogo"], ["erp_employee", "catalogo"], ["erp_carrier", "catalogo"],
  ["erp_document", "documentos"], ["erp_service", "documentos"], ["erp_sales_bag", "documentos"], ["erp_freight", "documentos"],
  ["erp_document_stock", "estoque"], ["erp_document_finance", "financeiro"], ["erp_document_mirror", "origin"],
  ["erp_stock", "estoque"], ["erp_purchase_receipt", "estoque"], ["erp_warehouse", "estoque"],
  ["erp_finance", "financeiro"], ["erp_financial", "financeiro"], ["erp_due", "financeiro"],
  ["erp_pos", "pdv"],
  ["erp_cnab", "cnab"], ["erp_boleto", "cnab"], ["erp_itau", "cnab"],
  ["erp_fiscal", "fiscal"], ["erp_dfe", "fiscal"], ["erp_a1", "fiscal"], ["erp_invoice", "fiscal"], ["erp_nfe", "fiscal"],
  ["erp_preferences", "preferencias"], ["erp_home", "preferencias"], ["erp_platform", "preferencias"],
  ["erp_attachment", "preferencias"], ["erp_list", "preferencias"], ["erp_integration", "preferencias"],
  ["erp_custom", "preferencias"], ["erp_report", "preferencias"], ["erp_label", "preferencias"], ["erp_system", "preferencias"],
  ["erp_origin", "origin"], ["erp_sync", "origin"], ["erp_cutover", "origin"], ["erp_mirror", "origin"],
  ["erp_sales_history", "origin"], ["erp_backup", "origin"], ["erp_warehouse_import", "origin"],
].sort((a, b) => b[0].length - a[0].length);

const db = await oracleDb();
const fns = (
  await db.query(`
  select n.nspname schema, p.proname name, p.prosrc src, l.lanname lang
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname not in ('pg_catalog','information_schema') and p.prokind='f'`)
).rows;
const triggers = (
  await db.query(`
  select n.nspname schema, c.relname tbl, t.tgname name, pn.nspname fschema, p.proname fname, pg_get_triggerdef(t.oid) def
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace where not t.tgisinternal`)
).rows;
await db.close();

// RPCs da erp-api: nomes literais e os prefixos montados em tempo de execução.
const dir = "src/erp/fagoo/workers/erp-api/src";
const publicNames = new Set(fns.filter((f) => f.schema === "public").map((f) => f.name));
const rpcs = new Set();
const dynamic = new Set();
for (const file of readdirSync(dir)) {
  const src = readFileSync(`${dir}/${file}`, "utf8");
  for (const m of src.matchAll(/erp_[a-z0-9_]+/g)) if (publicNames.has(m[0])) rpcs.add(m[0]);
  for (const m of src.matchAll(/`(erp_[a-z0-9_]*)\$\{/g)) dynamic.add(m[1]);
}
for (const name of publicNames) for (const p of dynamic) if (name.startsWith(p)) rpcs.add(name);

// Arestas por função: chamadas e escritas (tabela + evento).
const byName = new Map();
for (const f of fns)
  for (const key of [`${f.schema}.${f.name}`, f.schema === "public" ? f.name : null])
    if (key) byName.set(key, [...(byName.get(key) || []), f]);
const info = new Map();
function edges(f) {
  const id = `${f.schema}.${f.name}`;
  if (info.has(id)) return info.get(id);
  const src = (f.src || "").replace(/--[^\n]*/g, "");
  const calls = new Set();
  for (const m of src.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/g))
    if (byName.has(`${m[1]}.${m[2]}`)) calls.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/(?<![.\w])(erp_[a-z0-9_]+)\s*\(/g)) if (byName.has(m[1])) calls.add(m[1]);
  const writes = new Map(); // tabela → Set(eventos)
  const add = (t, ev) => writes.set(t, new Set([...(writes.get(t) || []), ev]));
  for (const m of src.matchAll(/\binsert\s+into\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)([\s\S]{0,4000}?)(;|$)/gi)) {
    add(`${m[1]}.${m[2]}`, "INSERT");
    if (/on\s+conflict[\s\S]*do\s+update/i.test(m[3])) add(`${m[1]}.${m[2]}`, "UPDATE");
  }
  for (const m of src.matchAll(/\bupdate\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) add(`${m[1]}.${m[2]}`, "UPDATE");
  for (const m of src.matchAll(/\bdelete\s+from\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) add(`${m[1]}.${m[2]}`, "DELETE");
  for (const m of src.matchAll(/\btruncate\s+(?:table\s+)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi)) add(`${m[1]}.${m[2]}`, "TRUNCATE");
  const e = { id, f, calls, writes, bytes: (f.src || "").length, lang: f.lang };
  info.set(id, e);
  return e;
}
const triggersByTable = new Map();
for (const t of triggers) {
  const events = new Set(
    (/ (?:BEFORE|AFTER|INSTEAD OF) (.*?) ON /.exec(t.def)?.[1] || "").split(" OR ").map((e) => e.replace(/ OF .*/, "")),
  );
  const key = `${t.schema}.${t.tbl}`;
  triggersByTable.set(key, [...(triggersByTable.get(key) || []), { ...t, events }]);
}

function closure(rootName, refined) {
  const seen = new Map();
  const tables = new Set();
  const queue = [...(byName.get(rootName) || [])];
  while (queue.length) {
    const f = queue.shift();
    const e = edges(f);
    if (seen.has(e.id)) continue;
    seen.set(e.id, e);
    for (const c of e.calls) queue.push(...byName.get(c));
    for (const [table, events] of e.writes) {
      tables.add(table);
      for (const t of triggersByTable.get(table) || [])
        if (!refined || [...events].some((ev) => t.events.has(ev)))
          queue.push(...(byName.get(`${t.fschema}.${t.fname}`) || []));
    }
  }
  return { fns: seen, tables };
}

function rpcDomain(name) {
  for (const [p, d] of PREFIX) if (name.startsWith(p)) return { domain: d, by: "nome" };
  // Sem prefixo conhecido: o schema com mais bytes no fecho (fora dos transversais).
  const { fns: c } = closure(name, true);
  const bytes = {};
  for (const e of c.values()) {
    const d = schemaDomain(e.f.schema);
    if (d && !["acesso", "origin", "preferencias"].includes(d)) bytes[d] = (bytes[d] || 0) + e.bytes;
  }
  const best = Object.entries(bytes).sort((a, b) => b[1] - a[1])[0];
  return { domain: best ? best[0] : "preferencias", by: "fecho" };
}
const fnDomain = (e) => (e.f.schema === "public" ? rpcDomain(e.f.name).domain : schemaDomain(e.f.schema) ?? "?");

const rows = [];
const usage = new Map(); // função interna → { rpcs:Set, domains:Set }
for (const name of [...rpcs].sort()) {
  const naive = closure(name, false);
  const refined = closure(name, true);
  const { domain, by } = rpcDomain(name);
  const sum = (c) => [...c.fns.values()].reduce((s, e) => s + e.bytes, 0);
  rows.push({
    rpc: name,
    domain,
    by,
    naive: { functions: naive.fns.size, bytes: sum(naive) },
    refined: {
      functions: refined.fns.size,
      plpgsql: [...refined.fns.values()].filter((e) => e.lang === "plpgsql").length,
      bytes: sum(refined),
      tables_written: refined.tables.size,
    },
  });
  for (const e of refined.fns.values()) {
    if (e.f.schema === "public" && e.f.name === name) continue;
    const u = usage.get(e.id) || { rpcs: new Set(), domains: new Set(), bytes: e.bytes, owner: fnDomain(e) };
    u.rpcs.add(name);
    u.domains.add(domain);
    usage.set(e.id, u);
  }
}

// Por domínio: contagem, bytes únicos, maiores fechos.
const byDomain = {};
for (const d of DOMAINS) {
  const list = rows.filter((r) => r.domain === d).sort((a, b) => b.refined.bytes - a.refined.bytes);
  const own = [...usage.entries()].filter(([, u]) => u.owner === d).reduce((s, [, u]) => s + u.bytes, 0);
  byDomain[d] = {
    rpcs: list.length,
    by_closure: list.filter((r) => r.by === "fecho").length,
    owned_internal_bytes: own,
    largest: list.slice(0, 5).map((r) => ({ rpc: r.rpc, ...r.refined, naive_functions: r.naive.functions })),
  };
}
// Funções compartilhadas entre domínios (precisam de dono único).
const shared = [...usage.entries()]
  .filter(([, u]) => u.domains.size >= 2)
  .map(([id, u]) => ({ id, owner: u.owner, domains: [...u.domains].sort(), rpcs: u.rpcs.size, bytes: u.bytes }))
  .sort((a, b) => b.domains.length - a.domains.length || b.rpcs - a.rpcs);
// Dependências: domínio A usa funções cujo dono é B (bytes).
const deps = {};
for (const [, u] of usage)
  for (const d of u.domains)
    if (u.owner !== d && u.owner !== "?") {
      deps[d] ??= {};
      deps[d][u.owner] = (deps[d][u.owner] || 0) + u.bytes;
    }
const users = {};
for (const [a, m] of Object.entries(deps)) for (const b of Object.keys(m)) (users[b] ??= new Set()).add(a);

const summary = {
  rpcs: rows.length,
  dynamic_prefixes: [...dynamic].sort(),
  domain_by_closure: rows.filter((r) => r.by === "fecho").length,
  internal_functions_reached: usage.size,
  shared_between_domains: shared.length,
  overestimate: {
    naive_functions: rows.reduce((s, r) => s + r.naive.functions, 0),
    refined_functions: rows.reduce((s, r) => s + r.refined.functions, 0),
    naive_bytes: rows.reduce((s, r) => s + r.naive.bytes, 0),
    refined_bytes: rows.reduce((s, r) => s + r.refined.bytes, 0),
  },
  domains: byDomain,
  used_by_other_domains: Object.fromEntries(
    DOMAINS.map((d) => [d, [...(users[d] || [])].sort()]).filter(([, v]) => v.length),
  ),
  depends_on: Object.fromEntries(
    Object.entries(deps).map(([d, m]) => [d, Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]))]),
  ),
  shared_top: shared.slice(0, 60),
};
if (out) writeFileSync(out, JSON.stringify({ summary, rows, shared }, null, 1));
console.log(JSON.stringify(summary, null, 1));
