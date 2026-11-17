// Gatilhos adiados do motor (engine/registry.ts, defer): rodam no fim da
// transação, antes do COMMIT, na ordem da fila, incluindo o que a própria
// fila enfileira; erro num adiado desfaz a transação inteira.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { defer, inTransaction } from "../../src/erp/engine/registry.ts";
import { nodeDriver } from "./harness/node-driver.mjs";

const fresh = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE t(n INTEGER)");
  return { raw, db: nodeDriver(raw) };
};

test("adiados rodam depois do corpo, em ordem, com os enfileirados pela fila", () => {
  const { raw, db } = fresh();
  const seen = [];
  const result = inTransaction(db, (ctx) => {
    defer(ctx, () => {
      seen.push("a");
      defer(ctx, () => seen.push("c"));
    });
    defer(ctx, () => seen.push("b"));
    seen.push("corpo");
    ctx.db.exec("INSERT INTO t VALUES(1)");
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(seen, ["corpo", "a", "b", "c"]);
  assert.equal(raw.prepare("SELECT count(*) n FROM t").get().n, 1);
});

test("erro num adiado desfaz a transação", () => {
  const { raw, db } = fresh();
  assert.throws(() =>
    inTransaction(db, (ctx) => {
      ctx.db.exec("INSERT INTO t VALUES(1)");
      defer(ctx, () => {
        throw new Error("adiado");
      });
    }),
  );
  assert.equal(raw.prepare("SELECT count(*) n FROM t").get().n, 0);
});
