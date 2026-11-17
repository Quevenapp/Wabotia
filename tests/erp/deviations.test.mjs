// Desvios deliberados do oráculo (src/erp/schema/deviations.ts).
//   node --test tests/erp/deviations.test.mjs
// - a lista só toca valores iniciais semeados, com motivo, e cada item ainda
//   bate com o valor do Fagoo (se o Fagoo mudar, o teste e o gerador param);
// - o mecanismo troca exatamente as linhas do desvio;
// - no diferencial, com o desvio valendo, os dois motores leem o valor do
//   Wabotia e a semeadura diferente não aparece como divergência.
import { test } from "node:test";
import assert from "node:assert/strict";
import { oracleDb } from "../../scripts/erp/oracle-db.mjs";
import { pgSelect, pgToLite } from "../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { ERP_SEED } from "../../src/erp/schema/seed.generated.ts";
import { ERP_DEVIATIONS, applyDeviations, checkDeviations, liteValue } from "../../src/erp/schema/deviations.ts";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import * as preferences from "../../src/erp/domains/preferences/public.ts";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { diffTables, IdMap } from "./harness/state-compare.mjs";

const codecOf = (table, column) => ERP_TABLES[table].columns[column].codec;
const forced = ERP_DEVIATIONS.map((d) => ({ ...d, applied: true }));

test("lista: só valores semeados, com motivo (Origin desligado e padrão de 2 casas)", () => {
  assert.ok(ERP_DEVIATIONS.some((d) => d.id === "origin-fora" && d.applied));
  assert.ok(ERP_DEVIATIONS.some((d) => d.id === "telas-2-casas"));
  const seeded = new Set(ERP_SEED.map((t) => t.table));
  for (const d of ERP_DEVIATIONS) {
    assert.ok(seeded.has(d.table), `${d.table}: só dados semeados (referência e preferências)`);
    assert.ok(ERP_TABLES[d.table].columns[d.column], `${d.table}.${d.column}`);
    assert.ok(d.reason.length > 20 && d.decided, `${d.id}: motivo e decisão`);
  }
});

test("cada desvio ainda bate com o Fagoo (oráculo)", async () => {
  const pg = await oracleDb();
  try {
    const tables = [...new Set(ERP_DEVIATIONS.map((d) => d.table))];
    const seed = [];
    for (const table of tables) {
      const info = ERP_TABLES[table];
      const rows = (await pg.query(pgSelect(info))).rows;
      const columns = Object.keys(rows[0]).filter((c) => info.columns[c]);
      seed.push({ table, columns, rows: rows.map((r) => columns.map((c) => pgToLite(r[c], info.columns[c]))) });
    }
    assert.deepEqual(checkDeviations(seed, ERP_DEVIATIONS, codecOf), []);
  } finally {
    await pg.close();
  }
});

test("o mecanismo troca só as linhas do desvio; a semeadura atual segue o Fagoo nos não aplicados", () => {
  const changed = applyDeviations(ERP_SEED, forced, codecOf);
  let diffs = 0;
  ERP_SEED.forEach((t, i) => t.rows.forEach((r, j) => r.forEach((v, k) => (v !== changed[i].rows[j][k] ? diffs++ : 0))));
  const pending = ERP_DEVIATIONS.filter((d) => !d.applied);
  assert.equal(diffs, pending.length, "os aplicados já estão na semeadura");
  assert.deepEqual(checkDeviations(ERP_SEED, pending, codecOf), [], "semeadura sem os desvios não aplicados");
  const applied = ERP_DEVIATIONS.filter((d) => d.applied).map((d) => ({ ...d, oracle: d.value }));
  assert.deepEqual(checkDeviations(ERP_SEED, applied, codecOf), [], "semeadura com os aplicados");
  assert.deepEqual(checkDeviations(changed, forced.map((d) => ({ ...d, oracle: d.value })), codecOf), []);
  assert.equal(liteValue("json", 2), "2");
});

test("diferencial com o desvio valendo: mesmo valor nos dois motores, sem divergência", async () => {
  const f = await dualFixture({ deviations: forced });
  try {
    assert.deepEqual(await diffTables(f.db, f.lite, ["erp_preferences__definition"], new IdMap()), []);
    for (const d of forced) {
      if (d.table !== "erp_preferences__definition") continue;
      const value = await f.dual(
        "erp_preferences.get",
        async () => (await f.db.query("select erp_preferences.get($1) v", [d.key.key])).rows[0].v,
        () => inTransaction(f.driver, (ctx) => preferences.get(ctx.db, d.key.key), f.clock),
      );
      assert.equal(value, d.value);
    }
  } finally {
    await f.close();
  }
  // Sem aplicar (o padrão hoje): o valor do Fagoo, nos dois motores.
  const g = await dualFixture();
  try {
    for (const d of ERP_DEVIATIONS.filter((x) => !x.applied && x.table === "erp_preferences__definition"))
      assert.equal(
        await g.dual(
          "erp_preferences.get",
          async () => (await g.db.query("select erp_preferences.get($1) v", [d.key.key])).rows[0].v,
          () => inTransaction(g.driver, (ctx) => preferences.get(ctx.db, d.key.key), g.clock),
        ),
        d.oracle,
      );
  } finally {
    await g.close();
  }
});
