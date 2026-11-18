// Fase 0 do ERP, prova 4: paridade do esquema gerado (scripts/erp/gen-sqlite.mjs)
// com o Postgres do Fagoo (oráculo em PGlite, scripts/erp/oracle-db.mjs).
//   node --test tests/erp/schema-parity.test.mjs
// - cada tabela, coluna, PK, UNIQUE, FK e índice tem par ou descarte declarado;
// - cada CHECK traduzido é provado por comportamento nos dois motores, com os
//   mesmos valores de amostra; os de regex viram RegExp e são conferidos
//   contra o "~" do Postgres; o resto é pendência declarada, com teto;
// - cada gatilho tem SQL gerado ou pendência declarada (porte do domínio).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { oracleDb } from "../../scripts/erp/oracle-db.mjs";
import { decText, scaled } from "../../scripts/erp/gen-sqlite-lib.mjs";
import { overrides } from "../../scripts/erp/overrides.mjs";
import { ERP_DDL_GENERATED } from "../../src/erp/schema/ddl.generated.ts";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { ERP_REGEX_CHECKS } from "../../src/erp/schema/validators.generated.ts";
import { ERP_GUARDS } from "../../src/erp/schema/guards.generated.ts";
import { ERP_SEED } from "../../src/erp/schema/seed.generated.ts";

const catalog = JSON.parse(readFileSync("src/erp/schema/catalog.json", "utf8"));
const report = JSON.parse(readFileSync("src/erp/schema/report.generated.json", "utf8"));
const proofs = JSON.parse(readFileSync("tests/erp/oracle/check-proofs.json", "utf8"));
const sqlName = (t) => `${t.schema}__${t.name}`;
const q = (id) => `"${id.replace(/"/g, '""')}"`;

// Tetos das pendências: subir exige rever o gerador (ou declarar por quê).
// Contam só as pendências que nenhum domínio cumpre em TS (overrides/<domínio>.mjs, `covered`).
/** Item coberto: { where, test }; o arquivo de teste tem de existir. */
function proven(kind, id, item) {
  assert.ok(item && typeof item === "object" && item.where && item.test, `${kind} ${id}: declare { where, test }`);
  assert.ok(existsSync(item.test), `${kind} ${id}: teste ${item.test} não existe`);
}
const LIMITS = { checks_pending: 189, triggers_pending: 199, indexes_dropped: 1 };

const lite = new DatabaseSync(":memory:");
lite.exec("PRAGMA foreign_keys=ON");
for (const s of ERP_DDL_GENERATED) lite.exec(s);

test("toda tabela e coluna do Postgres tem par com codec", () => {
  assert.equal(catalog.tables.length, 430);
  for (const t of catalog.tables) {
    const name = sqlName(t);
    const info = lite.prepare(`PRAGMA table_info(${q(name)})`).all();
    assert.ok(info.length, `tabela ${name}`);
    const spec = ERP_TABLES[name];
    for (const col of t.columns) {
      assert.ok(info.some((c) => c.name === col.name), `${name}.${col.name}`);
      assert.ok(spec.columns[col.name]?.codec, `codec ${name}.${col.name}`);
      assert.equal(
        !!info.find((c) => c.name === col.name).notnull || info.find((c) => c.name === col.name).pk > 0,
        !!col.not_null || (t.constraints.find((k) => k.type === "p")?.cols.includes(col.name) ?? false),
        `NOT NULL ${name}.${col.name}`,
      );
    }
    // Colunas a mais só as declaradas (normalizadas ou calculadas pelo motor).
    for (const c of info)
      if (!t.columns.some((col) => col.name === c.name))
        assert.ok(["fold", "computed"].includes(spec.columns[c.name]?.codec), `extra ${name}.${c.name}`);
    // Tabelas STRICT.
    const ddl = lite.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql;
    assert.match(ddl, /\) STRICT$/, `STRICT ${name}`);
  }
});

test("PK, UNIQUE, FK e índices", () => {
  let fks = 0,
    uniques = 0,
    indexes = 0;
  const dropped = new Set(report.indexes.dropped.map((d) => d.index));
  const nnd = new Set(
    report.checks.pending.filter((p) => p.why === "UNIQUE NULLS NOT DISTINCT").map((p) => `${p.table}.${p.constraint}`),
  );
  for (const t of catalog.tables) {
    const name = sqlName(t);
    const info = lite.prepare(`PRAGMA table_info(${q(name)})`).all();
    const pk = t.constraints.find((k) => k.type === "p");
    const litePk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(litePk, pk.cols, `PK ${name}`);
    const idx = lite.prepare(`PRAGMA index_list(${q(name)})`).all();
    const cols = (i) => lite.prepare(`PRAGMA index_info(${q(i)})`).all().map((c) => c.name);
    for (const k of t.constraints.filter((k) => k.type === "u")) {
      if (nnd.has(`${t.schema}.${t.name}.${k.name}`)) continue;
      assert.ok(
        idx.some((i) => i.unique && i.origin === "u" && JSON.stringify(cols(i.name)) === JSON.stringify(k.cols)),
        `UNIQUE ${name} ${k.name}`,
      );
      uniques++;
    }
    const liteFks = lite.prepare(`PRAGMA foreign_key_list(${q(name)})`).all();
    for (const k of t.constraints.filter((k) => k.type === "f")) {
      if (["auth", "storage"].includes(k.ref_schema)) continue;
      const ref = `${k.ref_schema}__${k.ref_table}`;
      const got = liteFks.filter((f) => f.table === ref);
      assert.ok(
        k.cols.every((c, n) => got.some((f) => f.from === c && f.to === k.ref_cols[n])),
        `FK ${name} ${k.name}`,
      );
      fks++;
    }
    for (const i of t.indexes.filter((i) => !i.constraint_backed)) {
      const id = `${t.schema}.${t.name}.${i.name}`;
      if (dropped.has(id)) continue;
      const got = idx.find((x) => x.name === `${t.schema}__${i.name}`);
      assert.ok(got, `índice ${id}`);
      assert.equal(!!got.unique, !!i.unique, `unicidade ${id}`);
      assert.equal(!!got.partial, !!i.predicate, `parcial ${id}`);
      indexes++;
    }
  }
  assert.equal(uniques, report.uniques);
  assert.equal(fks, report.foreign_keys.kept);
  assert.equal(indexes, report.indexes.created);
  assert.ok(report.indexes.dropped.length <= LIMITS.indexes_dropped);
  // FKs adiadas no Postgres viram imediatas (prova 1): todas declaradas.
  const deferrable = catalog.tables.flatMap((t) =>
    t.constraints.filter((k) => k.type === "f" && k.deferrable && !["auth", "storage"].includes(k.ref_schema)).map((k) => `${t.schema}.${t.name}.${k.name}`),
  );
  assert.deepEqual(new Set(report.foreign_keys.made_immediate), new Set(deferrable));
  for (const s of ERP_DDL_GENERATED) assert.doesNotMatch(s, /DEFERRABLE/);
});

test("todo CHECK é traduzido, validador de regex ou pendência declarada", () => {
  const all = catalog.tables.flatMap((t) => t.constraints.filter((k) => k.type === "c").map((k) => `${t.schema}.${t.name}.${k.name}`));
  const translated = new Set(proofs.map((p) => `${p.source}.${p.constraint}`));
  const regex = new Set(ERP_REGEX_CHECKS.map((v) => `${ERP_TABLES[v.table].schema}.${ERP_TABLES[v.table].table}.${v.constraint}`));
  const pending = new Set(report.checks.pending.filter((p) => p.why !== "UNIQUE NULLS NOT DISTINCT").map((p) => `${p.table}.${p.constraint}`));
  for (const id of all) assert.ok(translated.has(id) || regex.has(id) || pending.has(id), `CHECK ${id}`);
  assert.equal(translated.size + regex.size + pending.size, all.length);
  for (const [id, item] of Object.entries(overrides.covered.checks)) {
    assert.ok(pending.has(id), `coberto mas não pendente: ${id}`);
    proven("CHECK", id, item);
  }
  const uncovered = [...pending].filter((id) => !(id in overrides.covered.checks));
  assert.ok(uncovered.length <= LIMITS.checks_pending, `pendências de CHECK sem cobertura: ${uncovered.length}`);
  for (const p of report.checks.pending) assert.ok(p.why, "motivo");
});

test("todo gatilho tem SQL gerado ou pendência declarada", () => {
  const all = catalog.tables.flatMap((t) => t.triggers.map((g) => `${sqlName(t)}.${g.name}`));
  const guards = new Map(ERP_GUARDS.map((g) => [`${g.table}.${g.trigger}`, g]));
  for (const id of all) assert.ok(guards.has(id), `gatilho ${id}`);
  const pending = ERP_GUARDS.filter((g) => g.status === "pending");
  const ids = new Set(pending.map((g) => `${g.table}.${g.trigger}`));
  for (const [id, item] of Object.entries(overrides.covered.triggers)) {
    assert.ok(ids.has(id), `coberto mas não pendente: ${id}`);
    proven("gatilho", id, item);
  }
  const uncovered = [...ids].filter((id) => !(id in overrides.covered.triggers));
  assert.ok(uncovered.length <= LIMITS.triggers_pending, `gatilhos pendentes sem cobertura: ${uncovered.length}`);
  for (const g of pending) assert.ok(g.reason);
  // Os gerados existem no SQLite.
  const names = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name));
  for (const g of ERP_GUARDS.filter((g) => g.status === "sql"))
    assert.ok([...names].some((n) => n.startsWith(`${g.table.split("__")[0]}__${g.trigger}__`)), `gatilho SQL ${g.trigger}`);
});

// ---------------------------------------------------------------------------
// Comportamento: o mesmo valor nos dois motores

const UUID = "11111111-2222-4333-8444-555555555555";
function samplesFor(col, pgType, body) {
  const codec = col.codec;
  const lits = [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  const nums = [...body.matchAll(/(?<![\w.'])(-?\d+(?:\.\d+)?)(?![\w'])/g)].map((m) => m[1]);
  const out = [null];
  if (codec === "bool") out.push(true, false);
  else if (codec === "int" || codec === "int53") out.push(-1, 0, 1, 2, ...nums.flatMap((n) => [Number(n) - 1, Number(n), Number(n) + 1].map(Math.trunc)));
  else if (codec === "dec" || codec === "dec_i64") out.push("0", "-1", "1", "0.5", ...nums.flatMap((n) => [n, String(Number(n) + 1), String(Number(n) - 1), String(Number(n) + 0.0001)]));
  else if (codec === "dec_text")
    out.push("0", "0.0", "-0.0", "-1", "1", "0.5", "-0.5", "007.50", "0.0000000001", "99999999999999.9999999999", "-99999999999999.9999999999");
  else if (codec === "uuid") out.push(UUID);
  else if (codec === "json") out.push("{}", "[]", '"x"', "1", "null", '{"a":1}', ...lits.filter((l) => /^[{["\d]/.test(l)));
  else if (codec.startsWith("array:")) out.push("{}", "{a}", "{a,b}");
  else if (codec === "timestamp_us") out.push("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  else if (codec === "date") out.push("2026-01-01", "2026-12-31");
  else out.push("", "x", " ", ...lits, ...lits.map((l) => l + "x"), "a".repeat(65), "1".repeat(14));
  return [...new Map(out.map((v) => [JSON.stringify(v), v])).values()].slice(0, 14);
}
function toLite(v, col) {
  if (v === null) return null;
  if (col.codec === "bool") return v ? 1 : 0;
  // Inteiro, como fica na coluna STRICT (texto compararia em ordem alfabética).
  if (col.codec === "dec" || col.codec === "dec_i64") return BigInt(scaled(String(v), col.scale));
  if (col.codec === "dec_text") return decText(String(v), col.scale, col.fixed);
  if (col.codec === "timestamp_us") return BigInt(Date.parse(v)) * 1000n;
  if (col.codec.startsWith("array:")) return JSON.stringify(v === "{}" ? [] : v.slice(1, -1).split(","));
  return v;
}
function* combos(columns, samples, limit, seed = 7) {
  let x = seed;
  const rand = (n) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
  const seen = new Set();
  // Cada valor de cada coluna aparece ao menos uma vez; o resto, sorteado.
  for (const c of columns)
    for (const v of samples[c]) {
      const row = Object.fromEntries(columns.map((k) => [k, k === c ? v : samples[k][rand(samples[k].length)]]));
      const key = JSON.stringify(row);
      if (!seen.has(key)) (seen.add(key), yield row);
    }
  for (let i = 0; i < limit; i++) {
    const row = Object.fromEntries(columns.map((k) => [k, samples[k][rand(samples[k].length)]]));
    const key = JSON.stringify(row);
    if (!seen.has(key)) (seen.add(key), yield row);
  }
}

test("CHECKs traduzidos: mesmo resultado nos dois motores", { timeout: 600_000 }, async () => {
  const pg = await oracleDb();
  let compared = 0,
    pgErrors = 0;
  const mismatches = [];
  try {
    for (const p of proofs) {
      const spec = ERP_TABLES[p.table].columns;
      const table = catalog.tables.find((t) => sqlName(t) === p.table);
      const used = table.columns.filter((c) => new RegExp(`(^|[^a-z0-9_])${c.name}([^a-z0-9_]|$)`).test(p.pg));
      if (!used.length) continue;
      const samples = Object.fromEntries(used.map((c) => [c.name, samplesFor(spec[c.name], c.type, p.pg)]));
      const pgSql = `select (${p.pg}) as r from (select ${used.map((c, i) => `$${i + 1}::${c.type} as ${q(c.name)}`).join(",")}) t`;
      const liteStmt = lite.prepare(`select (${p.sqlite}) as r from (select ${used.map((c) => `? as ${q(c.name)}`).join(",")})`);
      for (const row of combos(used.map((c) => c.name), samples, 24)) {
        let expected;
        try {
          expected = (await pg.query(pgSql, used.map((c) => (row[c.name] === null ? null : String(row[c.name]))))).rows[0].r;
        } catch {
          // Valor que o próprio Postgres não aceita no tipo (o SQLite recusa
          // pelos CHECKs de coluna): fora da comparação.
          pgErrors++;
          continue;
        }
        const got = liteStmt.get(...used.map((c) => toLite(row[c.name], spec[c.name]))).r;
        const pgPass = expected !== false;
        const litePass = got === null || Number(got) !== 0;
        compared++;
        if (pgPass !== litePass) mismatches.push({ table: p.source, constraint: p.constraint, row, pg: expected, sqlite: got });
      }
    }
  } finally {
    await pg.close();
  }
  console.log(`CHECKs comparados: ${proofs.length} restrições, ${compared} avaliações, ${pgErrors} valores recusados pelo próprio Postgres`);
  if (process.env.ERP_PARITY_DUMP) {
    const by = new Map();
    for (const m of mismatches) by.set(`${m.table}.${m.constraint}`, m);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.env.ERP_PARITY_DUMP,
      JSON.stringify([...by.values()].map((m) => ({ ...m, def: proofs.find((p) => `${p.source}.${p.constraint}` === `${m.table}.${m.constraint}`) })), null, 1),
    );
  }
  assert.deepEqual(mismatches.slice(0, 5), []);
  assert.ok(compared > proofs.length * 3);
});

test("validadores de regex: RegExp do JS igual ao ~ do Postgres", async () => {
  const pg = await oracleDb();
  const probes = ["", "a", "abc", "ABC", "a-b_c", "0".repeat(64), "f".repeat(64), "F".repeat(64), "12345678901234", "1234", "x y", "é", "a.b", "AB12"];
  const bad = [];
  try {
    for (const v of ERP_REGEX_CHECKS) {
      const re = new RegExp(v.pattern, "u");
      for (const s of probes) {
        const expected = (await pg.query("select $1 ~ $2 as r", [s, v.pattern])).rows[0].r;
        if (re.test(s) !== expected) bad.push({ constraint: v.constraint, pattern: v.pattern, s, pg: expected });
      }
    }
  } finally {
    await pg.close();
  }
  assert.deepEqual(bad.slice(0, 5), []);
});

test("semeadura aplica com FKs ligadas, na ordem gerada", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const s of ERP_DDL_GENERATED) db.exec(s);
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys=ON");
  for (const t of ERP_SEED) {
    const ins = db.prepare(`INSERT INTO ${q(t.table)} (${t.columns.map(q).join(",")}) VALUES (${t.columns.map(() => "?").join(",")})`);
    for (const r of t.rows) ins.run(...r);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("COMMIT");
  assert.equal(db.prepare('SELECT count(*) n FROM "erp_reference__municipality"').get().n, 5571);
});
