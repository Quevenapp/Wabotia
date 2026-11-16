// Fixture dupla do diferencial (PLANO-FAGOO-MOTOR.md, seção 2): a mesma
// interface das fixtures do Fagoo (rpc, scalar, db, users), com dois motores.
//   ERP_ENGINE=both (padrão): RPC portado roda no Postgres (oráculo) e no
//     motor novo; compara a resposta (ou o erro) e o estado das tabelas
//     tocadas. RPC ainda não portado roda só no Postgres e o estado é
//     espelhado para o SQLite. Depois de cada chamada os dois ficam iguais
//     (o SQLite recebe as linhas do Postgres, com os ids dele).
//   ERP_ENGINE=pg: só o Postgres (o teste original como era).
// `f.db` e `f.scalar` consultam o Postgres: as asserções originais valem
// sobre ele, e o comparador garante que o SQLite tem o mesmo estado.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { oracleDb } from "../../../scripts/erp/oracle-db.mjs";
import { pgToLite } from "../../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import "../../../src/erp/domains/index.ts";
import { callRpc, isPorted } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { ERP_DEVIATIONS } from "../../../src/erp/schema/deviations.ts";
import { derivedIds } from "./derived-ids.mjs";
import { freshLite, nodeDriver } from "./node-driver.mjs";
import { applyDeviationsBoth, seedDifferences, withoutTriggers } from "./seed-align.mjs";
import { IdMap, collectIds, diffTables, diffValues, liteRows, pgSelectAll } from "./state-compare.mjs";

const q = (id) => `"${id.replace(/"/g, '""')}"`;
const TABLES = Object.keys(ERP_TABLES);

export const ROLES = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal", "vendedor", "inactive"];

/**
 * deviations: desvios deliberados do oráculo (src/erp/schema/deviations.ts)
 * que valem nos dois motores. Padrão: os aplicados (os que estão na
 * semeadura); o Postgres recebe o mesmo valor antes de tudo, e a semeadura
 * diferente não vira divergência.
 * derived: formatos de id derivado (derived-ids.mjs); padrão: todos os
 * registrados.
 * Antes de tudo, a semeadura dos dois lados é alinhada (seed-align.mjs):
 * tabela semeada com uuid aleatório no Fagoo é copiada do Postgres; outra
 * diferença de semeadura para a fixture.
 */
export async function dualFixture({
  engine = process.env.ERP_ENGINE || "both",
  deviations = ERP_DEVIATIONS.filter((d) => d.applied),
  derived = derivedIds(),
} = {}) {
  const pg = await oracleDb();
  const lite = freshLite();
  const driver = nodeDriver(lite);
  const clock = new Clock();
  const stats = { ported: 0, mirrored: 0, compared_tables: 0, pg_ms: 0, lite_ms: 0, aligned: [], seed_gaps: [] };
  // Ids que já passaram pelos dois bancos (semeadura e espelho): nunca são
  // ligados a outro id na comparação (state-compare.mjs).
  const known = new Set();
  // Tabelas tocadas pelo motor no SQLite (gatilhos TEMP, só no banco de teste).
  lite.exec("CREATE TEMP TABLE erp_changed(t TEXT PRIMARY KEY)");
  for (const t of TABLES)
    for (const ev of ["INSERT", "UPDATE", "DELETE"])
      lite.exec(
        `CREATE TEMP TRIGGER ${q(`chg_${t}_${ev}`)} AFTER ${ev} ON main.${q(t)} BEGIN INSERT OR IGNORE INTO erp_changed VALUES('${t}'); END`,
      );
  const fingerprintSql =
    TABLES.map((t) => {
      const info = ERP_TABLES[t];
      return `select '${t}' t, md5(coalesce(string_agg(x::text,'|' order by x::text),'')) h from ${q(info.schema)}.${q(info.table)} x`;
    }).join(" union all ");
  const fingerprints = async () => new Map((await pg.query(fingerprintSql)).rows.map((r) => [r.t, r.h]));
  let last = await fingerprints();

  /**
   * Copia do Postgres para o SQLite as tabelas dadas (FKs desligadas: sem
   * cascata). As colunas normalizadas (__fold) e calculadas pelo motor vêm
   * preenchidas: a expressão do índice do Fagoo, avaliada no Postgres. O
   * motor que as grava com outro valor aparece na comparação.
   */
  async function mirror(tables) {
    lite.exec("PRAGMA foreign_keys=OFF");
    lite.exec("BEGIN");
    try {
      for (const t of tables) {
        const info = ERP_TABLES[t];
        const cols = Object.entries(info.columns);
        const rows = (await pg.query(pgSelectAll(info))).rows.map((r) => cols.map(([n, c]) => pgToLite(r[n], c)));
        withoutTriggers(lite, t, () => {
          lite.exec(`DELETE FROM ${q(t)}`);
          if (!rows.length) return;
          const ins = lite.prepare(`INSERT INTO ${q(t)} (${cols.map(([n]) => q(n)).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
          for (const r of rows) ins.run(...r);
        });
        for (const r of rows) collectIds(Object.fromEntries(cols.map(([n], i) => [n, r[i]])), t, derived, known);
      }
      lite.exec("COMMIT");
    } catch (e) {
      lite.exec("ROLLBACK");
      throw e;
    } finally {
      lite.exec("PRAGMA foreign_keys=ON");
      lite.exec("DELETE FROM erp_changed");
    }
    stats.mirrored += tables.length;
  }
  async function changedInPg() {
    const now = await fingerprints();
    const changed = TABLES.filter((t) => now.get(t) !== last.get(t));
    last = now;
    return changed;
  }

  const argTypes = new Map();
  async function types(name) {
    if (!argTypes.has(name))
      argTypes.set(
        name,
        new Map(
          (
            await pg.query(
              "select x.n,x.t from pg_proc p,unnest(p.proargnames,string_to_array(oidvectortypes(p.proargtypes),', ')) x(n,t) where p.proname=$1 and p.pronamespace='public'::regnamespace",
              [name],
            )
          ).rows.map((r) => [r.n, r.t]),
        ),
      );
    return argTypes.get(name);
  }
  async function pgRpc(name, args) {
    const e = Object.entries(args),
      t = await types(name);
    await pg.exec("set role service_role");
    try {
      return (
        await pg.query(
          `select public.${name}(${e.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) v`,
          e.map(([k, v]) =>
            Array.isArray(v) && t.get(k)?.endsWith("[]") ? v : v !== null && typeof v === "object" ? JSON.stringify(v) : v,
          ),
        )
      ).rows[0]?.v;
    } finally {
      await pg.exec("reset role");
    }
  }
  const outcome = async (fn) => {
    const t = performance.now();
    try {
      return { ok: true, value: await fn(), ms: performance.now() - t };
    } catch (error) {
      return { ok: false, error: { code: error.code, message: error.message }, raw: error, ms: performance.now() - t };
    }
  };

  async function rpc(name, args) {
    if (engine === "pg" || !isPorted(name)) {
      const r = await outcome(() => pgRpc(name, args));
      if (engine === "both") await mirror(await changedInPg());
      if (!r.ok) throw r.raw;
      return r.value;
    }
    return dual(name, () => pgRpc(name, args), () => callRpc(driver, name, structuredClone(args), clock, objectLookup));
  }

  /**
   * A mesma operação nos dois motores (RPC portado ou função interna):
   * compara resposta ou erro e as tabelas tocadas, e realinha o SQLite.
   */
  async function dual(name, pgFn, liteFn) {
    stats.ported++;
    lite.exec("DELETE FROM erp_changed");
    const a = await outcome(pgFn);
    const b = await outcome(liteFn);
    stats.pg_ms += a.ms;
    stats.lite_ms += b.ms;
    const ids = new IdMap(known);
    const problems = [];
    if (a.ok !== b.ok) problems.push({ what: "resultado", pg: a.ok ? a.value : a.error, lite: b.ok ? b.value : b.error });
    else if (!a.ok) {
      if (a.error.code !== b.error.code || a.error.message !== b.error.message)
        problems.push({ what: "erro", pg: a.error, lite: b.error });
    } else problems.push(...diffValues(a.value, b.value, ids, "$", [], derived).map((d) => ({ what: "resposta", ...d })));
    const touched = [...new Set([...(await changedInPg()), ...lite.prepare("SELECT t FROM erp_changed").all().map((r) => r.t)])];
    stats.compared_tables += touched.length;
    if (!problems.length)
      problems.push(...(await diffTables(pg, lite, touched, ids, { specs: derived })).map((d) => ({ what: "tabela", ...d })));
    await mirror(touched);
    if (problems.length)
      assert.fail(`Diferencial ${name}: os motores divergem\n${JSON.stringify(problems.slice(0, 4), null, 1)}`);
    if (!a.ok) throw a.raw;
    return a.value;
  }

  // Armazenamento: o bucket de anexos existe em produção (o Supabase o cria
  // fora das migrações); objetos enviados entram nos dois lados por putObject.
  const objects = new Map();
  const objectLookup = (key) => objects.get(key) ?? null;
  await pg.query(
    "insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('erp-attachments','erp-attachments',false,10485760,$1) on conflict do nothing",
    [["application/pdf", "image/png", "image/jpeg", "application/xml", "text/plain"]],
  );
  async function putObject(bucket, name, size, mimetype) {
    await pg.query("insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)", [bucket, name, JSON.stringify({ size: String(size), mimetype })]);
    objects.set(`${bucket}/${name}`, { size, mimetype });
  }

  await applyDeviationsBoth(pg, lite, deviations);
  if (engine !== "pg") {
    const seed = await seedDifferences(pg, lite, { specs: derived });
    if (seed.diffs.length)
      throw new Error(`Semeadura desalinhada (Postgres × SQLite)\n${JSON.stringify(seed.diffs.slice(0, 4), null, 1)}`);
    await mirror(seed.align);
    stats.aligned = seed.align;
    stats.seed_gaps = seed.gaps;
  }
  const users = Object.fromEntries(ROLES.map((r) => [r, randomUUID()]));
  for (const [role, id] of Object.entries(users)) {
    await pg.query("insert into auth.users(id,email) values($1,$2)", [id, `${role}@sintetico.test`]);
    await pg.query("insert into erp_access.membership(user_id,role,active) values($1,$2,$3)", [
      id,
      role === "vendedor" ? "vendas" : role === "inactive" ? "admin" : role,
      role !== "inactive",
    ]);
  }
  // Nome de perfil para cada pessoa: o rótulo de autor (erp_activity.actor_label)
  // usa o nome; sem perfil o Fagoo cairia no e-mail de auth.users, que o
  // objeto não tem (o sincronismo com Pessoas da fase 3 mantém o perfil).
  for (const [role, id] of Object.entries(users))
    await pg.query("insert into erp_access.profile(user_id,name,version,updated_by,updated_at) values($1,$2,1,$1,now())", [id, `Pessoa sintética ${role}`]);
  await mirror(await changedInPg());
  for (const t of TABLES) for (const r of liteRows(lite, t)) collectIds(r, t, derived, known);
  const scalar = async (text, args = []) => {
    const row = (await pg.query(text, args)).rows[0];
    return row ? (row.value ?? row.v ?? Object.values(row)[0]) : undefined;
  };
  return {
    engine,
    db: pg,
    lite,
    driver,
    users,
    rpc,
    dual,
    clock,
    putObject,
    objectLookup,
    /** Depois de SQL direto no Postgres: espelha o que mudou. */
    sync: async () => mirror(await changedInPg()),
    scalar,
    stats,
    known,
    catalog: async (entity, data) =>
      (await rpc("erp_catalog_save", { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record,
    close: async () => {
      lite.close();
      await pg.close();
    },
  };
}
