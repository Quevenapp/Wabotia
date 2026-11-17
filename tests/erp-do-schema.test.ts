// Fase 0 do ERP, prova 4 (parte no workerd): o esquema gerado inteiro (430
// tabelas, índices, gatilhos e a semeadura) aplica numa instância erp: e as
// regras geradas valem lá dentro. Mede tempo e linhas escritas.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { migrate } from "../src/erp/schema/migrate";
import { ERP_DDL_VERSION } from "../src/erp/schema/ddl";
import { ERP_ENGINE_TABLES } from "../src/erp/schema/engine-tables";
import { ERP_GUARDS } from "../src/erp/schema/guards.generated";

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
    // 984 = 982 do gerado (com os 9 gatilhos do override sqlTriggers, versão 8)
    // + 2 tabelas só do motor (engine-tables.ts, versão 7); 432 tabelas.
    expect(result.first).toMatchObject({ status: "applied", version: ERP_DDL_VERSION, statements: 984, seedRows: 7586 });
    expect(result.again).toMatchObject({ status: "current" });
    expect(result.tables).toBe(432);
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
      // A versão 5 ainda não tinha as tabelas só do motor (o passo 6→7 as cria).
      for (const t of ERP_ENGINE_TABLES) sql.exec(`DROP TABLE "${t.table}"`);
      sql.exec("UPDATE erp_meta SET value='5' WHERE key='schema_version'");
      const step = migrate(state.storage);
      return { filled, step, after: folds(), again: migrate(state.storage) };
    });
    expect(out.filled.every((r: any) => r.f !== null)).toBe(true);
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.after).toEqual(out.filled);
    expect(out.again).toMatchObject({ status: "current" });
  });

  it("passo 7→8: instância sem os gatilhos do override sqlTriggers os ganha", async () => {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:schema-" + uid()));
    const out = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      migrate(state.storage);
      // Os gatilhos do override (guards.generated, source "override"), pelo prefixo "<schema>__<gatilho>__".
      const prefixes = ERP_GUARDS.filter((g: any) => g.source === "override").map((g) => `${g.table.split("__")[0]}__${g.trigger}__`);
      const cnab = () =>
        sql
          .exec("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
          .toArray()
          .map((r: any) => r.name as string)
          .filter((n) => prefixes.some((p) => n.startsWith(p)));
      const created = cnab();
      // Como uma instância criada na versão 7: sem esses gatilhos.
      for (const name of created) sql.exec(`DROP TRIGGER "${name}"`);
      sql.exec("UPDATE erp_meta SET value='7' WHERE key='schema_version'");
      const step = migrate(state.storage);
      return { created, step, after: cnab(), again: migrate(state.storage) };
    });
    // A recusa de cada um contra o oráculo: tests/erp/cnab-sql-triggers.test.mjs.
    expect(out.created.length).toBe(9);
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.after).toEqual(out.created);
    expect(out.again).toMatchObject({ status: "current" });
  });

  // Tempo da subida 6→atual no objeto (a primeira requisição depois da
  // implantação). Os passos só mexem em DDL (2 tabelas, os gatilhos recriados),
  // sem trabalho proporcional aos dados; a fidelidade da subida (esquema da v6
  // de verdade, dados do motor) está em tests/erp/schema-upgrade.test.mjs.
  it("passo 6→atual no objeto: tempo da subida", async () => {
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("erp:schema-" + uid()));
    const out = await runInDurableObject(stub, (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      migrate(state.storage);
      for (const t of ERP_ENGINE_TABLES) sql.exec(`DROP TABLE "${t.table}"`);
      sql.exec("UPDATE erp_meta SET value='6' WHERE key='schema_version'");
      const t0 = performance.now();
      const step = migrate(state.storage);
      return { step, ms: performance.now() - t0 };
    });
    console.log("ERP_SCHEMA_UPGRADE " + JSON.stringify({ from: 6, to: ERP_DDL_VERSION, ms: Math.round(out.ms) }));
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.ms).toBeLessThan(5_000);
  });

  // O hub carrega o motor por import dinâmico (hub.ts, prova 7). No vitest
  // esse import passa pela transformação do Vite e leva ~28 s (medido em
  // 17/11: import 28,5 s; primeira aplicação do esquema 1,7 s; pings 4 ms), o
  // que estourava o tempo-limite do caso abaixo até na main pura. Custo do
  // ambiente de teste, não do produto: no bundle do wrangler o motor já vem
  // compilado. Carregado aqui, com tempo próprio, o caso mede só o objeto.
  beforeAll(() => import("../src/erp/hub-engine.ts"), 180_000);

  // Folga para máquina cheia: a primeira chamada aplica o DDL inteiro e a
  // semeadura num objeto novo, e o teste faz mais 20 idas.
  it("o ping do ERP aplica o esquema na primeira chamada (tempo Worker→objeto)", { timeout: 30_000 }, async () => {
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
