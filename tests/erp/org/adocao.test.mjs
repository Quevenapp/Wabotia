// Fatia B1: adotar os cadastros coletados do Bling. Só SQLite em memória e
// RPCs do próprio ERP; nenhuma chamada ao Bling, rede ou cofre.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation, adoptionRequestHash } from "../../../src/erp/bling/adoption-api.ts";
import { runAdoptionUnit } from "../../../src/erp/bling/adoption.ts";
import { BLING_ADOPTION_ENTITIES } from "../../../src/erp/bling/adoption-contracts.ts";
import { blingFailureResponse, handleBlingOperation, nextBlingWake, prepareBlingDispatch, runBlingWake } from "../../../src/erp/bling/assembly.ts";

/** Armazenamento SQL como o do objeto: inteiros chegam como number. */
function sqliteStorage(db) {
  let depth = 0;
  return {
    sql: {
      get databaseSize() { return Number(db.prepare("PRAGMA page_count").get().page_count) * Number(db.prepare("PRAGMA page_size").get().page_size); },
      exec(sql, ...params) {
        const statement = db.prepare(sql);
        const columns = statement.columns();
        if (columns.length) {
          statement.setReturnArrays(true);
          const raw = statement.all(...params);
          const rows = raw.map(values => Object.fromEntries(columns.map((column, index) => [column.name, values[index]])));
          return { toArray: () => rows, raw: () => raw, rowsRead: rows.length, rowsWritten: 0 };
        }
        const result = statement.run(...params);
        return { toArray: () => [], raw: () => [], rowsRead: 0, rowsWritten: Number(result.changes) };
      },
    },
    transactionSync(fn) {
      const name = `adocao_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

const area = "adocao-area", admin = "b7200000-0000-4000-8000-000000000001", seller = "b7200000-0000-4000-8000-000000000002";
const now = Date.UTC(2026, 10, 20, 15);
const person = (user_id, erp_role) => ({ user_id, name: null, email: null, erp_role, verified_factor: true });
const people = [person(admin, "admin"), person(seller, "vendas")];
const identityOf = (user = admin, role = "admin", extra = {}) => ({ actor: { ...person(user, role), session_id: "sessao-" + user.slice(-4), aal: "aal2", is_agent: false, ...extra }, people });
let sequence = 0;
const commandId = () => `comando-${++sequence}`;
const uuid = () => { const h = createHash("sha256").update(String(++sequence)).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function fixture(partsInput = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const storage = sqliteStorage(sqlite); migrate(storage);
  const db = storageDriver(storage);
  let parts = normalizeErpParts(partsInput);
  const snapshot = () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts });
  sqlite.prepare("INSERT INTO wb_bling_control(id,account_id,updated_at) VALUES(1,'conta',?)").run(now);
  const versions = new Map();
  function seed(entity, payload) {
    const text = JSON.stringify(payload), hash = createHash("sha256").update(text).digest("hex");
    const version = (versions.get(entity + payload.id) ?? 0) + 1; versions.set(entity + payload.id, version);
    sqlite.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(entity, now);
    sqlite.prepare(`INSERT INTO origin_sync__raw_record(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload, version_hash=excluded.version_hash, version=excluded.version`).run(entity, payload.id, entity, text, hash, version, now, now, now);
  }
  async function call(name, input, identity = identityOf(), authorization = null) {
    const response = await handleAdoptionOperation({ name, identity, profile: area, input, authorization }, { storage, readSnapshot: async () => snapshot() });
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input, identity) {
    const result = await call(name, input, identity);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  /** Roda o lote até o fim, como o alarme faria. */
  function drain() {
    for (let i = 0; i < 200; i++) if (!runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more) return;
    assert.fail("o lote não terminou");
  }
  /** Cadastro feito "à mão", pelas mesmas RPCs das telas. */
  function rpc(name, args) {
    return callRpc(db, name, { p_user_id: admin, ...args }, undefined, { identity: identityOf(), parts });
  }
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  return { sqlite, storage, db, seed, call, ok, drain, rpc, count, setParts(next) { parts = normalizeErpParts(next); } };
}

const contact = (id, nome, extra = {}) => ({ id, nome, situacao: "A", tipo: "F", ...extra });

test("lote adota sem duplicar, liga o que bate, deixa pendente o que diverge e repete sem criar outro", async () => {
  const f = fixture();
  // Já cadastrados à mão no ERP.
  f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Mercado Bom Preço", person_type: "J", document: "11.222.333/0001-81" }, p_acknowledged: null });
  f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Nome Antigo", person_type: "F", document: "390.533.447-05" }, p_acknowledged: null });
  f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Sem Documento", email: "maria@exemplo.com.br" }, p_acknowledged: null });
  f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Café 500 g", code: "CAFE500", price: "19.9", unit: "UN" }, p_acknowledged: null });
  const contactsBefore = f.count("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'");

  f.seed("product_categories", { id: "10", descricao: "Bebidas" });
  f.seed("product_categories", { id: "11", descricao: "Cafés", categoriaPai: { id: "10" } });
  f.seed("contacts", contact("100", "Ana Souza", { numeroDocumento: "529.982.247-25", email: "ana@exemplo.com.br", tiposContato: [{ descricao: "Cliente" }] }));
  f.seed("contacts", contact("101", "Mercado Bom Preço", { tipo: "J", numeroDocumento: "11222333000181" }));
  f.seed("contacts", contact("102", "Nome Novo", { numeroDocumento: "39053344705" }));
  f.seed("contacts", contact("103", "Maria", { email: "maria@exemplo.com.br" }));
  f.seed("contacts", contact("104", "CPF Errado", { numeroDocumento: "111.111.111-12" }));
  f.seed("sellers", { id: "200", contato: { id: "100", nome: "Ana Souza" } });
  f.seed("products", { id: "300", nome: "Café 500 g", codigo: "CAFE500", preco: 19.90, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  f.seed("products", { id: "301", nome: "Café especial", codigo: "CAFE-ESP", preco: 42.5, unidade: "UN", tipo: "P", formato: "S", situacao: "A", categoria: { id: "11" } });
  f.seed("products", { id: "302", nome: "Unidade longa demais", codigo: "LONGO", preco: 1, unidade: "UNIDADE-COM-NOME-MUITO-LONGO", tipo: "P", formato: "S", situacao: "A" });
  f.seed("warehouses", { id: "400", descricao: "Depósito central", situacao: 1, desconsiderarSaldo: false });
  f.seed("payment_methods", { id: "500", descricao: "Pix", tipoPagamento: 17, situacao: 1 });
  f.seed("financial_categories", { id: "600", descricao: "Vendas de mercadorias", tipo: 2 });
  f.seed("ledger_accounts", { id: "700", descricao: "Caixa da loja" });

  const status = await f.ok("erp_bling_adoption_status", {});
  assert.equal(status.available, true);
  assert.deepEqual(status.entities.map(item => item.entity), [...BLING_ADOPTION_ENTITIES]);
  assert.equal(status.entities.find(item => item.entity === "contacts").collected, 5);
  assert.equal(status.job.state, "idle");

  const started = await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_ENTITIES] });
  assert.ok(["running", "done"].includes(started.job.state));
  f.drain();
  const after = await f.ok("erp_bling_adoption_status", {});
  assert.equal(after.job.state, "done");
  const by = Object.fromEntries(after.entities.map(item => [item.entity, item]));  assert.deepEqual([by.contacts.adopted, by.contacts.pending, by.contacts.waiting], [2, 3, 0]);
  assert.deepEqual([by.products.adopted, by.products.pending], [2, 1]);
  for (const entity of ["product_categories", "sellers", "warehouses", "payment_methods", "financial_categories", "ledger_accounts"]) assert.equal(by[entity].adopted, by[entity].collected, entity);

  // Criado pelas RPCs do domínio, com o vínculo ao id do Bling.
  const ana = f.sqlite.prepare("SELECT l.record_id, l.mode, l.source_version, r.name, c.document, c.roles FROM wb_bling_adoption_link l JOIN erp_catalog__record r ON r.id=l.record_id JOIN erp_catalog__contact c ON c.record_id=r.id WHERE l.entity='contacts' AND l.source_id='100'").get();
  assert.equal(ana.name, "Ana Souza"); assert.equal(ana.mode, "created"); assert.equal(Number(ana.source_version), 1); assert.match(String(ana.roles), /customer/);
  assert.equal(f.sqlite.prepare("SELECT mode FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='101'").get().mode, "linked");
  assert.equal(f.sqlite.prepare("SELECT mode FROM wb_bling_adoption_link WHERE entity='products' AND source_id='300'").get().mode, "linked");
  const special = f.sqlite.prepare("SELECT d.category_id, t.name FROM wb_bling_adoption_link l JOIN erp_catalog__product_detail d ON d.record_id=l.record_id JOIN erp_catalog__taxonomy t ON t.id=d.category_id WHERE l.entity='products' AND l.source_id='301'").get();
  assert.equal(special.name, "Cafés");
  const child = f.sqlite.prepare("SELECT t.parent_id, p.name parent FROM wb_bling_adoption_link l JOIN erp_catalog__taxonomy t ON t.id=l.record_id JOIN erp_catalog__taxonomy p ON p.id=t.parent_id WHERE l.entity='product_categories' AND l.source_id='11'").get();
  assert.equal(child.parent, "Bebidas");
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__seller s JOIN wb_bling_adoption_link l ON l.entity='contacts' AND l.source_id='100' AND l.record_id=s.contact_id"), 1);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'"), contactsBefore + 1);

  // Pendências com o motivo e as duas versões.
  const reviews = await f.ok("erp_bling_adoption_reviews", { entity: "contacts" });
  const reason = Object.fromEntries(reviews.items.map(item => [item.source_id, item]));
  assert.equal(reason["102"].reason, "divergent"); assert.equal(reason["102"].bling["Nome"], "Nome Novo"); assert.equal(reason["102"].erp[0].summary["Nome"], "Nome Antigo");
  assert.equal(reason["103"].reason, "suggestion"); assert.equal(reason["103"].erp.length, 1);
  assert.equal(reason["104"].reason, "invalid_document"); assert.match(reason["104"].reason_text, /CPF ou CNPJ/);
  const productReview = (await f.ok("erp_bling_adoption_reviews", { entity: "products" })).items[0];
  assert.equal(productReview.source_id, "302"); assert.equal(productReview.reason, "invalid_data");

  // Repetir não cria outro cadastro.
  const records = f.count("SELECT count(*) n FROM erp_catalog__record");
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_ENTITIES] });
  f.drain();
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__record"), records);
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link WHERE entity='contacts'"), 2);
  // Nada sai para o Bling: a sincronização de mão dupla continua desligada e sem fila.
  assert.equal(f.count("SELECT count(*) n FROM erp_sync__outbox"), 0);
  assert.equal(f.count("SELECT count(*) n FROM erp_sync__link"), 0);

  // Resolver: manter a do ERP e ligar; usar a do Bling num novo; ignorar.
  const keep = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "contacts", source_id: "102", action: "keep_erp", record_id: reason["102"].erp[0].record_id });
  assert.equal(keep.outcome, "linked");
  assert.equal(f.sqlite.prepare("SELECT name FROM erp_catalog__record WHERE id=?").get(keep.record_id).name, "Nome Antigo");
  const fresh = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "contacts", source_id: "103", action: "use_bling" });
  assert.equal(fresh.outcome, "adopted"); assert.notEqual(fresh.record_id, reason["103"].erp[0].record_id);
  const resolveInput = { command_id: commandId(), entity: "contacts", source_id: "104", action: "ignore" };
  assert.equal((await f.ok("erp_bling_adoption_resolve", resolveInput)).outcome, "ignored");
  // O mesmo comando devolve o mesmo recibo; com outro pedido, recusa.
  assert.equal((await f.ok("erp_bling_adoption_resolve", resolveInput)).receipt.replayed, true);
  const conflict = await f.call("erp_bling_adoption_resolve", { ...resolveInput, action: "use_bling" });
  assert.equal(conflict.body.error.code, "BLING_ADOPTION_COMMAND_CONFLICT");
  const final = Object.fromEntries((await f.ok("erp_bling_adoption_status", {})).entities.map(item => [item.entity, item]));
  assert.deepEqual([final.contacts.adopted, final.contacts.pending, final.contacts.ignored], [4, 0, 1]);

  // Usar a do Bling num cadastro existente atualiza pela RPC da tela.
  f.seed("contacts", contact("105", "Ana S. Atualizada", { numeroDocumento: "529.982.247-25" }));
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  f.drain();
  const duplicate = (await f.ok("erp_bling_adoption_reviews", { entity: "contacts" })).items.find(item => item.source_id === "105");
  assert.equal(duplicate.reason, "ambiguous", "o cadastro com o mesmo CPF já está ligado a outro registro do Bling");

  // Desligar do Bling: só o vínculo sai; o cadastro fica e o lote não religa sozinho.
  const unlinked = await f.ok("erp_bling_adoption_unlink", { command_id: commandId(), entity: "contacts", source_id: "101" });
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__record WHERE id=?", unlinked.record_id), 1);
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='101'"), 0);
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  f.drain();
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='101'"), 0);
  const ignored = await f.ok("erp_bling_adoption_reviews", { entity: "contacts", state: "ignored" });
  assert.ok(ignored.items.some(item => item.source_id === "101" && item.reason === "unlinked"));
  // E a pessoa pode ligar de novo pelos ignorados.
  const relink = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "contacts", source_id: "101", action: "keep_erp", record_id: unlinked.record_id });
  assert.equal(relink.outcome, "linked");
});

test("usar a do Bling atualiza o cadastro existente pelas regras da tela", async () => {
  const f = fixture();
  f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: uuid(), p_data: { name: "Açúcar", code: "ACU1", price: "5", unit: "UN" }, p_acknowledged: null });
  f.seed("products", { id: "310", nome: "Açúcar cristal 1 kg", codigo: "ACU1", preco: 6.5, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["products"] });
  f.drain();
  const review = (await f.ok("erp_bling_adoption_reviews", { entity: "products" })).items[0];
  assert.equal(review.reason, "divergent");
  assert.equal(review.bling["Preço"], "6.5"); assert.equal(review.erp[0].summary["Preço"], "5");
  const updated = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "products", source_id: "310", action: "use_bling", record_id: review.erp[0].record_id });
  assert.equal(updated.outcome, "updated");
  const row = f.sqlite.prepare("SELECT r.name, r.version FROM erp_catalog__record r WHERE r.id=?").get(updated.record_id);
  assert.equal(row.name, "Açúcar cristal 1 kg"); assert.equal(Number(row.version), 2);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__record WHERE entity='products'"), 1);
});

test("variações do produto viram variações do ERP", async () => {
  const f = fixture();
  f.seed("products", { id: "320", nome: "Camiseta", codigo: "CAM", preco: 50, unidade: "UN", tipo: "P", formato: "V", situacao: "A",
    variacoes: [{ id: "321", nome: "Camiseta Azul P", codigo: "CAM-AZ-P", preco: 50, variacao: { nome: "Cor:Azul;Tamanho:P" } }, { id: "322", nome: "Camiseta sem atributo", codigo: "CAM-X" }] });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["products"] });
  f.drain();
  const parent = f.sqlite.prepare("SELECT record_id FROM wb_bling_adoption_link WHERE entity='products' AND source_id='320'").get().record_id;
  const variation = f.sqlite.prepare("SELECT l.record_id, r.code FROM wb_bling_adoption_link l JOIN erp_catalog__record r ON r.id=l.record_id WHERE l.entity='products' AND l.source_id='321'").get();
  assert.equal(variation.code, "CAM-AZ-P");
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__product_variation WHERE parent_id=? AND child_id=?", parent, variation.record_id), 1);
  assert.equal(f.sqlite.prepare("SELECT reason FROM wb_bling_adoption_review WHERE entity='products' AND source_id='322'").get().reason, "invalid_data");
  // A pendência da variação aparece e pode ser ignorada, mesmo sem registro próprio no acervo.
  assert.equal((await f.ok("erp_bling_adoption_status", {})).entities.find(item => item.entity === "products").pending, 1);
  const pending = (await f.ok("erp_bling_adoption_reviews", { entity: "products" })).items[0];
  assert.equal(pending.source_id, "322"); assert.equal(pending.bling, null); assert.match(pending.detail, /sem atributos/);
  const refused = await f.call("erp_bling_adoption_resolve", { command_id: commandId(), entity: "products", source_id: "322", action: "use_bling" });
  assert.equal(refused.body.error.code, "BLING_ADOPTION_RECORD_REFUSED");
  assert.equal((await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "products", source_id: "322", action: "ignore" })).outcome, "ignored");
});

test("produto com recurso de módulo desligado vira pendência só dele; o lote segue", async () => {
  const f = fixture({ stock: false, pos: false });
  f.seed("products", { id: "350", nome: "Kit composto", codigo: "KIT", preco: 10, unidade: "UN", tipo: "P", formato: "E", situacao: "A" });
  f.seed("products", { id: "351", nome: "Simples", codigo: "SIMPLES", preco: 1, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["products"] });
  f.drain();
  const status = await f.ok("erp_bling_adoption_status", {});
  assert.equal(status.job.state, "done"); assert.equal(status.job.stop, null);
  const products = status.entities.find(item => item.entity === "products");
  assert.deepEqual([products.adopted, products.pending], [1, 1]);
  const review = (await f.ok("erp_bling_adoption_reviews", { entity: "products" })).items[0];
  assert.equal(review.source_id, "350"); assert.match(review.detail, /módulo desligado/);
});

test("parte desligada: a entidade avisa qual módulo ligar e a adoção recusa sem erro genérico", async () => {
  const f = fixture({ products: false, stock: false, finance: false, sales: false, purchases: false, pos: false, billing: false });
  f.seed("products", { id: "330", nome: "Produto", codigo: "P1", preco: 1, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  const status = await f.ok("erp_bling_adoption_status", {});
  const products = status.entities.find(item => item.entity === "products");
  assert.equal(products.enabled, false); assert.match(products.part_off_message, /Produtos e serviços/);
  assert.match(status.entities.find(item => item.entity === "warehouses").part_off_message, /Estoque/);
  assert.match(status.entities.find(item => item.entity === "ledger_accounts").part_off_message, /Financeiro/);
  assert.equal(status.entities.find(item => item.entity === "contacts").enabled, true);
  const refused = await f.call("erp_bling_adoption_start", { command_id: commandId(), entities: ["products"] });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, "BLING_ADOPTION_PART_DISABLED"); assert.match(refused.body.error.detail, /Produtos e serviços/);
  // Com a Base desligada, nada responde.
  f.setParts({ customers: false });
  assert.equal((await f.call("erp_bling_adoption_status", {})).body.error.code, "BLING_ADOPTION_DISABLED");
});

test("lote pausa, retoma de onde parou e para com o motivo quando a parte é desligada no meio", async () => {
  const f = fixture();
  for (let i = 1; i <= 30; i++) f.seed("contacts", contact(String(1000 + i), `Contato ${i}`));
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  const firstUnit = f.count("SELECT count(*) n FROM wb_bling_adoption_link");
  assert.ok(firstUnit > 0 && firstUnit < 30, "unidades pequenas");
  const paused = await f.ok("erp_bling_adoption_pause", { command_id: commandId() });
  assert.equal(paused.job.state, "paused");
  assert.equal(runAdoptionUnit({ db: f.db, profile: area, now: () => Date.now(), parts: normalizeErpParts({}) }).worked, false);
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  f.drain();
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link"), 30);
  assert.equal(f.count("SELECT count(*) n FROM erp_catalog__record WHERE entity='contacts'"), 30);

  for (let i = 1; i <= 30; i++) f.seed("products", { id: String(3400 + i), nome: `Produto ${i}`, codigo: `P${3400 + i}`, preco: 1, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["products"] });
  f.setParts({ products: false, stock: false, sales: false, purchases: false, pos: false });
  f.drain();
  const status = await f.ok("erp_bling_adoption_status", {});
  assert.equal(status.job.state, "paused"); assert.equal(status.job.stop.code, "module_disabled");
});

test("só administrador; bot só com a operação confirmada pela pessoa", async () => {
  const f = fixture();
  const notAdmin = await f.call("erp_bling_adoption_status", {}, identityOf(seller, "vendas"));
  assert.equal(notAdmin.status, 403); assert.equal(notAdmin.body.error.code, "BLING_ADOPTION_ADMIN_REQUIRED");
  const bot = identityOf(admin, "admin", { is_agent: true });
  const input = { command_id: commandId(), entities: ["contacts"] };
  const missing = await f.call("erp_bling_adoption_start", input, bot);
  assert.equal(missing.body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  const unconfirmed = await f.call("erp_bling_adoption_start", input, bot, { request_hash: adoptionRequestHash(input), bot: { id: "bot-1", operation: "erp_bling_adoption_start" }, delegation: { run_id: "run-1" }, confirmed: false });
  assert.equal(unconfirmed.body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  const otherOperation = await f.call("erp_bling_adoption_start", input, bot, { request_hash: adoptionRequestHash(input), bot: { id: "bot-1", operation: "erp_bling_adoption_pause" }, delegation: { run_id: "run-1", proposal_id: "p-1" }, confirmed: true });
  assert.equal(otherOperation.body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  const confirmed = await f.call("erp_bling_adoption_start", input, bot, { request_hash: adoptionRequestHash(input), bot: { id: "bot-1", operation: "erp_bling_adoption_start" }, delegation: { run_id: "run-1", proposal_id: "p-1" }, confirmed: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  // Leitura não sensível: basta a operação concedida.
  const read = await f.call("erp_bling_adoption_status", {}, bot, { request_hash: adoptionRequestHash({}), bot: { id: "bot-1", operation: "erp_bling_adoption_status" }, delegation: { run_id: "run-1" }, confirmed: false });
  assert.equal(read.status, 200);
});

test("rota interna do objeto despacha a adoção sem montar a coleta e recusa quem não é administrador", async () => {
  const f = fixture();
  f.seed("contacts", contact("900", "Pela rota"));
  const dependencies = { env: {}, storage: f.storage, profile: area, readParts: async () => normalizeErpParts({}),
    readSnapshot: async () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts: normalizeErpParts({}) }) };
  const request = body => new Request("https://erp.invalid/erp-bling/operations/x", { method: "POST", body: JSON.stringify(body) });
  const start = await prepareBlingDispatch(area, "/erp-bling/operations/erp_bling_adoption_start", request({ command_id: commandId(), entities: ["contacts"] }), identityOf());
  assert.equal(start.name, "erp_bling_adoption_start");
  const response = await handleBlingOperation(start, dependencies);
  assert.equal(response.status, 200);
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link WHERE source_id='900'"), 1);
  await assert.rejects(prepareBlingDispatch(area, "/erp-bling/operations/erp_bling_adoption_status", request({}), identityOf(seller, "vendas")), error => error.code === "BLING_ADOPTION_ADMIN_REQUIRED");
  const refused = blingFailureResponse(await prepareBlingDispatch(area, "/erp-bling/operations/erp_bling_adoption_start", request({ entities: [] }), identityOf()).catch(error => error));
  assert.equal(refused.status, 400); assert.equal((await refused.json()).error.code, "BLING_ADOPTION_INVALID");
});

test("alarme: uma unidade por acordada elegível e volta logo enquanto há lote", async () => {
  const f = fixture();
  for (let i = 1; i <= 30; i++) f.seed("contacts", contact(String(2000 + i), `Alarme ${i}`));
  const dependencies = { env: {}, storage: f.storage, profile: area, readParts: async () => normalizeErpParts({}),
    readSnapshot: async () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts: normalizeErpParts({}) }) };
  assert.equal(await nextBlingWake(area, dependencies, 5), null, "sem lote nem coleta, o alarme não volta");
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  assert.equal(await nextBlingWake(area, dependencies, 5), 5);
  const clock = { now: () => Date.now() };
  const ran = await runBlingWake(area, dependencies, { eligible: true, nextOperationalAt: null, clock });
  assert.equal(ran.worked, true); assert.equal(ran.requests, 0); assert.ok(ran.nextWake > Date.now());
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_link"), 30);
  await runBlingWake(area, dependencies, { eligible: true, nextOperationalAt: null, clock });
  assert.equal((await f.ok("erp_bling_adoption_status", {})).job.state, "done");
});

test("sem conta vinculada ao acervo, a adoção explica e não começa", async () => {
  const f = fixture();
  f.sqlite.prepare("UPDATE wb_bling_control SET account_id=NULL").run();
  const status = await f.ok("erp_bling_adoption_status", {});
  assert.equal(status.available, false); assert.match(status.unavailable_message, /Colete os dados/);
  const refused = await f.call("erp_bling_adoption_start", { command_id: commandId(), entities: ["contacts"] });
  assert.equal(refused.body.error.code, "BLING_ADOPTION_UNAVAILABLE");
});
