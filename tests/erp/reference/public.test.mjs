// Referências: funções públicas (src/erp/domains/reference/public.ts) contra o oráculo.
import { test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as reference from "../../../src/erp/domains/reference/public.ts";

const f = await dualFixture();
test.after(() => f.close());
const both = (label, sql, args, ts) =>
  f.dual(label, async () => (await f.db.query(sql, args)).rows[0]?.v ?? null, () => inTransaction(f.driver, (ctx) => ts(ctx.db), f.clock));

test("key e municipality_known", async () => {
  for (const text of ["São Paulo", "ALTA FLORESTA D'OESTE", "Ação, Ñandu & Ü", "  ", "", null, "4744-0/01", "ÁÉÍÓÚÇ"])
    await both("key", "select erp_reference.key($1) v", [text], () => reference.key(text));
  for (const [city, uf] of [
    ["São Paulo", "SP"], ["sao paulo", " sp "], ["Campinas", "RJ"], ["Alta Floresta D'Oeste", "RO"], ["", "SP"],
    [null, "SP"], ["Lisboa", "EX"], ["Lisboa", ""], ["Cidade Inexistente", "MG"],
  ])
    await both("municipality_known", "select erp_reference.municipality_known($1, $2) v", [city, uf], (db) => reference.municipalityKnown(db, city, uf));
});
