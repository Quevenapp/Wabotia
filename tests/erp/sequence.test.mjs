// Identity no motor (engine/sequence.ts): o ponto de partida bate com as
// sequências do oráculo, e o número emitido numa transação que falha não
// volta (como o nextval), nos dois motores.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { nextIdentity } from "../../src/erp/engine/sequence.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const identities = Object.entries(ERP_TABLES).flatMap(([table, info]) =>
  Object.entries(info.columns).filter(([, c]) => c.identity).map(([column]) => ({ table, column, schema: info.schema, name: info.table })),
);

test("ponto de partida: a sequência do oráculo está no maior valor da tabela (ou nunca usada)", async () => {
  assert.ok(identities.length > 40);
  const off = [];
  for (const { table, column, schema, name } of identities) {
    const seq = (await f.db.query(`select pg_get_serial_sequence($1, $2) s`, [`"${schema}"."${name}"`, column])).rows[0].s;
    assert.ok(seq, `${table}.${column} sem sequência`);
    const s = (await f.db.query(`select last_value::text v, is_called c from ${seq}`)).rows[0];
    const max = (await f.db.query(`select coalesce(max("${column}"),0)::text m from "${schema}"."${name}"`)).rows[0].m;
    const pgLast = s.c ? s.v : "0";
    if (pgLast !== max) off.push(`${table}.${column}: sequência ${pgLast}, maior ${max}`);
  }
  assert.deepEqual(off, []);
});

test("número emitido numa transação que falha não volta, nos dois motores", async () => {
  const { table, column, schema, name } = identities.find((x) => x.table === "erp_finance__grouped_billing") ?? identities[0];
  const seq = (await f.db.query(`select pg_get_serial_sequence($1, $2) s`, [`"${schema}"."${name}"`, column])).rows[0].s;
  // Postgres: nextval dentro de uma transação desfeita, depois outro.
  await f.db.exec("begin");
  const pgFirst = Number((await f.db.query(`select nextval('${seq}') v`)).rows[0].v);
  await f.db.exec("rollback");
  const pgSecond = Number((await f.db.query(`select nextval('${seq}') v`)).rows[0].v);
  // Motor: o mesmo, com o inTransaction (que grava o número fora da transação).
  let liteFirst;
  assert.throws(() =>
    inTransaction(f.driver, (ctx) => {
      liteFirst = nextIdentity(ctx, table, column);
      throw new Error("falha depois de consumir o número");
    }),
  );
  const liteSecond = inTransaction(f.driver, (ctx) => nextIdentity(ctx, table, column));
  assert.deepEqual([liteFirst, liteSecond], [pgFirst, pgSecond]);
  // Dois números na mesma chamada também seguem.
  const [a, b] = inTransaction(f.driver, (ctx) => [nextIdentity(ctx, table, column), nextIdentity(ctx, table, column)]);
  assert.deepEqual([a, b], [pgSecond + 1, pgSecond + 2]);
});
