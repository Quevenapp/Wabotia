// to_jsonb(linha) no motor (engine/row-json.ts) contra o oráculo: as linhas
// das tabelas semeadas inteiras e valores de fronteira de cada codec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { pgSelect, pgToLite } from "../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { ERP_SEED } from "../../src/erp/schema/seed.generated.ts";
import { rowJson, rowJsonSelect, valueJson } from "../../src/erp/engine/row-json.ts";

const f = await dualFixture();
test.after(() => f.close());

const canon = (v) =>
  Array.isArray(v)
    ? "[" + v.map(canon).join(",") + "]"
    : v && typeof v === "object"
      ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
      : JSON.stringify(v);

test("linhas das tabelas semeadas: rowJson da mesma linha igual ao to_jsonb do oráculo", async () => {
  // A mesma linha do oráculo nas duas formas: to_jsonb(t) e a forma guardada
  // no SQLite (pgSelect + pgToLite). Não depende da semeadura do SQLite, que
  // pode ter sido gerada com outro now() (erp_a1.head.updated_at).
  let rows = 0;
  for (const { table } of ERP_SEED) {
    const info = ERP_TABLES[table];
    const select = pgSelect(info);
    const list = select.slice("select ".length, select.lastIndexOf(" from "));
    const cols = Object.entries(info.columns).filter(([, c]) => !["fold", "computed"].includes(c.codec));
    for (const r of (await f.db.query(`select to_jsonb(t) "__json", ${list} from "${info.schema}"."${info.table}" t`)).rows) {
      const stored = Object.fromEntries(cols.map(([n, c]) => [n, pgToLite(r[n], c)]));
      assert.equal(canon(rowJson(table, stored)), canon(r.__json), table);
      rows++;
    }
  }
  assert.ok(rows > 7000, `linhas conferidas: ${rows}`);
});

test("leitura pelo SQLite (rowJsonSelect): semeadura igual ao oráculo, a menos dos instantes", async () => {
  // Instantes semeados com now() na montagem do oráculo diferem do gerado (achado da P).
  const masked = (table, row) => {
    const out = { ...row };
    for (const [n, c] of Object.entries(ERP_TABLES[table].columns)) if (c.codec === "timestamp_us" && out[n] !== null && n in out) out[n] = "<tempo>";
    return canon(out);
  };
  for (const { table } of ERP_SEED) {
    const info = ERP_TABLES[table];
    const pg = (await f.db.query(`select to_jsonb(t) v from "${info.schema}"."${info.table}" t`)).rows.map((r) => masked(table, r.v)).sort();
    const lite = f.driver
      .exec(`SELECT ${rowJsonSelect(table)} FROM "${table}"`)
      .rows.map((r) => masked(table, rowJson(table, r)))
      .sort();
    assert.deepEqual(lite, pg, table);
  }
});

// Valor no tipo do Postgres → forma guardada no SQLite (como pgSelect + pgToLite) → valueJson.
const STORE = {
  timestamp_us: (v) =>
    `case when ${v} = 'infinity' then '9223372036854775807' when ${v} = '-infinity' then '-9223372036854775808' else (extract(epoch from ${v} - 'epoch'::timestamptz)::numeric * 1000000)::bigint::text end`,
  dec: (v) => `${v}::text`,
  dec_i64: (v) => `${v}::text`,
  dec_text: (v) => `${v}::text`,
  int: (v) => `${v}::text`,
  int53: (v) => `${v}::text`,
  date: (v) => `${v}::text`,
};
const CASES = [
  [{ codec: "dec", scale: 4 }, "numeric(15,4)", ["0", "1.5", "-2.0001", "99999999999.9999", "-0.0001"]],
  [{ codec: "dec", scale: 2 }, "numeric(12,2)", ["0.10", "1234567890.99"]],
  [{ codec: "dec_i64", scale: 6 }, "numeric(18,6)", ["999999999999.999999", "-0.000001", "12.5"]],
  [{ codec: "dec_text", scale: 10, fixed: true }, "numeric(30,10)", ["99999999999999.9999999999", "0.0000000001", "3"]],
  [{ codec: "dec_text", scale: 12, fixed: false }, "numeric", ["1.50", "0.000000000001", "-7"]],
  [{ codec: "timestamp_us" }, "timestamptz", ["2026-11-16 14:03:12.12+00", "2026-01-01 00:00:00.000001+00", "1900-01-01 00:00:00+00", "infinity", "-infinity"]],
  [{ codec: "date" }, "date", ["2026-02-28", "1900-01-01"]],
  [{ codec: "time" }, "time", ["10:00:00", "23:59:59.5"]],
  [{ codec: "bool" }, "boolean", ["true", "false"]],
  [{ codec: "int" }, "integer", ["2147483647", "-2147483648", "0"]],
  [{ codec: "int53" }, "bigint", ["9007199254740991", "-1"]],
  [{ codec: "json" }, "jsonb", ['{"a":[1,"x",null,true],"b":{"c":1.5}}', "[]", '"texto"']],
  [{ codec: "array:text" }, "text[]", ["{a,b}", "{}", '{"com espaço",NULL}']],
  [{ codec: "array:uuid" }, "uuid[]", ["{11111111-2222-4333-8444-555555555555}"]],
  [{ codec: "array:int4" }, "int4[]", ["{1,2,3}"]],
  [{ codec: "uuid" }, "uuid", ["11111111-2222-4333-8444-555555555555"]],
  [{ codec: "text" }, "text", ["Ação \"x\" \\ \n", ""]],
];

test("valores de fronteira de cada codec: to_jsonb igual", async () => {
  for (const [spec, type, values] of CASES)
    for (const text of values) {
      const store = (STORE[spec.codec] ?? ((v) => v))("x.v");
      const r = (await f.db.query(`select to_jsonb(x.v) j, ${store} s from (select $1::${type} v) x`, [text])).rows[0];
      const stored = pgToLite(r.s, { ...spec, nullable: true });
      assert.deepEqual(canon(valueJson({ ...spec, nullable: true }, stored)), canon(r.j), `${type} ${JSON.stringify(text)}`);
    }
});
