// Desvios deliberados do oráculo (src/erp/schema/deviations.ts).
//   node --test tests/erp/deviations.test.mjs
// - a lista só toca valores iniciais semeados, com motivo, e cada item ainda
//   bate com o valor do Fagoo (se o Fagoo mudar, o teste e o gerador param);
// - o mecanismo troca exatamente as linhas do desvio;
// - no diferencial, com o desvio valendo, os dois motores leem o valor do
//   Vinki e a semeadura diferente não aparece como divergência.
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { oracleDb } from "../../scripts/erp/oracle-db.mjs";
import { pgSelect, pgToLite } from "../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../src/erp/schema/columns.generated.ts";
import { ERP_SEED } from "../../src/erp/schema/seed.generated.ts";
import {
  ERP_DEVIATIONS,
  FUNCTION_DEFINITION_SQL,
  applyDeviations,
  applyFunctionDeviation,
  checkDeviations,
  checkFunctionDeviation,
  functionDeviationApplied,
  isFunctionDeviation,
  liteValue,
} from "../../src/erp/schema/deviations.ts";
import { inTransaction } from "../../src/erp/engine/registry.ts";
import * as preferences from "../../src/erp/domains/preferences/public.ts";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { diffTables, IdMap } from "./harness/state-compare.mjs";

const codecOf = (table, column) => ERP_TABLES[table].columns[column].codec;
const forced = ERP_DEVIATIONS.map((d) => ({ ...d, applied: true }));
const seedDeviations = ERP_DEVIATIONS.filter((d) => !isFunctionDeviation(d));
const functionDeviations = ERP_DEVIATIONS.filter(isFunctionDeviation);
const definition = async (pg, fn) => {
  const [schema, name] = fn.split(".");
  return (await pg.query(FUNCTION_DEFINITION_SQL, [schema, name])).rows;
};

test("lista: valores semeados e trechos de saída de função, com motivo (Origin, 2 casas, nome da exportação)", () => {
  assert.ok(ERP_DEVIATIONS.some((d) => d.id === "origin-fora" && d.applied));
  assert.ok(ERP_DEVIATIONS.some((d) => d.id === "telas-2-casas"));
  assert.ok(ERP_DEVIATIONS.some((d) => d.id === "exportacao-wabotia" && d.applied));
  const seeded = new Set(ERP_SEED.map((t) => t.table));
  for (const d of seedDeviations) {
    assert.ok(seeded.has(d.table), `${d.table}: só dados semeados (referência e preferências)`);
    assert.ok(ERP_TABLES[d.table].columns[d.column], `${d.table}.${d.column}`);
    assert.ok(d.reason.length > 20 && d.decided, `${d.id}: motivo e decisão`);
  }
  for (const d of functionDeviations) {
    assert.match(d.fn, /^[a-z_]+\.[a-z0-9_]+$/, `${d.id}: schema.nome`);
    assert.ok(d.oracle && d.value && d.oracle !== d.value, `${d.id}: trechos`);
    assert.ok(d.reason.length > 20 && d.decided, `${d.id}: motivo e decisão`);
  }
});

test("cada desvio ainda bate com o Fagoo (oráculo)", async () => {
  const pg = await oracleDb();
  try {
    for (const d of functionDeviations) {
      const rows = await definition(pg, d.fn);
      assert.equal(rows.length, 1, `${d.fn}: sem sobrecarga`);
      assert.equal(checkFunctionDeviation(rows[0].def, d), null);
    }
    const tables = [...new Set(seedDeviations.map((d) => d.table))];
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
  const pending = seedDeviations.filter((d) => !d.applied);
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

test("desvio de função: o oráculo da fixture passa a devolver o trecho do Vinki, com dono, SECURITY DEFINER e GRANTs iguais", async () => {
  const d = functionDeviations.find((x) => x.id === "exportacao-wabotia");
  const pg = await oracleDb();
  const privileges = async (db) =>
    (
      await db.query(
        `select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) owner, p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='erp_platform_export_link'`,
      )
    ).rows[0];
  let before;
  try {
    before = await privileges(pg);
    assert.match((await definition(pg, d.fn))[0].def, /'brufap-exportacao-'/, "o banco do cache segue o Fagoo");
  } finally {
    await pg.close();
  }
  // Duas fixtures no mesmo processo: cada uma aplica o desvio no seu oráculo.
  for (let round = 0; round < 2; round++) {
    const f = await dualFixture();
    try {
      const def = (await definition(f.db, d.fn))[0].def;
      assert.ok(def.includes("'wabotia-exportacao-'") && !def.includes("'brufap-exportacao-'"), `rodada ${round}`);
      assert.deepEqual(await privileges(f.db), before, "dono, SECURITY DEFINER, search_path e GRANTs");
      // A saída da função no oráculo (e no motor, pelo f.rpc): o nome do arquivo de uma exportação pronta.
      const asked = await f.rpc("erp_platform_export_request", { p_user_id: f.users.admin, p_command_id: randomUUID() });
      const lease = randomUUID();
      const task = (await f.rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["company_export"] })).task;
      await f.rpc("erp_platform_export_plan", { p_task: task.id, p_lease: lease });
      const sha = "c".repeat(64);
      await f.rpc("erp_platform_export_complete", {
        p_task: task.id, p_lease: lease, p_sha256: sha, p_size_bytes: 100, p_object_key: `exports/${asked.export.id}/${sha}.zip`, p_manifest: { summary: {} },
      });
      const link = await f.rpc("erp_platform_export_link", { p_user_id: f.users.admin, p_export_id: asked.export.id });
      assert.match(link.filename, /^wabotia-exportacao-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
    } finally {
      await f.close();
    }
  }
});

test("desvio de função: trecho ausente ou repetido falha com a função e o trecho na mensagem", () => {
  const d = { kind: "function", id: "teste.funcao", fn: "public.erp_teste", oracle: "'velho-'", value: "'novo-'", reason: "x".repeat(30), decided: "teste", applied: true };
  const body = "create function public.erp_teste() returns text language sql as $$ select 'velho-' $$";
  assert.equal(checkFunctionDeviation(body, d), null);
  assert.match(applyFunctionDeviation(body, d), /'novo-'/);
  for (const [def, count] of [[body.replace("'velho-'", "'outro-'"), 0], [body.replace("'velho-'", "'velho-' || 'velho-'"), 2]]) {
    const problem = checkFunctionDeviation(def, d);
    assert.ok(problem.includes("public.erp_teste") && problem.includes("'velho-'") && problem.includes(`${count} vezes`), problem);
    assert.throws(() => applyFunctionDeviation(def, d), (e) => e.message.includes("public.erp_teste") && e.message.includes("'velho-'"));
  }
  assert.match(checkFunctionDeviation(null, d), /public\.erp_teste: a função não existe/);
  // Reaplicar no mesmo banco: só o estado exato (trecho do Fagoo some, o do Vinki uma vez) conta como aplicado.
  const applied = applyFunctionDeviation(body, d);
  assert.equal(functionDeviationApplied(applied, d), true);
  assert.equal(functionDeviationApplied(body, d), false);
  assert.equal(functionDeviationApplied(applied.replace("'novo-'", "'novo-' || 'novo-'"), d), false);
});
