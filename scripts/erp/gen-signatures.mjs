#!/usr/bin/env node
// Assinaturas dos RPCs do oráculo (nome, tipo e DEFAULT de cada argumento),
// para o motor aplicar antes do corpo o que o Postgres faz na chamada:
// resolução por nome (42883), DEFAULT do argumento omitido e conversão de
// tipo (22P02, 22003, 22007, 22008). Ver src/erp/engine/args.ts.
//   node --no-warnings scripts/erp/gen-signatures.mjs  → src/erp/engine/signatures.generated.ts
// tests/erp/signatures.test.mjs confere o arquivo contra o oráculo.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { oracleDb } from "./oracle-db.mjs";

/** Tipo do Postgres → código curto do motor. */
export const TYPE_CODES = {
  uuid: "u",
  text: "t",
  integer: "i",
  bigint: "b",
  jsonb: "j",
  date: "d",
  boolean: "o",
  "text[]": "T",
  "uuid[]": "U",
  "timestamp with time zone": "z",
};

/** DEFAULT do catálogo (pg_get_expr) → valor JS. Só constantes; outra coisa é erro. */
export function defaultValue(expr) {
  if (/^NULL::[a-z ]+(\[\])?$/.test(expr)) return null;
  if (/^-?\d+$/.test(expr)) return Number(expr);
  if (expr === "true" || expr === "false") return expr === "true";
  const text = /^'((?:[^']|'')*)'::text$/.exec(expr);
  if (text) return text[1].replace(/''/g, "'");
  throw new Error(`DEFAULT não suportado: ${expr}`);
}

/** Assinaturas de todas as funções erp_* do schema public, em ordem de nome. */
export async function readSignatures(db) {
  const rows = (
    await db.query(`
      select p.proname, p.proargnames names, p.pronargdefaults ndef,
        (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes) with ordinality u(t, o)) types,
        pg_get_expr(p.proargdefaults, 0) defs
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname like 'erp\\_%' and p.prokind = 'f'
        and p.prorettype <> 'trigger'::regtype
      order by p.proname`)
  ).rows;
  const out = {};
  for (const r of rows) {
    if (out[r.proname]) throw new Error(`sobrecarga: ${r.proname}`);
    const types = r.types ?? [];
    // pg_get_expr da lista de DEFAULTs: "a, b, c" (constantes sem vírgula interna).
    const defs = r.ndef ? splitDefaults(r.defs) : [];
    if (defs.length !== r.ndef) throw new Error(`DEFAULTs de ${r.proname}: ${r.defs}`);
    out[r.proname] = types.map((t, i) => {
      const code = TYPE_CODES[t];
      if (!code) throw new Error(`tipo não suportado em ${r.proname}: ${t}`);
      const arg = [r.names[i], code];
      const d = i - (types.length - r.ndef);
      if (d >= 0) arg.push(defaultValue(defs[d]));
      return arg;
    });
  }
  return out;
}

function splitDefaults(list) {
  const parts = [];
  let cur = "",
    quoted = false;
  for (const ch of list) {
    if (ch === "'") quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

export function render(signatures) {
  const lines = Object.entries(signatures).map(([name, args]) => `  ${name}: ${JSON.stringify(args)},`);
  return `// Gerado por scripts/erp/gen-signatures.mjs a partir do oráculo. Não editar.
// Argumentos de cada RPC: [nome, tipo, DEFAULT?]. Tipos: u uuid, t text,
// i integer, b bigint, j jsonb, d date, o boolean, T text[], U uuid[],
// z timestamptz. Sem terceiro elemento: argumento obrigatório.
export type ArgType = "u" | "t" | "i" | "b" | "j" | "d" | "o" | "T" | "U" | "z";
export type ArgSpec = [name: string, type: ArgType, fallback?: string | number | boolean | null];

export const SIGNATURES: Record<string, ArgSpec[]> = {
${lines.join("\n")}
};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await oracleDb();
  const signatures = await readSignatures(db);
  writeFileSync(new URL("../../src/erp/engine/signatures.generated.ts", import.meta.url), render(signatures));
  console.log(`${Object.keys(signatures).length} assinaturas`);
  process.exit(0);
}
