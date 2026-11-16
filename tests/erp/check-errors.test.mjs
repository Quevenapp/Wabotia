// CHECK e UNIQUE violados no SQLite saem como no Postgres. CHECK: 23514 e
// 'new row for relation "<tabela>" violates check constraint "<restrição>"'
// (engine/errors.ts, fromSqlite/checkRelation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { checkRelation, uniqueName } from "../../src/erp/engine/errors.ts";
import { ERP_DDL_GENERATED } from "../../src/erp/schema/ddl.generated.ts";

const f = await dualFixture();
test.after(() => f.close());

test("todo CHECK do DDL gerado aponta para a tabela e a restrição do oráculo", async () => {
  const pg = new Map(
    (
      await f.db.query(
        `select n.nspname s, c.relname t, k.conname k from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where k.contype = 'c' and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage') and n.nspname not like 'pg\\_%'`,
      )
    ).rows.map((r) => [`${r.s}__${r.k}`, r]),
  );
  const names = ERP_DDL_GENERATED.flatMap((s) => [...s.matchAll(/CONSTRAINT "([a-z0-9_]+)" CHECK/g)].map((m) => m[1]));
  assert.ok(names.length > 900);
  assert.equal(new Set(names).size, names.length, "nome de CHECK repetido dentro de um schema");
  for (const name of names) {
    const want = pg.get(name);
    assert.ok(want, `${name} não existe no oráculo`);
    assert.deepEqual(checkRelation(name), { table: want.t, constraint: want.k }, name);
  }
  // Nomes repetidos no oráculo dentro de um schema (em tabelas diferentes) não podem ter virado CHECK no SQLite.
  const seen = new Map();
  for (const r of pg.values()) seen.set(`${r.s}.${r.k}`, (seen.get(`${r.s}.${r.k}`) ?? 0) + 1);
  assert.deepEqual(names.filter((n) => seen.get(n.replace("__", ".")) > 1), []);
});

test("violação de CHECK: mesmo código e mensagem nos dois motores", async () => {
  const both = (label, pgSql, liteSql = pgSql.replace(/\b(erp_\w+?)\.(\w+)/g, '"$1__$2"')) =>
    f
      .dual(label, async () => (await f.db.query(pgSql)).rows, () => inTransaction(f.driver, (ctx) => ctx.db.exec(liteSql).rows, f.clock))
      .then(
        () => assert.fail(`${label}: devia recusar`),
        (e) => {
          if (e.code === "ERR_ASSERTION") throw e;
          assert.equal(e.code, "23514");
          return e.message;
        },
      );
  assert.equal(
    await both("posição", "update erp_catalog.contact_type set position = 0 where slug = 'customer'"),
    'new row for relation "contact_type" violates check constraint "contact_type_position_check"',
  );
  // Duas violações: o Postgres confere em ordem de nome, o DDL gerado também.
  assert.equal(
    await both("duas", "update erp_catalog.contact_type set position = 0, active = false where slug = 'customer'"),
    'new row for relation "contact_type" violates check constraint "contact_type_check2"',
  );
  // Outro schema (os CHECKs com gatilho em PL/pgSQL na frente divergem pelo gatilho, não pelo CHECK).
  await both("versão", "update erp_finance.category_default set version = 0");
});

// UNIQUE: 23505 e 'duplicate key value violates unique constraint "<nome>"'
// (fromSqlite/uniqueName). O nome é o da restrição (PK, UNIQUE) ou o do índice único.
test("todo único do DDL gerado aponta para a restrição ou o índice do oráculo, nas mesmas colunas", async () => {
  const rows = (
    await f.db.query(`
      select n.nspname s, t.relname t, i.relname name,
        (select string_agg(a.attname, ',' order by k.ord) from unnest(x.indkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum) cols,
        x.indexprs is not null expr
      from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid join pg_namespace n on n.oid = t.relnamespace
      where x.indisunique and n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage') and n.nspname not like 'pg\\_%'`)
  ).rows;
  const pg = new Map(rows.map((r) => [`${r.s}__${r.t}|${r.cols}`, r]));
  const byName = new Map(rows.map((r) => [`${r.s}.${r.name}`, r]));
  const keys = [];
  for (const s of ERP_DDL_GENERATED) {
    const t = /^CREATE TABLE "([^"]+)"/.exec(s);
    if (t) {
      const pk = /^\s*PRIMARY KEY \(([^)]*)\)/m.exec(s) ?? /^\s*"([^"]+)" INTEGER PRIMARY KEY/m.exec(s);
      if (pk) keys.push(`${t[1]}|${[...pk[1].matchAll(/"?([a-z0-9_]+)"?/g)].map((m) => m[1]).join(",")}`);
      for (const m of s.matchAll(/CONSTRAINT "[^"]+" UNIQUE \(([^)]*)\)/g)) keys.push(`${t[1]}|${[...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).join(",")}`);
    }
    const i = /^CREATE UNIQUE INDEX "([^"]+)" ON "([^"]+)" \((.*?)\)/s.exec(s);
    if (i) keys.push(`index:${i[1]}`);
  }
  assert.ok(keys.length > 600);
  const ambiguous = [];
  for (const key of keys) {
    const name = uniqueName(key);
    assert.notEqual(name, undefined, `${key} sem nome`);
    if (name === null) {
      ambiguous.push(key);
      continue;
    }
    if (key.startsWith("index:")) {
      const schema = key.slice(6).split("__")[0];
      assert.ok(byName.has(`${schema}.${name}`), `${key}: índice ${name} não existe no oráculo`);
    } else {
      const want = pg.get(key);
      // Colunas __fold e calculadas do SQLite são expressões no Postgres: o nome basta.
      if (want) assert.equal(name, want.name, key);
      else assert.ok([...byName.keys()].includes(`${key.split("__")[0]}.${name}`), `${key}: ${name} não existe no oráculo`);
    }
  }
  // Dois únicos nas mesmas colunas (parciais diferentes): a mensagem do SQLite não diz qual.
  assert.ok(ambiguous.length <= 5, `ambíguos: ${ambiguous.join(" ")}`);
});

test("violação de UNIQUE: mesmo código e mensagem nos dois motores", async () => {
  const both = (label, pgSql, liteSql = pgSql.replace(/\b(erp_\w+?)\.(\w+)/g, '"$1__$2"')) =>
    f
      .dual(label, async () => (await f.db.query(pgSql)).rows, () => inTransaction(f.driver, (ctx) => ctx.db.exec(liteSql).rows, f.clock))
      .then(
        () => assert.fail(`${label}: devia recusar`),
        (e) => {
          if (e.code === "ERR_ASSERTION") throw e;
          assert.equal(e.code, "23505");
          return e.message;
        },
      );
  assert.equal(
    await both("chave primária", "update erp_catalog.contact_type set id = (select id from erp_catalog.contact_type where slug = 'supplier') where slug = 'customer'"),
    'duplicate key value violates unique constraint "contact_type_pkey"',
  );
  assert.equal(
    await both("UNIQUE de tabela", "update erp_catalog.contact_type set slug = 'supplier' where slug = 'customer'"),
    'duplicate key value violates unique constraint "contact_type_slug_key"',
  );
  // Duas colunas (page_id, ordinal): o ordinal de outra definição da mesma página.
  const [a, b] = (
    await f.db.query("select page_id, ordinal from erp_preferences.definition where page_id = (select page_id from erp_preferences.definition group by page_id having count(*) > 1 limit 1) order by ordinal limit 2")
  ).rows;
  assert.equal(
    await both("UNIQUE de duas colunas", `update erp_preferences.definition set ordinal = ${a.ordinal} where page_id = '${b.page_id}' and ordinal = ${b.ordinal}`),
    'duplicate key value violates unique constraint "definition_page_id_ordinal_key"',
  );
});