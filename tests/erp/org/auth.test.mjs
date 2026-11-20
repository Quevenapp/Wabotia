import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { BlingAuthStore } from "../../../src/erp/bling/auth-store.ts";
import { createBlingAuthorization, createBlingOAuthProvider, oauthHash, blingCallbackUrl } from "../../../src/erp/bling/oauth.ts";
import { createBlingVault } from "../../../src/erp/bling/vault.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { FakeClock, FakeBling } from "./fake-bling.mjs";
import { FakeOAuth } from "./fake-oauth.mjs";
import { assertNoSecrets, assertOperationalUnchanged, guardCollectionDriver, operationalSnapshot, tableSnapshot } from "./contract-checks.mjs";

const opaque = () => randomBytes(32).toString("base64url");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const hasCode = code => error => error?.code === code;

async function fixture() {
  const clock = new FakeClock(), db = freshLite(), d1 = new DatabaseSync(":memory:");
  d1.exec("CREATE TABLE secrets(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const d1Adapter = { prepare(sql) { return { bind(...params) { return { first: async () => d1.prepare(sql).get(...params) ?? null }; } }; } };
  // Cifragem falsa isolada: o teste Worker verifica o AES-GCM real do núcleo.
  const encrypted = new Map();
  const cipher = { async seal(value) { const id = opaque(); encrypted.set(id, structuredClone(value)); return id; }, async unseal(id) { return structuredClone(encrypted.get(id)); } };
  const coreVault = createBlingVault({ DB: d1Adapter }, cipher), hooks = {};
  const vault = {
    async read(profile) { if (hooks.read) await hooks.read(); return coreVault.read(profile); },
    async compareAndSwap(...args) {
      if (hooks.beforeCas) await hooks.beforeCas(...args);
      const saved = await coreVault.compareAndSwap(...args);
      if (hooks.afterCas) await hooks.afterCas(saved);
      return saved;
    },
  };
  const writes = [], store = new BlingAuthStore(guardCollectionDriver(nodeDriver(db), writes), "area-auth");
  const identity = {
    actor: { user_id: crypto.randomUUID(), session_id: crypto.randomUUID(), name: "Administradora", email: null, erp_role: "admin", aal: "aal2", is_agent: false, verified_factor: true },
    people: [], parts: normalizeErpParts({}), partsControl: { profile: "area-auth", revision: "1", expires_at: clock.now() + 86400000 },
  };
  const cookies = [], ctx = { profile: "area-auth", identity: structuredClone(identity), origin: "app", clock, response: { setCookie: cookie => cookies.push(cookie) } };
  const session = { identity };
  const oauth = new FakeOAuth({ clock }), resources = new FakeBling({ clock });
  const provider = { async exchange(input) { if (hooks.exchange) await hooks.exchange(); const result = await oauth.exchange(input); if (hooks.afterExchange) await hooks.afterExchange(result); return result; },
    async refresh(input) { if (hooks.refresh) await hooks.refresh(); const result = await oauth.refresh(input); if (hooks.afterRefresh) await hooks.afterRefresh(result); return result; } };
  const proof = { evidence: { url: "https://official.invalid/identity", checked_at: new Date(clock.now()).toISOString(), read_only: true }, async identify() { if (hooks.identify) await hooks.identify(); return { id: oauth.accountId, name: "Empresa simulada", confirmed_at: new Date(clock.now()).toISOString() }; } };
  const deps = { store, vault, provider, accountProof: proof, publicOrigin: "https://installation.invalid", authorizationEndpoint: "https://oauth.invalid/authorize", readScopes: [],
    session: async () => structuredClone(session.identity), revalidate: async () => { if (hooks.revalidate) await hooks.revalidate(); } };
  const auth = createBlingAuthorization(deps);
  const expected = () => store.control(ctx).expected;
  store.control(ctx);
  db.prepare("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,0)").run();
  db.prepare("INSERT INTO origin_sync__resource_state(resource,account_id,checkpoint,checkpoint_version,updated_at) VALUES('contacts',1,?,7,0)")
    .run(JSON.stringify({ page: 4, cursor: "preservar" }));
  db.prepare("INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES('contacts','contacts','9007199254740993123',?,'[]',?,3,0,0,0)")
    .run(JSON.stringify({ id: "9007199254740993123", nome: "Registro histórico" }), "b".repeat(64));
  const archiveBaseline = tableSnapshot(db, ["origin_sync__account", "origin_sync__resource_state", "origin_sync__raw_record"]);
  const baseline = operationalSnapshot(db), secrets = [];
  const app = () => { const value = { client_id: opaque(), client_secret: opaque() }; secrets.push(...Object.values(value)); return value; };
  async function save(command = crypto.randomUUID(), values = app()) {
    return auth.saveApplication(ctx, { command_id: command, expected_revision: expected().configuration_revision, ...values });
  }
  function enable() {
    db.prepare("UPDATE wb_bling_control SET collect_enabled=1,state='needs_authorization',revision=revision+1,authorization_revision=authorization_revision+1,approved_by=?,approved_at=?,approval_hash=? WHERE id=1")
      .run(identity.actor.user_id, clock.now(), "a".repeat(64));
  }
  function disable() { db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off',revision=revision+1,authorization_revision=authorization_revision+1"); }
  async function start() {
    const command_id = crypto.randomUUID();
    const result = await auth.authorize(ctx, { command_id, expected_revision: expected().configuration_revision });
    const state = new URL(result.authorization_url).searchParams.get("state"), browser_nonce = cookies.at(-1).value, code = opaque();
    secrets.push(state, browser_nonce, code);
    return { command_id, result, input: { state, browser_nonce, code, callback_url: blingCallbackUrl(deps.publicOrigin, ctx.profile) } };
  }
  async function connect() { await save(); enable(); const pending = await start(); assert.equal((await auth.callback(ctx, pending.input)).state, "authorized"); }
  const internal = () => ({ ...ctx, origin: "internal", identity: structuredClone(ctx.identity) });
  const lease = () => ({ owner: crypto.randomUUID(), fence: crypto.randomUUID(), expires_at: clock.now() + 30000 });
  async function verify() {
    for (const envelope of encrypted.values()) {
      if (envelope.value.application) secrets.push(...Object.values(envelope.value.application));
      if (envelope.value.credential) secrets.push(envelope.value.credential.access_token, envelope.value.credential.refresh_token);
    }
    assertNoSecrets(tableSnapshot(db), secrets);
    assertNoSecrets(oauth.calls, secrets);
    assertOperationalUnchanged(db, baseline);
    assert.deepEqual(tableSnapshot(db, Object.keys(archiveBaseline)), archiveBaseline);
    assert.ok(writes.every(write => ["wb_bling_control", "wb_bling_unit", "wb_bling_receipt", "wb_bling_audit"].includes(write.table)));
    resources.assertReadOnly(); assert.equal(resources.mutations, 0);
    db.close(); d1.close();
  }
  return { auth, ctx, session, clock, store, vault, coreVault, hooks, oauth, resources, proof, deps, db, d1, expected, save, enable, disable, start, connect, internal, lease, verify, secrets, app };
}

test("aplicativo idempotente; OAuth hash/session/área, custódia e DTO público sem material privado", async () => {
  const f = await fixture(), input = { command_id: crypto.randomUUID(), expected_revision: "0", ...f.app() };
  const saved = await f.auth.saveApplication(f.ctx, input);
  assert.deepEqual(await f.auth.saveApplication(f.ctx, input), saved);
  assert.equal(f.expected().credential_revision, "1");
  await assert.rejects(f.auth.saveApplication(f.ctx, { ...input, ...f.app() }), hasCode("BLING_COMMAND_CONFLICT"));
  f.enable(); const started = await f.start();
  const row = f.db.prepare("SELECT * FROM wb_bling_unit WHERE kind='oauth_state'").get();
  assert.equal(row.state_hash, await oauthHash(started.input.state));
  assert.equal(row.browser_hash, await oauthHash(started.input.browser_nonce));
  assert.equal(row.session_id, f.ctx.identity.actor.session_id);
  assert.equal(row.profile, f.ctx.profile);
  assert.equal(row.expires_at - row.created_at, 600000);
  const result = await f.auth.callback(f.ctx, started.input);
  assert.deepEqual(result, { redirect: "https://installation.invalid/receber-bling", state: "authorized", clear_cookie: true });
  const pub = await f.auth.publicState(f.ctx);
  assert.equal(pub.authorized, true); assert.equal(pub.revision, "2");
  assertNoSecrets([saved, pub, result], f.secrets);
  const credential = await f.auth.privateCredential(f.internal(), f.expected());
  assert.ok(credential.access_token);
  await assert.rejects(f.auth.privateCredential(f.ctx, f.expected()), hasCode("BLING_ADMIN_REQUIRED"));
  assert.equal(f.oauth.callCount, 1);
  assert.equal((await f.auth.callback(f.ctx, started.input)).state, "unavailable");
  assert.equal(f.oauth.callCount, 1);
  await f.verify();
});

test("negação consome estado e limpa retorno; input remoto não aparece no erro", async () => {
  const f = await fixture(); await f.save(); f.enable(); const start = await f.start();
  const remote = opaque(); f.secrets.push(remote);
  const denied = await f.auth.callback(f.ctx, { ...start.input, code: undefined, error: remote });
  assert.equal(denied.state, "denied"); assert.equal(denied.clear_cookie, true);
  assert.equal((await f.auth.callback(f.ctx, start.input)).state, "unavailable");
  assert.equal(f.oauth.callCount, 0); assertNoSecrets(denied, f.secrets);
  await f.verify();
});

for (const change of ["expired", "session", "actor", "area", "cookie", "callback", "revision", "parts", "role"]) {
  test(`estado OAuth recusa ${change} sem POST`, async () => {
    const f = await fixture(); await f.save(); f.enable(); const start = await f.start();
    if (change === "expired") f.clock.advance(600000);
    if (change === "session") f.session.identity.actor.session_id = crypto.randomUUID();
    if (change === "actor") f.session.identity.actor.user_id = crypto.randomUUID();
    if (change === "area") f.ctx.profile = "outra-area";
    if (change === "cookie") start.input.browser_nonce = opaque();
    if (change === "callback") start.input.callback_url = "https://evil.invalid/return";
    if (change === "revision") f.db.exec("UPDATE wb_bling_control SET revision=revision+1");
    if (change === "parts") f.session.identity.partsControl.revision = "2";
    if (change === "role") f.session.identity.actor.erp_role = "consulta";
    const result = await f.auth.callback(f.ctx, start.input);
    assert.equal(result.state, "unavailable"); assert.equal(result.redirect, "https://installation.invalid/receber-bling");
    assert.equal(f.oauth.callCount, 0); await f.verify();
  });
}

test("desligado e identidade oficial não conferida não chamam provedor", async () => {
  const f = await fixture(); await f.save();
  await assert.rejects(f.start(), hasCode("BLING_DISABLED"));
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_DISABLED"));
  f.enable(); f.proof.evidence = null;
  await assert.rejects(f.start(), hasCode("BLING_RESOURCE_UNCONFIRMED"));
  assert.equal(f.oauth.callCount, 0); await f.verify();
});

test("renovação exclusiva, replay não repete POST nem incrementa revisão duas vezes", async () => {
  const f = await fixture(); await f.connect();
  const input = { expected: f.expected(), lease: f.lease() }, entered = deferred(), resume = deferred();
  f.hooks.refresh = async () => { entered.resolve(); await resume.promise; };
  const first = f.auth.renew(f.internal(), input); await entered.promise;
  await assert.rejects(f.auth.renew(f.internal(), { ...input, lease: f.lease() }), hasCode("BLING_LEASE_LOST"));
  await assert.rejects(f.auth.renew(f.internal(), input), hasCode("BLING_LEASE_LOST"));
  resume.resolve(); const result = await first;
  assert.equal(result.revision, "3");
  assert.deepEqual(await f.auth.renew(f.internal(), input), result);
  assert.equal(f.oauth.callCount, 2);
  const receipts = f.db.prepare("SELECT count(*) AS n FROM wb_bling_receipt WHERE operation='erp_bling_oauth_refresh'").get();
  assert.equal(receipts.n, 1); await f.verify();
});

test("concorrência na mesma reserva antes de HTTP não encerra tentativa de outro executor", async () => {
  const f = await fixture(); await f.connect();
  const input = { expected: f.expected(), lease: f.lease() }, entered = deferred(), resume = deferred();
  f.hooks.read = async () => { entered.resolve(); await resume.promise; };
  const first = f.auth.renew(f.internal(), input); await entered.promise;
  await assert.rejects(f.auth.renew(f.internal(), input), hasCode("BLING_LEASE_LOST"));
  resume.resolve(); assert.equal((await first).authorized, true);
  assert.equal(f.oauth.callCount, 2); await f.verify();
});

test("refresh rotacionado com resposta perdida fica incerto, sem repetição cega; nova autorização recupera", async () => {
  const f = await fixture(); await f.connect();
  f.hooks.afterRefresh = () => { throw new Error(opaque()); };
  const input = { expected: f.expected(), lease: f.lease() };
  await assert.rejects(f.auth.renew(f.internal(), input), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
  await assert.rejects(f.auth.renew(f.internal(), input), hasCode("BLING_AUTH_REQUIRED"));
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal(f.oauth.callCount, 2);
  delete f.hooks.afterRefresh;
  const start = await f.start(); assert.equal((await f.auth.callback(f.ctx, start.input)).state, "authorized");
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, false);
  await f.verify();
});

test("queda após CAS cifrado e antes de recibo permite nova autorização sem travar revisão", async () => {
  const f = await fixture(); await f.connect();
  f.hooks.afterCas = () => { throw new Error(opaque()); };
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal(f.expected().credential_revision, "2");
  assert.equal((await f.coreVault.read(f.ctx.profile)).revision, "3");
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
  delete f.hooks.afterCas;
  const start = await f.start(); assert.equal((await f.auth.callback(f.ctx, start.input)).state, "authorized");
  assert.equal(f.expected().credential_revision, "4");
  await f.verify();
});

test("CAS perdido não publica credencial; resultado remoto já rotacionado exige reautorização", async () => {
  const f = await fixture(); await f.connect();
  f.hooks.beforeCas = async (profile, previous) => {
    delete f.hooks.beforeCas;
    await f.coreVault.compareAndSwap(profile, previous, { ...previous.value, revision: String(Number(previous.revision) + 1) });
  };
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_REVISION_CONFLICT"));
  assert.equal(f.expected().credential_revision, "2");
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
  await f.verify();
});

test("unidade fetching abandonada expira e termina incerta sem repetir POST", async () => {
  const f = await fixture(); await f.connect();
  const input = { command_id: crypto.randomUUID(), request_hash: await oauthHash(opaque()), kind: "oauth_refresh", operation: "erp_bling_oauth_refresh", expected: f.expected(), lease: f.lease() };
  const { attempt } = f.store.begin(f.internal(), input); f.store.markFetching(f.internal(), attempt);
  f.clock.advance(30000);
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
  assert.equal(f.store.receipt(f.ctx, input.command_id, input.request_hash).state, "rejected");
  assert.equal(f.oauth.callCount, 1); await f.verify();
});

test("porta privada reavalia incerteza surgida enquanto lê o cofre", async () => {
  const f = await fixture(); await f.connect();
  f.hooks.read = () => { f.db.exec("UPDATE wb_bling_control SET credential_status='uncertain',state='needs_authorization'"); };
  await assert.rejects(f.auth.privateCredential(f.internal(), f.expected()), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal(f.oauth.callCount, 1); await f.verify();
});

for (const action of ["disable", "disconnect"]) {
  test(`${action} durante I/O impede publicação atrasada e preserva conta`, async () => {
    const f = await fixture(); await f.connect(); const beforeAccount = f.store.control(f.ctx).account;
    const entered = deferred(), resume = deferred();
    f.hooks.afterRefresh = async () => { entered.resolve(); await resume.promise; };
    const pending = f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }); await entered.promise;
    if (action === "disable") f.disable();
    else assert.equal((await f.auth.disconnect(f.ctx, f.expected())).authorized, false);
    resume.resolve(); await assert.rejects(pending);
    assert.deepEqual(f.store.control(f.ctx).account, beforeAccount);
    assert.equal(f.store.control(f.ctx).enabled, false);
    if (action === "disconnect") {
      const snapshot = await f.coreVault.read(f.ctx.profile);
      assert.equal(snapshot.value.disconnected, true);
      assert.equal(snapshot.value.application, null); assert.equal(snapshot.value.credential, null);
      assert.equal((await f.auth.publicState(f.ctx)).uncertain, false);
    } else assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
    await f.verify();
  });
}

test("reautorizar mesma conta conserva identidade/acervo/checkpoint; outra conta é recusada", async () => {
  const f = await fixture(); await f.connect();
  const bound = f.store.control(f.ctx).account.id;
  // Checkpoint legado preservado integralmente por todas as autorizações.
  const checkpoints = tableSnapshot(f.db, ["origin_sync__resource_state", "origin_sync__raw_record", "erp_sync__link"]);
  let start = await f.start(); assert.equal((await f.auth.callback(f.ctx, start.input)).state, "authorized");
  assert.equal(f.store.control(f.ctx).account.id, bound);
  f.oauth.accountId = "123456789";
  start = await f.start(); const result = await f.auth.callback(f.ctx, start.input);
  assert.equal(result.error.code, "BLING_ACCOUNT_MISMATCH");
  assert.equal(f.store.control(f.ctx).account.id, bound);
  assert.deepEqual(tableSnapshot(f.db, Object.keys(checkpoints)), checkpoints);
  await f.verify();
});

test("sessão revogada durante troca não publica segredo nem autoriza", async () => {
  const f = await fixture(); await f.save(); f.enable(); const start = await f.start();
  f.hooks.afterExchange = () => { f.session.identity.actor.erp_role = "consulta"; };
  const result = await f.auth.callback(f.ctx, start.input);
  assert.equal(result.error.code, "BLING_ADMIN_REQUIRED"); assert.equal(f.expected().credential_revision, "1");
  assertNoSecrets(result, f.secrets); await f.verify();
});

test("sessão revogada durante CAS não confirma custódia; nova autorização recupera revisão", async () => {
  const f = await fixture(); await f.save(); f.enable(); const start = await f.start();
  f.hooks.afterCas = () => { f.session.identity.actor.erp_role = "consulta"; };
  const result = await f.auth.callback(f.ctx, start.input);
  assert.equal(result.error.code, "BLING_ADMIN_REQUIRED");
  assert.equal(f.expected().credential_revision, "1"); assert.equal((await f.coreVault.read(f.ctx.profile)).revision, "2");
  delete f.hooks.afterCas; f.session.identity.actor.erp_role = "admin"; f.ctx.identity.actor.erp_role = "admin";
  const next = await f.start(); assert.equal((await f.auth.callback(f.ctx, next.input)).state, "authorized");
  await f.verify();
});

test("desconexão interrompida retoma tombstone com expected original e preserva conta", async () => {
  const f = await fixture(); await f.connect(); const expected = f.expected();
  f.hooks.beforeCas = () => { throw new Error(opaque()); };
  await assert.rejects(f.auth.disconnect(f.ctx, expected), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal(f.store.control(f.ctx).disconnected, true);
  assert.equal((await f.auth.publicState(f.ctx)).configured, false);
  delete f.hooks.beforeCas;
  assert.equal((await f.auth.disconnect(f.ctx, expected)).authorized, false);
  const tombstone = await f.coreVault.read(f.ctx.profile);
  assert.equal(tombstone.value.disconnected, true); assert.equal(tombstone.value.application, null);
  assert.equal(f.store.control(f.ctx).account.id, expected.account_id);
  await f.verify();
});

test("resposta atrasada após desconectar e reautorizar não sobrescreve credencial nova", async () => {
  const f = await fixture(); await f.connect(); const entered = deferred(), resume = deferred();
  f.hooks.afterRefresh = async () => { entered.resolve(); await resume.promise; };
  const pending = f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }); await entered.promise;
  await f.auth.disconnect(f.ctx, f.expected());
  await f.save(); f.enable(); const start = await f.start();
  assert.equal((await f.auth.callback(f.ctx, start.input)).state, "authorized");
  const before = await f.coreVault.read(f.ctx.profile), revision = f.expected().credential_revision;
  resume.resolve(); await assert.rejects(pending);
  assert.equal((await f.coreVault.read(f.ctx.profile)).ciphertext, before.ciphertext);
  assert.equal(f.expected().credential_revision, revision);
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, false);
  await f.verify();
});

test("prova privada de conta e revalidação nunca propagam exceção com segredo", async () => {
  const f = await fixture(); await f.connect();
  const previous = await f.coreVault.read(f.ctx.profile), errorValue = opaque(); f.secrets.push(errorValue);
  f.hooks.identify = () => { throw new Error(errorValue); };
  await assert.rejects(f.auth.custodyCas(f.internal(), { expected: f.expected(), expected_revision: previous.revision, previous_ciphertext: previous.ciphertext,
    credential: previous.value.credential, account: f.store.control(f.ctx).account, lease: f.lease() }), error => {
    assert.equal(error.code, "BLING_AUTH_REQUIRED"); assertNoSecrets(String(error), f.secrets); return true;
  });
  f.hooks.revalidate = () => { throw new Error(errorValue); };
  await assert.rejects(f.auth.privateCredential(f.internal(), f.expected()), error => {
    assert.equal(error.code, "BLING_AUTH_REQUIRED"); assertNoSecrets(String(error), f.secrets); return true;
  });
  await f.verify();
});

test("reserva abandonada antes de I/O termina explicitamente, sem chamada ou checkpoint", async () => {
  const f = await fixture(); await f.connect();
  const input = { command_id: crypto.randomUUID(), request_hash: await oauthHash(opaque()), operation: "erp_bling_oauth_refresh", kind: "oauth_refresh", expected: f.expected(), lease: f.lease() };
  f.store.begin(f.internal(), input); f.clock.advance(30000); f.store.recoverExpired(f.internal());
  assert.equal(f.store.receipt(f.ctx, input.command_id, input.request_hash).error.code, "BLING_AUTH_REQUIRED");
  assert.equal(f.oauth.callCount, 1); assert.equal(f.expected().credential_revision, "2");
  await f.verify();
});

test("incerteza é durável antes do POST, mesmo se desligamento encerrar unidade e processo cair", async () => {
  const f = await fixture(); await f.connect();
  const input = { command_id: crypto.randomUUID(), request_hash: await oauthHash(opaque()), operation: "erp_bling_oauth_refresh", kind: "oauth_refresh", expected: f.expected(), lease: f.lease() };
  const { attempt } = f.store.begin(f.internal(), input); f.store.markFetching(f.internal(), attempt);
  assert.equal((await f.auth.publicState(f.ctx)).uncertain, true);
  f.disable();
  f.db.prepare("UPDATE wb_bling_unit SET phase='superseded',finished_at=? WHERE id=?").run(f.clock.now(), attempt.id);
  f.enable();
  await assert.rejects(f.auth.renew(f.internal(), { expected: f.expected(), lease: f.lease() }), hasCode("BLING_AUTH_REQUIRED"));
  assert.equal(f.oauth.callCount, 1); await f.verify();
});

test("restauração com revisão local acima do cofre fica bloqueada sem sobrescrever credencial", async () => {
  const f = await fixture(); await f.connect();
  const before = await f.coreVault.read(f.ctx.profile);
  f.db.exec("UPDATE wb_bling_control SET credential_revision=credential_revision+1,app_configured=0,credential_status='missing',collect_enabled=0,state='off'");
  await assert.rejects(f.save(), hasCode("BLING_REVISION_CONFLICT"));
  assert.equal((await f.coreVault.read(f.ctx.profile)).ciphertext, before.ciphertext);
  assert.equal(f.oauth.callCount, 1); await f.verify();
});

test("arquivos da tarefa são UTF-8 sem BOM e LF", () => {
  for (const path of ["../../../src/erp/bling/oauth.ts", "../../../src/erp/bling/auth-store.ts", "../../../src/erp/bling/vault.ts", "../../org-auth.test.ts", "./auth.test.mjs"]) {
    const bytes = readFileSync(new URL(path, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.includes("\r"), false); assert.equal(text.includes("\uFFFD"), false);
  }
});

for (const operation of ["erp_bling_app_save", "erp_bling_oauth_start", "erp_bling_disconnect"]) {
  test(`${operation}: bot configurado alcança a porta; externo, sem configuração e sem papel são recusados`, async () => {
    const f = await fixture(); await f.save(); f.enable();
    const command_id = crypto.randomUUID();
    f.ctx.identity.actor.is_agent = true; f.session.identity.actor.is_agent = true;
    const invoke = () => operation === "erp_bling_app_save" ? f.auth.saveApplication(f.ctx, { command_id, expected_revision: f.expected().configuration_revision, ...f.app() }) : operation === "erp_bling_oauth_start" ? f.auth.authorize(f.ctx, { command_id, expected_revision: f.expected().configuration_revision }) : f.auth.disconnect(f.ctx, f.expected());
    await assert.rejects(invoke(), hasCode("BLING_SCOPE_REQUIRED"));
    f.ctx.authorization = { bot: { id: "bot-equipe", allowed_operations: [operation], allowed_entities: [], data_scopes: [], allow_sensitive: true } };
    f.ctx.origin = "external"; await assert.rejects(invoke(), hasCode("BLING_ADMIN_REQUIRED")); f.ctx.origin = "app";
    f.session.identity.actor.erp_role = "consulta"; await assert.rejects(invoke(), hasCode("BLING_ADMIN_REQUIRED"));
    f.session.identity.actor.erp_role = "admin"; f.ctx.identity.actor.erp_role = "admin";
    assert.ok(await invoke()); await f.verify();
  });
}

for (const mode of ["configured", "unconfigured", "external"]) {
  test(`callback OAuth de bot ${mode} mantém a política da autorização original`, async () => {
    const f = await fixture(); await f.save(); f.enable();
    f.ctx.identity.actor.is_agent = true; f.session.identity.actor.is_agent = true;
    f.ctx.authorization = { bot: { id: "bot-equipe", allowed_operations: ["erp_bling_oauth_start"], allowed_entities: [], data_scopes: [], allow_sensitive: true } };
    const start = await f.start();
    if (mode === "unconfigured") f.ctx.authorization.bot.allowed_operations = [];
    if (mode === "external") f.ctx.origin = "external";
    const result = await f.auth.callback(f.ctx, start.input);
    assert.equal(result.state, mode === "configured" ? "authorized" : "unavailable");
    assert.equal(f.oauth.callCount, mode === "configured" ? 1 : 0);
    await f.verify();
  });
}

test("adaptador protocolar usa POST fake separado; dados permanecem GET sem mutações", async () => {
  const clock = new FakeClock(), fake = new FakeBling({ clock }), oauth = new FakeOAuth({ clock }), application = { client_id: opaque(), client_secret: opaque() };
  const code = opaque(), requests = [];
  const transport = createBlingOAuthProvider({ tokenEndpoint: "https://oauth.invalid/token", clock, readScopes: [], fetch: async (url, init) => {
    assert.equal(url, "https://oauth.invalid/token"); assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${application.client_id}:${application.client_secret}`).toString("base64")}`);
    const body = new URLSearchParams(init.body); requests.push(body.get("grant_type"));
    const result = body.get("grant_type") === "authorization_code" ? await oauth.exchange(application) : await oauth.refresh(body.get("refresh_token"));
    return Response.json(result);
  } });
  const first = await transport.exchange({ ...application, code, callback_url: "https://installation.invalid/api/public/erp-bling/area/callback" });
  const second = await transport.refresh(first); assert.notEqual(second.refresh_token, first.refresh_token);
  assert.deepEqual(requests, ["authorization_code", "refresh_token"]);
  fake.resource("/contatos", [{ id: "1", nome: "Consulta" }]); await fake.fetch(fake.baseUrl + "/contatos");
  fake.assertReadOnly(); assert.equal(fake.mutations, 0);
});
