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
import { pgSelect, pgToLite } from "../../../scripts/erp/gen-sqlite-lib.mjs";
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";
import "../../../src/erp/domains/index.ts";
import { callRpc, isPorted } from "../../../src/erp/engine/registry.ts";
import { Clock } from "../../../src/erp/engine/time.ts";
import { freshLite, nodeDriver } from "./node-driver.mjs";
import { IdMap, diffTables, diffValues } from "./state-compare.mjs";

const q = (id) => `"${id.replace(/"/g, '""')}"`;
const TABLES = Object.keys(ERP_TABLES);

export const ROLES = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal", "vendedor", "inactive"];

export async function dualFixture({ engine = process.env.ERP_ENGINE || "both" } = {}) {
  const pg = await oracleDb();
  const lite = freshLite();
  const driver = nodeDriver(lite);
  const clock = new Clock();
  const stats = { ported: 0, mirrored: 0, compared_tables: 0, pg_ms: 0, lite_ms: 0 };
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

  /** Copia do Postgres para o SQLite as tabelas dadas (FKs desligadas: sem cascata). */
  async function mirror(tables) {
    lite.exec("PRAGMA foreign_keys=OFF");
    lite.exec("BEGIN");
    try {
      for (const t of tables) {
        const info = ERP_TABLES[t];
        const cols = Object.entries(info.columns).filter(([, c]) => !["fold", "computed"].includes(c.codec));
        // Os gatilhos gerados (imutabilidade) não valem para a cópia do
        // harness: saem durante a cópia e voltam iguais.
        const triggers = lite.prepare("SELECT name, sql FROM main.sqlite_master WHERE type='trigger' AND tbl_name=?").all(t);
        for (const g of triggers) lite.exec(`DROP TRIGGER main.${q(g.name)}`);
        lite.exec(`DELETE FROM ${q(t)}`);
        const rows = (await pg.query(pgSelect(info))).rows;
        if (rows.length) {
          const ins = lite.prepare(`INSERT INTO ${q(t)} (${cols.map(([n]) => q(n)).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
          for (const r of rows) ins.run(...cols.map(([n, c]) => pgToLite(r[n], c)));
        }
        for (const g of triggers) lite.exec(g.sql);
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
    return dual(name, () => pgRpc(name, args), () => callRpc(driver, name, structuredClone(args), clock));
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
    const ids = new IdMap();
    const problems = [];
    if (a.ok !== b.ok) problems.push({ what: "resultado", pg: a.ok ? a.value : a.error, lite: b.ok ? b.value : b.error });
    else if (!a.ok) {
      if (a.error.code !== b.error.code || a.error.message !== b.error.message)
        problems.push({ what: "erro", pg: a.error, lite: b.error });
    } else problems.push(...diffValues(a.value, b.value, ids).map((d) => ({ what: "resposta", ...d })));
    const touched = [...new Set([...(await changedInPg()), ...lite.prepare("SELECT t FROM erp_changed").all().map((r) => r.t)])];
    stats.compared_tables += touched.length;
    if (!problems.length) problems.push(...(await diffTables(pg, lite, touched, ids)).map((d) => ({ what: "tabela", ...d })));
    await mirror(touched);
    if (problems.length)
      assert.fail(`Diferencial ${name}: os motores divergem\n${JSON.stringify(problems.slice(0, 4), null, 1)}`);
    if (!a.ok) throw a.raw;
    return a.value;
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
  await mirror(await changedInPg());
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
    /** Depois de SQL direto no Postgres: espelha o que mudou. */
    sync: async () => mirror(await changedInPg()),
    scalar,
    stats,
    catalog: async (entity, data) =>
      (await rpc("erp_catalog_save", { p_user_id: users.admin, p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data })).record,
    close: async () => {
      lite.close();
      await pg.close();
    },
  };
}
