// Segunda revisão da junção candidata: M5 pela rota interna (ERP suspenso,
// restauração com XML em espera e apagamento com erro gravado; recusa com
// exclusão no ar) e B7 (continuação do cron só com lote cheio e progresso
// gravado). Os casos de M6 e os de M5 no motor estão em
// tests/erp/backup/corr2-revisao.test.mjs. Nenhuma chamada ao Bling.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erpFetch, erpStub, ErpHub } from "../src/erp/hub";
import { ERP_PARTS_TTL_MS, normalizeErpParts, type ErpPartsSnapshot } from "../src/erp/parts";
import { ERP_CRON_BUDGET_MS, ERP_CRON_CONCURRENCY, ERP_CRON_INSTANCE, ERP_CRON_MAX_AREAS, wakeErpAreas } from "../src/erp/scheduler/cron";

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

const inspect = <T>(profile: string, fn: (s: DurableObjectState) => T) =>
  runInDurableObject(erpStub(env, profile), (_i: unknown, s: DurableObjectState) => fn(s));

/** Unidade do Bling gravada à mão (o estado que a coleta deixa). */
function insertUnit(s: DurableObjectState, profile: string, fields: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), command_id: crypto.randomUUID(), request_hash: "d".repeat(64),
    generation: 1, authorization_revision: 0, credential_revision: 0, kind: "xml_store", profile, phase: "waiting",
    progress: "{}", not_before: 0, created_at: 0, updated_at: 0, ...fields,
  };
  const names = Object.keys(row);
  s.storage.sql.exec(`INSERT INTO wb_bling_unit(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`, ...names.map(n => row[n]));
}

async function areas(count: number) {
  const prefix = crypto.randomUUID(), at = Date.now();
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

/**
 * D1 real com interceptação da marca de tentativa (`mark`), entregas às áreas
 * contadas e a instância "erp-cron" simulada (pedidos de continuação contados).
 */
function cronEnv(mark: (args: unknown[]) => Promise<void> = async () => {}) {
  const cron = cronInstance(), mine = new Set(areaIds);
  const delivered: string[] = [], continuations: string[] = [];
  let hub: ErpHub;
  const wrapped = {
    ...env,
    DB: { prepare(sql: string) { return { bind(...args: unknown[]) {
      const bound = env.DB.prepare(sql).bind(...args);
      return {
        async all() { return bound.all(); }, async first() { return bound.first(); },
        async run() { if (sql.startsWith("INSERT INTO instance_settings")) await mark(args); return bound.run(); },
      };
    } }; } },
    COORDINATOR: {
      idFromName: (name: string) => name,
      get: (id: string) => ({ fetch: async (url: string, init: RequestInit = {}) => {
        if (id === ERP_CRON_INSTANCE) { continuations.push(url); return hub.handle(new URL(url).pathname, new Request(url, init)); }
        const snapshot = JSON.parse(String(init.body)) as ErpPartsSnapshot;
        if (mine.has(snapshot.profile)) delivered.push(snapshot.profile);
        return Response.json({ profile: snapshot.profile, revision: snapshot.revision });
      } }),
    },
  } as any;
  hub = new ErpHub(wrapped, { storage: cron.storage, id: { name: ERP_CRON_INSTANCE } } as any);
  return { env: wrapped, cron, hub, delivered, continuations };
}

describe("segunda revisão: restauração e cron", () => {
  it("M5: com o ERP suspenso, XML em espera com progresso e apagamento com erro gravado não travam; exclusão no ar recusa com motivo", async () => {
    const source = crypto.randomUUID(), target = crypto.randomUUID();
    expect((await erpFetch(env, source, "/erp-ping")).status).toBe(200);
    const backup = await (await erpFetch(env, source, "/erp-backup", { method: "POST" })).json<{ prefix: string }>();
    expect((await erpFetch(env, target, "/erp-ping")).status).toBe(200);
    // ERP suspenso na área de destino (a Base desligada): o cenário de recuperação.
    const suspended: ErpPartsSnapshot = { profile: target, revision: "1", parts: normalizeErpParts({ customers: false }), expires_at: Date.now() + ERP_PARTS_TTL_MS };
    expect((await erpFetch(env, target, "/erp-parts", { method: "POST", body: JSON.stringify(suspended) })).status).toBe(200);
    await inspect(target, s => {
      insertUnit(s, target, { kind: "xml_store", progress: JSON.stringify({ xml: { phase: "stored", documents: [{ sha256: "a".repeat(64) }] } }) });
      insertUnit(s, target, { kind: "r2_delete", error_code: "BLING_RETRY_WAIT", not_before: Date.now() + 30_000 });
      insertUnit(s, target, { kind: "r2_delete", phase: "queued", progress: JSON.stringify({ deleted: true }) });
    });
    const restore = () => erpFetch(env, target, "/erp-restore", { method: "POST", body: JSON.stringify({ prefix: backup.prefix }) });
    const restored = await restore();
    expect(restored.status, await restored.clone().text()).toBe(200);
    // Exclusão no R2 de fato no ar (dono e posse viva): continua recusando, e diz o que fazer.
    await inspect(target, s => insertUnit(s, target, { kind: "r2_delete", owner: "dono", fence: "f1", lease_until: Date.now() + 30_000 }));
    const refused = await restore();
    expect(refused.status).toBe(409);
    const body = await refused.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("erp_restore_archive_busy");
    expect(body.error.message).toMatch(/exclusão de XML do acervo/);
    expect(body.error.message).toMatch(/Espere a coleta do Bling em curso terminar/);
    await inspect(target, s => { s.storage.sql.exec("DELETE FROM wb_bling_unit"); return s.storage.deleteAlarm(); });
  }, 120_000);

  it("B7: 101 áreas, uma continuação de 1 área e a rodada para", async () => {
    const ids = await areas(ERP_CRON_MAX_AREAS + 1);
    const f = cronEnv();
    const start = Date.now();
    await wakeErpAreas(f.env, start);
    expect(f.delivered).toHaveLength(ERP_CRON_MAX_AREAS);
    expect(f.continuations).toHaveLength(1);
    const at = f.cron.take();
    expect(at).not.toBeNull();
    await f.hub.alarm();
    expect(f.delivered).toHaveLength(ERP_CRON_MAX_AREAS + 1);
    expect(new Set(f.delivered)).toEqual(new Set(ids));
    // A continuação veio parcial: não reagenda.
    expect(f.cron.alarm()).toBeNull();
    expect(f.continuations).toHaveLength(1);
  }, 120_000);

  it("B7: lote cheio sem nenhuma marca gravada (D1 recusando escrita) termina a rodada sem continuação", async () => {
    await areas(ERP_CRON_MAX_AREAS + 1);
    const f = cronEnv(async () => { throw new Error("D1 recusou a escrita"); });
    await wakeErpAreas(f.env, Date.now());
    expect(f.delivered).toHaveLength(0);
    expect(f.continuations).toHaveLength(0);
    expect(f.cron.alarm()).toBeNull();
  }, 120_000);

  it("B7: prazo estourado antes de qualquer marca termina a rodada sem continuação", async () => {
    await areas(3);
    let waiting = 0, reached!: () => void, release!: () => void;
    const allWaiting = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    // Cada marca fica presa até depois do prazo, e então falha: nenhum progresso gravado.
    const f = cronEnv(async () => {
      if (++waiting === Math.min(3, ERP_CRON_CONCURRENCY)) reached();
      await released;
      throw new Error("tarde demais");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wake = wakeErpAreas(f.env, Date.now());
    await allWaiting;
    await vi.advanceTimersByTimeAsync(ERP_CRON_BUDGET_MS);
    await wake;
    release();
    expect(f.delivered).toHaveLength(0);
    expect(f.continuations).toHaveLength(0);
    expect(f.cron.alarm()).toBeNull();
  }, 120_000);
});
