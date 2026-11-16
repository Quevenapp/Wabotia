// Fase 0 do ERP, prova 8: dump lógico no R2 e restauração numa instância
// nova, com as mesmas linhas e os mesmos SHA-256 por tabela; e o que a API
// de bookmark (recuperação no tempo) responde no workerd local.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import "../src/erp/domains/index";
import { storageDriver } from "../src/erp/engine/driver";
import { callRpc } from "../src/erp/engine/registry";
import { dumpAll } from "../src/erp/engine/dump";

const micros = () => String(BigInt(Date.now()) * 1000n);

describe("ERP fase 0: backup e restauração", () => {
  it("dump no R2 e restauração numa instância nova batem tabela por tabela", async () => {
    const source = uid(),
      target = uid();
    await erpFetch(env, source, "/erp-ping");
    const user = crypto.randomUUID();
    // Dados sintéticos: vínculo, 20 produtos, 2 depósitos e 30 lançamentos.
    await runInDurableObject(erpStub(env, source), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const t = micros();
      sql.exec(`INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'estoque', 1, ?, ?)`, user, t, t);
      sql.exec(
        `INSERT INTO "erp_catalog__record"(id, entity, name, active, created_by, updated_by, created_at, updated_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<22)
         SELECT printf('00000000-0000-4000-8000-%012d', i), CASE WHEN i<=20 THEN 'products' ELSE 'warehouses' END,
                'Registro sintético ' || i, 1, ?, ?, ?, ? FROM n`,
        user, user, t, t,
      );
      sql.exec(`INSERT INTO "erp_catalog__product"(record_id, unit, kind, format) SELECT id,'UN','P','S' FROM "erp_catalog__record" WHERE entity='products'`);
      sql.exec(`INSERT INTO "erp_catalog__warehouse"(record_id) SELECT id FROM "erp_catalog__record" WHERE entity='warehouses'`);
      const db = storageDriver(state.storage);
      const version = (p: string, w: string) =>
        Number(sql.exec(`SELECT coalesce((SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?),0) v`, p, w).toArray()[0].v);
      for (let i = 0; i < 30; i++) {
        const p = `00000000-0000-4000-8000-${String(1 + (i % 20)).padStart(12, "0")}`;
        const w = `00000000-0000-4000-8000-${String(21 + (i % 2)).padStart(12, "0")}`;
        callRpc(db, "erp_stock_post", {
          p_user_id: user, p_command_id: crypto.randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-15",
          p_reason: "Lançamento sintético do backup", p_items: [{ product_id: p, warehouse_id: w, quantity: `${i + 1}.123456`, expected_version: version(p, w) }],
          p_reference: i % 3 ? null : `Ref ${i}`,
        });
      }
      return {};
    });
    // Recuperação no tempo (PITR): o que a API responde no workerd local.
    const bookmark = await runInDurableObject(erpStub(env, source), async (_i: any, state: DurableObjectState) => {
      const s = state.storage as any;
      const out: Record<string, unknown> = {};
      for (const [name, call] of [
        ["getCurrentBookmark", () => s.getCurrentBookmark()],
        ["getBookmarkForTime", () => s.getBookmarkForTime(Date.now() - 1000)],
      ] as const)
        try {
          const v = await call();
          out[name] = typeof v === "string" ? `texto de ${v.length} caracteres` : String(v);
        } catch (e: any) {
          out[name] = "erro: " + String(e.message).slice(0, 100);
        }
      out.onNextSessionRestoreBookmark = typeof s.onNextSessionRestoreBookmark;
      return out;
    });
    const seeded = { bookmark };
    const t0 = Date.now();
    const backup = await (await erpFetch(env, source, "/erp-backup", { method: "POST" })).json<any>();
    const backupMs = Date.now() - t0;
    expect(backup.prefix).toMatch(new RegExp(`^erp-backups/${source}/`));
    const listed = await env.MEDIA.list({ prefix: backup.prefix });
    expect(listed.objects.length).toBe(backup.manifest.tables.length + 1);

    await erpFetch(env, target, "/erp-ping");
    const t1 = Date.now();
    const restored = await (
      await erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) })
    ).json<any>();
    const restoreMs = Date.now() - t1;
    const again = await runInDurableObject(erpStub(env, target), (_i: any, state: DurableObjectState) => dumpAll(state.storage).manifest);
    expect(again.tables).toEqual(backup.manifest.tables);
    const balances = (p: string) =>
      runInDurableObject(erpStub(env, p), (_i: any, state: DurableObjectState) =>
        state.storage.sql.exec(`SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" ORDER BY 1,2`).toArray(),
      );
    expect(await balances(target)).toEqual(await balances(source));
    // O ledger restaurado continua imutável (gatilhos recriados).
    const blocked = await runInDurableObject(erpStub(env, target), (_i: any, state: DurableObjectState) => {
      try {
        state.storage.sql.exec(`DELETE FROM "erp_stock__entry"`);
        return "apagou";
      } catch (e: any) {
        return String(e.message).slice(0, 40);
      }
    });
    expect(blocked).toMatch(/^40001:erp_stock_immutable_ledger/);
    console.log(
      "ERP_BACKUP " +
        JSON.stringify({
          tables: backup.manifest.tables.length,
          rows: backup.manifest.tables.reduce((s: number, t: any) => s + t.rows, 0),
          gzip_bytes: backup.bytes,
          backup_ms: backupMs,
          restore_ms: restoreMs,
          restored,
          bookmark: seeded.bookmark,
        }),
    );
  });
});
