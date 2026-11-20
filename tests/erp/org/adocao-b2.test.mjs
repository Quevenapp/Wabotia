// Fatia B2: documentos e contas em aberto do Bling viram documentos e títulos
// do ERP, sem efeitos; os encerrados ficam no histórico. Só SQLite em memória
// e RPCs do próprio ERP; nenhuma chamada ao Bling, rede ou cofre.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation } from "../../../src/erp/bling/adoption-api.ts";
import { runAdoptionUnit } from "../../../src/erp/bling/adoption.ts";
import { BLING_ADOPTION_B2_ENTITIES, BLING_ADOPTION_RECORD_ENTITIES, BLING_HISTORY_READONLY } from "../../../src/erp/bling/adoption-contracts.ts";
import { build } from "esbuild";

// Inventário dos bots: empacotado como em bot-access.test.mjs (imports do Worker sem extensão).
const bundle = await build({ entryPoints: ["src/modules/erp/bot-access.ts"], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
const { ERP_BOT_OPERATIONS } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

function sqliteStorage(db) {
  let depth = 0;
  return {
    sql: {
      get databaseSize() { return 0; },
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
      const name = `b2_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

const area = "adocao-b2", admin = "b7300000-0000-4000-8000-000000000001";
const now = Date.UTC(2026, 10, 20, 15);
const person = (user_id, erp_role) => ({ user_id, name: null, email: null, erp_role, verified_factor: true });
const identityOf = () => ({ actor: { ...person(admin, "admin"), session_id: "sessao-0001", aal: "aal2", is_agent: false }, people: [person(admin, "admin")] });
let sequence = 0;
const commandId = () => `b2-comando-${++sequence}`;

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
  async function call(name, input) {
    const response = await handleAdoptionOperation({ name, identity: identityOf(), profile: area, input, authorization: null }, { storage, readSnapshot: async () => snapshot() });
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input) {
    const result = await call(name, input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  function drain() {
    for (let i = 0; i < 400; i++) if (!runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more) return;
    assert.fail("o lote não terminou");
  }
  const rpc = (name, args) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, { identity: identityOf(), parts });
  const pref = (page, key, value) => {
    const old = rpc("erp_preferences_page", { p_page: page }).items.find(i => i.key === key);
    rpc("erp_preferences_save", { p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: old.version, value }] });
  };
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  const one = (sql, ...params) => sqlite.prepare(sql).get(...params);
  return { sqlite, db, seed, call, ok, drain, rpc, pref, count, one, setParts(next) { parts = normalizeErpParts(next); } };
}

/** Cadastros já coletados e adotados (fatia B1), como numa conta de verdade. */
async function withRecords(f) {
  f.seed("contacts", { id: "100", nome: "Ana Souza", tipo: "F", situacao: "A", numeroDocumento: "529.982.247-25", tiposContato: [{ descricao: "Cliente" }] });
  f.seed("contacts", { id: "101", nome: "Distribuidora Sul", tipo: "J", situacao: "A", numeroDocumento: "11222333000181", tiposContato: [{ descricao: "Fornecedor" }] });
  f.seed("sellers", { id: "200", contato: { id: "100", nome: "Ana Souza" } });
  f.seed("products", { id: "300", nome: "Café 500 g", codigo: "CAFE500", preco: 19.9, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  f.seed("payment_methods", { id: "500", descricao: "Pix", tipoPagamento: 17, situacao: 1 });
  f.seed("financial_categories", { id: "600", descricao: "Vendas", tipo: 2 });
  f.seed("financial_categories", { id: "601", descricao: "Fornecedores", tipo: 1 });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_RECORD_ENTITIES] });
  f.drain();
  const contact = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='100'");
  assert.ok(contact, "o contato do teste precisa estar adotado");
}

const order = (id, extra = {}) => ({
  id, numero: "15", data: "2026-11-10", dataPrevista: "2026-11-20", situacao: { id: 6, valor: 0 }, contato: { id: "100", nome: "Ana Souza" }, vendedor: { id: "200" },
  itens: [{ codigo: "CAFE500", unidade: "UN", quantidade: 2, valor: 19.9, desconto: 0, descricao: "Café 500 g", produto: { id: "300" } }],
  parcelas: [{ dataVencimento: "2026-12-10", valor: 39.8, formaPagamento: { id: "500" } }], total: 39.8,
  observacoes: "Entregar pela manhã", observacoesInternas: "Cliente antigo", ...extra,
});
const effects = f => ({
  finance: f.count("SELECT count(*) n FROM erp_finance__document_posting"), stock: f.count("SELECT count(*) n FROM erp_stock__document_posting"),
  reservations: f.count("SELECT count(*) n FROM erp_stock__reservation"), titlesFromDocs: f.count("SELECT count(*) n FROM erp_finance__document_title"),
  settlements: f.count("SELECT count(*) n FROM erp_finance__settlement"),
});

test("em aberto vira documento e conta do ERP sem efeitos; encerrado vai para o histórico; repetir não duplica", async () => {
  const f = fixture();
  await withRecords(f);
  f.seed("sales_orders", order("9001"));
  f.seed("sales_orders", order("9002", { numero: "16", situacao: { id: 9, valor: 1 }, data: "2026-10-01", total: 120 }));
  f.seed("sales_orders", order("9003", { numero: "17", situacao: { id: 12, valor: 2 }, data: "2026-10-05" }));
  f.seed("sales_proposals", { id: "8001", numero: "40", data: "2026-11-01", situacao: "Pendente", contato: { id: "100", nome: "Ana Souza" },
    itens: [{ descricao: "Café 500 g", codigo: "CAFE500", unidade: "UN", quantidade: 10, valor: 18, produto: { id: "300" } }], total: 180 });
  f.seed("sales_proposals", { id: "8002", numero: "41", data: "2026-09-01", situacao: "Aprovado", contato: { id: "100", nome: "Ana Souza" }, itens: [], total: 50 });
  f.seed("purchase_orders", { id: "7001", numero: "7", data: "2026-11-05", situacao: { valor: 0 }, fornecedor: { id: "101", nome: "Distribuidora Sul" },
    itens: [{ descricao: "Café 500 g", codigoFornecedor: "F-1", unidade: "UN", valor: 10, quantidade: 5, produto: { id: "300" } }],
    parcelas: [{ valor: 50, dataVencimento: "2026-12-05" }], total: 50 });
  f.seed("receivables", { id: "6001", situacao: 1, vencimento: "2026-12-01", valor: 100, saldo: 100, dataEmissao: "2026-11-01", numeroDocumento: "NF 123",
    historico: "Venda balcão", contato: { id: "100" }, formaPagamento: { id: "500" }, categoria: { id: "600" } });
  f.seed("receivables", { id: "6002", situacao: 1, vencimento: "2026-12-01", valor: 100, saldo: 40, dataEmissao: "2026-11-01", contato: { id: "100" } });
  f.seed("receivables", { id: "6003", situacao: 2, vencimento: "2026-10-01", valor: 80, saldo: 0, dataEmissao: "2026-09-01", contato: { id: "100" } });
  f.seed("payables", { id: "5001", situacao: 1, vencimento: "2026-12-15", valor: 250.5, dataEmissao: "2026-11-10", numeroDocumento: "Boleto 9",
    contato: { id: "101" }, categoria: { id: "601" } });
  f.seed("payables", { id: "5002", situacao: 5, vencimento: "2026-12-15", valor: 30, contato: { id: "101" } });
  const before = effects(f);

  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_B2_ENTITIES] });
  f.drain();
  const status = await f.ok("erp_bling_adoption_status", {});
  const by = Object.fromEntries(status.entities.map(item => [item.entity, item]));
  assert.deepEqual([by.sales_orders.adopted, by.sales_orders.history, by.sales_orders.pending, by.sales_orders.waiting], [1, 2, 0, 0]);
  assert.deepEqual([by.sales_proposals.adopted, by.sales_proposals.history], [1, 1]);
  assert.deepEqual([by.purchase_orders.adopted, by.purchase_orders.history], [1, 0]);
  assert.deepEqual([by.receivables.adopted, by.receivables.history], [1, 2]);
  assert.deepEqual([by.payables.adopted, by.payables.history], [1, 1]);
  // Totais do que ficou de fora e por quê.
  const outside = Object.fromEntries(by.receivables.outside.map(item => [item.scope, item]));
  assert.equal(outside.partial.count, 1); assert.equal(outside.partial.total_cents, "10000"); assert.match(outside.partial.label, /parcial/);
  assert.equal(outside.paid.count, 1); assert.equal(outside.paid.total_cents, "8000");
  assert.equal(status.job.counts.history, 6);

  // Pedido de venda: pelo domínio, Em aberto, com cliente, item, vendedor, forma de pagamento e observações.
  const sale = f.one(`SELECT d.* FROM wb_bling_adoption_doc_link l JOIN erp_documents__document d ON d.id=l.record_id WHERE l.entity='sales_orders' AND l.source_id='9001'`);
  assert.equal(sale.kind, "sales_orders"); assert.equal(sale.status, "open"); assert.equal(sale.origin, "brufap");
  const contact = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='100'").record_id;
  assert.equal(sale.contact_id, contact);
  const body = JSON.parse(sale.body);
  assert.equal(body.seller_id, f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='sellers' AND source_id='200'").record_id);
  assert.equal(body.installments[0].payment_method_id, f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='payment_methods' AND source_id='500'").record_id);
  assert.equal(body.notes, "Entregar pela manhã");
  assert.match(body.internal_notes, /Adotado do Bling: pedido de venda nº 15 \(id 9001\), situação no Bling: Em aberto/);
  assert.match(body.internal_notes, /Cliente antigo/);
  const item = f.one("SELECT product_id, quantity FROM erp_documents__item WHERE document_id=?", sale.id);
  assert.equal(item.product_id, f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='products' AND source_id='300'").record_id);
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__audit WHERE document_id=? AND action='create'", sale.id), 1);
  // Proposta: na situação equivalente (Pendente), pela transição da tela.
  const proposal = f.one(`SELECT d.status FROM wb_bling_adoption_doc_link l JOIN erp_documents__document d ON d.id=l.record_id WHERE l.entity='sales_proposals'`);
  assert.equal(proposal.status, "pending");
  // Pedido de compra: fornecedor e código do fornecedor.
  const purchase = f.one(`SELECT d.* FROM wb_bling_adoption_doc_link l JOIN erp_documents__document d ON d.id=l.record_id WHERE l.entity='purchase_orders'`);
  assert.equal(purchase.status, "open");
  assert.equal(purchase.contact_id, f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='101'").record_id);
  assert.equal(JSON.parse(f.one("SELECT data FROM erp_documents__item WHERE document_id=?", purchase.id).data).supplier_code, "F-1");
  // Contas: título do ERP com contato, vencimento, valor, categoria, forma de pagamento e origem; sem baixa.
  const title = f.one(`SELECT t.* FROM wb_bling_adoption_doc_link l JOIN erp_finance__title t ON t.id=l.record_id WHERE l.entity='receivables'`);
  assert.equal(title.kind, "receivable"); assert.equal(Number(title.amount_cents), 10000); assert.equal(title.due_on, "2026-12-01");
  assert.equal(title.category_id, f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='financial_categories' AND source_id='600'").record_id);
  assert.match(title.source_reference, /NF 123 \(Bling 6001\)/);
  assert.equal(Number(title.settled_cents), 0);
  const payable = f.one(`SELECT t.* FROM wb_bling_adoption_doc_link l JOIN erp_finance__title t ON t.id=l.record_id WHERE l.entity='payables'`);
  assert.equal(payable.kind, "payable"); assert.equal(Number(payable.amount_cents), 25050);
  // Sem efeitos: nada de estoque, contas a partir de documento, reserva ou baixa.
  assert.deepEqual(effects(f), before);
  // Encerrados não viram documento nem título do ERP.
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__document"), 3);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__title"), 2);

  // Repetir o lote não cria outro documento nem outro título.
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_B2_ENTITIES] });
  f.drain();
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__document"), 3);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__title"), 2);
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_history"), 6);
});

test("histórico: busca por número, contato e período; abrir mostra como veio e diz que é só consulta", async () => {
  const f = fixture();
  await withRecords(f);
  f.seed("sales_orders", order("9002", { numero: "16", situacao: { id: 9, valor: 1 }, data: "2026-10-01", total: 120 }));
  f.seed("sales_orders", order("9003", { numero: "17", situacao: { id: 12, valor: 2 }, data: "2026-08-05", contato: { id: "100", nome: "José Araújo" } }));
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["sales_orders"] });
  f.drain();
  const all = await f.ok("erp_bling_adoption_history", { entity: "sales_orders" });
  assert.deepEqual(all.items.map(item => item.number), ["16", "17"]);
  assert.equal(all.items[0].scope, "fulfilled"); assert.equal(all.items[1].scope, "cancelled");
  assert.equal(all.items[0].total_cents, "12000");
  assert.deepEqual((await f.ok("erp_bling_adoption_history", { entity: "sales_orders", q: "17" })).items.map(i => i.source_id), ["9003"]);
  assert.deepEqual((await f.ok("erp_bling_adoption_history", { entity: "sales_orders", q: "jose araujo" })).items.map(i => i.source_id), ["9003"]);
  assert.deepEqual((await f.ok("erp_bling_adoption_history", { entity: "sales_orders", from: "2026-09-01", to: "2026-10-31" })).items.map(i => i.source_id), ["9002"]);
  const page = await f.ok("erp_bling_adoption_history", { entity: "sales_orders", limit: 1 });
  assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
  const second = await f.ok("erp_bling_adoption_history", { entity: "sales_orders", limit: 1, cursor: page.next_cursor });
  assert.deepEqual(second.items.map(i => i.source_id), ["9003"]);
  const opened = await f.ok("erp_bling_adoption_history_get", { entity: "sales_orders", source_id: "9002" });
  assert.equal(opened.read_only_message, BLING_HISTORY_READONLY);
  assert.match(opened.read_only_message, /não pode ser faturado, cancelado nem editado/);
  assert.equal(opened.lines[0].description, "Café 500 g");
  assert.match(opened.payload_text, /"numero":"16"/);
  assert.equal(opened.fields["Situação"], "Atendido");
  const missing = await f.call("erp_bling_adoption_history_get", { entity: "sales_orders", source_id: "9999" });
  assert.equal(missing.status, 404);
});

test("cadastro que falta vira pendência dizendo qual; adotar o cadastro pelo atalho e tentar de novo adota o documento", async () => {
  const f = fixture();
  await withRecords(f);
  // Contato coletado depois da adoção dos cadastros: ainda aguardando.
  f.seed("contacts", { id: "105", nome: "Bruna Lima", tipo: "F", situacao: "A" });
  f.seed("sales_orders", order("9010", { numero: "30", contato: { id: "105", nome: "Bruna Lima" } }));
  f.seed("payables", { id: "5010", situacao: 1, vencimento: "2026-12-15", valor: 10, dataEmissao: "2026-11-10", contato: { id: "101" }, categoria: { id: "699" } });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["sales_orders", "payables"] });
  f.drain();
  const reviews = await f.ok("erp_bling_adoption_reviews", { entity: "sales_orders" });
  assert.equal(reviews.items.length, 1);
  const review = reviews.items[0];
  assert.equal(review.reason, "missing_records");
  assert.match(review.detail, /contato "Bruna Lima" \(id 105\)/);
  assert.deepEqual(review.missing, [{ entity: "contacts", source_id: "105", label: "Bruna Lima", state: "waiting" }]);
  assert.equal(review.bling["Contato"], "Bruna Lima");
  const payable = (await f.ok("erp_bling_adoption_reviews", { entity: "payables" })).items[0];
  assert.deepEqual(payable.missing.map(m => [m.entity, m.source_id, m.state]), [["financial_categories", "699", "absent"]]);
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__document"), 0);

  // Atalho: adotar só o contato agora.
  const one = await f.ok("erp_bling_adoption_adopt_one", { command_id: commandId(), entity: "contacts", source_id: "105" });
  assert.equal(one.outcome, "adopted"); assert.ok(one.record_id);
  assert.deepEqual((await f.ok("erp_bling_adoption_reviews", { entity: "sales_orders" })).items[0].missing, []);
  // Tentar de novo (usar a do Bling): agora o documento é adotado.
  const resolved = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "sales_orders", source_id: "9010", action: "use_bling" });
  assert.equal(resolved.outcome, "adopted");
  assert.equal(f.one("SELECT contact_id FROM erp_documents__document WHERE id=?", resolved.record_id).contact_id, one.record_id);
  assert.equal((await f.ok("erp_bling_adoption_reviews", { entity: "sales_orders" })).items.length, 0);
  // Conta com categoria que não foi coletada: tentar de novo explica o que falta.
  const again = await f.call("erp_bling_adoption_resolve", { command_id: commandId(), entity: "payables", source_id: "5010", action: "use_bling" });
  assert.equal(again.status, 409); assert.match(again.body.error.detail, /Falta adotar: categoria financeira/);
  // Adotar um registro que não foi coletado diz o que fazer.
  const absent = await f.call("erp_bling_adoption_adopt_one", { command_id: commandId(), entity: "financial_categories", source_id: "699" });
  assert.equal(absent.status, 404); assert.match(absent.body.error.detail, /ainda não foi coletado/);

  // Desligar do Bling só remove o vínculo: o documento continua.
  const unlinked = await f.ok("erp_bling_adoption_unlink", { command_id: commandId(), entity: "sales_orders", source_id: "9010" });
  assert.equal(unlinked.record_id, resolved.record_id);
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__document WHERE id=?", resolved.record_id), 1);
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_doc_link WHERE entity='sales_orders'"), 0);
  assert.equal(f.one("SELECT state FROM wb_bling_adoption_doc_review WHERE entity='sales_orders' AND source_id='9010'").state, "ignored");
});

test("pedido de compra com contas automáticas ligadas nas Preferências não é adotado: vira pendência e nada é criado", async () => {
  const f = fixture();
  await withRecords(f);
  f.pref("suprimentos-compras", "compras.automacao_contas_pagar", true);
  f.seed("purchase_orders", { id: "7002", numero: "8", data: "2026-11-05", situacao: { valor: 0 }, fornecedor: { id: "101", nome: "Distribuidora Sul" },
    itens: [{ descricao: "Café 500 g", unidade: "UN", valor: 10, quantidade: 1, produto: { id: "300" } }], parcelas: [{ valor: 10, dataVencimento: "2026-12-05" }], total: 10 });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["purchase_orders"] });
  f.drain();
  const review = (await f.ok("erp_bling_adoption_reviews", { entity: "purchase_orders" })).items[0];
  assert.equal(review.reason, "effects_blocked"); assert.match(review.detail, /Preferências → Compras/);
  assert.equal(f.count("SELECT count(*) n FROM erp_documents__document"), 0);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__title"), 0);
});

test("situação desconhecida vira pendência; conta já existente parecida pede confirmação", async () => {
  const f = fixture();
  await withRecords(f);
  f.seed("sales_orders", order("9020", { situacao: { id: 777 } }));
  const contact = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='contacts' AND source_id='100'").record_id;
  f.rpc("erp_finance_title_execute", { p_command_id: randomUUID(), p_action: "title_create", p_data: { kind: "receivable", contact_id: contact, description: "Digitada à mão",
    issued_on: "2026-11-01", competence_on: "2026-11-01", total_cents: "10000", installments: [{ amount_cents: "10000", due_on: "2026-12-01" }] } });
  f.seed("receivables", { id: "6010", situacao: 1, vencimento: "2026-12-01", valor: 100, saldo: 100, dataEmissao: "2026-11-01", contato: { id: "100" } });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["sales_orders", "receivables"] });
  f.drain();
  const sale = (await f.ok("erp_bling_adoption_reviews", { entity: "sales_orders" })).items[0];
  assert.equal(sale.reason, "unknown_situation"); assert.match(sale.detail, /id 777/);
  const receivable = (await f.ok("erp_bling_adoption_reviews", { entity: "receivables" })).items[0];
  assert.equal(receivable.reason, "possible_duplicate"); assert.equal(receivable.erp.length, 1);
  assert.equal(receivable.erp[0].summary["Valor"], "R$ 100,00"); assert.equal(receivable.bling["Valor"], "R$ 100,00");
  // Manter a do ERP e ligar.
  const linked = await f.ok("erp_bling_adoption_resolve", { command_id: commandId(), entity: "receivables", source_id: "6010", action: "keep_erp", record_id: receivable.erp[0].record_id });
  assert.equal(linked.outcome, "linked");
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__title"), 1);
});

test("parte desligada: a entidade avisa qual módulo ligar e as operações recusam com o código de parte desligada", async () => {
  const f = fixture({ sales: false, finance: false });
  const status = await f.ok("erp_bling_adoption_status", {});
  const by = Object.fromEntries(status.entities.map(item => [item.entity, item]));
  assert.equal(by.sales_orders.enabled, false); assert.match(by.sales_orders.part_off_message, /ligue o módulo Vendas em Gestão → Módulos/);
  assert.equal(by.receivables.enabled, false); assert.match(by.receivables.part_off_message, /Financeiro/);
  assert.equal(by.purchase_orders.enabled, true);
  const start = await f.call("erp_bling_adoption_start", { command_id: commandId(), entities: ["sales_orders"] });
  assert.equal(start.body.error.code, "BLING_ADOPTION_PART_DISABLED"); assert.match(start.body.error.detail, /Vendas/);
  const history = await f.call("erp_bling_adoption_history", { entity: "receivables" });
  assert.equal(history.body.error.code, "BLING_ADOPTION_PART_DISABLED");
  // Compras sem Produtos: diz os dois módulos.
  f.setParts({ products: false, purchases: true });
  const off = Object.fromEntries((await f.ok("erp_bling_adoption_status", {})).entities.map(item => [item.entity, item]));
  assert.equal(off.purchase_orders.enabled, false); assert.match(off.purchase_orders.part_off_message, /Produtos e serviços/);
});

test("bots: as operações novas estão no inventário, grupo bling, com descrição e parâmetros; as que gravam são sensíveis", () => {
  const ops = Object.fromEntries(ERP_BOT_OPERATIONS.filter(op => op.group === "bling").map(op => [op.id, op]));
  for (const id of ["erp_bling_adoption_adopt_one", "erp_bling_adoption_history", "erp_bling_adoption_history_get"]) {
    assert.ok(ops[id], id); assert.match(ops[id].description, /Bling/); assert.doesNotMatch(ops[id].description, /Fagoo|Origin/);
  }
  assert.equal(ops.erp_bling_adoption_adopt_one.sensitive, true);
  assert.equal(ops.erp_bling_adoption_adopt_one.method, "POST");
  assert.deepEqual(ops.erp_bling_adoption_adopt_one.params.required, ["command_id", "entity", "source_id"]);
  assert.deepEqual(ops.erp_bling_adoption_history.params.required, ["entity"]);
  assert.ok(ops.erp_bling_adoption_history.params.properties.q);
  assert.ok(ops.erp_bling_adoption_start.params.properties.entities.items.enum.includes("sales_orders"));
});
