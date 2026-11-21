// Fatia C: o corte. Data de corte, contas parciais pelo saldo, resumo das
// pagas e canceladas, saldos de abertura, estoque de abertura, notas emitidas
// no Bling, pacote do contador, conflitos depois do corte e a conferência
// final. Só SQLite em memória, RPCs do próprio ERP e um R2 simulado; nenhuma
// chamada ao Bling, rede ou cofre.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { storageDriver } from "../../../src/erp/engine/driver.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { handleAdoptionOperation, runAdoptionWake } from "../../../src/erp/bling/adoption-api.ts";
import { runAdoptionUnit } from "../../../src/erp/bling/adoption.ts";
import { BLING_ADOPTION_B2_ENTITIES, BLING_ADOPTION_OPERATIONS, BLING_ADOPTION_RECORD_ENTITIES } from "../../../src/erp/bling/adoption-contracts.ts";
import { BLING_CUTOVER_OPERATION_NAMES } from "../../../src/erp/bling/cutover-contracts.ts";
import { crc32, runPackageUnit } from "../../../src/erp/bling/cutover-package.ts";
import { build } from "esbuild";

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
      const name = `corte_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
      finally { depth--; }
    },
  };
}
/** R2 simulado: guarda bytes em memória. */
function fakeMedia() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const b = objects.get(key); return b ? { size: b.length, arrayBuffer: async () => b.slice().buffer } : null; },
    async delete(key) { objects.delete(key); },
  };
}

const area = "corte-bling", admin = "c7300000-0000-4000-8000-000000000001";
const now = Date.UTC(2026, 10, 20, 15);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const CUTOVER = "2026-11-15";
const person = (user_id, erp_role) => ({ user_id, name: null, email: null, erp_role, verified_factor: true });
const identityOf = () => ({ actor: { ...person(admin, "admin"), session_id: "sessao-0001", aal: "aal2", is_agent: false }, people: [person(admin, "admin")] });
let sequence = 0;
const commandId = () => `corte-comando-${++sequence}`;

function fixture(partsInput = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const storage = sqliteStorage(sqlite); migrate(storage);
  const db = storageDriver(storage);
  const media = fakeMedia();
  let parts = normalizeErpParts(partsInput);
  const snapshot = () => ({ profile: area, revision: "1", expires_at: Date.now() + 120000, parts });
  sqlite.prepare("INSERT INTO wb_bling_control(id,account_id,updated_at) VALUES(1,'conta',?)").run(now);
  const versions = new Map();
  function seed(entity, payload, id = payload.id) {
    const text = JSON.stringify(payload), hash = createHash("sha256").update(text).digest("hex");
    const version = (versions.get(entity + id) ?? 0) + 1; versions.set(entity + id, version);
    sqlite.prepare("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)").run(entity, now);
    sqlite.prepare(`INSERT INTO origin_sync__raw_record(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entity,source_id) DO UPDATE SET payload=excluded.payload, version_hash=excluded.version_hash, version=excluded.version, changed_at=excluded.changed_at`).run(entity, String(id), entity, text, hash, version, now, now, now + version);
  }
  async function raw(name, input) {
    return handleAdoptionOperation({ name, identity: identityOf(), profile: area, input, authorization: null }, { storage, readSnapshot: async () => snapshot(), media });
  }
  async function call(name, input) {
    const response = await raw(name, input);
    return { status: response.status, body: await response.json() };
  }
  async function ok(name, input) {
    const result = await call(name, input);
    assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
    return result.body;
  }
  function drain() {
    for (let i = 0; i < 400; i++) if (!runAdoptionUnit({ db, profile: area, now: () => Date.now(), parts }).more) return;
    assert.fail("o lote não terminou");
  }
  const count = (sql, ...params) => Number(sqlite.prepare(sql).get(...params).n);
  const one = (sql, ...params) => sqlite.prepare(sql).get(...params);
  return { sqlite, db, media, storage, seed, raw, call, ok, drain, count, one, snapshot, setParts(next) { parts = normalizeErpParts(next); } };
}

/** Cadastros e contas como numa conta de verdade, já adotados (B1 e B2). */
async function prepared(partsInput) {
  const f = fixture(partsInput);
  f.seed("contacts", { id: "100", nome: "Ana Souza", tipo: "F", situacao: "A", numeroDocumento: "529.982.247-25", tiposContato: [{ descricao: "Cliente" }] });
  f.seed("contacts", { id: "101", nome: "Distribuidora Sul", tipo: "J", situacao: "A", numeroDocumento: "11222333000181", tiposContato: [{ descricao: "Fornecedor" }] });
  f.seed("products", { id: "300", nome: "Café 500 g", codigo: "CAFE500", preco: 19.9, precoCusto: 8.5, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  f.seed("products", { id: "301", nome: "Açúcar 1 kg", codigo: "ACUCAR1", preco: 6, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  f.seed("warehouses", { id: "400", descricao: "Loja" });
  f.seed("payment_methods", { id: "500", descricao: "Pix", tipoPagamento: 17 });
  f.seed("financial_categories", { id: "600", descricao: "Vendas", tipo: 2 });
  f.seed("financial_categories", { id: "601", descricao: "Fornecedores", tipo: 1 });
  f.seed("ledger_accounts", { id: "700", descricao: "Caixa da loja" });
  // Contas: em aberto, parciais, pagas e canceladas.
  f.seed("receivables", { id: "6001", situacao: 1, vencimento: "2026-12-01", valor: 100, saldo: 100, dataEmissao: "2026-11-01", numeroDocumento: "NF 1", contato: { id: "100" }, categoria: { id: "600" } });
  f.seed("receivables", { id: "6002", situacao: 1, vencimento: "2026-12-05", valor: 100, saldo: 40, dataEmissao: "2026-11-01", numeroDocumento: "NF 2", historico: "Venda a prazo", contato: { id: "100" }, categoria: { id: "600" } });
  f.seed("receivables", { id: "6003", situacao: 2, vencimento: "2026-10-01", valor: 80, saldo: 0, dataEmissao: "2026-09-01", contato: { id: "100" }, categoria: { id: "600" } });
  f.seed("receivables", { id: "6004", situacao: 2, vencimento: "2026-10-20", valor: 20.5, saldo: 0, dataEmissao: "2026-09-01", contato: { id: "100" } });
  f.seed("payables", { id: "5001", situacao: 3, vencimento: "2026-12-15", valor: 250.5, saldo: 50.5, dataEmissao: "2026-11-10", numeroDocumento: "Boleto 9", contato: { id: "101" }, categoria: { id: "601" } });
  f.seed("payables", { id: "5002", situacao: 5, vencimento: "2026-12-15", valor: 30, contato: { id: "101" }, categoria: { id: "601" } });
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_RECORD_ENTITIES, ...BLING_ADOPTION_B2_ENTITIES] });
  f.drain();
  return f;
}
const confirm = f => f.ok("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: CUTOVER, acknowledged: true });

test("sem a data de corte confirmada nada roda; a conferência antes de confirmar aponta o que falta", async () => {
  const f = await prepared();
  for (const [name, input] of [["erp_bling_cutover_partials_adopt", { command_id: commandId() }], ["erp_bling_cutover_balances", {}], ["erp_bling_cutover_stock", {}],
    ["erp_bling_cutover_invoices", {}], ["erp_bling_cutover_report", {}], ["erp_bling_cutover_package_start", { command_id: commandId(), month: "2026-10" }]]) {
    const refused = await f.call(name, input);
    assert.equal(refused.status, 409, name);
    assert.match(refused.body.error.detail, /Confirme primeiro a data de corte/, name);
  }
  const status = await f.ok("erp_bling_cutover_status", { cutover_on: CUTOVER });
  assert.equal(status.cutover.state, "none");
  assert.equal(status.proposed_on, CUTOVER);
  assert.ok(status.checks.find(c => c.key === "date").ok);
  assert.ok(status.steps.some(s => s.key === "stock" && s.module_name === "Estoque"));
  // Data no futuro: recusada, dizendo o que fazer.
  const future = await f.call("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: "2999-01-01", acknowledged: true });
  assert.equal(future.status, 400); assert.match(future.body.error.detail, /não pode estar no futuro/);
  const done = await confirm(f);
  assert.equal(done.cutover.state, "confirmed"); assert.equal(done.cutover.cutover_on, CUTOVER); assert.equal(done.cutover.can_change_date, true);
  // Nada gravado ainda: outra data pode ser confirmada.
  const changed = await f.ok("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: "2026-11-14", acknowledged: true });
  assert.equal(changed.cutover.cutover_on, "2026-11-14");
  await confirm(f);
  // Bot: a operação entra no inventário, no grupo bling, sensível (menos a consulta do andamento).
  const ops = Object.fromEntries(ERP_BOT_OPERATIONS.filter(op => op.group === "bling").map(op => [op.id, op]));
  for (const name of BLING_CUTOVER_OPERATION_NAMES) {
    assert.ok(ops[name], name);
    assert.equal(ops[name].sensitive, name !== "erp_bling_cutover_status", name);
    assert.equal(ops[name].path, `erp/v1/receber-bling${BLING_ADOPTION_OPERATIONS[name].path}`);
  }
});

test("parciais entram pelo saldo que falta, sem baixas antigas; pagas e canceladas batem com o acervo", async () => {
  const f = await prepared();
  await confirm(f);
  const before = f.count("SELECT count(*) n FROM erp_finance__title");
  const settlements = f.count("SELECT count(*) n FROM erp_finance__settlement");
  const run = await f.ok("erp_bling_cutover_partials_adopt", { command_id: commandId() });
  assert.deepEqual([run.adopted, run.pending, run.remaining], [2, 0, 0]);
  const receivable = f.one(`SELECT t.* FROM wb_bling_adoption_doc_link l JOIN erp_finance__title t ON t.id=l.record_id WHERE l.entity='receivables' AND l.source_id='6002'`);
  assert.equal(Number(receivable.amount_cents), 4000);
  assert.equal(Number(receivable.settled_cents), 0);
  assert.match(receivable.description, /valor original R\$ 100,00, já pago no Bling R\$ 60,00 \(Bling id 6002\)/);
  const payable = f.one(`SELECT t.* FROM wb_bling_adoption_doc_link l JOIN erp_finance__title t ON t.id=l.record_id WHERE l.entity='payables' AND l.source_id='5001'`);
  assert.equal(Number(payable.amount_cents), 5050);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__settlement"), settlements, "não recria baixas");
  assert.equal(f.count("SELECT count(*) n FROM wb_bling_adoption_history WHERE scope='partial'"), 0);
  // Repetir não duplica.
  const again = await f.ok("erp_bling_cutover_partials_adopt", { command_id: commandId() });
  assert.equal(again.adopted, 0);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__title"), before + 2);
  const list = await f.ok("erp_bling_cutover_partials", { entity: "receivables" });
  assert.deepEqual(list.items.map(i => [i.source_id, i.state, i.balance_cents, i.paid_cents]), [["6002", "adopted", "4000", "6000"]]);
  // Resumo por mês e categoria, conferido com o acervo.
  const summary = await f.ok("erp_bling_cutover_accounts_summary", {});
  assert.equal(summary.matches, true);
  const paid = summary.rows.filter(r => r.entity === "receivables" && r.scope === "paid");
  assert.deepEqual(paid.map(r => [r.month, r.category, r.count, r.total_cents]).sort(), [["2026-10", "Sem categoria", 1, "2050"], ["2026-10", "Vendas", 1, "8000"]]);
  assert.deepEqual(summary.totals.find(t => t.entity === "payables" && t.scope === "cancelled"), { entity: "payables", scope: "cancelled", count: 1, total_cents: "3000" });
  // Com a data usada, ela não muda mais.
  const change = await f.call("erp_bling_cutover_confirm", { command_id: commandId(), cutover_on: "2026-11-10", acknowledged: true });
  assert.equal(change.status, 409); assert.match(change.body.error.detail, /não muda mais/);
});

test("saldo de abertura: calculado dos lançamentos, corrigido pela pessoa, gravado uma vez só", async () => {
  const f = await prepared();
  await confirm(f);
  f.seed("cash_entries", { id: "9001", data: "2026-11-10", valor: 150.25, debitoCredito: "C", contaFinanceira: { id: "700" } });
  f.seed("cash_entries", { id: "9002", data: "2026-11-12", valor: 50, debitoCredito: "D", contaFinanceira: { id: "700" } });
  f.seed("cash_entries", { id: "9003", data: "2026-11-18", valor: 999, debitoCredito: "C", contaFinanceira: { id: "700" } });
  const list = await f.ok("erp_bling_cutover_balances", {});
  const item = list.items.find(i => i.source_id === "700");
  assert.equal(item.computed_cents, "10025"); assert.equal(item.computed_entries, 2); assert.equal(item.state, "waiting");
  // Mudou depois de conferir: recusa.
  const stale = await f.call("erp_bling_cutover_balance_post", { command_id: commandId(), source_id: "700", confirmed_cents: "10000", computed_cents: "1" });
  assert.equal(stale.status, 409);
  const posted = await f.ok("erp_bling_cutover_balance_post", { command_id: commandId(), source_id: "700", confirmed_cents: "10000", computed_cents: "10025" });
  assert.equal(posted.item.state, "posted"); assert.equal(posted.item.posted_cents, "10000");
  const account = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='ledger_accounts' AND source_id='700'").record_id;
  assert.equal(Number(f.one("SELECT coalesce(sum(delta_cents),0) n FROM erp_finance__movement WHERE account_id=?", account).n), 10000);
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__cash_entry WHERE account_id=? AND note LIKE 'Saldo de abertura vindo do Bling%'", account), 1);
  // Uma vez só: repetir com o mesmo valor não duplica; outro valor é recusado.
  await f.ok("erp_bling_cutover_balance_post", { command_id: commandId(), source_id: "700", confirmed_cents: "10000", computed_cents: "10025" });
  assert.equal(f.count("SELECT count(*) n FROM erp_finance__cash_entry WHERE account_id=?", account), 1);
  const other = await f.call("erp_bling_cutover_balance_post", { command_id: commandId(), source_id: "700", confirmed_cents: "20000", computed_cents: "10025" });
  assert.equal(other.status, 409); assert.match(other.body.error.detail, /já foi gravado/);
  // Parte desligada: diz qual módulo ligar.
  f.setParts({ finance: false });
  const off = await f.call("erp_bling_cutover_balances", {});
  assert.equal(off.status, 409); assert.equal(off.body.error.code, "BLING_ADOPTION_PART_DISABLED"); assert.match(off.body.error.detail, /Financeiro/);
});

test("estoque de abertura: prévia com o que falta, um lançamento por depósito, sem duplicar", async () => {
  const f = await prepared();
  await confirm(f);
  f.seed("stock_balances", { produto: { id: "300" }, saldoFisicoTotal: 12.5, depositos: [{ id: "400", saldoFisico: 12.5, saldoVirtual: 12.5 }] }, "300");
  f.seed("stock_balances", { produto: { id: "301" }, depositos: [{ id: "400", saldoFisico: -2 }] }, "301");
  f.seed("stock_balances", { produto: { id: "302" }, depositos: [{ id: "400", saldoFisico: 7 }] }, "302");
  const preview = await f.ok("erp_bling_cutover_stock", { warehouse: "400" });
  const w = preview.warehouses.find(x => x.source_id === "400");
  assert.deepEqual([w.products, w.ready, w.without_product, w.negatives, w.state], [3, 1, 1, 1, "waiting"]);
  assert.equal(w.valued_cents, "10625", "12,5 × R$ 8,50");
  assert.equal(preview.lines.items.find(l => l.product_source_id === "302").issue, "no_product");
  const stale = await f.call("erp_bling_cutover_stock_post", { command_id: commandId(), warehouse: "400", preview_hash: "0".repeat(64) });
  assert.equal(stale.status, 409);
  const posted = await f.ok("erp_bling_cutover_stock_post", { command_id: commandId(), warehouse: "400", preview_hash: w.preview_hash });
  assert.equal(posted.warehouse.state, "posted"); assert.equal(posted.posted_lines, 1); assert.ok(posted.movement_id);
  const product = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='products' AND source_id='300'").record_id;
  const warehouse = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='warehouses' AND source_id='400'").record_id;
  assert.equal(String(f.one("SELECT CAST(quantity AS TEXT) q FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product, warehouse).q), "12500000");
  const movement = f.one("SELECT * FROM erp_stock__movement WHERE id=?", posted.movement_id);
  assert.equal(movement.occurred_on, CUTOVER); assert.equal(movement.kind, "adjustment");
  // Repetir não lança de novo.
  const again = await f.ok("erp_bling_cutover_stock_post", { command_id: commandId(), warehouse: "400", preview_hash: w.preview_hash });
  assert.equal(again.posted_lines, 0);
  assert.equal(f.count("SELECT count(*) n FROM erp_stock__movement"), 1);
  f.setParts({ stock: false });
  const off = await f.call("erp_bling_cutover_stock", {});
  assert.equal(off.body.error.code, "BLING_ADOPTION_PART_DISABLED"); assert.match(off.body.error.detail, /Estoque/);
});

test("notas emitidas no Bling: consulta no Fiscal, sem XML coletado diz o que fazer; pacote do contador no R2", async () => {
  const f = await prepared();
  await confirm(f);
  const key = "35261011222333000181550010000001231000001234";
  f.seed("nfe", { id: "8001", numero: "123", serie: "1", chaveAcesso: key, dataEmissao: "2026-10-05 10:00:00", tipo: 1, situacao: 5, valorNota: 150.9, contato: { nome: "Ana Souza", numeroDocumento: "529.982.247-25" } });
  f.seed("nfce", { id: "8101", numero: "77", serie: "2", dataEmissao: "2026-10-07 09:00:00", tipo: 1, situacao: 2, valorNota: 12, contato: { nome: "Consumidor" } });
  f.seed("nfe", { id: "8002", numero: "124", serie: "1", dataEmissao: "2026-11-02 10:00:00", tipo: 1, situacao: 5, valorNota: 10, contato: { nome: "Outro" } });
  const byKey = await f.ok("erp_bling_cutover_invoices", { q: key });
  assert.deepEqual(byKey.items.map(i => [i.number, i.situation, i.total_cents, i.has_xml]), [["123", "Autorizada", "15090", false]]);
  assert.match(byKey.read_only_message, /não podem ser canceladas nem corrigidas/);
  const october = await f.ok("erp_bling_cutover_invoices", { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(october.items.map(i => i.source_id), ["8101", "8001"]);
  const opened = await f.ok("erp_bling_cutover_invoice_get", { entity: "nfe", source_id: "8001" });
  assert.equal(opened.fields["Chave de acesso"], key); assert.equal(opened.xml.available, false); assert.match(opened.xml.note, /coleta de XML/);
  // Pacote: depois da data de corte não é período antigo.
  const late = await f.call("erp_bling_cutover_package_start", { command_id: commandId(), month: "2026-12" });
  assert.equal(late.status, 400);
  await f.ok("erp_bling_cutover_package_start", { command_id: commandId(), month: "2026-10" });
  for (let i = 0; i < 20; i++) if (!(await runPackageUnit({ db: f.db, profile: area, media: f.media, now: () => Date.now() })).more) break;
  const packages = await f.ok("erp_bling_cutover_packages", {});
  const october_ = packages.items.find(p => p.month === "2026-10");
  assert.deepEqual([october_.state, october_.notes, october_.without_xml], ["done", 2, 2]);
  const response = await f.raw("erp_bling_cutover_package_download", { month: "2026-10" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/zip");
  const zip = new Uint8Array(await response.arrayBuffer());
  assert.equal(zip.length, october_.bytes);
  // Fecho do ZIP: uma entrada (o índice), e o índice tem as duas notas.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength), end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 1);
  const csv = new TextDecoder().decode(zip);
  assert.match(csv, new RegExp(`NF-e;${key};123;1;05/10/2026;150,90;Autorizada;não coletado`));
  assert.match(csv, /NFC-e;;77;2;07\/10\/2026;12,00;Cancelada;não coletado/);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  // Fiscal desligado: some a consulta e diz o que ligar.
  f.setParts({ fiscal: false });
  const off = await f.call("erp_bling_cutover_invoices", {});
  assert.equal(off.body.error.code, "BLING_ADOPTION_PART_DISABLED"); assert.match(off.body.error.detail, /Fiscal/);
});

test("depois do corte: mudança no Bling vira conflito, nunca sobrescreve; conferência só conclui com tudo justificado", async () => {
  const f = await prepared();
  await confirm(f);
  const product = f.one("SELECT record_id FROM wb_bling_adoption_link WHERE entity='products' AND source_id='300'").record_id;
  f.seed("products", { id: "300", nome: "Café 500 g tradicional", codigo: "CAFE500", preco: 21, precoCusto: 8.5, unidade: "UN", tipo: "P", formato: "S", situacao: "A" });
  f.seed("receivables", { id: "6001", situacao: 2, vencimento: "2026-12-01", valor: 100, saldo: 0, dataEmissao: "2026-11-01", numeroDocumento: "NF 1", contato: { id: "100" }, categoria: { id: "600" } });
  // A coleta seguiu e o lote rodou de novo: nada muda sozinho.
  await f.ok("erp_bling_adoption_start", { command_id: commandId(), entities: [...BLING_ADOPTION_RECORD_ENTITIES, ...BLING_ADOPTION_B2_ENTITIES] });
  f.drain();
  assert.equal(f.one("SELECT name FROM erp_catalog__record WHERE id=?", product).name, "Café 500 g");
  const conflicts = await f.ok("erp_bling_cutover_conflicts", {});
  assert.deepEqual(conflicts.items.map(c => [c.entity, c.source_id, c.can_use_bling]).sort(), [["products", "300", true], ["receivables", "6001", false]]);
  const doc = await f.call("erp_bling_cutover_conflict_resolve", { command_id: commandId(), entity: "receivables", source_id: "6001", action: "use_bling" });
  assert.equal(doc.status, 400);
  await f.ok("erp_bling_cutover_conflict_resolve", { command_id: commandId(), entity: "receivables", source_id: "6001", action: "keep_erp" });
  await f.ok("erp_bling_cutover_conflict_resolve", { command_id: commandId(), entity: "products", source_id: "300", action: "use_bling" });
  assert.equal(f.one("SELECT name FROM erp_catalog__record WHERE id=?", product).name, "Café 500 g tradicional");
  assert.equal((await f.ok("erp_bling_cutover_conflicts", {})).total, 0);

  // Conferência: parciais, saldo e estoque ainda por fazer; não conclui.
  const report = await f.ok("erp_bling_cutover_report", {});
  const receivables = report.entities.find(e => e.key === "receivables");
  assert.equal(receivables.bling, 4);
  assert.ok(report.money.find(m => m.key === "receivables"));
  assert.ok(report.blocking > 0); assert.equal(report.can_conclude, false);
  const refused = await f.call("erp_bling_cutover_conclude", { command_id: commandId() });
  assert.equal(refused.status, 409); assert.match(refused.body.error.detail, /sem justificativa/);
  await f.ok("erp_bling_cutover_partials_adopt", { command_id: commandId() });
  for (const difference of (await f.ok("erp_bling_cutover_report", {})).differences.filter(d => !d.justified))
    await f.ok("erp_bling_cutover_justify", { command_id: commandId(), key: difference.key, text: "Conferido com o contador em 20/11/2026." });
  const final = await f.ok("erp_bling_cutover_report", {});
  assert.equal(final.blocking, 0); assert.equal(final.can_conclude, true);
  assert.ok(final.differences.every(d => d.justified));
  const concluded = await f.ok("erp_bling_cutover_conclude", { command_id: commandId() });
  assert.equal(concluded.cutover.state, "concluded");
  assert.ok(f.one("SELECT snapshot FROM wb_bling_cutover WHERE id=1").snapshot.includes("receivables"));
  // Concluído: as etapas que gravam no ERP param.
  const late = await f.call("erp_bling_cutover_partials_adopt", { command_id: commandId() });
  assert.equal(late.status, 409); assert.match(late.body.error.detail, /já foi concluído/);
});

test("alarme: o pacote do contador anda uma parte por acordada, depois da adoção", async () => {
  const f = await prepared();
  await confirm(f);
  for (let i = 0; i < 30; i++) f.seed("nfce", { id: String(8200 + i), numero: String(i + 1), serie: "1", dataEmissao: "2026-09-10 08:00:00", situacao: 5, valorNota: 1 });
  const started = await f.ok("erp_bling_cutover_package_start", { command_id: commandId(), month: "2026-09" });
  assert.equal(started.package.state, "running");
  let wake = 0;
  while ((await runAdoptionWake(area, { storage: f.storage, readSnapshot: async () => f.snapshot(), media: f.media })).nextWake !== null && wake < 20) wake++;
  const done = (await f.ok("erp_bling_cutover_packages", {})).items.find(p => p.month === "2026-09");
  assert.deepEqual([done.state, done.notes, done.parts], ["done", 30, 2]);
});
