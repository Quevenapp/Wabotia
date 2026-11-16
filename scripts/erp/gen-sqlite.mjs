#!/usr/bin/env node
// Gera o esquema SQLite do ERP a partir de src/erp/schema/catalog.json
// (scripts/erp/introspect.mjs) e das decisões de scripts/erp/overrides.mjs.
// Saídas em src/erp/schema/:
//   ddl.generated.ts         instruções CREATE (tabelas STRICT, índices, gatilhos)
//   columns.generated.ts     codec por coluna (escala, i64, tempo, JSON, padrão)
//   validators.generated.ts  CHECKs que viram RegExp/regra em TS
//   guards.generated.ts      gatilhos: gerados em SQL ou pendentes (porte do domínio)
//   seed.generated.ts        dados de referência das migrações
//   report.generated.json    contagens e tudo o que não foi traduzido, com motivo
// Regras: PLANO-FAGOO-MOTOR.md seção 3, ajustadas pela prova 1
// (docs/ERP-FASE0.md): nunca DEFERRABLE; i64 lido como TEXT; tempo em
// microssegundos; decimais escalados em INTEGER.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { overrides } from "./overrides.mjs";
import { decText, pgSelect, pgToLite, scaled } from "./gen-sqlite-lib.mjs";

const catalog = JSON.parse(readFileSync("src/erp/schema/catalog.json", "utf8"));
const MAX_SAFE = "9007199254740991";
export const sqlTable = (schema, name) => `${schema}__${name}`;
const q = (id) => `"${id.replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

class Unsupported extends Error {}

// ---------------------------------------------------------------------------
// Tipos e codecs

function columnSpec(table, col) {
  const key = `${table.schema}.${table.name}.${col.name}`;
  const forced = overrides.columns[key];
  const out = { sql: "TEXT", codec: "text", checks: [] };
  const base = col.base;
  if (col.category === "A" || col.dims > 0) {
    out.codec = "array:" + (col.elem || "").replace(/^_/, "");
    out.checks.push(`json_valid(${q(col.name)}) AND json_type(${q(col.name)})='array'`);
  } else if (base === "uuid") out.codec = "uuid";
  else if (["text", "varchar", "bpchar", "citext", "name"].includes(base)) out.codec = "text";
  else if (base === "bool") {
    out.sql = "INTEGER";
    out.codec = "bool";
    out.checks.push(`${q(col.name)} IN (0,1)`);
  } else if (["int2", "int4"].includes(base)) {
    out.sql = "INTEGER";
    out.codec = "int";
  } else if (base === "int8") {
    // bigint: contadores, centavos e ids; lidos como número, com o teto
    // seguro do JavaScript garantido no banco.
    out.sql = "INTEGER";
    out.codec = "int53";
    out.checks.push(`abs(${q(col.name)}) <= ${MAX_SAFE}`);
  } else if (base === "numeric") {
    const scale = forced?.scale ?? (col.typmod >= 0 ? ((col.typmod - 4) & 0xffff) : null);
    const precision = forced?.precision ?? (col.typmod >= 0 ? ((col.typmod - 4) >> 16) & 0xffff : null);
    if (scale === null)
      throw new Unsupported(`numeric sem escala em ${key}: declare a escala em overrides.columns`);
    out.sql = "INTEGER";
    out.scale = scale;
    // Até 15 dígitos o valor escalado cabe no número do JS. Até 18, i64 lido
    // por CAST(… AS TEXT): numeric(18,6) chega a 999999999999.999999
    // (10^18 escalado), muito acima de 2^53 — o Fagoo testa esse teto.
    // Acima de 18 dígitos (numeric(30,10), preços de 24 dígitos) o i64
    // estoura: decimal exato em TEXT, conta em TS.
    if (precision !== null && precision <= 15) out.codec = "dec";
    else if (precision !== null && precision <= 18) out.codec = "dec_i64";
    else {
      out.sql = "TEXT";
      out.codec = "dec_text";
      // numeric(p,s) arredonda para s casas; numeric puro guarda a escala de entrada.
      out.fixed = col.typmod >= 0;
      out.checks.push(`${q(col.name)} <> '' AND ltrim(${q(col.name)}, '-0123456789.') = ''`);
    }
  } else if (["timestamptz", "timestamp"].includes(base)) {
    out.sql = "INTEGER";
    out.codec = "timestamp_us";
  } else if (base === "date") {
    out.codec = "date";
    out.checks.push(`${q(col.name)} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`);
  } else if (base === "time") out.codec = "time";
  else if (["jsonb", "json"].includes(base)) {
    out.codec = "json";
    out.checks.push(`json_valid(${q(col.name)})`);
  } else if (base === "bytea") {
    out.sql = "BLOB";
    out.codec = "bytes";
  } else if (base === "inet") out.codec = "text";
  else throw new Unsupported(`tipo ${col.type} em ${key}`);
  if (forced?.codec && forced.codec !== out.codec) throw Error(`override ${key}: codec ${forced.codec}, gerador deu ${out.codec}`);
  return out;
}

// Valor de padrão: SQL quando é constante; senão o motor preenche em TS.
function defaultSpec(col, spec) {
  const d = col.default;
  if (d === null || d === undefined) return { sql: null, ts: null };
  if (/^(clock_timestamp|now|statement_timestamp|transaction_timestamp)\(\)$/.test(d))
    return { sql: null, ts: "now" };
  if (d === "gen_random_uuid()") return { sql: null, ts: "uuid" };
  if (d === "true" || d === "false") return { sql: d === "true" ? "1" : "0", ts: null };
  let m = /^\(?(-?\d+(?:\.\d+)?)\)?(?:::\w+)?$/.exec(d);
  if (m) {
    if (spec.codec === "dec_text") return { sql: lit(decText(m[1], spec.scale, spec.fixed)), ts: null };
    if (spec.scale !== undefined) return { sql: scaled(m[1], spec.scale), ts: null };
    return { sql: m[1], ts: null };
  }
  m = /^'((?:[^']|'')*)'::(text|character varying|jsonb|json|date|uuid)$/.exec(d);
  if (m) return { sql: lit(m[1].replace(/''/g, "'")), ts: null };
  m = /^'((?:[^']|'')*)'::timestamp with time zone$/.exec(d);
  if (m) {
    const iso = m[1].replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
    const at = Date.parse(iso);
    if (Number.isFinite(at)) return { sql: String(BigInt(at) * 1000n), ts: null };
    return { sql: null, ts: "expr:" + d };
  }
  if (/^'\{\}'::\w+\[\]$/.test(d) || /^ARRAY\[\]::\w+\[\]$/.test(d)) return { sql: "'[]'", ts: null };
  m = /^'\{(.*)\}'::(\w+)\[\]$/.exec(d);
  if (m) return { sql: lit(JSON.stringify(m[1] ? m[1].split(",") : [])), ts: null };
  return { sql: null, ts: "expr:" + d };
}


// ---------------------------------------------------------------------------
// Tradutor de expressões do Postgres (CHECK, predicado de índice, WHEN)

const FUNCTIONS_OK = new Set([
  "coalesce", "nullif", "length", "abs", "json_type", "json_valid", "json_array_length",
  "trim", "ltrim", "rtrim", "substr", "instr", "iif", "max", "min", "cast", "json_extract",
]);

export function translate(expr, cols, { prefix = "" } = {}) {
  let s = ` ${expr} `;
  const bad = (why) => {
    throw new Unsupported(why);
  };
  if (/ ~\*? | !~/.test(s)) bad("expressão regular");
  if (/@>|<@|&&|\?\||\?&/.test(s)) bad("operador de array/jsonb");
  if (/\binterval\b|date_trunc|extract\(|now\(\)|clock_timestamp|current_date|current_timestamp|age\(/i.test(s))
    bad("tempo relativo");
  if (/\b(lower|upper|initcap|unaccent)\(/.test(s)) bad("caixa de texto (só ASCII no SQLite)");
  if (/jsonb_path|jsonb_build|jsonb_object|to_jsonb|jsonb_each|jsonb_array_elements|jsonb_strip|jsonb_set/.test(s))
    bad("função jsonb");
  if (/\b(regexp_|split_part|position\(|strpos|format\(|to_char|to_number|left\(|right\(|md5|digest)/.test(s))
    bad("função de texto");
  if (/\b[a-z_]+\.[a-z_]+\(/.test(s)) bad("função do Fagoo");
  // ARRAY e ANY/ALL
  s = s.replace(/= ANY \(ARRAY\[([^\]]*)\]\)/g, " IN ($1)");
  s = s.replace(/<> ALL \(ARRAY\[([^\]]*)\]\)/g, " NOT IN ($1)");
  if (/\bANY\b|\bALL\b|ARRAY\[/.test(s)) bad("ANY/ALL/ARRAY");
  // jsonb
  s = s.replace(/#>> '\{([^}]*)\}'::text\[\]/g, (_m, path) => `->> '$.${path.split(",").join(".")}'`);
  s = s.replace(/jsonb_typeof\(/g, "erp_jsonb_typeof(");
  s = s.replace(/jsonb_array_length\(/g, "json_array_length(");
  // jsonb ? 'chave': nulo quando o JSON é nulo, como no Postgres.
  s = s.replace(
    /\(([^()]+?) \? '([^']+)'::text\)/g,
    (_m, col, key) => `(CASE WHEN ${col} IS NULL THEN NULL ELSE json_type(${col}, '$.${key}') IS NOT NULL END)`,
  );
  if (/ \? /.test(s)) bad("operador ? do jsonb");
  // Comparações de nulidade
  s = s.replace(/IS NOT DISTINCT FROM/g, "IS");
  s = s.replace(/IS DISTINCT FROM/g, "IS NOT");
  // Funções equivalentes
  s = s.replace(/\bchar_length\(/g, "length(").replace(/\bbtrim\(/g, "trim(");
  s = s.replace(/\bcardinality\(/g, "json_array_length(").replace(/\barray_length\(([^,()]+), 1\)/g, "json_array_length($1)");
  s = s.replace(/\bnum_nonnulls\(([^()]*)\)/g, (_m, a) => "(" + a.split(",").map((x) => `(${x.trim()} IS NOT NULL)`).join("+") + ")");
  s = s.replace(/\bnum_nulls\(([^()]*)\)/g, (_m, a) => "(" + a.split(",").map((x) => `(${x.trim()} IS NULL)`).join("+") + ")");
  // Literais com tipo
  s = s.replace(/'((?:[^']|'')*)'::(text|character varying|bpchar|jsonb|json|uuid|date|name)\b/g, "'$1'");
  s = s.replace(/\((-?\d+(?:\.\d+)?)\)::(numeric|integer|bigint|smallint)\b/g, "$1");
  s = s.replace(/(-?\d+(?:\.\d+)?)::(numeric|integer|bigint|smallint)\b/g, "$1");
  s = s.replace(/\(([a-z_][a-z0-9_]*)\)::text\b/g, "$1");
  s = s.replace(/\(\(([a-z_][a-z0-9_]*) ->> '([^']+)'\)\)::(numeric|integer|bigint)\b/g, "CAST(($1 ->> '$2') AS NUMERIC)");
  if (/::/.test(s)) bad("conversão de tipo");
  s = s.replace(/\btrue\b/g, "1").replace(/\bfalse\b/g, "0");
  // Colunas com escala ou tempo: só comparação com literal ou com outra
  // coluna da mesma escala.
  for (const [name, spec] of Object.entries(cols)) {
    const col = `${prefix}${name}`.replace(/\./g, "\\.");
    const mention = new RegExp(`(^|[^a-z0-9_.])(${col})(?![a-z0-9_])`, "g");
    if (!mention.test(s)) continue;
    if (spec.codec === "timestamp_us") {
      if (new RegExp(`(${col})\\s*(=|<>|<|<=|>|>=)\\s*'`).test(s)) bad("tempo comparado com literal");
      continue;
    }
    if (spec.codec === "dec_text") {
      // Texto canônico (sem "-0", sem zeros à esquerda): o sinal com zero
      // traduz para texto; outra comparação fica para o TS.
      const at = (op) => new RegExp(`(^|[^a-z0-9_.])(${col})\\s*${op}\\s*0(?![0-9.])`, "g");
      s = s.replace(at(">="), (_m, pre, c) => `${pre}(substr(${c},1,1) <> '-')`);
      s = s.replace(at(">"), (_m, pre, c) => `${pre}(substr(${c},1,1) <> '-' AND ltrim(${c},'0.') <> '')`);
      const rest = s
        .replace(/\((substr|ltrim)\(([^()]*)\)/g, "")
        .replace(new RegExp(`(${col}) IS (NOT )?NULL`, "g"), "");
      if (new RegExp(`(^|[^a-z0-9_.])(${col})(?![a-z0-9_])`).test(rest)) bad("decimal em TEXT (comparação em TS)");
      continue;
    }
    if (spec.scale === undefined) continue;
    // col op número → número escalado
    s = s.replace(
      new RegExp(`(^|[^a-z0-9_.])(${col})\\s*(=|<>|<|<=|>|>=)\\s*\\(?(-?\\d+(?:\\.\\d+)?)\\)?`, "g"),
      (_m, pre, c, op, n) => `${pre}${c} ${op} ${scaled(n, spec.scale)}`,
    );
    s = s.replace(
      new RegExp(`\\(?(-?\\d+(?:\\.\\d+)?)\\)?\\s*(=|<>|<|<=|>|>=)\\s*(${col})(?![a-z0-9_])`, "g"),
      (_m, n, op, c) => `${scaled(n, spec.scale)} ${op} ${c}`,
    );
    s = s.replace(
      new RegExp(`(${col}) BETWEEN (-?\\d+(?:\\.\\d+)?) AND (-?\\d+(?:\\.\\d+)?)`, "g"),
      (_m, c, a, b) => `${c} BETWEEN ${scaled(a, spec.scale)} AND ${scaled(b, spec.scale)}`,
    );
    // Sobrou aritmética com a coluna escalada: TS.
    if (new RegExp(`(${col})\\s*[-+*/]|[-+*/]\\s*(${col})(?![a-z0-9_])`).test(s)) bad("aritmética decimal");
  }
  const fns = [...s.matchAll(/([a-z_][a-z0-9_]*)\(/gi)].map((m) => m[1].toLowerCase());
  for (const f of fns)
    if (!FUNCTIONS_OK.has(f) && !["in", "and", "or", "not", "erp_jsonb_typeof", "case", "when"].includes(f))
      bad(`função ${f}`);
  s = s.replace(/erp_jsonb_typeof\(([^()]+)\)/g, (_m, x) =>
    `(CASE json_type(${x}) WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' WHEN 'true' THEN 'boolean' WHEN 'false' THEN 'boolean' ELSE json_type(${x}) END)`,
  );
  return s.trim();
}

// ---------------------------------------------------------------------------
// Geração

const report = {
  tables: 0,
  columns: 0,
  checks: { translated: 0, regex: 0, pending: [] },
  uniques: 0,
  foreign_keys: { kept: 0, dropped_external: 0, made_immediate: [] },
  indexes: { created: 0, expression_columns: [], dropped: [] },
  triggers: { generated: 0, pending: [] },
  defaults_ts: [],
  columns_unsupported: [],
};
const ddl = [];
const columnsOut = {};
const validators = [];
const guards = [];
const checkProofs = [];

const scratch = new DatabaseSync(":memory:");
const tryPrepare = (sqlText) => {
  try {
    scratch.prepare(sqlText);
    return null;
  } catch (e) {
    return String(e.message);
  }
};

for (const table of catalog.tables) {
  const key = `${table.schema}.${table.name}`;
  if (overrides.discardTables[key]) continue;
  report.tables++;
  const name = sqlTable(table.schema, table.name);
  const cols = {};
  const lines = [];
  const pk = table.constraints.find((k) => k.type === "p");
  const extra = [];
  for (const col of table.columns) {
    report.columns++;
    let spec;
    try {
      spec = columnSpec(table, col);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      report.columns_unsupported.push({ column: `${key}.${col.name}`, why: e.message });
      spec = { sql: "TEXT", codec: "text", checks: [] };
    }
    const def = defaultSpec(col, spec);
    if (def.ts && def.ts.startsWith("expr:")) report.defaults_ts.push(`${key}.${col.name}: ${def.ts.slice(5)}`);
    cols[col.name] = {
      codec: spec.codec,
      ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
      ...(spec.fixed !== undefined ? { fixed: spec.fixed } : {}),
      nullable: !col.not_null,
      ...(def.ts ? { default: def.ts } : {}),
      ...(col.identity ? { identity: true } : {}),
    };
    const identityPk = col.identity && pk?.cols?.length === 1 && pk.cols[0] === col.name;
    let line = `${q(col.name)} ${spec.sql}`;
    if (identityPk) line += " PRIMARY KEY";
    if (col.not_null && !identityPk) line += " NOT NULL";
    if (def.sql !== null) line += ` DEFAULT ${def.sql}`;
    for (const c of spec.checks) line += ` CHECK (${q(col.name)} IS NULL OR (${c}))`;
    lines.push(line);
  }
  columnsOut[name] = { schema: table.schema, table: table.name, columns: cols };
  if (pk && !(pk.cols.length === 1 && table.columns.find((c) => c.name === pk.cols[0])?.identity))
    lines.push(`PRIMARY KEY (${pk.cols.map(q).join(", ")})`);
  for (const k of table.constraints) {
    if (k.type === "u") {
      if (/NULLS NOT DISTINCT/.test(k.def)) {
        report.checks.pending.push({ table: key, constraint: k.name, why: "UNIQUE NULLS NOT DISTINCT", def: k.def });
        continue;
      }
      report.uniques++;
      lines.push(`CONSTRAINT ${q(table.schema + "__" + k.name)} UNIQUE (${k.cols.map(q).join(", ")})`);
    } else if (k.type === "f") {
      if (["auth", "storage"].includes(k.ref_schema)) {
        report.foreign_keys.dropped_external++;
        continue;
      }
      if (overrides.discardTables[`${k.ref_schema}.${k.ref_table}`]) continue;
      if (k.deferrable) report.foreign_keys.made_immediate.push(`${key}.${k.name}`);
      const action = { c: "CASCADE", n: "SET NULL", d: "SET DEFAULT", r: "RESTRICT" };
      let fk = `CONSTRAINT ${q(table.schema + "__" + k.name)} FOREIGN KEY (${k.cols.map(q).join(", ")}) REFERENCES ${q(sqlTable(k.ref_schema, k.ref_table))} (${k.ref_cols.map(q).join(", ")})`;
      if (action[k.on_delete]) fk += ` ON DELETE ${action[k.on_delete]}`;
      if (action[k.on_update]) fk += ` ON UPDATE ${action[k.on_update]}`;
      report.foreign_keys.kept++;
      lines.push(fk);
    } else if (k.type === "c") {
      const body = /^CHECK \((.*)\)( NOT VALID)?$/s.exec(k.def)?.[1];
      const regex = /^\(?\(?(?:\(([a-z_][a-z0-9_]*) IS NULL\) OR )?\(?([a-z_][a-z0-9_]*) ~ '((?:[^']|'')*)'::text\)\)?\)?$/.exec(body || "");
      if (regex && (!regex[1] || regex[1] === regex[2])) {
        validators.push({
          table: name,
          constraint: k.name,
          column: regex[2],
          pattern: regex[3].replace(/''/g, "'"),
          nullable: !!regex[1],
        });
        report.checks.regex++;
        continue;
      }
      try {
        const translated = translate(body, cols);
        const err = tryPrepare(
          `SELECT (${translated}) FROM (SELECT ${Object.keys(cols).map((c) => `NULL AS ${q(c)}`).join(",")})`,
        );
        if (err) throw new Unsupported("não prepara no SQLite: " + err);
        lines.push(`CONSTRAINT ${q(table.schema + "__" + k.name)} CHECK (${translated})`);
        checkProofs.push({ table: name, source: key, constraint: k.name, pg: body, sqlite: translated });
        report.checks.translated++;
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        report.checks.pending.push({ table: key, constraint: k.name, why: e.message, def: k.def.slice(0, 300) });
      }
    }
  }
  ddl.push(`CREATE TABLE ${q(name)} (\n  ${lines.join(",\n  ")}\n) STRICT`);

  // Índices fora das restrições
  for (const i of table.indexes) {
    if (i.constraint_backed) continue;
    const iname = q(`${table.schema}__${i.name}`);
    if (i.method !== "btree") {
      report.indexes.dropped.push({ index: `${key}.${i.name}`, why: `índice ${i.method}` });
      continue;
    }
    const parts = splitTop(indexKeys(i.def));
    const keys = [];
    let failed = null;
    parts.forEach((part, n) => {
      const m = /^([a-z_][a-z0-9_]*)( DESC| ASC)?( NULLS (?:FIRST|LAST))?$/.exec(part.trim());
      if (m) return keys.push(q(m[1]) + (m[2] || ""));
      if (part.trim() === "(true)") return keys.push("(1)");
      const fold = /^(?:erp_catalog\.fold|lower)\(([a-z_][a-z0-9_]*)\)$/.exec(part.trim());
      if (fold) {
        const col = `${fold[1]}__fold`;
        if (!cols[col]) {
          cols[col] = { codec: "fold", of: fold[1], nullable: true, generated_by: part.trim() };
          extra.push(`ALTER TABLE ${q(name)} ADD COLUMN ${q(col)} TEXT`);
          report.indexes.expression_columns.push(`${key}.${col} = ${part.trim()}`);
        }
        return keys.push(q(col));
      }
      try {
        const t = translate(part.trim(), cols);
        keys.push(`(${t})`);
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        // Expressão sem tradução: coluna calculada pelo motor em TS.
        const col = `${i.name}__k${n}`;
        cols[col] = { codec: "computed", nullable: true, generated_by: part.trim() };
        extra.push(`ALTER TABLE ${q(name)} ADD COLUMN ${q(col)} TEXT`);
        report.indexes.expression_columns.push(`${key}.${col} = ${part.trim()}`);
        keys.push(q(col));
      }
    });
    let where = "";
    if (i.predicate) {
      try {
        where = ` WHERE ${translate(i.predicate, cols)}`;
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        failed = `predicado: ${e.message}`;
      }
    }
    if (failed) {
      report.indexes.dropped.push({ index: `${key}.${i.name}`, why: failed, def: i.def.slice(0, 200) });
      continue;
    }
    extra.push(`CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${iname} ON ${q(name)} (${keys.join(", ")})${where}`);
    report.indexes.created++;
  }
  ddl.push(...extra);

  // Gatilhos
  for (const g of table.triggers) {
    const id = `${key}.${g.name}`;
    const decl = /CREATE (?:CONSTRAINT )?TRIGGER \S+ (BEFORE|AFTER) (.*?) ON \S+ (?:DEFERRABLE INITIALLY DEFERRED )?FOR EACH (ROW|STATEMENT)(?: WHEN \((.*)\))? EXECUTE FUNCTION/s.exec(g.def);
    const raise = /^\s*begin\s+raise\s+exception\s+'((?:[^']|'')*)'\s*(?:using\s+errcode\s*=\s*'([0-9A-Z]{5})')?\s*;\s*end;?\s*$/i.exec(g.function_source || "");
    const deferred = /DEFERRABLE INITIALLY DEFERRED/.test(g.def);
    if (!decl || !raise || deferred || decl[3] !== "ROW") {
      guards.push({
        table: name,
        trigger: g.name,
        function: `${g.function_schema}.${g.function_name}`,
        timing: decl?.[1] || null,
        events: decl?.[2] || null,
        deferred,
        status: "pending",
        reason: deferred ? "gatilho de restrição adiado: conferência no fim da transação (TS)" : "regra em PL/pgSQL: porte no domínio",
        bytes: g.function_bytes,
      });
      report.triggers.pending.push(id);
      continue;
    }
    let when = "";
    if (decl[4]) {
      try {
        when = translate(decl[4].replace(/\bold\./g, "OLD.").replace(/\bnew\./g, "NEW."), cols, { prefix: "" });
      } catch (e) {
        if (!(e instanceof Unsupported)) throw e;
        guards.push({ table: name, trigger: g.name, function: `${g.function_schema}.${g.function_name}`, status: "pending", reason: "WHEN sem tradução: " + e.message, bytes: g.function_bytes });
        report.triggers.pending.push(id);
        continue;
      }
    }
    const code = raise[2] || "P0001";
    const message = raise[1].replace(/''/g, "'");
    const events = decl[2].split(" OR ");
    events.forEach((event, n) => {
      if (event === "TRUNCATE") return;
      ddl.push(
        `CREATE TRIGGER ${q(`${table.schema}__${g.name}__${n}`)} ${decl[1]} ${event.replace(/OF (.*)/, (_m, c) => "OF " + c.split(", ").map(q).join(", "))} ON ${q(name)} FOR EACH ROW${when ? ` WHEN ${when}` : ""} BEGIN SELECT RAISE(ABORT, ${lit(`${code}:${message}`)}); END`,
      );
    });
    guards.push({ table: name, trigger: g.name, function: `${g.function_schema}.${g.function_name}`, status: "sql", code, message });
    report.triggers.generated++;
  }
}

/** Texto entre os parênteses de "USING btree (…)", respeitando aninhamento. */
function indexKeys(def) {
  const start = def.indexOf("USING btree (") + "USING btree (".length;
  let depth = 1,
    quote = false;
  for (let i = start; i < def.length; i++) {
    const ch = def[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return def.slice(start, i);
  }
  throw Error("Índice sem lista de colunas: " + def);
}

function splitTop(text) {
  const out = [];
  let depth = 0,
    cur = "",
    quote = false;
  for (const ch of text) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth++;
    if (!quote && ch === ")") depth--;
    if (!quote && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// Tabelas criadas antes das que as referenciam? Não é preciso: o SQLite só
// confere a FK na escrita. Ordem: tabelas, depois índices e gatilhos.
const statements = [
  ...ddl.filter((s) => s.startsWith("CREATE TABLE")),
  ...ddl.filter((s) => s.startsWith("ALTER TABLE")),
  ...ddl.filter((s) => s.startsWith("CREATE ") && !s.startsWith("CREATE TABLE")),
];

// Confere tudo num SQLite de verdade antes de gravar.
const check = new DatabaseSync(":memory:");
check.exec("PRAGMA foreign_keys=ON");
for (const s of statements) {
  try {
    check.exec(s);
  } catch (e) {
    throw Error(`DDL não aplica: ${e.message}\n${s.slice(0, 600)}`);
  }
}

// Semeadura: dados de referência das migrações (lidos do oráculo).
const { oracleDb } = await import("./oracle-db.mjs");
const db = await oracleDb();
const seed = [];
for (const [name, info] of Object.entries(columnsOut)) {
  const rows = (await db.query(pgSelect(info))).rows;
  if (!rows.length) continue;
  const names = Object.keys(rows[0]).filter((c) => info.columns[c]);
  seed.push({
    table: name,
    columns: names,
    rows: rows.map((r) => names.map((c) => pgToLite(r[c], info.columns[c]))),
  });
}
await db.close();

for (const t of seed) {
  const insert = check.prepare(
    `INSERT INTO ${q(t.table)} (${t.columns.map(q).join(",")}) VALUES (${t.columns.map(() => "?").join(",")})`,
  );
  check.exec("PRAGMA foreign_keys=OFF");
  for (const r of t.rows) insert.run(...r);
  check.exec("PRAGMA foreign_keys=ON");
}

const version = createHash("sha256").update(statements.join("\n")).digest("hex").slice(0, 12);
const banner = "// Gerado por scripts/erp/gen-sqlite.mjs a partir de catalog.json. Não edite.\n";
writeFileSync(
  "src/erp/schema/ddl.generated.ts",
  banner +
    `export const ERP_DDL_HASH = "${version}";\nexport const ERP_DDL_GENERATED: readonly string[] = ${JSON.stringify(statements, null, 0)};\n`,
);
writeFileSync(
  "src/erp/schema/columns.generated.ts",
  banner +
    `export type Codec = string;\nexport interface ColumnSpec { codec: Codec; scale?: number; fixed?: boolean; nullable: boolean; default?: string; identity?: boolean; of?: string; generated_by?: string }\nexport const ERP_TABLES: Record<string, { schema: string; table: string; columns: Record<string, ColumnSpec> }> = ${JSON.stringify(columnsOut)};\n`,
);
writeFileSync(
  "src/erp/schema/validators.generated.ts",
  banner +
    `export const ERP_REGEX_CHECKS: readonly { table: string; constraint: string; column: string; pattern: string; nullable: boolean }[] = ${JSON.stringify(validators)};\n`,
);
writeFileSync(
  "src/erp/schema/guards.generated.ts",
  banner + `export const ERP_GUARDS = ${JSON.stringify(guards)} as const;\n`,
);
writeFileSync(
  "src/erp/schema/seed.generated.ts",
  banner + `export const ERP_SEED: readonly { table: string; columns: string[]; rows: unknown[][] }[] = ${JSON.stringify(seed)};\n`,
);
writeFileSync("tests/erp/oracle/check-proofs.json", JSON.stringify(checkProofs, null, 1) + "\n");
report.seed = { tables: seed.length, rows: seed.reduce((s, t) => s + t.rows.length, 0) };
report.statements = statements.length;
report.hash = version;
writeFileSync("src/erp/schema/report.generated.json", JSON.stringify(report, null, 1) + "\n");
console.log(
  JSON.stringify(
    {
      statements: statements.length,
      tables: report.tables,
      columns: report.columns,
      columns_unsupported: report.columns_unsupported.length,
      checks_translated: report.checks.translated,
      checks_regex: report.checks.regex,
      checks_pending: report.checks.pending.length,
      uniques: report.uniques,
      fks: report.foreign_keys.kept,
      fks_external_dropped: report.foreign_keys.dropped_external,
      fks_made_immediate: report.foreign_keys.made_immediate.length,
      indexes: report.indexes.created,
      index_expression_columns: report.indexes.expression_columns.length,
      indexes_dropped: report.indexes.dropped.length,
      triggers_sql: report.triggers.generated,
      triggers_pending: report.triggers.pending.length,
      defaults_ts_expr: report.defaults_ts.length,
      seed: report.seed,
    },
    null,
    1,
  ),
);
