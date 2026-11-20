// Revisão de acesso, achado M1: escrita administrativa do Bling já gravada não
// volta como erro por causa de uma revisão de partes que chegou depois. A
// reconferência tardia continua valendo para leitura (não começa trabalho novo).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";
import { createBlingApi } from "../../../src/erp/bling/operations.ts";
import { createBlingControl } from "../../../src/erp/bling/control.ts";
import { handleBlingOperation } from "../../../src/erp/bling/assembly.ts";
import { normalizeErpParts, ERP_PARTS_TTL_MS } from "../../../src/erp/parts.ts";
import { applyErpPartsSnapshot } from "../../../src/erp/parts-control.ts";
import { encodeIdentity, IDENTITY_HEADER } from "../../../src/erp/engine/identity.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { FakeClock } from "./fake-bling.mjs";
import { sqliteStorage } from "./contract-checks.mjs";

const area = "escrita-area", actorId = "b7100000-0000-4000-8000-000000000001", sessionId = "b7100000-0000-4000-8000-000000000002";
const hashA = "a".repeat(64);
const hash = async bytes => createHash("sha256").update(bytes).digest("hex");
const parts = normalizeErpParts({ products: false, sales: false, purchases: false, stock: false, finance: false, fiscal: false, billing: false, pos: false });
const access = { reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } };

/** Motor do Bling com portas falsas; `current` é a fotografia de partes guardada no objeto. */
function fixture() {
  const db = new DatabaseSync(":memory:"), clock = new FakeClock();
  const storage = sqliteStorage(db); migrate(storage);
  let sequence = 0;
  const randomId = () => `escrita-id-${++sequence}`;
  const identity = revision => ({ actor: { user_id: actorId, name: null, email: null, erp_role: "admin", session_id: sessionId, aal: "aal2", verified_factor: true, is_agent: false },
    people: [], parts, partsControl: { profile: area, revision, expires_at: clock.now() + 120000 } });
  const ctx = revision => ({ profile: area, origin: "app", clock, identity: identity(revision) });
  const driver = storageDriver(storage);
  const control = createBlingControl({ db: driver, databaseSize: () => storage.sql.databaseSize, randomId, profile: area });
  db.prepare(`INSERT INTO wb_bling_control(revision,authorization_revision,credential_revision,collect_enabled,state,account_id,account_public,selection,permissions,approved_by,approved_at,approval_hash,app_configured,credential_status,credential_expires_at,credential_scopes,updated_at)
    VALUES(1,1,1,1,'ready','company',?,'[]',?,?,?,?,1,'ready',?,'[]',?)`).run(JSON.stringify({ id: "company", name: "Empresa de teste", confirmed_at: clock.iso() }),
    JSON.stringify(access), actorId, clock.now(), hashA, clock.now() + 3600000, clock.now());
  const state = { current: "1" };
  const calls = { disconnect: 0, purge: 0 };
  const unsupported = () => { throw new Error("Porta inesperada."); };
  const deps = {
    db: driver, databaseSize: () => storage.sql.databaseSize, randomId, hash,
    readParts: async () => ({ profile: area, revision: state.current, expires_at: clock.now() + 120000, parts }), revalidate: async () => {}, data: { get: unsupported },
    authorization: {
      // O cofre remove a credencial; enquanto isso chega outra entrega de partes.
      disconnect: async () => { calls.disconnect++; state.current = "2"; return { configured: false, authorized: false, revision: "2", expires_at: null, scopes: [], uncertain: false }; },
    },
    collection: {},
    archive: {
      purgePreview: () => ({ generation: "1", preview_hash: hashA, counts: { records: 0 }, files: 0, blocked_references: 0 }),
      purge: async (context, input) => {
        calls.purge++;
        const receipt = control.finish(context, "erp_bling_purge_apply", input, context.authorization.request_hash, { references: { work_id: "purge-1" } });
        state.current = "2";
        return { work_id: "purge-1", receipt };
      },
    },
  };
  const api = createBlingApi(deps, { profile: area, resources: [], resource_version: "test-v1" });
  return { db, ctx, api, calls, state, close: () => db.close() };
}

test("M1: desconectar já gravado devolve o recibo mesmo com revisão de partes nova; repetir não executa de novo", async () => {
  const f = fixture();
  try {
    const input = { command_id: "disconnect-1", expected_revision: "1" };
    const done = await f.api.execute(f.ctx("1"), "erp_bling_disconnect", input);
    assert.equal(done.receipt.state, "committed");
    assert.equal(done.receipt.command_id, "disconnect-1");
    assert.equal(done.configuration.credential.configured, false);
    // O próximo pedido carrega a fotografia nova e recebe o mesmo recibo.
    const replay = await f.api.execute(f.ctx("2"), "erp_bling_disconnect", input);
    assert.deepEqual(replay.receipt, done.receipt);
    assert.equal(f.calls.disconnect, 1);
    // A fotografia antiga continua sem começar trabalho novo.
    await assert.rejects(f.api.execute(f.ctx("1"), "erp_bling_disable", { command_id: "disable-1", expected_revision: done.configuration.revision }),
      error => error.code === "BLING_REVISION_CONFLICT");
  } finally { f.close(); }
});

test("M1: apagamento já reservado devolve o recibo mesmo com revisão de partes nova; repetir não apaga de novo", async () => {
  const f = fixture();
  try {
    const input = { command_id: "purge-1", expected_revision: "1", scope: { all: true, entities: [] }, generation: "1", preview_hash: hashA, confirmed: true };
    const done = await f.api.execute(f.ctx("1"), "erp_bling_purge_apply", input);
    assert.equal(done.work_id, "purge-1");
    assert.equal(done.receipt.command_id, "purge-1");
    const replay = await f.api.execute(f.ctx("2"), "erp_bling_purge_apply", input);
    assert.deepEqual(replay.receipt, done.receipt);
    assert.equal(f.calls.purge, 1);
  } finally { f.close(); }
});

const identityFor = (now, revision = "1") => ({
  actor: { user_id: actorId, name: null, email: null, erp_role: "admin", session_id: sessionId, aal: "aal2", verified_factor: true, is_agent: false },
  people: [], parts: normalizeErpParts(), partsControl: { profile: area, revision, expires_at: now + ERP_PARTS_TTL_MS },
});

test("M1: a montagem não troca escrita gravada por BLING_DISABLED; leitura continua reconferida", async () => {
  const now = Date.now();
  const context = { profile: area, origin: "app", clock: { now: () => now }, identity: identityFor(now) };
  let reads = 0;
  // A Base está ligada no começo e desligada quando a operação termina.
  const dependencies = { env: {}, storage: {}, profile: area, readParts: async () => (++reads === 1 ? normalizeErpParts() : { ...normalizeErpParts(), customers: false }) };
  const receipt = { command_id: "collect-1", operation: "erp_bling_collect_request", request_hash: hashA, generation: "1", state: "committed",
    committed_at: new Date(now).toISOString(), counts: {}, references: { run_id: "run-1" }, error: null };
  const written = await handleBlingOperation({ context, name: "erp_bling_collect_request", input: { command_id: "collect-1", expected_revision: "1", resource_keys: ["products"] } },
    dependencies, { execute: async () => ({ run_id: "run-1", next_wake: null, receipt }) });
  const body = await written.json();
  assert.equal(written.status, 200, JSON.stringify(body));
  assert.deepEqual(body.receipt, receipt);
  reads = 0;
  const read = await handleBlingOperation({ context, name: "erp_bling_command_get", input: { id: "collect-1" } }, dependencies,
    { execute: async () => ({ phase: "committed", receipt }) });
  assert.equal(read.status, 503);
  assert.equal((await read.json()).error.code, "BLING_DISABLED");
});

async function isolatedHub() {
  const result = await build({ entryPoints: ["src/erp/hub.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
    plugins: [{ name: "motor-falso", setup(b) {
      b.onResolve({ filter: /hub-engine\.ts$/ }, args => ({ path: args.path, namespace: "falso" }));
      b.onLoad({ filter: /.*/, namespace: "falso" }, () => ({ loader: "js", contents: `
        export const ERP_SCHEMA_VERSION = 1;
        export const migrate = () => ({ status: "current" });
        export const handleBlingOperation = (...args) => globalThis.m1Bling(...args);
      ` }));
    } }] });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}
const hub = await isolatedHub();

function kv() {
  const data = new Map();
  let alarm = null;
  const storage = {
    get: async key => data.get(key),
    put: async (key, value) => {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
      else data.set(key, structuredClone(value));
    },
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
    transaction: async fn => fn(storage),
  };
  return storage;
}

test("M1: o hub devolve a escrita com recibo mesmo se a revisão de partes mudou durante a operação; leitura é recusada", async t => {
  t.after(() => { delete globalThis.m1Bling; });
  for (const [name, body, expected] of [
    ["erp_bling_disable", { command_id: "disable-1", expected_revision: "1" }, 200],
    ["erp_bling_status", {}, 409],
  ]) {
    const now = Date.now(), storage = kv();
    let ran = 0;
    globalThis.m1Bling = async () => {
      ran++;
      // Durante a operação, outra aba liga ou desliga um módulo: revisão 2.
      await applyErpPartsSnapshot(storage, area, { profile: area, revision: "2", expires_at: now + ERP_PARTS_TTL_MS, parts: normalizeErpParts() });
      return Response.json({ receipt: { command_id: "disable-1", state: "committed" } });
    };
    const request = new Request(`https://coordinator/erp-bling/operations/${name}`, { method: "POST", body: JSON.stringify(body),
      headers: { "x-erp-profile": area, [IDENTITY_HEADER]: encodeIdentity(identityFor(now)) } });
    const response = await new hub.ErpHub({}, { id: { name: `erp:${area}` }, storage }).handle(`/erp-bling/operations/${name}`, request);
    assert.equal(ran, 1);
    assert.equal(response.status, expected, `${name}: ${await response.clone().text()}`);
    if (expected === 200) assert.equal((await response.json()).receipt.command_id, "disable-1");
    else assert.equal((await response.json()).code, "erp_parts_stale");
  }
});
