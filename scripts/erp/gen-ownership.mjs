#!/usr/bin/env node
// Dono de cada RPC e de cada função compartilhada, por domínio do porte, e
// os stubs das funções que um domínio usa de outro (docs/ERP-PORTE.md).
//   node scripts/erp/closure-map.mjs --fns --json output/closure-fns.json
//   node scripts/erp/gen-ownership.mjs
// Saídas:
//   src/erp/domains/ownership.generated.json   RPCs e funções por domínio
//   src/erp/domains/<domínio>/stubs.generated.ts  stubs 0A000 das funções que
//     outros domínios chamam e ainda não estão no public.ts do dono
// O public.ts de cada domínio faz `export * from "./stubs.generated.ts"`; a
// função portada no public.ts tem precedência sobre o stub do mesmo nome, e
// a próxima geração deixa de criar o stub.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { oracleDb } from "./oracle-db.mjs";

const { rows } = JSON.parse(readFileSync("output/closure-fns.json", "utf8"));

/** Domínio do plano (closure-map) → pasta em src/erp/domains. */
export const DIR = {
  referencias: "reference", empresa: "company", acesso: "access", catalogo: "catalog", documentos: "documents",
  estoque: "stock", financeiro: "finance", fiscal: "fiscal", cnab: "cnab", pdv: "pos", preferencias: "preferences",
};
const SCHEMA_DIR = {
  erp_reference: "reference", erp_company: "company", erp_access: "access", erp_activity: "access",
  erp_catalog: "catalog", erp_pricing: "catalog", erp_documents: "documents", erp_stock: "stock",
  erp_purchase_receipts: "stock", erp_finance: "finance", erp_cnab: "cnab", erp_pos: "pos", erp_dfe: "fiscal",
  erp_a1: "fiscal", erp_preferences: "preferences", erp_list_preferences: "preferences", erp_home: "preferences",
  erp_platform: "preferences", erp_attachments: "preferences", erp_integration: "preferences", erp_sync: "sync",
};
// Fora do porte principal (PLANO-FAGOO.md, item 17): o Origin.
const ORIGIN = ["erp_cutover", "erp_document_mirror", "erp_stock_mirror", "erp_warehouse_import", "erp_sales_history", "erp_sales_history_continuation"];
const rpcDir = Object.fromEntries(rows.map((r) => [r.rpc, DIR[r.domain] ?? null]));
function dirOf(id) {
  const [s, f] = id.split(".");
  if (s === "public") return rpcDir[f] ?? null;
  if (ORIGIN.includes(s) || s.startsWith("origin")) return "origin";
  if (s.startsWith("erp_fiscal")) return "fiscal";
  return SCHEMA_DIR[s] ?? null;
}

const domains = {};
const d = (name) => (domains[name] ??= { rpcs: [], owns: new Set(), uses: {} });
for (const r of rows) {
  const dir = DIR[r.domain];
  if (!dir) continue; // Origin
  d(dir).rpcs.push(r.rpc);
  for (const id of r.fns) {
    const owner = dirOf(id);
    if (!owner || owner === "origin") continue;
    d(owner).owns.add(id);
    if (owner !== dir) (d(dir).uses[owner] ??= new Set()).add(id);
  }
}

// Assinaturas no oráculo, para o comentário de cada stub.
const db = await oracleDb();
const sig = new Map(
  (
    await db.query(
      "select n.nspname||'.'||p.proname id, pg_get_function_identity_arguments(p.oid) args, pg_get_function_result(p.oid) ret from pg_proc p join pg_namespace n on n.oid=p.pronamespace",
    )
  ).rows.map((r) => [r.id, `(${r.args}) → ${r.ret}`]),
);
await db.close();

const camel = (s) => s.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
function exportedNames(file) {
  if (!existsSync(file)) return new Set();
  const src = readFileSync(file, "utf8");
  const names = [...src.matchAll(/export (?:async )?(?:function|const|let) ([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  for (const m of src.matchAll(/export \{([^}]*)\}/g))
    names.push(...m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  return new Set(names);
}

const banner = "// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.\n";
const ownership = {};
for (const [dir, info] of Object.entries(domains).sort()) {
  const usedByOthers = new Set();
  for (const other of Object.values(domains)) for (const id of other.uses[dir] ?? []) usedByOthers.add(id);
  // Nome TS de cada função compartilhada: camelCase do nome; colisão no
  // mesmo domínio leva o sufixo do schema na frente.
  const ids = [...usedByOthers].sort();
  const base = new Map();
  for (const id of ids) base.set(camel(id.split(".")[1]), [...(base.get(camel(id.split(".")[1])) ?? []), id]);
  const names = {};
  for (const id of ids) {
    const [schema, fn] = id.split(".");
    const plain = camel(fn);
    names[id] = base.get(plain).length > 1 ? camel(schema.replace(/^erp_/, "").replace(/^public$/, "rpc") + "_" + fn) : plain;
  }
  const folder = `src/erp/domains/${dir}`;
  mkdirSync(folder, { recursive: true });
  const ported = exportedNames(`${folder}/public.ts`);
  const stubs = ids.filter((id) => !ported.has(names[id]));
  writeFileSync(
    `${folder}/stubs.generated.ts`,
    banner +
      'import { notPorted } from "../../engine/errors.ts";\n\n' +
      stubs.map((id) => `/** ${id}${sig.get(id) ?? ""} */\nexport const ${names[id]} = (..._args: unknown[]): never => notPorted("${id}");\n`).join("") +
      (stubs.length ? "" : "export {};\n"),
  );
  ownership[dir] = {
    rpcs: info.rpcs.sort(),
    public_functions: Object.fromEntries(ids.map((id) => [id, { name: names[id], ported: ported.has(names[id]) }])),
    uses: Object.fromEntries(Object.entries(info.uses).map(([o, s]) => [o, [...s].sort()])),
  };
}
writeFileSync("src/erp/domains/ownership.generated.json", JSON.stringify(ownership, null, 1) + "\n");
for (const [dir, o] of Object.entries(ownership))
  console.log(
    dir.padEnd(12),
    "rpcs",
    String(o.rpcs.length).padStart(3),
    "public",
    String(Object.keys(o.public_functions).length).padStart(3),
    "ported",
    Object.values(o.public_functions).filter((x) => x.ported).length,
  );
