import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { normalizeErpParts, readErpPartsSnapshot, ERP_PARTS_TTL_MS, ERP_PARTS_CLOCK_SKEW_MS } from "../../../src/erp/parts.ts";
import { applyErpPartsSnapshot, currentErpParts, requireCurrentErpParts } from "../../../src/erp/parts-control.ts";
import { decodeIdentity, encodeIdentity } from "../../../src/erp/engine/identity.ts";

const snapshot = (now, extra = {}) => ({ profile: "area", revision: "1", parts: normalizeErpParts(), expires_at: now + ERP_PARTS_TTL_MS, ...extra });
function kv() {
  const data = new Map(), writes = [];
  const storage = {
    get: async key => data.get(key),
    put: async (key, value) => {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) await storage.put(k, v);
      else { writes.push(key); data.set(key, structuredClone(value)); }
    },
    transaction: async fn => fn(storage),
    sql: { exec: () => assert.fail("recusa não pode acessar SQLite") },
  };
  return { storage, data, writes };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test("renovação grava só a fotografia; duplicata não regrava e vínculos divergentes continuam recusados", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { storage, writes, data } = kv();
  await applyErpPartsSnapshot(storage, "area", snapshot(now));
  assert.deepEqual(writes, ["kind", "erp_profile", "erp_parts"]);
  writes.length = 0;
  now += 300_000;
  await applyErpPartsSnapshot(storage, "area", snapshot(now));
  assert.deepEqual(writes, ["erp_parts"]);
  writes.length = 0;
  await applyErpPartsSnapshot(storage, "area", snapshot(now));
  assert.deepEqual(writes, []);
  data.set("erp_profile", "outra");
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot(now)), { code: "erp_parts_unavailable" });
  data.set("erp_profile", "area"); data.set("kind", "area");
  await assert.rejects(applyErpPartsSnapshot(storage, "area", snapshot(now)), { code: "erp_parts_unavailable" });
  assert.deepEqual(writes, []);
});

test("diferença de relógio de até cinco segundos atravessa identidade e KV sem autorizar além de seis minutos", async t => {
  const start = 1_800_000_000_000;
  let now = start;
  t.mock.method(Date, "now", () => now);
  for (const skew of [-5_000, -2_000, 0, 2_000, 5_000]) {
    now = start;
    const s = snapshot(start + skew, { issued_at: start + skew });
    const { parts, ...partsControl } = s;
    const decoded = decodeIdentity(encodeIdentity({ actor: null, people: null, parts, partsControl }));
    assert.deepEqual(decoded.partsControl, partsControl);
    const { storage } = kv();
    await applyErpPartsSnapshot(storage, "area", { ...decoded.partsControl, parts: decoded.parts });
    const deadline = s.expires_at - ERP_PARTS_CLOCK_SKEW_MS;
    now = deadline - 1;
    assert.ok(await currentErpParts(storage, "area"));
    now++;
    assert.equal(await currentErpParts(storage, "area"), null);
    await assert.rejects(requireCurrentErpParts(storage, "area", s), { code: "erp_parts_unavailable" });
    now = start + ERP_PARTS_TTL_MS;
    assert.equal(readErpPartsSnapshot(s, "area"), null);
    await assert.rejects(applyErpPartsSnapshot(storage, "area", s), { code: "erp_parts_unavailable" });
  }
});

test("margem não aceita emissão distante, duração excessiva nem estende o formato legado", t => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const s of [
    snapshot(now + ERP_PARTS_CLOCK_SKEW_MS + 1, { issued_at: now + ERP_PARTS_CLOCK_SKEW_MS + 1 }),
    snapshot(now, { issued_at: now - 1 }),
    snapshot(now, { issued_at: now + 0.5 }),
    snapshot(now, { issued_at: null }),
    snapshot(now, { issued_at: now, expires_at: now }),
    snapshot(now + 1),
  ]) assert.equal(readErpPartsSnapshot(s), null);
});

test("renovação mais curta conserva o par emissão/vencimento da concessão salva", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const { storage } = kv();
  const s = snapshot(now, { issued_at: now });
  await applyErpPartsSnapshot(storage, "area", s);
  now += 30_000;
  await applyErpPartsSnapshot(storage, "area", snapshot(now, { issued_at: now, expires_at: now + 60_000 }));
  assert.deepEqual(await currentErpParts(storage, "area"), s);
});

// Compila os módulos de produção em memória. Só substitui as fronteiras de
// I/O; seleção, orçamento, ordenação SQL, Hub e controle são o código real.
async function isolated(entry, filter, contents) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
    plugins: [{ name: "fronteira-offline", setup(b) {
      b.onResolve({ filter }, args => ({ path: args.path, namespace: "offline" }));
      b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ contents, loader: "js" }));
    } }],
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}
const cron = await isolated("src/erp/scheduler/cron.ts", /modules\/erp\/parts-state$/, `
  export const readErpPartsState = (...args) => globalThis.f2CronIO.read(...args);
  export const deliverErpParts = (...args) => globalThis.f2CronIO.deliver(...args);
`);

function cronEnv(t, count, hooks = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  t.after(() => { delete globalThis.f2CronIO; });
  db.exec(`CREATE TABLE profile_erp_revision(profile_id TEXT PRIMARY KEY,revision INTEGER,delivered_revision INTEGER);
    CREATE TABLE profile_modules(profile_id TEXT,module_id TEXT,enabled INTEGER);
    CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL);`);
  const ids = Array.from({ length: count }, (_, i) => `area-${String(i).padStart(4, "0")}`);
  for (const id of ids) {
    db.prepare("INSERT INTO profile_erp_revision VALUES(?,1,0)").run(id);
    db.prepare("INSERT INTO profile_modules VALUES(?,'erp',1)").run(id);
  }
  const statements = [], deliveries = [];
  let active = 0, maximum = 0;
  const env = { DB: { prepare(sql) { return { bind(...args) { return {
    async all() { statements.push(sql); return { results: db.prepare(sql).all(...args) }; },
    async run() { statements.push(sql); return db.prepare(sql).run(...args); },
  }; } }; } } };
  globalThis.f2CronIO = {
    async read(_env, profile) {
      active++; maximum = Math.max(maximum, active);
      try { await hooks.read?.(profile); } catch (e) { active--; throw e; }
      return { snapshot: snapshot(Date.now(), { profile }) };
    },
    async deliver(_env, s, signal) {
      try { await hooks.deliver?.(s.profile, signal); deliveries.push(s.profile); return true; }
      finally { active--; }
    },
  };
  return { env, db, ids, deliveries, statements, maximum: () => maximum };
}

test("cron entrega antes da última leitura e limita o número de áreas simultâneas", async t => {
  const slow = deferred(), progressed = deferred();
  const f = cronEnv(t, 12, {
    read: id => id === "area-0000" ? slow.promise : undefined,
    deliver: id => { if (id === "area-0011") progressed.resolve(); },
  });
  const running = cron.wakeErpAreas(f.env, Date.now());
  await progressed.promise;
  assert.equal(f.deliveries.includes(f.ids[0]), false);
  assert.ok(f.deliveries.length >= 10, "leitura lenta não retém as entregas prontas");
  assert.ok(f.maximum() <= cron.ERP_CRON_CONCURRENCY);
  slow.resolve();
  assert.equal(await running, 12);
});

test("cron retoma no D1 áreas fora do orçamento, mesmo após falha e nova instância do Worker", async t => {
  const limit = cron.ERP_CRON_MAX_AREAS;
  const f = cronEnv(t, limit * 2 + 3, { read: id => { if (id === "area-0000") throw new Error("leitura falhou"); } });
  await cron.wakeErpAreas(f.env, Date.now());
  assert.equal(f.deliveries.length, limit - 1);
  assert.ok(f.statements.length <= 2 + 4 * limit);
  assert.equal(f.db.prepare("SELECT delivered_revision FROM profile_erp_revision WHERE profile_id=?").get(f.ids[0]).delivered_revision, 0);
  f.deliveries.length = 0;
  await cron.wakeErpAreas({ ...f.env }, Date.now() + 300_000);
  assert.deepEqual(new Set(f.deliveries), new Set(f.ids.slice(limit, limit * 2)));
  f.deliveries.length = 0;
  await cron.wakeErpAreas({ ...f.env }, Date.now() + 600_000);
  assert.ok(f.ids.slice(limit * 2).every(id => f.deliveries.includes(id)));
});

test("cron encerra no prazo, deixa o restante para depois e não entrega leitura que terminou tarde", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slow = deferred(), started = deferred();
  let reads = 0;
  const f = cronEnv(t, 9, { read: () => { if (++reads === cron.ERP_CRON_CONCURRENCY) started.resolve(); return slow.promise; } });
  const running = cron.wakeErpAreas(f.env, Date.now());
  await started.promise;
  t.mock.timers.tick(cron.ERP_CRON_BUDGET_MS);
  assert.equal(await running, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM instance_settings").get().n, cron.ERP_CRON_CONCURRENCY);
  slow.resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.deliveries, []);
  globalThis.f2CronIO.read = async (_env, profile) => ({ snapshot: snapshot(Date.now(), { profile }) });
  await cron.wakeErpAreas(f.env, Date.now() + 300_000);
  assert.deepEqual(new Set(f.deliveries.slice(0, 5)), new Set(f.ids.slice(4)));
});

const hub = await isolated("src/erp/hub.ts", /hub-engine\.ts$/, `
  globalThis.f2EngineImports = (globalThis.f2EngineImports || 0) + 1;
  globalThis.f2OnEngineImport?.();
  export const migrate = () => { throw new Error("motor não pode migrar chamada recusada"); };
`);
test("Hub recusa fotografia ausente, parcial, vencida, superada ou Base desligada antes do import e do SQLite", async t => {
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const input of [null, snapshot(now, { parts: { customers: true } }), snapshot(now, { expires_at: now }),
    snapshot(now, { revision: "0" }), snapshot(now, { parts: normalizeErpParts({ customers: false }), revision: "2" })]) {
    const { storage } = kv();
    if (input?.revision === "0") await applyErpPartsSnapshot(storage, "area", snapshot(now));
    const { parts, ...partsControl } = input ?? {};
    const request = new Request("https://internal/erp-rpc/erp_access_me", { method: "POST",
      headers: { "x-erp-profile": "area", "x-erp-identity": encodeIdentity({ actor: null, people: null, parts, partsControl }) }, body: "{}" });
    const response = await new hub.ErpHub({}, { id: { name: "erp:area" }, storage }).handle("/erp-rpc/erp_access_me", request);
    assert.equal(response.status, input?.revision === "0" || input?.revision === "2" ? 409 : 503);
    assert.equal(globalThis.f2EngineImports, undefined);
  }
});

test("Hub revalida após o import: vencer nesse await também impede migrate", async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  globalThis.f2OnEngineImport = () => { now += ERP_PARTS_TTL_MS; };
  t.after(() => { delete globalThis.f2OnEngineImport; delete globalThis.f2EngineImports; });
  const { storage } = kv();
  const { parts, ...partsControl } = snapshot(now);
  const request = new Request("https://internal/erp-rpc/erp_access_me", { method: "POST", body: "{}",
    headers: { "x-erp-profile": "area", "x-erp-identity": encodeIdentity({ actor: null, people: null, parts, partsControl }) } });
  const response = await new hub.ErpHub({}, { id: { name: "erp:area" }, storage }).handle("/erp-rpc/erp_access_me", request);
  assert.equal(response.status, 503);
  assert.equal(globalThis.f2EngineImports, 1);
});
