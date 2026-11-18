// Comparador do diferencial: resposta e estado das tabelas nos dois motores.
// - carimbos de hora mascarados (o instante difere; nulo ou não, não);
// - erros comparados por código e mensagem;
// - colunas normalizadas (__fold) e calculadas pelo motor entram na
//   comparação: o lado do Postgres é a expressão do índice do Fagoo
//   (generated_by), avaliada no próprio Postgres;
// - correspondência de ids (abaixo).
//
// Correspondência de ids. O uuid que o Postgres gera (gen_random_uuid) e o
// que o motor gera nunca são iguais. Um id é LIVRE num lado quando:
//   - não existia antes da chamada (não está em `known`: tudo o que já
//     passou pelos dois bancos, semeadura e espelho);
//   - não aparece no outro lado (argumento do RPC aparece nos dois);
//   - ainda não foi ligado (pela resposta, por exemplo).
// Só id livre pode ser ligado a id livre. Id que já existia nunca é ligado a
// outro: FK que aponta para a linha errada (já existente) é divergência.
//
// Ligação: procura uma bijeção entre os ids livres do Postgres e os do
// motor que torne as tabelas tocadas IGUAIS, linha a linha, como
// multiconjunto. Refinamento de cores (cada id ganha a "assinatura" das
// linhas e posições onde aparece, repetido até estabilizar, em todas as
// tabelas juntas: a ordem das tabelas não importa) e, se sobrar empate,
// tentativa e erro com verificação exata. A bijeção só é aceita se as
// tabelas ficam idênticas; empate entre linhas iguais a menos do id (e de
// quem aponta para elas) é simetria de verdade: qualquer escolha dá o mesmo
// estado. Sem bijeção: divergência. Busca acima do limite: divergência
// declarada como "ambíguo" (nunca liga às cegas).
import { createHash } from "node:crypto";
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import { pgSelect, pgToLite } from "../../../scripts/erp/gen-sqlite-lib.mjs";
import { clockFor, derivedIds, derivedUuid, inClockWindow, isIdentityRef, orderFor } from "./derived-ids.mjs";
import { volatileHash } from "./volatile-hashes.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const q = (id) => `"${id.replace(/"/g, '""')}"`;
const NORMALIZED = ["fold", "computed"];
// uuid canônico (com hífens) dentro de um texto, sem ser parte de outro hexa.
const EMBEDDED_SRC = "(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])";
const EMBEDDED = new RegExp(EMBEDDED_SRC, "i");
const EMBEDDED_ALL = new RegExp(EMBEDDED_SRC, "gi");

export class IdMap {
  /** known: ids que já existiam nos dois bancos (nunca ligados a outro). */
  constructor(known = new Set()) {
    this.liteToPg = new Map();
    this.pgToLite = new Map();
    this.known = known;
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
  clone() {
    const c = new IdMap(this.known);
    c.rpc = this.rpc;
    // Janela da chamada ({ from, to } em ms; dual-fixture.mjs): valores do relógio declarados (registerClockColumn).
    c.window = this.window;
    c.liteToPg = new Map(this.liteToPg);
    c.pgToLite = new Map(this.pgToLite);
    return c;
  }
  assign(other) {
    this.liteToPg = other.liteToPg;
    this.pgToLite = other.pgToLite;
  }
}

/**
 * O array está na ordem declarada (derived-ids.mjs, registerNewIdOrder)
 * pelos ids deste lado? Ordem do uuid no Postgres: bytes, a mesma do texto
 * em minúsculas. Ids que já existiam podem vir misturados aos novos
 * (category_ids com uma categoria antiga e uma criada no comando): são os
 * mesmos nos dois lados e só os novos mudam a posição. A comparação sem ordem
 * que vem depois ainda exige o mesmo multiconjunto, e um id antigo só casa
 * com ele mesmo; dois lados ordenados com o mesmo conteúdo só antigo têm a
 * mesma ordem.
 */
function inNewIdOrder(arr, order) {
  const obj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const vals = arr.map((x) => (order.by === null ? x : obj(x) ? x[order.by] : undefined));
  if (!vals.every((s) => typeof s === "string" && UUID.test(s))) return false;
  const lc = vals.map((s) => s.toLowerCase());
  return lc.every((s, i) => i === 0 || (order.dir === "asc" ? lc[i - 1] < s : lc[i - 1] > s));
}

/**
 * Array declarado como ordenado por id novo, nos dois lados nessa ordem:
 * casa elemento a elemento, ligando os ids. Devolve o IdMap com as
 * ligações, ou null.
 */
function matchUnordered(pg, lite, ids, path, specs, key) {
  const n = pg.length;
  let budget = 20000;
  const used = new Array(n).fill(false);
  const search = (i, state) => {
    if (i === n) return state;
    for (let j = 0; j < n; j++) {
      if (used[j] || --budget < 0) continue;
      const trial = state.clone();
      if (diffValues(pg[i], lite[j], trial, `${path}.${i}`, [], specs, key).length) continue;
      used[j] = true;
      const r = search(i + 1, trial);
      used[j] = false;
      if (r) return r;
    }
    return null;
  };
  return search(0, ids);
}
/** Liga um par vindo da resposta; id que já existia só vale igual. */
function linkPair(pg, lite, ids, path, out, what) {
  const p = pg.toLowerCase(),
    l = lite.toLowerCase();
  if (p === l) return;
  if (ids.known.has(p) || ids.known.has(l)) out.push({ path, pg, lite, why: `${what} que já existia, diferente` });
  else if (!ids.link(p, l)) out.push({ path, pg, lite, why: `${what} sem correspondência` });
}

/**
 * Diferenças entre a resposta do Postgres e a do motor (lista vazia: iguais).
 * Liga os ids novos que aparecem na mesma posição (e os derivados
 * declarados, sob as chaves deles).
 */
export function diffValues(pg, lite, ids, path = "$", out = [], specs = derivedIds(), key = undefined, positional = false) {
  if (typeof pg === "string" && typeof lite === "string") {
    if (UUID.test(pg) && UUID.test(lite)) {
      linkPair(pg, lite, ids, path, out, "id");
      return out;
    }
    if (key !== undefined)
      for (const s of specs) {
        if (!s.keys.has(key)) continue;
        const a = derivedUuid(s, pg),
          b = derivedUuid(s, lite);
        if (a && b) {
          linkPair(a, b, ids, path, out, `id derivado (${s.id})`);
          return out;
        }
      }
    if (ISO_TIME.test(pg) && ISO_TIME.test(lite)) return out;
    // Minuto ou dia do relógio declarado (registerClockColumn): os dois lados dentro da janela da chamada.
    const clock = pg !== lite && key !== undefined ? clockFor({ key }) : null;
    if (clock && inClockWindow(pg, clock.unit, ids.window) && inClockWindow(lite, clock.unit, ids.window)) return out;
    // Hash declarado sobre ids novos (volatile-hashes.mjs).
    if (volatileHash(ids.rpc, key, pg, lite)) return out;
    if (pg !== lite && EMBEDDED.test(pg) && EMBEDDED.test(lite)) {
      const parts = (s) => s.split(EMBEDDED_ALL);
      const ids_ = (s) => [...s.matchAll(EMBEDDED_ALL)].map((m) => m[0]);
      const a = ids_(pg),
        b = ids_(lite);
      if (a.length !== b.length || JSON.stringify(parts(pg)) !== JSON.stringify(parts(lite))) out.push({ path, pg, lite });
      else a.forEach((x, i) => linkPair(x, b[i], ids, path, out, "id embutido"));
      return out;
    }
  }
  if (pg === null || lite === null || typeof pg !== "object" || typeof lite !== "object") {
    if (pg !== lite && !(typeof pg === "number" && String(pg) === String(lite))) out.push({ path, pg, lite });
    return out;
  }
  if (Array.isArray(pg) !== Array.isArray(lite)) {
    out.push({ path, pg, lite, why: "tipo" });
    return out;
  }
  // Array declarado como ordenado por id novo (registerNewIdOrder): a ordem
  // vem dos uuids aleatórios de cada lado. Cada lado tem de estar nessa
  // ordem; aí os elementos casam um a um. Fora da declaração, ordem é ordem.
  const order = !positional && Array.isArray(pg) && key !== undefined ? orderFor(key, { rpc: ids.rpc ?? null }) : null;
  if (order && pg.length === lite.length && pg.length > 1) {
    const trial = ids.clone();
    if (!diffValues(pg, lite, trial, path, [], specs, key, true).length) {
      ids.assign(trial);
      return out;
    }
    if (!inNewIdOrder(pg, order) || !inNewIdOrder(lite, order)) {
      out.push({ path, pg, lite, why: `array fora da ordem declarada (${order.id})` });
      return out;
    }
    const r = matchUnordered(pg, lite, ids, path, specs, key);
    if (r) {
      ids.assign(r);
      return out;
    }
  }
  const keys = new Set([...Object.keys(pg), ...Object.keys(lite)]);
  for (const k of keys) diffValues(pg[k], lite[k], ids, `${path}.${k}`, out, specs, Array.isArray(pg) ? key : k);
  return out;
}

/**
 * SELECT do Postgres na forma do SQLite, com as colunas normalizadas e
 * calculadas: a expressão do índice do Fagoo, como texto.
 */
export function pgSelectAll(info) {
  const base = pgSelect(info);
  const extra = Object.entries(info.columns)
    .filter(([, c]) => NORMALIZED.includes(c.codec))
    .map(([n, c]) => `(${c.generated_by})::text as ${q(n)}`);
  if (!extra.length) return base;
  const i = base.lastIndexOf(" from ");
  return `${base.slice(0, i)},${extra.join(",")}${base.slice(i)}`;
}

/** Conteúdo de uma tabela no Postgres, na forma do SQLite (todas as colunas). */
export async function pgRows(pg, table) {
  const info = ERP_TABLES[table];
  const cols = Object.entries(info.columns);
  const rows = (await pg.query(pgSelectAll(info))).rows;
  return rows.map((r) => Object.fromEntries(cols.map(([n, c]) => [n, pgToLite(r[n], c)])));
}

/** Conteúdo de uma tabela no SQLite, com inteiros como texto. */
export function liteRows(lite, table) {
  const info = ERP_TABLES[table];
  const select = Object.entries(info.columns)
    .map(([n, c]) =>
      ["dec", "dec_i64", "int53", "int", "timestamp_us"].includes(c.codec) ? `CAST(${q(n)} AS TEXT) AS ${q(n)}` : q(n),
    )
    .join(",");
  return lite.prepare(`SELECT ${select} FROM ${q(table)}`).all();
}

// ---------------------------------------------------------------------------
// Codificação de uma linha em texto canônico. Cada uuid (coluna uuid, texto
// que é um uuid inteiro, string em json/array) e cada id derivado declarado
// passa por `leaf(kind, uuid, spec)`, que devolve o pedaço de texto.

function encodeString(s, table, column, key, specs, leaf, inJson) {
  if (UUID.test(s)) return leaf("uuid", s.toLowerCase(), null);
  const where = `${table}.${column}`;
  for (const sp of specs) {
    if (!sp.columns.has(where) || (inJson && !sp.keys.has(key))) continue;
    const u = derivedUuid(sp, s);
    if (u) return leaf("derived", u, sp);
  }
  if (inJson && ISO_TIME.test(s)) return '"<tempo>"';
  // uuid canônico embutido no texto (source_key = 'cash_session:<id>'): cada
  // um passa pela mesma correspondência; o resto do texto é literal.
  if (EMBEDDED.test(s)) {
    let out = '"',
      last = 0;
    for (const m of s.matchAll(EMBEDDED_ALL)) {
      out += JSON.stringify(s.slice(last, m.index)).slice(1, -1);
      const t = leaf("embedded", m[0].toLowerCase(), null);
      out += t.startsWith('"') ? t.slice(1, -1) : t;
      last = m.index + m[0].length;
    }
    return out + JSON.stringify(s.slice(last)).slice(1, -1) + '"';
  }
  return JSON.stringify(s);
}

function encodeJson(v, table, column, key, specs, leaf) {
  if (typeof v === "string") return encodeString(v, table, column, key, specs, leaf, true);
  if (Array.isArray(v)) {
    const parts = v.map((x) => encodeJson(x, table, column, key, specs, leaf));
    // Array declarado como ordenado por id novo (registerNewIdOrder) nesta
    // coluna: na ordem declarada, os elementos (já com os ids ligados) são
    // comparados pelo conteúdo, sem a ordem; fora dela, marcado à parte,
    // nunca igual ao ordenado (o motor que não ordena diverge sempre).
    const order = leaf.isNew && key !== undefined ? orderFor(key, { where: `${table}.${column}` }) : null;
    if (order && inNewIdOrder(v, order)) return "\u0002[" + parts.join("\u0003") + "\u0002]";
    if (order) return "[!" + parts.join(",") + "]";
    return "[" + parts.join(",") + "]";
  }
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + encodeJson(v[k], table, column, k, specs, leaf))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}

export function encodeRow(row, table, specs, leaf) {
  const info = ERP_TABLES[table];
  const parts = [];
  for (const [name, c] of Object.entries(info.columns)) {
    if (!(name in row)) continue;
    const v = row[name];
    let t;
    if (v === null || v === undefined) t = "null";
    else if (c.codec === "timestamp_us") t = '"<tempo>"';
    // Minuto ou dia do relógio declarado (registerClockColumn), dentro da janela da chamada.
    else if (leaf?.window && inClockWindow(String(v), clockFor({ where: `${table}.${name}` })?.unit, leaf.window)) t = '"<relógio>"';
    // Identity: a sequência do Postgres não reaproveita números de transações
    // desfeitas; o rowid do SQLite reaproveita. Só a existência conta.
    else if (c.identity || isIdentityRef(`${table}.${name}`)) t = '"<identity>"';
    else if (c.codec === "json" || c.codec.startsWith("array:")) t = encodeJson(JSON.parse(v), table, name, undefined, specs, leaf);
    else if (c.codec === "uuid") t = leaf("uuid", String(v).toLowerCase(), null);
    else if (c.codec === "text") t = encodeString(String(v), table, name, undefined, specs, leaf, false);
    else t = JSON.stringify(String(v));
    parts.push(JSON.stringify(name) + ":" + t);
  }
  return "{" + parts.join(",") + "}";
}

/** Junta em `into` os uuids (e os de origem dos derivados) de uma linha. */
export function collectIds(row, table, specs, into) {
  encodeRow(row, table, specs, (_, u) => (into.add(u), ""));
  return into;
}

// Marcador de id livre no texto: \0<spec>\1<n>\0 (o JSON nunca tem \0 cru).
const SLOT = /\u0000([^\u0001]*)\u0001(\d+)\u0000/g;
// Array marcado (encodeJson, ordem declarada): \2[ e1 \3 e2 … \2]; o mais interno primeiro.
const MARKED = /\u0002\[([^\u0002]*)\u0002\]/;
function canonical(s) {
  for (let m; (m = MARKED.exec(s)); ) s = s.slice(0, m.index) + "[" + m[1].split("\u0003").sort().join(",") + "]" + s.slice(m.index + m[0].length);
  return s;
}
const render = (row, f) => canonical(row.text.replace(SLOT, (_, spec, k) => f(row.slots[+k], spec, +k)));
const hash = (s) => createHash("sha1").update(s).digest("base64").slice(0, 20);

function encodeAll(data, ids, specs) {
  const raw = { pg: new Set(), lite: new Set() };
  for (const [table, d] of Object.entries(data))
    for (const side of ["pg", "lite"]) for (const r of d[side]) collectIds(r, table, specs, raw[side]);
  const rows = [];
  for (const [table, d] of Object.entries(data))
    for (const side of ["pg", "lite"]) {
      const other = side === "pg" ? raw.lite : raw.pg;
      for (const r of d[side]) {
        const slots = [];
        const leaf = (kind, u, sp) => {
          let lit = null;
          if (side === "pg") {
            if (ids.pgToLite.has(u) || ids.known.has(u) || other.has(u)) lit = u;
          } else {
            const m = ids.liteToPg.get(u);
            if (m !== undefined) lit = m;
            else if (ids.known.has(u) || other.has(u)) lit = u;
          }
          if (lit !== null) return JSON.stringify(kind === "derived" ? sp.fromUuid(lit) : lit);
          slots.push(`${side}:${u}`);
          return `\u0000${kind === "derived" ? sp.id : kind === "embedded" ? "~" : ""}\u0001${slots.length - 1}\u0000`;
        };
        // Gerado nesta chamada: não existia e só aparece deste lado (ligado ou não).
        leaf.isNew = (u) => !ids.known.has(u) && !other.has(u);
        leaf.window = ids.window;
        const text = encodeRow(r, table, specs, leaf);
        rows.push({ table, side, text, slots });
      }
    }
  return rows;
}

const keyValue = (key) => key.slice(key.indexOf(":") + 1);

/** Texto final de uma linha com a bijeção (lite → pg); sem par, o valor do lado. */
function finalText(row, pairs, specById) {
  return render(row, (key, spec) => {
    const v = keyValue(row.side === "lite" && pairs.has(key) ? pairs.get(key) : key);
    // "~": uuid embutido num texto (sem aspas próprias).
    return spec === "~" ? v : JSON.stringify(spec ? specById.get(spec).fromUuid(v) : v);
  });
}

/** Diferença de multiconjunto, por tabela, com o texto final. */
function tableDiffs(rows, pairs, specById, tables) {
  const out = [];
  for (const table of tables) {
    const count = new Map();
    let a = 0,
      b = 0;
    for (const r of rows) {
      if (r.table !== table) continue;
      const t = finalText(r, pairs, specById);
      const e = count.get(t) ?? { pg: 0, lite: 0 };
      e[r.side]++;
      count.set(t, e);
      r.side === "pg" ? a++ : b++;
    }
    const onlyPg = [],
      onlyLite = [];
    for (const [t, e] of count) {
      for (let i = e.lite; i < e.pg; i++) onlyPg.push(t);
      for (let i = e.pg; i < e.lite; i++) onlyLite.push(t);
    }
    if (onlyPg.length || onlyLite.length)
      out.push({ table, onlyPg: onlyPg.sort().slice(0, 3), onlyLite: onlyLite.sort().slice(0, 3), counts: [a, b] });
  }
  return out;
}

/** Refinamento de cores até estabilizar (as cores não dependem do lado). */
function refine(rows, color) {
  let n = new Set(color.values()).size;
  for (;;) {
    const contrib = new Map([...color.keys()].map((k) => [k, []]));
    for (const r of rows) {
      // A posição do id é a da forma canônica (arrays marcados ordenados),
      // não a ordem de leitura: a linha com este slot marcado.
      r.slots.forEach((k, i) =>
        contrib.get(k).push(r.table + "\u0004" + render(r, (key, spec, j) => (j === i ? `${spec}@` : `${spec}#${color.get(key)}`))),
      );
    }
    const next = new Map();
    for (const [k, list] of contrib) next.set(k, hash(color.get(k) + "\u0004" + list.sort().join("\u0005")));
    const m = new Set(next.values()).size;
    if (m === n) return next;
    color = next;
    n = m;
  }
}

function classes(color) {
  const out = new Map();
  for (const [k, c] of color) {
    if (!out.has(c)) out.set(c, { pg: [], lite: [] });
    out.get(c)[k.startsWith("pg:") ? "pg" : "lite"].push(k);
  }
  return out;
}

/**
 * Bijeção lite → pg dos ids livres que deixa as tabelas iguais, ou null.
 * `partial` fica com os pares forçados (classes 1 × 1) para o relatório.
 */
function solve(rows, tables, specById, budget) {
  const free = rows.filter((r) => r.slots.length);
  const keys = new Set(free.flatMap((r) => r.slots));
  const state = { budget, tag: 0, reason: null };
  const first = refine(free, new Map([...keys].map((k) => [k, ""])));
  const partial = new Map();
  for (const cl of classes(first).values()) if (cl.pg.length === 1 && cl.lite.length === 1) partial.set(cl.lite[0], cl.pg[0]);
  const equal = (pairs) => tableDiffs(rows, pairs, specById, tables).length === 0;

  function search(color) {
    if (--state.budget < 0) {
      state.reason = "ambíguo: linhas iguais a menos dos ids e a busca passou do limite (não liga às cegas)";
      return null;
    }
    const cls = [...classes(color).values()];
    if (cls.some((c) => c.pg.length !== c.lite.length)) return null;
    const open = cls.filter((c) => c.pg.length > 1).sort((x, y) => x.pg.length - y.pg.length);
    if (!open.length) {
      const pairs = new Map(cls.map((c) => [c.lite[0], c.pg[0]]));
      return equal(pairs) ? pairs : null;
    }
    const p = open[0].pg.sort()[0];
    for (const l of open[0].lite.sort()) {
      const tag = `!${state.tag++}`;
      const c2 = new Map(color);
      c2.set(p, tag);
      c2.set(l, tag);
      const r = search(refine(free, c2));
      if (r || state.budget < 0) return r;
    }
    return null;
  }
  const pairs = search(first);
  return { pairs, partial, reason: state.reason };
}

/**
 * Compara o estado já carregado ({tabela: {pg: linhas, lite: linhas}}).
 * Liga em `ids` os pares achados. Devolve as divergências e as tabelas que
 * tinham ids livres.
 */
export function compareState(data, ids, { specs = derivedIds(), budget = 2000 } = {}) {
  const tables = Object.keys(data);
  const specById = new Map(specs.map((s) => [s.id, s]));
  const rows = encodeAll(data, ids, specs);
  const withFree = new Set(rows.filter((r) => r.slots.length).map((r) => r.table));
  if (!withFree.size) return { diffs: tableDiffs(rows, new Map(), specById, tables), withFree };
  const { pairs, partial, reason } = solve(rows, tables, specById, budget);
  if (pairs) {
    for (const [l, p] of pairs) ids.link(keyValue(p), keyValue(l));
    return { diffs: [], withFree };
  }
  const diffs = tableDiffs(rows, partial, specById, tables);
  if (reason) diffs.unshift({ table: [...withFree].join(","), why: reason });
  else if (!diffs.length) diffs.push({ table: [...withFree].join(","), why: "ids novos sem bijeção que iguale as tabelas" });
  return { diffs, withFree };
}

/** Lê as tabelas dadas nos dois motores. */
export async function loadTables(pg, lite, tables) {
  const data = {};
  for (const t of tables) data[t] = { pg: await pgRows(pg, t), lite: liteRows(lite, t) };
  return data;
}

/** Compara as tabelas dadas nos dois motores (lista vazia: iguais). */
export async function diffTables(pg, lite, tables, ids, opts = {}) {
  return compareState(await loadTables(pg, lite, tables), ids, opts).diffs;
}
