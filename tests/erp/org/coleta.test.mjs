import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { FakeBling, FakeClock } from "./fake-bling.mjs";
import { assertNoSecrets, assertOperationalUnchanged, guardCollectionDriver, operationalSnapshot } from "./contract-checks.mjs";
import { BLING_LEGACY_ENTITIES, BLING_EXTRA_ENTITIES, BlingError } from "../../../src/erp/bling/contracts.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { resourceDescriptorSchema } from "../../../src/erp/bling/schema.ts";
import { BLING_RESOURCES, BLING_RESOURCE_LANES, getBlingResource, buildBlingListQuery } from "../../../src/erp/bling/resources.ts";
import { createBlingDataClient, parseBlingResponse } from "../../../src/erp/bling/client.ts";
import { createCollectionStore, remoteTimestampMillis, semanticHash } from "../../../src/erp/bling/repository.ts";
import { advanceWindow, captureRepairEligible, chooseFair, collectionBackoff, financeRefreshEligible, finishPageItem, localTimestamp, nextWindow, pageSlice } from "../../../src/erp/bling/planner.ts";
import { createBlingWake } from "../../../src/erp/bling/wake.ts";

const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const expected = { generation: "1", authorization_revision: "1", credential_revision: "1", configuration_revision: "1", account_id: "account", parts_revision: "1" };
const bytes = text => new TextEncoder().encode(text);
const parts = normalizeErpParts({ products: false, sales: false, stock: false, finance: false, fiscal: false, billing: false, pos: false, purchases: false });
const actor = { user_id: "b6000000-0000-4000-8000-000000000001", name: "Pessoa", email: null, erp_role: "admin", verified_factor: true, session_id: "b6000000-0000-4000-8000-000000000002", aal: "aal2", is_agent: false };
function context(clock = new FakeClock()) {
  return { profile: "org-coleta", origin: "internal", clock, identity: { actor: null, people: [], parts, partsControl: { profile: "org-coleta", revision: "1", expires_at: clock.now() + 360_000 } } };
}
function officialResources() {
  return BLING_RESOURCES.map(resource => resource.confirmation === "nao_confirmado" ? resource : {
    ...resource, confirmation: "oficial_confirmado", officialEvidence: { url: "https://example.invalid/evidence", checked_at: "2026-11-19T12:00:00.000Z", scopes_checked: true, identity_checked: true, limits_checked: true },
  });
}
function clientFixture(options = {}) {
  const clock = new FakeClock(), ctx = context(clock), fake = new FakeBling({ clock });
  const privateValues = Array.from({ length: 4 }, () => randomBytes(24).toString("hex"));
  const credential = { client_id: privateValues[0], client_secret: privateValues[1], access_token: privateValues[2], refresh_token: privateValues[3], expires_at: clock.now() + 3600_000, scopes: [] };
  let credentialReads = 0, validations = 0;
  const authorization = { privateCredential: async () => { credentialReads++; return credential; } };
  const client = createBlingDataClient({ fetch: fake.fetch, authorization, revalidate: async () => { validations++; }, resources: officialResources(), baseUrl: fake.baseUrl, ...options });
  const request = (overrides = {}) => ({ method: "GET", resource_key: "contacts", path: "/contatos", query: { pagina: "1", limite: "10", criterio: "1", dataAlteracaoInicial: "2026-11-01 00:00:00", dataAlteracaoFinal: "2026-11-19 09:00:00" }, deadline: clock.now() + 3000, expected, ...overrides });
  return { clock, ctx, fake, privateValues, credential, authorization, client, request, reads: () => credentialReads, validations: () => validations };
}

test("A4 mantém as 18 identidades, todas as variantes e recursos adicionais sem endpoint presumido", () => {
  assert.deepEqual(BLING_RESOURCES.filter(resource => BLING_LEGACY_ENTITIES.includes(resource.entity)).map(resource => resource.entity).sort(), [...BLING_LEGACY_ENTITIES].sort());
  for (const resource of BLING_RESOURCES) resourceDescriptorSchema.parse(resource);
  for (const entity of BLING_EXTRA_ENTITIES) {
    const resource = getBlingResource(entity);
    assert.equal(resource.confirmation, "nao_confirmado");
    for (const field of ["path", "pagination", "detail", "dateFilter", "deletedEvidence"]) assert.equal(resource[field], null);
    assert.equal(resource.defaultSelected, false);
  }
  assert.equal(BLING_RESOURCE_LANES.filter(lane => lane.entity === "products").length, 6);
  assert.equal(BLING_RESOURCE_LANES.filter(lane => lane.entity === "nfe").length, 4);
  assert.notEqual(getBlingResource("nfe").entity, getBlingResource("nfce").entity);
  assert.equal(getBlingResource("financial_categories").pagination.short_page_ends, false);
  assert.equal(getBlingResource("cash_entries").pagination.limit_parameter, false);
  const cash = buildBlingListQuery("cash_entries_registered", { from: "2026-11-01", to: "2026-11-19", page: 1 });
  assert.ok(!Object.hasOwn(cash, "limite"));
  assert.equal(String(cash.situacaoConciliacao), "3");
});

test("recurso adicional só monta paginação pelo descritor completo oficialmente conferido", () => {
  const extra = { ...getBlingResource("contracts"), key: "contracts", path: "/recurso-simulado", detail: { path: "/recurso-simulado/{id}", required: true },
    pagination: { strategy: "page", page_size: 10, limit_parameter: true, short_page_ends: true }, dateFilter: { kind: "U", from: null, to: null, time_zone: "America/Sao_Paulo", overlap_minutes: 15 },
    identityRule: { kind: "global", parent_entity: null }, parser: "json", confirmation: "oficial_confirmado", officialEvidence: officialResources()[0].officialEvidence };
  assert.deepEqual(buildBlingListQuery("contracts", { page: 2 }, extra), { pagina: "2", limite: "10" });
  assert.throws(() => buildBlingListQuery("contracts", { page: 2 }, { ...extra, confirmation: "nao_confirmado" }), BlingError);
  assert.equal(getBlingResource("contracts").path, null);
});

test("cliente faz uma tentativa GET e não entrega credenciais em URL, retorno ou erro", async () => {
  const f = clientFixture();
  f.fake.resource("/contatos", [{ id: "9007199254740993123", nome: "Contato" }]);
  const result = await f.client.get(f.ctx, f.request());
  assert.equal(result.kind, "success");
  assert.equal(f.fake.callCount, 1);
  assert.ok(f.validations() >= 2);
  assertNoSecrets({ result, calls: f.fake.calls }, f.privateValues);
  f.fake.assertReadOnly();
});

test("cliente não aceita método, origem, caminho, recurso ou parâmetros arbitrários", async () => {
  const f = clientFixture();
  for (const overrides of [
    { method: "POST" }, { path: "https://attacker.invalid/contatos" }, { path: "/contatos/../produtos" },
    { path: "/contatos%2f1" }, { path: "/produtos" }, { path: "/contatos/1?secret=1" },
    { resource_key: "contracts", path: "/contratos" }, { query: { access_token: f.privateValues[2] } },
  ]) {
    const result = await f.client.get(f.ctx, f.request(overrides));
    assert.notEqual(result.kind, "success");
    assertNoSecrets(result, f.privateValues);
  }
  assert.equal(f.fake.callCount, 0);
  assert.equal(f.reads(), 0);
  assert.throws(() => createBlingDataClient({ fetch: f.fake.fetch, authorization: f.authorization, revalidate: async () => {}, baseUrl: "https://attacker.invalid/Api/v3" }), BlingError);
});

test("cliente recusa referência não confirmada antes de obter credencial", async () => {
  const f = clientFixture({ resources: BLING_RESOURCES });
  const result = await f.client.get(f.ctx, f.request());
  assert.equal(result.kind, "failure");
  assert.equal(result.error.code, "BLING_RESOURCE_UNCONFIRMED");
  assert.equal(f.reads(), 0);
  assert.equal(f.fake.callCount, 0);
});

test("429 respeita Retry-After; 5xx, truncamento, redirect, 401 e 403 são saneados sem repetição interna", async () => {
  const f = clientFixture();
  f.fake.queue({ status: 429, retryAfter: 60 }).queue({ status: 503 })
    .queue({ truncated: true }).queue({ status: 302, headers: { location: "https://attacker.invalid/" } })
    .queue({ status: 401 }).queue({ status: 403 });
  const rate = await f.client.get(f.ctx, f.request());
  assert.equal(rate.kind, "retry");
  assert.ok(rate.retry_at >= f.clock.now() + 60_000);
  const server = await f.client.get(f.ctx, f.request());
  assert.equal(server.kind, "retry");
  const truncated = await f.client.get(f.ctx, f.request());
  assert.equal(truncated.kind, "retry");
  const redirect = await f.client.get(f.ctx, f.request());
  assert.equal(redirect.kind, "failure");
  const unauthorized = await f.client.get(f.ctx, f.request());
  assert.equal(unauthorized.error.code, "BLING_AUTH_REQUIRED");
  const forbidden = await f.client.get(f.ctx, f.request());
  assert.equal(forbidden.error.code, "BLING_SCOPE_REQUIRED");
  assert.equal(f.fake.callCount, 6);
  assertNoSecrets([rate, server, truncated, redirect, unauthorized, forbidden], f.privateValues);
  f.fake.assertReadOnly();
});

test("resposta excedente e deadline vencido nunca são aceitos como página válida", async () => {
  const f = clientFixture({ maxResponseBytes: 128 });
  f.fake.queue({ body: JSON.stringify({ data: [{ id: "1", nome: "x".repeat(512) }] }) });
  assert.notEqual((await f.client.get(f.ctx, f.request())).kind, "success");
  assert.equal(f.fake.callCount, 1);
  assert.notEqual((await f.client.get(f.ctx, f.request({ deadline: f.clock.now() }))).kind, "success");
  assert.equal(f.fake.callCount, 1);
});

test("deadline injetado também limita revalidação pendente antes do HTTP", async () => {
  let expire, cleared = 0;
  const timer = { set(callback, milliseconds) { assert.equal(milliseconds, 3000); expire = callback; return 1; }, clear() { cleared++; } };
  const f = clientFixture({ timer, revalidate: () => new Promise(() => {}) });
  const pending = f.client.get(f.ctx, f.request());
  assert.equal(typeof expire, "function");
  f.clock.advance(3000); expire();
  const result = await pending;
  assert.equal(result.kind, "retry");
  assert.equal(f.fake.callCount, 0);
  assert.equal(f.reads(), 0);
  assert.equal(cleared, 1);
});

test("captura lexical conserva IDs, dinheiro e quantidades e rejeita chaves duplicadas", async () => {
  const text = '{"data":{"id":90071992547409931234567890,"preco":12345678901234567890.123456789,"pesoLiquido":0.0000000000000000001}}';
  const parsed = await parseBlingResponse("products", "/produtos/90071992547409931234567890", bytes(text));
  assert.equal(parsed.items[0].id, "90071992547409931234567890");
  assert.match(parsed.items[0].payload_text, /12345678901234567890\.123456789/);
  assert.match(parsed.items[0].payload_text, /0\.0000000000000000001/);
  assert.ok(parsed.items[0].capture.values.some(item => item.path === "/preco" && item.lexeme === "12345678901234567890.123456789"));
  for (const invalid of ['{"data":{"id":"1","preco":1,"preco":2}}', '{"data":{"id":"2"}}', '{"data":']) {
    await assert.rejects(parseBlingResponse("products", "/produtos/1", bytes(invalid)), BlingError);
  }
});

test("parsers cobrem as 18 entidades; estoque conserva precisão por produto e divergência entre partições", async () => {
  for (const entity of BLING_LEGACY_ENTITIES) {
    const resource = getBlingResource(entity);
    const path = entity === "stock_balances" ? resource.path : resource.detail.path.replace("{id}", "7");
    const text = entity === "stock_balances" ? '{"data":[{"produto":{"id":"7"},"saldoFisicoTotal":12.0000000000000001,"depositos":[{"id":"3","saldoFisico":12.0000000000000001}]}]}' : '{"data":{"id":"7","nome":"Observado"}}';
    const parsed = await parseBlingResponse(entity, path, bytes(text));
    assert.equal(parsed.items[0].id, "7", entity);
    if (entity === "stock_balances") {
      assert.equal(parsed.items[0].capture.source, "stock_product");
      assert.ok(parsed.items[0].capture.values.some(token => token.lexeme === "12.0000000000000001"));
      const changed = await parseBlingResponse(entity, path, bytes(text.replaceAll("12.0000000000000001", "-0.0000000000000001")));
      assert.notEqual(changed.items[0].payload_text, parsed.items[0].payload_text);
    }
  }
});

test("planejador alterna recente/histórico, sobrepõe quinze minutos e página curta não encerra source_page", () => {
  const now = Date.UTC(2026, 10, 19, 12), resource = getBlingResource("contacts");
  const selection = { key: "contacts", selected: true, from: "2026-01-01", to: null };
  assert.equal(localTimestamp(now), "2026-11-19 09:00:00");
  const recent = nextWindow(resource, {}, now, selection);
  const completed = advanceWindow(recent, 0, now);
  const history = nextWindow(resource, completed, now, selection);
  assert.equal(history.lane, "history");
  assert.equal(history.cursor.from, "2026-01-01 00:00:00");
  const again = nextWindow(resource, { ...completed, nextLane: "recent" }, now + 60_000, selection);
  assert.equal(again.cursor.from, "2026-11-19 08:45:00");
  const categories = nextWindow(getBlingResource("financial_categories"), {}, now, { ...selection, key: "financial_categories" });
  assert.equal(advanceWindow(categories, 3, now, true).unfiltered.page, 2);
  assert.equal(advanceWindow(categories, 0, now, true).unfiltered, undefined);
});

test("página mutável reinicia offset e conserva IDs/fingerprint/subcursor de recortes limitados", () => {
  const state = { cp: {}, lane: "unfiltered", cursor: { page: 1, offset: 10, list_fingerprint: digest("old"), started_at: "2026-11-19T12:00:00.000Z" } };
  const ids = Array.from({ length: 25 }, (_, index) => String(index + 1));
  const stable = pageSlice(state, ids, digest("old"), true);
  assert.deepEqual(stable.ids, ids.slice(10, 20));
  const changed = pageSlice(state, [...ids].reverse(), digest("new"), true);
  assert.deepEqual(changed.ids, [...ids].reverse().slice(0, 10));
  assert.equal(changed.subcursor, 0);
  assert.equal(changed.more, true);
  assert.equal(JSON.stringify(changed).includes("payload"), false);
});

test("justiça por entidade impede seis variantes de produto de causar fome de contatos", () => {
  const candidates = ["p0", "p1", "p2", "p3", "p4", "p5"].map(key => ({ key, entity: "products", last_served_at: 0, not_before: 0 }));
  candidates.push({ key: "contacts", entity: "contacts", last_served_at: 0, not_before: 0 });
  const served = [];
  for (let now = 1; now <= 14; now++) {
    const next = chooseFair(candidates, now);
    served.push(next.entity); next.last_served_at = now;
  }
  assert.equal(served.filter(entity => entity === "contacts").length, 7);
  assert.equal(chooseFair([{ key: "blocked", entity: "contacts", last_served_at: 0, not_before: 100 }], 99), null);
});

test("recaptura escolhe títulos antigos abertos/parciais e precisão faltante; 404 conserva espera específica", () => {
  const now = Date.UTC(2026, 10, 19, 12), base = { identity: { entity: "receivables" }, payload_text: '{"id":"1","situacao":1,"saldo":null}', observed_at: "2026-10-19T12:00:00.000Z" };
  assert.equal(financeRefreshEligible(base, now), true);
  assert.equal(financeRefreshEligible({ ...base, payload_text: '{"id":"1","situacao":3}' }, now), true);
  assert.equal(financeRefreshEligible({ ...base, payload_text: '{"id":"1","situacao":2}' }, now), false);
  assert.equal(financeRefreshEligible({ ...base, observed_at: new Date(now).toISOString() }, now), false);
  assert.equal(captureRepairEligible({ ...base, identity: { entity: "products" }, capture: null, deleted: false }), true);
  assert.equal(captureRepairEligible({ ...base, identity: { entity: "products" }, capture: null, deleted: true }), false);
  assert.equal(collectionBackoff("finance_refresh", 404, 1, now, "same"), now + 3600_000);
  assert.equal(collectionBackoff("capture_repair", 404, 1, now, "same"), now + 86_400_000);
  assert.equal(collectionBackoff("detail", 503, 2, now, "same"), collectionBackoff("detail", 503, 2, now, "same"));
});

function storeFixture(options = {}) {
  const db = freshLite(), clock = new FakeClock(), ctx = context(clock), writes = [];
  let id = 0, occupied = 100_000;
  db.prepare(`INSERT INTO wb_bling_control(id,revision,generation,authorization_revision,credential_revision,collect_enabled,state,account_id,selection,approved_by,approved_at,approval_hash,credential_status,updated_at)
    VALUES(1,1,1,1,1,1,'ready','account',?,?,?,?, 'ready',?)`).run(
    JSON.stringify([{ key: "contacts", selected: true, from: null, to: null }]), actor.user_id, clock.now(), digest("approval"), clock.now());
  const driver = guardCollectionDriver(nodeDriver(db), writes);
  const store = createCollectionStore({ db: driver, randomId: () => `id-${++id}`, databaseSize: () => occupied, ...options });
  const baseline = operationalSnapshot(db);
  const identity = { profile: ctx.profile, account_id: expected.account_id, entity: "contacts", source_id: "1" };
  function makeUnit(overrides = {}) {
    const serial = ++id;
    return { work_id: `work-${serial}`, attempt_id: `attempt-${serial}`, command_id: `command-${serial}`, request_hash: digest(`request-${serial}`), kind: "detail", entity: "contacts", source_id: "1", resource_key: "contacts", phase: "queued", expected,
      checkpoint: store.checkpoint("contacts"), lease: null, not_before: clock.now(), plan: {}, page: null, progress: {}, ...overrides };
  }
  function reserve(input = makeUnit(), owner = "collector") {
    return store.markFetching(ctx, store.reserve(ctx, { unit: input, owner, lease_until: clock.now() + 4000 }).unit);
  }
  function record(name, overrides = {}) {
    const payload_text = JSON.stringify({ id: identity.source_id, nome: name });
    const current = store.readCurrent(ctx, identity);
    const hash = semanticHash(payload_text, overrides.document_links ?? []);
    return { identity, version: current?.semantic_hash === hash ? current.version : String(Number(current?.version ?? 0) + 1), semantic_hash: hash, payload_text, document_links: [], observed_at: clock.iso(), source_updated_at: null, source_time_quality: "unknown", deleted: false, deletion_evidence: null, capture: null, ...overrides };
  }
  function commit(unit, incoming, overrides = {}) {
    const current = store.readCurrent(ctx, identity);
    return store.commitBatch(ctx, { unit, expected: unit.expected, fence: unit.lease.fence, request_hash: unit.request_hash, records: incoming ? [incoming] : [],
      next_checkpoint: { ...unit.checkpoint, revision: String(Number(unit.checkpoint.revision) + 1), cursor: { step: unit.work_id } },
      source_expectations: incoming ? [{ identity, version: current?.version ?? null, semantic_hash: current?.semantic_hash ?? null }] : [], counts: { observed: incoming ? 1 : 0 }, ...overrides });
  }
  return { db, driver, store, clock, ctx, writes, baseline, identity, makeUnit, reserve, record, commit, setSize: value => { occupied = value; }, close: () => db.close() };
}

test("A→B→A são três versões; replay consulta recibo antes do checkpoint antigo e não duplica inbox/estatística", () => {
  const f = storeFixture();
  try {
    const first = f.reserve(), a = f.record("A");
    const receipt = f.commit(first, a);
    const checkpoint = f.store.checkpoint("contacts");
    assert.equal(checkpoint.cursor.observed_count, 1); assert.equal(checkpoint.cursor.changed_count, 1);
    const counts = f.db.prepare("SELECT observed_count, archive_bytes FROM wb_bling_control").get();
    assert.deepEqual(f.commit(first, a, { source_expectations: [{ identity: f.identity, version: null, semantic_hash: null }] }), receipt);
    assert.deepEqual(f.store.checkpoint("contacts"), checkpoint);
    assert.deepEqual(f.db.prepare("SELECT observed_count, archive_bytes FROM wb_bling_control").get(), counts);
    f.clock.advance(1000);
    f.commit(f.reserve(), f.record("B"));
    f.clock.advance(1000);
    f.commit(f.reserve(), f.record("A"));
    assert.equal(f.store.readCurrent(f.ctx, f.identity).version, "3");
    assert.equal(f.store.checkpoint("contacts").cursor.observed_count, 3);
    assert.equal(f.store.checkpoint("contacts").cursor.changed_count, 3);
    const history = f.db.prepare("SELECT source_version,payload FROM erp_document_mirror__source_version WHERE entity='contacts' AND source_id='1' ORDER BY source_version").all();
    assert.deepEqual(history.map(row => row.source_version), [1, 2]);
    assert.deepEqual(history.map(row => JSON.parse(row.payload).nome), ["A", "B"]);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_sync__inbox WHERE entity='contacts' AND source_id='1'").get().n, 1);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("bruto adicional preservado por purge parcial continua na geração nova sem reescrever identidade", () => {
  const f = storeFixture(), key = { ...f.identity, entity: "contracts" };
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "contracts", selected: true, from: null, to: null }]));
    const collect = (name, generation) => {
      const previous = f.store.readCurrent(f.ctx, key), payload_text = JSON.stringify({ id: "1", nome: name });
      const work = f.reserve(f.makeUnit({ entity: "contracts", resource_key: "contracts", expected: { ...expected, generation }, checkpoint: f.store.checkpoint("contracts") }));
      const record = f.record(name, { identity: key, payload_text, semantic_hash: semanticHash(payload_text, []), version: previous ? previous.payload_text === payload_text ? previous.version : String(Number(previous.version) + 1) : "1" });
      return f.commit(work, record, { source_expectations: [{ identity: key, version: previous?.version ?? null, semantic_hash: previous?.semantic_hash ?? null }] });
    };
    collect("A", "1");
    // Estado final do purge de outra entidade: a geração ativa avança, mas
    // a identidade imutável do conteúdo que permaneceu não é adulterada.
    f.db.exec("UPDATE wb_bling_control SET generation=2");
    collect("A", "2"); collect("B", "2");
    assert.equal(f.store.readCurrent(f.ctx, key).version, "2");
    assert.equal(f.db.prepare("SELECT generation FROM wb_bling_extra_raw WHERE entity='contracts'").get().generation, 1);
    assert.deepEqual(f.db.prepare("SELECT version,generation FROM wb_bling_record_version WHERE entity='contracts' ORDER BY version").all().map(row => ({ ...row })), [{ version: 1, generation: 1 }, { version: 2, generation: 2 }]);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("mesmo comando com conteúdo diferente é conflito e não altera o recibo terminal", () => {
  const f = storeFixture();
  try {
    const unit = f.reserve(), receipt = f.commit(unit, f.record("A"));
    assert.throws(() => f.commit(unit, f.record("B")), error => error.code === "BLING_COMMAND_CONFLICT");
    assert.equal(f.store.readCurrent(f.ctx, f.identity).version, "1");
    assert.deepEqual(f.store.receipt(f.ctx, { command_id: unit.command_id, request_hash: unit.request_hash, generation: "1" }), receipt);
  } finally { f.close(); }
});

test("manutenção vazia de produto avança cursor sem exigir testemunha e não permite injetar fonte", () => {
  const f = storeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "products", selected: true, from: null, to: null }]));
    const unit = f.reserve(f.makeUnit({ entity: "products", source_id: null, resource_key: "products", kind: "capture_repair", plan: { local_only: true }, checkpoint: f.store.checkpoint("products") }));
    const identity = { ...f.identity, entity: "products" };
    assert.throws(() => f.commit(unit, f.record("Injetado", { identity }), { source_expectations: [{ identity, version: null, semantic_hash: null }] }), error => error.code === "BLING_RESPONSE_INVALID");
    assert.equal(f.store.readCurrent(f.ctx, identity), null);
    const receipt = f.commit(unit, null, { next_checkpoint: { ...unit.checkpoint, revision: "1", cursor: { turn: 4 } } });
    assert.equal(receipt.state, "committed"); assert.equal(f.store.checkpoint("products").cursor.turn, 4);
    const refused = f.reserve(f.makeUnit({ entity: "products", source_id: "1", resource_key: "products", kind: "capture_repair", plan: { local_only: true }, checkpoint: f.store.checkpoint("products") }));
    assert.throws(() => f.commit(refused, null), error => error.code === "BLING_RESPONSE_INVALID");
    assert.equal(f.store.checkpoint("products").cursor.turn, 4); assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("início, fim e cobertura da passagem são auditados no commit sem duplicar por replay", () => {
  const f = storeFixture();
  try {
    const unit = f.reserve(), incoming = f.record("A"), start = f.clock.iso();
    const envelope = { next_checkpoint: { ...unit.checkpoint, revision: "1", pass_started_at: start }, source_expectations: [{ identity: f.identity, version: null, semantic_hash: null }] };
    const receipt = f.commit(unit, incoming, envelope);
    assert.deepEqual(f.commit(unit, incoming, envelope), receipt);
    f.commit(f.reserve(), f.record("A"));
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM wb_bling_audit WHERE operation='erp_bling_pass_start'").get().n, 1);
    f.clock.advance(1000);
    const next = f.reserve(), completed = f.clock.iso();
    f.commit(next, f.record("B"), { next_checkpoint: { ...next.checkpoint, revision: String(Number(next.checkpoint.revision) + 1), pass_started_at: completed, pass_completed_at: completed } });
    const audits = f.db.prepare("SELECT operation,references_json FROM wb_bling_audit WHERE operation IN ('erp_bling_pass_start','erp_bling_pass_complete','erp_bling_coverage_changed') ORDER BY created_at,id").all();
    assert.equal(audits.filter(row => row.operation === "erp_bling_pass_start").length, 2);
    assert.equal(audits.filter(row => row.operation === "erp_bling_pass_complete").length, 1);
    assert.equal(audits.filter(row => row.operation === "erp_bling_coverage_changed").length, 1);
    assert.equal(JSON.parse(audits.find(row => row.operation === "erp_bling_coverage_changed").references_json).coverage_complete, false);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("posse expirada troca fence; renovação e commit atrasados não ressuscitam posse", () => {
  const f = storeFixture();
  try {
    const queued = f.makeUnit(), original = f.reserve(queued);
    const same = f.reserve(queued);
    assert.equal(same.lease.fence, original.lease.fence);
    assert.throws(() => f.reserve(queued, "another"), error => error.code === "BLING_LEASE_LOST");
    f.clock.advance(4001);
    assert.throws(() => f.store.renew(f.ctx, { work_id: original.work_id, attempt_id: original.attempt_id, owner: original.lease.owner, fence: original.lease.fence, lease_until: f.clock.now() + 4000 }), error => error.code === "BLING_LEASE_LOST");
    const taken = f.reserve(queued, "another");
    assert.notEqual(taken.lease.fence, original.lease.fence);
    assert.throws(() => f.commit(original, f.record("atrasado")), error => error.code === "BLING_LEASE_LOST");
    f.store.release(f.ctx, { work_id: original.work_id, owner: original.lease.owner, fence: original.lease.fence });
    f.commit(taken, f.record("vigente"));
    assert.equal(JSON.parse(f.store.readCurrent(f.ctx, f.identity).payload_text).nome, "vigente");
  } finally { f.close(); }
});

test("fonte comprovadamente anterior não substitui corrente e ausência não marca exclusão", () => {
  const f = storeFixture();
  try {
    f.commit(f.reserve(), f.record("recente", { source_updated_at: "2026-11-19T12:00:00.000Z", source_time_quality: "remote" }));
    f.clock.advance(1000);
    f.commit(f.reserve(), f.record("antigo", { source_updated_at: "2026-10-01T12:00:00.000Z", source_time_quality: "remote" }));
    f.commit(f.reserve(), null);
    const current = f.store.readCurrent(f.ctx, f.identity);
    assert.equal(current.version, "1");
    assert.equal(JSON.parse(current.payload_text).nome, "recente");
    assert.equal(current.deleted, false);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("conflito CAS e falta de espaço preservam fonte, checkpoint, recibo e estatísticas atomicamente", () => {
  const f = storeFixture();
  try {
    const unit = f.reserve(), before = f.store.checkpoint("contacts");
    assert.throws(() => f.commit(unit, f.record("A"), { source_expectations: [{ identity: f.identity, version: "3", semantic_hash: digest("missing") }] }), error => error.code === "BLING_REVISION_CONFLICT");
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.deepEqual(f.store.checkpoint("contacts"), before);
    f.setSize(7_999_999_999);
    assert.throws(() => f.commit(unit, f.record("A")), error => error.code === "BLING_CAPACITY_STOP");
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.deepEqual(f.store.checkpoint("contacts"), before);
    assert.equal(f.store.receipt(f.ctx, { command_id: unit.command_id, request_hash: unit.request_hash, generation: "1" }), null);
    assert.equal(f.db.prepare("SELECT observed_count FROM wb_bling_control").get().observed_count, 0);
  } finally { f.close(); }
});

test("queda SQL depois de gravar fonte desfaz histórico, inbox, checkpoint e contadores juntos", () => {
  const f = storeFixture();
  try {
    f.commit(f.reserve(), f.record("A"));
    const unit = f.reserve(), next = f.record("B"), checkpoint = f.store.checkpoint("contacts");
    const execute = f.driver.exec.bind(f.driver);
    f.driver.exec = (sql, ...params) => {
      if (sql.startsWith("INSERT INTO erp_sync__inbox")) throw new Error("queda antes do checkpoint");
      return execute(sql, ...params);
    };
    assert.throws(() => f.commit(unit, next), /queda antes do checkpoint/);
    assert.equal(JSON.parse(f.store.readCurrent(f.ctx, f.identity).payload_text).nome, "A");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_document_mirror__source_version").get().n, 0);
    assert.equal(f.db.prepare("SELECT observed_count FROM wb_bling_control").get().observed_count, 1);
    assert.deepEqual(f.store.checkpoint("contacts"), checkpoint);
    assert.equal(f.store.receipt(f.ctx, { command_id: unit.command_id, request_hash: unit.request_hash, generation: "1" }), null);
    f.driver.exec = execute;
    f.commit(unit, next);
    assert.equal(f.store.readCurrent(f.ctx, f.identity).version, "2");
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("captura precisa exige paths completos e nova prova lexical não cria versão semântica falsa", async () => {
  const f = storeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "products", selected: true, from: null, to: null }]));
    const identity = { ...f.identity, entity: "products" };
    const text = '{"data":{"id":"1","preco":12345678901234567890.123456789}}';
    const parsed = (await parseBlingResponse("products", "/produtos/1", bytes(text))).items[0];
    const hash = semanticHash(parsed.payload_text, []);
    const record = { ...f.record("unused"), identity, payload_text: parsed.payload_text, semantic_hash: hash, capture: { ...parsed.capture, revision: "1", semantic_hash: hash, semantic_version: "1" } };
    const unit = f.reserve(f.makeUnit({ entity: "products", resource_key: "products", checkpoint: f.store.checkpoint("products") }));
    const commit = (work, value, previous = null) => f.store.commitBatch(f.ctx, { unit: work, expected, fence: work.lease.fence, request_hash: work.request_hash, records: [value], next_checkpoint: { ...work.checkpoint, revision: String(Number(work.checkpoint.revision) + 1) }, source_expectations: [{ identity, version: previous?.version ?? null, semantic_hash: previous?.semantic_hash ?? null }], counts: { observed: 1 } });
    assert.throws(() => commit(unit, { ...record, capture: { ...record.capture, values: [] } }), error => error.code === "BLING_RESPONSE_INVALID");
    assert.equal(f.store.readCurrent(f.ctx, identity), null);
    commit(unit, record);
    const current = f.store.readCurrent(f.ctx, identity);
    assert.equal(current.capture.values[0].lexeme, "12345678901234567890.123456789");
    const second = f.reserve(f.makeUnit({ entity: "products", resource_key: "products", checkpoint: f.store.checkpoint("products") }));
    commit(second, { ...record, capture: { ...record.capture, revision: "2", bytes_sha256: digest(text + " ") } }, current);
    const observed = f.store.readCurrent(f.ctx, identity);
    assert.equal(observed.version, "1");
    assert.equal(observed.capture.revision, "2");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_document_mirror__source_version").get().n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_sync__inbox WHERE entity='products'").get().n, 1);
  } finally { f.close(); }
});

test("links existentes sobrevivem releitura vazia e mudança de links participa do hash comum", () => {
  const f = storeFixture();
  try {
    const links = [{ kind: "xml", reference: "opaque-file" }];
    f.commit(f.reserve(), f.record("A", { document_links: links }));
    const before = f.store.readCurrent(f.ctx, f.identity);
    f.commit(f.reserve(), f.record("A"));
    const after = f.store.readCurrent(f.ctx, f.identity);
    assert.deepEqual(after.document_links, links);
    assert.equal(after.version, before.version);
    assert.notEqual(semanticHash(after.payload_text, []), after.semantic_hash);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_document_mirror__source_version").get().n, 0);
  } finally { f.close(); }
});

test("pedido administrativo aplica pessoa ∩ bot e teto da origem externa", () => {
  const f = storeFixture();
  try {
    const input = { command_id: "admin-collect", expected_revision: "1", resource_keys: ["contacts"] };
    const app = { ...f.ctx, origin: "app", identity: { ...f.ctx.identity, actor } };
    assert.throws(() => f.store.requestCollection({ ...app, identity: { ...app.identity, actor: { ...actor, erp_role: "consulta" } } }, input), error => error.code === "BLING_ADMIN_REQUIRED");
    const bot = { ...app, identity: { ...app.identity, actor: { ...actor, is_agent: true } } };
    assert.throws(() => f.store.requestCollection(bot, input), error => error.code === "BLING_SCOPE_REQUIRED");
    const enabled = { ...bot, authorization: { bot: { id: "bot", allowed_operations: ["erp_bling_collect_request"], allowed_entities: ["contacts"], data_scopes: [], allow_sensitive: true } } };
    assert.throws(() => f.store.requestCollection({ ...enabled, origin: "external" }, input), error => error.code === "BLING_ADMIN_REQUIRED");
    assert.throws(() => f.store.requestCollection(enabled, input), error => error.code === "BLING_SCOPE_REQUIRED");
    f.db.prepare("UPDATE wb_bling_control SET permissions=?").run(JSON.stringify({ bots: [{ bot_id: "bot", operations: ["erp_bling_collect_request"], entities: ["contacts"] }] }));
    const result = f.store.requestCollection(enabled, input);
    assert.equal(result.receipt.state, "committed");
    assert.deepEqual(f.store.requestCollection(enabled, input), result);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("pedido manual separa passagens de entidade do trabalho XML e mantém replay integral", () => {
  const f = storeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?,permissions=?").run(JSON.stringify([{ key: "contacts", selected: true }, { key: "fiscal_xml", selected: true }]),
      JSON.stringify({ bots: [{ bot_id: "bot", operations: ["erp_bling_collect_request"], entities: ["nfe"] }] }));
    const app = { ...f.ctx, origin: "app", identity: { ...f.ctx.identity, actor } };
    const input = { command_id: "manual-with-xml", expected_revision: "1", resource_keys: ["contacts", "fiscal_xml"] };
    const result = f.store.requestCollection(app, input);
    assert.deepEqual(f.store.requestCollection(app, input), result);
    assert.equal(result.receipt.request_hash, digest(JSON.stringify(input))); assert.equal(result.receipt.references.xml_requested, true);
    assert.deepEqual(JSON.parse(f.db.prepare("SELECT cursor FROM erp_sync__run WHERE id=?").get(result.run_id).cursor).resources, ["contacts"]);
    const bot = { ...app, identity: { ...app.identity, actor: { ...actor, is_agent: true } }, authorization: { bot: { id: "bot", allowed_operations: ["erp_bling_collect_request"], allowed_entities: ["nfe"], data_scopes: [], allow_sensitive: true } } };
    const xmlInput = { command_id: "manual-only-xml", expected_revision: "1", resource_keys: ["fiscal_xml"] };
    const xml = f.store.requestCollection(bot, xmlInput), run = f.db.prepare("SELECT state,cursor FROM erp_sync__run WHERE id=?").get(xml.run_id);
    assert.equal(run.state, "done"); assert.deepEqual(JSON.parse(run.cursor), { resources: [], xml_requested: true, xml_complete: false });
    assert.deepEqual(f.store.requestCollection(bot, xmlInput), xml);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM erp_sync__run WHERE state IN ('queued','running')").get().n, 1);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

function wakeFixture(options = {}) {
  const f = storeFixture(), fake = new FakeBling({ clock: f.clock });
  fake.resource("/contatos", [{ id: "1", nome: "Atual" }]);
  fake.beforeRequest(call => { if (call.path === "/contatos" && call.query.criterio === "2") fake.queue({ data: { data: [] } }); });
  const secret = randomBytes(24).toString("hex");
  const authorization = { privateCredential: async () => ({ client_id: randomBytes(24).toString("hex"), client_secret: randomBytes(24).toString("hex"), access_token: secret, refresh_token: randomBytes(24).toString("hex"), expires_at: f.clock.now() + 3600_000, scopes: [] }), renew: async () => { throw new Error("renovação não esperada"); } };
  const resources = officialResources();
  let sequence = 0, baseOn = true;
  const readParts = async () => ({ profile: f.ctx.profile, revision: "1", expires_at: f.clock.now() + 300_000, parts: { ...parts, customers: baseOn } });
  const archive = { validateCapture: (_ctx, { record }) => record.capture };
  const data = createBlingDataClient({ fetch: fake.fetch, authorization, revalidate: async () => {}, resources, baseUrl: fake.baseUrl });
  const wake = createBlingWake({ collection: f.store, data, authorization, archive, readParts, revalidate: async () => {}, randomId: () => `wake-${++sequence}`, resources, ...options });
  const run = (overrides = {}) => wake.runOne(f.ctx, { deadline: f.clock.now() + 4000, nextOperationalAt: null, maxGets: 1, ...overrides });
  async function steps(count) {
    const results = [];
    for (let index = 0; index < count; index++) {
      const result = await run(); results.push(result);
      assert.ok(result.requests <= 1);
      if (result.nextWake !== null) f.clock.set(Math.max(f.clock.now() + 700, result.nextWake));
    }
    return results;
  }
  return { ...f, fake, wake, data, archive, authorization, secret, run, steps, setBase: value => { baseOn = value; } };
}

test("função ou Base desligada e deadline operacional insuficiente fazem zero chamadas", async () => {
  const f = wakeFixture();
  try {
    f.db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off'");
    assert.equal((await f.run()).requests, 0);
    assert.equal(await f.wake.nextWake(f.ctx), null);
    f.db.exec("UPDATE wb_bling_control SET collect_enabled=1,state='ready'");
    f.setBase(false);
    assert.equal((await f.run()).requests, 0);
    f.setBase(true);
    assert.equal((await f.run({ nextOperationalAt: f.clock.now() + 1200 })).requests, 0);
    assert.equal(f.fake.callCount, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wb_bling_unit").get().n, 0);
  } finally { f.close(); }
});

test("unidades duráveis dividem lista/detalhe e retomam depois de HTTP sem avançar duas vezes", async () => {
  let failOnce = true;
  const f = wakeFixture({ archive: { validateCapture: (_ctx, { record }) => { if (failOnce) { failOnce = false; throw new Error("queda após HTTP"); } return record.capture; } } });
  try {
    const first = await f.run();
    assert.equal(first.requests, 1);
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    const cp = f.store.checkpoint("contacts");
    assert.deepEqual(cp.cursor.page.ids, ["1"]);
    assert.equal(cp.cursor.page.subcursor, 0);
    f.clock.set(first.nextWake);
    await f.steps(8);
    const current = f.store.readCurrent(f.ctx, f.identity);
    assert.ok(current);
    assert.equal(current.version, "1");
    assert.equal(JSON.parse(current.payload_text).nome, "Atual");
    assert.ok(f.fake.calls.filter(call => call.path === "/contatos/1").length >= 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_sync__inbox WHERE entity='contacts' AND source_id='1'").get().n, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_document_mirror__source_version WHERE entity='contacts' AND source_id='1'").get().n, 0);
    assertNoSecrets({ calls: f.fake.calls, units: f.db.prepare("SELECT * FROM wb_bling_unit").all() }, [f.secret]);
    f.fake.assertReadOnly();
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("resposta perdida após commit reapresenta recibo sem repetir GET daquela unidade", async () => {
  const f = wakeFixture();
  try {
    const commit = f.store.commitBatch.bind(f.store);
    let interrupted = false;
    f.store.commitBatch = (ctx, input) => {
      const receipt = commit(ctx, input);
      if (!interrupted) { interrupted = true; throw new Error("resposta de commit perdida"); }
      return receipt;
    };
    const result = await f.run();
    assert.equal(result.worked, true);
    assert.equal(result.error, undefined);
    assert.equal(f.fake.callCount, 1);
    assert.equal(f.store.checkpoint("contacts").revision, "1");
    const persisted = f.db.prepare("SELECT id,command_id,phase FROM wb_bling_unit").get();
    assert.equal(persisted.phase, "committed");
    f.clock.set(result.nextWake);
    await f.run();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wb_bling_unit WHERE command_id=?").get(persisted.command_id).n, 1);
    assert.equal(f.fake.calls.filter(call => call.path === "/contatos" && call.query.criterio === "1").length, 1);
  } finally { f.close(); }
});

test("404 comum é pendência sem tombstone e quota diária impede chamadas", async () => {
  const f = wakeFixture();
  try {
    f.fake.setDetail("/contatos", "1", null);
    await f.steps(3);
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM wb_bling_unit WHERE error_code='BLING_RETRY_WAIT'").get().n >= 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wb_bling_record_version WHERE deleted_observed=1").get().n, 0);
    f.db.prepare("UPDATE wb_bling_control SET next_allowed_at=NULL,calls_today=1,daily_call_limit=1,calls_day=?").run(new Date(f.clock.now()).toISOString().slice(0, 10));
    const count = f.fake.callCount;
    await f.run();
    assert.equal(f.fake.callCount, count);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("429 pausa compartilhada por conta alcança outras entidades e não é ultrapassado por pedido manual", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify(["contacts", "sellers"].map(key => ({ key, selected: true, from: "2026-11-01", to: null }))));
    f.fake.resource("/vendedores", [{ id: "2", nome: "Vendedor" }]);
    f.fake.queue({ status: 429, retryAfter: 120 });
    const now = f.clock.now(), rate = await f.run();
    assert.equal(rate.requests, 1);
    assert.equal(rate.error.code, "BLING_RATE_WAIT");
    assert.ok(f.store.control().next_allowed_at >= now + 120_000);
    assert.equal((await f.run()).requests, 0);
    const app = { ...f.ctx, origin: "app", identity: { ...f.ctx.identity, actor } };
    f.store.requestCollection(app, { command_id: "request-during-rate", expected_revision: "1", resource_keys: ["sellers"] });
    assert.equal((await f.run()).requests, 0);
    assert.equal(f.fake.callCount, 1);
    f.clock.advance(119_999);
    assert.equal((await f.run()).requests, 0);
    assert.equal(f.fake.callCount, 1);
  } finally { f.close(); }
});

test("desligamento durante HTTP invalida o commit e não reinicia o trabalho", async () => {
  const f = wakeFixture();
  try {
    f.fake.beforeRequest(() => { f.db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off',authorization_revision=2"); });
    const result = await f.run();
    assert.equal(result.requests, 1);
    assert.equal(result.nextWake, null);
    assert.equal(f.store.checkpoint("contacts").revision, "0");
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.equal((await f.run()).requests, 0);
    assert.equal(f.fake.callCount, 1);
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("estoque retoma três partições por IDs conhecidos, conserva divergência e não inventa zero para ausente", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "stock_balances", selected: true, from: null, to: null }]));
    f.db.prepare("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,?)").run(f.clock.now());
    f.db.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES('products_zero',?)").run(f.clock.now());
    for (const id of ["1", "2"]) {
      const payload = JSON.stringify({ id, preco: 1 });
      f.db.prepare("INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES('products','products_zero',?,?,'[]',?,1,?,?,?)")
        .run(id, payload, semanticHash(payload, []), f.clock.now(), f.clock.now(), f.clock.now());
    }
    f.fake.beforeRequest(call => {
      if (call.path !== "/estoques/saldos") return;
      const value = { "0": "0.00000000000000001", "1": "12345678901234567890.123456789", "2": "-0.00000000000000001" }[call.query.filtroSaldoEstoque];
      f.fake.queue({ body: '{"data":[{"produto":{"id":"1"},"saldoFisicoTotal":' + value + '}]}' });
    });
    await f.steps(3);
    assert.deepEqual(f.fake.calls.map(call => call.query.filtroSaldoEstoque), ["0", "1", "2"]);
    const current = f.store.readCurrent(f.ctx, { ...f.identity, entity: "stock_balances" });
    assert.equal(current.version, "3");
    assert.match(current.payload_text, /-0\.00000000000000001/);
    assert.equal(f.store.readCurrent(f.ctx, { ...f.identity, entity: "stock_balances", source_id: "2" }), null);
    const history = f.db.prepare("SELECT payload FROM erp_document_mirror__source_version WHERE entity='stock_balances' AND source_id='1' ORDER BY source_version").all();
    assert.equal(history.length, 2);
    assert.match(history[0].payload, /0\.00000000000000001/);
    assert.match(history[1].payload, /12345678901234567890\.123456789/);
    assertOperationalUnchanged(f.db, f.baseline);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("produto excluído sem detalhe exige releitura da variante explícita e captura precisa do preço", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "products_deleted_zero", selected: true, from: null, to: null }]));
    f.fake.beforeRequest(call => {
      if (call.path === "/produtos") f.fake.queue({ body: '{"data":[{"id":"1","nome":"Excluído","preco":12345678901234567890.123456789}]}' });
    });
    const results = await f.steps(3);
    assert.ok(results.every(result => result.error === undefined));
    assert.deepEqual(f.fake.calls.map(call => call.path), ["/produtos", "/produtos/1", "/produtos"]);
    const current = f.store.readCurrent(f.ctx, { ...f.identity, entity: "products" });
    assert.equal(current.deleted, true);
    assert.match(current.deletion_evidence, /products_deleted_zero/);
    assert.equal(current.capture.source, "deleted_without_detail");
    assert.equal(current.capture.values[0].lexeme, "12345678901234567890.123456789");
    assert.equal(current.version, "1");
    assertOperationalUnchanged(f.db, f.baseline);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("período histórico encerrado continua varrendo sem janela temporal invertida", () => {
  const now = Date.UTC(2026, 10, 19, 12), resource = getBlingResource("sales_proposals");
  const selection = { key: "sales_proposals", selected: true, from: "2020-01-01", to: "2020-02-01" };
  let checkpoint = {};
  const windows = [];
  for (let turn = 0; turn < 8; turn++) {
    const current = nextWindow(resource, checkpoint, now + turn * 1000, selection);
    assert.ok(current.cursor.from <= current.cursor.to);
    assert.ok(current.cursor.to <= "2020-02-01 23:59:59");
    windows.push(current.lane);
    checkpoint = advanceWindow(current, 0, now + turn * 1000);
  }
  assert.ok(windows.filter(lane => lane === "history").length >= 3);
  assert.ok(windows.filter(lane => lane === "recent").length >= 3);
});

test("finalizar página conserva cursores de manutenção e referências alterados entre os detalhes", () => {
  const now = Date.UTC(2026, 10, 19, 12), resource = getBlingResource("financial_categories");
  const state = nextWindow(resource, { maintenance_after: "old", reference_offset: 0 }, now, { key: resource.key, selected: true, from: null, to: null });
  for (const more of [false, true]) {
    const page = { ids: ["1"], fingerprint: digest("ids"), subcursor: 0, state, listed_count: 1, slice_end: 1, more };
    const checkpoint = { revision: "4", cursor: { page, maintenance_after: "new", reference_offset: 7 }, pass_started_at: null, pass_completed_at: null };
    const next = finishPageItem(checkpoint, resource, now);
    assert.equal(next.maintenance_after, "new");
    assert.equal(next.reference_offset, 7);
    assert.equal(next.page, undefined);
  }
});

test("401 agenda renovação em outra acordada sem GET e só retoma com revisão nova", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "sales_orders", selected: true, from: "2026-11-01", to: null }]));
    f.fake.resource("/pedidos/vendas", [{ id: "1", itens: [] }]);
    f.fake.queue({ status: 401 });
    let renewals = 0;
    f.authorization.renew = async (_ctx, input) => {
      renewals++;
      assert.equal(input.expected.credential_revision, "1");
      f.db.exec("UPDATE wb_bling_control SET credential_revision=2,credential_status='ready',state='ready'");
      return { configured: true, authorized: true, revision: "2", expires_at: f.clock.now() + 3600_000, scopes: [], uncertain: false };
    };
    const rejected = await f.run();
    assert.equal(rejected.requests, 1);
    assert.equal(rejected.error.code, "BLING_AUTH_REQUIRED");
    assert.equal(renewals, 0);
    assert.equal(f.store.checkpoint("sales_orders").revision, "0");
    f.clock.set(rejected.nextWake);
    const renewed = await f.run();
    assert.equal(renewed.requests, 0);
    assert.equal(renewals, 1);
    assert.equal(f.fake.callCount, 1);
    assert.equal(f.db.prepare("SELECT phase FROM wb_bling_unit WHERE credential_revision=1").get().phase, "superseded");
    f.clock.set(renewed.nextWake);
    const resumed = await f.run();
    assert.equal(resumed.requests, 1);
    assert.equal(resumed.error, undefined);
    assert.equal(f.store.checkpoint("sales_orders").revision, "1");
    assert.equal(f.db.prepare("SELECT credential_revision FROM wb_bling_unit WHERE phase='committed'").get().credential_revision, 2);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("renovação pendente respeita deadline injetado e nunca inicia GET na mesma acordada", async () => {
  let timerId = 0;
  const scheduled = new Map();
  const timer = { set(callback) { const id = ++timerId; scheduled.set(id, callback); return id; }, clear(id) { scheduled.delete(id); } };
  const f = wakeFixture({ timer });
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "sales_orders", selected: true, from: "2026-11-01", to: null }]));
    f.fake.queue({ status: 401 });
    const first = await f.run();
    assert.equal(first.error.code, "BLING_AUTH_REQUIRED");
    f.clock.set(first.nextWake);
    let entered;
    const reachedRenewal = new Promise(resolve => { entered = resolve; });
    f.authorization.renew = () => { entered(); return new Promise(() => {}); };
    const pending = f.run();
    await reachedRenewal;
    assert.equal(scheduled.size, 1);
    f.clock.advance(4000);
    for (const callback of [...scheduled.values()]) callback();
    const result = await pending;
    assert.equal(result.requests, 0);
    assert.equal(result.error.code, "BLING_RETRY_WAIT");
    assert.equal(f.fake.callCount, 1);
    assert.equal(scheduled.size, 0);
  } finally { f.close(); }
});

async function seedReferenceWitness(f, targetSelected = true) {
  const selected = [{ key: "sales_proposals", selected: true, from: null, to: null }];
  if (targetSelected) selected.push({ key: "contacts", selected: true, from: null, to: null });
  f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify(selected));
  for (const key of ["sales_proposals", "contacts", "contacts_deleted"]) {
    f.db.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(key, f.clock.now());
    f.db.prepare("UPDATE origin_sync__resource_state SET checkpoint=? WHERE resource=?").run(JSON.stringify(key === "sales_proposals" ? { turn: 3 } : { not_before: f.clock.now() + 86_400_000, last_served_at: f.clock.now() }), key);
  }
  const text = '{"data":{"id":"9","situacao":"Rascunho","contato":{"id":"1"},"itens":[{"produto":{"id":"2"},"valor":1.25}]}}';
  const item = (await parseBlingResponse("sales_proposals", "/propostas-comerciais/9", bytes(text))).items[0];
  const hash = semanticHash(item.payload_text, []), capture = { ...item.capture, revision: "1", semantic_hash: hash, semantic_version: "1" };
  f.db.prepare("INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at,price_capture) VALUES('sales_proposals','sales_proposals','9',?,'[]',?,1,?,?,?,?)")
    .run(item.payload_text, hash, f.clock.now(), f.clock.now(), f.clock.now(), JSON.stringify(capture));
  return { payload: item.payload_text, hash };
}

test("referência faltante verifica testemunha novamente depois do HTTP e não grava resposta obsoleta", async () => {
  const f = wakeFixture();
  try {
    const witness = await seedReferenceWitness(f);
    f.fake.beforeRequest(call => {
      assert.equal(call.path, "/contatos/1");
      const changed = witness.payload.replace("Rascunho", "Cancelada");
      f.db.prepare("UPDATE origin_sync__raw_record SET payload=?,version_hash=?,version=2 WHERE entity='sales_proposals' AND source_id='9'").run(changed, semanticHash(changed, []));
    });
    const result = await f.run();
    assert.equal(result.requests, 1);
    assert.equal(result.error.code, "BLING_REVISION_CONFLICT");
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.equal(f.store.checkpoint("sales_proposals").revision, "0");
    assert.equal(f.db.prepare("SELECT phase FROM wb_bling_unit").get().phase, "superseded");
    assertOperationalUnchanged(f.db, f.baseline);
  } finally { f.close(); }
});

test("referência não inicia chamada para entidade não selecionada", async () => {
  const f = wakeFixture();
  try {
    await seedReferenceWitness(f, false);
    const result = await f.run();
    assert.equal(result.error, undefined);
    assert.equal(result.requests, 0);
    assert.equal(f.fake.callCount, 0);
    assert.equal(f.store.readCurrent(f.ctx, f.identity), null);
    assert.equal(f.store.checkpoint("sales_proposals").revision, "1");
  } finally { f.close(); }
});

test("dois trabalhos da mesma pista não podem adquirir posses concorrentes", () => {
  const f = storeFixture();
  try {
    const firstQueued = f.makeUnit(), secondQueued = f.makeUnit();
    assert.equal(firstQueued.checkpoint.revision, secondQueued.checkpoint.revision);
    const first = f.reserve(firstQueued, "owner-one");
    assert.throws(() => f.reserve(secondQueued, "owner-two"), error => error.code === "BLING_LEASE_LOST");
    assert.equal(f.db.prepare("SELECT lease_token FROM origin_sync__resource_state WHERE resource='contacts'").get().lease_token, first.lease.fence);
    f.clock.advance(4001);
    const second = f.reserve(secondQueued, "owner-two");
    assert.notEqual(second.lease.fence, first.lease.fence);
    assert.throws(() => f.commit(first, f.record("atrasado")), error => error.code === "BLING_LEASE_LOST");
    f.commit(second, f.record("vigente"));
    assert.equal(JSON.parse(f.store.readCurrent(f.ctx, f.identity).payload_text).nome, "vigente");
    assert.equal(f.store.checkpoint("contacts").revision, "1");
  } finally { f.close(); }
});

test("datas remotas impossíveis não são normalizadas silenciosamente nem declaradas confiáveis", async () => {
  for (const value of ["2026-02-31T12:00:00Z", "2026-02-29T12:00:00Z", "2026-13-01T12:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T12:00:60Z", "2026-01-01T12:00:00+14:30", "2026-01-01"]) {
    assert.equal(remoteTimestampMillis(value), null, value);
  }
  assert.equal(remoteTimestampMillis("2024-02-29 09:00:00"), Date.UTC(2024, 1, 29, 12));
  assert.equal(remoteTimestampMillis("2024-02-29T12:00:00Z"), Date.UTC(2024, 1, 29, 12));
  const f = wakeFixture();
  try {
    f.fake.setDetail("/contatos", "1", { id: "1", nome: "Data original", dataAlteracao: "2026-02-31T12:00:00Z" });
    await f.steps(3);
    const current = f.store.readCurrent(f.ctx, f.identity);
    assert.equal(current.source_time_quality, "invalid");
    assert.equal(current.source_updated_at, "2026-02-31T12:00:00Z");
    assert.equal(JSON.parse(current.payload_text).dataAlteracao, "2026-02-31T12:00:00Z");
    const unit = f.reserve();
    assert.throws(() => f.commit(unit, f.record("não confiável", { source_time_quality: "remote", source_updated_at: "2026-02-31T12:00:00Z" })), error => error.code === "BLING_RESPONSE_INVALID");
  } finally { f.close(); }
});

test("rodada automática termina depois de todas as variantes e uma passagem posterior continua coletando", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET selection=?").run(JSON.stringify([{ key: "warehouses", selected: true, from: null, to: null }]));
    f.fake.resource("/depositos", []);
    const first = await f.run();
    assert.equal(first.requests, 1);
    assert.equal(f.db.prepare("SELECT state FROM erp_sync__run").get().state, "running");
    f.clock.set(first.nextWake);
    const second = await f.run();
    assert.equal(second.requests, 1);
    const finished = f.db.prepare("SELECT id,state,finished_at,stats FROM erp_sync__run").get();
    assert.equal(finished.state, "done");
    assert.equal(finished.finished_at, f.clock.now());
    assert.equal(JSON.parse(finished.stats).requests, 2);
    assert.ok(second.nextWake > f.clock.now());
    f.clock.set(second.nextWake);
    const continuous = await f.run();
    assert.equal(continuous.requests, 1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM erp_sync__run").get().n, 2);
    assert.equal(f.db.prepare("SELECT state FROM erp_sync__run WHERE id=?").get(finished.id).state, "done");
    assert.equal(f.fake.callCount, 3);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("credencial vencida agenda custódia antes de qualquer GET e retoma com a revisão renovada", async () => {
  const f = wakeFixture();
  try {
    f.db.prepare("UPDATE wb_bling_control SET credential_status='expired',selection=?").run(JSON.stringify([{ key: "sales_orders", selected: true, from: "2026-11-01", to: null }]));
    f.fake.resource("/pedidos/vendas", []);
    let renewals = 0;
    f.authorization.renew = async () => {
      renewals++;
      f.db.exec("UPDATE wb_bling_control SET credential_revision=2,credential_status='ready'");
      return { configured: true, authorized: true, revision: "2", expires_at: f.clock.now() + 3600_000, scopes: [], uncertain: false };
    };
    const renewed = await f.run();
    assert.equal(renewed.error, undefined);
    assert.equal(renewed.requests, 0);
    assert.equal(renewals, 1);
    assert.equal(f.fake.callCount, 0);
    f.clock.set(renewed.nextWake);
    const resumed = await f.run();
    assert.equal(resumed.requests, 1);
    assert.equal(resumed.error, undefined);
    assert.equal(f.fake.callCount, 1);
  } finally { f.close(); }
});
