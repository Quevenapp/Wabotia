// Correções da revisão do sincronizador, agendador e backup (achados 1, 2, 3,
// 6, 7, 8 e 9). Montagem real com Bling, OAuth, R2 e relógio simulados; nenhuma
// chamada real. Os achados 4 e 5 estão em tests/org-correcoes.test.ts e em
// web/erp/test/receive-bling.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMountedBlingAssembly } from "../../../src/erp/bling/assembly.ts";
import { BLING_RESOURCES, BLING_XML_RESOURCE } from "../../../src/erp/bling/resources.ts";
import { createBlingVault } from "../../../src/erp/bling/vault.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { nodeDriver } from "../harness/node-driver.mjs";
import { dumpAll, restoreAll, readBackup, backupToR2, measureDump, ErpBackupTooLargeError, ErpRestoreBusyError, ERP_LOGICAL_BACKUP_LIMIT_BYTES, archiveIoLiveError } from "../../../src/erp/engine/dump.ts";
import { beginArchiveRestore, endArchiveRestore } from "../../../src/erp/bling/xml.ts";
import { ARCHIVE_PURGE_DELETE_TRIGGERS } from "../../../src/erp/bling/purge.ts";
import { FakeBling, FakeClock } from "./fake-bling.mjs";
import { FakeOAuth } from "./fake-oauth.mjs";
import { sqliteStorage, assertCollectionWrite, assertOperationalUnchanged, operationalSnapshot, assertNoSecrets, tableSnapshot } from "./contract-checks.mjs";

const opaque = () => randomBytes(32).toString("hex");
const profile = "correcoes", publicOrigin = "https://installation.invalid";
const confirmed = () => [...BLING_RESOURCES, BLING_XML_RESOURCE].map(resource => resource.confirmation === "nao_confirmado" ? resource : ({ ...resource, confirmation: "oficial_confirmado", officialEvidence: { url: "https://official.invalid/simulated", checked_at: "2026-11-19T12:00:00.000Z", scopes_checked: true, identity_checked: true, limits_checked: true } }));
const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).n);
function fiscalKey() {
  const stem = "3526111234567800019555001000000001112345678";
  let weight = 2, sum = 0;
  for (let i = stem.length - 1; i >= 0; i--) { sum += Number(stem[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const digit = 11 - sum % 11;
  return stem + (digit >= 10 ? 0 : digit);
}
const KEY = fiscalKey();
const NFE = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${KEY}"><ide><tpAmb>1</tpAmb><mod>55</mod><cUF>35</cUF><serie>1</serie><nNF>1</nNF><tpEmis>1</tpEmis><cNF>12345678</cNF><cDV>${KEY[43]}</cDV><dhEmi>2026-11-19T12:00:00-03:00</dhEmi></ide><emit><CNPJ>12345678000195</CNPJ></emit></infNFe></NFe>`;
const event = (type, sequence) => `<evento xmlns="http://www.portalfiscal.inf.br/nfe"><infEvento Id="ID${type}${KEY}${String(sequence).padStart(2, "0")}"><chNFe>${KEY}</chNFe><tpAmb>1</tpAmb><tpEvento>${type}</tpEvento><nSeqEvento>${sequence}</nSeqEvento></infEvento></evento>`;
const envelope = texts => texts.map((text, index) => ({ nome: `documento-${index}.xml`, conteudo: gzipSync(text).toString("base64") }));

async function fixture(keys = ["contacts"]) {
  const clock = new FakeClock(), db = new DatabaseSync(":memory:"), d1 = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON"); d1.exec("CREATE TABLE secrets(id TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const storage = sqliteStorage(db); migrate(storage);
  const baseline = operationalSnapshot(db), hooks = {}, savedCiphertexts = new Map(), secrets = [], objects = new Map();
  const driver = nodeDriver(db);
  const guarded = { exec(sql, ...params) {
    if (/^(?:DROP|CREATE) TRIGGER/i.test(sql.trim())) assert.ok(Object.keys(ARCHIVE_PURGE_DELETE_TRIGGERS).some(name => sql.includes(name)), "DDL limitada à allowlist de apagamento");
    else assertCollectionWrite(sql);
    return driver.exec(sql, ...params);
  }, transaction: fn => driver.transaction(fn) };
  const cipher = { async seal(value) { const id = opaque(); savedCiphertexts.set(id, structuredClone(value)); return id; }, async unseal(id) { return structuredClone(savedCiphertexts.get(id)); } };
  const vault = createBlingVault({ DB: { prepare(sql) { return { bind(...params) { return { first: async () => d1.prepare(sql).get(...params) ?? null }; } }; } } }, cipher);
  const fake = new FakeBling({ clock }), oauth = new FakeOAuth({ clock }), cookies = [];
  const parts = normalizeErpParts({ products: false, sales: false, purchases: false, finance: false, fiscal: false, stock: false, billing: false, pos: false });
  const actor = { user_id: crypto.randomUUID(), session_id: crypto.randomUUID(), name: "Dono simulado", email: null, erp_role: "admin", aal: "aal2", is_agent: false, verified_factor: true };
  const snapshot = () => ({ profile, revision: "1", expires_at: clock.now() + 120_000, parts });
  const ctx = { profile, origin: "app", clock, identity: { actor, people: [], parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } }, response: { setCookie: cookie => cookies.push(cookie) } };
  for (const resource of BLING_RESOURCES.filter(r => r.path)) fake.resource(resource.path, [{ id: "7", nome: "Observado", ...(resource.entity === "nfe" ? { chaveAcesso: KEY, tipo: 1, situacao: 5, numero: "1", serie: "1" } : {}) }]);
  // XML pelo detalhe do simulador: trocar o conjunto não deixa respostas antigas na fila.
  fake.resource("/nfe/documento", []);
  const setDocuments = texts => fake.setDetail("/nfe/documento", KEY, envelope(texts));
  setDocuments([NFE]);
  fake.beforeRequest(call => {
    if (call.path === "/produtos" && call.query.criterio === "4") fake.queue({ path: call.path, data: { data: [] } });
    if (call.path === "/estoques/saldos") fake.queue({ path: call.path, body: '{"data":[]}' });
  });
  const media = { put: async (key, bytes) => { objects.set(key, Uint8Array.from(bytes)); }, get: async key => { const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null; }, delete: async key => { hooks.delete?.(key); objects.delete(key); } };
  const options = { profile, db: guarded, databaseSize: () => storage.sql.databaseSize, readParts: async () => snapshot(),
    session: async context => ({ ...structuredClone(context.identity), parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } }),
    vault, provider: { exchange: oauth.exchange, refresh: oauth.refresh },
    accountProof: { evidence: { url: "https://official.invalid/simulated", checked_at: clock.iso(), read_only: true }, identify: async () => ({ id: oauth.accountId, name: "Conta simulada", confirmed_at: clock.iso() }) },
    publicOrigin, authorizationEndpoint: "https://oauth.invalid/authorize", readScopes: [],
    fetch: fake.fetch, baseUrl: fake.baseUrl, resources: confirmed(), media };
  let mounted = createMountedBlingAssembly(options);
  const api = async (name, input = {}) => { ctx.identity.partsControl.expires_at = clock.now() + 120_000; return mounted.api.execute(ctx, name, input); };
  const status = () => api("erp_bling_status");
  const command = async (name, input = {}) => api(name, { command_id: crypto.randomUUID(), expected_revision: (await status()).configuration.revision, ...input });
  async function authorize() {
    const start = await command("erp_bling_oauth_start");
    const state = new URL(start.authorization_url).searchParams.get("state"), browser_nonce = cookies.at(-1).value, code = opaque();
    secrets.push(state, browser_nonce, code);
    return mounted.api.callback(ctx, { state, browser_nonce, code, callback_url: `${publicOrigin}/api/public/erp-bling/${profile}/callback` });
  }
  const enable = () => command("erp_bling_enable", { warning_confirmed: true, checklist_hash: "a".repeat(64) });
  const configure = async (selections) => {
    const config = (await status()).configuration;
    return command("erp_bling_configure", { selections, daily_call_limit: config.daily_call_limit, access: config.access, ai_disclosure_acknowledged: false });
  };
  async function start() {
    await configure(keys.map(key => ({ key, selected: true, from: "2026-11-19", to: "2026-11-19" })));
    const application = { client_id: opaque(), client_secret: opaque() }; secrets.push(...Object.values(application));
    await command("erp_bling_app_save", application); await enable();
    assert.equal((await authorize()).state, "authorized");
  }
  const internal = () => ({ ...ctx, origin: "internal", identity: { actor: null, people: [], parts, partsControl: { profile, revision: "1", expires_at: clock.now() + 120_000 } } });
  async function tick() {
    const due = await mounted.wake.nextWake(internal());
    if (due !== null && due > clock.now()) clock.set(due);
    const before = fake.callCount;
    const result = await mounted.wake.runOne(internal(), { deadline: clock.now() + 4000, nextOperationalAt: null, maxGets: 1 });
    assert.ok(fake.callCount - before <= 1, "um GET por acordada"); clock.advance(1000); return result;
  }
  async function until(predicate, max = 600, tolerated = []) {
    for (let i = 0; i < max; i++) {
      if (await predicate()) return;
      const r = await tick();
      if (r.error && ![...tolerated, "BLING_RATE_WAIT", "BLING_RETRY_WAIT", "BLING_AUTH_REQUIRED", "BLING_REVISION_CONFLICT"].includes(r.error.code))
        throw new Error(JSON.stringify({ result: r, units: db.prepare("SELECT resource,kind,phase,error_code FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded') LIMIT 5").all() }));
    }
    assert.ok(await predicate(), JSON.stringify({ message: "progresso limitado esperado", units: db.prepare("SELECT resource,kind,phase,error_code FROM wb_bling_unit WHERE phase NOT IN ('committed','superseded') LIMIT 5").all(), objects: objects.size }));
  }
  function verify() {
    for (const value of savedCiphertexts.values()) if (value.value.credential) secrets.push(value.value.credential.access_token, value.value.credential.refresh_token);
    assertNoSecrets(tableSnapshot(db), secrets); assertNoSecrets(fake.calls, secrets);
    assertOperationalUnchanged(db, baseline); fake.assertReadOnly(); assert.equal(fake.mutations, 0);
    db.close(); d1.close();
  }
  async function purge() {
    const current = (await status()).configuration;
    const preview = await api("erp_bling_purge_preview", { scope: { all: true, entities: [] }, generation: current.generation });
    const input = { command_id: crypto.randomUUID(), expected_revision: current.revision, generation: current.generation, scope: { all: true, entities: [] }, preview_hash: preview.preview_hash, confirmed: true };
    await api("erp_bling_purge_apply", input);
    return input;
  }
  return { db, storage, options, ctx, clock, fake, oauth, api, command, status, start, enable, configure, authorize, tick, until, hooks, objects, secrets, verify, purge, setDocuments, internal,
    mounted: () => mounted, restart: () => { mounted = createMountedBlingAssembly(options); } };
}
const bucket = () => {
  const stored = new Map(), puts = [];
  return { stored, puts, async put(key, body) { puts.push(key); stored.set(key, new Uint8Array(typeof body === "string" ? new TextEncoder().encode(body) : body)); },
    async get(key) { const bytes = stored.get(key); return bytes ? { size: bytes.byteLength, body: null, arrayBuffer: async () => bytes.slice().buffer, json: async () => JSON.parse(new TextDecoder().decode(bytes)) } : null; } };
};
const files = dump => new Map(dump.files.map(file => [file.table, file.body]));
const committedPurge = async (f, input) => (await f.api("erp_bling_command_get", { id: input.command_id })).phase === "committed";

test("achado 1: DELETE de XML em voo recusa a restauração, com motivo próprio, sem trocar o banco; durante a troca nenhum DELETE começa", async () => {
  const f = await fixture(["nfe", "fiscal_xml"]);
  try {
    await f.start();
    await f.until(() => count(f.db, "SELECT count(*) n FROM origin_fiscal__revision") === 1);
    // B referencia o XML H; o apagamento vai removê-lo do R2.
    const backup = dumpAll(f.storage);
    const input = await f.purge();
    let release, started = false, startedSignal;
    const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { startedSignal = resolve; });
    const remove = f.options.media.delete;
    f.options.media.delete = async key => { started = true; startedSignal(); await gate; return remove(key); };
    f.restart();
    let inflight = null;
    for (let i = 0; i < 400 && !started; i++) { inflight = f.tick(); await Promise.race([inflight, began]); }
    assert.equal(started, true, "o DELETE do apagamento foi enviado ao R2 e está em voo");
    const before = tableSnapshot(f.db);
    // O pedido de restauração chega com o DELETE em voo.
    assert.equal(beginArchiveRestore(profile), false, "barreira da instância recusa o início");
    assert.throws(() => restoreAll(f.storage, backup.manifest, files(backup), { profile, now: f.clock.now() }), error => error instanceof ErpRestoreBusyError && error.code === "erp_restore_archive_busy");
    assert.deepEqual(tableSnapshot(f.db), before, "nada foi trocado");
    // Passa do prazo da acordada: a chamada continua viva e a recusa também.
    await inflight;
    assert.equal(beginArchiveRestore(profile), false, "DELETE além do prazo ainda recusa");
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    // Terminou e ficou gravado (progresso, sem dono): nada mais no ar, a guarda do banco não trava.
    assert.equal(archiveIoLiveError(f.storage.sql, f.clock.now()), null);
    assert.deepEqual(tableSnapshot(f.db).origin_fiscal__item, before.origin_fiscal__item);
    // A restauração começou (barreira tomada antes de ler o backup): nenhum
    // novo DELETE do apagamento nem I/O de XML inicia até ela terminar.
    assert.equal(beginArchiveRestore(profile), true);
    try {
      let deletes = 0; f.hooks.delete = () => { deletes++; };
      for (let i = 0; i < 5; i++) assert.equal((await f.tick()).worked, false);
      assert.equal(deletes, 0, "DELETE não começa durante a restauração");
      assert.equal(beginArchiveRestore(profile), false, "uma restauração por vez");
    } finally { endArchiveRestore(profile); f.hooks.delete = undefined; }
    // Depois dela, o apagamento retoma e se reconcilia; aí a restauração pode começar.
    await f.until(() => committedPurge(f, input), 400, ["BLING_RESPONSE_INVALID"]);
    assert.equal(restoreAll(f.storage, backup.manifest, files(backup), { profile }).tables, backup.manifest.tables.length);
  } finally { f.verify(); }
});

test("achado 2: restaurar backup feito durante um apagamento aposenta o trabalho, preserva a limpeza R2 e permite nova prévia", async () => {
  const f = await fixture(["nfe", "fiscal_xml"]);
  try {
    await f.start();
    await f.until(() => count(f.db, "SELECT count(*) n FROM origin_fiscal__revision") === 1);
    const first = await f.purge();
    // Retrato no meio do apagamento: unidade purge, plano, fase e exclusões R2 enfileiradas.
    await f.until(() => count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete'") > 0, 100, ["BLING_RESPONSE_INVALID"]);
    assert.equal(count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete' AND (owner IS NOT NULL OR error_code IS NOT NULL)"), 0);
    const backup = dumpAll(f.storage);
    await f.until(() => committedPurge(f, first), 400, ["BLING_RESPONSE_INVALID"]);
    restoreAll(f.storage, backup.manifest, files(backup), { profile }); f.restart();
    const control = f.db.prepare("SELECT state,collect_enabled FROM wb_bling_control").get();
    assert.deepEqual({ ...control }, { state: "off", collect_enabled: 0 }, "coleta desligada");
    assert.equal(count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='purge' AND phase NOT IN ('committed','superseded')"), 0, "apagamento incompatível aposentado");
    const pendingDeletes = count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded')");
    assert.ok(pendingDeletes > 0);
    assert.equal(count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded') AND json_extract(plan,'$.orphan_work_id') IS NULL"), 0, "exclusões preservadas como limpeza de órfãos");
    // O comando antigo não ressuscita o trabalho aposentado.
    await assert.rejects(f.api("erp_bling_purge_apply", first), error => ["BLING_LEASE_LOST", "BLING_GENERATION_RETIRED", "BLING_REVISION_CONFLICT"].includes(error.code));
    // Nova prévia e confirmação concluem; antes, o trabalho antigo era escolhido a cada 30 s.
    const second = await f.purge();
    await f.until(() => committedPurge(f, second), 300, ["BLING_RESPONSE_INVALID"]);
    await f.until(() => count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded')") === 0, 100);
    assert.equal(f.objects.size, 0);
  } finally { f.verify(); }
});

test("achado 3: backup e restauração medem antes de materializar e falham cedo acima do teto, sem manifesto parcial", async () => {
  const f = await fixture(["contacts"]);
  try {
    await f.start();
    await f.until(() => count(f.db, "SELECT count(*) n FROM origin_sync__raw_record") > 0);
    assert.equal(ERP_LOGICAL_BACKUP_LIMIT_BYTES, 16 * 1024 * 1024);
    const measured = measureDump(f.storage);
    const dump = dumpAll(f.storage);
    const real = dump.files.reduce((total, file) => total + Buffer.byteLength(file.body), 0);
    assert.ok(measured >= real * 0.9 && measured <= real * 1.1, `medição ${measured} próxima do NDJSON ${real}`);
    // Acima do teto: falha antes de materializar e nada é gravado.
    const target = bucket();
    assert.throws(() => { const big = dumpAll(f.storage, Math.floor(real / 2)); return backupToR2(target, profile, big); }, error => error instanceof ErpBackupTooLargeError && error.code === "erp_backup_too_large");
    assert.equal(target.puts.length, 0, "nenhum arquivo nem manifesto");
    // A restauração confere compactado e descompactado antes de trocar o banco.
    const saved = await backupToR2(target, profile, dump);
    const before = tableSnapshot(f.db);
    await assert.rejects(readBackup(target, saved.prefix, 64), ErpBackupTooLargeError);
    await assert.rejects(readBackup(target, saved.prefix, Math.floor(real / 2)), ErpBackupTooLargeError);
    assert.deepEqual(tableSnapshot(f.db), before);
    const read = await readBackup(target, saved.prefix);
    assert.equal(read.files.size, dump.files.length);
    // A tela e o documento dizem a partir de que tamanho o backup lógico deixa de cobrir.
    const screen = readFileSync(new URL("../../../web/erp/app/components/ReceiveBling.tsx", import.meta.url), "utf8");
    const doc = readFileSync(new URL("../../../docs/RECEBER-BLING.md", import.meta.url), "utf8");
    for (const text of [screen, doc]) { assert.match(text, /1\.073\.741\.824 bytes/); assert.match(text, /recuperação no tempo/); }
  } finally { f.verify(); }
});

test("achado 6: recusa autenticada por revisão antiga grava recibo terminal que a consulta do comando devolve", async () => {
  const f = await fixture(["contacts"]);
  try {
    await f.start();
    const old = (await f.status()).configuration.revision;
    await f.api("erp_bling_disable", { command_id: crypto.randomUUID(), expected_revision: old });
    const stale = { command_id: crypto.randomUUID(), expected_revision: old };
    await assert.rejects(f.api("erp_bling_disable", stale), error => error.code === "BLING_REVISION_CONFLICT");
    const found = await f.api("erp_bling_command_get", { id: stale.command_id });
    assert.equal(found.receipt?.state, "rejected");
    assert.equal(found.receipt.error.code, "BLING_REVISION_CONFLICT");
    assert.equal(found.receipt.operation, "erp_bling_disable");
    assert.notEqual(found.phase, "absent");
    // O mesmo comando, se ainda estava em trânsito, não produz efeito depois.
    const enabled = await f.enable();
    await assert.rejects(f.api("erp_bling_disable", { ...stale, expected_revision: enabled.configuration.revision }), error => ["BLING_COMMAND_CONFLICT", "BLING_REVISION_CONFLICT"].includes(error.code));
    assert.equal((await f.status()).configuration.collect_enabled, true);
  } finally { f.verify(); }
});

test("achado 7: mudar o período reinicia página e janelas da pista, preservando o acervo", async () => {
  const f = await fixture(["contacts"]);
  try {
    await f.start();
    const cursor = () => JSON.parse(f.db.prepare("SELECT checkpoint FROM origin_sync__resource_state WHERE resource='contacts'").get()?.checkpoint ?? "{}");
    // Uma página do período antigo já teve seus IDs persistidos.
    await f.until(() => !!cursor().page);
    const archived = tableSnapshot(f.db).origin_sync__raw_record;
    await f.configure([{ key: "contacts", selected: true, from: "2026-11-01", to: "2026-11-10" }]);
    await f.enable();
    const saved = cursor();
    assert.equal(saved.page, undefined); assert.equal(saved.recent, undefined); assert.equal(saved.history, undefined);
    assert.deepEqual(tableSnapshot(f.db).origin_sync__raw_record, archived, "acervo preservado");
    const before = f.fake.callCount;
    await f.until(() => f.fake.calls.slice(before).some(call => call.path === "/contatos/7" || call.path === "/contatos" && call.query.criterio === "1"), 50);
    const next = f.fake.calls.slice(before).find(call => call.path === "/contatos/7" || call.path === "/contatos" && call.query.criterio === "1");
    assert.equal(next.path, "/contatos", "nova janela, não o detalhe da página antiga");
    assert.match(next.query.dataAlteracaoInicial, /^2026-11-01/);
    assert.match(next.query.dataAlteracaoFinal, /^2026-11-(0\d|10)/);
  } finally { f.verify(); }
});

for (const release of ["reautorização", "retomada do administrador"]) {
  test(`achado 8: 403 de XML bloqueia a nota até a ${release}`, async () => {
    const f = await fixture(["nfe", "fiscal_xml"]);
    try {
      f.fake.queue({ path: `/nfe/documento/${KEY}`, status: 403 });
      await f.start();
      const xmlCalls = () => f.fake.calls.filter(call => call.path === `/nfe/documento/${KEY}`).length;
      await f.until(() => f.db.prepare("SELECT state FROM origin_fiscal__source").get()?.state === "blocked", 300, ["BLING_SCOPE_REQUIRED"]);
      assert.equal(xmlCalls(), 1);
      f.clock.advance(2 * 86_400_000);
      for (let i = 0; i < 30; i++) await f.tick();
      assert.equal(xmlCalls(), 1, "bloqueada não é tentada de novo por si só");
      if (release === "reautorização") assert.equal((await f.authorize()).state, "authorized");
      else await f.command("erp_bling_collect_request", { resource_keys: ["fiscal_xml"] });
      await f.until(() => count(f.db, "SELECT count(*) n FROM origin_fiscal__revision") === 1, 300, ["BLING_SCOPE_REQUIRED"]);
      assert.equal(xmlCalls(), 2);
      assert.equal(f.objects.size, 1);
    } finally { f.verify(); }
  });
}

test("achado 8: renovação de token não libera a nota bloqueada; outro 403 bloqueia de novo", async () => {
  const f = await fixture(["nfe", "fiscal_xml"]);
  try {
    f.fake.queue({ path: `/nfe/documento/${KEY}`, status: 403 });
    await f.start();
    await f.until(() => f.db.prepare("SELECT state FROM origin_fiscal__source").get()?.state === "blocked", 300, ["BLING_SCOPE_REQUIRED"]);
    const xmlCalls = () => f.fake.calls.filter(call => call.path === `/nfe/documento/${KEY}`).length;
    const revision = () => Number(f.db.prepare("SELECT credential_revision r FROM wb_bling_control").get().r);
    const blockedAt = revision();
    // O token simulado vence em uma hora: a coleta JSON renova a credencial.
    f.clock.advance(86_400_000);
    await f.until(() => f.oauth.calls.some(call => call.operation === "refresh") && revision() > blockedAt, 300, ["BLING_SCOPE_REQUIRED"]);
    for (let i = 0; i < 20; i++) await f.tick();
    assert.equal(xmlCalls(), 1, "renovação não é reautorização");
    f.fake.queue({ path: `/nfe/documento/${KEY}`, status: 403 });
    assert.equal((await f.authorize()).state, "authorized");
    await f.until(() => xmlCalls() === 2, 300, ["BLING_SCOPE_REQUIRED"]);
    await f.until(() => f.db.prepare("SELECT state FROM origin_fiscal__source").get()?.state === "blocked", 50, ["BLING_SCOPE_REQUIRED"]);
    for (let i = 0; i < 20; i++) await f.tick();
    assert.equal(xmlCalls(), 2);
  } finally { f.verify(); }
});

test("achado 9: conjunto de XML que muda na retomada aposenta a tentativa, reconcilia os objetos e a pista avança", async () => {
  const f = await fixture(["nfe", "fiscal_xml"]);
  try {
    const eventA = event(110110, 1), eventB = event(110111, 1);
    f.setDocuments([NFE, eventA]);
    await f.start();
    // Primeiro documento gravado; o segundo exigirá a retomada.
    await f.until(() => f.objects.size === 1);
    const first = f.db.prepare("SELECT id FROM wb_bling_unit WHERE resource='fiscal_xml' AND json_type(progress,'$.xml') IS NOT NULL").get().id;
    // A retomada refaz o GET para o documento ausente; a fonte JSON não muda.
    f.setDocuments([NFE, eventA, eventB]);
    await f.until(() => count(f.db, "SELECT count(*) n FROM origin_fiscal__revision") === 1, 300);
    assert.equal(count(f.db, "SELECT count(*) n FROM origin_fiscal__item"), 3);
    assert.equal(f.db.prepare("SELECT phase FROM wb_bling_unit WHERE id=?").get(first).phase, "superseded");
    assert.equal(f.db.prepare("SELECT state FROM origin_fiscal__attempt WHERE json_extract(result,'$.work_id')=?").get(first).state, "superseded");
    await f.until(() => count(f.db, "SELECT count(*) n FROM wb_bling_unit WHERE kind='r2_delete' AND phase NOT IN ('committed','superseded')") === 0, 100);
    const referenced = f.db.prepare("SELECT hash FROM origin_fiscal__object").all().map(row => `erp/${profile}/bling/xml/${row.hash}`).sort();
    assert.deepEqual([...f.objects.keys()].sort(), referenced, "R2 contém exatamente os objetos do manifesto confirmado");
  } finally { f.verify(); }
});
