// Comparador do diferencial: resposta e estado das tabelas nos dois motores.
// - correspondência de ids: o uuid que o Postgres gerou e o que o motor gerou
//   na mesma posição da resposta (ou da linha) viram o mesmo id;
// - carimbos de hora mascarados (o instante difere; nulo ou não, não);
// - erros comparados por código e mensagem.
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import { pgSelect, pgToLite } from "../../../scripts/erp/gen-sqlite-lib.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const q = (id) => `"${id.replace(/"/g, '""')}"`;

export class IdMap {
  constructor() {
    this.liteToPg = new Map();
    this.pgToLite = new Map();
  }
  link(pg, lite) {
    pg = pg.toLowerCase();
    lite = lite.toLowerCase();
    if (pg === lite) return true;
    const a = this.liteToPg.get(lite),
      b = this.pgToLite.get(pg);
    if (a === undefined && b === undefined) {
      this.liteToPg.set(lite, pg);
      this.pgToLite.set(pg, lite);
      return true;
    }
    return a === pg && b === lite;
  }
  map(lite) {
    return this.liteToPg.get(String(lite).toLowerCase()) ?? lite;
  }
}

/** Diferenças entre a resposta do Postgres e a do motor (lista vazia: iguais). */
export function diffValues(pg, lite, ids, path = "$", out = []) {
  if (typeof pg === "string" && typeof lite === "string") {
    if (UUID.test(pg) && UUID.test(lite)) {
      if (!ids.link(pg, lite)) out.push({ path, pg, lite, why: "id sem correspondência" });
      return out;
    }
    if (ISO_TIME.test(pg) && ISO_TIME.test(lite)) return out;
  }
  if (pg === null || lite === null || typeof pg !== "object" || typeof lite !== "object") {
    if (pg !== lite && !(typeof pg === "number" && String(pg) === String(lite)))
      out.push({ path, pg, lite });
    return out;
  }
  if (Array.isArray(pg) !== Array.isArray(lite)) {
    out.push({ path, pg, lite, why: "tipo" });
    return out;
  }
  const keys = new Set([...Object.keys(pg), ...Object.keys(lite)]);
  for (const k of keys) diffValues(pg[k], lite[k], ids, `${path}.${k}`, out);
  return out;
}

/** Conteúdo de uma tabela no Postgres, na forma do SQLite. */
export async function pgRows(pg, table) {
  const info = ERP_TABLES[table];
  const cols = Object.entries(info.columns).filter(([, c]) => !["fold", "computed"].includes(c.codec));
  const rows = (await pg.query(pgSelect(info))).rows;
  return rows.map((r) => Object.fromEntries(cols.map(([n, c]) => [n, pgToLite(r[n], c)])));
}

/** Conteúdo de uma tabela no SQLite, com inteiros como texto. */
export function liteRows(lite, table) {
  const info = ERP_TABLES[table];
  const cols = Object.entries(info.columns).filter(([, c]) => !["fold", "computed"].includes(c.codec));
  const select = cols
    .map(([n, c]) =>
      ["dec", "dec_i64", "int53", "int", "timestamp_us"].includes(c.codec) ? `CAST(${q(n)} AS TEXT) AS ${q(n)}` : q(n),
    )
    .join(",");
  return lite.prepare(`SELECT ${select} FROM ${q(table)}`).all();
}

/** Linha normalizada: tempo mascarado, JSON reordenado, ids do motor → Postgres. */
function normalize(row, table, ids) {
  const info = ERP_TABLES[table];
  const out = {};
  for (const [name, value] of Object.entries(row)) {
    const c = info.columns[name];
    if (value === null || value === undefined) out[name] = null;
    else if (c.codec === "timestamp_us") out[name] = "<tempo>";
    // Identity: a sequência do Postgres não reaproveita números de transações
    // desfeitas; o rowid do SQLite reaproveita. Só a existência conta.
    else if (c.identity) out[name] = "<identity>";
    else if (c.codec === "json" || c.codec.startsWith("array:")) out[name] = stable(mapIds(JSON.parse(value), ids));
    else if (c.codec === "uuid") out[name] = String(ids.map(value)).toLowerCase();
    else out[name] = String(value);
  }
  return out;
}
function mapIds(v, ids) {
  if (typeof v === "string") return UUID.test(v) ? String(ids.map(v)).toLowerCase() : ISO_TIME.test(v) ? "<tempo>" : v;
  if (Array.isArray(v)) return v.map((x) => mapIds(x, ids));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapIds(x, ids)]));
  return v;
}
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

/**
 * Compara as tabelas dadas nos dois motores. Antes, liga os ids das linhas
 * novas pela chave primária na ordem de criação (por exemplo o id do
 * movimento, quando a resposta não o traz).
 */
export async function diffTables(pg, lite, tables, ids) {
  const out = [];
  for (const table of tables) {
    const a = (await pgRows(pg, table)).map((r) => stable(normalize(r, table, ids)));
    const b = liteRows(lite, table).map((r) => stable(normalize(r, table, ids)));
    a.sort();
    b.sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const onlyPg = a.filter((x) => !b.includes(x)),
        onlyLite = b.filter((x) => !a.includes(x));
      out.push({ table, onlyPg: onlyPg.slice(0, 3), onlyLite: onlyLite.slice(0, 3), counts: [a.length, b.length] });
    }
  }
  return out;
}
