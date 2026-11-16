// As 20 colunas numeric sem escala do Fagoo (scripts/erp/overrides.mjs):
// valores de fronteira passam pelo Postgres e pelo codec do SQLite sem perda.
//   node --test tests/erp/numeric-boundary.test.mjs
// - codec: cada valor de fronteira, depois do numeric do Postgres, cabe na
//   coluna gerada e volta igual (dec: mesmo número; dec_text: mesmo texto);
// - caminho real: o teste do Fagoo tools/migration/test_unit_price_precision_sql.mjs
//   grava preço de 14 inteiros e 10 casas por erp_catalog_save; aqui a mesma
//   gravação, espelhada e comparada nos dois motores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { overrides } from "../../scripts/erp/overrides.mjs";
import { oracleDb } from "../../scripts/erp/oracle-db.mjs";
import { decText, pgToLite } from "../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_DDL_GENERATED } from "../../src/erp/schema/ddl.generated.ts";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { formatScaled } from "../../src/erp/engine/dec.ts";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { diffTables, IdMap } from "./harness/state-compare.mjs";

const q = (id) => `"${id.replace(/"/g, '""')}"`;

/** Fronteiras de cada coluna, pela evidência registrada em overrides. */
function boundaries(o) {
  const nines = (n) => "9".repeat(n);
  const int = o.precision - o.scale;
  const top = `${nines(int)}.${nines(o.scale)}`;
  const tiny = `0.${"0".repeat(o.scale - 1)}1`;
  const out = ["0", tiny, top, `1.${"0".repeat(o.scale)}`, "1.5"];
  // A observação do espelho aceita negativo (abs < 1e24).
  if (o.codec === "dec_text" && o.scale === 12) out.push(`-${top}`, `-${tiny}`);
  return out;
}

test("as 20 colunas: fronteiras do Fagoo cabem no codec e voltam iguais", async () => {
  const pg = await oracleDb();
  const lite = new DatabaseSync(":memory:");
  for (const s of ERP_DDL_GENERATED) lite.exec(s);
  const seen = [];
  try {
    for (const [key, o] of Object.entries(overrides.columns)) {
      const [schema, table, column] = key.split(".");
      const spec = ERP_TABLES[`${schema}__${table}`].columns[column];
      assert.equal(spec.codec, o.codec, key);
      assert.equal(spec.scale, o.scale, key);
      assert.ok(o.evidence && ["evidência", "assumido"].includes(o.status), `${key}: decisão com motivo`);
      const type = lite.prepare(`SELECT type FROM pragma_table_info(?) WHERE name=?`).get(`${schema}__${table}`, column).type;
      lite.exec(`CREATE TEMP TABLE IF NOT EXISTS probe_${type.toLowerCase()} (v ${type}) STRICT`);
      for (const value of boundaries(o)) {
        const fromPg = (await pg.query("select $1::numeric::text v", [value])).rows[0].v;
        const stored = pgToLite(fromPg, spec);
        lite.exec(`DELETE FROM probe_${type.toLowerCase()}`);
        lite.prepare(`INSERT INTO probe_${type.toLowerCase()} VALUES (?)`).run(stored);
        const back = lite.prepare(`SELECT CAST(v AS TEXT) v FROM probe_${type.toLowerCase()}`).get().v;
        if (o.codec === "dec") {
          assert.ok(Number.isSafeInteger(Number(back)), `${key} ${value}: ${back} acima de 2^53`);
          const same = (await pg.query("select $1::numeric = $2::numeric v", [formatScaled(BigInt(back), o.scale), fromPg])).rows[0].v;
          assert.ok(same, `${key} ${value}: ${back}`);
        } else {
          assert.equal(back, fromPg, `${key} ${value}`);
          assert.equal(decText(value, o.scale, false), fromPg, `decText ${value}`);
        }
        seen.push(key);
      }
    }
  } finally {
    await pg.close();
    lite.close();
  }
  assert.equal(new Set(seen).size, 20);
});

test("preço de 14 inteiros e 10 casas por erp_catalog_save: igual nos dois motores", async () => {
  const f = await dualFixture();
  try {
    const prices = ["0.0000000001", "1.2345678901", "99999999999999.9999999999", "1.2345000000", null];
    for (const price of prices) {
      const r = await f.catalog("products", { name: "Preço exato sintético", unit: "UN", kind: "P", format: "S", price, net_weight: "1.123456" });
      const lite = f.lite.prepare('SELECT price FROM "erp_catalog__product" WHERE record_id=?').get(r.id);
      assert.equal(lite.price, r.price, `preço ${price}`);
    }
    const diff = await diffTables(f.db, f.lite, ["erp_catalog__product"], new IdMap());
    assert.deepEqual(diff, []);
    // O CHECK de sinal traduzido vale no SQLite; o teto e as casas ficam no TS.
    assert.throws(() => f.lite.prepare('UPDATE "erp_catalog__product" SET price=? WHERE price IS NOT NULL').run("-1"), /CHECK/);
    assert.throws(() => f.lite.prepare('UPDATE "erp_catalog__product" SET price=? WHERE price IS NOT NULL').run("1e5"), /CHECK/);
  } finally {
    await f.close();
  }
});
