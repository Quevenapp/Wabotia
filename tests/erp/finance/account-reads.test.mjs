// Leituras de erp_finance.account em finance/public.ts (escritas pela P para o
// Catálogo; dono: Financeiro, sessão O), contra o oráculo:
// - accountOptions = erp_catalog.payment_method_accounts() (lower(name), id; 500; left 200);
// - accountName = left(name, 200); accountActive = conta existe e está ativa.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { accountActive, accountName, accountOptions } from "../../../src/erp/domains/finance/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("contas: ordem lower(name) e id, teto de 500, left(name, 200) e conta inativa", async () => {
  const r = rng(500);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const names = ["Banco", "banco", "BANCO", "Ágil", "ágil", "Caixa", "Ωmega ΑΣ", "ωmega ασ", "Zeta", "zeta", "ß conta", "😀 Pix", "İstanbul", "a"];
  const rows = [];
  for (let i = 0; i < 520; i++) {
    const long = r() < 0.05;
    rows.push([long ? "Conta longa ".repeat(20) + "é".repeat(5) : `${pick(names)} ${r() < 0.3 ? "" : Math.floor(r() * 50)}`.trim(), r() < 0.8]);
  }
  await f.db.query(
    "insert into erp_finance.account(name,kind,active) select x.n,'bank',x.a from jsonb_to_recordset($1::jsonb) x(n text,a boolean)",
    [JSON.stringify(rows.map(([n, a]) => ({ n, a })))],
  );
  await f.sync();
  const lite = (fn) => () => inTransaction(f.driver, (ctx) => fn(ctx.db));
  const options = await f.dual("accountOptions", async () => (await f.db.query("select erp_catalog.payment_method_accounts() v")).rows[0].v, lite(accountOptions));
  assert.equal(options.length, 500);
  assert.ok(options.some((o) => !o.active));
  const ids = (await f.db.query("select id::text id from erp_finance.account order by random() limit 40")).rows.map((x) => x.id);
  ids.push("00000000-0000-4000-8000-000000000000");
  for (const id of ids) {
    await f.dual("accountName", async () => (await f.db.query("select (select left(name,200) from erp_finance.account where id=$1) v", [id])).rows[0].v, lite((db) => accountName(db, id)));
    await f.dual("accountActive", async () => (await f.db.query("select exists(select 1 from erp_finance.account where id=$1 and active) v", [id])).rows[0].v, lite((db) => accountActive(db, id)));
  }
  assert.equal(await f.dual("accountName", async () => null, lite((db) => accountName(db, null))), null);
});
