// Fase 0 do ERP, prova 7: medidas dentro do objeto erp: (workerd local; a
// CPU de produção só se confirma na instalação de teste).
// - erp_stock_post com 50 e 100 itens (o erp_document_save não foi portado);
// - relatório sobre 100 mil lançamentos de estoque (saldo por produto e
//   depósito, e a página do extrato), com linhas lidas.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import "../src/erp/domains/index";
import { storageDriver } from "../src/erp/engine/driver";
import { callRpc } from "../src/erp/engine/registry";
import { Clock } from "../src/erp/engine/time";

const now = () => String(BigInt(Date.now()) * 1000n);

describe("ERP fase 0: medidas no objeto", () => {
  it("erp_stock_post com 50 e 100 itens; relatório sobre 100 mil linhas", async () => {
    const profile = uid();
    await erpFetch(env, profile, "/erp-ping");
    const user = crypto.randomUUID();
    const out = await runInDurableObject(erpStub(env, profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const t = now();
      sql.exec(`INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'estoque', 1, ?, ?)`, user, t, t);
      // 100 produtos e 10 depósitos, criados por SQL (o cadastro não foi portado).
      sql.exec(
        `INSERT INTO "erp_catalog__record"(id, entity, name, active, created_by, updated_by, created_at, updated_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<110)
         SELECT printf('00000000-0000-4000-8000-%012d', i), CASE WHEN i<=100 THEN 'products' ELSE 'warehouses' END,
                'Registro ' || i, 1, ?, ?, ?, ? FROM n`,
        user, user, t, t,
      );
      sql.exec(
        `INSERT INTO "erp_catalog__product"(record_id, unit, kind, format) SELECT id, 'UN', 'P', 'S' FROM "erp_catalog__record" WHERE entity='products'`,
      );
      sql.exec(`INSERT INTO "erp_catalog__warehouse"(record_id) SELECT id FROM "erp_catalog__record" WHERE entity='warehouses'`);
      const products = sql.exec(`SELECT id FROM "erp_catalog__record" WHERE entity='products' ORDER BY id`).toArray().map((r) => r.id as string);
      const warehouses = sql.exec(`SELECT id FROM "erp_catalog__record" WHERE entity='warehouses' ORDER BY id`).toArray().map((r) => r.id as string);
      const db = storageDriver(state.storage);
      const clock = new Clock();
      const post = (n: number) => {
        const items = products.slice(0, n).map((p) => ({
          product_id: p,
          warehouse_id: warehouses[0],
          quantity: "3.5",
          expected_version: Number(
            sql.exec(`SELECT coalesce((SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?),0) v`, p, warehouses[0]).toArray()[0].v,
          ),
        }));
        const before = sql.databaseSize;
        const t0 = performance.now();
        const r: any = callRpc(db, "erp_stock_post", {
          p_user_id: user, p_command_id: crypto.randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-15",
          p_reason: "Medida de lançamento", p_items: items, p_reference: null,
        }, clock);
        return { items: n, ms: +(performance.now() - t0).toFixed(1), lines: r.movement.items.length, growth_bytes: sql.databaseSize - before };
      };
      const posts = [post(50), post(50), post(100), post(100)];

      // 100 mil lançamentos sintéticos: 1.000 movimentos × 100 linhas.
      const t1 = performance.now();
      sql.exec(
        `INSERT INTO "erp_stock__movement"(id, kind, occurred_on, reason, reference, actor, command_id, reverses_id, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
         SELECT printf('10000000-0000-4000-8000-%012d', i), 'receipt', '2026-10-15', 'Carga sintética', NULL, ?,
                printf('20000000-0000-4000-8000-%012d', i), NULL, ? + i FROM n`,
        user, t,
      );
      const load = sql.exec(
        `INSERT INTO "erp_stock__entry"(movement_id, ordinal, product_id, warehouse_id, quantity, unit, balance_after, balance_version)
         WITH RECURSIVE m(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM m WHERE i<1000),
                        l(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM l WHERE j<100)
         SELECT printf('10000000-0000-4000-8000-%012d', i), j,
                printf('00000000-0000-4000-8000-%012d', j),
                printf('00000000-0000-4000-8000-%012d', 101 + (i % 10)),
                1000000 + j, 'UN', 0, 1 FROM m, l`,
      );
      const loadMs = performance.now() - t1;
      const report = (label: string, q: string, ...args: unknown[]) => {
        const t0 = performance.now();
        const c = sql.exec(q, ...args);
        const rows = c.toArray();
        return { report: label, ms: +(performance.now() - t0).toFixed(1), rows: rows.length, rowsRead: c.rowsRead };
      };
      const reports = [
        report(
          "saldo por produto e depósito (100 mil linhas)",
          `SELECT product_id, warehouse_id, CAST(sum(quantity) AS TEXT) q, count(*) n FROM "erp_stock__entry" GROUP BY product_id, warehouse_id`,
        ),
        report(
          "extrato de um produto, página de 50",
          `SELECT e.movement_id, e.ordinal, CAST(e.quantity AS TEXT) q, m.occurred_on, m.created_at FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id WHERE e.product_id=? ORDER BY m.created_at DESC, e.ordinal LIMIT 50`,
          products[41],
        ),
        report(
          "total por depósito com JSON na resposta",
          `SELECT warehouse_id, json_group_array(json_object('p', product_id, 'q', CAST(quantity AS TEXT))) j FROM (SELECT warehouse_id, product_id, sum(quantity) quantity FROM "erp_stock__entry" GROUP BY 1,2) GROUP BY warehouse_id`,
        ),
      ];
      return { posts, load: { rows: load.rowsWritten, ms: Math.round(loadMs) }, reports, bytes: sql.databaseSize };
    });
    console.log("ERP_MEASURE " + JSON.stringify(out));
    expect(out.posts[3].lines).toBe(100);
    expect(out.reports[0].rows).toBe(1000);
  }, 120_000);
});
