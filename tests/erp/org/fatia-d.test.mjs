// Fatia D do Bling: coletar e adotar listas de preços, naturezas, campos
// customizados (e valores), fornecedores e lotes de produto, contratos e NFS-e.
// Só SQLite em memória, RPCs do próprio ERP e o Bling simulado; nenhuma
// chamada ao Bling, rede ou cofre.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation, adoptionRequestHash } from "../../../src/erp/bling/adoption-api.ts";
import { BLING_ADOPTION_ADMIN_OPERATIONS, BLING_ADOPTION_OPERATIONS } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_EXTRAS_BATCH } from "../../../src/erp/bling/extras-contracts.ts";
import { runExtrasOutboundUnit, runExtrasTwoWayLocal } from "../../../src/erp/bling/extras-two-way.ts";
import { createBlingWriter } from "../../../src/erp/bling/writer.ts";
import { BLING_EXTRA_COLLECTED, BLING_RESOURCES, buildBlingListQuery, confirmBlingExtraResource, getBlingResource } from "../../../src/erp/bling/resources.ts";
import { BlingError } from "../../../src/erp/bling/contracts.ts";
import { resourceDescriptorSchema } from "../../../src/erp/bling/schema.ts";
import { createBlingDataClient } from "../../../src/erp/bling/client.ts";
import { createCollectionStore } from "../../../src/erp/bling/repository.ts";
import { createBlingWake } from "../../../src/erp/bling/wake.ts";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { BLING_EXTRAS_PATHS, FakeBling, FakeClock, blingExtrasSample } from "./fake-bling.mjs";

const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const evidence = { url: "https://example.invalid/evidencia-simulada", checked_at: "2026-11-19T12:00:00.000Z", scopes_checked: true, identity_checked: true, limits_checked: true };

// ---------------------------------------------------------------------------
// Catálogo e coleta

test("os sete recursos continuam não confirmados e sem caminho; só a evidência completa os torna coletáveis", () => {
  for (const entity of BLING_EXTRA_COLLECTED) {
    const resource = getBlingResource(entity);
    assert.equal(resource.confirmation, "nao_confirmado");
    assert.equal(resource.path, null);
    assert.equal(resource.defaultSelected, false);
    assert.throws(() => confirmBlingExtraResource(entity, { ...evidence, limits_checked: false }), BlingError);
    assert.throws(() => confirmBlingExtraResource(entity, { ...evidence, url: "http://inseguro.invalid" }), BlingError);
    const confirmed = confirmBlingExtraResource(entity, evidence);
    resourceDescriptorSchema.parse(confirmed);
    assert.equal(confirmed.path, BLING_EXTRAS_PATHS[entity]);
    assert.equal(confirmed.defaultSelected, false);
    assert.deepEqual(buildBlingListQuery(entity, { page: 3 }, confirmed), { pagina: "3", limite: "10" });
  }
  assert.throws(() => buildBlingListQuery("price_lists", { page: 1 }), BlingError);
});

const actor = { user_id: "bd000000-0000-4000-8000-000000000001", name: "Pessoa", email: null, erp_role: "admin", verified_factor: true, session_id: "bd000000-0000-4000-8000-000000000002", aal: "aal2", is_agent: false };
function collector(selected) {
  const db = freshLite(), clock = new FakeClock(), fake = new FakeBling({ clock });
  db.prepare(`INSERT INTO wb_bling_control(id,revision,generation,authorization_revision,credential_revision,collect_enabled,state,account_id,selection,approved_by,approved_at,approval_hash,credential_status,updated_at)
    VALUES(1,1,1,1,1,1,'ready','account',?,?,?,?,'ready',?)`).run(JSON.stringify(selected.map(key => ({ key, selected: true, from: null, to: null }))), actor.user_id, clock.now(), digest("approval"), clock.now());
  let id = 0;
  const store = createCollectionStore({ db: nodeDriver(db), randomId: () => `id-${++id}`, databaseSize: () => 100_000 });
  const resources = BLING_RESOURCES.map(resource => BLING_EXTRA_COLLECTED.includes(resource.entity) ? confirmBlingExtraResource(resource.entity, evidence) : resource);
  const parts = normalizeErpParts({});
  const ctx = { profile: "fatia-d", origin: "internal", clock, identity: { actor: null, people: [], parts, partsControl: { profile: "fatia-d", revision: "1", expires_at: clock.now() + 360_000 } } };
  const authorization = { privateCredential: async () => ({ client_id: "c".repeat(32), client_secret: "s".repeat(32), access_token: "t".repeat(32), refresh_token: "r".repeat(32), expires_at: clock.now() + 3600_000, scopes: [] }), renew: async () => { throw new Error("renovação não esperada"); } };
  const readParts = async () => ({ profile: "fatia-d", revision: "1", expires_at: clock.now() + 300_000, parts });
  const data = createBlingDataClient({ fetch: fake.fetch, authorization, revalidate: async () => {}, resources, baseUrl: fake.baseUrl });
  const wake = createBlingWake({ collection: store, data, authorization, archive: { validateCapture: (_ctx, { record }) => record.capture }, readParts, revalidate: async () => {}, randomId: () => `wake-${++id}`, resources });
  async function steps(count) {
    for (let index = 0; index < count; index++) {
      const result = await wake.runOne(ctx, { deadline: clock.now() + 4000, nextOperationalAt: null, maxGets: 1 });
      assert.ok(result.requests <= 1);
      if (result.nextWake === null) return;
      clock.set(Math.max(clock.now() + 700, result.nextWake));
    }
  }
  return { db, fake, steps, close: () => db.close() };
}

test("coleta pelo mesmo coletor: lista e detalhe, lista sem detalhe, acervo bruto e só GET", async () => {
  const sample = blingExtrasSample();
  const f = collector(["price_lists", "operation_natures"]);
  try {
    f.fake.resource(BLING_EXTRAS_PATHS.price_lists, sample.price_lists);
    f.fake.resource(BLING_EXTRAS_PATHS.operation_natures, sample.operation_natures, { detail: false });
    await f.steps(30);
    const rows = f.db.prepare("SELECT entity, source_id FROM wb_bling_extra_raw ORDER BY entity, source_id").all().map(r => `${r.entity}:${r.source_id}`);
    assert.deepEqual(rows, ["operation_natures:9001", "operation_natures:9002", "price_lists:8001", "price_lists:8002"]);
    // Naturezas vêm inteiras na lista: nenhum GET de detalhe.
    assert.ok(!f.fake.calls.some(call => call.path.startsWith("/naturezas-operacoes/")));
    assert.ok(f.fake.calls.some(call => call.path === "/listas-precos/8001"));
    // Recibo e retomada são os do coletor: o mesmo checkpoint por recurso.
    assert.ok(f.db.prepare("SELECT count(*) AS n FROM wb_bling_receipt").get().n > 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM origin_sync__resource_state WHERE resource IN ('price_lists','operation_natures')").get().n, 2);
    f.fake.assertReadOnly();
  } finally { f.close(); }
});

test("recurso não selecionado não é chamado", async () => {
  const f = collector(["operation_natures"]);
  try {
    f.fake.resource(BLING_EXTRAS_PATHS.price_lists, blingExtrasSample().price_lists);
    f.fake.resource(BLING_EXTRAS_PATHS.operation_natures, [], { detail: false });
    await f.steps(10);
    assert.ok(!f.fake.calls.some(call => call.path.startsWith("/listas-precos")));
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Adoção

function sqliteStorage(db) {
  let depth = 0;
  return {
    sql: {
      get databaseSize() { return 1_000_000; },
      exec(sql, ...params) {
        const statement = db.prepare(sql), columns = statement.columns();
        if (columns.length) {
          statement.setReturnArrays(true);
          const raw = statement.all(...params), rows = raw.map(values => Object.fromEntries(columns.map((column, index) => [column.name, values[index]])));
          return { toArray: () => rows, raw: () => raw, rowsRead: rows.length, rowsWritten: 0 };
        }
        const result = statement.run(...params);
        return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(result.changes) };
      },
    },
    transactionSync(fn) {
      const name = `fatia_d_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}
const area = "fatia-d-area", admin = actor.user_id;
const now = Date.UTC(2026, 10, 20, 15);
const people = [{ user_id: admin, name: null, email: null, erp_role: "admin", verified_factor: true }];
const identityOf = (extra = {}) => ({ actor: { ...people[0], session_id: "sessao-1", aal: "aal2", is_agent: false, ...extra }, people });
let sequence = 0;
const commandId = () => `fatia-d-${++sequence}`;
const uuid = () => { const h = createHash("sha256").update("u" + ++sequence).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function fixture(partsInput = {}) {
  const sqlite = new DatabaseSync(":memory:"), storage = sqliteStorage(sqlite);
  migrate(storage);
  const db = storageDriver(storage);
  let parts = normalizeErpParts(partsInput);
  const snapshot = () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts });
  sqlite.prepare("INSERT INTO wb_bling_control(id,account_id,credential_status,updated_at) VALUES(1,'conta','ready',?)").run(now);
  const versions = new Map();
  const put = (table, entity, payload, extra) => {
    const text = JSON.stringify(payload), hash = digest(text), version = (versions.get(entity + payload.id) ?? 0) + 1;
    versions.set(entity + payload.id, version);
    sqlite.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(entity, now);
    sqlite.prepare(`INSERT INTO ${table}(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at${extra ? ",generation" : ""}) VALUES(?,?,?,?,?,?,?,?,?${extra ? ",1" : ""})
      ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload, version_hash=excluded.version_hash, version=excluded.version, changed_at=excluded.changed_at`).run(entity, payload.id, entity, text, hash, version, now, Date.now(), Date.now());
  };
  const seed = (entity, payload) => put("origin_sync__raw_record", entity, payload, false);
  const seedExtra = (entity, payload) => put("wb_bling_extra_raw", entity, payload, true);
  async function call(name, input, identity = identityOf(), authorization = null) {
    const response = await handleAdoptionOperation({ name, identity, profile: area, input, authorization }, { storage, readSnapshot: async () => snapshot() });
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input, identity) {
    const result = await call(name, input, identity);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const rpc = (name, args) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, { identity: identityOf(), parts });
  /** Cadastro do ERP já adotado na fatia B1 (vínculo da versão 12). */
  function adopted(entity, source, record) {
    sqlite.prepare("INSERT INTO wb_bling_adoption_link(entity,source_id,record_id,source_version,source_hash,mode,adopted_by,adopted_at) VALUES(?,?,?,1,?,'created',?,?)").run(entity, source, record, digest(entity + source), admin, now);
  }
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  return { sqlite, storage, db, seed, seedExtra, call, ok, rpc, adopted, count, get parts() { return parts; }, setParts(next) { parts = normalizeErpParts(next); } };
}
/** Produto 501, fornecedor 301 e depósito 401, já no ERP e ligados ao Bling. */
function base(f) {
  const product = f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Caneta azul", code: "CANETA-AZ", price: "2.5", unit: "UN" }, p_acknowledged: null }).record.id;
  const contactResult = f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Cliente Bling", person_type: "F", phone: "11999990000", roles: ["customer", "supplier"] }, p_acknowledged: null });
  const contact = contactResult.id ?? contactResult.record?.id ?? contactResult.contact?.id;
  const warehouseCommand = uuid();
  f.rpc("erp_stock_warehouse_save", { p_command_id: warehouseCommand, p_warehouse_id: null, p_expected_version: 0, p_expected_setting_version: 0, p_name: "Depósito do Bling", p_ignore_balance: false });
  const warehouse = String(f.sqlite.prepare('SELECT warehouse_id FROM "erp_stock__warehouse_command" WHERE id=?').get(warehouseCommand).warehouse_id);
  f.seed("products", { id: "501", nome: "Caneta azul", codigo: "CANETA-AZ", camposCustomizados: [{ idCampoCustomizado: "7001", valor: "220 V" }] });
  f.seed("contacts", { id: "301", nome: "Cliente Bling", camposCustomizados: [{ idCampoCustomizado: "7002", valor: "15/03/1990" }] });
  f.adopted("products", "501", product); f.adopted("contacts", "301", contact); f.adopted("warehouses", "401", warehouse);
  const sample = blingExtrasSample();
  for (const [entity, rows] of Object.entries(sample)) for (const row of rows) f.seedExtra(entity, row);
  return { product, contact, warehouse, sample };
}

test("prévia mostra o que vai acontecer; adotar cria pelas funções do domínio, recusa o formato desconhecido e não duplica", async () => {
  const f = fixture();
  const ids = base(f);
  const status = await f.ok("erp_bling_extras_status", {});
  assert.equal(status.available, true);
  const by = Object.fromEntries(status.entities.map(item => [item.entity, item]));
  assert.equal(by.custom_fields.collected, 3);
  assert.equal(by.custom_field_values.collected, 2);
  assert.equal(by.price_lists.proposed_path, "/listas-precos");

  // Campos: prévia sem gravar nada.
  const preview = await f.ok("erp_bling_extras_preview", { entity: "custom_fields" });
  assert.deepEqual(preview.items.map(item => [item.source_id, item.outcome]), [["7001", "create"], ["7002", "create"], ["7003", "pending"]]);
  assert.match(preview.items[2].reason_text, /formato/);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__custom_field"), 0);

  const command = commandId();
  const adopted = await f.ok("erp_bling_extras_adopt", { command_id: command, entity: "custom_fields" });
  assert.deepEqual([adopted.counts.adopted, adopted.counts.pending], [2, 1]);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__custom_field WHERE module='products'"), 1);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__contact_field"), 1);
  // Repetir o mesmo pedido devolve o mesmo resultado; outro pedido não cria de novo.
  assert.equal((await f.ok("erp_bling_extras_adopt", { command_id: command, entity: "custom_fields" })).receipt.replayed, true);
  const again = await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "custom_fields" });
  assert.equal(again.counts.adopted, 0);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__custom_field"), 1);

  // Valores dos campos, pelas funções do produto e (versão 20) do contato.
  await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "custom_field_values" });
  const option = f.sqlite.prepare("SELECT o.id FROM erp_catalog__custom_field_option o JOIN erp_catalog__custom_field c ON c.id=o.field_id WHERE o.label='220 V'").get().id;
  assert.equal(f.sqlite.prepare("SELECT value FROM erp_catalog__product_custom_value WHERE record_id=?").get(ids.product).value, option);
  assert.equal(f.sqlite.prepare("SELECT value FROM erp_catalog__contact_field_value WHERE contact_id=?").get(ids.contact).value, "1990-03-15");

  // Lista de preços com o item; a outra veio num formato desconhecido.
  const lists = await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "price_lists" });
  assert.deepEqual([lists.counts.adopted, lists.counts.pending], [1, 1]);
  const list = f.sqlite.prepare("SELECT id, list_type FROM erp_pricing__price_list WHERE name='Atacado'").get();
  assert.equal(list.list_type, "custom");
  assert.equal(Number(f.sqlite.prepare("SELECT custom_price FROM erp_pricing__price_list_item WHERE list_id=? AND product_id=?").get(list.id, ids.product).custom_price), 9.9);
  const reviews = await f.ok("erp_bling_extras_reviews", { entity: "price_lists" });
  assert.equal(reviews.items[0].source_id, "8002");
  assert.equal(reviews.items[0].reason, "unknown_format");

  // Fornecedor do produto: o mesmo vínculo que a compra pela nota usa.
  await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "product_suppliers" });
  assert.equal(f.sqlite.prepare("SELECT code FROM erp_catalog__product_supplier WHERE record_id=? AND supplier_id=?").get(ids.product, ids.contact).code, "FORN-01");

  // Lote: o produto não controla lotes; nada é criado.
  await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "product_lots" });
  assert.equal((await f.ok("erp_bling_extras_reviews", { entity: "product_lots" })).items[0].reason, "lot_control_off");
  assert.equal(f.count("SELECT count(*) n FROM erp_stock__lot"), 0);
});

test("naturezas entram sem trocar a natureza padrão; sem regime informado ficam pendentes", async () => {
  const f = fixture();
  base(f);
  const defaults = f.sqlite.prepare("SELECT code, nature_id FROM erp_fiscal_invoices__nature_default ORDER BY code").all();
  const result = await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "operation_natures" });
  assert.deepEqual([result.counts.adopted, result.counts.pending], [1, 1]);
  assert.equal(f.count("SELECT count(*) n FROM erp_fiscal_invoices__nature WHERE description='Venda de mercadoria (Bling)'"), 1);
  assert.deepEqual(f.sqlite.prepare("SELECT code, nature_id FROM erp_fiscal_invoices__nature_default ORDER BY code").all(), defaults);
  assert.match((await f.ok("erp_bling_extras_reviews", { entity: "operation_natures" })).items[0].detail, /CRT/);
});

test("parte desligada recusa com o módulo a ligar; NFS-e é só consulta e pede o Fiscal", async () => {
  const f = fixture();
  base(f);
  f.setParts({ products: false, fiscal: false });
  const refused = await f.call("erp_bling_extras_adopt", { command_id: commandId(), entity: "price_lists" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "BLING_ADOPTION_PART_DISABLED");
  assert.match(refused.body.error.detail, /ligue o módulo Produtos e serviços/);
  const invoices = await f.call("erp_bling_extras_invoices", {});
  assert.equal(invoices.body.error.code, "BLING_ADOPTION_PART_DISABLED");
  f.setParts({});
  const list = await f.ok("erp_bling_extras_invoices", { q: "cliente" });
  assert.deepEqual(list.items.map(item => [item.source_id, item.number, item.total]), [["9801", "321", "250.00"]]);
  assert.match(list.read_only_message, /só consulta/);
});

test("contrato: prévia conferida, criação só pela tela (Worker), vínculo único", async () => {
  const f = fixture();
  base(f);
  const contracts = await f.ok("erp_bling_extras_contracts", {});
  const first = contracts.items.find(item => item.source_id === "9701");
  assert.deepEqual([first.period, first.value, first.starts_on, first.ends_on, first.problems.length], ["month", "150.00", "2026-01-01", "2026-12-31", 0]);
  assert.ok(contracts.items.find(item => item.source_id === "9702").problems.some(problem => /início/.test(problem)));
  // O objeto do ERP não cria o contrato sozinho.
  const direct = await f.call("erp_bling_extras_contract_create", { command_id: commandId(), source_id: "9701", version: "1", contact_id: uuid(), plan_id: uuid(), visits_per_period: 1, period: "month" });
  assert.equal(direct.body.error.code, "BLING_ADOPTION_INVALID");
  const contract = uuid();
  await f.ok("erp_bling_extras_contract_link", { command_id: commandId(), source_id: "9701", version: "1", contract_id: contract, number: "CM-1" });
  assert.equal((await f.ok("erp_bling_extras_contracts", {})).items.find(item => item.source_id === "9701").link.contract_id, contract);
  const other = await f.call("erp_bling_extras_contract_link", { command_id: commandId(), source_id: "9702", version: "1", contract_id: contract });
  assert.equal(other.body.error.code, "BLING_ADOPTION_CONFLICT");
});

test("bots: consultar é leitura; adotar é sensível; criar contrato e ligar a mão dupla ficam fora do inventário", async () => {
  assert.equal(BLING_ADOPTION_OPERATIONS.erp_bling_extras_status.sensitive, false);
  for (const name of ["erp_bling_extras_adopt", "erp_bling_extras_resolve", "erp_bling_extras_preview"]) assert.equal(BLING_ADOPTION_OPERATIONS[name].sensitive, true);
  for (const name of ["erp_bling_extras_contract_create", "erp_bling_extras_contract_link", "erp_bling_extras_switch"]) {
    assert.ok(!Object.hasOwn(BLING_ADOPTION_OPERATIONS, name));
    assert.ok(Object.hasOwn(BLING_ADOPTION_ADMIN_OPERATIONS, name));
  }
  const f = fixture();
  base(f);
  const input = { command_id: commandId(), entity: "price_lists" };
  const bot = identityOf({ is_agent: true, session_id: null });
  const proposal = { request_hash: adoptionRequestHash(input), bot: { id: "bot-1", operation: "erp_bling_extras_adopt" }, delegation: { run_id: "run-1" }, confirmed: false };
  assert.equal((await f.call("erp_bling_extras_adopt", input, bot, proposal)).body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  const read = { request_hash: adoptionRequestHash({}), bot: { id: "bot-1", operation: "erp_bling_extras_status" }, delegation: { run_id: "run-1" }, confirmed: false };
  assert.equal((await f.call("erp_bling_extras_status", {}, bot, read)).status, 200);
  const switchInput = { command_id: commandId(), entity: "price_lists", direction: "outbound", enabled: true, acknowledged: true };
  const switchByBot = { request_hash: adoptionRequestHash(switchInput), bot: { id: "bot-1", operation: "erp_bling_extras_switch" }, delegation: { run_id: "run-1", proposal_id: "p-1" }, confirmed: true };
  assert.equal((await f.call("erp_bling_extras_switch", switchInput, bot, switchByBot)).body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  assert.deepEqual([...BLING_EXTRAS_BATCH].sort(), ["custom_field_values", "custom_fields", "operation_natures", "price_lists", "product_lots", "product_suppliers"]);
});

// ---------------------------------------------------------------------------
// Mão dupla das listas de preços

test("mão dupla da lista: desligada não escreve; ligada envia a mudança, incerto não repete e entrada aplica a versão nova", async () => {
  const f = fixture();
  const ids = base(f);
  await f.ok("erp_bling_extras_adopt", { command_id: commandId(), entity: "price_lists" });
  const list = String(f.sqlite.prepare("SELECT id FROM erp_pricing__price_list WHERE name='Atacado'").get().id);
  // Sem a data de corte, ligar é recusado.
  const early = await f.call("erp_bling_extras_switch", { command_id: commandId(), entity: "price_lists", direction: "outbound", enabled: true, acknowledged: true });
  assert.equal(early.body.error.code, "BLING_ADOPTION_CONFLICT");
  await f.ok("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: "2026-11-01", acknowledged: true });

  const clock = { now: () => Date.now() };
  const fake = new FakeBling({ writes: true });
  fake.resource("/listas-precos", [blingExtrasSample().price_lists[0]]);
  const writer = createBlingWriter({ fetch: fake.fetch, accessToken: async () => "token-simulado", baseUrl: fake.baseUrl });
  const ctx = { profile: area, origin: "internal", clock, identity: { actor: null, people: [] } };
  const local = () => runExtrasTwoWayLocal({ db: f.db, profile: area, now: clock.now, parts: f.parts });
  const send = () => runExtrasOutboundUnit({ db: f.db, profile: area, now: clock.now, parts: f.parts, writer, ctx, deadline: clock.now() + 4000 });
  const bump = () => f.sqlite.prepare("UPDATE wb_bling_adoption_extra_twoway SET next_scan_at=0").run();
  const changePrice = price => f.rpc("erp_pricing_list_items", { p_id: list, p_expected_version: Number(f.sqlite.prepare("SELECT version FROM erp_pricing__price_list WHERE id=?").get(list).version), p_command_id: uuid(), p_change: { prices: [{ product_id: ids.product, custom_price: price }] } });

  // Desligada: mudar no ERP não escreve nada.
  changePrice("10.5");
  local(); await send();
  assert.equal(fake.mutations, 0);

  await f.ok("erp_bling_extras_switch", { command_id: commandId(), entity: "price_lists", direction: "outbound", enabled: true, acknowledged: true });
  local(); // ponto de partida: o ERP de agora não é reenviado
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_extra_outbox"), 0);
  changePrice("11.0"); bump(); local();
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_extra_outbox WHERE state='pending'"), 1);
  assert.equal((await send()).requests, 1);
  assert.equal(fake.writes[0].method, "PUT");
  assert.equal(fake.writes[0].path, "/listas-precos/8001");
  assert.equal(fake.writes[0].body.produtos[0].produto.id, "501");
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_extra_outbox WHERE state='done'"), 1);

  // Resposta perdida depois de gravar: fica incerto e não é reenviado sozinho.
  changePrice("12.0"); bump(); local();
  fake.queue({ method: "PUT", apply: true, throw: true });
  f.sqlite.prepare("UPDATE wb_bling_control SET next_allowed_at=NULL").run();
  await send();
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_extra_outbox WHERE state='uncertain'"), 1);
  const calls = fake.callCount;
  f.sqlite.prepare("UPDATE wb_bling_control SET next_allowed_at=NULL").run();
  await send();
  assert.equal(fake.callCount, calls);
  const outbox = await f.ok("erp_bling_extras_outbox", {});
  const uncertain = outbox.items.find(item => item.state === "uncertain");
  assert.deepEqual(uncertain.actions.map(a => a.action), ["confirm_sent", "resend"]);
  await f.ok("erp_bling_extras_outbox_resolve", { command_id: commandId(), id: uncertain.id, action: "confirm_sent" });

  // Entrada: a versão nova do Bling entra pela mesma função da adoção.
  await f.ok("erp_bling_extras_switch", { command_id: commandId(), entity: "price_lists", direction: "inbound", enabled: true, acknowledged: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  f.seedExtra("price_lists", { id: "8001", nome: "Atacado", produtos: [{ produto: { id: "501" }, preco: "13.00" }] });
  bump(); local();
  assert.equal(Number(f.sqlite.prepare("SELECT custom_price FROM erp_pricing__price_list_item WHERE list_id=?").get(list).custom_price), 13);
  // Naturezas, NFS-e e contratos nunca foram escritos.
  assert.ok(fake.writes.every(write => write.path.startsWith("/listas-precos/")));
});
