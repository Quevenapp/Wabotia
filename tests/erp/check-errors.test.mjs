// CHECK violado no SQLite sai como no Postgres: 23514 e
// 'new row for relation "<tabela>" violates check constraint "<restrição>"'
// (engine/errors.ts, fromSqlite/checkRelation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { checkRelation } from "../../src/erp/engine/errors.ts";
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
