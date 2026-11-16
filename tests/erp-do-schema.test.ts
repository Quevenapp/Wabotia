// Fase 0 do ERP, prova 4 (parte no workerd): o esquema gerado inteiro (430
// tabelas, índices, gatilhos e a semeadura) aplica numa instância erp: e as
// regras geradas valem lá dentro. Mede tempo e linhas escritas.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { migrate } from "../src/erp/schema/migrate";
import { ERP_DDL_VERSION } from "../src/erp/schema/ddl";

describe("ERP fase 0: esquema gerado no objeto", () => {
  it("aplica DDL e semeadura numa instância nova; regras geradas valem", async () => {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:schema-" + uid()));
    const result = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
      const t0 = performance.now();
      const first = migrate(state.storage);
      const t1 = performance.now();
      const again = migrate(state.storage);
      const sql = state.storage.sql;
      const count = (q: string) => Number(sql.exec(q).toArray()[0].n);
      const out: any = {
        first,
        again,
        // performance.now() só avança com E/S no workerd: medida de referência.
        ms: Math.round(t1 - t0),
        tables: count("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%\\_\\_%' ESCAPE '\\'"),
        indexes: count("SELECT count(*) n FROM sqlite_master WHERE type='index'"),
        triggers: count("SELECT count(*) n FROM sqlite_master WHERE type='trigger'"),
        municipalities: count('SELECT count(*) n FROM "erp_reference__municipality"'),
        bytes: sql.databaseSize,
      };
      out.sqlite_version = (() => {
        try {
          return sql.exec("SELECT sqlite_version() v").toArray()[0].v;
        } catch (e: any) {
          return String(e.message).slice(0, 60);
        }
      })();
      try {
        sql.exec('DELETE FROM "erp_reference__country" WHERE rowid IN (SELECT rowid FROM "erp_reference__country" LIMIT 1)');
        out.reference_delete = "permitido";
      } catch (e: any) {
        out.reference_delete = String(e.message).slice(0, 120);
      }
      return out;
    });
    console.log("ERP_SCHEMA " + JSON.stringify(result));
    expect(result.first).toMatchObject({ status: "applied", version: ERP_DDL_VERSION, statements: 973, seedRows: 7586 });
    expect(result.again).toMatchObject({ status: "current" });
    expect(result.tables).toBe(430);
    expect(result.triggers).toBeGreaterThan(148);
    expect(result.municipalities).toBe(5571);
  });

  it("passo 5→6: instância com a semeadura antiga (label__fold NULL) fica preenchida", async () => {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:schema-" + uid()));
    const out = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      migrate(state.storage);
      const folds = () => sql.exec('SELECT slug, label__fold f FROM "erp_catalog__contact_type" ORDER BY slug').toArray();
      const filled = folds();
      // Como uma instância criada na versão 5: colunas normalizadas da semeadura NULL.
      sql.exec('UPDATE "erp_catalog__contact_type" SET label__fold = NULL');
      sql.exec("UPDATE erp_meta SET value='5' WHERE key='schema_version'");
      const step = migrate(state.storage);
      return { filled, step, after: folds(), again: migrate(state.storage) };
    });
    expect(out.filled.every((r: any) => r.f !== null)).toBe(true);
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.after).toEqual(out.filled);
    expect(out.again).toMatchObject({ status: "current" });
  });

  it("o ping do ERP aplica o esquema na primeira chamada (tempo Worker→objeto)", async () => {
    const profile = uid();
    const t0 = Date.now();
    const first = await erpFetch(env, profile, "/erp-ping");
    const t1 = Date.now();
    expect(first.status).toBe(200);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = Date.now();
      await erpFetch(env, profile, "/erp-ping");
      times.push(Date.now() - s);
    }
    times.sort((a, b) => a - b);
    const body = await first.json<any>();
    console.log(
      "ERP_PING " +
        JSON.stringify({ first_ms: t1 - t0, p50_ms: times[10], p95_ms: times[18], max_ms: times[19], bytes: body.database_size }),
    );
    expect(body.schema_version).toBe(ERP_DDL_VERSION);
    // Gatilho gerado no objeto: imutabilidade com código e mensagem.
    const raised = await runInDurableObject(erpStub(env, profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const trigger = sql
        .exec("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%RAISE(ABORT%' AND sql LIKE '%BEFORE DELETE%' LIMIT 1")
        .toArray()[0] as { name: string; tbl_name: string };
      return { trigger };
    });
    expect(raised.trigger.name).toMatch(/__/);
  });
});
