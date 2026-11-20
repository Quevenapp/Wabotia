// Backup e restauração em páginas pelas rotas internas do objeto erp:<área>
// (src/erp/hub.ts) no workerd: barreira na rota /erp-rpc (leitura passa,
// escrita volta 503 sem efeito), continuação pelo alarme com progresso
// visível, banco acima do antigo teto de 16 MiB e a troca medida no workerd.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { encodeIdentity, IDENTITY_HEADER, SYSTEM_HEADER } from "../src/erp/engine/identity";
import { normalizeErpParts } from "../src/erp/parts";
import { startBackup, startRestore, runBackupJob } from "../src/erp/engine/backup-pages";
import { BACKUP_ACTIVE_KV, backupFence, fencedWrite, ErpBackupFencedError, readBackupJob } from "../src/erp/engine/backup-state";

const inside = <T>(profile: string, fn: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(erpStub(env, profile), (_i: unknown, state: DurableObjectState) => fn(state));
const rpc = (profile: string, name: string, body: unknown) => erpFetch(env, profile, `/erp-rpc/${name}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", [SYSTEM_HEADER]: "1", [IDENTITY_HEADER]: encodeIdentity({ actor: null, people: null,
    parts: normalizeErpParts(), partsControl: { profile, revision: "1", expires_at: Date.now() + 360_000 } }) },
  body: JSON.stringify(body),
});
const status = async (profile: string) => (await (await erpFetch(env, profile, "/erp-backup-status")).json<any>()).job;
/** Roda os alarmes que o objeto agendou até o trabalho acabar (como a plataforma faria). */
async function alarmsUntilDone(profile: string, max = 200) {
  const seen: number[] = [];
  for (let i = 0; i < max; i++) {
    const job = await status(profile);
    if (job && ["done", "failed"].includes(job.phase)) return { job, alarms: i, seen };
    seen.push(job?.percent ?? 0);
    expect(await runDurableObjectAlarm(erpStub(env, profile))).toBe(true);
  }
  throw new Error("trabalho não terminou");
}
/** ~mib MiB de NDJSON no acervo do Bling, gerados no próprio SQLite do objeto. */
const seed = (profile: string, rows: number) => inside(profile, state => {
  const sql = state.storage.sql;
  sql.exec("INSERT INTO origin_sync__resource_state(resource,updated_at) VALUES('contacts',0) ON CONFLICT(resource) DO NOTHING");
  for (let start = 1; start <= rows; start += 5_000) {
    sql.exec(`INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at)
      WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < CAST(? AS INTEGER))
      SELECT 'contacts','contacts',printf('%010d',i),json_object('nome','Registro '||i,'texto',hex(randomblob(500))),'[]',lower(hex(randomblob(32))),1,i,i,i FROM n`,
      String(start), String(Math.min(rows, start + 4_999)));
  }
  return Number(sql.exec("SELECT count(*) n FROM origin_sync__raw_record").one().n);
});
const digest = (profile: string) => inside(profile, state =>
  state.storage.sql.exec("SELECT count(*) n, sum(length(payload)) bytes, min(source_id) first, max(source_id) last, sum(unicode(substr(version_hash,7,1))) mix FROM origin_sync__raw_record").one());

describe("ERP: backup e restauração em páginas pelas rotas internas", () => {
  it("total_changes no SQLite do objeto: escrita sob a barreira é desfeita, leitura passa", async () => {
    const profile = uid();
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    const result = await inside(profile, state => {
      startBackup(state.storage, profile);
      const fence = backupFence(state.storage)!;
      const count = () => Number(state.storage.sql.exec("SELECT count(*) n FROM erp_catalog__record").one().n);
      const before = count();
      let refused = "";
      try {
        fencedWrite(state.storage, fence, () => state.storage.sql.exec(`INSERT INTO erp_catalog__record(id,entity,name,active,created_at,updated_at) VALUES(?, 'products', 'Teste', 1, 1, 1)`, crypto.randomUUID()));
      } catch (error) { refused = error instanceof ErpBackupFencedError ? error.code : String(error); }
      return { refused, unchanged: count() === before, read: fencedWrite(state.storage, fence, count) === before };
    });
    expect(result).toEqual({ refused: "erp_backup_running", unchanged: true, read: true });
  });

  it("barreira na rota: leitura responde, escrita volta 503 sem efeito; o alarme termina o backup e a escrita entra", async () => {
    const profile = uid();
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    await seed(profile, 2_000);
    const tasks = () => inside(profile, state => Number(state.storage.sql.exec('SELECT count(*) n FROM "erp_platform__task"').one().n));
    const before = await tasks();
    // Backup aberto e ainda não terminado (o alarme continua o trabalho).
    // Como a rota faz: trabalho, marca no KV e alarme.
    await inside(profile, async state => { startBackup(state.storage, profile); await state.storage.put(BACKUP_ACTIVE_KV, true); await state.storage.setAlarm(Date.now() + 60_000); });
    // Leitura (fila vazia): passa.
    const read = await rpc(profile, "erp_platform_task_claim", { p_lease: crypto.randomUUID(), p_purposes: ["company_export"] });
    expect(read.status, await read.clone().text()).toBe(200);
    // Escrita (enfileira tarefas): 503, sem efeito.
    const write = await rpc(profile, "erp_platform_schedule", { p_now: new Date().toISOString() });
    expect(write.status).toBe(503);
    expect(write.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await write.json()).toMatchObject({ code: "erp_backup_running", error: { code: "erp_backup_running" } });
    expect(await tasks()).toBe(before);
    expect((await erpFetch(env, profile, "/erp-probe/qualquer", { method: "POST", body: "{}" })).status).toBe(503);
    // Quem pediu vê o progresso.
    const running = await status(profile);
    expect(running).toMatchObject({ kind: "backup", phase: "export", barrier: { active: true } });
    const { job } = await alarmsUntilDone(profile);
    expect(job.phase).toBe("done");
    expect(job.barrier.active).toBe(false);
    expect(await inside(profile, state => backupFence(state.storage))).toBeNull();
    const after = await rpc(profile, "erp_platform_schedule", { p_now: new Date().toISOString() });
    expect(after.status).toBe(200);
    expect(await tasks()).toBeGreaterThan(before);
  }, 120_000);

  it("acima do antigo teto de 16 MiB: backup e restauração pela rota, com alarme, progresso e retrato igual", async () => {
    const source = uid(), target = uid();
    expect((await erpFetch(env, source, "/erp-ping")).status).toBe(200);
    expect((await erpFetch(env, target, "/erp-ping")).status).toBe(200);
    const rows = await seed(source, 18_000);
    const t0 = Date.now();
    const started = await erpFetch(env, source, "/erp-backup", { method: "POST" });
    expect([200, 202]).toContain(started.status);
    const first = await started.json<any>();
    let job = started.status === 200 ? first.job : (await alarmsUntilDone(source)).job;
    const backupMs = Date.now() - t0;
    expect(job.phase).toBe("done");
    expect(job.progress.text_bytes).toBeGreaterThan(16 * 1024 * 1024);
    const manifest = await (await env.MEDIA.get(job.prefix + "manifest.json"))!.json<any>();
    expect(manifest.format).toBe(2);
    expect(manifest.totals.text_bytes).toBe(job.progress.text_bytes);
    expect(manifest.external_objects.included).toBe(false);
    const listed = await env.MEDIA.list({ prefix: job.prefix });
    expect(listed.objects.length).toBe(manifest.parts.length + 1);

    const t1 = Date.now();
    const restoring = await erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: job.prefix }) });
    expect([200, 202]).toContain(restoring.status);
    const restored = restoring.status === 200 ? (await restoring.json<any>()).job : (await alarmsUntilDone(target)).job;
    const restoreMs = Date.now() - t1;
    expect(restored).toMatchObject({ phase: "done", result: { rows: manifest.totals.rows } });
    expect(await digest(target)).toEqual(await digest(source));
    expect(rows).toBe(18_000);

    // A troca medida no workerd (uma transação só), para o teto real.
    const swap = await inside(target, async state => {
      await startRestore(state.storage, env.MEDIA, target, job.prefix);
      let at = 0, ms = 0;
      const hooks = { at: (point: string) => { if (point === "swap:before") at = performance.now(); if (point === "swap:after") ms = performance.now() - at; } };
      let more = true;
      while (more) more = (await runBackupJob(state.storage, env.MEDIA, { hooks })).more;
      return { ms, phase: readBackupJob(state.storage)?.phase };
    });
    expect(swap.phase).toBe("done");
    console.log("ERP_BACKUP_PAGES " + JSON.stringify({ rows, text_bytes: job.progress.text_bytes, gzip_bytes: job.progress.bytes, parts: job.progress.parts_done,
      backup_ms: backupMs, backup_invocations: job.invocations, writes_held_ms: job.barrier.held_ms, restore_ms: restoreMs, restore_invocations: restored.invocations, swap_ms: Math.round(swap.ms) }));
  }, 300_000);

  it("restauração pela rota: prefixo inválido 400, backup inexistente 404, trabalho em andamento 409", async () => {
    const profile = uid();
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    const bad = await erpFetch(env, profile, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: "../x" }) });
    expect(bad.status).toBe(400);
    const missing = await erpFetch(env, profile, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: `erp-backups/${profile}/nada/` }) });
    expect(missing.status).toBe(404);
    await inside(profile, state => { startBackup(state.storage, profile); });
    const busy = await erpFetch(env, profile, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: `erp-backups/${profile}/nada/` }) });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "erp_backup_job_running" } });
  });
});
