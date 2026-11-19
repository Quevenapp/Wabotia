import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { nodeDriver } from "../harness/node-driver.mjs";

const migration = readFileSync("migrations/0133_erp_parts.sql", "utf8");
const core = ["erp-compras", "erp-estoque", "erp-financeiro", "erp-produtos", "erp-vendas"];
function fixture(t, before = "") {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE profile_modules(profile_id TEXT, module_id TEXT, enabled INTEGER,
    updated INTEGER, updated_by TEXT, PRIMARY KEY(profile_id,module_id)); ${before}`);
  db.exec(migration);
  const save = (area, id, enabled) => db.prepare(`INSERT INTO profile_modules VALUES(?,?,?,10,'writer')
    ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled`).run(area, id, enabled);
  const mark = area => db.prepare("INSERT OR IGNORE INTO profile_erp_parts_managed VALUES(?)").run(area);
  const rows = area => db.prepare("SELECT * FROM profile_modules WHERE profile_id=? ORDER BY module_id").all(area);
  const states = area => Object.fromEntries(rows(area).map(row => [row.module_id, row.enabled]));
  return { db, save, mark, rows, states };
}

test("0133 completa cinco partes na ativação antiga por INSERT e na transição desligado→ligado", t => {
  const f = fixture(t, "INSERT INTO profile_modules VALUES('old-off','erp',0,1,'old')");
  const offBefore = f.rows("old-off");
  for (const area of ["old-insert", "old-off"]) {
    f.save(area, "erp", 1);
    assert.deepEqual(f.states(area), Object.fromEntries(["erp", ...core].map(id => [id, 1])));
    assert.equal(f.db.prepare("SELECT count(*) n FROM profile_erp_parts_managed WHERE profile_id=?").get(area).n, 0);
    const revision = f.db.prepare("SELECT * FROM profile_erp_revision WHERE profile_id=?").get(area);
    assert.equal(revision.revision, area === "old-insert" ? 6 : 7);
    assert.equal(revision.delivered_revision, 0);
  }
  assert.ok(offBefore.every(row => row.enabled === 0));
  assert.equal(f.db.prepare("SELECT count(*) n FROM profile_modules WHERE module_id IN ('erp-fiscal','erp-cobranca','erp-pdv')").get().n, 0);
});

test("marca e ativação novas no mesmo lote mantêm só a Base, inclusive ao reaplicar a 0133", t => {
  const f = fixture(t);
  f.db.exec("BEGIN");
  f.mark("new"); f.save("new", "erp", 1);
  f.db.exec("COMMIT");
  assert.deepEqual(f.states("new"), { erp: 1 });
  const before = f.rows("new");
  const revision = f.db.prepare("SELECT * FROM profile_erp_revision WHERE profile_id='new'").get();
  f.db.exec(migration);
  assert.deepEqual(f.rows("new"), before);
  assert.deepEqual(f.db.prepare("SELECT * FROM profile_erp_revision WHERE profile_id='new'").get(), revision);
});

test("escolha nova de desligar uma parte sobrevive a ativação antiga e à reexecução", t => {
  const f = fixture(t);
  f.save("area", "erp", 1);
  f.db.exec("BEGIN");
  f.mark("area"); f.save("area", "erp-estoque", 0);
  f.db.exec("COMMIT");
  const before = f.rows("area").filter(row => row.module_id !== "erp");
  f.save("area", "erp", 0); f.save("area", "erp", 1);
  f.db.exec(migration);
  assert.deepEqual(f.rows("area").filter(row => row.module_id !== "erp"), before);
  assert.equal(f.states("area")["erp-estoque"], 0);
});

test("gravação antiga sem transição não religa parte e não toca outra área", t => {
  const f = fixture(t);
  f.save("area", "erp", 1); f.save("area", "erp-estoque", 0);
  const before = f.rows("area");
  f.save("area", "erp", 1);
  f.save("other", "erp", 1);
  assert.deepEqual(f.rows("area"), before);
  assert.equal(f.states("other")["erp-estoque"], 1);
});

test("rollback remove marca, módulos e revisão juntos; gatilho antigo também é atômico", t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER fail_part BEFORE INSERT ON profile_modules
    WHEN NEW.module_id='erp-estoque' BEGIN SELECT RAISE(ABORT,'forced_failure'); END`);
  assert.throws(() => f.save("old", "erp", 1), /forced_failure/);
  f.db.exec("BEGIN");
  f.mark("new"); f.save("new", "erp", 1);
  assert.throws(() => f.save("new", "erp-estoque", 1), /forced_failure/);
  f.db.exec("ROLLBACK");
  for (const table of ["profile_modules", "profile_erp_revision", "profile_erp_parts_managed"])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
});

// Executa Hub, produtor da fotografia, migração e RPC reais sem Vitest/rede.
// Só o armazenamento do objeto é adaptado para KV em memória e node:sqlite.
let runtimePromise;
const cleanups = [];
after(() => { for (const cleanup of cleanups) cleanup(); });
function runtime() {
  return runtimePromise ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "f2-fecha-hub-"));
    const counter = `f2-fecha-engine-${crypto.randomUUID()}`;
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); delete globalThis[counter]; });
    await build({
      stdin: { contents: `export {ErpHub} from './src/erp/hub.ts';
        export {erpPartsStateOf} from './src/modules/erp/parts-state.ts';
        export {wakeErpAreas} from './src/erp/scheduler/cron.ts';
        export {encodeIdentity} from './src/erp/engine/identity.ts';
        export {readErpPartsSnapshot} from './src/erp/parts.ts';
        export const engineLoads = () => globalThis[${JSON.stringify(counter)}] ?? 0;`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)), loader: "ts" },
      bundle: true, splitting: true, outdir: dir, outExtension: { ".js": ".mjs" },
      format: "esm", platform: "node", mainFields: ["module", "main"], logLevel: "silent",
      plugins: [{ name: "observe-engine", setup(builder) {
        builder.onLoad({ filter: /[/\\]hub-engine\.ts$/ }, ({ path }) => ({
          contents: readFileSync(path, "utf8") + `\nglobalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1;`, loader: "ts",
        }));
      } }],
    });
    return import(pathToFileURL(join(dir, "stdin.mjs")).href);
  })();
}
async function object(t) {
  const m = await runtime(), profile = crypto.randomUUID(), lite = new DatabaseSync(":memory:");
  t.after(() => lite.close());
  const driver = nodeDriver(lite), kv = new Map(); let alarm = null, sqlCalls = 0;
  const storage = {
    get: async key => kv.get(key),
    put: async (key, value) => {
      for (const [k, v] of typeof key === "string" ? [[key, value]] : Object.entries(key)) kv.set(k, structuredClone(v));
    },
    transaction: async fn => fn(storage), transactionSync: fn => driver.transaction(fn),
    getAlarm: async () => alarm, setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = null; },
    sql: { exec(sql, ...params) {
      sqlCalls++;
      const result = driver.exec(sql, ...params);
      return { toArray: () => result.rows, rowsRead: result.rowsRead, rowsWritten: result.rowsWritten };
    } },
  };
  const hub = new m.ErpHub({ MEDIA: new Proxy({}, { get() { assert.fail("recusa não deve acessar R2"); } }) },
    { storage, id: { name: "erp:" + profile } });
  const send = (path, body = {}, headers = {}) => hub.handle(path, new Request("https://internal" + path, {
    method: "POST", headers: { "x-erp-profile": profile, ...headers }, body: JSON.stringify(body),
  }));
  const snapshot = at => m.erpPartsStateOf(profile, [{ module_id: "erp", enabled: 1, revision: "1", delivered_revision: "0" }], at).snapshot;
  return { m, lite, storage, kv, send, snapshot, profile, sqlCalls: () => sqlCalls };
}

test("recusa sem fotografia mantém objeto novo sem esquema e objeto instalado sem gravações", async t => {
  const f = await object(t), loads = f.m.engineLoads();
  const refused = async () => {
    const before = f.sqlCalls();
    for (const name of ["erp_catalog_seller_options", "erp_catalog_seller_save", "erp_platform_task_claim"]) {
      const response = await f.send("/erp-rpc/" + name, {}, { "x-erp-system": "1" });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "erp_parts_unavailable");
    }
    assert.equal(f.sqlCalls(), before);
    assert.equal(f.kv.get("erp_parts"), undefined);
    assert.equal(await f.storage.getAlarm(), null);
  };
  await refused();
  assert.deepEqual(f.lite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'erp_%'").all(), []);
  assert.equal(f.m.engineLoads(), loads);
  assert.equal((await f.send("/erp-ping")).status, 200);
  assert.ok(f.m.engineLoads() > loads);
  const tables = ["erp_catalog__record", "erp_catalog__seller", "erp_catalog__command", "erp_platform__task"];
  const rows = () => Object.fromEntries(tables.map(table => [table, f.lite.prepare(`SELECT * FROM ${table}`).all()]));
  const before = rows();
  assert.deepEqual(before, Object.fromEntries(tables.map(table => [table, []])));
  await refused();
  assert.deepEqual(rows(), before);
});

test("RPC desconhecida só alcança 404 depois de autorização válida; RPC de tarefa continua operacional", async t => {
  const f = await object(t), at = Date.now();
  t.mock.method(Date, "now", () => at);
  const path = "/erp-rpc/erp_nao_existe_de_jeito_nenhum";
  assert.equal((await f.send(path)).status, 503);
  const { parts, ...partsControl } = f.snapshot(at);
  const headers = { "x-erp-identity": f.m.encodeIdentity({ actor: null, people: null, parts, partsControl }) };
  const unknown = await f.send(path, {}, headers);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { code: "PGRST202", message: "erp_rpc_unknown:erp_nao_existe_de_jeito_nenhum", details: null, hint: null });
  const task = await f.send("/erp-rpc/erp_platform_task_claim", { p_lease: crypto.randomUUID(), p_purposes: ["company_export"] },
    { ...headers, "x-erp-system": "1" });
  assert.equal(task.status, 200);
  assert.deepEqual(await task.json(), { scope: "platform_task", data_mode: "erp_native", task: null });
});

test("renovação real atualiza emissão e vencimento juntos sem migrar nem antecipar alarme", async t => {
  const f = await object(t), start = Date.now(); let now = start;
  t.mock.method(Date, "now", () => now);
  const loads = f.m.engineLoads(), first = f.snapshot(now);
  assert.equal(first.issued_at, start);
  assert.equal((await f.send("/erp-parts", first)).status, 200);
  assert.equal(await f.storage.getAlarm(), start + 1_000);
  await f.storage.setAlarm(start + 3_600_000);
  now += 300_000;
  const renewed = f.snapshot(now);
  assert.deepEqual(renewed, { ...first, issued_at: start + 300_000, expires_at: start + 660_000 });
  // A expectativa antiga produziria duração de onze minutos e seria inválida.
  assert.equal(f.m.readErpPartsSnapshot({ ...first, expires_at: renewed.expires_at }, f.profile), null);
  assert.equal((await f.send("/erp-parts", renewed)).status, 200);
  assert.deepEqual(f.kv.get("erp_parts"), renewed);
  assert.equal(await f.storage.getAlarm(), start + 3_600_000);
  assert.equal(f.sqlCalls(), 0);
  assert.equal(f.m.engineLoads(), loads);
});

test("cron real renova após cinco minutos, confirma desligamento e deixa área já desligada intacta", async t => {
  const on = await object(t), off = await object(t), f = fixture(t);
  const start = Date.now(); let now = start;
  t.mock.method(Date, "now", () => now);
  f.db.exec("CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL)");
  for (const [area, enabled] of [[on, 1], [off, 0]]) {
    f.mark(area.profile); f.save(area.profile, "erp", enabled);
  }
  const delivered = [], objects = new Map([on, off].map(area => ["erp:" + area.profile, area]));
  const env = {
    DB: { prepare(sql) { return { bind(...args) {
      const statement = f.db.prepare(sql);
      return {
        all: async () => ({ results: statement.all(...args) }),
        run: async () => statement.run(...args),
      };
    } }; } },
    COORDINATOR: {
      idFromName: name => name,
      get: name => ({ fetch: (url, init) => {
        const snapshot = JSON.parse(init.body);
        delivered.push(snapshot);
        return objects.get(name).send(new URL(url).pathname, snapshot);
      } }),
    },
  };
  const loads = on.m.engineLoads();
  assert.equal(await on.m.wakeErpAreas(env, now), 2);
  const first = on.kv.get("erp_parts"), stopped = off.kv.get("erp_parts");
  assert.deepEqual(first, on.snapshot(start));
  assert.equal(stopped.parts.customers, false);
  assert.equal(await on.storage.getAlarm(), start + 1_000);
  assert.equal(await off.storage.getAlarm(), null);
  const planned = start + 3_600_000;
  await on.storage.setAlarm(planned);

  now += 300_000; delivered.length = 0;
  assert.equal(await on.m.wakeErpAreas(env, now), 1);
  const renewed = { ...first, issued_at: now, expires_at: now + 360_000 };
  assert.deepEqual(delivered, [renewed]);
  assert.deepEqual(on.kv.get("erp_parts"), renewed);
  assert.deepEqual(off.kv.get("erp_parts"), stopped);
  assert.equal(await on.storage.getAlarm(), planned);

  f.save(on.profile, "erp", 0);
  now += 300_000; delivered.length = 0;
  assert.equal(await on.m.wakeErpAreas(env, now), 1);
  assert.deepEqual(delivered, [{ ...renewed, revision: "2", issued_at: now,
    expires_at: now + 360_000, parts: { ...first.parts, customers: false } }]);
  assert.deepEqual(on.kv.get("erp_parts"), delivered[0]);
  assert.deepEqual(off.kv.get("erp_parts"), stopped);
  for (const area of [on, off]) {
    assert.equal(await area.storage.getAlarm(), null);
    assert.equal(area.sqlCalls(), 0);
  }
  assert.ok(f.db.prepare("SELECT * FROM profile_erp_revision").all()
    .every(row => row.revision === row.delivered_revision));
  assert.equal(on.m.engineLoads(), loads);
  now += 300_000; delivered.length = 0;
  assert.equal(await on.m.wakeErpAreas(env, now), 0);
  assert.deepEqual(delivered, []);
});
