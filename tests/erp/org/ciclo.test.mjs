import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createMountedBlingAssembly, runBlingWake } from "../../../src/erp/bling/assembly.ts";
import { BLING_LEGACY_ENTITIES, BLING_ENTITIES, BLING_OPERATION_NAMES } from "../../../src/erp/bling/contracts.ts";
import { BLING_RESOURCES, BLING_XML_RESOURCE } from "../../../src/erp/bling/resources.ts";
import { createBlingVault } from "../../../src/erp/bling/vault.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { nodeDriver } from "../harness/node-driver.mjs";
import { dumpAll, restoreAll } from "../../../src/erp/engine/dump.ts";
import { ARCHIVE_PURGE_DELETE_TRIGGERS } from "../../../src/erp/bling/purge.ts";
import { FakeBling, FakeClock } from "./fake-bling.mjs";
import { FakeOAuth } from "./fake-oauth.mjs";
import { sqliteStorage, assertCollectionWrite, assertOperationalUnchanged, operationalSnapshot, assertNoSecrets, tableSnapshot } from "./contract-checks.mjs";

const opaque = () => randomBytes(32).toString("hex");
const profile = "ciclo", publicOrigin = "https://installation.invalid";
const confirmed = () => [...BLING_RESOURCES, BLING_XML_RESOURCE].map(resource => resource.confirmation === "nao_confirmado" ? resource : ({ ...resource, confirmation: "oficial_confirmado", officialEvidence: { url: "https://official.invalid/simulated", checked_at: "2026-11-19T12:00:00.000Z", scopes_checked: true, identity_checked: true, limits_checked: true } }));
const hasCode = code => error => error?.code === code;
function fiscalXml() {
  const stem = "3526111234567800019555001000000001112345678";
  let weight = 2, sum = 0;
  for (let i = stem.length - 1; i >= 0; i--) { sum += Number(stem[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const digit = 11 - sum % 11, key = stem + (digit >= 10 ? 0 : digit);
  return { key, text: `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${key}"><ide><tpAmb>1</tpAmb><mod>55</mod><cUF>35</cUF><serie>1</serie><nNF>1</nNF><tpEmis>1</tpEmis><cNF>12345678</cNF><cDV>${key[43]}</cDV><dhEmi>2026-11-19T12:00:00-03:00</dhEmi></ide><emit><CNPJ>12345678000195</CNPJ></emit></infNFe></NFe>` };
}
async function fixture(keys = ["contacts"], extra = {}) {
  const clock = new FakeClock(), db = new DatabaseSync(":memory:"), d1 = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON"); d1.exec("CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const storage = sqliteStorage(db); migrate(storage);
  const baseline = operationalSnapshot(db), writes = [], hooks = {}, savedCiphertexts = new Map(), secrets = [], objects = new Map();
  const driver = nodeDriver(db);
  const guarded = { exec(sql, ...params) {
    // A única exceção DDL é a suspensão transacional exata dos DELETE imutáveis.
    if (/^(?:DROP|CREATE) TRIGGER/i.test(sql.trim())) {
      const matched = Object.keys(ARCHIVE_PURGE_DELETE_TRIGGERS).find(name => sql.includes(name));
      assert.ok(matched, "DDL limitada à allowlist de apagamento");
    } else writes.push(...assertCollectionWrite(sql));
    hooks.sql?.(sql, params);
    const result = driver.exec(sql, ...params); hooks.afterSql?.(sql, params); return result;
  }, transaction: fn => driver.transaction(fn) };
  const cipher = { async seal(value) { const id = opaque(); savedCiphertexts.set(id, structuredClone(value)); return id; }, async unseal(id) { return structuredClone(savedCiphertexts.get(id)); } };
  const vault = createBlingVault({ DB: { prepare(sql) { return { bind(...params) { return { first: async () => d1.prepare(sql).get(...params) ?? null }; } }; } } }, cipher);
  const fake = new FakeBling({ clock }), oauth = new FakeOAuth({ clock }), cookies = [];
  let parts = normalizeErpParts({ products: false, sales: false, purchases: false, finance: false, fiscal: false, stock: false, billing: false, pos: false });
  const actor = { user_id: crypto.randomUUID(), session_id: crypto.randomUUID(), name: "Dono simulado", email: null, erp_role: "admin", aal: "aal2", is_agent: false, verified_factor: true };
  const snapshot = () => ({ profile, revision: "1", expires_at: clock.now() + 120_000, parts });
  const ctx = { profile, origin: "app", clock, identity: { actor, people: [], parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } }, response: { setCookie: cookie => cookies.push(cookie) } };
  const xml = fiscalXml();
  for (const resource of BLING_RESOURCES.filter(r => r.path)) fake.resource(resource.path, [{ id: "7", nome: "Observado", ...(resource.entity === "nfe" ? { chaveAcesso: xml.key, tipo: 1, situacao: 5, numero: "1", serie: "1" } : {}) }]);
  fake.beforeRequest(call => {
    hooks.request?.(call);
    if (call.path === "/produtos" && call.query.criterio === "4") fake.queue({ path: call.path, data: { data: [] } });
    if (call.path === "/estoques/saldos") fake.queue({ path: call.path, body: '{"data":[{"produto":{"id":"7"},"saldoFisicoTotal":12.0000000000000001,"depositos":[{"id":"3","saldoFisico":12.0000000000000001}]}]}' });
    if (call.path.startsWith("/nfe/documento/")) fake.queue({ path: call.path, data: { data: [{ nome: "nota.xml", conteudo: gzipSync(xml.text).toString("base64") }] } });
  });
  let size = storage.sql.databaseSize;
  const options = { profile, db: guarded, databaseSize: () => size, readParts: async () => snapshot(),
    session: async context => { if (hooks.session) return hooks.session(context); return { ...structuredClone(context.identity), parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } }; },
    vault, provider: { exchange: oauth.exchange, refresh: async input => { hooks.refresh?.(); return oauth.refresh(input); } },
    accountProof: { evidence: { url: "https://official.invalid/simulated", checked_at: clock.iso(), read_only: true }, identify: async () => ({ id: oauth.accountId, name: "Conta simulada", confirmed_at: clock.iso() }) },
    publicOrigin, authorizationEndpoint: "https://oauth.invalid/authorize", readScopes: [],
    fetch: fake.fetch, baseUrl: fake.baseUrl, resources: confirmed(),
    media: { put: async (key, bytes) => { hooks.put?.(); objects.set(key, Uint8Array.from(bytes)); hooks.afterPut?.(); }, get: async key => { hooks.get?.(); const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null; }, delete: async key => { hooks.delete?.(); objects.delete(key); } }, ...extra };
  let mounted = createMountedBlingAssembly(options);
  const api = async (name, input = {}, context = ctx) => { try { if (context === ctx) context.identity.partsControl.expires_at = clock.now() + 120_000; return await mounted.api.execute(context, name, input); } catch (error) { error.message = `${name}: ${error.code}`; throw error; } };
  const status = () => api("erp_bling_status");
  const command = async (name, input = {}) => api(name, { command_id: crypto.randomUUID(), expected_revision: (await status()).configuration.revision, ...input });
  async function authorize() {
    const start = await command("erp_bling_oauth_start");
    const state = new URL(start.authorization_url).searchParams.get("state"), browser_nonce = cookies.at(-1).value, code = opaque();
    secrets.push(state, browser_nonce, code);
    return mounted.api.callback(ctx, { state, browser_nonce, code, callback_url: `${publicOrigin}/api/public/erp-bling/${profile}/callback` });
  }
  async function enable() { return command("erp_bling_enable", { warning_confirmed: true, checklist_hash: "a".repeat(64) }); }
  async function start() {
    await command("erp_bling_configure", { selections: keys.map(key => ({ key, selected: true, from: "2026-11-19", to: "2026-11-19" })), daily_call_limit: 20000,
      access: { reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } }, ai_disclosure_acknowledged: false });
    const application = { client_id: opaque(), client_secret: opaque() }; secrets.push(...Object.values(application));
    await command("erp_bling_app_save", application); await enable();
    assert.equal((await authorize()).state, "authorized");
  }
  async function tick() {
    ctx.identity.partsControl.expires_at = clock.now() + 120_000;
    const internal = { ...ctx, origin: "internal", identity: { actor: null, people: [], parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } } };
    const due = await mounted.wake.nextWake(internal);
    if (due !== null && due > clock.now()) clock.set(due);
    const before = fake.callCount;
    const result = await mounted.wake.runOne(internal, { deadline: clock.now() + 4000, nextOperationalAt: null, maxGets: 1 });
    assert.ok(fake.callCount - before <= 1, "um GET por acordada"); clock.advance(1000); return result;
  }
  async function until(predicate, max = 600, tolerated = []) { let lastResult; for (let i = 0; i < max; i++) { if (await predicate()) return; const r = lastResult = await tick(); if (r.error && ![...tolerated, "BLING_RATE_WAIT", "BLING_RETRY_WAIT", "BLING_AUTH_REQUIRED", "BLING_REVISION_CONFLICT"].includes(r.error.code)) throw new Error(JSON.stringify({result:r,last:fake.calls.at(-1),pending:db.prepare("SELECT resource,kind,phase,error_code FROM wb_bling_unit WHERE error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 3").all()})); } assert.ok(await predicate(), JSON.stringify({ message: "progresso limitado esperado", lastResult, control: db.prepare("SELECT state,collect_enabled,credential_status,credential_revision,next_allowed_at FROM wb_bling_control").all(), entities: db.prepare("SELECT DISTINCT entity FROM origin_sync__raw_record").all(), objects: objects.size, units: db.prepare("SELECT resource,kind,phase,error_code,progress FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded') LIMIT 5").all(), calls: fake.callCount, clock: clock.now(), checkpoints: db.prepare("SELECT resource,checkpoint FROM origin_sync__resource_state").all().map(row => { const cp=JSON.parse(row.checkpoint); return { resource:row.resource, served:cp.last_served_at, recent:!!cp.recentPassCompletedAt, history:!!cp.historyPassCompletedAt, all:!!cp.unfilteredPassCompletedAt, due:cp.not_before }; }), fiscal: db.prepare("SELECT state,next_attempt_at,last_checked_at FROM origin_fiscal__source").all() })); }
  function verify() {
    for (const envelope of savedCiphertexts.values()) if (envelope.value.credential) secrets.push(envelope.value.credential.access_token, envelope.value.credential.refresh_token);
    assertNoSecrets(tableSnapshot(db), secrets); assertNoSecrets(fake.calls, secrets); assertNoSecrets(oauth.calls, secrets);
    assertOperationalUnchanged(db, baseline); fake.assertReadOnly(); assert.equal(fake.mutations, 0);
    db.close(); d1.close();
  }
  return { db, storage, options, ctx, clock, fake, oauth, api, command, status, start, enable, authorize, tick, until, hooks, objects, secrets, verify,
    mounted: () => mounted, restart: () => { mounted = createMountedBlingAssembly(options); }, setSize: value => { size = value; }, setParts: value => { parts = value; } };
}

test("montagem real: configurar, ligar, OAuth separado, 18 entidades, XML e continuidade sem efeitos operacionais", async () => {
  const f = await fixture([...BLING_LEGACY_ENTITIES, "fiscal_xml"]);
  try {
    assert.equal((await f.status()).state, "off"); assert.equal(f.fake.callCount, 0);
    await f.start();
    const requested = await f.command("erp_bling_collect_request", { resource_keys: [...BLING_LEGACY_ENTITIES] });
    assert.equal(requested.receipt.state, "committed");
    await f.until(() => f.db.prepare("SELECT count(DISTINCT entity) n FROM origin_sync__raw_record").get().n === 17 && f.objects.size > 0);
    f.clock.advance(86_400_000);
    await f.until(() => f.db.prepare("SELECT count(DISTINCT entity) n FROM origin_sync__raw_record").get().n === 18);
    assert.equal(f.db.prepare("SELECT count(DISTINCT entity) n FROM origin_sync__raw_record").get().n, 18);
    await f.until(() => f.db.prepare("SELECT count(*) n FROM origin_fiscal__revision").get().n > 0);
    await f.until(() => f.db.prepare("SELECT state FROM erp_sync__run WHERE id=?").get(requested.run_id)?.state === "done", 2500);
    const listed = await f.api("erp_bling_xml_list", { limit: 50 }); assert.ok(listed.items.length);
    const original = await f.api("erp_bling_record_get", { entity: "contacts", id: "7" });
    f.fake.setDetail("/contatos", "7", { id: "7", nome: "Alterado" });
    await f.until(() => f.db.prepare("SELECT payload FROM origin_sync__raw_record WHERE entity='contacts' AND source_id='7'").get()?.payload.includes("Alterado"), 2000);
    const changed = await f.api("erp_bling_record_get", { entity: "contacts", id: "7" }); assert.ok(BigInt(changed.raw.version) > BigInt(original.raw.version));
    const prior = await f.api("erp_bling_record_get", { entity: "contacts", id: "7", version: original.raw.version }); assert.equal(prior.raw.payload_text, original.raw.payload_text);
    assert.ok(f.oauth.calls.every(call => ["exchange", "refresh"].includes(call.operation)));
  } finally { f.verify(); }
});

test("XML selecionado isoladamente arquiva fonte existente, retoma espera e não recolhe JSON fiscal", async () => {
  const f = await fixture(["nfe"]);
  try {
    await f.start();
    await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='nfe'").get());
    assert.equal(f.objects.size, 0, "coleta de NF-e não implica seleção de XML");
    const records = f.db.prepare("SELECT * FROM origin_sync__raw_record ORDER BY entity,source_id").all();
    const checkpoints = f.db.prepare("SELECT resource,checkpoint,checkpoint_version FROM origin_sync__resource_state ORDER BY resource").all();
    const config = (await f.status()).configuration;
    await f.command("erp_bling_configure", { selections: [{ key: "fiscal_xml", selected: true, from: null, to: null }],
      daily_call_limit: config.daily_call_limit, access: config.access, ai_disclosure_acknowledged: false });
    await f.enable();
    await f.command("erp_bling_collect_request", { resource_keys: ["fiscal_xml"] });
    const before = f.fake.callCount;
    f.fake.queue({ path: `/nfe/documento/${fiscalXml().key}`, status: 404 });
    await f.tick();
    assert.equal(f.fake.callCount, before + 1);
    const retryAt = f.db.prepare("SELECT next_attempt_at FROM origin_fiscal__source WHERE entity='nfe'").get().next_attempt_at;
    assert.ok(retryAt > f.clock.now(), "arquivo ausente conserva espera durável");
    f.restart();
    const internal = { ...f.ctx, origin: "internal" };
    assert.equal(await f.mounted().wake.nextWake(internal), retryAt);
    await f.until(() => f.db.prepare("SELECT count(*) n FROM origin_fiscal__revision").get().n === 1, 20);
    assert.equal(f.objects.size, 1);
    const calls = f.fake.calls.slice(before);
    assert.equal(calls.length, 2, "um GET falho e um GET retomado, sem recolher a fonte");
    assert.ok(calls.every(call => call.path === `/nfe/documento/${fiscalXml().key}` && call.method === "GET"));
    assert.deepEqual(f.db.prepare("SELECT * FROM origin_sync__raw_record ORDER BY entity,source_id").all(), records);
    assert.deepEqual(f.db.prepare("SELECT resource,checkpoint,checkpoint_version FROM origin_sync__resource_state WHERE resource<>'fiscal_xml' ORDER BY resource").all(), checkpoints);
    const revisitAt = f.db.prepare("SELECT next_attempt_at FROM origin_fiscal__source WHERE entity='nfe'").get().next_attempt_at;
    assert.ok(revisitAt > f.clock.now());
    assert.equal(await f.mounted().wake.nextWake({ ...f.ctx, origin: "internal" }), revisitAt);
  } finally { f.verify(); }
});

test("429, 401/refresh, desligar/religar, mesma conta, outra conta e teto conservam acervo/checkpoint", async () => {
  const f = await fixture();
  try {
    await f.start(); f.fake.queue({ status: 429, retryAfter: 60 }); const rate = await f.tick(); assert.equal(rate.error.code, "BLING_RATE_WAIT");
    const calls = f.fake.callCount; await f.command("erp_bling_disable"); await f.tick(); assert.equal(f.fake.callCount, calls);
    await f.enable(); f.fake.queue({ status: 401 }); await f.tick(); await f.until(() => f.oauth.calls.some(call => call.operation === "refresh"));
    await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='contacts'").get());
    const record = await f.api("erp_bling_record_get", { entity: "contacts", id: "7" });
    await f.authorize(); assert.equal((await f.api("erp_bling_record_get", { entity: "contacts", id: "7" })).raw.version, record.raw.version);
    f.oauth.accountId = "different-account"; assert.equal((await f.authorize()).error.code, "BLING_ACCOUNT_MISMATCH"); f.oauth.accountId = record.raw.identity.account_id;
    await f.authorize(); f.setSize(8_000_000_000); await f.until(async () => (await f.status()).state === "blocked_capacity");
    const stopped = f.fake.callCount; await f.tick(); assert.equal(f.fake.callCount, stopped);
  } finally { f.verify(); }
});

for (const boundary of ["reservation", "fetching", "list", "detail", "before_commit", "lost_commit_response", "after_http"]) {
  test(`queda em ${boundary}: reconstrução da montagem retoma sem duplicar conteúdo ou checkpoint`, async () => {
    const f = await fixture();
    try {
      await f.start();
      const collection = f.mounted().collection;
      const method = boundary === "reservation" ? "reserve" : boundary === "fetching" ? "markFetching" : "commitBatch";
      const original = collection[method].bind(collection); let interrupted = false, committedInput;
      if (boundary === "after_http") {
        const originalFetch = f.options.fetch;
        f.options.fetch = async (...args) => { const response = await originalFetch(...args); if (!interrupted) { interrupted = true; throw new Error("SIMULATED_CRASH_AFTER_HTTP"); } return response; };
        f.restart();
      } else collection[method] = (...args) => {
        const kind = args[1]?.unit?.kind;
        const applies = !interrupted && (boundary !== "list" || kind === "list") && (boundary !== "detail" || kind === "detail");
        if (applies && ["before_commit", "list", "detail"].includes(boundary)) { interrupted = true; throw new Error("SIMULATED_CRASH_BEFORE_COMMIT"); }
        const result = original(...args);
        if (applies) { interrupted = true; if (boundary === "lost_commit_response") committedInput = args; throw new Error("SIMULATED_CRASH_AFTER_DURABLE_WRITE"); }
        return result;
      };
      for (let i = 0; i < 8 && !interrupted; i++) await f.tick();
      assert.equal(interrupted, true);
      if (committedInput) {
        const checkpoint = f.db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource=?").get(committedInput[1].unit.resource_key);
        const replay = original(...committedInput); assert.equal(replay.state, "committed");
        assert.deepEqual(f.db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource=?").get(committedInput[1].unit.resource_key), checkpoint);
        assert.throws(() => original(committedInput[0], { ...committedInput[1], counts: { different: 1 } }), hasCode("BLING_COMMAND_CONFLICT"));
      }
      f.restart();
      await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='contacts'").get());
      assert.equal(f.db.prepare("SELECT count(*) n FROM origin_sync__raw_record WHERE entity='contacts'").get().n, 1);
      assert.equal(f.db.prepare("SELECT count(*) n FROM erp_document_mirror__source_version WHERE entity='contacts'").get().n, 0);
    } finally { f.verify(); }
  });
}

test("apagamento retoma perda de resposta R2/SQL, mantém guardas e replay sem ressurreição", async () => {
  const f = await fixture(["nfe", "fiscal_xml"]);
  try {
    await f.start();
    await f.until(() => f.db.prepare("SELECT count(*) n FROM origin_fiscal__revision").get().n === 1);
    const guards = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    const generation = (await f.status()).configuration.generation;
    const preview = await f.api("erp_bling_purge_preview", { scope: { all: true, entities: [] }, generation });
    const input = { command_id: crypto.randomUUID(), expected_revision: (await f.status()).configuration.revision, generation, scope: { all: true, entities: [] }, preview_hash: preview.preview_hash, confirmed: true };
    const result = await f.api("erp_bling_purge_apply", input); assert.ok(result.work_id);
    let sqlCrash = false, r2Crash = false;
    f.hooks.afterSql = sql => { if (!sqlCrash && /^DELETE FROM ["`]?origin_sync__raw_record/.test(sql)) { sqlCrash = true; throw new Error("SIMULATED_PURGE_SQL_CRASH"); } };
    f.hooks.delete = () => { if (!r2Crash) { r2Crash = true; throw new Error("SIMULATED_R2_DELETE_CRASH"); } };
    const calls = f.fake.callCount;
    await f.until(async () => (await f.api("erp_bling_command_get", { id: input.command_id })).phase === "committed", 400, ["BLING_RESPONSE_INVALID"]);
    assert.equal(sqlCrash, true); assert.equal(r2Crash, true); assert.equal(f.fake.callCount, calls);
    assert.equal(f.objects.size, 0);
    for (const table of ["origin_sync__raw_record", "erp_document_mirror__source_version", "wb_bling_record_version", "origin_fiscal__source", "origin_fiscal__object", "origin_fiscal__revision", "origin_fiscal__item"]) assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
    assert.deepEqual(f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), guards);
    const replay = await f.api("erp_bling_purge_apply", input);
    assert.equal(replay.work_id, result.work_id); assert.equal(replay.receipt.state, "committed");
    assert.equal(f.objects.size, 0); assert.equal(f.fake.callCount, calls);
    assert.equal((await f.status()).configuration.collect_enabled, false);
  } finally { f.verify(); }
});

test("backup/restauração suspende coleta; sessão e área são revalidadas; alarme operacional tem prioridade", async () => {
  const f = await fixture();
  try {
    await f.start(); await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record").get());
    const dump = dumpAll(f.storage); assertNoSecrets(dump.files.map(file => file.body).join("\n"), f.secrets);
    restoreAll(f.storage, dump.manifest, new Map(dump.files.map(file => [file.table, file.body]))); f.restart();
    const count = f.fake.callCount; await f.tick(); assert.equal(f.fake.callCount, count);
    assert.equal((await f.status()).configuration.collect_enabled, false);
    const wrongArea = { ...f.ctx, profile: "outra" };
    await assert.rejects(f.api("erp_bling_records_list", { entity: "contacts" }, wrongArea), hasCode("BLING_SCOPE_REQUIRED"));
    const reader = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, erp_role: "consulta" } } };
    await assert.rejects(f.api("erp_bling_disable", { command_id: crypto.randomUUID(), expected_revision: "1" }, reader), hasCode("BLING_ADMIN_REQUIRED"));
    let ran = false;
    const wake = { nextWake: async () => f.clock.now(), runOne: async () => { ran = true; return { worked: true, requests: 1, nextWake: null }; } };
    const deps = { env: {}, storage: {}, readParts: async () => f.ctx.identity.parts };
    await runBlingWake(profile, deps, { eligible: false, nextOperationalAt: null, clock: f.clock }, wake);
    await runBlingWake(profile, deps, { eligible: true, nextOperationalAt: f.clock.now() + 1200, clock: f.clock }, wake);
    assert.equal(ran, false);
  } finally { f.verify(); }
});

for (const boundary of ["r2_put", "r2_verify", "manifest"]) {
  test(`XML: queda em ${boundary} retoma journal sem repetir GET nem criar outro manifesto`, async () => {
    const f = await fixture(["nfe", "fiscal_xml"]);
    try {
      await f.start(); let interrupted = false;
      const crash = () => { if (!interrupted) { interrupted = true; throw new Error("SIMULATED_XML_CRASH"); } };
      if (boundary === "r2_put") f.hooks.afterPut = crash;
      if (boundary === "r2_verify") f.hooks.get = crash;
      if (boundary === "manifest") f.hooks.sql = sql => { if (/INSERT INTO origin_fiscal__revision/.test(sql)) crash(); };
      for (let i = 0; i < 40 && !interrupted; i++) await f.tick();
      assert.equal(interrupted, true); const calls = f.fake.calls.filter(call => call.path.startsWith("/nfe/documento/")).length;
      f.restart(); await f.until(() => f.db.prepare("SELECT count(*) n FROM origin_fiscal__revision").get().n === 1);
      assert.equal(f.fake.calls.filter(call => call.path.startsWith("/nfe/documento/")).length, calls);
      assert.equal(f.objects.size, 1);
      assert.equal(f.db.prepare("SELECT count(*) n FROM origin_fiscal__object").get().n, 1);
    } finally { f.verify(); }
  });
}

test("desligamento entre GET e gravação invalida resultado; religar não adota nem perde a página", async () => {
  const f = await fixture();
  try {
    await f.start(); let interrupted = false;
    const fetch = f.options.fetch;
    f.options.fetch = async (...args) => { const response = await fetch(...args); if (!interrupted) { interrupted = true; await f.command("erp_bling_disable"); } return response; };
    f.restart(); await f.tick(); assert.equal(interrupted, true);
    assert.equal(f.db.prepare("SELECT count(*) n FROM origin_sync__raw_record").get().n, 0);
    const count = f.fake.callCount; await f.tick(); assert.equal(f.fake.callCount, count);
    await f.enable(); f.restart(); await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='contacts'").get());
  } finally { f.verify(); }
});

test("refresh consumido sem custódia exige reautorização e não repete token rotacionado", async () => {
  const f = await fixture();
  try {
    await f.start(); let interrupted = false;
    const refresh = f.options.provider.refresh;
    f.options.provider.refresh = async input => { const result = await refresh(input); interrupted = true; throw new Error("SIMULATED_REFRESH_RESULT_LOST"); };
    f.restart(); f.fake.queue({ status: 401 }); await f.tick();
    for (let i = 0; i < 10 && !interrupted; i++) await f.tick();
    assert.equal(interrupted, true); assert.equal((await f.status()).configuration.credential.uncertain, true);
    const count = f.oauth.callCount; f.restart(); await f.tick(); await f.tick(); assert.equal(f.oauth.callCount, count);
    f.options.provider.refresh = refresh;
    assert.equal((await f.authorize()).state, "authorized");
    await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='contacts'").get());
  } finally { f.verify(); }
});

test("partição de estoque confirmada com resposta perdida tem recibo e subcursor únicos", async () => {
  const f = await fixture(["products", "stock_balances"]);
  try {
    await f.start(); await f.until(() => !!f.db.prepare("SELECT 1 FROM origin_sync__raw_record WHERE entity='products'").get());
    f.clock.advance(86_400_000);
    const collection = f.mounted().collection, commit = collection.commitBatch.bind(collection); let interrupted = false, args;
    collection.commitBatch = (...input) => { const result = commit(...input); if (!interrupted && input[1].unit.kind === "stock" && input[1].unit.plan.stock_partition === 1) { interrupted = true; args = input; throw new Error("SIMULATED_PARTITION_RESPONSE_LOST"); } return result; };
    for (let i = 0; i < 100 && !interrupted; i++) await f.tick(); assert.equal(interrupted, true);
    const checkpoint = f.db.prepare("SELECT checkpoint,checkpoint_version FROM origin_sync__resource_state WHERE resource='stock_balances'").get();
    assert.equal(commit(...args).state, "committed");
    assert.deepEqual(f.db.prepare("SELECT checkpoint,checkpoint_version FROM origin_sync__resource_state WHERE resource='stock_balances'").get(), checkpoint);
    f.restart(); await f.until(() => f.fake.calls.some(call => call.path === "/estoques/saldos" && call.query.filtroSaldoEstoque === "2"));
    const record = await f.api("erp_bling_record_get", { entity: "stock_balances", id: "7" });
    assert.equal(record.raw.version, "1"); assert.match(record.raw.payload_text, /12\.0000000000000001/);
  } finally { f.verify(); }
});
