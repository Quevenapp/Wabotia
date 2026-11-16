// As consultas do teste original "PRF-296, CTT-045, VND-042" de
// workers/erp-api/test/plataforma-h-sql.test.mjs do Fagoo (que passa pela
// rota HTTP; a rota com o motor novo é a prova 6), chamando o RPC
// erp_reference_search na fixture dupla: cada chamada roda nos dois motores
// e as asserções originais sobre os itens valem.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());
const search = (table, q, uf = null, user = f.users.admin, limit = 20) =>
  f.rpc("erp_reference_search", { p_user_id: user, p_table: table, p_query: q, p_uf: uf, p_limit: limit });

test("PRF-296, CTT-045, VND-042: official tables for any member; strict queries", async () => {
  const cnae = await search("cnae", "4744", null, f.users.vendas);
  assert.ok(cnae.items.length > 0);
  assert.ok(cnae.items.every((i) => i.code.replace(/\D/g, "").startsWith("4744")));
  const words = await search("cnae", "comercio varejista de ferragens");
  assert.ok(words.items.some((i) => i.code === "4744-0/01"), JSON.stringify(words.items.slice(0, 3)));
  const city = await search("municipios", "alta floresta doeste", "RO");
  assert.deepEqual(city.items.map((i) => i.code), ["1100015"]);
  const country = await search("paises", "alemanha");
  assert.deepEqual(country.items[0], { code: "0230", name: "ALEMANHA" });
  assert.ok(!(await search("paises", "wake")).items.length, "a country closed in 2018 is not offered");
  await assert.rejects(() => search("paises", null, "SP"), (e) => e.code === "22023");
  await assert.rejects(() => search("ncm", null), (e) => e.code === "22023");
  await assert.rejects(() => search("cnae", null, null, f.users.inactive), (e) => e.code === "42501");
});

test("buscas com acento, prefixo, dígitos e limites batem nos dois motores", async () => {
  for (const [table, q, uf, limit] of [
    ["municipios", "são paulo", null, 10],
    ["municipios", "SAO", "SP", 50],
    ["municipios", "3550", null, 5],
    ["municipios", null, "AC", 50],
    ["municipios", "ç", null, 3],
    ["cnae", "ALIMENTOS", null, 50],
    ["cnae", "62", null, 50],
    ["cnae", null, null, 1],
    ["paises", "a", null, 50],
    ["paises", "10", null, 50],
  ])
    await search(table, q, uf, f.users.admin, limit);
  await assert.rejects(() => search("cnae", "x".repeat(81)), (e) => e.code === "22023");
  await assert.rejects(() => search("cnae", "a", null, f.users.admin, 51), (e) => e.code === "22023");
  await assert.rejects(() => search("municipios", "a", "sp"), (e) => e.code === "22023");
});
