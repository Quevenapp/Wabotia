// Tabelas só do motor da reforma tributária (engine-tables.ts, versão 7;
// structural.ts, reforma-classificacao) no workerd: um objeto na versão 6
// migra para a 7 e ganha as tabelas, e o backup com a restauração as leva.
// Base: tests/erp-do-backup.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import "../src/erp/domains/index";
import { dumpAll } from "../src/erp/engine/dump";
import { migrate } from "../src/erp/schema/migrate";
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../src/erp/schema/ddl";
import { ERP_ENGINE_TABLES } from "../src/erp/schema/engine-tables";

const micros = () => String(BigInt(Date.now()) * 1000n);
const TABLES = ERP_ENGINE_TABLES.map((t) => t.table);

describe("ERP: tabelas da classificação da reforma", () => {
  it("passo 6→7: o objeto da versão 6 ganha as duas tabelas", async () => {
    const profile = uid();
    await erpFetch(env, profile, "/erp-ping");
    const out = await runInDurableObject(erpStub(env, profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const exists = () => TABLES.map((t) => sql.exec("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?", t).toArray()[0].n);
      const fresh = exists();
      // Como um objeto criado na versão 6: sem as tabelas só do motor.
      for (const t of TABLES) sql.exec(`DROP TABLE "${t}"`);
      sql.exec("UPDATE erp_meta SET value='6' WHERE key='schema_version'");
      const dropped = exists();
      const step = migrate(state.storage);
      const meta = Object.fromEntries(sql.exec("SELECT key, value FROM erp_meta WHERE key IN ('schema_version','schema_hash')").toArray().map((r: any) => [r.key, r.value]));
      return { fresh, dropped, step, after: exists(), meta, again: migrate(state.storage) };
    });
    // A partir da 7 (as versões seguintes passam pelo passo 6→7 também).
    expect(ERP_DDL_VERSION).toBeGreaterThanOrEqual(7);
    expect(out.fresh).toEqual([1, 1]);
    expect(out.dropped).toEqual([0, 0]);
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.after).toEqual([1, 1]);
    expect(out.meta).toEqual({ schema_version: String(ERP_DDL_VERSION), schema_hash: ERP_DDL_HASH });
    expect(out.again).toMatchObject({ status: "current" });
  });

  it("os CHECK nomeados valem e o backup com a restauração levam as linhas", async () => {
    const source = uid(),
      target = uid();
    await erpFetch(env, source, "/erp-ping");
    const user = crypto.randomUUID(),
      nature = crypto.randomUUID(),
      product = crypto.randomUUID();
    const checks = await runInDurableObject(erpStub(env, source), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const t = micros();
      sql.exec(
        `INSERT INTO "erp_fiscal_invoices__nature"(id, description, direction, crt, presence, invoiced, final_consumer, return_operation, update_last_purchase_price,
           include_freight_ipi_base, others, retentions, active, version, created_by, updated_by, created_at, updated_at, description__fold)
         VALUES(?, 'Natureza sintética', '1', '1', '9', 1, 0, 0, 0, 0, '{}', '{}', 1, 1, ?, ?, ?, ?, 'natureza sintética')`,
        nature, user, user, t, t,
      );
      sql.exec(`INSERT INTO "erp_catalog__record"(id, entity, name, active, created_by, updated_by, created_at, updated_at) VALUES(?, 'products', 'Produto sintético', 1, ?, ?, ?, ?)`, product, user, user, t, t);
      sql.exec(`INSERT INTO "erp_catalog__product"(record_id, unit, kind, format) VALUES(?, 'UN', 'S', 'S')`, product);
      sql.exec(
        `INSERT INTO "erp_fiscal_reform__nature_class"(nature_id, position, product_scope, ncms, product_ids, group_ids, cst, cclasstrib, updated_by, updated_at)
         VALUES(?, 1, 'any', '[]', '[]', '[]', '000', '000001', ?, ?), (?, 2, 'ncm', '["8471"]', '[]', '[]', '200', '200030', ?, ?)`,
        nature, user, t, nature, user, t,
      );
      sql.exec(
        `INSERT INTO "erp_fiscal_reform__product_class"(product_id, cst, cclasstrib, nbs, version, updated_by, updated_at) VALUES(?, '000', '000001', '101011100', 1, ?, ?)`,
        product, user, t,
      );
      const refused = (s: string, ...p: unknown[]) => {
        try {
          sql.exec(s, ...p);
          return "aceitou";
        } catch (e: any) {
          return String(e.message).match(/erp_fiscal_reform__\w+|FOREIGN KEY|UNIQUE|PRIMARY KEY/)?.[0] ?? String(e.message).slice(0, 80);
        }
      };
      const row = (scope: string, ncms: string, cst = "000", cls = "000001") =>
        refused(
          `INSERT INTO "erp_fiscal_reform__nature_class"(nature_id, position, product_scope, ncms, product_ids, group_ids, cst, cclasstrib, updated_by, updated_at) VALUES(?, 9, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
          nature, scope, ncms, cst, cls, user, t,
        );
      return {
        scope: row("ncm", "[]"),
        any: row("any", '["8471"]'),
        unknown: row("outro", "[]"),
        cst: row("any", "[]", "00"),
        cclasstrib: row("any", "[]", "000", "00000A"),
        nbs: refused(`UPDATE "erp_fiscal_reform__product_class" SET nbs='12345' WHERE product_id=?`, product),
        version: refused(`UPDATE "erp_fiscal_reform__product_class" SET version=0 WHERE product_id=?`, product),
        product: refused(
          `INSERT INTO "erp_fiscal_reform__product_class"(product_id, cst, cclasstrib, version, updated_by, updated_at) VALUES(?, '000', '000001', 1, ?, ?)`,
          crypto.randomUUID(), user, t,
        ),
      };
    });
    expect(checks).toEqual({
      scope: "erp_fiscal_reform__nature_class_scope",
      any: "erp_fiscal_reform__nature_class_scope",
      unknown: "erp_fiscal_reform__nature_class_product_scope_check",
      cst: "erp_fiscal_reform__nature_class_cst_check",
      cclasstrib: "erp_fiscal_reform__nature_class_cclasstrib_check",
      nbs: "erp_fiscal_reform__product_class_nbs_check",
      version: "erp_fiscal_reform__product_class_version_check",
      product: "FOREIGN KEY",
    });
    const backup = await (await erpFetch(env, source, "/erp-backup", { method: "POST" })).json<any>();
    const listed = backup.manifest.tables.filter((t: any) => TABLES.includes(t.table)).map((t: any) => [t.table, t.rows]);
    expect(listed).toEqual([
      ["erp_fiscal_reform__nature_class", 2],
      ["erp_fiscal_reform__product_class", 1],
    ]);
    await erpFetch(env, target, "/erp-ping");
    await erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    const again = await runInDurableObject(erpStub(env, target), (_i: any, state: DurableObjectState) => dumpAll(state.storage).manifest);
    expect(again.tables).toEqual(backup.manifest.tables);
    const rows = (p: string) =>
      runInDurableObject(erpStub(env, p), (_i: any, state: DurableObjectState) => ({
        nature: state.storage.sql.exec(`SELECT nature_id, position, product_scope, ncms, cst, cclasstrib FROM "erp_fiscal_reform__nature_class" ORDER BY position`).toArray(),
        product: state.storage.sql.exec(`SELECT product_id, cst, cclasstrib, nbs, version FROM "erp_fiscal_reform__product_class"`).toArray(),
      }));
    expect(await rows(target)).toEqual(await rows(source));
  }, 120_000);
});
