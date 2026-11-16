// Sondas da instalação de teste (roteiro da sessão K, scripts/erp/staging-check.mjs).
// Medem na Cloudflare o que o workerd local não mede: CPU real do
// erp_stock_post e do relatório de 100 mil linhas, limites do SQLite de
// produção, bookmark (recuperação no tempo) e localização do objeto. Só
// existem com a variável ERP_PROBES=1 no deploy (src/erp/api/local-fetch.ts,
// erpProbe) e só administrador chama. Dados sintéticos, numa área própria;
// "wipe" apaga tudo do objeto erp: dessa área.
import "./domains/index.ts";
import { storageDriver } from "./engine/driver.ts";
import { callRpc } from "./engine/registry.ts";
import { Clock } from "./engine/time.ts";

type Body = Record<string, any>;
const micros = () => String(BigInt(Date.now()) * 1000n);
const attempt = (fn: () => unknown) => {
  try {
    return { ok: true, value: fn() };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error).slice(0, 160) };
  }
};
const PRODUCT = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

export async function probe(ctx: DurableObjectState, name: string, body: Body): Promise<unknown> {
  const sql = ctx.storage.sql;
  const rows = (q: string, ...a: unknown[]) => sql.exec(q, ...a).toArray();
  switch (name) {
    // Vínculo do administrador, 100 produtos (P1…P100) e 10 depósitos (P101…P110).
    case "setup": {
      const t = micros();
      sql.exec(
        `INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'admin', 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role='admin', active=1`,
        body.user,
        t,
        t,
      );
      if (!rows(`SELECT 1 FROM "erp_catalog__record" WHERE id=?`, PRODUCT(1)).length) {
        sql.exec(
          `INSERT INTO "erp_catalog__record"(id, entity, name, active, created_by, updated_by, created_at, updated_at)
           WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<110)
           SELECT printf('00000000-0000-4000-8000-%012d', i), CASE WHEN i<=100 THEN 'products' ELSE 'warehouses' END,
                  'Registro sintético ' || i, 1, ?, ?, ?, ? FROM n`,
          body.user,
          body.user,
          t,
          t,
        );
        sql.exec(`INSERT INTO "erp_catalog__product"(record_id, unit, kind, format) SELECT id, 'UN', 'P', 'S' FROM "erp_catalog__record" WHERE entity='products'`);
        sql.exec(`INSERT INTO "erp_catalog__warehouse"(record_id) SELECT id FROM "erp_catalog__record" WHERE entity='warehouses'`);
      }
      return { products: 100, warehouses: 10, bytes: sql.databaseSize };
    }
    // erp_stock_post com N itens (até 100) no depósito P101.
    case "stock-post": {
      const n = Math.min(Number(body.items) || 100, 100);
      const items = Array.from({ length: n }, (_, k) => ({
        product_id: PRODUCT(k + 1),
        warehouse_id: PRODUCT(101),
        quantity: "3.5",
        expected_version: Number(
          rows(`SELECT coalesce((SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?),0) v`, PRODUCT(k + 1), PRODUCT(101))[0].v,
        ),
      }));
      const before = sql.databaseSize;
      const r: any = callRpc(storageDriver(ctx.storage), "erp_stock_post", {
        p_user_id: body.user,
        p_command_id: crypto.randomUUID(),
        p_kind: "receipt",
        p_occurred_on: "2026-10-15",
        p_reason: "Conferência na instalação de teste",
        p_items: items,
        p_reference: null,
      }, new Clock());
      return { items: n, lines: r.movement.items.length, growth_bytes: sql.databaseSize - before };
    }
    // Carga do relatório: movimentos [from, from+count) × 100 linhas (1.000 movimentos = 100 mil linhas).
    case "load": {
      const from = Number(body.from) || 1,
        count = Math.min(Number(body.count) || 200, 250);
      const t = micros();
      sql.exec(
        `INSERT INTO "erp_stock__movement"(id, kind, occurred_on, reason, reference, actor, command_id, reverses_id, created_at)
         WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
         SELECT printf('10000000-0000-4000-8000-%012d', i), 'receipt', '2026-10-15', 'Carga sintética', NULL, ?,
                printf('20000000-0000-4000-8000-%012d', i), NULL, ? + i FROM n`,
        from,
        from + count - 1,
        body.user,
        t,
      );
      const c = sql.exec(
        `INSERT INTO "erp_stock__entry"(movement_id, ordinal, product_id, warehouse_id, quantity, unit, balance_after, balance_version)
         WITH RECURSIVE m(i) AS (SELECT ? UNION ALL SELECT i+1 FROM m WHERE i<?),
                        l(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM l WHERE j<100)
         SELECT printf('10000000-0000-4000-8000-%012d', i), j, printf('00000000-0000-4000-8000-%012d', j),
                printf('00000000-0000-4000-8000-%012d', 101 + (i % 10)), 1000000 + j, 'UN', 0, 1 FROM m, l`,
        from,
        from + count - 1,
      );
      return { rows_written: c.rowsWritten, entries: rows(`SELECT count(*) n FROM "erp_stock__entry"`)[0].n, bytes: sql.databaseSize };
    }
    case "report": {
      const reports: Record<string, [string, unknown[]]> = {
        saldo: [`SELECT product_id, warehouse_id, CAST(sum(quantity) AS TEXT) q, count(*) n FROM "erp_stock__entry" GROUP BY product_id, warehouse_id`, []],
        extrato: [
          `SELECT e.movement_id, e.ordinal, CAST(e.quantity AS TEXT) q, m.occurred_on, m.created_at FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id WHERE e.product_id=? ORDER BY m.created_at DESC, e.ordinal LIMIT 50`,
          [PRODUCT(42)],
        ],
        deposito: [
          `SELECT warehouse_id, json_group_array(json_object('p', product_id, 'q', CAST(quantity AS TEXT))) j FROM (SELECT warehouse_id, product_id, sum(quantity) quantity FROM "erp_stock__entry" GROUP BY 1,2) GROUP BY warehouse_id`,
          [],
        ],
      };
      const [q, args] = reports[body.name] ?? reports.saldo;
      const c = sql.exec(q, ...args);
      return { report: body.name ?? "saldo", rows: c.toArray().length, rowsRead: c.rowsRead };
    }
    // Limites do SQLite em produção (o local mostrou 100 parâmetros, profundidade 100, LIKE de 50 bytes).
    case "limits": {
      const params = (n: number) => attempt(() => sql.exec(`SELECT ${Array.from({ length: n }, () => "?").join(",")}`, ...Array(n).fill(1)).toArray().length);
      const length = (n: number) => attempt(() => String(sql.exec(`SELECT '${"x".repeat(n)}' v`).toArray()[0]?.v).length);
      const depth = (n: number) => attempt(() => sql.exec(`SELECT ${"(".repeat(n)}1${")".repeat(n)} v`).toArray()[0].v);
      const chain = (n: number) => attempt(() => sql.exec(`SELECT ${Array(n).fill("1").join("+")} v`).toArray()[0].v);
      const like = (n: number) => attempt(() => sql.exec(`SELECT 'a' LIKE ? v`, "%".repeat(n)).toArray()[0].v);
      return {
        params: { 100: params(100), 101: params(101), 999: params(999), 32766: params(32766) },
        statement_bytes: {
          10_000: length(10_000),
          50_000: length(50_000),
          99_000: length(99_000),
          100_000: length(100_000),
          1_000_000: length(1_000_000),
        },
        parentheses_depth: { 99: depth(99), 100: depth(100), 1000: depth(1000) },
        plus_chain: { 100: chain(100), 1000: chain(1000) },
        like_pattern_bytes: { 50: like(50), 51: like(51) },
      };
    }
    // Recuperação no tempo: marcas, bookmark de um instante e restauração.
    case "bookmark-mark": {
      sql.exec(`INSERT INTO erp_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, `probe_mark_${body.label}`, String(Date.now()));
      return { label: body.label, at: Date.now(), bookmark: await ctx.storage.getCurrentBookmark() };
    }
    case "bookmark-at":
      return { at: body.at, bookmark: await ctx.storage.getBookmarkForTime(Number(body.at)) };
    case "bookmark-restore": {
      await ctx.storage.onNextSessionRestoreBookmark(String(body.bookmark));
      // Reinicia o objeto depois de responder: a próxima chamada vê o estado do bookmark.
      setTimeout(() => ctx.abort("restauração por bookmark (sonda)"), 50);
      return { restoring: body.bookmark };
    }
    case "bookmark-check":
      return { marks: rows(`SELECT key, value FROM erp_meta WHERE key LIKE 'probe_mark_%' ORDER BY key`) };
    // Onde o objeto roda (locationHint "sam"): o colo da saída do objeto.
    case "location": {
      const trace = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
      return { object_colo: /colo=(\w+)/.exec(trace)?.[1] ?? null, object_loc: /loc=(\w+)/.exec(trace)?.[1] ?? null };
    }
    // Limpeza: apaga tudo do objeto erp: da área de teste.
    case "wipe":
      await ctx.storage.deleteAlarm();
      await ctx.storage.deleteAll();
      return { wiped: true };
    default:
      return { error: "sonda desconhecida" };
  }
}
