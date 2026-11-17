// FK adiada numa transação do motor (engine/fk.ts): a linha aponta para outra
// que nasce depois; conferida antes do COMMIT, a violação vira 23503 e desfaz.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import { deferForeignKeys } from "../../src/erp/engine/fk.ts";
import { nodeDriver } from "./harness/node-driver.mjs";

const fresh = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys=ON; CREATE TABLE p(id TEXT PRIMARY KEY); CREATE TABLE c(id TEXT PRIMARY KEY, p TEXT REFERENCES p(id));");
  return { raw, db: nodeDriver(raw) };
};
const count = (raw, t) => raw.prepare(`SELECT count(*) n FROM ${t}`).get().n;

test("sem adiar, a FK recusa na hora", () => {
  const { raw, db } = fresh();
  assert.throws(() => inTransaction(db, (ctx) => ctx.db.exec("INSERT INTO c VALUES('c1','p1')")));
  assert.equal(count(raw, "c"), 0);
});

test("adiada: a linha apontada nasce depois na mesma transação", () => {
  const { raw, db } = fresh();
  inTransaction(db, (ctx) => {
    deferForeignKeys(ctx, "c");
    ctx.db.exec("INSERT INTO c VALUES('c1','p1')");
    ctx.db.exec("INSERT INTO p VALUES('p1')");
  });
  assert.equal(count(raw, "c"), 1);
});

test("adiada e nunca satisfeita: 23503 antes do COMMIT, nada gravado", () => {
  const { raw, db } = fresh();
  assert.throws(
    () =>
      inTransaction(db, (ctx) => {
        deferForeignKeys(ctx, "c");
        ctx.db.exec("INSERT INTO c VALUES('c1','p1')");
      }),
    (e) => e.code === "23503" && e.message === "foreign_key_violation:c",
  );
  assert.equal(count(raw, "c"), 0);
  // A transação seguinte volta a recusar na hora (o PRAGMA vale só para aquela transação).
  assert.throws(() => inTransaction(db, (ctx) => ctx.db.exec("INSERT INTO c VALUES('c2','p2')")));
});
