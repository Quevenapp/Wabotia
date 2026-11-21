// Subida de esquema de um objeto erp: que já existe, com dados (pedido da
// orquestração, 17/11/2026, antes de a junção ir para a instalação de teste):
//   1. o objeto nasce com o migrate() do tronco 4748b75 (esquema v6; os
//      arquivos de src/erp/schema saem do git para uma pasta temporária);
//   2. recebe dados gravados pelo próprio motor: contato, produto, depósito,
//      movimento de estoque, pedido de venda com item, conta e título do
//      Financeiro (dualFixture, os RPCs atuais nos dois motores);
//   3. abre com o migrate() de agora, numa chamada só.
// Confere: toda linha igual antes e depois, tabela a tabela; o esquema
// inteiro (tabelas, índices e gatilhos, estes na ordem de criação, que no
// SQLite decide quem dispara primeiro) igual ao de uma instalação nova;
// erp_meta na versão e no hash de agora. E a interrupção: uma falha no meio
// do passo 7→8 desfaz a subida inteira (o objeto fica na v6, intacto) e a
// abertura seguinte completa.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../../src/erp/schema/ddl.ts";
import { migrate, recreateTriggers } from "../../src/erp/schema/migrate.ts";
import { createEngineTables, ERP_ENGINE_TABLES } from "../../src/erp/schema/engine-tables.ts";
import { dumpAll, restoreAll } from "../../src/erp/engine/dump.ts";
import { com1Fixture } from "./comnfe/fixtures.mjs";

const OLD = "4748b75"; // tronco implantado na instalação de teste (esquema v6)
const OLD_FILES = ["migrate.ts", "ddl.ts", "ddl.generated.ts", "seed.generated.ts"];
const q = (id) => `"${id.replace(/"/g, '""')}"`;

/** storage de objeto (sql.exec com cursor, transactionSync) sobre node:sqlite; `fail` simula a interrupção. */
function storage(db, fail = () => false) {
  return {
    sql: {
      exec(sql, ...params) {
        if (fail(sql)) throw new Error("interrompido: " + sql.slice(0, 60));
        const st = db.prepare(sql);
        st.setReadBigInts(true);
        if (/^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i.test(sql)) {
          const rows = st.all(...params);
          return { toArray: () => rows, raw: () => rows.map(row => Object.values(row)), rowsRead: rows.length, rowsWritten: 0 };
        }
        const r = st.run(...params);
        return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

let f, dir, oldMigrate;
before(async () => {
  dir = mkdtempSync(join(process.cwd(), `.com1-schema-${OLD}-`));
  for (const name of OLD_FILES)
    writeFileSync(join(dir, name), execFileSync("git", ["show", `${OLD}:src/erp/schema/${name}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  oldMigrate = (await import(pathToFileURL(join(dir, "migrate.ts")).href)).migrate;

  // Dados gravados pelo motor (os mesmos RPCs nos dois motores).
  f = await dualFixture();
  const u = f.users;
  const contact = await f.catalog("contacts", { name: "Cliente da subida", person_type: "J", roles: ["customer", "supplier"] });
  const product = await f.catalog("products", { name: "Produto da subida", unit: "UN", kind: "P", format: "S", price: "25.5000" });
  const warehouse = await f.catalog("warehouses", { name: "Depósito da subida" });
  await f.rpc("erp_stock_post", {
    p_user_id: u.estoque, p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-11-10", p_reason: "Entrada antes da subida",
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "7", expected_version: 0 }], p_reference: null,
  });
  await f.rpc("erp_document_save", {
    p_user_id: u.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-11-11", contact_id: contact.id, items: [{ product_id: product.id, description: "Item da subida", unit: "UN", quantity: "2", unit_price: "25.5", discount_percent: "0" }], installments: [] },
  });
  await f.rpc("erp_finance_account_execute", {
    p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: "checking", institution_code: "341", institution_name: "Itaú Unibanco", name: "Conta da subida", agency: "1", account_number: "2", account_digit: "3", start_on: "2026-01-01", opening_cents: "15000" },
  });
  await f.rpc("erp_finance_title_execute", {
    p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create",
    p_data: { kind: "receivable", contact_id: contact.id, description: "Título da subida", issued_on: "2026-11-11", competence_on: "2026-11-11", total_cents: "5100", installments: [{ amount_cents: "5100", due_on: "2026-12-11" }] },
  });
});
after(async () => {
  await f?.close();
  if (dir) {
    assert.ok(resolve(dir).startsWith(resolve(process.cwd()) + sep + `.com1-schema-${OLD}-`));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Objeto criado pelo migrate() de 4748b75 e com os dados do motor (as linhas que o v6 ainda não tem). */
function oldObject() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const created = oldMigrate(storage(db));
  assert.equal(created.status, "applied");
  assert.equal(created.version, 6, `${OLD} cria a v6`);
  const src = f.driver.db;
  const tables = tablesOf(db);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN");
  let copied = 0;
  for (const t of tables) {
    if (!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) continue;
    const read = src.prepare(`SELECT * FROM ${q(t)}`);
    read.setReadBigInts(true);
    for (const row of read.all()) {
      const cols = Object.keys(row);
      copied += Number(db.prepare(`INSERT OR IGNORE INTO ${q(t)} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c])).changes);
    }
  }
  db.exec("COMMIT");
  db.exec("PRAGMA foreign_keys=ON");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "dados copiados com as FKs inteiras");
  assert.ok(copied > 30, `linhas do motor copiadas: ${copied}`);
  return db;
}
const tablesOf = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('erp_meta','wb_routine') ORDER BY name").all().map((r) => r.name);
/** Conteúdo de cada tabela, linha a linha (texto canônico, ordenado). */
function content(db, tables = tablesOf(db)) {
  const out = {};
  for (const t of tables) {
    const st = db.prepare(`SELECT * FROM ${q(t)}`);
    st.setReadBigInts(true);
    out[t] = st.all().map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).sort();
  }
  return out;
}
/** Esquema: tabelas e índices por nome; gatilhos de cada tabela na ordem de criação (rowid do sqlite_master). */
function schema(db) {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const objects = rows.filter((r) => r.type !== "trigger").map((r) => `${r.type} ${r.name} ${r.sql}`).sort();
  const triggers = {};
  for (const r of rows.filter((r) => r.type === "trigger")) (triggers[r.tbl_name] ??= []).push(`${r.name} ${r.sql}`);
  return { objects, triggers };
}
const meta = (db) => Object.fromEntries(db.prepare("SELECT key, value FROM erp_meta").all().map((r) => [r.key, r.value]));

test("objeto da v6 (4748b75) com dados sobe para a versão atual numa abertura: dados intactos, esquema igual ao de uma instalação nova", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec("PRAGMA foreign_keys=ON");
  assert.equal(migrate(storage(fresh)).status, "applied");

  const db = oldObject();
  assert.deepEqual(meta(db), { schema_version: "6", schema_hash: "d492bbd25c82" });
  const before = content(db);
  const t0 = performance.now();
  const up = migrate(storage(db));
  const ms = performance.now() - t0;
  console.log(`subida v6 → v${ERP_DDL_VERSION}: ${ms.toFixed(1)} ms, ${Object.values(before).reduce((s, r) => s + r.length, 0)} linhas`);
  assert.deepEqual(up, { status: "applied", version: ERP_DDL_VERSION, rowsWritten: up.rowsWritten });
  assert.deepEqual(meta(db), { schema_version: String(ERP_DDL_VERSION), schema_hash: ERP_DDL_HASH });
  // Toda tabela que já existia, linha a linha.
  assert.deepEqual(content(db, Object.keys(before)), before);
  // As tabelas novas (só do motor) existem e estão vazias.
  for (const t of tablesOf(db).filter((t) => !(t in before))) assert.equal(db.prepare(`SELECT count(*) n FROM ${q(t)}`).get().n, 0, t);
  // v9: as 5 tabelas do cofre e os 2 gatilhos de imutabilidade do __received_change.
  const vault = ["erp_fiscal_vault__cursor", "erp_fiscal_vault__emission", "erp_fiscal_vault__event", "erp_fiscal_vault__received", "erp_fiscal_vault__received_change"];
  assert.deepEqual(tablesOf(db).filter((t) => t.startsWith("erp_fiscal_vault__")), [...vault, ...commercialTables, ...counterTables].sort());
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='erp_fiscal_vault__received_change' ORDER BY name").all().map((r) => r.name),
    ["erp_fiscal_vault__received_change_immutable_delete", "erp_fiscal_vault__received_change_immutable_update"],
  );
  // O esquema inteiro, com a ordem dos gatilhos, é o de uma instalação nova.
  const a = schema(db),
    b = schema(fresh);
  assert.deepEqual(a.objects, b.objects);
  assert.deepEqual(a.triggers, b.triggers);
  assert.equal(migrate(storage(db)).status, "current");
});

test("interrupção no meio do passo 7→8: a subida inteira é desfeita e a abertura seguinte completa", () => {
  const db = oldObject();
  const before = { meta: meta(db), schema: schema(db), content: content(db) };
  // Cai depois de o passo 6→7 criar as tabelas e de o 7→8 apagar os gatilhos.
  const stop = (sql) => /^CREATE TRIGGER "erp_cnab__operational_return_file_immutable__/.test(sql);
  assert.throws(() => migrate(storage(db, stop)), /interrompido/);
  assert.deepEqual(meta(db), before.meta, "continua na v6");
  assert.deepEqual(schema(db), before.schema, "esquema da v6, sem as tabelas novas e com os gatilhos de antes");
  assert.deepEqual(content(db), before.content);
  assert.equal(migrate(storage(db)).status, "applied");
  assert.deepEqual(meta(db), { schema_version: String(ERP_DDL_VERSION), schema_hash: ERP_DDL_HASH });
  assert.deepEqual(content(db, Object.keys(before.content)), before.content);
});

const commercialTables = ERP_ENGINE_TABLES.filter(t => t.since === 10).map(t => t.table);
// v13 (balcão com NFC-e): as irmãs do modelo 65 e a natureza do cupom.
const counterTables = ["audit", "cancel", "command", "effect", "emission", "revision", "settings"].map(name => `erp_fiscal_vault__counter_${name}`);
const hash = "a".repeat(64);
const now = 1_795_089_600_000_000;

function versionNineObject() {
  const db = oldObject();
  const s = storage(db);
  s.transactionSync(() => {
    createEngineTables(s.sql, 7);
    recreateTriggers(s.sql);
    createEngineTables(s.sql, 9);
    db.prepare("UPDATE erp_meta SET value='9' WHERE key='schema_version'").run();
  });
  return db;
}

function commercialRows(db) {
  const document = db.prepare("SELECT id, version FROM erp_documents__document WHERE kind='sales_orders' LIMIT 1").get();
  const emission = randomUUID(), command = randomUUID();
  const person = f.users.admin;
  storage(db).transactionSync(() => {
    db.prepare("INSERT INTO erp_fiscal_vault__commercial_settings(updated_at,updated_by) VALUES(?,?)").run(now, person);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_emission(id,document_id,fiscal_version,environment,connection_fingerprint,reference,current_body_revision,status,created_at,created_by,updated_at)
      VALUES(?,?,1,'homologacao',?,?,1,'preparada',?,?,?)`).run(emission, document.id, hash, `wb.${document.id}.v1`, now, person, now);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_revision(emission_id,body_revision,source_document_version,snapshot,tax_sources,commercial_hash,source_fingerprint,body,body_hash,calculation,blockers,prepared_by,prepared_at)
      VALUES(?,1,?,'{}','{}',?,?,'{}',?,'{}','[]',?,?)`).run(emission, document.version, hash, hash, hash, person, now);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_command(id,action,person_id,session_id,args_hash,emission_id,body_revision,state,token,lease_until,request,created_at,updated_at)
      VALUES(?,'emit',?,?,?,?,1,'claimed',?,?,'{}',?,?)`).run(command, person, randomUUID(), hash, emission, randomUUID(), now + 60_000_000, now, now);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_cancel(emission_id,justification,body,body_hash,command_id,created_at,updated_at)
      VALUES(?,'Cancelamento solicitado pelo cliente','{}',?,?,?,?)`).run(emission, hash, command, now, now);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_effect(emission_id,axis,state,reason,updated_at) VALUES(?,'stock','pulado','part_disabled',?)`).run(emission, now);
    db.prepare(`INSERT INTO erp_fiscal_vault__order_audit(id,person_id,command_id,emission_id,environment,action,created_at)
      VALUES(?,?,?,?,'homologacao','claim',?)`).run(randomUUID(), person, command, emission, now);
  });
  return { emission, command, document, person };
}

test("v15 vazia tem 1102 instruções e 466 tabelas; repetição e restrições comerciais preservadas", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const first = migrate(storage(db));
  assert.equal(first.version, ERP_DDL_VERSION);
  assert.equal(first.statements, 1102);
  assert.equal(tablesOf(db).length, 466);
  assert.equal(migrate(storage(db)).status, "current");
  assert.equal(commercialTables.length, 7);
  for (const table of commercialTables) {
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
    assert.match(definition, /\) STRICT$/);
    assert.match(definition, /CONSTRAINT/);
  }
  for (const table of ["erp_fiscal_drafts__draft", "erp_fiscal_invoices__invoice"])
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql, /environment[^\n]*'2'/);
  db.close();
});

test("v9 populada sobe aditivamente, falha no 9→10 é atômica e repetição conserva todo dado", () => {
  const db = versionNineObject();
  const before = { content: content(db), schema: schema(db), meta: meta(db) };
  assert.throws(() => migrate(storage(db, sql => sql.startsWith('CREATE TABLE "erp_fiscal_vault__order_cancel"'))), /interrompido/);
  assert.deepEqual(meta(db), before.meta);
  assert.deepEqual(schema(db), before.schema);
  assert.deepEqual(content(db), before.content);
  assert.equal(migrate(storage(db)).version, ERP_DDL_VERSION);
  assert.deepEqual(content(db, Object.keys(before.content)), before.content);
  const oldObjects = new Set(before.schema.objects);
  for (const object of oldObjects) assert.ok(schema(db).objects.includes(object), object);
  commercialRows(db);
  const populated = content(db);
  assert.equal(migrate(storage(db)).status, "current");
  assert.deepEqual(content(db), populated);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("contratos comerciais impõem unicidade, referências válidas e histórico imutável", () => {
  const db = versionNineObject();
  migrate(storage(db));
  const ids = commercialRows(db);
  for (const table of commercialTables.filter(t => !t.endsWith("commercial_settings"))) {
    const row = db.prepare(`SELECT * FROM ${q(table)} LIMIT 1`).get();
    const columns = Object.keys(row);
    assert.throws(() => db.prepare(`INSERT INTO ${q(table)}(${columns.map(q)}) VALUES(${columns.map(() => "?")})`).run(...Object.values(row)), /UNIQUE/);
  }
  assert.throws(() => db.prepare("UPDATE erp_fiscal_vault__order_emission SET reference='wb.outro.v1' WHERE id=?").run(ids.emission), /com1_emission_identity_immutable/);
  for (const table of ["erp_fiscal_vault__order_revision", "erp_fiscal_vault__order_audit"]) {
    assert.throws(() => db.exec(`UPDATE ${q(table)} SET ${table.endsWith("revision") ? "snapshot='{}'" : "action='alterada'"}`), /com1_history_immutable/);
    assert.throws(() => db.exec(`DELETE FROM ${q(table)}`), /com1_history_immutable/);
  }
  assert.throws(() => db.exec("UPDATE erp_fiscal_vault__order_command SET request='{\"diferente\":true}'"), /com1_command_identity_immutable/);
  assert.throws(() => db.exec("UPDATE erp_fiscal_vault__order_emission SET status='autorizada'"), /authorized_check/);
  db.exec("UPDATE erp_fiscal_vault__order_emission SET status='enviando'");
  assert.throws(() => db.exec("UPDATE erp_fiscal_vault__order_emission SET current_body_revision=2"), /com1_emission_body_frozen/);
  assert.throws(() => db.exec(`UPDATE erp_fiscal_vault__order_emission SET connection_fingerprint='${"b".repeat(64)}'`), /com1_emission_identity_immutable/);
  assert.throws(() => db.exec("UPDATE erp_fiscal_vault__order_cancel SET xml_status='disponivel',xml='<xml/>'"), /xml_check/);
  db.close();
});

test("backup e restauração incluem as sete tabelas novas e restauram os gatilhos", () => {
  const db = versionNineObject();
  migrate(storage(db));
  commercialRows(db);
  const snapshot = dumpAll(storage(db));
  for (const table of commercialTables) assert.ok(snapshot.manifest.tables.some(t => t.table === table), table);
  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys=ON");
  migrate(storage(restored));
  restoreAll(storage(restored), snapshot.manifest, new Map(snapshot.files.map(f => [f.table, f.body])));
  assert.deepEqual(content(restored), content(db));
  assert.deepEqual(schema(restored), schema(db));
  assert.throws(() => restored.exec("DELETE FROM erp_fiscal_vault__order_revision"), /com1_history_immutable/);
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  restored.close();
});

test("fixture comercial entrega fontes persistidas, papéis e relógio sem espera real", t => {
  const fixture = com1Fixture(t, { parts: { stock: false, finance: false } });
  assert.equal(fixture.order.kind, "sales_orders");
  assert.equal(fixture.company.cnpj, "11222333000181");
  assert.equal(fixture.nature.crt, "1");
  assert.equal(fixture.identity.actor.erp_role, "admin");
  assert.equal(fixture.parts.stock, false);
  assert.equal(fixture.parts.finance, false);
  assert.ok(fixture.lite.prepare("SELECT 1 FROM erp_documents__document WHERE id=?").get(fixture.order.id));
  const time = fixture.clock.now();
  fixture.clock.advance(60_000);
  assert.equal(fixture.clock.now(), time + 60_000);
});


const blingTables = ERP_ENGINE_TABLES.filter(t => t.since === 11).map(t => t.table);

function versionTenObject() {
  const db = versionNineObject();
  const s = storage(db);
  s.transactionSync(() => {
    createEngineTables(s.sql, 10);
    db.prepare("UPDATE erp_meta SET value='10' WHERE key='schema_version'").run();
  });
  commercialRows(db);
  return db;
}

for (const from of [9, 10]) test(`v${from} sobe à v11 sem tocar conteúdo prévio; interrupção no 10→11 desfaz tudo`, () => {
  const db = from === 9 ? versionNineObject() : versionTenObject();
  const before = { meta: meta(db), schema: schema(db), content: content(db) };
  assert.throws(() => migrate(storage(db, sql => sql.startsWith('CREATE TABLE "wb_bling_audit"'))), /interrompido/);
  assert.deepEqual(meta(db), before.meta);
  assert.deepEqual(schema(db), before.schema);
  assert.deepEqual(content(db), before.content);
  // A subida segue até a versão atual (12 e 13: tabelas da adoção; 14: balcão com NFC-e, também vazias).
  assert.equal(migrate(storage(db)).version, ERP_DDL_VERSION);
  assert.equal(blingTables.length, 6);
  assert.deepEqual(content(db, Object.keys(before.content)), before.content);
  for (const table of blingTables) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${q(table)}`).get().n, 0);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql, /\) STRICT$/);
  }
  const after = { meta: meta(db), schema: schema(db), content: content(db) };
  assert.equal(migrate(storage(db)).status, "current");
  assert.deepEqual({ meta: meta(db), schema: schema(db), content: content(db) }, after);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

for (const from of [9, 10]) test(`backup após v${from}→11 conserva NF-e e dados operacionais; restauração suspende coleta, credenciais e posses`, () => {
  const db = from === 9 ? versionNineObject() : versionTenObject();
  migrate(storage(db));
  if (from === 9) commercialRows(db);
  const instant = 1_795_089_600_000;
  const credential = randomUUID(); // Só material sintético gerado em memória, nunca gravado em arquivo.
  // A migração já semeia a conta legada única; a credencial usa essa mesma FK.
  assert.equal(db.prepare("SELECT count(*) n FROM origin_sync__account WHERE id=1").get().n, 1);
  db.prepare("INSERT INTO origin_sync__credentials(account_id,ciphertext,expires_at,revision,updated_at) VALUES(1,?,?,1,?)")
    .run(JSON.stringify({ synthetic: credential }), instant + 10000, instant);
  const oauthHash = "b".repeat(64), browserHash = "c".repeat(64);
  db.prepare("INSERT INTO origin_sync__oauth_state(state_hash,browser_hash,created_at,expires_at) VALUES(?,?,?,?)")
    .run(oauthHash, browserHash, instant, instant + 600000);
  db.prepare("INSERT INTO origin_sync__resource_state(resource,lease_owner,lease_token,lease_expires_at,updated_at) VALUES('contracts','old-worker','old-fence',?,?)")
    .run(instant + 5000, instant);
  db.prepare(`INSERT INTO wb_bling_control(revision,generation,authorization_revision,credential_revision,collect_enabled,state,account_id,approved_by,approved_at,approval_hash,app_configured,credential_status,updated_at)
    VALUES(4,2,3,2,1,'running','company','administrator',?,?,1,'ready',?)`).run(instant, hash, instant);
  db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,phase,owner,fence,lease_until,not_before,created_at,updated_at,account_id,parts_revision)
    VALUES('work','attempt','command',?,2,3,2,'detail','fetching','old-worker','old-fence',?,?,?,?,'company','1')`).run(hash, instant + 5000, instant, instant, instant);
  db.prepare(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,kind,not_before,state_hash,browser_hash,profile,session_id,actor_id,configuration_revision,expires_at,created_at,updated_at)
    VALUES('oauth','oauth-attempt','oauth-command',?,2,3,2,'oauth_state',?,?,?,'area','session','administrator',4,?,?,?)`)
    .run(hash, instant, oauthHash, browserHash, instant + 600000, instant, instant);
  db.prepare(`INSERT INTO wb_bling_extra_raw(entity,source_id,generation,last_resource,payload,version_hash,first_seen_at,last_seen_at,changed_at)
    VALUES('contracts','900719925474099312345',2,'contracts','{"total":"123.4500"}',?,?,?,?)`).run(hash, instant, instant, instant);
  const snapshot = dumpAll(storage(db));
  for (const table of commercialTables) assert.ok(snapshot.manifest.tables.some(t => t.table === table), table);
  const text = JSON.stringify(snapshot);
  for (const excluded of [credential, oauthHash, browserHash, "old-fence", "origin_sync__credentials", "origin_sync__oauth_state"])
    assert.equal(text.includes(excluded), false, "backup não pode conter material privado nem posses reutilizáveis");
  const unitFile = snapshot.files.find(f => f.table === "wb_bling_unit").body;
  assert.equal(unitFile.trimEnd().split("\n").length, 2, "só a unidade de coleta é exportada");
  const restored = new DatabaseSync(":memory:");
  restored.exec("PRAGMA foreign_keys=ON");
  migrate(storage(restored));
  restoreAll(storage(restored), snapshot.manifest, new Map(snapshot.files.map(f => [f.table, f.body])));
  const control = restored.prepare("SELECT * FROM wb_bling_control").get();
  assert.equal(control.collect_enabled, 0);
  assert.equal(control.state, "off");
  assert.equal(control.generation, 2, "geração mantém o vínculo do acervo");
  assert.equal(control.revision, 5);
  assert.equal(control.authorization_revision, 4);
  assert.equal(control.credential_revision, 3);
  assert.equal(control.approved_by, null);
  assert.equal(control.approval_hash, null);
  assert.equal(control.credential_status, "missing");
  const unit = restored.prepare("SELECT * FROM wb_bling_unit").get();
  assert.equal(unit.id, "work");
  assert.equal(unit.phase, "waiting");
  assert.equal(unit.owner, null);
  assert.equal(unit.fence, null);
  assert.equal(unit.lease_until, null);
  const resource = restored.prepare("SELECT * FROM origin_sync__resource_state WHERE resource='contracts'").get();
  assert.equal(resource.lease_owner, null);
  assert.equal(resource.lease_token, null);
  assert.equal(resource.lease_expires_at, null);
  for (const table of ["origin_sync__credentials", "origin_sync__oauth_state"])
    assert.equal(restored.prepare(`SELECT count(*) n FROM ${q(table)}`).get().n, 0);
  assert.deepEqual(content(restored, ["wb_bling_extra_raw"]), content(db, ["wb_bling_extra_raw"]));
  const operationalTables = tablesOf(db).filter(table => table.startsWith("erp_"));
  assert.deepEqual(content(restored, operationalTables), content(db, operationalTables));
  assert.deepEqual(schema(restored), schema(db));
  assert.throws(() => restored.exec("DELETE FROM erp_fiscal_vault__order_revision"), /com1_history_immutable/);
  // Restaurar de novo nunca faz a revisão regredir ao valor do backup.
  restored.exec("UPDATE wb_bling_control SET revision=20,authorization_revision=20,credential_revision=20");
  restoreAll(storage(restored), snapshot.manifest, new Map(snapshot.files.map(f => [f.table, f.body])));
  assert.deepEqual({ ...restored.prepare("SELECT revision,authorization_revision,credential_revision FROM wb_bling_control").get() },
    { revision: 21, authorization_revision: 21, credential_revision: 21 });
  assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
  const forbidden = { ...snapshot.manifest, tables: [...snapshot.manifest.tables, { table: "origin_sync__credentials", rows: 0, sha256: hash }] };
  assert.throws(() => restoreAll(storage(restored), forbidden, new Map()), /Tabela não permitida/);
  db.close();
  restored.close();
});
