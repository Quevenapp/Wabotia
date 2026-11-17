// Agendador do ERP no workerd (docs/ERP-AGENDADOR.md): o encaixe no objeto
// erp:<área>. O despachante em si é testado com relógio controlado no Node
// (tests/erp/scheduler/dispatch.test.mjs).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { storageDriver } from "../src/erp/engine/driver";
import { runRound } from "../src/erp/scheduler/dispatch";
import { erpAreas, isErpCronSlot, wakeErpAreas } from "../src/erp/scheduler/cron";
import { nextHour } from "../src/erp/scheduler/routines";
import { exec } from "../src/db";
import { fixture } from "./service-center-fixture";

const far = () => Date.now() + 10 * 60_000;
const alarmOf = (profile: string) =>
  runInDurableObject(erpStub(env, profile), (_i: any, s: DurableObjectState) => s.storage.getAlarm());
const setAlarm = (profile: string, at: number) =>
  runInDurableObject(erpStub(env, profile), (_i: any, s: DurableObjectState) => s.storage.setAlarm(at));
const clearAlarm = (profile: string) =>
  runInDurableObject(erpStub(env, profile), (_i: any, s: DurableObjectState) => s.storage.deleteAlarm());
const wake = (profile: string, body?: unknown) =>
  erpFetch(env, profile, "/erp-wake", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Rodada longa (40 unidades de trabalho real no SQLite, uns ms cada) e, com
 * ela em curso, duas chamadas ao objeto: /erp-ping e um RPC. Devolve a ordem
 * dos acontecimentos.
 */
async function roundWithReads(yieldTurn?: () => Promise<void>) {
  const f = await fixture();
  await erpFetch(env, f.profile, "/erp-ping");
  await clearAlarm(f.profile);
  const UNITS = 40;
  const log: string[] = [];
  const round = runInDurableObject(erpStub(env, f.profile), async (_i: any, s: DurableObjectState) => {
    let n = 0;
    const heavy = {
      id: "teste.longa",
      block: "erp",
      next: nextHour,
      step: ({ db }: any) => {
        db.exec("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<60000) SELECT count(*) n FROM c");
        log.push("unidade");
        return ++n < UNITS ? "more" : "done";
      },
    };
    const report = await runRound(storageDriver(s.storage), {
      routines: [heavy],
      handlers: {},
      budgetMs: 60_000,
      maxUnits: 1_000,
      ...(yieldTurn ? { yieldTurn } : {}),
    });
    log.push("fim da rodada");
    return report;
  });
  // Espera a rodada começar (ou terminar, se ela não cede a vez) e chama o ERP.
  while (!log.length) await new Promise((r) => setTimeout(r, 1));
  const ping = await erpFetch(env, f.profile, "/erp-ping");
  log.push("leitura " + ping.status);
  // O RPC mais barato que responde 200 sem identidade: nada a tomar para company_export.
  const rpc = await erpFetch(env, f.profile, "/erp-rpc/erp_platform_task_claim", {
    method: "POST",
    body: JSON.stringify({ p_lease: crypto.randomUUID(), p_purposes: ["company_export"] }),
  });
  log.push("rpc " + rpc.status);
  const report = await round;
  expect(report.routines).toEqual([{ id: "teste.longa", status: "ok" }]);
  return log;
}

describe("agendador do ERP no objeto", () => {
  it("o wake só antecipa (o mais cedo vence), grava os blocos e recusa corpo inválido", async () => {
    const f = await fixture();
    await erpFetch(env, f.profile, "/erp-ping");
    const base = far();
    await setAlarm(f.profile, base);
    // Mais tarde que o alarme atual: não adia.
    const later = await (await wake(f.profile, { at: base + 60_000, blocks: { "erp-fiscal": true } })).json<any>();
    expect(later).toEqual({ ok: true, alarm: base });
    expect(await alarmOf(f.profile)).toBe(base);
    // Mais cedo: antecipa (longe o bastante para o runtime não rodar sozinho).
    const sooner = base - 5 * 60_000;
    expect(await (await wake(f.profile, { at: sooner })).json<any>()).toEqual({ ok: true, alarm: sooner });
    expect(await alarmOf(f.profile)).toBe(sooner);
    const kept = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
      s.storage.get<{ blocks: Record<string, boolean> }>("erp_blocks"),
    );
    expect(kept?.blocks).toEqual({ "erp-fiscal": true });
    for (const bad of [
      "{",
      "[]",
      JSON.stringify({ at: "amanhã" }),
      JSON.stringify({ blocks: { "erp-x": true } }),
      JSON.stringify({ blocks: { "erp-pdv": 1 } }),
    ]) {
      const r = await erpFetch(env, f.profile, "/erp-wake", { method: "POST", body: bad });
      expect(r.status).toBe(400);
      expect((await r.json<any>()).error.code).toBe("erp_wake_invalid");
    }
    await clearAlarm(f.profile);
  }, 60_000);

  it("o alarme roda a rodada (rotinas e fila) e se reagenda para a hora cheia", async () => {
    const f = await fixture();
    await erpFetch(env, f.profile, "/erp-ping");
    await clearAlarm(f.profile);
    await setAlarm(f.profile, far());
    const before = Date.now();
    expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
    const state = await runInDurableObject(erpStub(env, f.profile), async (_i: any, s: DurableObjectState) => ({
      alarm: await s.storage.getAlarm(),
      routines: s.storage.sql.exec("SELECT id, last_status FROM wb_routine ORDER BY id").toArray(),
      tasks: s.storage.sql.exec('SELECT purpose, status FROM "erp_platform__task" ORDER BY purpose').toArray(),
      lastAlarm: s.storage.sql.exec("SELECT value FROM erp_meta WHERE key='last_alarm'").toArray()[0]?.value,
    }));
    expect(state.routines).toEqual([
      { id: "platform.schedule", last_status: "ok" },
      { id: "retention", last_status: "ok" },
    ]);
    expect(state.tasks).toEqual([
      { purpose: "export_cleanup", status: "queued" },
      { purpose: "notifications_generate", status: "done" },
    ]);
    expect(Number(state.lastAlarm)).toBeGreaterThanOrEqual(before);
    expect(state.alarm).toBe(nextHour(Number(state.lastAlarm)));
    await clearAlarm(f.profile);
  }, 60_000);

  it("uma leitura do ERP no meio de uma rodada longa responde sem esperar o fim da rodada", async () => {
    const log = await roundWithReads();
    const readAt = log.indexOf("leitura 200");
    const rpcAt = log.indexOf("rpc 200");
    const end = log.indexOf("fim da rodada");
    expect(readAt).toBeGreaterThan(0);
    expect(rpcAt).toBeGreaterThan(readAt);
    // As duas respostas chegaram com a rodada ainda em curso (unidades depois delas).
    expect(rpcAt).toBeLessThan(end);
    expect(log.slice(rpcAt).filter((x) => x === "unidade").length).toBeGreaterThan(0);
  }, 60_000);

  it("controle: sem ceder a vez de verdade (só microtarefa), a leitura espera a rodada inteira", async () => {
    const log = await roundWithReads(() => Promise.resolve());
    expect(log.indexOf("leitura 200")).toBeGreaterThan(log.indexOf("fim da rodada"));
    expect(log.filter((x) => x === "unidade").length).toBe(40);
  }, 60_000);

  it("backup e restauração: a wb_routine não vai no backup; na instância restaurada as rotinas rodam uma vez, sem duplicar tarefas", async () => {
    const source = await fixture();
    await erpFetch(env, source.profile, "/erp-ping");
    await clearAlarm(source.profile);
    await setAlarm(source.profile, far());
    expect(await runDurableObjectAlarm(erpStub(env, source.profile))).toBe(true);
    const backup = await (await erpFetch(env, source.profile, "/erp-backup", { method: "POST" })).json<any>();
    expect(backup.manifest.tables.map((t: any) => t.table)).not.toContain("wb_routine");
    expect(backup.manifest.tables.map((t: any) => t.table)).toContain("erp_platform__task");
    const target = await fixture();
    await erpFetch(env, target.profile, "/erp-ping");
    await clearAlarm(target.profile);
    await erpFetch(env, target.profile, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    // A instância nova tem a wb_routine (criada pelo migrate), vazia.
    const empty = await runInDurableObject(erpStub(env, target.profile), (_i: any, s: DurableObjectState) =>
      s.storage.sql.exec("SELECT count(*) n FROM wb_routine").one().n,
    );
    expect(empty).toBe(0);
    await setAlarm(target.profile, far());
    expect(await runDurableObjectAlarm(erpStub(env, target.profile))).toBe(true);
    const after = await runInDurableObject(erpStub(env, target.profile), async (_i: any, s: DurableObjectState) => ({
      routines: s.storage.sql.exec("SELECT id, last_status FROM wb_routine ORDER BY id").toArray(),
      tasks: s.storage.sql.exec('SELECT purpose, operation_id, status FROM "erp_platform__task" ORDER BY purpose, operation_id').toArray(),
    }));
    expect(after.routines).toEqual([
      { id: "platform.schedule", last_status: "ok" },
      { id: "retention", last_status: "ok" },
    ]);
    // Mesma hora: a tarefa restaurada é a mesma (chave), nada se repete.
    const purposes = after.tasks.map((t: any) => t.purpose);
    expect(purposes.filter((p: string) => p === "export_cleanup").length).toBe(1);
    expect(after.tasks.every((t: any) => t.purpose !== "notifications_generate" || t.status === "done")).toBe(true);
    await clearAlarm(target.profile);
  }, 120_000);

  it("cron: só no primeiro disparo da hora, só as áreas com o ERP ligado, com os blocos", async () => {
    const on = await fixture();
    const off = await fixture();
    const fiscalOnly = await fixture();
    const save = (profile: string, module: string, enabled: number) =>
      exec(
        env,
        "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
        profile,
        module,
        enabled,
        Date.now(),
        "teste",
      );
    await save(on.profile, "erp", 1);
    await save(on.profile, "erp-pdv", 1);
    await save(off.profile, "erp", 0);
    await save(fiscalOnly.profile, "erp-fiscal", 1); // sem o erp: o bloco não vale
    const mine = [on.profile, off.profile, fiscalOnly.profile];
    const areas = (await erpAreas(env)).filter((a) => mine.includes(a.profile));
    expect(areas).toEqual([{ profile: on.profile, blocks: { "erp-fiscal": false, "erp-cobranca": false, "erp-pdv": true } }]);
    expect(isErpCronSlot(Date.parse("2026-11-16T15:04:59Z"))).toBe(true);
    expect(isErpCronSlot(Date.parse("2026-11-16T15:05:00Z"))).toBe(false);
    expect(await wakeErpAreas(env, Date.parse("2026-11-16T15:35:00Z"))).toBe(0);
    await erpFetch(env, on.profile, "/erp-ping");
    expect(await wakeErpAreas(env, Date.parse("2026-11-16T15:00:00Z"))).toBeGreaterThanOrEqual(1);
    const blocks = await runInDurableObject(erpStub(env, on.profile), async (_i: any, s: DurableObjectState) => {
      const b = await s.storage.get<{ blocks: Record<string, boolean> }>("erp_blocks");
      return b?.blocks;
    });
    expect(blocks).toEqual({ "erp-fiscal": false, "erp-cobranca": false, "erp-pdv": true });
    await clearAlarm(on.profile);
  }, 60_000);
});
