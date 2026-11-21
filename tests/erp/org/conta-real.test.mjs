// Bling numa conta real (versão 32), só contra o Bling simulado: catálogo
// oficial com referência da documentação e motivo de quem ficou fora; prova de
// conta pelos dados básicos da empresa; escopos opacos do token; nota,
// situação e rastreio de volta ao pedido do Bling pela fila da mão dupla
// (conferência antes de reenviar, pendência com motivo, interruptores
// desligados e só do administrador); webhook assinado que adianta a coleta.
// SQLite em memória, RPCs do próprio ERP; nenhuma rede, cofre ou Bling real.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation } from "../../../src/erp/bling/adoption-api.ts";
import { runAdoptionUnit } from "../../../src/erp/bling/adoption.ts";
import { BLING_ADOPTION_OPERATIONS, BLING_ADOPTION_RECORD_ENTITIES, getAdoptionOperation } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_LEGACY_ENTITIES } from "../../../src/erp/bling/contracts.ts";
import { resourceDescriptorSchema } from "../../../src/erp/bling/schema.ts";
import { BLING_CONFIRMED_RESOURCES, BLING_RESOURCES, BLING_XML_RESOURCE, assertResourceConfirmed, blingUnconfirmedLimitations } from "../../../src/erp/bling/resources.ts";
import { BLING_ACCOUNT_PATH, blingScopeChecklist, createBlingAccountProof, isBlingGrantedScope } from "../../../src/erp/bling/account.ts";
import { createBlingOAuthProvider } from "../../../src/erp/bling/oauth.ts";
import { createBlingWriter, isWritablePath } from "../../../src/erp/bling/writer.ts";
import { runReturnsLocalUnit, runReturnsOutboundUnit, returnBody, returnPresent } from "../../../src/erp/bling/returns.ts";
import { BLING_WEBHOOK_RESERVE_MS, consumeBlingWebhookEvents, handleBlingWebhook, parseBlingWebhook, webhookHints, webhookPace } from "../../../src/erp/bling/webhook.ts";
import { FakeBling, FakeClock } from "./fake-bling.mjs";

const area = "conta-real", admin = "c7500000-0000-4000-8000-000000000001";
const person = (user_id, erp_role) => ({ user_id, name: "Dona da loja", email: null, erp_role, verified_factor: true });
const identityOf = (agent = false) => ({ actor: { ...person(admin, "admin"), session_id: agent ? null : "sessao-0001", aal: "aal2", is_agent: agent }, people: [person(admin, "admin")] });
let sequence = 0;
const commandId = () => `real-comando-${++sequence}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - 86_400_000));
const KEY = "35261111222333000181550010000001231123456789";

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
      const name = `conta_real_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}

// ---------------------------------------------------------------------------
// Item 1: catálogo oficial, prova de conta e escopos

test("catálogo da conta real: os recursos com referência pública passam a oficial confirmado; os outros ficam fora com o motivo", () => {
  const legacy = BLING_CONFIRMED_RESOURCES.filter(resource => BLING_LEGACY_ENTITIES.includes(resource.entity));
  assert.equal(legacy.length, BLING_LEGACY_ENTITIES.length);
  for (const resource of BLING_CONFIRMED_RESOURCES) resourceDescriptorSchema.parse(resource);
  for (const resource of legacy.filter(r => r.key !== "service_orders")) {
    assert.equal(resource.confirmation, "oficial_confirmado", resource.key);
    assert.match(resource.officialEvidence.url, /^https:\/\/developer\.bling\.com\.br\/referencia#\//, resource.key);
    assert.doesNotThrow(() => assertResourceConfirmed(resource), resource.key);
  }
  // Sem referência pública: continuam fora, com o motivo dito na tela.
  const out = blingUnconfirmedLimitations([...BLING_CONFIRMED_RESOURCES, BLING_XML_RESOURCE]);
  for (const key of ["service_orders", "fiscal_xml", "price_lists", "companies"]) assert.ok(out.some(line => line.startsWith(`${key}: `)), key);
  assert.notEqual(BLING_CONFIRMED_RESOURCES.find(r => r.key === "service_orders").confirmation, "oficial_confirmado");
  assert.notEqual(BLING_CONFIRMED_RESOURCES.find(r => r.key === "price_lists").confirmation, "oficial_confirmado");
  // O catálogo base (testes e simulador) não muda.
  assert.ok(BLING_RESOURCES.every(resource => resource.confirmation !== "oficial_confirmado"));
});

test("prova de conta: um GET nos dados básicos da empresa com o token, sem segredo na URL; recusas ditas", async () => {
  const clock = new FakeClock();
  const fake = new FakeBling({ clock }).company({ id: "d4475854366a36c86a37e792f9634a51", nome: "Loja da Ana Ltda", cnpj: "11.222.333/0001-81" });
  const proof = createBlingAccountProof({ fetch: fake.fetch, baseUrl: fake.baseUrl });
  assert.match(proof.evidence.url, /^https:\/\/developer\.bling\.com\.br\/referencia#\/Empresas\//);
  const ctx = { profile: area, clock, identity: { actor: null, people: null }, origin: "internal" };
  const account = await proof.identify(ctx, { access_token: "token-simulado", refresh_token: "r", client_id: "c", client_secret: "s", expires_at: clock.now() + 3_600_000, scopes: [] });
  assert.equal(account.id, "d4475854366a36c86a37e792f9634a51");
  assert.equal(account.name, "Loja da Ana Ltda");
  assert.deepEqual(fake.calls.map(call => [call.method, call.path]), [["GET", BLING_ACCOUNT_PATH]]);
  fake.assertReadOnly();
  fake.queue({ path: BLING_ACCOUNT_PATH, status: 401 });
  await assert.rejects(proof.identify(ctx, { access_token: "t" }), error => error.code === "BLING_AUTH_REQUIRED");
  fake.queue({ path: BLING_ACCOUNT_PATH, status: 403 });
  await assert.rejects(proof.identify(ctx, { access_token: "t" }), error => error.code === "BLING_SCOPE_REQUIRED");
  fake.queue({ path: BLING_ACCOUNT_PATH, data: { data: { nome: "Sem id" } } });
  await assert.rejects(proof.identify(ctx, { access_token: "t" }), error => error.code === "BLING_RESPONSE_INVALID");
  assert.throws(() => createBlingAccountProof({ fetch: fake.fetch, baseUrl: "https://attacker.invalid/Api/v3" }));
});

test("escopos: o Bling devolve identificadores opacos; a produção aceita e grava, sem regra recusa", async () => {
  const clock = { now: () => Date.UTC(2026, 10, 21, 12) };
  const token = scope => async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 21600, scope }), { status: 200, headers: { "content-type": "application/json" } });
  const real = createBlingOAuthProvider({ tokenEndpoint: "https://oauth.invalid/token", clock, readScopes: [], acceptScope: isBlingGrantedScope, fetch: token("98309 5990556 106168710") });
  const credential = await real.exchange({ client_id: "c", client_secret: "s", code: "x", callback_url: "https://installation.invalid/api/public/erp-bling/a/callback" });
  assert.deepEqual(credential.scopes, ["98309", "5990556", "106168710"]);
  const strict = createBlingOAuthProvider({ tokenEndpoint: "https://oauth.invalid/token", clock, readScopes: [], fetch: token("98309") });
  await assert.rejects(strict.exchange({ client_id: "c", client_secret: "s", code: "x", callback_url: "https://installation.invalid/api/public/erp-bling/a/callback" }), error => error.code === "BLING_SCOPE_REQUIRED");
  assert.equal(isBlingGrantedScope("bad scope"), false);
  const list = blingScopeChecklist({ read: ["contacts", "sales_orders"], write: [], invoice_back: true, status_back: false });
  assert.ok(list.read.includes("Empresa (dados básicos)") && list.read.includes("Pedidos de venda"));
  assert.deepEqual(list.write, ["Pedidos de venda"]);
});

// ---------------------------------------------------------------------------
// Itens 2 e 3: nota, situação e rastreio de volta ao Bling

const order = (id, extra = {}) => ({
  id, numero: "15", data: "2026-11-10", dataPrevista: "2026-11-20", situacao: { id: 6, valor: 0 }, contato: { id: "100", nome: "Ana Souza" }, vendedor: { id: "200" },
  itens: [{ codigo: "CAFE500", unidade: "UN", quantidade: 2, valor: 19.9, desconto: 0, descricao: "Café 500 g", produto: { id: "300" } }],
  parcelas: [{ dataVencimento: "2026-12-10", valor: 39.8, formaPagamento: { id: "500" } }], total: 39.8,
  observacoes: "Entregar pela manhã", observacoesInternas: "Cliente antigo", ...extra,
});

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const storage = sqliteStorage(sqlite); migrate(storage);
  const db = storageDriver(storage);
  let parts = normalizeErpParts({});
  const snapshot = () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts });
  const setParts = changes => { parts = normalizeErpParts({ ...parts, ...changes }); };
  sqlite.prepare("INSERT INTO wb_bling_control(id,account_id,credential_status,updated_at) VALUES(1,'conta','ready',?)").run(Date.now());
  const versions = new Map();
  function seed(entity, payload, id = payload.id) {
    const text = JSON.stringify(payload), hash = createHash("sha256").update(text).digest("hex");
    const version = (versions.get(entity + id) ?? 0) + 1; versions.set(entity + id, version);
    const at = Date.now() + version;
    sqlite.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(entity, at);
    sqlite.prepare(`INSERT INTO origin_sync__raw_record(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload, version_hash=excluded.version_hash, version=excluded.version, changed_at=excluded.changed_at`).run(entity, String(id), entity, text, hash, version, at, at, at);
  }
  async function call(name, input, agent = false) {
    const response = await handleAdoptionOperation({ name, identity: identityOf(agent), profile: area, input, authorization: null }, { storage, readSnapshot: async () => snapshot() });
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input) {
    const result = await call(name, input);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  const one = (sql, ...params) => sqlite.prepare(sql).get(...params);
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  // Cadastros e o pedido 9001 adotados do Bling; corte confirmado.
  seed("contacts", { id: "100", nome: "Ana Souza", tipo: "F", situacao: "A", numeroDocumento: "529.982.247-25", tiposContato: [{ descricao: "Cliente" }] });
  seed("sellers", { id: "200", contato: { id: "100", nome: "Ana Souza" } });
  seed("products", { id: "300", nome: "Café 500 g", codigo: "CAFE500", preco: 19.9, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  seed("payment_methods", { id: "500", descricao: "Pix", tipoPagamento: 17, situacao: 1 });
  seed("financial_categories", { id: "600", descricao: "Vendas", tipo: 2 });
  await ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_RECORD_ENTITIES] });
  for (let i = 0; i < 400 && runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more; i++);
  seed("sales_orders", order("9001"));
  await ok("erp_bling_adoption_start", { command_id: commandId(), entities: ["sales_orders"] });
  for (let i = 0; i < 400 && runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more; i++);
  const sale = one("SELECT record_id AS id FROM wb_bling_adoption_doc_link WHERE entity='sales_orders' AND source_id='9001'");
  assert.ok(sale, "o pedido do Bling precisa estar adotado");
  await ok("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: today, acknowledged: true });
  // O Bling simulado com o mesmo pedido, um volume sem rastreio.
  const clock = new FakeClock(Date.now());
  const fake = new FakeBling({ clock, writes: true });
  fake.resource("/pedidos/vendas", [order("9001", { transporte: { volumes: [{ id: "1", servico: "SEDEX", codigoRastreamento: "" }] } })]);
  const writer = createBlingWriter({ fetch: fake.fetch, baseUrl: fake.baseUrl, accessToken: async () => "token-simulado" });
  const ctx = { profile: area, clock, identity: { actor: null, people: null }, origin: "internal" };
  function local() {
    for (let i = 0; i < 20; i++) { clock.advance(61_000); if (!runReturnsLocalUnit({ db, now: clock.now, parts }).more) return; }
    assert.fail("a varredura não terminou");
  }
  async function outbound(w = writer) { clock.advance(61_000); return runReturnsOutboundUnit({ db, now: clock.now, parts, writer: w, ctx, deadline: clock.now() + 4000 }); }
  async function drainOut() { for (let i = 0; i < 20; i++) { const r = await outbound(); if (!r.worked) return; } assert.fail("a fila não esvaziou"); }
  /** A NF-e do pedido autorizada aqui (cofre fiscal, só as colunas lidas). */
  function authorize(at = Date.now() + 5_000) {
    const id = randomUUID();
    sqlite.exec("PRAGMA foreign_keys=OFF");
    sqlite.prepare(`INSERT INTO erp_fiscal_vault__order_emission(id,document_id,fiscal_version,environment,environment_confirmed,connection_fingerprint,reference,current_body_revision,status,version,provider_id,messages,series,number,access_key,protocol,issued_at,authorized_at,total,created_at,created_by,updated_at)
      VALUES(?,?,1,'producao',1,?,?,1,'autorizada',1,'prov-1','[]',1,123,?,'135260000000001',?,?,3980,?,?,?)`)
      .run(id, sale.id, "a".repeat(64), `wb.${sale.id}.v1`, KEY, at * 1000, at * 1000, at * 1000, admin, at * 1000);
    sqlite.exec("PRAGMA foreign_keys=ON");
  }
  /** Expedição: pedido enviado com rastreio. */
  function ship(code = "BR123456789BR", at = Date.now() + 5_000) {
    sqlite.prepare(`INSERT INTO erp_shipping__order(document_id,status,version,tracking_code,shipped_by,shipped_at,updated_by,created_at,updated_at) VALUES(?,'shipped',1,?,?,?,?,?,?)
      ON CONFLICT(document_id) DO UPDATE SET tracking_code=excluded.tracking_code, updated_at=excluded.updated_at`).run(sale.id, code, admin, at * 1000, admin, at * 1000, at * 1000);
  }
  return { sqlite, db, storage, call, ok, one, count, clock, fake, writer, ctx, local, outbound, drainOut, authorize, ship, sale, setParts };
}
const turn = (f, kind, extra = {}) => f.ok("erp_bling_twoway_return_switch", { command_id: commandId(), kind, enabled: true, acknowledged: true, ...extra });

test("volta ao Bling desligada por padrão: com nota e rastreio aqui, nada vai ao Bling", async () => {
  const f = await fixture();
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.ok(status.returns, "a consulta da mão dupla traz a volta ao Bling");
  assert.deepEqual([status.returns.invoice.enabled, status.returns.status.enabled, status.returns.webhook.enabled], [false, false, false]);
  assert.match(status.returns.texts.invoice_limit, /não aceita receber uma NF-e emitida fora/);
  f.authorize(); f.ship();
  f.local(); await f.drainOut();
  assert.equal(f.fake.mutationAttempts, 0);
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_return_outbox"), 0);
});

test("nota de volta: chave, número e série nas observações do pedido do Bling; lê antes de gravar e não reenvia", async () => {
  const f = await fixture();
  const refused = await f.call("erp_bling_twoway_return_switch", { command_id: commandId(), kind: "invoice", enabled: true });
  assert.equal(refused.status, 400, "sem o aviso confirmado não liga");
  await turn(f, "invoice");
  f.authorize();
  f.local();
  const item = f.one("SELECT * FROM wb_bling_return_outbox WHERE kind='invoice'");
  assert.ok(item, "a nota autorizada entrou na fila");
  assert.match(item.id, new RegExp(`^invoice\\.${f.sale.id}\\.[0-9a-f]{16}$`), "id estável: tipo, pedido e impressão");
  await f.drainOut();
  const remote = f.fake.record("/pedidos/vendas", "9001");
  assert.match(remote.observacoesInternas, /^Cliente antigo\nNF-e emitida no ERP: nº 123, série 1, chave 3526/);
  assert.ok(remote.observacoesInternas.includes(KEY));
  assert.deepEqual(f.fake.calls.map(c => c.method), ["GET", "PUT"], "lê o pedido, depois grava");
  assert.equal(f.one("SELECT state FROM wb_bling_return_outbox WHERE id=?", item.id).state, "done");
  // A varredura de novo não reenvia o que já foi.
  f.local(); await f.drainOut();
  assert.equal(f.fake.mutations, 1);
  // Na fila da mão dupla, como pedido de venda.
  const queue = await f.ok("erp_bling_twoway_queue", { state: "done" });
  assert.ok(queue.items.some(i => i.id === item.id && i.entity === "sales_orders" && i.op === "invoice" && i.op_text === "Nota no pedido do Bling"));
});

test("situação e rastreio: a etapa vira a situação escolhida e o rastreio vai para o volume do pedido do Bling", async () => {
  const f = await fixture();
  await turn(f, "status", { situations: { shipped: "24", cancelled: "12" } });
  f.ship("BR987654321BR");
  f.local();
  assert.deepEqual(f.sqlite.prepare("SELECT kind FROM wb_bling_return_outbox ORDER BY kind").all().map(r => r.kind), ["status", "tracking"]);
  await f.drainOut();
  const remote = f.fake.record("/pedidos/vendas", "9001");
  assert.equal(remote.situacao.id, 24);
  assert.equal(remote.transporte.volumes[0].codigoRastreamento, "BR987654321BR");
  assert.match(remote.observacoesInternas, /Código de rastreio: BR987654321BR\./);
  assert.ok(f.fake.calls.some(c => c.method === "PATCH" && c.path === "/pedidos/vendas/9001/situacoes/24"));
  assert.equal(f.count("SELECT count(*) AS n FROM wb_bling_return_outbox WHERE state<>'done'"), 0);
  // Etapa sem número escolhido não muda a situação no Bling.
  const g = await fixture();
  await turn(g, "status", { situations: { cancelled: "12" } });
  g.ship();
  g.local();
  assert.deepEqual(g.sqlite.prepare("SELECT kind FROM wb_bling_return_outbox").all().map(r => r.kind), ["tracking"]);
  // Só o PATCH da situação de pedido de venda entra; nota fiscal nunca.
  assert.equal(isWritablePath("PATCH", "/pedidos/vendas/9001/situacoes/24"), true);
  for (const path of ["/nfe/1/situacoes/2", "/pedidos/compras/1/situacoes/2", "/pedidos/vendas/1"]) assert.equal(isWritablePath("PATCH", path), false, path);
});

test("resposta incerta: confere no Bling antes de reenviar; entrou vira gravado sem segundo envio", async () => {
  const f = await fixture();
  await turn(f, "invoice");
  f.authorize(); f.local();
  await f.outbound(); // GET e preparo
  f.fake.queue({ method: "PUT", apply: true, throw: true }); // gravou, mas a conexão caiu
  await f.outbound();
  const item = f.one("SELECT * FROM wb_bling_return_outbox WHERE kind='invoice'");
  assert.equal(item.state, "uncertain");
  await f.outbound(); // conferência por GET
  assert.equal(f.one("SELECT state FROM wb_bling_return_outbox WHERE id=?", item.id).state, "done");
  assert.equal(f.fake.calls.filter(c => c.method === "PUT").length, 1, "nunca reenvia às cegas");
});

test("recusa do Bling vira pendência com o motivo; tentar de novo lê o pedido outra vez", async () => {
  const f = await fixture();
  await turn(f, "status", { situations: { shipped: "24" } });
  f.ship(); f.local();
  f.fake.queue({ method: "PATCH", status: 400, data: { error: { type: "VALIDATION_ERROR", description: "Situação inexistente" } } });
  await f.drainOut();
  const failed = f.one("SELECT * FROM wb_bling_return_outbox WHERE kind='status'");
  assert.equal(failed.state, "failed");
  const issues = await f.ok("erp_bling_twoway_issues", {});
  const issue = issues.items.find(i => i.key === `ret:${failed.id}`);
  assert.ok(issue, "a pendência aparece com as outras da mão dupla");
  assert.equal(issue.entity, "sales_orders");
  assert.match(issue.reason, /Situação inexistente/);
  assert.deepEqual(issue.actions.map(a => a.action), ["retry", "discard"]);
  const retried = await f.ok("erp_bling_twoway_resolve", { command_id: commandId(), key: issue.key, action: "retry" });
  assert.equal(retried.outcome, "retrying");
  await f.drainOut();
  assert.equal(f.one("SELECT state FROM wb_bling_return_outbox WHERE id=?", failed.id).state, "done");
  assert.equal(f.fake.record("/pedidos/vendas", "9001").situacao.id, 24);
});

test("bots: consultar é leitura; ligar a volta ao Bling é só do administrador", async () => {
  const f = await fixture();
  assert.ok(!Object.hasOwn(BLING_ADOPTION_OPERATIONS, "erp_bling_twoway_return_switch"), "fora do inventário dos bots");
  assert.ok(getAdoptionOperation("erp_bling_twoway_return_switch"), "mas existe para a tela");
  assert.equal(BLING_ADOPTION_OPERATIONS.erp_bling_twoway_status.sensitive, false);
  const bot = await f.call("erp_bling_twoway_return_switch", { command_id: commandId(), kind: "invoice", enabled: false }, true);
  assert.equal(bot.status, 403);
  assert.equal(bot.body.error.code, "BLING_ADOPTION_SCOPE_REQUIRED");
  // Partes: sem o Fiscal, a nota não liga e a tela diz qual módulo ligar.
  f.setParts({ fiscal: false });
  const off = await f.call("erp_bling_twoway_return_switch", { command_id: commandId(), kind: "invoice", enabled: true, acknowledged: true });
  assert.equal(off.body.error.code, "BLING_ADOPTION_PART_DISABLED");
  assert.match(off.body.error.detail, /ligue o módulo Fiscal em Gestão → Módulos/);
});

test("corpo da volta: só acrescenta, sem apagar o que o pedido do Bling já tinha", () => {
  const remote = order("9001", { transporte: { volumes: [{ id: "1", codigoRastreamento: "JA-TEM" }, { id: "2" }] } });
  const body = returnBody("tracking", remote, { code: "BR1" });
  assert.equal(body.transporte.volumes[0].codigoRastreamento, "JA-TEM");
  assert.equal(body.transporte.volumes[1].codigoRastreamento, "BR1");
  assert.ok(body.observacoesInternas.startsWith("Cliente antigo\n"));
  assert.equal(returnPresent("tracking", body, { code: "BR1" }), true);
  assert.equal(returnPresent("invoice", remote, { access_key: KEY }), false);
  assert.equal(returnPresent("status", { situacao: { id: 24 } }, { situation_id: "24" }), true);
});

// ---------------------------------------------------------------------------
// Item 4: aviso do Bling (webhook)

function d1(sqlite) {
  const statement = (sql, values = []) => ({ sql, values, bind: (...v) => statement(sql, v),
    run: async () => sqlite.prepare(sql).run(...values), all: async () => ({ results: sqlite.prepare(sql).all(...values) }) });
  return { prepare: sql => statement(sql), batch: async list => Promise.all(list.map(s => s.run())) };
}

test("webhook: só com a assinatura do aplicativo; guarda o essencial, não duplica e acorda a área", async () => {
  const central = new DatabaseSync(":memory:");
  central.exec(readFileSync("migrations/0280_erp_bling_webhook.sql", "utf8"));
  const env = { DB: d1(central) };
  const secret = "segredo-do-aplicativo", wakes = [];
  const options = { secret: async profile => profile === area ? secret : null, wake: async profile => { wakes.push(profile); } };
  const body = JSON.stringify({ eventId: "01J0000000000000000000AAAA", date: "2026-11-21T12:00:00Z", version: "v1", event: "order.updated", companyId: "conta", data: { id: 9001, numero: 15 } });
  const sign = (text, key = secret) => `sha256=${createHmac("sha256", key).update(text).digest("hex")}`;
  const post = (text, signature) => handleBlingWebhook(env, area, new Request("https://installation.invalid/api/public/erp-bling/conta-real/webhook", { method: "POST", body: text, headers: signature ? { "X-Bling-Signature-256": signature } : {} }), options);
  assert.equal((await post(body)).status, 401, "sem assinatura");
  assert.equal((await post(body, sign(body, "outro-segredo"))).status, 401, "assinatura de outro aplicativo");
  assert.equal((await post(body.replace("9001", "9002"), sign(body))).status, 401, "corpo alterado");
  assert.equal(central.prepare("SELECT count(*) AS n FROM erp_bling_webhook_event").get().n, 0);
  assert.equal((await post(body, sign(body))).status, 200);
  assert.equal((await post(body, sign(body))).status, 200, "o Bling pode repetir o aviso");
  const rows = central.prepare("SELECT profile_id, event_id, entity, action, source_id, company_id FROM erp_bling_webhook_event").all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ profile_id: area, event_id: "01J0000000000000000000AAAA", entity: "sales_orders", action: "updated", source_id: "9001", company_id: "conta" }]);
  assert.deepEqual(wakes, [area, area]);
  const ignored = JSON.stringify({ eventId: "01J0000000000000000000BBBB", event: "something.created", companyId: "conta", data: { id: 1 } });
  assert.equal((await (await post(ignored, sign(ignored))).json()).ignored, true);
  assert.equal(parseBlingWebhook({ eventId: "x", event: "order.created" }), null);

  // Na área: confere a empresa vinculada e marca a entidade a coletar já.
  const f = await fixture();
  central.prepare("INSERT INTO erp_bling_webhook_event(profile_id,event_id,entity,action,source_id,company_id,received_at) VALUES(?,?,?,?,?,?,?)")
    .run(area, "01J0000000000000000000CCCC", "products", "updated", "300", "outra-empresa", Date.now());
  assert.equal(await consumeBlingWebhookEvents(env.DB, f.db, area, Date.now()), 0, "desligado: nada é lido");
  await f.ok("erp_bling_twoway_return_switch", { command_id: commandId(), kind: "webhook", enabled: true, acknowledged: true });
  assert.equal(await consumeBlingWebhookEvents(env.DB, f.db, area, Date.now()), 1, "só o aviso da empresa vinculada");
  assert.deepEqual([...webhookHints(f.db).keys()], ["sales_orders"]);
  assert.equal(central.prepare("SELECT count(*) AS n FROM erp_bling_webhook_event WHERE consumed_at IS NULL").get().n, 0);
  // A consulta periódica fica de reserva para quem tem aviso; os outros seguem o ritmo.
  assert.equal(webhookPace(f.db, "sales_orders", 900_000), BLING_WEBHOOK_RESERVE_MS);
  assert.equal(webhookPace(f.db, "contacts", 900_000), 900_000);
  const status = await f.ok("erp_bling_twoway_status", {});
  assert.equal(status.returns.webhook.enabled, true);
  assert.equal(status.returns.webhook.path, "/api/public/erp-bling/conta-real/webhook");
  assert.equal(status.returns.webhook.events, 1);
});
