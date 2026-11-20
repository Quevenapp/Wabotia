import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBlingApi } from "../../../src/erp/bling/operations.ts";
import { createBlingControl } from "../../../src/erp/bling/control.ts";
import { BLING_ENTITIES, BLING_OPERATION_NAMES, BlingError } from "../../../src/erp/bling/contracts.ts";
import { BLING_OPERATIONS } from "../../../src/erp/bling/schema.ts";
import { handlePublicBlingRequest, matchPublicBlingRoute } from "../../../src/erp/bling/routes.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { FakeClock, FakeBling } from "./fake-bling.mjs";
import { assertNoSecrets, assertOperationalUnchanged, operationalSnapshot, guardCollectionDriver, sqliteStorage } from "./contract-checks.mjs";

const area = "api-area", actorId = "b7000000-0000-4000-8000-000000000001", sessionId = "b7000000-0000-4000-8000-000000000002";
const hashA = "a".repeat(64), hashB = "b".repeat(64);
const hash = async bytes => createHash("sha256").update(bytes).digest("hex");
const parts = normalizeErpParts({ products: false, sales: false, purchases: false, stock: false, finance: false, fiscal: false, billing: false, pos: false });
const emptyAccess = () => ({ reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } });
const allAccess = () => ({ ...emptyAccess(), bots: [{ bot_id: "bot-1", operations: [...BLING_OPERATION_NAMES], entities: [...BLING_ENTITIES], data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: true, mask_personal: false }] });
const resource = (confirmation = "oficial_confirmado") => ({ key: "products", entity: "products", path: "/produtos",
  pagination: { strategy: "page", page_size: 10, limit_parameter: true, short_page_ends: true }, detail: { path: "/produtos/{id}", required: true },
  dateFilter: { kind: "M", from: "dataAlteracaoInicial", to: "dataAlteracaoFinal", time_zone: "America/Sao_Paulo", overlap_minutes: 15 },
  variants: [], deletedEvidence: "explicit_deleted_variant", identityRule: { kind: "global", parent_entity: null }, parser: "price", scopeRequirements: ["read-products"], confirmation,
  officialEvidence: confirmation === "oficial_confirmado" ? { url: "https://docs.invalid/products", checked_at: "2026-11-19T12:00:00.000Z", scopes_checked: true, identity_checked: true, limits_checked: true } : null, defaultSelected: false });
const selection = [{ key: "products", selected: true, from: "2020-01-01", to: null }];

function fixture({ ready = true, access = emptyAccess(), resources = [resource()] } = {}) {
  const db = new DatabaseSync(":memory:"), clock = new FakeClock();
  db.exec("PRAGMA foreign_keys=ON");
  const storage = sqliteStorage(db); migrate(storage);
  db.prepare("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,?)").run(clock.now());
  db.prepare("INSERT INTO origin_sync__resource_state(resource,account_id,checkpoint,checkpoint_version,updated_at) VALUES('products',1,'{}',0,?)").run(clock.now());
  const base = operationalSnapshot(db), writes = [], driver = guardCollectionDriver(storageDriver(storage), writes);
  let sequence = 0;
  const randomId = () => `api-id-${++sequence}`;
  const ctx = { profile: area, origin: "app", clock, identity: { actor: { user_id: actorId, name: null, email: null, erp_role: "admin", session_id: sessionId, aal: "aal2", verified_factor: true, is_agent: false }, people: [], parts, partsControl: { profile: area, revision: "1", expires_at: clock.now() + 120000 } } };
  const control = createBlingControl({ db: driver, databaseSize: () => storage.sql.databaseSize, randomId, profile: area });
  if (ready) db.prepare(`INSERT INTO wb_bling_control(revision,authorization_revision,credential_revision,collect_enabled,state,account_id,account_public,selection,permissions,approved_by,approved_at,approval_hash,app_configured,credential_status,credential_expires_at,credential_scopes,updated_at)
    VALUES(1,1,1,1,'ready','company',?,?,?,?,?,?,1,'ready',?, ?,?)`).run(JSON.stringify({ id: "company", name: "Empresa de teste", confirmed_at: clock.iso() }), JSON.stringify(selection), JSON.stringify(access), actorId, clock.now(), hashA, clock.now() + 3600000, JSON.stringify(["read-products"]), clock.now());
  const calls = { collect: 0, auth: 0, disconnect: 0, read: 0, xml: 0, purge: 0, callback: 0, save: 0 };
  const fake = new FakeBling({ clock }).resource("/produtos", [{ id: "1", nome: "Produto" }]);
  const coverage = { complete: false, observed: 1, changed: 1, pending: 0, last_pass_started_at: null, last_pass_completed_at: null, freshness_at: null, limitations: ["Não certifica a conta."] };
  const identity = { profile: area, account_id: "company", entity: "products", source_id: "1" };
  const record = { identity, version: "1", semantic_hash: hashA, payload_text: '{"id":"1","nome":"Nome pessoal","preco":12345678901234567890.123456789}', document_links: [], observed_at: clock.iso(), source_updated_at: null, source_time_quality: "unknown", deleted: false, deletion_evidence: null, capture: null };
  const metadata = { identity, version: "1", semantic_hash: hashA, payload_bytes: 96, first_observed_at: clock.iso(), last_observed_at: clock.iso(), source_updated_at: null, source_time_quality: "unknown", deleted: false, mapper_version: null, capture_revision: null };
  const historical = { label: "Consulta histórica — não opera no ERP", kind: "products", fields: { name: "Nome pessoal" }, unresolved_references: [], unmapped_fields: ["preco"], coverage };
  const preview = { generation: "1", preview_hash: hashA, counts: { records: 1 }, files: 0, blocked_references: 0 };
  const unsupported = () => { throw new Error("Porta inesperada."); };
  const deps = {
    db: driver, databaseSize: () => storage.sql.databaseSize, randomId, hash,
    readParts: async () => ({ ...ctx.identity.partsControl, parts: ctx.identity.parts }), revalidate: async () => {}, data: { get: unsupported },
    authorization: { publicState: async () => control.read(ctx).configuration.credential, renew: unsupported, reserveOAuth: unsupported, consumeOAuth: unsupported, custodyCas: unsupported, privateCredential: unsupported,
      saveApplication: async (context, input) => { calls.save++; const receipt = control.finish(context, "erp_bling_app_save", input, context.authorization.request_hash, { references: { callback_url: `https://installation.invalid/api/public/erp-bling/${area}/callback`, revision: "1" } }); return { configured: true, revision: "1", callback_url: `https://installation.invalid/api/public/erp-bling/${area}/callback`, receipt }; },
      authorize: async () => { calls.auth++; return { authorization_url: "https://provider.invalid/authorize", expires_at: clock.now() + 600000 }; },
      disconnect: async () => { calls.disconnect++; return { configured: false, authorized: false, revision: "2", expires_at: null, scopes: [], uncertain: false }; },
      callback: async () => { calls.callback++; return { redirect: "/receber-bling", state: "authorized", clear_cookie: true }; },
    },
    collection: { reserve: unsupported, renew: unsupported, release: unsupported, receipt: unsupported, markFetching: unsupported, commitBatch: unsupported, reschedule: unsupported,
      requestCollection: (context, input) => { calls.collect++; const receipt = control.finish(context, "erp_bling_collect_request", input, context.authorization.request_hash, { references: { run_id: "run-1", next_wake: clock.now() + 700 }, counts: { scheduled: 1 } }); return { run_id: "run-1", next_wake: clock.now() + 700, receipt }; },
    },
    archive: { validateCapture: unsupported, archiveXml: unsupported,
      listRecords: () => ({ items: [metadata], next_cursor: null }), listVersions: () => ({ items: [metadata], next_cursor: null }),
      readVersion: () => { calls.read++; return structuredClone(record); }, project: () => ({ metadata: structuredClone(metadata), historical: structuredClone(historical) }),
      listXml: () => ({ items: [], next_cursor: null }), readXml: async () => { calls.xml++; return { bytes: new TextEncoder().encode("<nfe/>"), sha256: hashA, filename: "nota.xml", content_type: "application/xml" }; },
      purgePreview: () => structuredClone(preview), purge: async () => { calls.purge++; return { work_id: "purge-1", receipt: null }; },
    },
  };
  const api = createBlingApi(deps, { profile: area, resources, resource_version: "test-v1" });
  return { db, ctx, clock, deps, api, control, calls, fake, record, metadata, preview, writes,
    verify() { assertOperationalUnchanged(db, base); fake.assertReadOnly(); assert.equal(fake.mutations, 0); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); },
    close() { db.close(); } };
}
const command = (id = "command-1", revision = "1") => ({ command_id: id, expected_revision: revision });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof BlingError && error.code === code);

test("configuração inicia desligada, CAS/recibo são atômicos e replay precede revisão antiga", async () => {
  const f = fixture({ ready: false });
  try {
    const initial = await f.api.execute(f.ctx, "erp_bling_status", {});
    assert.equal(initial.state, "off"); assert.equal(initial.configuration.access.bots.length, 0); assert.equal(initial.coverage.complete, false);
    const input = { ...command("configure", "0"), selections: selection, daily_call_limit: 300, access: emptyAccess(), ai_disclosure_acknowledged: false };
    const first = await f.api.execute(f.ctx, "erp_bling_configure", input);
    assert.equal(first.configuration.revision, "1");
    const replay = await f.api.execute(f.ctx, "erp_bling_configure", input);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_audit").get().n, 1);
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_configure", { ...input, daily_call_limit: 301 }), "BLING_COMMAND_CONFLICT");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_configure", { ...input, command_id: "stale" }), "BLING_REVISION_CONFLICT");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_configure", { ...input, command_id: "raise-quota", expected_revision: "1", daily_call_limit: 301 }), "BLING_RESOURCE_UNCONFIRMED");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command("off", "1"), resource_keys: ["products"] }), "BLING_DISABLED");
    assert.equal(f.calls.collect, 0); assert.equal(f.fake.callCount, 0); f.verify();
  } finally { f.close(); }
});

test("configuração/ativação exigem referência oficial, quota e aviso de IA; não operam registros", async () => {
  const f = fixture({ resources: [resource("original_conferido")] });
  try {
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_enable", { ...command(), warning_confirmed: true, checklist_hash: hashA }), "BLING_RESOURCE_UNCONFIRMED");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command(), resource_keys: ["products"] }), "BLING_RESOURCE_UNCONFIRMED");
    const config = { ...command(), selections: selection, daily_call_limit: 20001, access: emptyAccess(), ai_disclosure_acknowledged: false };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_configure", config), "BLING_RESPONSE_INVALID");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_configure", { ...config, daily_call_limit: 100, access: allAccess() }), "BLING_RESPONSE_INVALID");
    assert.equal(f.calls.collect, 0); f.verify();
  } finally { f.close(); }
});

test("pedido perdido após gravação recupera recibo sem duplicar rodada nem avançar checkpoint", async () => {
  const f = fixture();
  try {
    const input = { ...command("collect"), resource_keys: ["products"] };
    await f.api.execute(f.ctx, "erp_bling_collect_request", input); // resposta descartada pelo cliente
    const replay = await f.api.execute(f.ctx, "erp_bling_collect_request", input);
    assert.equal(replay.run_id, "run-1"); assert.equal(f.calls.collect, 1);
    assert.equal(f.db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource='products'").get().checkpoint_version, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt WHERE command_id='collect'").get().n, 1);
    assert.equal((await f.api.execute(f.ctx, "erp_bling_command_get", { id: "collect" })).receipt.command_id, "collect");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...input, resource_keys: ["contacts"] }), "BLING_COMMAND_CONFLICT");
    f.verify();
  } finally { f.close(); }
});

test("desligar invalida posse em curso e impede novos pedidos; acervo continua consultável", async () => {
  const f = fixture();
  try {
    f.db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,account_id,parts_revision,kind,resource,entity,phase,owner,fence,lease_until,not_before,created_at,updated_at)
      VALUES('work','attempt','unit-command',?,1,1,1,1,'company','1','detail','products','products','fetching','worker','fence',?,?,?,?)`).run(hashA, f.clock.now() + 60000, f.clock.now(), f.clock.now(), f.clock.now());
    const disabled = await f.api.execute(f.ctx, "erp_bling_disable", command());
    assert.equal(disabled.configuration.collect_enabled, false); assert.equal(disabled.configuration.generation, "1");
    assert.notEqual(disabled.configuration.authorization_revision, "1");
    const unit = f.db.prepare("SELECT phase,owner,fence FROM wb_bling_unit WHERE id='work'").get();
    assert.equal(unit.phase, "superseded"); assert.equal(unit.fence, null);
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command("after", disabled.configuration.revision), resource_keys: ["products"] }), "BLING_DISABLED");
    assert.match((await f.api.execute(f.ctx, "erp_bling_record_get", { entity: "products", id: "1" })).raw.payload_text, /12345678901234567890\.123456789/);
    assert.equal(f.calls.disconnect, 0); f.verify();
  } finally { f.close(); }
});

test("sem privilégio, área ou origem corretos não há efeito; identidade no corpo é recusada", async () => {
  const f = fixture();
  try {
    const lower = structuredClone(f.ctx.identity); lower.actor.erp_role = "consulta";
    await rejectsCode(f.api.execute({ ...f.ctx, identity: lower }, "erp_bling_disable", command()), "BLING_ADMIN_REQUIRED");
    await rejectsCode(f.api.execute({ ...f.ctx, origin: "external" }, "erp_bling_disable", command()), "BLING_ADMIN_REQUIRED");
    await rejectsCode(f.api.execute({ ...f.ctx, profile: "other" }, "erp_bling_status", {}), "BLING_SCOPE_REQUIRED");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_disable", { ...command(), actor: actorId, profile: "other", admin: true }), "BLING_RESPONSE_INVALID");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_audit").get().n, 0); f.verify();
  } finally { f.close(); }
});

test("leitura concedida funciona desligada; IA padrão recusa, configuração libera e máscara protege conteúdo", async () => {
  const access = allAccess(); access.reader_user_ids = [actorId];
  const f = fixture({ access });
  try {
    const lower = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, erp_role: "consulta" } } };
    assert.equal((await f.api.execute(lower, "erp_bling_records_list", { entity: "products" })).items.length, 1);
    const bot = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, is_agent: true } }, authorization: { bot: { id: "bot-1", allowed_operations: [...BLING_OPERATION_NAMES], allowed_entities: [...BLING_ENTITIES], data_scopes: ["public", "raw", "personal", "sensitive", "xml"], allow_sensitive: true } } };
    const full = await f.api.execute(bot, "erp_bling_record_get", { entity: "products", id: "1" }); assert.equal(full.raw.payload_text, f.record.payload_text);
    access.bots[0].mask_personal = true;
    f.db.prepare("UPDATE wb_bling_control SET permissions=?").run(JSON.stringify(access));
    const masked = await f.api.execute(bot, "erp_bling_record_get", { entity: "products", id: "1" });
    assert.equal(masked.raw.payload_text, "{}"); assert.ok(!JSON.stringify(masked).includes("Nome pessoal"));
    await rejectsCode(f.api.execute(bot, "erp_bling_xml_get", { object_id: "xml-1" }), "BLING_SCOPE_REQUIRED");
    f.db.prepare("UPDATE wb_bling_control SET permissions=?").run(JSON.stringify(emptyAccess()));
    await rejectsCode(f.api.execute(bot, "erp_bling_records_list", { entity: "products" }), "BLING_SCOPE_REQUIRED");
    await rejectsCode(f.api.execute(lower, "erp_bling_records_list", { entity: "products" }), "BLING_SCOPE_REQUIRED"); f.verify();
  } finally { f.close(); }
});

test("confirmação de bot cobre argumentos/revisão e expira pelo relógio injetado", async () => {
  const access = allAccess(); access.bots[0].allow_sensitive = false;
  const f = fixture({ access });
  try {
    const input = command(), requestHash = await hash(new TextEncoder().encode(JSON.stringify(input)));
    const ctx = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, is_agent: true } }, authorization: { request_hash: requestHash,
      bot: { id: "bot-1", allowed_operations: ["erp_bling_disable"], allowed_entities: [...BLING_ENTITIES], data_scopes: [], allow_sensitive: false },
      confirmation: { operation: "erp_bling_disable", command_id: input.command_id, request_hash: requestHash, confirmed_by: actorId, expires_at: f.clock.now() + 1000 } } };
    await rejectsCode(f.api.execute(ctx, "erp_bling_disable", { ...input, command_id: "swapped" }), "BLING_COMMAND_CONFLICT");
    const wrong = { ...ctx, authorization: { ...ctx.authorization, confirmation: { ...ctx.authorization.confirmation, operation: "erp_bling_enable" } } };
    await rejectsCode(f.api.execute(wrong, "erp_bling_disable", input), "BLING_SCOPE_REQUIRED");
    f.clock.advance(1001);
    await rejectsCode(f.api.execute(ctx, "erp_bling_disable", input), "BLING_SCOPE_REQUIRED");
    ctx.authorization.confirmation.expires_at = f.clock.now() + 1000;
    assert.equal((await f.api.execute(ctx, "erp_bling_disable", input)).configuration.collect_enabled, false); f.verify();
  } finally { f.close(); }
});

test("limites, escopos, geração e hash de prévia são conferidos antes da coleta/apagamento", async () => {
  const f = fixture();
  try {
    const apply = { ...command(), generation: "1", scope: { all: true, entities: [] }, preview_hash: hashA, confirmed: true };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_purge_apply", { ...apply, generation: "2" }), "BLING_GENERATION_RETIRED");
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_purge_apply", { ...apply, preview_hash: hashB }), "BLING_REVISION_CONFLICT");
    f.preview.blocked_references = 1;
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_purge_apply", apply), "BLING_ARCHIVE_REFERENCED"); assert.equal(f.calls.purge, 0);
    f.preview.blocked_references = 0;
    assert.equal((await f.api.execute(f.ctx, "erp_bling_purge_apply", apply)).work_id, "purge-1");
    f.db.prepare("UPDATE wb_bling_control SET credential_scopes='[]'").run();
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command("scope"), resource_keys: ["products"] }), "BLING_SCOPE_REQUIRED");
    f.db.prepare("UPDATE wb_bling_control SET state='blocked_capacity'").run();
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command("capacity"), resource_keys: ["products"] }), "BLING_CAPACITY_STOP"); f.verify();
  } finally { f.close(); }
});

test("consulta detecta resposta de outra área/conta e revogação durante I/O", async () => {
  const f = fixture();
  try {
    f.record.identity.profile = "other";
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_record_get", { entity: "products", id: "1" }), "BLING_ACCOUNT_MISMATCH");
    f.deps.archive.readXml = async () => {
      await f.api.execute(f.ctx, "erp_bling_disable", command("during-read"));
      return { bytes: new Uint8Array([1]), sha256: hashA, filename: "nota.xml", content_type: "application/xml" };
    };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_xml_get", { object_id: "xml-1" }), "BLING_GENERATION_RETIRED"); f.verify();
  } finally { f.close(); }
});

test("segredos gerados só em memória não saem de exceções, DTO inválido, recibo nem auditoria", async () => {
  const f = fixture(), secret = randomBytes(32).toString("base64url");
  try {
    const input = { ...command(), client_id: randomBytes(24).toString("base64url"), client_secret: secret };
    const saved = await f.api.execute(f.ctx, "erp_bling_app_save", input);
    assertNoSecrets(saved, [secret, input.client_id]);
    assertNoSecrets(f.db.prepare("SELECT * FROM wb_bling_receipt").all(), [secret, input.client_id]);
    assertNoSecrets(f.db.prepare("SELECT * FROM wb_bling_audit").all(), [secret, input.client_id]);
    f.deps.archive.listRecords = () => { const error = new BlingError("BLING_RETRY_WAIT", { retry_at: f.clock.now() + 30000 }); error.message = secret; throw error; };
    const response = await handlePublicBlingRequest(new Request(`https://installation.invalid/api/v1/profiles/${area}/erp/v1/receber-bling/acervo?entity=products`), f.ctx, f.api);
    assert.equal(response.status, 503); assertNoSecrets(await response.text(), [secret]);
    f.deps.archive.listRecords = () => ({ items: [], next_cursor: null, access_token: secret });
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_records_list", { entity: "products" }), "BLING_RESPONSE_INVALID"); f.verify();
  } finally { f.close(); }
});

test("desconexão continua separada, recupera erro do cofre e mantém acervo", async () => {
  const f = fixture();
  try {
    const disconnect = f.deps.authorization.disconnect;
    f.deps.authorization.disconnect = async () => { throw new Error(randomBytes(20).toString("hex")); };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_disconnect", command()), "BLING_RESPONSE_INVALID");
    assert.equal(f.control.read(f.ctx).configuration.collect_enabled, false);
    f.deps.authorization.disconnect = disconnect;
    const done = await f.api.execute(f.ctx, "erp_bling_disconnect", command());
    assert.equal(done.configuration.credential.authorized, false);
    const replay = await f.api.execute(f.ctx, "erp_bling_disconnect", command());
    assert.deepEqual(replay.receipt, done.receipt); assert.equal(f.calls.disconnect, 1);
    assert.equal((await f.api.execute(f.ctx, "erp_bling_record_get", { entity: "products", id: "1" })).raw.version, "1"); f.verify();
  } finally { f.close(); }
});

test("todas operações são públicas e tipadas; stage, commit, adoção e envio não têm rota", () => {
  assert.equal(Object.keys(BLING_OPERATIONS).length, 18);
  for (const op of Object.values(BLING_OPERATIONS)) {
    assert.ok(op.summary.length > 10); assert.deepEqual(op.requirement.all, ["erp"]);
    if (op.name === "erp_bling_oauth_callback") continue;
    const suffix = op.path === "/" ? "" : op.path.replace(/:[A-Za-z_]+/g, "1");
    assert.equal(matchPublicBlingRoute(op.method, `/api/v1/profiles/${area}/erp/v1/receber-bling${suffix}`, area).name, op.name);
  }
  for (const suffix of ["stage", "commit", "adotar", "enviar", "claim", "ack", "reservar"])
    assert.equal(matchPublicBlingRoute("POST", `/api/v1/profiles/${area}/erp/v1/receber-bling/${suffix}`, area), null);
});

test("cada operação alcança a porta comum com bot configurado; sem concessão e origem externa não chegam", async () => {
  for (const name of BLING_OPERATION_NAMES) {
    const f = fixture({ access: allAccess() });
    try {
      const admin = command(name), query = { entity: "products", id: "1" };
      const inputs = {
        erp_bling_status: {}, erp_bling_resources: {},
        erp_bling_configure: { ...admin, selections: selection, daily_call_limit: 200, access: allAccess(), ai_disclosure_acknowledged: true },
        erp_bling_app_save: { ...admin, client_id: randomBytes(20).toString("hex"), client_secret: randomBytes(32).toString("hex") },
        erp_bling_enable: { ...admin, warning_confirmed: true, checklist_hash: hashA },
        erp_bling_disable: admin, erp_bling_oauth_start: admin, erp_bling_disconnect: admin,
        erp_bling_oauth_callback: { state: randomBytes(32).toString("hex"), code: randomBytes(32).toString("hex"), callback_url: `https://installation.invalid/api/public/erp-bling/${area}/callback` },
        erp_bling_collect_request: { ...admin, resource_keys: ["products"] },
        erp_bling_records_list: { entity: "products" }, erp_bling_record_get: query, erp_bling_versions_list: query,
        erp_bling_xml_list: {}, erp_bling_xml_get: { object_id: "xml-1" },
        erp_bling_purge_preview: { scope: { all: true, entities: [] }, generation: "1" },
        erp_bling_purge_apply: { ...admin, scope: { all: true, entities: [] }, generation: "1", preview_hash: hashA, confirmed: true },
        erp_bling_command_get: { id: "seed-command" },
      };
      if (name === "erp_bling_command_get") f.control.finish(f.ctx, "erp_bling_disable", command("seed-command"), hashA);
      const bot = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, is_agent: true } }, authorization: { bot: { id: "bot-1", allowed_operations: [...BLING_OPERATION_NAMES], allowed_entities: [...BLING_ENTITIES], data_scopes: ["public", "raw", "personal", "sensitive", "xml"], allow_sensitive: true } } };
      const call = ctx => name === "erp_bling_oauth_callback" ? f.api.callback(ctx, inputs[name]) : f.api.execute(ctx, name, inputs[name]);
      await rejectsCode(call({ ...bot, authorization: undefined }), "BLING_SCOPE_REQUIRED");
      await rejectsCode(call({ ...bot, origin: "external" }), "BLING_ADMIN_REQUIRED");
      const result = await call(bot);
      assert.ok(BLING_OPERATIONS[name].output.safeParse(result).success, name);
      f.verify();
    } finally { f.close(); }
  }
});

test("uma porta que falha após gravar reverte o pedido síncrono, permitindo recuperação única", async () => {
  const f = fixture();
  try {
    const original = f.deps.collection.requestCollection;
    const input = { ...command("crash"), resource_keys: ["products"] };
    f.deps.collection.requestCollection = (ctx, request) => { original(ctx, request); throw new Error("Resposta perdida antes do commit externo."); };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", input), "BLING_RESPONSE_INVALID");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 0);
    assert.equal(f.db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource='products'").get().checkpoint_version, 0);
    f.deps.collection.requestCollection = original;
    const done = await f.api.execute(f.ctx, "erp_bling_collect_request", input);
    assert.equal(done.receipt.command_id, "crash");
    await f.api.execute(f.ctx, "erp_bling_collect_request", input);
    assert.equal(f.calls.collect, 2); // Uma tentativa revertida e uma confirmada.
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 1); f.verify();
  } finally { f.close(); }
});

test("espera de quota persiste no agendamento e replay; bot não seleciona entidade fora da concessão", async () => {
  const f = fixture({ access: allAccess() });
  try {
    const until = f.clock.now() + 60000;
    f.db.prepare("UPDATE wb_bling_control SET next_allowed_at=?").run(until);
    const input = { ...command(), resource_keys: ["products"] };
    assert.equal((await f.api.execute(f.ctx, "erp_bling_collect_request", input)).next_wake, until);
    assert.equal((await f.api.execute(f.ctx, "erp_bling_collect_request", input)).next_wake, until);
    const bot = { ...f.ctx, identity: { ...f.ctx.identity, actor: { ...f.ctx.identity.actor, is_agent: true } }, authorization: { bot: { id: "bot-1", allowed_operations: [...BLING_OPERATION_NAMES], allowed_entities: ["contacts"], data_scopes: ["public"], allow_sensitive: true } } };
    await rejectsCode(f.api.execute(bot, "erp_bling_collect_request", { ...input, command_id: "other" }), "BLING_SCOPE_REQUIRED");
    await rejectsCode(f.api.execute(bot, "erp_bling_enable", { ...command("enable"), warning_confirmed: true, checklist_hash: hashA }), "BLING_SCOPE_REQUIRED");
    assert.equal(f.calls.collect, 1); f.verify();
  } finally { f.close(); }
});

test("fronteira assíncrona usa apenas GET do Bling simulado e não altera tabela operacional", async () => {
  const f = fixture();
  try {
    f.deps.archive.readXml = async () => {
      const response = await f.fake.fetch(f.fake.baseUrl + "/produtos/1", { method: "GET" });
      assert.equal(response.status, 200);
      return { bytes: new TextEncoder().encode("<nfe/>"), sha256: hashA, filename: "nota.xml", content_type: "application/xml" };
    };
    await f.api.execute(f.ctx, "erp_bling_xml_get", { object_id: "xml-1" });
    assert.equal(f.fake.callCount, 1); assert.ok(f.fake.calls.every(call => call.method === "GET")); f.verify();
  } finally { f.close(); }
});

test("os seis arquivos de org-api usam UTF-8 sem BOM e LF", () => {
  for (const file of ["src/erp/bling/operations.ts", "src/erp/bling/routes.ts", "src/erp/bling/control.ts", "src/erp/bling/permissions.ts", "tests/erp/org/api.test.mjs", "tests/org-api.test.ts"]) {
    const bytes = readFileSync(new URL("../../../" + file, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191], file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.includes("\r"), false, file);
  }
});

test("recibo rejeitado ou de outra geração não vira sucesso; projeção não substitui bruto conferido", async () => {
  const f = fixture();
  try {
    const original = f.deps.collection.requestCollection;
    f.deps.collection.requestCollection = (ctx, input) => ({ run_id: "run-1", next_wake: null,
      receipt: { command_id: input.command_id, request_hash: ctx.authorization.request_hash, generation: "1", operation: "erp_bling_collect_request", state: "rejected", committed_at: f.clock.iso(), references: {}, counts: {}, error: new BlingError("BLING_SCOPE_REQUIRED").toJSON() } });
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command(), resource_keys: ["products"] }), "BLING_SCOPE_REQUIRED");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 0);
    f.deps.collection.requestCollection = (ctx, input) => { const result = original(ctx, input); return { ...result, receipt: { ...result.receipt, generation: "2" } }; };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_collect_request", { ...command(), resource_keys: ["products"] }), "BLING_GENERATION_RETIRED");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 0);
    const project = f.deps.archive.project;
    f.deps.archive.project = (...args) => ({ ...project(...args), raw: { ...f.record, payload_text: "conteúdo de outra área" } });
    assert.equal((await f.api.execute(f.ctx, "erp_bling_record_get", { entity: "products", id: "1" })).raw.payload_text, f.record.payload_text); f.verify();
  } finally { f.close(); }
});

test("URL de retorno contaminada e geração aposentada durante cofre são recusadas", async () => {
  const f = fixture(), secret = randomBytes(32).toString("hex");
  try {
    const input = { ...command(), client_id: randomBytes(20).toString("hex"), client_secret: secret };
    const receipt = ctx => ({ command_id: input.command_id, request_hash: ctx.authorization.request_hash, generation: "1", operation: "erp_bling_app_save", state: "committed", committed_at: f.clock.iso(), references: {}, counts: {}, error: null });
    f.deps.authorization.saveApplication = async ctx => ({ configured: true, revision: "1", receipt: receipt(ctx), callback_url: `https://installation.invalid/api/public/erp-bling/${area}/callback?private=${secret}` });
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_app_save", input), "BLING_RESPONSE_INVALID");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 0);
    f.deps.authorization.saveApplication = async ctx => {
      f.db.prepare("UPDATE wb_bling_control SET generation=2,collect_enabled=0,state='off'").run();
      return { configured: true, revision: "1", receipt: receipt(ctx), callback_url: `https://installation.invalid/api/public/erp-bling/${area}/callback` };
    };
    await rejectsCode(f.api.execute(f.ctx, "erp_bling_app_save", input), "BLING_GENERATION_RETIRED");
    assert.equal(f.db.prepare("SELECT count(*) n FROM wb_bling_receipt").get().n, 0);
    assertNoSecrets(f.db.prepare("SELECT * FROM wb_bling_audit").all(), [secret]); f.verify();
  } finally { f.close(); }
});

test("recibo terminal de apagamento recupera resposta mesmo após aposentar geração", async () => {
  const f = fixture();
  try {
    const input = { ...command(), generation: "1", scope: { all: true, entities: [] }, preview_hash: hashA, confirmed: true };
    const digest = await hash(new TextEncoder().encode(JSON.stringify(input)));
    const receipt = f.control.finish(f.ctx, "erp_bling_purge_apply", input, digest, { references: { work_id: "purge-1" } });
    f.db.prepare("UPDATE wb_bling_control SET generation=2,collect_enabled=0,state='off'").run();
    const replay = await f.api.execute(f.ctx, "erp_bling_purge_apply", input);
    assert.deepEqual(replay.receipt, receipt); assert.equal(replay.work_id, "purge-1"); assert.equal(f.calls.purge, 0); f.verify();
  } finally { f.close(); }
});
