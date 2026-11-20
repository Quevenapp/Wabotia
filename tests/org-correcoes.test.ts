// Correções da revisão: achado 4 (cron com mais áreas que um lote) e a costura
// da restauração interna do achado 1. Relógio simulado; nenhuma chamada ao Bling.
// Os demais achados estão em tests/erp/org/correcoes.test.mjs e no painel.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erpFetch, ErpHub } from "../src/erp/hub";
import { ERP_PARTS_CLOCK_SKEW_MS, ERP_PARTS_TTL_MS, type ErpPartsSnapshot } from "../src/erp/parts";
import { ERP_CRON_MAX_AREAS, wakeErpAreas } from "../src/erp/scheduler/cron";
import { markXmlObjectDelete } from "../src/erp/bling/xml";

const areaIds = new Set<string>();
afterEach(async () => {
  vi.useRealTimers();
  if (!areaIds.size) return;
  const profiles = JSON.stringify([...areaIds]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM profile_modules WHERE profile_id IN (SELECT value FROM json_each(?))").bind(profiles),
    env.DB.prepare("DELETE FROM profile_erp_revision WHERE profile_id IN (SELECT value FROM json_each(?))").bind(profiles),
    env.DB.prepare("DELETE FROM instance_settings WHERE key IN (SELECT 'erp_parts_attempt:' || value FROM json_each(?))").bind(profiles),
  ]);
  areaIds.clear();
});

async function areas(count: number, at: number) {
  const prefix = crypto.randomUUID();
  const ids = Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
  for (const id of ids) areaIds.add(id);
  for (let i = 0; i < ids.length; i += 50)
    await env.DB.batch(ids.slice(i, i + 50).map(id => env.DB.prepare(
      "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,?)").bind(id, at)));
  return ids;
}

/** KV e alarme de uma instância "erp-cron" do Coordinator, sem SQLite. */
function cronInstance() {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: any = {
    get: async (key: string) => kv.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") kv.set(key, value); else for (const [k, v] of Object.entries(key)) kv.set(k, v);
    },
    getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
    transaction: async (fn: (tx: unknown) => unknown) => fn(storage),
    get sql() { throw new Error("A continuação do cron não usa o SQLite do ERP."); },
  };
  return { storage, alarm: () => alarm, take: () => { const at = alarm; alarm = null; return at; } };
}

describe("correções do agendador e da restauração", () => {
  it("achado 4: 250 áreas têm a fotografia renovada dentro da validade, com no máximo um lote por invocação", async () => {
    const T0 = Date.UTC(2027, 0, 4, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
    const ids = await areas(250, T0);
    const mine = new Set(ids), deliveries = new Map<string, number[]>(ids.map(id => [id, []]));
    let invocation = 0;
    const perInvocation = new Map<number, number>(), statements = new Map<number, number>();
    const counted = (n: number) => statements.set(n, (statements.get(n) ?? 0) + 1);
    const cron = cronInstance();
    let hub: ErpHub;
    const wrapped = {
      ...env,
      DB: { prepare(sql: string) { return { bind(...args: unknown[]) {
        const bound = env.DB.prepare(sql).bind(...args), n = invocation;
        return { async all() { counted(n); return bound.all(); }, async run() { counted(n); return bound.run(); }, async first() { counted(n); return bound.first(); } };
      } }; } },
      COORDINATOR: {
        idFromName: (name: string) => name,
        get: (id: string) => ({ fetch: async (url: string, init: RequestInit = {}) => {
          if (id === "erp-cron") return hub.handle(new URL(url).pathname, new Request(url, init));
          const snapshot = JSON.parse(String(init.body)) as ErpPartsSnapshot;
          if (mine.has(snapshot.profile)) {
            deliveries.get(snapshot.profile)!.push(Date.now());
            perInvocation.set(invocation, (perInvocation.get(invocation) ?? 0) + 1);
            expect(snapshot.expires_at).toBeGreaterThan(Date.now());
          }
          return Response.json({ profile: snapshot.profile, revision: snapshot.revision });
        } }),
      },
    } as any;
    hub = new ErpHub(wrapped, { storage: cron.storage, id: { name: "erp-cron" } } as any);

    const windows = 3, period = 300_000;
    for (let window = 0; window < windows; window++) {
      const start = T0 + window * period;
      vi.setSystemTime(start); invocation++;
      await wakeErpAreas(wrapped, start);
      // Continuação durável: cada alarme é uma invocação própria dentro da janela.
      for (let guard = 0; guard < 20; guard++) {
        const at = cron.alarm();
        if (at === null || at >= start + period) break;
        cron.take(); vi.setSystemTime(at); invocation++;
        await hub.alarm();
      }
      for (const id of ids)
        expect(deliveries.get(id)!.some(at => at >= start && at < start + period), `${id} na janela ${window}`).toBe(true);
    }
    const validity = ERP_PARTS_TTL_MS - ERP_PARTS_CLOCK_SKEW_MS;
    for (const id of ids) {
      const times = deliveries.get(id)!;
      expect(times[0] - T0).toBeLessThan(validity);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThan(validity);
    }
    for (const delivered of perInvocation.values()) expect(delivered).toBeLessThanOrEqual(ERP_CRON_MAX_AREAS);
    for (const used of statements.values()) expect(used).toBeLessThanOrEqual(2 + 4 * ERP_CRON_MAX_AREAS);
    expect(invocation).toBeGreaterThanOrEqual(windows * 3);
  }, 120_000);

  it("achado 1: a rota interna recusa restaurar com DELETE de XML em voo, com motivo próprio, e restaura depois", async () => {
    const profile = crypto.randomUUID();
    expect((await erpFetch(env, profile, "/erp-ping")).status).toBe(200);
    const backup = await (await erpFetch(env, profile, "/erp-backup", { method: "POST" })).json<{ prefix: string }>();
    const key = `erp/${profile}/bling/xml/${"a".repeat(64)}`;
    const restore = () => erpFetch(env, profile, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    markXmlObjectDelete(profile, key, true);
    try {
      const refused = await restore();
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "erp_restore_archive_busy" } });
    } finally { markXmlObjectDelete(profile, key, false); }
    expect((await restore()).status).toBe(200);
  }, 120_000);
});
