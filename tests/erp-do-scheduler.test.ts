// Agendador do ERP no workerd (docs/ERP-AGENDADOR.md): o encaixe no objeto
// erp:<área>. O despachante em si é testado com relógio controlado no Node
// (tests/erp/scheduler/dispatch.test.mjs).
//
// Relógio injetado: o objeto roda no mesmo isolado dos testes, então
// `at(ms)` fixa o Date dos dois (vi.useFakeTimers só com Date; o setTimeout
// das cessões de vez continua real). O tempo fica parado até o próximo
// `at`: cada acordada esperada cai num ms exato, e nenhum teste depende da
// hora em que a suíte roda. Os instantes ficam nas próximas 24 h do relógio
// real: alarme agendado nunca fica no passado (o runtime o rodaria sozinho)
// e o erp_platform_schedule aceita o p_now.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erpFetch, erpStub } from "../src/erp/hub";
import { storageDriver } from "../src/erp/engine/driver";
import "../src/erp/domains/index";
import { callRpc } from "../src/erp/engine/registry";
import { saoPauloParts } from "../src/erp/engine/time";
import { SYSTEM_HEADER, IDENTITY_HEADER, encodeIdentity } from "../src/erp/engine/identity";
import { runRound } from "../src/erp/scheduler/dispatch";
import { erpAreas, isErpCronSlot, wakeErpAreas } from "../src/erp/scheduler/cron";
import { DAY_MS, nextHour, nextLocalTime } from "../src/erp/scheduler/routines";
import { exec } from "../src/db";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { deliverErpParts, readErpPartsState } from "../src/modules/erp/parts-state";
import { type ErpPartsSnapshot } from "../src/erp/parts";

async function prepare(profile: string) {
  await setModule(profile, "erp", true, "teste");
  const { snapshot } = await readErpPartsState(env, profile);
  expect(await deliverErpParts(env, snapshot)).toBe(true);
  return erpFetch(env, profile, "/erp-ping");
}

/** O Date.now nativo, guardado antes de qualquer relógio fixo. */
const realNow = Date.now.bind(Date);
afterEach(() => vi.useRealTimers());
/** Fixa o relógio do teste e do objeto em `ms` (parado até o próximo `at`). */
const at = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
  return ms;
};
/** O próximo "HH:MM" de São Paulo nas próximas 24 h, mais `extra` ms. */
const upcoming = (hm: string, extra = 0) => nextLocalTime(realNow() + 60_000, hm) + extra;
/** Data de São Paulo de um instante (AAAA-MM-DD). */
const spDate = (ms: number) => saoPauloParts(BigInt(ms) * 1000n).date;

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
  await prepare(f.profile);
  const { parts, ...partsControl } = (await readErpPartsState(env, f.profile)).snapshot;
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
      parts,
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
  // O RPC mais barato com envelope de sistema: nada a tomar para
  // company_export. É RPC do agendador: na rota, só com a marca de chamada
  // interna (rpc-endpoint.ts, SYSTEM_RPCS), como a costura põe.
  const rpc = await erpFetch(env, f.profile, "/erp-rpc/erp_platform_task_claim", {
    method: "POST",
    headers: { [SYSTEM_HEADER]: "1", [IDENTITY_HEADER]: encodeIdentity({ actor: null, people: null, parts, partsControl }) },
    body: JSON.stringify({ p_lease: crypto.randomUUID(), p_purposes: ["company_export"] }),
  });
  log.push("rpc " + rpc.status);
  const report = await round;
  expect(report.routines).toEqual([{ id: "teste.longa", status: "ok" }]);
  return log;
}

describe("agendador do ERP no objeto", () => {
  it("o wake só antecipa com fotografia completa entregue e recusa mapas parciais", async () => {
    const f = await fixture();
    await prepare(f.profile);
    const base = far();
    await setAlarm(f.profile, base);
    // Mais tarde que o alarme atual: não adia.
    const later = await (await wake(f.profile, { at: base + 60_000 })).json<any>();
    expect(later).toEqual({ ok: true, alarm: base });
    expect(await alarmOf(f.profile)).toBe(base);
    // Mais cedo: antecipa (longe o bastante para o runtime não rodar sozinho).
    const sooner = base - 5 * 60_000;
    expect(await (await wake(f.profile, { at: sooner })).json<any>()).toEqual({ ok: true, alarm: sooner });
    expect(await alarmOf(f.profile)).toBe(sooner);
    const kept = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
      s.storage.get<ErpPartsSnapshot>("erp_parts"),
    );
    expect(kept?.parts.customers).toBe(true);
    expect(kept?.parts.fiscal).toBe(false);
    for (const bad of [
      "{",
      "[]",
      JSON.stringify({ at: "amanhã" }),
      JSON.stringify({ blocks: { "erp-fiscal": true } }),
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
    // 03:20 em São Paulo: longe da virada de hora e das 03:10.
    const t = at(upcoming("03:20"));
    const f = await fixture();
    await prepare(f.profile);
    await clearAlarm(f.profile);
    await setAlarm(f.profile, far());
    expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
    const state = await runInDurableObject(erpStub(env, f.profile), async (_i: any, s: DurableObjectState) => ({
      alarm: await s.storage.getAlarm(),
      routines: s.storage.sql.exec("SELECT id, last_status FROM wb_routine ORDER BY id").toArray(),
      tasks: s.storage.sql.exec('SELECT purpose, operation_id, status FROM "erp_platform__task" ORDER BY purpose').toArray(),
      lastAlarm: s.storage.sql.exec("SELECT value FROM erp_meta WHERE key='last_alarm'").toArray()[0]?.value,
    }));
    // A rotina dos contratos fica registrada e pula com a parte Contratos desligada (padrão).
    // A das recorrências automáticas também, com o Financeiro desligado (só o ERP foi ligado).
    expect(state.routines).toEqual([
      { id: "contracts.daily", last_status: "skipped" },
      { id: "finance.recurring", last_status: "skipped" },
      { id: "platform.schedule", last_status: "ok" },
      { id: "retention", last_status: "ok" },
    ]);
    // A limpeza do dia (com arquivo) não vai na mesma acordada das rotinas:
    // fica para a seguinte, 1 s depois.
    expect(state.tasks).toEqual([
      { purpose: "export_cleanup", operation_id: `limpeza-exportacoes:${spDate(t)}`, status: "queued" },
      { purpose: "notifications_generate", operation_id: `notificacoes:${spDate(t)}T03`, status: "done" },
    ]);
    expect(Number(state.lastAlarm)).toBe(t);
    expect(state.alarm).toBe(t + 1_000);
    // Acordada seguinte, só da limpeza; depois, a hora cheia (04:00).
    at(t + 1_000);
    expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
    const after = await runInDurableObject(erpStub(env, f.profile), async (_i: any, s: DurableObjectState) => ({
      alarm: await s.storage.getAlarm(),
      cleanup: s.storage.sql
        .exec(`SELECT status, result FROM "erp_platform__task" WHERE purpose='export_cleanup'`)
        .toArray()[0],
    }));
    expect(after.cleanup.status).toBe("done");
    expect(JSON.parse(String(after.cleanup.result))).toEqual({ removed: 0 });
    expect(after.alarm).toBe(nextHour(t)); // sem acordada vazia após a última tarefa
    await clearAlarm(f.profile);
  }, 60_000);

  /**
   * Janela de tempo: a primeira acordada um segundo antes de `edge` e a
   * seguinte exatamente nela (o alarme agendado para 1 s depois, por causa da
   * limpeza do dia). Devolve as tarefas e as rotinas depois das duas.
   */
  async function window(edge: number) {
    const t = at(edge - 1_000);
    const f = await fixture();
    await prepare(f.profile);
    await clearAlarm(f.profile);
    await setAlarm(f.profile, far());
    expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
    const first = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
      s.storage.sql.exec("SELECT id, CAST(next_run_us AS TEXT) next, runs FROM wb_routine ORDER BY id").toArray() as any[],
    );
    expect(await alarmOf(f.profile)).toBe(edge);
    at(edge);
    expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
    const state = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) => ({
      routines: s.storage.sql.exec("SELECT id, CAST(next_run_us AS TEXT) next, runs FROM wb_routine ORDER BY id").toArray() as any[],
      ops: s.storage.sql.exec('SELECT operation_id FROM "erp_platform__task" ORDER BY operation_id').toArray().map((r: any) => r.operation_id),
    }));
    await clearAlarm(f.profile);
    const next = (rows: any[], id: string) => Number(BigInt(rows.find((r) => r.id === id).next) / 1000n);
    const runs = (rows: any[], id: string) => Number(rows.find((r) => r.id === id).runs);
    return { t, first, state, next, runs };
  }

  it("virada de hora: 05:59:59 gera a tarefa das 05; 06:00:00 gera a das 06", async () => {
    const edge = upcoming("06:00");
    const { t, first, state, next, runs } = await window(edge);
    expect(next(first, "platform.schedule")).toBe(edge);
    expect(runs(state.routines, "platform.schedule")).toBe(2);
    expect(state.ops).toEqual([
      `limpeza-exportacoes:${spDate(t)}`,
      `notificacoes:${spDate(t)}T05`,
      `notificacoes:${spDate(t)}T06`,
    ]);
    expect(next(state.routines, "platform.schedule")).toBe(edge + 3_600_000);
  }, 60_000);

  it("03:10: a retenção vista pela primeira vez às 03:09:59 roda de novo às 03:10 e depois só no dia seguinte", async () => {
    const edge = upcoming("03:10");
    const { first, state, next, runs } = await window(edge);
    // Primeira vez que a instância vê a rotina: roda na hora, e o próximo
    // horário é o das 03:10 do mesmo dia (docs/ERP-AGENDADOR.md).
    expect(next(first, "retention")).toBe(edge);
    expect(runs(state.routines, "retention")).toBe(2);
    expect(next(state.routines, "retention")).toBe(edge + DAY_MS);
  }, 60_000);

  it("virada do dia em São Paulo: 23:59:59 é um dia, 00:00:00 é outro (notificações e limpeza)", async () => {
    const edge = upcoming("00:00");
    const { t, state } = await window(edge);
    const [d1, d2] = [spDate(t), spDate(edge)];
    expect(d1).not.toBe(d2);
    expect(state.ops).toEqual([
      `limpeza-exportacoes:${d1}`,
      `limpeza-exportacoes:${d2}`,
      `notificacoes:${d1}T23`,
      `notificacoes:${d2}T00`,
    ]);
  }, 60_000);

  it("exportação da empresa pelo alarme: sozinha numa acordada, em fatias no R2 da área, e a exportação fica pronta", async () => {
    const t = at(upcoming("03:20"));
    const f = await fixture();
    await prepare(f.profile);
    await clearAlarm(f.profile);
    const admin = crypto.randomUUID();
    const requested = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) => {
      const t = String(BigInt(Date.now()) * 1000n);
      s.storage.sql.exec(
        `INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'admin', 1, ?, ?)`,
        admin,
        t,
        t,
      );
      return callRpc(storageDriver(s.storage), "erp_platform_export_request", {
        p_user_id: admin,
        p_command_id: crypto.randomUUID(),
      }) as any;
    });
    const exportId = requested.export.id;
    // Acordadas até não sobrar tarefa com arquivo: a primeira roda as
    // rotinas; as seguintes, uma tarefa com arquivo cada.
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Cada acordada 1 s depois da anterior (o próximo alarme que o objeto agenda).
      at(t + i * 1_000);
      expect(await alarmOf(f.profile)).toBe(i ? t + i * 1_000 : null);
      await setAlarm(f.profile, far());
      expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
      const done = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
        s.storage.sql
          .exec(`SELECT purpose FROM "erp_platform__task" WHERE purpose IN ('company_export','export_cleanup') AND status='done' ORDER BY finished_at`)
          .toArray()
          .map((r: any) => r.purpose),
      );
      files.push(String(done.length));
      if (done.length === 2) break;
    }
    // Uma tarefa com arquivo por acordada (0 na das rotinas, depois 1, depois 2).
    expect(files.slice(0, 3)).toEqual(["0", "1", "2"]);
    const row = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
      s.storage.sql
        .exec(`SELECT object_key, CAST(size_bytes AS TEXT) size, sha256, ready_at FROM "erp_platform__export" WHERE id=?`, exportId)
        .toArray()[0] as any,
    );
    expect(row.object_key).toMatch(new RegExp(`^exports/${exportId}/[a-f0-9]{64}\\.zip$`));
    expect(row.ready_at).not.toBeNull();
    const object = await env.MEDIA.get(`erp-storage/${f.profile}/brufap-exports/${row.object_key}`);
    expect(object).not.toBeNull();
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect(bytes.length).toBe(Number(row.size));
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK": ZIP
    // Nenhuma parte temporária sobrou.
    const temp = await env.MEDIA.list({ prefix: `erp-storage/${f.profile}/brufap-exports/.upload/` });
    expect(temp.objects).toEqual([]);
    await clearAlarm(f.profile);
  }, 120_000);

  it("exportação pelo caminho do painel: o pedido acorda o agendador, o alarme roda sozinho e o link baixa o ZIP", async () => {
    const t = at(upcoming("03:20"));
    const f = await fixture();
    const token = await bearer(f.admin);
    await setModule(f.profile, "erp", true, f.admin.id);
    await prepare(f.profile);
    await clearAlarm(f.profile);
    // Vínculo do administrador no ERP (como em tests/erp-do-api.test.ts).
    await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) => {
      const now = String(BigInt(Date.now()) * 1000n);
      s.storage.sql.exec(
        `INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?, 'admin', 1, ?, ?)`,
        f.admin.id,
        now,
        now,
      );
    });
    const route = (path: string, body: unknown) =>
      SELF.fetch(`https://test/api/v1/profiles/${f.profile}/erp/v1/plataforma${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    // 1. O pedido pela rota da erp-api (Backup e Exportação › Backup).
    const requested = await route("/exportacoes", { command_id: crypto.randomUUID() });
    expect(requested.status).toBe(200);
    const exportId = (await requested.json<any>()).export.id as string;
    // O pedido acordou o agendador: alarme em 1 s, sem esperar a próxima acordada.
    expect(await alarmOf(f.profile)).toBe(t + 1_000);
    // 2. Só os alarmes que o próprio objeto agenda, sem setAlarm do teste: a
    // primeira acordada roda as rotinas (vistas pela primeira vez); a
    // seguinte, a exportação, sozinha.
    let ready = false;
    for (let i = 0; i < 4 && !ready; i++) {
      const next = await alarmOf(f.profile);
      expect(next).not.toBeNull();
      at(next!);
      expect(await runDurableObjectAlarm(erpStub(env, f.profile))).toBe(true);
      ready = await runInDurableObject(erpStub(env, f.profile), (_i: any, s: DurableObjectState) =>
        Boolean(s.storage.sql.exec(`SELECT ready_at FROM "erp_platform__export" WHERE id=?`, exportId).toArray()[0]?.ready_at),
      );
    }
    expect(ready).toBe(true);
    // 3. O link pela rota: endereço público da instalação.
    const linked = await route(`/exportacoes/${exportId}/link`, {});
    expect(linked.status).toBe(200);
    const link = await linked.json<any>();
    expect(link.filename).toMatch(/^wabotia-exportacao-.+\.zip$/);
    expect(link.url.startsWith(`https://test/api/public/erp-storage/${f.profile}/exportacoes/exports/${exportId}/`)).toBe(true);
    // 4. O GET do link baixa o ZIP com o nome da exportação.
    const download = await SELF.fetch(link.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toBe(`attachment; filename="${link.filename}"`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK": ZIP
    expect(bytes.length).toBe(link.size_bytes);
    await clearAlarm(f.profile);
  }, 120_000);

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
    // A mesma hora nas duas instâncias (03:20 em São Paulo).
    at(upcoming("03:20"));
    const source = await fixture();
    await prepare(source.profile);
    await clearAlarm(source.profile);
    await setAlarm(source.profile, far());
    expect(await runDurableObjectAlarm(erpStub(env, source.profile))).toBe(true);
    const backup = await (await erpFetch(env, source.profile, "/erp-backup", { method: "POST" })).json<any>();
    expect(backup.manifest.tables.map((t: any) => t.table)).not.toContain("wb_routine");
    expect(backup.manifest.tables.map((t: any) => t.table)).toContain("erp_platform__task");
    const target = await fixture();
    await prepare(target.profile);
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
      { id: "contracts.daily", last_status: "skipped" },
      { id: "finance.recurring", last_status: "skipped" },
      { id: "platform.schedule", last_status: "ok" },
      { id: "retention", last_status: "ok" },
    ]);
    // Mesma hora: a tarefa restaurada é a mesma (chave), nada se repete.
    const purposes = after.tasks.map((t: any) => t.purpose);
    expect(purposes.filter((p: string) => p === "export_cleanup").length).toBe(1);
    expect(after.tasks.every((t: any) => t.purpose !== "notifications_generate" || t.status === "done")).toBe(true);
    await clearAlarm(target.profile);
  }, 120_000);

  it("cron: renova a cada cinco minutos, inclui desligamentos pendentes e resolve dependências", async () => {
    at(upcoming("03:20"));
    const on = await fixture();
    const off = await fixture();
    const fiscalOnly = await fixture();
    const save = (profile: string, module: string, enabled: number) => exec(env,
      "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled",
      profile, module, enabled, Date.now(), "teste");
    await save(on.profile, "erp", 1);
    await save(on.profile, "erp-pdv", 1); // faltam dependências: PDV permanece desligado
    await save(off.profile, "erp", 0);
    await save(fiscalOnly.profile, "erp-fiscal", 1);
    const mine = [on.profile, off.profile, fiscalOnly.profile];
    const areas = (await erpAreas(env)).filter(a => mine.includes(a.profile));
    expect(areas).toHaveLength(3);
    expect(areas.find(a => a.profile === on.profile)?.parts).toMatchObject({ customers: true, pos: false });
    expect(areas.filter(a => a.profile !== on.profile).every(a => !a.parts.customers && !a.parts.fiscal)).toBe(true);
    expect(isErpCronSlot(Date.parse("2026-11-16T15:04:59Z"))).toBe(true);
    expect(isErpCronSlot(Date.parse("2026-11-16T15:05:00Z"))).toBe(true);
    expect(await wakeErpAreas(env, Date.parse("2026-11-16T15:35:00Z"))).toBeGreaterThanOrEqual(3);
    for (const profile of mine) expect((await readErpPartsState(env, profile)).erp_sync.status).toBe("applied");
    const kept = await runInDurableObject(erpStub(env, on.profile), (_i: any, s: DurableObjectState) => s.storage.get<ErpPartsSnapshot>("erp_parts"));
    expect(kept?.parts).toMatchObject({ customers: true, fiscal: false, billing: false, pos: false });
    expect(await alarmOf(off.profile)).toBeNull();
    expect(await alarmOf(fiscalOnly.profile)).toBeNull();
    await clearAlarm(on.profile);
  }, 60_000);
});
