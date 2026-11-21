// Provas da base e simuladores; não substituem o ciclo do executor em org-fecha.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parsePriceJson, priceCapture } from "../../../src/erp/fagoo/workers/origin-sync/src/price-json.mjs";
import { FakeBling, FakeClock } from "./fake-bling.mjs";
import { FakeOAuth } from "./fake-oauth.mjs";
import { assertCollectionWrite, assertNoSecrets, assertOperationalUnchanged, guardCollectionDriver, operationalSnapshot, sqliteStorage, tableSnapshot } from "./contract-checks.mjs";

const externalId = "900719925474099312345678901234567890";

test("simulador GET: ID textual, lista mutável, detalhe divergente, exclusão e nenhum socket", async () => {
  const clock = new FakeClock();
  const fake = new FakeBling({ clock }).resource("/produtos", [{ id: externalId, nome: "Anterior" }, { id: "2", nome: "Segundo" }], { pageSize: 1 });
  const get = path => fake.fetch(fake.baseUrl + path);
  assert.deepEqual((await (await get("/produtos?pagina=1&limite=1")).json()).data, [{ id: externalId, nome: "Anterior" }]);
  fake.replacePage("/produtos", 1, [{ id: "2", nome: "Segundo" }]);
  fake.setDetail("/produtos", externalId, { id: externalId, nome: "Depois da lista" });
  clock.advance(700);
  assert.equal((await (await get("/produtos/" + externalId)).json()).data.nome, "Depois da lista");
  assert.equal((await (await get("/produtos?pagina=1")).json()).data[0].id, "2");
  fake.setDetail("/produtos", externalId, null);
  assert.equal((await get("/produtos/" + externalId)).status, 404);
  fake.assertReadOnly();
  assert.equal(fake.calls[1].at - fake.calls[0].at, 700);
  assert.equal(fake.mutations, 0);
});

test("simulador rejeita todo método que não seja GET e nunca conta mutação efetivada", async () => {
  const fake = new FakeBling();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"])
    await assert.rejects(fake.fetch(fake.baseUrl + "/produtos", { method }), /FAKE_BLING_GET_ONLY/);
  assert.equal(fake.callCount, 0);
  assert.equal(fake.mutationAttempts, 5);
  assert.equal(fake.mutations, 0);
  assert.throws(() => fake.assertReadOnly());
});

test("simulador conserva 429, Retry-After, 5xx, 401, truncamento e queda sem retry escondido", async () => {
  const clock = new FakeClock(), fake = new FakeBling({ clock });
  fake.queue({ status: 429, retryAfter: 60 }).queue({ status: 503 }).queue({ status: 401 }).queue({ truncated: true }).queue({ throw: true, advance: 3000 });
  const get = () => fake.fetch(fake.baseUrl + "/produtos");
  const limited = await get();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await get()).status, 503);
  assert.equal((await get()).status, 401);
  await assert.rejects((await get()).json(), SyntaxError);
  const start = clock.now();
  await assert.rejects(get(), /FAKE_BLING_CONNECTION_LOST/);
  assert.equal(clock.now(), start + 3000);
  assert.equal(fake.callCount, 5);
  fake.assertReadOnly();
});

test("OAuth fake é porta separada; renovação rotaciona e não registra material privado", async () => {
  const clock = new FakeClock(), resources = new FakeBling({ clock }), oauth = new FakeOAuth({ clock });
  const first = await oauth.exchange({});
  const second = await oauth.refresh(first.refresh_token);
  assert.notEqual(first.refresh_token, second.refresh_token);
  await assert.rejects(oauth.refresh(first.refresh_token));
  assert.equal(oauth.callCount, 2);
  assert.equal(resources.callCount, 0);
  assertNoSecrets(oauth.calls, [first.client_id, first.client_secret, first.access_token, first.refresh_token, second.access_token, second.refresh_token]);
  resources.assertReadOnly();
});

test("runtime conserva captura lexical decimal, bytes e JSON.rawJSON sem dependência nova", async () => {
  assert.equal(typeof JSON.rawJSON, "function", "o runtime precisa oferecer JSON.rawJSON");
  const text = '{"data":{"id":"' + externalId + '","preco":12345678901234567890.1234567890123456789}}';
  const parsed = await parsePriceJson(text, new TextEncoder().encode(text), "product_detail");
  assert.equal(parsed.data.id, externalId);
  assert.equal(JSON.stringify(parsed), text);
  const capture = priceCapture(parsed.data);
  assert.equal(capture.tokens[0].lexeme, "12345678901234567890.1234567890123456789");
  assert.equal(capture.tokens[0].path, "/preco");
  assert.match(capture.response_sha256, /^[0-9a-f]{64}$/);
  const duplicated = '{"data":{"preco":1,"preco":2}}';
  await assert.rejects(parsePriceJson(duplicated, new TextEncoder().encode(duplicated), "product_detail"), /ORIGIN_DUPLICATE_JSON_KEY/);
  await assert.rejects(parsePriceJson(text, new TextEncoder().encode(text + " "), "product_detail"), /ORIGIN_INVALID_JSON/);
});

test("baseline compara conteúdo além da contagem e guarda de DML bloqueia alteração operacional", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE operational(id TEXT PRIMARY KEY, amount TEXT) STRICT");
    db.exec("CREATE TABLE wb_bling_control(id INTEGER PRIMARY KEY, state TEXT) STRICT");
    db.exec("INSERT INTO operational VALUES('1','12.50')");
    const baseline = operationalSnapshot(db);
    const driver = guardCollectionDriver({ exec: sql => db.exec(sql), transaction: fn => fn() });
    driver.exec("INSERT INTO wb_bling_control VALUES(1,'off')");
    assertOperationalUnchanged(db, baseline);
    for (const sql of [
      "UPDATE operational SET amount='0'",
      '/* leitura */ UPDATE "operational" SET amount=amount',
      "WITH ids AS (SELECT '1') DELETE FROM operational WHERE id IN (SELECT * FROM ids)",
      "INSERT OR REPLACE INTO main.operational VALUES('1','0')",
      "REPLACE INTO operational VALUES('1','0')",
      "SELECT 1; DELETE FROM operational",
    ]) assert.throws(() => driver.exec(sql), /DML fora do acervo/);
    assert.throws(() => assertCollectionWrite("PRAGMA writable_schema=ON"), /PRAGMA_WRITE_FORBIDDEN/);
    assert.throws(() => assertCollectionWrite("DROP TRIGGER alguma_guarda"), /SCHEMA_WRITE_FORBIDDEN/);
    // Atualização com mesma contagem deve ser detectada mesmo se escapar da guarda.
    db.exec("UPDATE operational SET amount='13.50'");
    assert.equal(operationalSnapshot(db).operational.count, baseline.operational.count);
    assert.throws(() => assertOperationalUnchanged(db, baseline));
  } finally { db.close(); }
});

test("verificador de vazamento compara material gerado em memória sem incluir valor no erro", () => {
  const material = randomBytes(32).toString("base64url");
  assertNoSecrets({ configured: true }, [material]);
  let rejected;
  try { assertNoSecrets({ result: material }, [material]); } catch (error) { rejected = error; }
  assert.ok(rejected);
  assertNoSecrets(rejected.message, [material]);
});

test("adapter SQLite impõe 100 parâmetros e rollback inclusive transação assíncrona indevida", () => {
  const db = new DatabaseSync(":memory:"), storage = sqliteStorage(db);
  try {
    db.exec("CREATE TABLE item(id TEXT PRIMARY KEY) STRICT");
    assert.throws(() => storage.sql.exec("SELECT 1", ...Array(101).fill(1)), /100 parâmetros/);
    assert.throws(() => storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO item VALUES(?)", "1");
      return Promise.resolve();
    }), /transação síncrona/);
    assert.equal(db.prepare("SELECT count(*) n FROM item").get().n, 0);
    storage.transactionSync(() => storage.sql.exec("INSERT INTO item VALUES(?)", "1"));
    assert.equal(db.prepare("SELECT count(*) n FROM item").get().n, 1);
  } finally { db.close(); }
});

// Esta transação de prova exercita as primitivas/constraints do esquema.
// O executor real terá testes próprios; não é uma implementação de coleta.
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
const hashA = "a".repeat(64), hashB = "b".repeat(64);
function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const storage = sqliteStorage(db);
  migrate(storage);
  return { db, storage };
}
function collectionIdentity(db) {
  db.prepare("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,0)").run();
  db.prepare("INSERT INTO origin_sync__resource_state(resource,account_id,checkpoint,checkpoint_version,updated_at) VALUES('contracts',1,'{}',0,0)").run();
  db.prepare("INSERT INTO wb_bling_control(updated_at) VALUES(0)").run();
}
function reserve(db) {
  db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,resource,entity,source_id,phase,owner,fence,lease_until,not_before,created_at,updated_at,account_id,parts_revision)
    VALUES('work-1','attempt-1','command-1',?,1,0,0,'detail','contracts','contracts',?,'fetching','worker-1','fence-1',1000,0,0,0,'company','1')`).run(hashA, externalId);
}
function proofCommit(driver, { requestHash = hashA, fence = "fence-1", now = 1, failBeforeReceipt = false } = {}) {
  return driver.transaction(() => {
    const receipt = driver.exec("SELECT request_hash,result FROM wb_bling_receipt WHERE command_id='command-1'").rows[0];
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new Error("BLING_COMMAND_CONFLICT");
      return JSON.parse(receipt.result);
    }
    const unit = driver.exec("SELECT * FROM wb_bling_unit WHERE id='work-1' AND fence=? AND lease_until>? AND generation=(SELECT generation FROM wb_bling_control WHERE id=1)", fence, now).rows[0];
    if (!unit) throw new Error("BLING_LEASE_LOST");
    const checkpoint = driver.exec("UPDATE origin_sync__resource_state SET checkpoint_version=checkpoint_version+1,checkpoint=? WHERE resource='contracts' AND checkpoint_version=?", JSON.stringify({ next: 1 }), unit.expected_checkpoint_version).rowsWritten;
    if (checkpoint !== 1) throw new Error("BLING_REVISION_CONFLICT");
    driver.exec(`INSERT INTO wb_bling_extra_raw(entity,source_id,generation,last_resource,payload,version_hash,first_seen_at,last_seen_at,changed_at)
      VALUES('contracts',?,1,'contracts',?, ?,0,0,0)`, externalId, JSON.stringify({ id: externalId, amount: "12345678901234567890.000001" }), hashA);
    driver.exec(`INSERT INTO wb_bling_record_version(entity,source_id,version,generation,semantic_hash,size_bytes,first_seen_at,last_seen_at)
      VALUES('contracts',?,1,1,?,100,0,0)`, externalId, hashA);
    driver.exec("UPDATE wb_bling_control SET observed_count=observed_count+1 WHERE id=1");
    if (failBeforeReceipt) throw new Error("simulated_crash");
    const result = { observed: 1, checkpoint_version: "1" };
    driver.exec("INSERT INTO wb_bling_receipt(command_id,operation,request_hash,generation,state,result,created_at) VALUES('command-1','collect',?,1,'committed',?,?)", requestHash, JSON.stringify(result), now);
    driver.exec("UPDATE wb_bling_unit SET phase='committed',finished_at=?,updated_at=? WHERE id='work-1'", now, now);
    return result;
  });
}

test("seis tabelas v11: constraints preservam identidade, recibo terminal, captura e janela OAuth", () => {
  const { db } = migratedDatabase();
  try {
    const tables = ERP_ENGINE_TABLES.filter(table => table.since === 11);
    assert.equal(tables.length, 6);
    for (const { table } of tables) assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql, /\) STRICT$/);
    collectionIdentity(db);
    reserve(db);
    assert.throws(() => reserve(db), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE wb_bling_unit SET request_hash='" + hashB + "'"), /BLING_COMMAND_CONFLICT/);
    assert.throws(() => db.exec("UPDATE wb_bling_unit SET page_ids='[1,2]',subcursor=3"), /CHECK/);
    assert.throws(() => db.exec("UPDATE wb_bling_unit SET owner=NULL"), /CHECK/);
    assert.throws(() => db.exec("UPDATE wb_bling_control SET collect_enabled=1"), /CHECK/);
    assert.throws(() => db.exec("UPDATE wb_bling_control SET daily_call_limit=20001"), /CHECK/);
    assert.throws(() => db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,not_before,state_hash,browser_hash,profile,session_id,actor_id,configuration_revision,expires_at,created_at,updated_at)
      VALUES('oauth-work','oauth-attempt','oauth-command',?,1,0,0,'oauth_state',0,?,?,'area','session','actor',0,600001,0,0)`).run(hashA, hashA, hashB), /CHECK/);
    // O CHECK fechado do bruto legado continua recusando entidades adicionais.
    assert.throws(() => db.prepare(`INSERT INTO origin_sync__raw_record(entity,last_resource,source_id,payload,document_links,version_hash,version,first_seen_at,last_seen_at,changed_at)
      VALUES('contracts','contracts',?,'{}','[]',?,1,0,0,0)`).run(externalId, hashA), /CHECK/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("recibo e transação de prova: queda antes da gravação, CAS, rollback e resposta perdida sem duplicação", async () => {
  const { db, storage } = migratedDatabase();
  try {
    collectionIdentity(db);
    const baseline = operationalSnapshot(db);
    const writes = [], driver = guardCollectionDriver(storageDriver(storage), writes);
    reserve(db);
    const fake = new FakeBling().resource("/fixture-extra", [{ id: externalId, amount: "12345678901234567890.000001" }]);
    await fake.fetch(fake.baseUrl + "/fixture-extra/" + externalId);
    // A resposta HTTP se perdeu: a reserva continua durável; nenhum checkpoint avançou.
    assert.equal(db.prepare("SELECT phase FROM wb_bling_unit").get().phase, "fetching");
    assert.equal(db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource='contracts'").get().checkpoint_version, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM wb_bling_extra_raw").get().n, 0);
    assert.throws(() => proofCommit(driver, { failBeforeReceipt: true }), /simulated_crash/);
    assert.equal(db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource='contracts'").get().checkpoint_version, 0);
    assert.equal(db.prepare("SELECT observed_count FROM wb_bling_control").get().observed_count, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM wb_bling_extra_raw").get().n, 0);
    assert.throws(() => proofCommit(driver, { now: 1001 }), /BLING_LEASE_LOST/);
    db.exec("UPDATE wb_bling_unit SET owner='worker-2',fence='fence-2',lease_until=3000");
    assert.throws(() => proofCommit(driver, { now: 1001 }), /BLING_LEASE_LOST/);
    const committed = proofCommit(driver, { fence: "fence-2", now: 1001 });
    // Recibo vem antes da checagem do CAS/lease antigo (resposta do commit perdida).
    assert.deepEqual(proofCommit(driver, { fence: "fence-1", now: 9999 }), committed);
    assert.throws(() => proofCommit(driver, { requestHash: hashB }), /BLING_COMMAND_CONFLICT/);
    assert.equal(db.prepare("SELECT checkpoint_version FROM origin_sync__resource_state WHERE resource='contracts'").get().checkpoint_version, 1);
    assert.equal(db.prepare("SELECT observed_count FROM wb_bling_control").get().observed_count, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM wb_bling_extra_raw").get().n, 1);
    assert.equal(db.prepare("SELECT source_id FROM wb_bling_extra_raw").get().source_id, externalId);
    assert.throws(() => db.exec("UPDATE wb_bling_receipt SET result='{}'"), /BLING_COMMAND_CONFLICT/);
    assert.throws(() => db.exec("UPDATE wb_bling_unit SET phase='fetching'"), /BLING_COMMAND_CONFLICT/);
    assert.throws(() => db.exec("UPDATE wb_bling_record_version SET deleted_observed=1"), /CHECK/);
    assert.throws(() => db.exec("UPDATE wb_bling_record_version SET capture_revision=1"), /CHECK/);
    assertOperationalUnchanged(db, baseline);
    assert.ok(writes.some(write => write.table === "wb_bling_receipt"));
    fake.assertReadOnly();
  } finally { db.close(); }
});

test("armazenamento aceita A→B→A por versão, mantém histórico imutável e corrente em um lugar", () => {
  const { db, storage } = migratedDatabase();
  try {
    collectionIdentity(db);
    const baseline = operationalSnapshot(db);
    storage.transactionSync(() => {
      for (const [version, hash, content] of [[1, hashA, "A"], [2, hashB, "B"]]) {
        db.prepare(`INSERT INTO erp_document_mirror__source_version(entity,source_id,source_version,source_hash,payload,document_links,observed_at)
          VALUES('contracts',?,?,?,?,'[]',?)`).run(externalId, version, hash, JSON.stringify({ id: externalId, content }), version);
      }
      db.prepare(`INSERT INTO wb_bling_extra_raw(entity,source_id,generation,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at)
        VALUES('contracts',?,1,'contracts',?,?,3,1,3,3)`).run(externalId, JSON.stringify({ id: externalId, content: "A" }), hashA);
      for (const [version, hash] of [[1, hashA], [2, hashB], [3, hashA]])
        db.prepare(`INSERT INTO wb_bling_record_version(entity,source_id,version,generation,semantic_hash,size_bytes,first_seen_at,last_seen_at)
          VALUES('contracts',?,?,1,?,100,?,?)`).run(externalId, version, hash, version, version);
    });
    assert.equal(db.prepare("SELECT count(*) n FROM erp_document_mirror__source_version WHERE entity='contracts'").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM wb_bling_extra_raw").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM wb_bling_record_version WHERE semantic_hash=?").get(hashA).n, 2);
    assert.throws(() => db.exec("UPDATE erp_document_mirror__source_version SET payload='{}' WHERE entity='contracts'"), /immutable/i);
    assert.throws(() => db.exec("UPDATE wb_bling_record_version SET semantic_hash='" + hashB + "' WHERE version=1"), /BLING_REVISION_CONFLICT/);
    assertOperationalUnchanged(db, baseline);
  } finally { db.close(); }
});

import { ERP_DDL_GENERATED, ERP_DDL_HASH as generatedHash } from "../../../src/erp/schema/ddl.generated.ts";
import { ERP_DDL_HASH } from "../../../src/erp/schema/ddl.ts";
import { ERP_SEED } from "../../../src/erp/schema/seed.generated.ts";
import { WB_ROUTINE_DDL } from "../../../src/erp/schema/migrate.ts";
import { dumpAll, restoreAll } from "../../../src/erp/engine/dump.ts";
const quote = name => `"${name.replaceAll('"', '""')}"`;
function priorDatabase(version) {
  const db = new DatabaseSync(":memory:"), storage = sqliteStorage(db);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("CREATE TABLE erp_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT");
  db.exec(WB_ROUTINE_DDL);
  const additional = ERP_ENGINE_TABLES.filter(table => table.since <= version).flatMap(table => table.ddl);
  storage.transactionSync(() => {
    for (const sql of [...ERP_DDL_GENERATED, ...additional]) storage.sql.exec(sql);
    db.exec("PRAGMA defer_foreign_keys=ON");
    for (const table of ERP_SEED) {
      const insert = db.prepare(`INSERT INTO ${quote(table.table)}(${table.columns.map(quote)}) VALUES(${table.columns.map(() => "?")})`);
      for (const row of table.rows) insert.run(...row);
    }
    db.prepare("INSERT INTO erp_meta VALUES('schema_version',?),('schema_hash',?)").run(String(version), createHash("sha256").update(generatedHash + "\n" + additional.join("\n")).digest("hex"));
    db.prepare("INSERT OR IGNORE INTO origin_sync__account(id,created_at) VALUES(1,0)").run();
    db.prepare("INSERT INTO origin_sync__resource_state(resource,account_id,checkpoint,checkpoint_version,updated_at) VALUES('products',1,'{\"page\":2}',7,0)").run();
    if (version === 10)
      db.prepare("INSERT INTO erp_fiscal_vault__commercial_settings(updated_at,updated_by) VALUES(0,?)").run("12345678-1234-1234-1234-123456789012");
  });
  return { db, storage };
}
function sqliteSchema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
}
for (const version of [9, 10]) test(`migração aditiva v${version}→11 preserva conteúdo e esquema anterior; falha reverte e repetição é inerte`, () => {
  const { db, storage } = priorDatabase(version);
  try {
    const oldTables = Object.keys(tableSnapshot(db));
    const before = tableSnapshot(db), oldSchema = sqliteSchema(db);
    const failing = sqliteStorage(db, { beforeExec(sql) { if (sql.startsWith('CREATE TABLE "wb_bling_extra_raw"')) throw new Error("interrupted_v11"); } });
    assert.throws(() => migrate(failing), /interrupted_v11/);
    assert.deepEqual(tableSnapshot(db), before);
    assert.deepEqual(sqliteSchema(db), oldSchema);
    // A subida segue até a versão atual (12 acrescenta as 4 tabelas da adoção; 13, as 3 de documentos e contas; 19, as 6 da mão dupla).
    // 27: lojas e filiais (a 26 é de outra frente).
    assert.equal(migrate(storage).version, 29);
    assert.deepEqual(tableSnapshot(db, oldTables.filter(table => table !== "erp_meta")), Object.fromEntries(Object.entries(before).filter(([table]) => table !== "erp_meta")));
    const upgradedSchema = sqliteSchema(db);
    for (const object of oldSchema) assert.ok(upgradedSchema.some(after => JSON.stringify(after) === JSON.stringify(object)), object.name);
    assert.equal(db.prepare("SELECT value FROM erp_meta WHERE key='schema_hash'").get().value, ERP_DDL_HASH);
    const upgraded = tableSnapshot(db);
    assert.equal(migrate(storage).status, "current");
    assert.deepEqual(tableSnapshot(db), upgraded);
    // 6 da coleta (versão 11) + 2 do corte (15) + 6 da mão dupla (19).
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'wb_bling_%' AND name NOT LIKE 'wb_bling_adoption_%'").get().n, 14);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("dump exclui credencial/estados OAuth, suspende coleta e restaura sem posse ou aprovação", () => {
  const { db, storage } = migratedDatabase(), target = migratedDatabase();
  try {
    collectionIdentity(db);
    reserve(db);
    const material = randomBytes(32).toString("base64url");
    const stateHash = randomBytes(32).toString("hex"), browserHash = randomBytes(32).toString("hex"), approvalHash = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO origin_sync__credentials(account_id,ciphertext,expires_at,revision,updated_at) VALUES(1,?,10000,2,0)").run(JSON.stringify({ ciphertext: material }));
    db.prepare("INSERT INTO origin_sync__oauth_state(state_hash,browser_hash,created_at,expires_at) VALUES(?,?,0,10000)").run(stateHash, browserHash);
    db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,not_before,state_hash,browser_hash,profile,session_id,actor_id,configuration_revision,expires_at,created_at,updated_at)
      VALUES('oauth-work','oauth-attempt','oauth-command',?,1,0,0,'oauth_state',0,?,?,'area','session','actor',0,600000,0,0)`).run(hashA, stateHash, browserHash);
    db.prepare("UPDATE wb_bling_control SET collect_enabled=1,state='ready',revision=3,authorization_revision=4,credential_revision=2,approved_by='actor',approved_at=0,approval_hash=?,app_configured=1,credential_status='ready'").run(approvalHash);
    const dump = dumpAll(storage);
    assertNoSecrets(dump, [material, stateHash, browserHash, approvalHash, "fence-1", "worker-1"]);
    assert.ok(!dump.manifest.tables.some(table => ["origin_sync__credentials", "origin_sync__oauth_state"].includes(table.table)));
    assert.equal(dump.manifest.tables.find(table => table.table === "wb_bling_unit").rows, 1);
    restoreAll(target.storage, dump.manifest, new Map(dump.files.map(file => [file.table, file.body])));
    const control = target.db.prepare("SELECT * FROM wb_bling_control").get();
    assert.equal(control.collect_enabled, 0);
    assert.equal(control.state, "off");
    assert.equal(control.authorization_revision, 5);
    assert.equal(control.credential_revision, 3);
    assert.equal(control.approval_hash, null);
    assert.equal(control.app_configured, 0);
    assert.deepEqual({ ...target.db.prepare("SELECT phase,owner,fence,lease_until FROM wb_bling_unit").get() }, { phase: "waiting", owner: null, fence: null, lease_until: null });
    assert.equal(target.db.prepare("SELECT count(*) n FROM origin_sync__credentials").get().n, 0);
    assert.equal(target.db.prepare("SELECT count(*) n FROM origin_sync__oauth_state").get().n, 0);
    assert.deepEqual(target.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => target.db.exec("UPDATE wb_bling_unit SET request_hash='" + hashB + "'"), /BLING_COMMAND_CONFLICT/);
    assert.throws(() => restoreAll(target.storage, { ...dump.manifest, tables: [...dump.manifest.tables, { table: "origin_sync__credentials", rows: 1, sha256: hashA }] }, new Map()), /Tabela não permitida/);
  } finally { db.close(); target.db.close(); }
});

import { BLING_ENTITIES, BlingError, DEFAULT_BLING_ACCESS_POLICY } from "../../../src/erp/bling/contracts.ts";
import { BLING_MODULE_CONTRACT, BLING_OPERATIONS, authorizeBlingOperation, dataRequestSchema, decimalSchema, exactDecimalEqual, generationSchema, metadataSchema, parseOAuthReservation, resourceDescriptorSchema, revisionSchema, sourceIdSchema, wakeBudgetSchema } from "../../../src/erp/bling/schema.ts";
import { blingFailureResponse, createBlingAssembly, handleBlingOperation, runBlingWake } from "../../../src/erp/bling/assembly.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";

function appContext({ agent = false, role = "admin", origin = "app" } = {}) {
  return {
    profile: "area", clock: new FakeClock(), origin,
    identity: { people: null, parts: normalizeErpParts({}), partsControl: { profile: "area", revision: "1", expires_at: new FakeClock().now() + 120000 }, actor: {
      user_id: "12345678-1234-1234-1234-123456789012", name: null, email: null,
      session_id: "12345678-1234-1234-1234-123456789013", erp_role: role,
      verified_factor: true, aal: "aal2", is_agent: agent,
    } },
  };
}

test("schemas conservam IDs/decimais exatos e recusam metadado secreto ou seleção não confirmada", () => {
  assert.equal(sourceIdSchema.parse(externalId), externalId);
  assert.equal(sourceIdSchema.safeParse(Number(externalId)).success, false);
  assert.equal(sourceIdSchema.safeParse("0").success, false);
  assert.equal(decimalSchema.parse("12345678901234567890.000001"), "12345678901234567890.000001");
  assert.ok(exactDecimalEqual("12345678901234567890.0000010", "12345678901234567890000001e-6"));
  assert.ok(exactDecimalEqual("-0.00", "0"));
  assert.equal(exactDecimalEqual("9007199254740992", "9007199254740993"), false);
  assert.equal(decimalSchema.safeParse(0.1).success, false);
  for (const invalid of ["-1", "9007199254740992", "abc", 1]) assert.equal(revisionSchema.safeParse(invalid).success, false);
  assert.equal(generationSchema.safeParse("0").success, false);
  const ephemeral = randomBytes(32).toString("base64url");
  assert.equal(metadataSchema.safeParse({ reference: { access_token: ephemeral } }).success, false);
  const resource = {
    key: "contracts", entity: "contracts", path: null, pagination: null, detail: null, dateFilter: null,
    variants: [], deletedEvidence: null, identityRule: { kind: "unconfirmed", parent_entity: null },
    parser: null, scopeRequirements: [], confirmation: "nao_confirmado", officialEvidence: null, defaultSelected: false,
  };
  assert.ok(resourceDescriptorSchema.safeParse(resource).success);
  assert.equal(resourceDescriptorSchema.safeParse({ ...resource, defaultSelected: true }).success, false);
  assert.equal(resourceDescriptorSchema.safeParse({ ...resource, confirmation: "oficial_confirmado" }).success, false);
  assert.deepEqual(DEFAULT_BLING_ACCESS_POLICY.bots, []);
  assert.equal(DEFAULT_BLING_ACCESS_POLICY.customer_delivery.enabled, false);
});

test("descritores têm schemas únicos e bots alcançam cada operação configurada; origem externa não alcança", () => {
  assert.equal(Object.keys(BLING_OPERATIONS).length, 18);
  for (const descriptor of Object.values(BLING_OPERATIONS)) {
    assert.equal(descriptor.bot.configurable, true);
    assert.deepEqual(descriptor.requirement, { all: ["erp"] });
    assert.ok(descriptor.summary.length > 10 && descriptor.description.length > 20);
    assert.equal(typeof descriptor.input.safeParse, "function");
    assert.equal(typeof descriptor.output.safeParse, "function");
    if (descriptor.permission === "oauth_callback") continue; // callback valida sessão/cookie na porta própria.
    const context = appContext({ agent: true });
    context.authorization = { bot: { id: "bot-1", allowed_operations: [descriptor.name], allowed_entities: [...BLING_ENTITIES], data_scopes: ["public", "personal", "sensitive", "raw", "xml"], allow_sensitive: true } };
    const input = { command_id: "command-1", entity: descriptor.name.includes("xml") ? "nfe" : "products" };
    assert.doesNotThrow(() => authorizeBlingOperation(context, descriptor.name, input), descriptor.name);
    assert.throws(() => authorizeBlingOperation({ ...context, authorization: undefined }, descriptor.name, input), error => error.code === "BLING_SCOPE_REQUIRED", descriptor.name);
    assert.throws(() => authorizeBlingOperation({ ...context, origin: "external" }, descriptor.name, input), error => error.code === "BLING_ADMIN_REQUIRED", descriptor.name);
    if (descriptor.permission === "admin")
      assert.throws(() => authorizeBlingOperation({ ...context, identity: { ...context.identity, actor: { ...context.identity.actor, erp_role: "consulta" } } }, descriptor.name, input), error => error.code === "BLING_ADMIN_REQUIRED", descriptor.name);
  }
});

test("ação sensível do bot exige confirmação vinculada ao comando ou liberação administrativa", () => {
  const context = appContext({ agent: true }), name = "erp_bling_disable", input = { command_id: "command-1", expected_revision: "1" };
  context.authorization = { request_hash: hashA, bot: { id: "bot-1", allowed_operations: [name], allowed_entities: [], data_scopes: [], allow_sensitive: false } };
  assert.throws(() => authorizeBlingOperation(context, name, input), error => error.code === "BLING_SCOPE_REQUIRED");
  context.authorization.confirmation = { operation: name, command_id: input.command_id, request_hash: hashA, confirmed_by: context.identity.actor.user_id, expires_at: context.clock.now() + 1000 };
  assert.doesNotThrow(() => authorizeBlingOperation(context, name, input));
  assert.throws(() => authorizeBlingOperation(context, name, { ...input, command_id: "outro" }), error => error.code === "BLING_SCOPE_REQUIRED");
  context.clock.advance(1001);
  assert.throws(() => authorizeBlingOperation(context, name, input), error => error.code === "BLING_SCOPE_REQUIRED");
});

test("prévia sem comando durável aceita confirmação vinculada ao hash e à pessoa", () => {
  const context = appContext({ agent: true }), name = "erp_bling_purge_preview";
  const input = { scope: { all: true, entities: [] }, generation: "1" };
  assert.ok(BLING_OPERATIONS[name].input.safeParse(input).success);
  context.authorization = { request_hash: hashA, bot: { id: "bot-1", allowed_operations: [name], allowed_entities: [], data_scopes: [], allow_sensitive: false },
    confirmation: { operation: name, command_id: hashA, request_hash: hashA, confirmed_by: context.identity.actor.user_id, expires_at: context.clock.now() + 1000 } };
  assert.doesNotThrow(() => authorizeBlingOperation(context, name, input));
  context.authorization.confirmation.confirmed_by = "outra-pessoa";
  assert.throws(() => authorizeBlingOperation(context, name, input), error => error.code === "BLING_SCOPE_REQUIRED");
});

test("OpenAPI descreve todas operações, sensibilidade e referências de schemas resolvíveis", () => {
  const spec = BLING_MODULE_CONTRACT.openapi;
  const operations = Object.values(spec.paths).flatMap(path => Object.values(path));
  assert.equal(operations.length, 18);
  assert.deepEqual(operations.map(op => op.operationId).sort(), Object.keys(BLING_OPERATIONS).sort());
  for (const operation of operations) {
    assert.ok(operation.summary.length > 10);
    assert.ok(operation.responses["403"] && operation.responses["503"]);
    if (operation["x-sensitive"]) assert.ok(BLING_MODULE_CONTRACT.definition.bot.sensitive.includes(operation.operationId));
  }
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      const target = node.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
      assert.ok(target, "referência OpenAPI não resolvida: " + node.$ref);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(spec);
});

test("envelopes privados limitam transporte a GET, margem operacional e estado OAuth a dez minutos", () => {
  const context = appContext();
  const expected = { generation: "1", authorization_revision: "1", credential_revision: "1", configuration_revision: "1", account_id: "123", parts_revision: "1" };
  const request = { method: "GET", resource_key: "products", path: "/produtos", query: { pagina: "1" }, deadline: context.clock.now() + 3000, expected };
  assert.ok(dataRequestSchema.safeParse(request).success);
  assert.equal(dataRequestSchema.safeParse({ ...request, method: "POST" }).success, false);
  assert.equal(dataRequestSchema.safeParse({ ...request, query: { access_token: randomBytes(32).toString("base64url") } }).success, false);
  assert.ok(wakeBudgetSchema.safeParse({ deadline: 1750, nextOperationalAt: 2000, maxGets: 1 }).success);
  assert.equal(wakeBudgetSchema.safeParse({ deadline: 1751, nextOperationalAt: 2000, maxGets: 1 }).success, false);
  const reservation = { command_id: "oauth-command", state_hash: hashA, browser_hash: hashB, session_id: context.identity.actor.session_id,
    actor_id: context.identity.actor.user_id, config_revision: "1", generation: "1", expires_at: context.clock.now() + 600000 };
  assert.deepEqual(parseOAuthReservation(context, reservation), reservation);
  assert.throws(() => parseOAuthReservation(context, { ...reservation, expires_at: reservation.expires_at + 1 }), error => error.code === "BLING_RESPONSE_INVALID");
  assert.throws(() => parseOAuthReservation({ ...context, origin: "external" }, reservation), error => error.code === "BLING_ADMIN_REQUIRED");
  const bot = { ...context, identity: { ...context.identity, actor: { ...context.identity.actor, is_agent: true } } };
  assert.throws(() => parseOAuthReservation(bot, reservation), error => error.code === "BLING_SCOPE_REQUIRED");
});

test("montagem incompleta recusa explicitamente, sem portas de sucesso simulado nem acesso a I/O", async () => {
  const forbidden = new Proxy({}, { get() { throw new Error("dependência não deveria ser acessada"); } });
  const context = appContext();
  const dependencies = { env: forbidden, storage: forbidden, readParts: async () => ({ customers: true }) };
  // Os stubs foram substituídos: configuração incompleta falha na criação,
  // em vez de entregar portas que ocultem ausência de implementação.
  await assert.rejects(createBlingAssembly(), error => error.code === "BLING_DISABLED" && error.status === 503);
  await assert.rejects(createBlingAssembly(dependencies), error => error.code === "BLING_DISABLED" && error.status === 503);
  const response = await handleBlingOperation({ context, name: "erp_bling_status", input: {} }, dependencies);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "BLING_DISABLED");
  await assert.rejects(runBlingWake("area", dependencies, { eligible: true, nextOperationalAt: null, clock: context.clock }), error => error.code === "BLING_DISABLED" && error.status === 503);
  const privateValue = randomBytes(32).toString("base64url");
  assertNoSecrets(await blingFailureResponse(new Error(privateValue)).text(), [privateValue]);
  const mislabeled = new BlingError("BLING_AUTH_REQUIRED");
  mislabeled.message = privateValue;
  assertNoSecrets(await blingFailureResponse(mislabeled).text(), [privateValue]);
});

test("costura de alarme respeita Base, trabalho operacional e margem do deadline sem espera real", async () => {
  const clock = new FakeClock(), initial = clock.now(), budgets = [];
  const dependencies = { env: {}, storage: {}, readParts: async () => ({ customers: true }) };
  const wake = { nextWake: async () => initial, runOne: async (_ctx, budget) => { budgets.push(budget); return { worked: true, requests: 1, nextWake: initial + 700 }; } };
  await runBlingWake("area", dependencies, { eligible: false, nextOperationalAt: null, clock }, wake);
  await runBlingWake("area", dependencies, { eligible: true, nextOperationalAt: initial + 1200, clock }, wake);
  await runBlingWake("area", { ...dependencies, readParts: async () => null }, { eligible: true, nextOperationalAt: null, clock }, wake);
  assert.equal(budgets.length, 0);
  await runBlingWake("area", dependencies, { eligible: true, nextOperationalAt: initial + 3000, clock }, wake);
  assert.deepEqual(budgets, [{ deadline: initial + 2750, nextOperationalAt: initial + 3000, maxGets: 1 }]);
  assert.equal(clock.now(), initial);
});
