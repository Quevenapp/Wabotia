// erp_sync.* com o Origin fora (sync/origin-off.ts) contra o oráculo, com o
// desvio origin-fora aplicado nos dois motores (settings.enabled = false).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import * as sync from "../../../src/erp/domains/sync/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());
const pg = async (sql, args = []) => (await f.db.query(sql, args)).rows[0]?.v ?? null;
const lite = (fn) => inTransaction(f.driver, fn, f.clock);

test("desvio origin-fora: a sincronização está desligada nos dois motores", async () => {
  assert.equal(await pg("select enabled v from erp_sync.settings where singleton"), false);
  assert.equal(lite((ctx) => sync.enabled(ctx)), false);
});

test("origin_number: a mesma conversão do Postgres", async () => {
  const values = [12, -3.5, 0, "007", "1.50", "-0.0", "1e3", "abc", "", " 5", "123456789012345", "1234567890123456", true, null, [1], { a: 1 }, "12.", ".5", "-0"];
  for (const v of values) {
    const want = await pg("select erp_sync.origin_number($1::jsonb) v", [JSON.stringify(v)]);
    assert.equal(sync.originNumber(v), want, JSON.stringify(v));
  }
});

test("origin_effects, origin_locked e stock_import_allowed sem documento do Origin", async () => {
  const id = randomUUID();
  assert.deepEqual(lite((ctx) => sync.originEffects(ctx, id)), await pg("select erp_sync.origin_effects($1) v", [id]));
  assert.equal(lite((ctx) => sync.originLocked(ctx, id)), await pg("select erp_sync.origin_locked($1) v", [id]));
  assert.equal(
    lite((ctx) => sync.stockImportAllowed(ctx)),
    await pg("select erp_sync.stock_import_allowed($1,$2,$3,1,1) v", [randomUUID(), randomUUID(), randomUUID()]),
  );
  // Capturas e guardas: sem efeito e sem erro com a sincronização desligada.
  lite((ctx) => {
    sync.captureCatalog(ctx);
    sync.captureDocument(ctx);
    sync.captureFinance(ctx);
    sync.captureStock(ctx);
    sync.guardOriginEffectsDocument(ctx, id);
    sync.guardOriginEffectsItem(ctx, id);
  });
});

test("guard_zero_title: título com origem zerada é recusado fora da aplicação do espelho", async () => {
  assert.throws(
    () => lite((ctx) => sync.guardZeroTitle(ctx, "INSERT", null, { origin_zero_source_id: "123", amount_cents: 0 })),
    (e) => e.code === "22023" && e.message === "ZERO_TITLE_SOURCE_REQUIRED",
  );
  assert.equal(lite((ctx) => sync.guardZeroTitle(ctx, "UPDATE", { origin_zero_source_id: "123" }, { origin_zero_source_id: "123", amount_cents: 500 })), null);
  assert.equal(lite((ctx) => sync.guardZeroTitle(ctx, "INSERT", null, { origin_zero_source_id: null, amount_cents: 0 })), null);
  // O mesmo no oráculo: a função do gatilho recusa a origem zerada sem a aplicação do espelho.
  const def = await pg("select pg_get_functiondef('erp_sync.guard_zero_title'::regproc) v");
  assert.match(def, /ZERO_TITLE_SOURCE_REQUIRED/);
});
