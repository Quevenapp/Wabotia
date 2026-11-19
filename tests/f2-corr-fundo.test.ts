import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec } from "../src/db";
import type { Env } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { applyErpPartsSnapshot, ERP_PARTS_KEY } from "../src/erp/parts-control";
import { ERP_PARTS_CLOCK_SKEW_MS, ERP_PARTS_TTL_MS, normalizeErpParts, type ErpPartsSnapshot } from "../src/erp/parts";
import { decodeIdentity, encodeIdentity, IDENTITY_HEADER } from "../src/erp/engine/identity";
import { ERP_PARTS_STATE_SQL, deliverErpParts, erpPartsStateOf, readErpPartsState } from "../src/modules/erp/parts-state";
import { ERP_CRON_MAX_AREAS, ERP_CRON_CONCURRENCY, wakeErpAreas } from "../src/erp/scheduler/cron";
import { localFetch } from "../src/erp/api/local-fetch";
import { bearer, fixture } from "./service-center-fixture";

const areaIds = new Set<string>();
afterEach(async () => {
  vi.useRealTimers();
  if (!areaIds.size) return;
  // O D1 persiste entre os casos deste arquivo. Limpa só as áreas da fixture;
  // apagar módulos dispara revisões, por isso remove a revisão depois deles.
  const profiles = JSON.stringify([...areaIds]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM profile_modules WHERE profile_id IN (SELECT value FROM json_each(?))").bind(profiles),
    env.DB.prepare("DELETE FROM profile_erp_revision WHERE profile_id IN (SELECT value FROM json_each(?))").bind(profiles),
    env.DB.prepare("DELETE FROM instance_settings WHERE key IN (SELECT 'erp_parts_attempt:' || value FROM json_each(?))").bind(profiles),
  ]);
  areaIds.clear();
});
const inspect = <T>(profile: string, fn: (s: DurableObjectState) => T) =>
  runInDurableObject(erpStub(env, profile), (_i: unknown, s: DurableObjectState) => fn(s));
const tables = (profile: string) => inspect(profile, s => s.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='erp_meta'").toArray());
const snap = (profile: string, changes: Partial<ErpPartsSnapshot> = {}): ErpPartsSnapshot =>
  ({ profile, revision: "1", parts: normalizeErpParts(), expires_at: Date.now() + ERP_PARTS_TTL_MS, ...changes });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

/** D1 real com observação/atraso só na fronteira; não simula o SQL nem o ACK. */
function observedEnv(before: (sql: string, args: unknown[]) => Promise<void> = async () => {}) {
  const statements: string[] = [], delivered: ErpPartsSnapshot[] = [];
  const wrapped = {
    ...env,
    DB: { prepare(sql: string) { return { bind(...args: any[]) {
      const bound = env.DB.prepare(sql).bind(...args);
      return {
        async all() { statements.push(sql); await before(sql, args); return bound.all(); },
        async run() { statements.push(sql); await before(sql, args); return bound.run(); },
      };
    } }; } },
    COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (_url: unknown, init: RequestInit) => {
        const s = JSON.parse(String(init.body)) as ErpPartsSnapshot;
        delivered.push(s);
        return Response.json({ profile: s.profile, revision: s.revision });
      } }),
    },
  } as unknown as Env;
  return { env: wrapped, statements, delivered };
}
async function areas(count: number) {
  const prefix = crypto.randomUUID();
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
  for (const id of ids) areaIds.add(id);
  await env.DB.batch(ids.map(id => env.DB.prepare(
    "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,?)").bind(id, Date.now())));
  return ids;
}

describe("correções das entregas e rotinas de fundo", () => {
  it("cron entrega as primeiras leituras enquanto uma área está lenta, com concorrência limitada", async () => {
    const ids = await areas(12), slow = deferred(), progressed = deferred();
    let active = 0, maximum = 0;
    const f = observedEnv(async (sql, args) => {
      if (sql !== ERP_PARTS_STATE_SQL) return;
      active++; maximum = Math.max(maximum, active);
      if (args[0] === ids[0]) await slow.promise;
      active--;
      if (args[0] === ids.at(-1)) progressed.resolve();
    });
    const running = wakeErpAreas(f.env, Date.now());
    try {
      await progressed.promise;
      expect(f.delivered.some(s => s.profile === ids[0])).toBe(false);
      // As demais vagas podem ainda estar lendo; só a área lenta fica retida.
      expect(f.delivered.length).toBeGreaterThanOrEqual(ids.length - ERP_CRON_CONCURRENCY);
      expect(maximum).toBeLessThanOrEqual(ERP_CRON_CONCURRENCY);
    } finally { slow.resolve(); await running; }
    expect(new Set(f.delivered.map(s => s.profile))).toEqual(new Set(ids));
  });

  it("orçamento deixa continuidade durável; falha de leitura não confirma nem monopoliza a próxima passagem", async () => {
    const ids = await areas(ERP_CRON_MAX_AREAS + 3);
    const f = observedEnv(async (sql, args) => {
      if (sql === ERP_PARTS_STATE_SQL && args[0] === ids[0]) throw new Error("leitura indisponível");
    });
    await wakeErpAreas(f.env, Date.now());
    expect(f.delivered).toHaveLength(ERP_CRON_MAX_AREAS - 1);
    expect(f.statements.length).toBeLessThanOrEqual(2 + 4 * ERP_CRON_MAX_AREAS);
    expect((await readErpPartsState(env, ids[0])).erp_sync.status).toBe("pending");
    const resumed = observedEnv();
    await wakeErpAreas(resumed.env, Date.now() + 300_000);
    expect(resumed.delivered.map(s => s.profile)).toEqual(expect.arrayContaining(ids.slice(-3)));
    expect((await readErpPartsState(env, ids[0])).erp_sync.status).toBe("applied");
  });

  it("poucas áreas renovam a cada passagem e desligamento pendente sai após o ACK", async () => {
    const ids = await areas(2), f = observedEnv();
    await wakeErpAreas(f.env, Date.now());
    expect(f.delivered.map(s => s.profile).sort()).toEqual(ids);
    f.delivered.length = 0;
    await exec(env, "UPDATE profile_modules SET enabled=0 WHERE profile_id=?", ids[1]);
    await wakeErpAreas(f.env, Date.now() + 300_000);
    expect(f.delivered.map(s => s.profile).sort()).toEqual(ids);
    expect(f.delivered.find(s => s.profile === ids[0])?.parts.customers).toBe(true);
    expect(f.delivered.find(s => s.profile === ids[1])?.parts.customers).toBe(false);
    expect((await readErpPartsState(env, ids[1])).erp_sync.status).toBe("applied");
    f.delivered.length = 0;
    await wakeErpAreas(f.env, Date.now() + 600_000);
    expect(f.delivered.map(s => s.profile)).toEqual([ids[0]]);
  });

  it("prazo encerrado durante a resposta não grava ACK tardio", async () => {
    const [profile] = await areas(1), waiting = deferred(), release = deferred();
    const controller = new AbortController();
    const { snapshot } = await readErpPartsState(env, profile);
    const delayed = { ...env, COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => {
        waiting.resolve(); await release.promise;
        return Response.json({ profile, revision: snapshot.revision });
      } }),
    } } as unknown as Env;
    const delivery = deliverErpParts(delayed, snapshot, controller.signal);
    await waiting.promise;
    controller.abort(); release.resolve();
    expect(await delivery).toBe(false);
    expect((await readErpPartsState(env, profile)).erp_sync.status).toBe("pending");
  });

  it("emissão D1/envelope tolera relógio adiantado sem ampliar a autorização", async () => {
    const [profile] = await areas(1);
    const rows = await all(env, ERP_PARTS_STATE_SQL, profile);
    const now = Date.now() + 86_400_000;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const issued = now + ERP_PARTS_CLOCK_SKEW_MS;
    const s = erpPartsStateOf(profile, rows, issued).snapshot;
    expect(s.issued_at).toBe(issued);
    expect(s.expires_at - s.issued_at!).toBe(ERP_PARTS_TTL_MS);
    const { parts, ...partsControl } = s;
    const identity = decodeIdentity(encodeIdentity({ actor: null, people: null, parts, partsControl }));
    expect(identity.partsControl).toEqual(partsControl);
    expect(await deliverErpParts(env, s)).toBe(true);
    expect(await tables(profile)).toEqual([]);
    vi.setSystemTime(now + ERP_PARTS_TTL_MS);
    expect(await deliverErpParts(env, s)).toBe(false);
    await inspect(profile, state => state.storage.deleteAlarm());
  });

  it("renovação real preserva alarme e não cria esquema", async () => {
    const [profile] = await areas(1);
    const now = Date.now() + 86_400_000;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    expect(await deliverErpParts(env, (await readErpPartsState(env, profile)).snapshot)).toBe(true);
    await inspect(profile, state => state.storage.setAlarm(now + 3_600_000));
    vi.setSystemTime(now + 300_000);
    expect(await deliverErpParts(env, (await readErpPartsState(env, profile)).snapshot)).toBe(true);
    expect(await tables(profile)).toEqual([]);
    expect(await inspect(profile, state => state.storage.getAlarm())).toBe(now + 3_600_000);
    await inspect(profile, state => state.storage.deleteAlarm());
  });

  it("RPC recusado por fotografia ausente, parcial, vencida, superada ou Base desligada não cria SQLite", async () => {
    for (const kind of ["ausente", "parcial", "vencida", "superada", "desligada"]) {
      const profile = crypto.randomUUID();
      const s = snap(profile);
      if (kind === "parcial") s.parts = { customers: true } as any;
      if (kind === "vencida") s.expires_at = Date.now() - 1;
      if (kind === "desligada") s.parts = normalizeErpParts({ customers: false });
      if (kind === "superada") await inspect(profile, state => applyErpPartsSnapshot(state.storage, profile, { ...s, revision: "2" }));
      const { parts, ...partsControl } = s;
      const response = await erpFetch(env, profile, "/erp-rpc/erp_access_me", { method: "POST", body: "{}",
        headers: { [IDENTITY_HEADER]: encodeIdentity({ actor: null, people: null, ...(kind === "ausente" ? {} : { parts, partsControl }) }) },
      });
      expect(response.status).toBe(["superada", "desligada"].includes(kind) ? 409 : 503);
      expect(await tables(profile)).toEqual([]);
    }
  });

  it("recuperação interna funciona sem fotografia e com Base suspensa; HTTP/costura não expõem as rotas", async () => {
    const f = await fixture(), target = crypto.randomUUID();
    const suspended = snap(f.profile, { parts: normalizeErpParts({ customers: false }) });
    expect((await erpFetch(env, f.profile, "/erp-parts", { method: "POST", body: JSON.stringify(suspended) })).status).toBe(200);
    const response = await erpFetch(env, f.profile, "/erp-backup", { method: "POST" });
    expect(response.status).toBe(200);
    const backup = await response.json<{ prefix: string }>();
    const restored = await erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    expect(restored.status).toBe(200);
    expect(await inspect(target, state => state.storage.get(ERP_PARTS_KEY))).toBeUndefined();
    const token = await bearer(f.admin);
    const fetch = localFetch(env, f.profile, f.admin);
    for (const route of ["erp-backup", "erp-restore"]) {
      expect((await fetch(`https://erp.wabotia.invalid/${route}`, { method: "POST", body: "{}" })).status).toBe(404);
      for (const path of [`/${route}`, `/api/v1/profiles/${f.profile}/${route}`]) {
        const outside = await SELF.fetch(`https://test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
        expect(outside.status).toBe(404);
      }
    }
  }, 120_000);
});
