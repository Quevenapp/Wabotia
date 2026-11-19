import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec } from "../src/db";
import { fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";
import { ErpHub, erpFetch, erpStub } from "../src/erp/hub";
import { ERP_PARTS_KEY, currentErpParts } from "../src/erp/parts-control";
import { normalizeErpParts, type ErpPartsSnapshot } from "../src/erp/parts";
import { deliverErpParts, readErpPartsState } from "../src/modules/erp/parts-state";
import { erpAreas, wakeErpAreas } from "../src/erp/scheduler/cron";
import { runRound } from "../src/erp/scheduler/dispatch";
import { guardedFileBucket, runFileTasks } from "../src/erp/scheduler/files";
import { storageDriver } from "../src/erp/engine/driver";
import { callRpc } from "../src/erp/engine/registry";

const realNow = Date.now.bind(Date);
afterEach(() => vi.useRealTimers());
const freeze = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = realNow() + 86_400_000;
  vi.setSystemTime(now);
  return now;
};
const inspect = <T>(profile: string, fn: (s: DurableObjectState) => T) =>
  runInDurableObject(erpStub(env, profile), (_i: unknown, s: DurableObjectState) => fn(s));
const saved = (profile: string) => inspect(profile, s => s.storage.get<ErpPartsSnapshot>(ERP_PARTS_KEY));
const schema = (profile: string) => inspect(profile, s => s.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='erp_meta'").toArray());
const alarm = (profile: string) => inspect(profile, s => s.storage.getAlarm());
const clear = (profile: string) => inspect(profile, s => s.storage.deleteAlarm());
const send = (snapshot: ErpPartsSnapshot) => erpFetch(env, snapshot.profile, "/erp-parts", { method: "POST", body: JSON.stringify(snapshot) });
const snapshot = (profile: string, revision = "1", parts = normalizeErpParts()) => ({ profile, revision, parts, expires_at: Date.now() + 360_000 });
const intercept = (fetcher: (profile: string, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => ({
  ...env,
  COORDINATOR: { idFromName: (name: string) => name.slice(4), get: (profile: string) => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => fetcher(profile, input, init) }) },
}) as any;

describe("fase 2: estado confiável de fundo", () => {
  it("/erp-parts persiste no KV antes de qualquer esquema; wake recusa autorização parcial", async () => {
    freeze();
    const f = await fixture();
    const s = snapshot(f.profile);
    const delivered = await send(s);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ profile: f.profile, revision: "1" });
    expect(await saved(f.profile)).toEqual(s);
    expect(await schema(f.profile)).toEqual([]);
    const wake = await erpFetch(env, f.profile, "/erp-wake", { method: "POST", body: JSON.stringify({ blocks: { "erp-fiscal": true } }) });
    expect(wake.status).toBe(400);
    expect(await schema(f.profile)).toEqual([]);
    const wrong = await erpStub(env, f.profile).fetch("https://internal/erp-parts", {
      method: "POST", headers: { "x-erp-profile": "outra-area" }, body: JSON.stringify(snapshot("outra-area")),
    });
    expect(wrong.status).toBe(409);
    expect(await saved(f.profile)).toEqual(s);
    await clear(f.profile);
  });

  it("revisão fora de ordem e mudança do mapa na mesma revisão não reativam; TTL excessivo falha", async () => {
    freeze();
    const f = await fixture();
    const on = snapshot(f.profile, "1");
    const off = snapshot(f.profile, "2", normalizeErpParts({ customers: false }));
    expect((await send(on)).status).toBe(200);
    expect((await send(off)).status).toBe(200);
    expect(await alarm(f.profile)).toBeNull();
    expect((await send(on)).status).toBe(409);
    expect((await send({ ...on, revision: "2" })).status).toBe(409);
    expect((await send({ ...on, revision: "3", expires_at: Date.now() + 360_001 })).status).toBe(503);
    expect(await saved(f.profile)).toEqual(off);
    expect(await schema(f.profile)).toEqual([]);
  });

  it("renovação da mesma revisão estende validade sem mudar mapa nem adiantar alarme vazio", async () => {
    const now = freeze();
    const f = await fixture();
    const s = snapshot(f.profile);
    await send(s);
    const planned = now + 3_600_000;
    await inspect(f.profile, state => state.storage.setAlarm(planned));
    vi.setSystemTime(now + 300_000);
    const renewed = { ...s, expires_at: Date.now() + 360_000 };
    expect((await send(renewed)).status).toBe(200);
    expect((await saved(f.profile))?.expires_at).toBe(now + 660_000);
    expect(await alarm(f.profile)).toBe(planned);
    expect((await send({ ...renewed, expires_at: Date.now() + 10_000 })).status).toBe(200);
    expect((await saved(f.profile))?.expires_at).toBe(now + 660_000);
    await clear(f.profile);
  });

  it("ausência, expiração e Base desligada encerram alarme antes de carregar esquema", async () => {
    const now = freeze();
    for (const state of [null, snapshot("unused", "1"), snapshot("unused", "1", normalizeErpParts({ customers: false }))]) {
      const f = await fixture();
      await inspect(f.profile, async s => {
        await s.storage.put({ kind: "erp", erp_profile: f.profile });
        if (state) await s.storage.put(ERP_PARTS_KEY, { ...state, profile: f.profile, expires_at: state.parts.customers ? now : now + 360_000 });
        await s.storage.setAlarm(now + 60_000);
        await new ErpHub(env, s).alarm();
      });
      expect(await schema(f.profile)).toEqual([]);
      expect(await alarm(f.profile)).toBeNull();
    }
  });

  it("expiração durante o await do carregamento também impede migração e execução", async () => {
    const now = freeze();
    const f = await fixture();
    await send(snapshot(f.profile));
    await inspect(f.profile, async s => {
      let reads = 0;
      const storage = new Proxy(s.storage, { get(target, key) {
        if (key === "get") return async (name: string) => {
          const value = await target.get(name);
          if (name === ERP_PARTS_KEY && ++reads === 2) vi.setSystemTime(now + 360_000);
          return value;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await new ErpHub(env, { storage, id: s.id } as DurableObjectState).alarm();
      expect(reads).toBe(2);
    });
    expect(await schema(f.profile)).toEqual([]);
    expect(await alarm(f.profile)).toBeNull();
  });

  it("perda de entrega e de ACK ficam pendentes; repetição confirma sem duplicar ou regredir", async () => {
    freeze();
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    const { snapshot: s } = await readErpPartsState(env, f.profile);
    const lost = intercept(async () => { throw new Error("entrega perdida"); });
    expect(await deliverErpParts(lost, s)).toBe(false);
    expect(await saved(f.profile)).toBeUndefined();
    const ackLost = intercept(async (profile, input, init) => {
      const response = await erpStub(env, profile).fetch(input, init);
      await response.body?.cancel();
      throw new Error("ACK perdido");
    });
    expect(await deliverErpParts(ackLost, s)).toBe(false);
    expect(await saved(f.profile)).toEqual(s);
    expect((await readErpPartsState(env, f.profile)).erp_sync.status).toBe("pending");
    expect(await deliverErpParts(env, s)).toBe(true);
    expect((await readErpPartsState(env, f.profile)).erp_sync).toEqual({ revision: s.revision, delivered_revision: s.revision, status: "applied" });
    expect(await schema(f.profile)).toEqual([]);
    await clear(f.profile);
  });

  it("ACK de entrega concorrente só confirma sua revisão; cron entrega desligamento inclusive após excluir a linha", async () => {
    freeze();
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    const { snapshot: s } = await readErpPartsState(env, f.profile);
    const changed = intercept(async (profile, input, init) => {
      const response = await erpStub(env, profile).fetch(input, init);
      await exec(env, "DELETE FROM profile_modules WHERE profile_id=? AND module_id='erp'", profile);
      return response;
    });
    expect(await deliverErpParts(changed, s)).toBe(true);
    const pending = await readErpPartsState(env, f.profile);
    expect(BigInt(pending.erp_sync.revision)).toBeGreaterThan(BigInt(s.revision));
    expect(pending.erp_sync.delivered_revision).toBe(s.revision);
    expect(pending.erp_sync.status).toBe("pending");
    expect((await erpAreas(env)).some(a => a.profile === f.profile)).toBe(true);
    await wakeErpAreas(env, Date.parse("2026-11-19T12:35:00Z"));
    expect((await saved(f.profile))?.parts.customers).toBe(false);
    expect((await readErpPartsState(env, f.profile)).erp_sync.status).toBe("applied");
    expect(await alarm(f.profile)).toBeNull();
    expect((await erpAreas(env)).some(a => a.profile === f.profile)).toBe(false);
    expect(await deliverErpParts(env, s)).toBe(false);
    expect((await saved(f.profile))?.parts.customers).toBe(false);
  });

  it("cron renova área ligada na passagem de cinco minutos sem exigir pendência", async () => {
    const now = freeze();
    const f = await fixture();
    await setModule(f.profile, "erp", true, f.admin.id);
    await wakeErpAreas(env, now);
    const first = await saved(f.profile);
    await inspect(f.profile, s => s.storage.setAlarm(now + 3_600_000));
    vi.setSystemTime(now + 300_000);
    await wakeErpAreas(env, now + 300_000);
    const latest = await saved(f.profile);
    expect(latest?.revision).toBe(first?.revision);
    expect(latest?.expires_at).toBe(now + 660_000);
    expect(await alarm(f.profile)).toBe(now + 3_600_000);
    await clear(f.profile);
  });

  it("desligamento durante yield termina unidade síncrona, devolve claim sem tentativa e não agenda ciclo vazio", async () => {
    freeze();
    const f = await fixture();
    const s = snapshot(f.profile);
    await send(s);
    await erpFetch(env, f.profile, "/erp-ping");
    await inspect(f.profile, async state => {
      const db = storageDriver(state.storage);
      const id = crypto.randomUUID();
      const at = String(BigInt(Date.now() - 1) * 1000n);
      db.exec("INSERT INTO erp_platform__task(id,purpose,operation_id,next_attempt_at,created_at) VALUES(?,'notifications_generate',?,?,?)", id, id, at, at);
      let ran = 0;
      const readParts = async () => (await currentErpParts(state.storage, f.profile))?.parts ?? null;
      const report = await runRound(db, { parts: s.parts, readParts, routines: [],
        handlers: { notifications_generate: () => { ran++; return {}; } },
        yieldTurn: async () => { await state.storage.put(ERP_PARTS_KEY, { ...s, revision: "2", parts: normalizeErpParts({ customers: false }) }); },
      });
      expect(ran).toBe(0);
      expect(db.exec("SELECT status, attempts, error_code FROM erp_platform__task WHERE id=?", id).rows[0]).toEqual({ status: "queued", attempts: 0, error_code: null });
      expect(db.exec("SELECT * FROM erp_platform__task_attempt WHERE task_id=?", id).rows).toEqual([]);
      expect(report).toMatchObject({ more: false, nextWake: null, fileDue: false });
      await new ErpHub(env, state).alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("arquivo: desligamento depois do claim devolve a tarefa e não consome tentativa nem toca R2", async () => {
    freeze();
    const f = await fixture();
    await send(snapshot(f.profile));
    await erpFetch(env, f.profile, "/erp-ping");
    await inspect(f.profile, async state => {
      const db = storageDriver(state.storage);
      const id = crypto.randomUUID(), at = String(BigInt(Date.now() - 1) * 1000n);
      db.exec("INSERT INTO erp_platform__task(id,purpose,operation_id,next_attempt_at,created_at) VALUES(?,'export_cleanup',?,?,?)", id, id, at, at);
      const media = new Proxy({}, { get: () => () => { throw new Error("R2 não deve ser chamado"); } }) as R2Bucket;
      const readParts = async () => db.exec("SELECT status FROM erp_platform__task WHERE id=?", id).rows[0].status === "running"
        ? normalizeErpParts({ customers: false }) : normalizeErpParts();
      await runFileTasks({ ...env, MEDIA: media }, state, f.profile, { parts: normalizeErpParts(), readParts });
      expect(db.exec("SELECT status,attempts,error_code FROM erp_platform__task WHERE id=?", id).rows[0]).toEqual({ status: "queued", attempts: 0, error_code: null });
      expect(db.exec("SELECT * FROM erp_platform__task_attempt WHERE task_id=?", id).rows).toEqual([]);
    });
    await clear(f.profile);
  });

  it("exportação pronta e tarefa terminam juntas mesmo com desligamento antes do finish externo", async () => {
    freeze();
    const f = await fixture();
    await send(snapshot(f.profile));
    await erpFetch(env, f.profile, "/erp-ping");
    await inspect(f.profile, async state => {
      const db = storageDriver(state.storage);
      const at = String(BigInt(Date.now() - 1) * 1000n);
      db.exec("INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,'admin',1,?,?)", f.admin.id, at, at);
      const requested = callRpc(db, "erp_platform_export_request", { p_user_id: f.admin.id, p_command_id: crypto.randomUUID() }, undefined,
        { parts: normalizeErpParts() }) as any;
      const readParts = async () => {
        const ready = db.exec("SELECT ready_at FROM erp_platform__export WHERE id=?", requested.export.id).rows[0].ready_at;
        return normalizeErpParts({ customers: ready === null });
      };
      await runFileTasks(env, state, f.profile, { parts: normalizeErpParts(), readParts });
      const row = db.exec("SELECT t.status,t.attempts,e.ready_at FROM erp_platform__export e JOIN erp_platform__task t ON t.id=e.task_id WHERE e.id=?", requested.export.id).rows[0];
      expect(row.ready_at).not.toBeNull();
      expect(row.status).toBe("done");
      expect(row.attempts).toBe(1);
    });
    await clear(f.profile);
  }, 120_000);

  it("limpeza fornece fotografia completa ao armazenamento e remove somente exportação vencida", async () => {
    freeze();
    const f = await fixture();
    await send(snapshot(f.profile));
    await erpFetch(env, f.profile, "/erp-ping");
    await inspect(f.profile, async state => {
      const db = storageDriver(state.storage), parts = normalizeErpParts();
      const at = String(BigInt(Date.now() - 1) * 1000n);
      db.exec("INSERT INTO erp_access__membership(user_id,role,active,created_at,updated_at) VALUES(?,'admin',1,?,?)", f.admin.id, at, at);
      const rpc = (name: string, args: Record<string, unknown>) => callRpc(db, name, args, undefined, { parts }) as any;
      const requested = rpc("erp_platform_export_request", { p_user_id: f.admin.id, p_command_id: crypto.randomUUID() });
      const lease = crypto.randomUUID();
      const task = rpc("erp_platform_task_claim", { p_lease: lease, p_purposes: ["company_export"] }).task;
      const sha = "a".repeat(64), key = `exports/${requested.export.id}/${sha}.zip`;
      await env.MEDIA.put(`erp-storage/${f.profile}/brufap-exports/${key}`, new Uint8Array(22));
      rpc("erp_platform_export_complete", { p_task: task.id, p_lease: lease, p_object_key: key, p_size_bytes: 22, p_sha256: sha, p_manifest: {} });
      rpc("erp_platform_task_finish", { p_task: task.id, p_lease: lease, p_ok: true, p_result: {}, p_error: null });
      db.exec("UPDATE erp_platform__export SET expires_at=? WHERE id=?", at, requested.export.id);
      const cleanup = crypto.randomUUID();
      db.exec("INSERT INTO erp_platform__task(id,purpose,operation_id,next_attempt_at,created_at) VALUES(?,'export_cleanup',?,?,?)", cleanup, cleanup, at, at);
      await runFileTasks(env, state, f.profile, { parts, readParts: async () => (await currentErpParts(state.storage, f.profile))?.parts ?? null });
      expect(await env.MEDIA.head(`erp-storage/${f.profile}/brufap-exports/${key}`)).toBeNull();
      expect(db.exec("SELECT removed_at FROM erp_platform__export WHERE id=?", requested.export.id).rows[0].removed_at).not.toBeNull();
      const done = db.exec("SELECT status,result FROM erp_platform__task WHERE id=?", cleanup).rows[0];
      expect(done.status).toBe("done");
      expect(JSON.parse(String(done.result))).toEqual({ removed: 1 });
    });
    await clear(f.profile);
  }, 60_000);

  it("R2 revalida após await e antes de cada parte multipart; abort continua permitido", async () => {
    const calls: string[] = [];
    let enabled = true;
    const check = async () => { if (!enabled) throw new Error("suspenso"); };
    const raw = {
      list: async () => { calls.push("list"); enabled = false; return { objects: [] }; },
      createMultipartUpload: async () => ({
        uploadPart: async () => { calls.push("upload"); enabled = false; return {}; },
        complete: async () => { calls.push("complete"); },
        abort: async () => { calls.push("abort"); },
      }),
    };
    const bucket = guardedFileBucket(raw as unknown as R2Bucket, check);
    await expect(bucket.list()).rejects.toThrow("suspenso");
    enabled = true;
    const upload = await bucket.createMultipartUpload("teste");
    await expect(upload.uploadPart(1, new Uint8Array(1))).rejects.toThrow("suspenso");
    await expect(upload.complete([])).rejects.toThrow("suspenso");
    await upload.abort();
    expect(calls).toEqual(["list", "upload", "abort"]);
  });
});
