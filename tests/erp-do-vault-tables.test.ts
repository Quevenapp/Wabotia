// Tabelas só do motor do cofre da NFapi (engine-tables.ts, versão 9;
// structural.ts, notas-recebidas-cofre e emissao-cofre) no workerd: o passo
// 8→9 as cria, os CHECK que dependem de NULL recusam, o __received_change é
// imutável (40001) e o backup com a restauração o leva com os gatilhos.
// Base: tests/erp-do-reform-tables.test.ts.
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
const VAULT = ERP_ENGINE_TABLES.filter((t) => t.since === 9).map((t) => t.table);
const KEY = "35261144555666000181550010000001011876543213";
const HASH = "a".repeat(64);
const CHANGE_TRIGGERS = ["erp_fiscal_vault__received_change_immutable_delete", "erp_fiscal_vault__received_change_immutable_update"];

/** INSERT de uma nota recebida (destinatário, produção) e da mudança "nova". */
function seedReceived(sql: SqlStorage, id: string, t: string) {
  sql.exec(
    `INSERT INTO "erp_fiscal_vault__received"(id, environment, cnpj, access_key, role, emitter_document, emitter_name, series, number, total, situation,
       xml_available, vault_sequence, vault_received_at, vault_updated_at, first_seen_at, synced_at)
     VALUES(?, 'producao', '44555666000181', ?, 'destinatario', '11222333000144', 'Fornecedor sintético', 1, 101, 15990, 'autorizada', 0, 7, ?, ?, ?, ?)`,
    id, KEY, t, t, t, t,
  );
  sql.exec(
    `INSERT INTO "erp_fiscal_vault__received_change"(received_id, vault_sequence, kind, snapshot, recorded_at) VALUES(?, 7, 'nova', ?, ?)`,
    id, JSON.stringify({ id, sequencia: 7, valor: 159.9 }), t,
  );
}

describe("ERP: tabelas do cofre (notas recebidas e emissão)", () => {
  it("passo 8→9: o objeto da versão 8 ganha as 5 tabelas e os 2 gatilhos", async () => {
    const profile = uid();
    await erpFetch(env, profile, "/erp-ping");
    const out = await runInDurableObject(erpStub(env, profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const tables = () => VAULT.map((t) => sql.exec("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?", t).toArray()[0].n);
      const triggers = () =>
        sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='erp_fiscal_vault__received_change' ORDER BY name").toArray().map((r: any) => r.name);
      const fresh = { tables: tables(), triggers: triggers() };
      // Como um objeto criado na versão 8: sem as tabelas do cofre nem as
      // comerciais da versão 10 (filhas antes das mães).
      for (const t of ERP_ENGINE_TABLES.filter((t) => t.since > 8).reverse()) sql.exec(`DROP TABLE "${t.table}"`);
      sql.exec("UPDATE erp_meta SET value='8' WHERE key='schema_version'");
      const dropped = { tables: tables(), triggers: triggers() };
      const step = migrate(state.storage);
      const meta = Object.fromEntries(sql.exec("SELECT key, value FROM erp_meta WHERE key IN ('schema_version','schema_hash')").toArray().map((r: any) => [r.key, r.value]));
      return { fresh, dropped, step, after: { tables: tables(), triggers: triggers() }, meta, again: migrate(state.storage) };
    });
    expect(ERP_DDL_VERSION).toBeGreaterThanOrEqual(9);
    expect(out.fresh).toEqual({ tables: [1, 1, 1, 1, 1], triggers: CHANGE_TRIGGERS });
    expect(out.dropped).toEqual({ tables: [0, 0, 0, 0, 0], triggers: [] });
    expect(out.step).toMatchObject({ status: "applied", version: ERP_DDL_VERSION });
    expect(out.after).toEqual(out.fresh);
    expect(out.meta).toEqual({ schema_version: String(ERP_DDL_VERSION), schema_hash: ERP_DDL_HASH });
    expect(out.again).toMatchObject({ status: "current" });
  });

  it("os CHECK com NULL recusam, o __received_change é imutável e o backup com a restauração o levam", async () => {
    const source = uid(),
      target = uid();
    await erpFetch(env, source, "/erp-ping");
    const user = crypto.randomUUID(),
      received = "rcb_" + crypto.randomUUID().replace(/-/g, "");
    const checks = await runInDurableObject(erpStub(env, source), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const t = micros();
      seedReceived(sql, received, t);
      const refused = (s: string, ...p: unknown[]) => {
        try {
          sql.exec(s, ...p);
          return "aceitou";
        } catch (e: any) {
          return String(e.message).match(/40001:\w+|erp_fiscal_vault__\w+_check|FOREIGN KEY|UNIQUE/)?.[0] ?? String(e.message).slice(0, 80);
        }
      };
      let n = 0;
      const event = (cols: Record<string, unknown>) => {
        const row = { id: crypto.randomUUID(), environment: "producao", reference: `ev.${++n}`, body: "{}", body_hash: HASH, command_id: crypto.randomUUID(), requested_by: user, created_at: t, updated_at: t, ...cols };
        const keys = Object.keys(row);
        return refused(`INSERT INTO "erp_fiscal_vault__event"(${keys.join(", ")}) VALUES(${keys.map(() => "?").join(", ")})`, ...Object.values(row));
      };
      return {
        manifest_ok: event({ kind: "manifestacao", received_id: received, manifestation: "ciencia", sequence: 1 }),
        cancel_without_text: event({ kind: "cancelamento", emission_id: null, invoice_id: null, received_id: null }),
        cancel_no_target_text: event({ kind: "cancelamento", text: "Cancelamento por erro de digitação" }),
        letter_without_text: event({ kind: "carta_correcao", received_id: received, sequence: 1 }),
        void_half_range: event({ kind: "inutilizacao", model: "55", series: 1, number_to: 10, text: "Faixa pulada na numeração" }),
        void_without_model: event({ kind: "inutilizacao", series: 1, number_from: 5, number_to: 10, text: "Faixa pulada na numeração" }),
        void_ok: event({ kind: "inutilizacao", model: "55", series: 1, number_from: 5, number_to: 10, text: "Faixa pulada na numeração" }),
        not_done_without_text: event({ kind: "manifestacao", received_id: received, manifestation: "nao_realizada", sequence: 1 }),
        manifestation_without_at: refused(`UPDATE "erp_fiscal_vault__received" SET manifestation='ciencia', manifestation_sequence=1 WHERE id=?`, received),
        manifestation_ok: refused(`UPDATE "erp_fiscal_vault__received" SET manifestation='ciencia', manifestation_sequence=1, manifestation_at=? WHERE id=?`, t, received),
        received_id: refused(`UPDATE "erp_fiscal_vault__received" SET id='nf_1' WHERE id=?`, received),
        invoice_on_summary: refused(`UPDATE "erp_fiscal_vault__received" SET invoice_id=? WHERE id=?`, crypto.randomUUID(), received),
        change_update: refused(`UPDATE "erp_fiscal_vault__received_change" SET kind='outra' WHERE received_id=?`, received),
        change_delete: refused(`DELETE FROM "erp_fiscal_vault__received_change" WHERE received_id=?`, received),
      };
    });
    expect(checks).toEqual({
      manifest_ok: "aceitou",
      cancel_without_text: "erp_fiscal_vault__event_target_check",
      cancel_no_target_text: "erp_fiscal_vault__event_target_check",
      letter_without_text: "erp_fiscal_vault__event_target_check",
      void_half_range: "erp_fiscal_vault__event_target_check",
      void_without_model: "erp_fiscal_vault__event_target_check",
      void_ok: "aceitou",
      not_done_without_text: "erp_fiscal_vault__event_text_check",
      manifestation_without_at: "erp_fiscal_vault__received_manifestation_check",
      manifestation_ok: "aceitou",
      received_id: "erp_fiscal_vault__received_id_check",
      invoice_on_summary: "erp_fiscal_vault__received_invoice_check",
      change_update: "40001:erp_fiscal_vault_received_change_immutable",
      change_delete: "40001:erp_fiscal_vault_received_change_immutable",
    });
    // Os CHECK de texto e de faixa, cada um sozinho (os alvos certos).
    // O cancelamento e a carta com alvo vão para uma emissão: as FKs ficam
    // adiadas (defer_foreign_keys) para o CHECK aparecer sozinho; a transação é desfeita.
    const alone = await runInDurableObject(erpStub(env, source), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      const t = micros();
      const one = (cols: Record<string, unknown>) => {
        const row = { id: crypto.randomUUID(), environment: "producao", reference: "r." + crypto.randomUUID(), body: "{}", body_hash: HASH, command_id: crypto.randomUUID(), requested_by: user, created_at: t, updated_at: t, ...cols };
        const keys = Object.keys(row);
        try {
          state.storage.transactionSync(() => {
            sql.exec("PRAGMA defer_foreign_keys = ON");
            sql.exec(`INSERT INTO "erp_fiscal_vault__event"(${keys.join(", ")}) VALUES(${keys.map(() => "?").join(", ")})`, ...Object.values(row));
            throw new Error("desfeita: aceitou");
          });
          return "?";
        } catch (e: any) {
          return String(e.message).match(/erp_fiscal_vault__\w+_check|aceitou/)?.[0] ?? String(e.message).slice(0, 80);
        }
      };
      const emission = crypto.randomUUID();
      return {
        cancel_null_text: one({ kind: "cancelamento", emission_id: emission }),
        cancel_ok: one({ kind: "cancelamento", emission_id: emission, text: "Cancelamento por erro de digitação" }),
        letter_null_text: one({ kind: "carta_correcao", emission_id: emission, sequence: 1 }),
        void_reversed_range: one({ kind: "inutilizacao", model: "55", series: 1, number_from: 9, number_to: 3, text: "Faixa pulada na numeração" }),
        void_short_text: one({ kind: "inutilizacao", model: "55", series: 1, number_from: 1, number_to: 2, text: "curto" }),
        void_null_text: one({ kind: "inutilizacao", model: "55", series: 1, number_from: 1, number_to: 2 }),
      };
    });
    expect(alone).toEqual({
      cancel_null_text: "erp_fiscal_vault__event_text_check",
      cancel_ok: "aceitou",
      letter_null_text: "erp_fiscal_vault__event_text_check",
      void_reversed_range: "erp_fiscal_vault__event_range_check",
      void_short_text: "erp_fiscal_vault__event_text_check",
      void_null_text: "erp_fiscal_vault__event_text_check",
    });

    const backup = await (await erpFetch(env, source, "/erp-backup", { method: "POST" })).json<any>();
    const listed = backup.manifest.tables.filter((t: any) => VAULT.includes(t.table)).map((t: any) => [t.table, t.rows]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ["erp_fiscal_vault__received", 1],
        ["erp_fiscal_vault__received_change", 1],
        ["erp_fiscal_vault__event", 2],
      ]),
    );
    await erpFetch(env, target, "/erp-ping");
    const restored = await erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    expect(restored.status).toBe(200);
    const again = await runInDurableObject(erpStub(env, target), (_i: any, state: DurableObjectState) => dumpAll(state.storage).manifest);
    expect(again.tables).toEqual(backup.manifest.tables);
    const rows = (p: string) =>
      runInDurableObject(erpStub(env, p), (_i: any, state: DurableObjectState) => {
        const sql = state.storage.sql;
        let immutable = "aceitou";
        try {
          sql.exec(`DELETE FROM "erp_fiscal_vault__received_change"`);
        } catch (e: any) {
          immutable = String(e.message).match(/40001:\w+/)?.[0] ?? String(e.message);
        }
        return {
          received: sql.exec(`SELECT id, access_key, total, manifestation, manifestation_sequence FROM "erp_fiscal_vault__received"`).toArray(),
          change: sql.exec(`SELECT received_id, vault_sequence, kind, snapshot FROM "erp_fiscal_vault__received_change"`).toArray(),
          events: sql.exec(`SELECT kind, manifestation, number_from, number_to FROM "erp_fiscal_vault__event" ORDER BY kind`).toArray(),
          triggers: sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='erp_fiscal_vault__received_change' ORDER BY name").toArray().map((r: any) => r.name),
          immutable,
        };
      });
    const a = await rows(target);
    expect(a).toEqual(await rows(source));
    expect(a.triggers).toEqual(CHANGE_TRIGGERS);
    expect(a.immutable).toBe("40001:erp_fiscal_vault_received_change_immutable");
  }, 120_000);
});
