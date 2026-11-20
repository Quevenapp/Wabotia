// Backup do ERP pelo Worker e a troca em etapas no workerd: rotas de
// administrador (/profiles/:p/erp-backup, src/erp/api/backup-routes.ts) com
// módulo, papel e confirmação; lista lida do R2; restauração acompanhada até
// o fim; exclusão; e, com a troca em curso, a área inteira parada para o ERP
// (leitura inclusive) com código próprio. A marca da recuperação no tempo é a
// do workerd local (a de verdade se confere numa instalação de teste).
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { encodeIdentity, IDENTITY_HEADER, SYSTEM_HEADER } from "../src/erp/engine/identity";
import { normalizeErpParts } from "../src/erp/parts";
import { startRestore } from "../src/erp/engine/backup-pages";
import { BACKUP_ACTIVE_KV, ERP_RESTORE_SWAPPING_CODE, ERP_RESTORE_SWAPPING_MESSAGE, readBackupJob, writeBackupJob } from "../src/erp/engine/backup-state";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

const inside = <T>(profile: string, fn: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(erpStub(env, profile), (_i: unknown, state: DurableObjectState) => fn(state));
const seed = (profile: string, rows: number, offset = 0) => inside(profile, state => {
  const sql = state.storage.sql;
  sql.exec("INSERT INTO origin_sync__resource_state(resource,updated_at) VALUES('contacts',0) ON CONFLICT(resource) DO NOTHING");
  sql.exec(`INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at)
    WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < CAST(? AS INTEGER))
    SELECT 'contacts','contacts',printf('%010d',i),json_object('nome','Registro '||i,'texto',hex(randomblob(300))),'[]',lower(hex(randomblob(32))),1,i,i,i FROM n`,
    String(offset + 1), String(offset + rows));
});
const count = (profile: string) => inside(profile, state => Number(state.storage.sql.exec("SELECT count(*) n FROM origin_sync__raw_record").one().n));

describe("ERP: backup pela tela de administrador e troca em etapas", () => {
  it("rotas: módulo e papel; fazer, listar, restaurar com o nome da área, acompanhar e apagar", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin), member = await bearer(f.member);
    const base = `https://test/api/v1/profiles/${f.profile}/erp-backup`;
    const call = (path: string, token: string, init: RequestInit = {}) =>
      SELF.fetch(base + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() } });
    const post = (path: string, body: unknown, token = admin) => call(path, token, { method: "POST", body: JSON.stringify(body) });
    // ERP desligado: a rota recusa com o código de módulo desligado.
    let r = await call("", admin);
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error.code).toBe("module_disabled");
    await setModule(f.profile, "erp", true, f.admin.id);
    // Pessoa da área sem papel de administrador: recusa.
    r = await call("", member);
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error.code).toBe("admin_required");
    r = await call("", admin);
    expect(r.status).toBe(200);
    expect(await r.json<any>()).toMatchObject({ backups: [] });
    await erpFetch(env, f.profile, "/erp-ping");
    await seed(f.profile, 1_500);
    const until = async () => {
      for (let i = 0; i < 100; i++) {
        const job = (await (await call("/progresso", admin)).json<any>()).job;
        if (job && ["done", "failed"].includes(job.phase)) return job;
        await runDurableObjectAlarm(erpStub(env, f.profile));
      }
      throw new Error("trabalho não terminou");
    };
    r = await post("", {});
    expect([200, 202]).toContain(r.status);
    const backup = await until();
    expect(backup).toMatchObject({ kind: "backup", phase: "done" });
    const listed = (await (await call("", admin)).json<any>()).backups;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ prefix: backup.prefix, format: 2, rows: backup.result.rows });
    expect(listed[0].bytes).toBeGreaterThan(0);
    expect(listed[0].created_at).toBe(backup.created_at);
    // Depois do backup, o ERP muda; a restauração o traz de volta.
    await seed(f.profile, 2_000, 10_000);
    expect(await count(f.profile)).toBe(3_500);
    // Confirmação errada, campo a mais ou backup de outra área: recusa sem começar.
    r = await post("/restaurar", { prefix: backup.prefix, confirmacao: "outra" });
    expect(r.status).toBe(400);
    expect((await r.json<any>()).error).toMatchObject({ code: "erp_restore_confirmation", message: expect.stringContaining("Atendimento") });
    expect((await post("/restaurar", { prefix: "erp-backups/outra-area/2026/", confirmacao: "Atendimento" })).status).toBe(400);
    expect((await post("/restaurar", { prefix: backup.prefix, confirmacao: "Atendimento", extra: 1 })).status).toBe(400);
    r = await post("/restaurar", { prefix: backup.prefix, confirmacao: " atendimento " });
    expect([200, 202]).toContain(r.status);
    const restored = await until();
    expect(restored).toMatchObject({ kind: "restore", phase: "done", blocked: false, result: { rows: backup.result.rows } });
    expect(await count(f.profile)).toBe(1_500);
    // Apagar: pede confirmação; depois a lista fica vazia.
    expect((await post("/apagar", { prefix: backup.prefix })).status).toBe(400);
    r = await post("/apagar", { prefix: backup.prefix, confirmado: true });
    expect(r.status).toBe(200);
    expect((await r.json<any>()).deleted).toBeGreaterThan(1);
    expect((await (await call("", admin)).json<any>()).backups).toEqual([]);
    expect((await post("/apagar", { prefix: backup.prefix, confirmado: true })).status).toBe(404);
  }, 180_000);

  it("troca em curso: o ERP da área recusa leitura e escrita com código próprio; o progresso mostra a área parada", async () => {
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    const profile = f.profile;
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    await seed(profile, 300);
    const started = await erpFetch(env, profile, "/erp-backup", { method: "POST" });
    expect([200, 202]).toContain(started.status);
    for (let i = 0; i < 50 && readBackupJobPhase(await status(profile)) !== "done"; i++) await runDurableObjectAlarm(erpStub(env, profile));
    const prefix = (await status(profile)).prefix;
    // A marca da recuperação no tempo existe no workerd local.
    const bookmark = await inside(profile, state => state.storage.getCurrentBookmark());
    expect(typeof bookmark).toBe("string");
    expect(bookmark.length).toBeGreaterThan(0);
    // Uma troca começada (estado gravado como a troca grava), parada no meio.
    await inside(profile, async state => {
      const job = await startRestore(state.storage, env.MEDIA, profile, prefix);
      writeBackupJob(state.storage, { ...job, phase: "swap", cursor: { ...job.cursor, swap: {
        bookmark, started_at: Date.now(), deadline: Date.now() + 3_600_000, step: "insert", group: 0, table: 0, pass: 0, part: 0, chunk: 0,
        header: null, header_seen: false, after_rowid: null, rows: 0, sha: null, rows_done: 0, control: null, rollbacks: 0, stall_step: null, stalls: 0 } } });
      await state.storage.put(BACKUP_ACTIVE_KV, true);
    });
    const rpc = (name: string, body: unknown) => erpFetch(env, profile, `/erp-rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SYSTEM_HEADER]: "1", [IDENTITY_HEADER]: encodeIdentity({ actor: null, people: null,
        parts: normalizeErpParts(), partsControl: { profile, revision: "1", expires_at: Date.now() + 360_000 } }) },
      body: JSON.stringify(body),
    });
    for (const response of [
      await rpc("erp_platform_task_claim", { p_lease: crypto.randomUUID(), p_purposes: ["company_export"] }),
      await rpc("erp_platform_schedule", { p_now: new Date().toISOString() }),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect(await response.json()).toEqual({ code: ERP_RESTORE_SWAPPING_CODE, message: ERP_RESTORE_SWAPPING_MESSAGE, error: { code: ERP_RESTORE_SWAPPING_CODE, message: ERP_RESTORE_SWAPPING_MESSAGE } });
    }
    expect((await erpFetch(env, profile, "/erp-probe/qualquer", { method: "POST", body: "{}" })).status).toBe(503);
    expect(await status(profile)).toMatchObject({ kind: "restore", phase: "swap", blocked: true, swap: { step: "insert" } });
    // Outro backup não começa durante a troca.
    expect((await erpFetch(env, profile, "/erp-backup", { method: "POST" })).status).toBe(409);
    // Encerra o estado fabricado (sem alarme correndo atrás dele).
    await inside(profile, async state => {
      const job = readBackupJob(state.storage)!;
      writeBackupJob(state.storage, { ...job, phase: "failed", cursor: { ...job.cursor, swap: null } });
      await state.storage.delete(BACKUP_ACTIVE_KV);
      await state.storage.deleteAlarm();
    });
  }, 120_000);
});

const status = async (profile: string) => (await (await erpFetch(env, profile, "/erp-backup-status")).json<any>()).job;
const readBackupJobPhase = (job: any) => job?.phase;
