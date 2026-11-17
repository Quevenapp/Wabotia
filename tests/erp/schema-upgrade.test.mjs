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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { ERP_DDL_HASH, ERP_DDL_VERSION } from "../../src/erp/schema/ddl.ts";
import { migrate } from "../../src/erp/schema/migrate.ts";

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
          return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
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
  dir = mkdtempSync(join(tmpdir(), `erp-schema-${OLD}-`));
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
  if (dir) rmSync(dir, { recursive: true, force: true });
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
