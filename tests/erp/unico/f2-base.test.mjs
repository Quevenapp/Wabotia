import { ERP_MANAGEMENT_ITEMS } from "../../../src/modules/erp/panel-menu.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { inTransaction, callRpc, invokeRpc, portedRpcs } from "../../../src/erp/engine/registry.ts";
import { todaySaoPaulo } from "../../../src/erp/engine/time.ts";
import { normalizeErpParts, ERP_PART_KEYS, ERP_MODULE_IDS, readErpPartsSnapshot } from "../../../src/erp/parts.ts";
import { ERP_RPC_RULES, requireRpcParts, rpcPartsRequirement, withErpMaintenance, maintenanceAllows } from "../../../src/erp/engine/parts-gate.ts";
import { erpEntityRequirement, erpReportRequirement, erpNotificationRequirement, erpRouteRequirement, erpDestinationRequirement, erpPreferenceFieldRequirement, erpListRequirement } from "../../../src/erp/parts-requirements.ts";
import { applyErpPartsSnapshot, requireCurrentErpParts, currentErpParts } from "../../../src/erp/parts-control.ts";
import { readIdentity, encodeIdentity, decodeIdentity } from "../../../src/erp/engine/identity.ts";

const minimal = () => nodeDriver(new DatabaseSync(":memory:"));
const disabled = e => e.code === "module_disabled";
const admin = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const identity = { actor: { user_id: admin, erp_role: "admin", is_agent: false, verified_factor: false, aal: "aal1", session_id: null, name: "Admin", email: null }, people: null };
const snap = (revision = "1", parts = normalizeErpParts(), now = Date.now()) => ({ profile: "area", revision, expires_at: now + 360_000, parts });
function kv() {
  const values = new Map();
  const store = { get: async k => values.get(k), put: async (k, v) => { values.set(k, structuredClone(v)); }, transaction: async fn => fn(store) };
  return store;
}

test("normalização: só false desliga; cópia congelada, inclusive na forma ObjectLookup", () => {
  // + Produção (erp-producao) e Expedição (erp-expedicao): onze partes.
  // + Contratos (erp-contratos): doze partes.
  assert.equal(ERP_MODULE_IDS.length, 12);
  assert.ok(ERP_PART_KEYS.every(k => normalizeErpParts()[k]));
  assert.equal(normalizeErpParts({ stock: false }).stock, false);
  const input = { stock: false };
  const db = minimal();
  inTransaction(db, ctx => {
    input.stock = true;
    assert.equal(ctx.parts.stock, false);
    assert.throws(() => { ctx.parts.stock = true; }, TypeError);
    assert.throws(() => { ctx.parts = normalizeErpParts(); }, TypeError);
  }, undefined, { parts: input });
  inTransaction(db, ctx => assert.ok(ctx.parts.finance), undefined, () => null);
  db.db.close();
});

test("todo RPC registrado tem classificação explícita", () => {
  assert.deepEqual(portedRpcs().filter(name => !ERP_RPC_RULES[name]), []);
  assert.ok(portedRpcs().includes("erp_document_save"));
});

test("invokeRpc repete autorização e não aceita domínio desconhecido", () => {
  const db = minimal();
  inTransaction(db, ctx => {
    assert.throws(() => invokeRpc(ctx, "erp_catalog_product_list", { p_user_id: admin }), disabled);
    assert.throws(() => requireRpcParts(ctx, "erp_inventado", {}), /unclassified/);
  }, undefined, { parts: { products: false } });
  db.db.close();
});

test("resolução persistida não deixa parâmetro trocar o dono", () => {
  const db = minimal(); db.exec("CREATE TABLE erp_documents__document(id TEXT, kind TEXT)");
  db.exec("INSERT INTO erp_documents__document VALUES(?, 'purchase_orders')", id);
  inTransaction(db, ctx => {
    assert.throws(() => requireRpcParts(ctx, "erp_document_get", { p_id: id, p_kind: "sales_orders" }), /owner_mismatch/);
    assert.throws(() => requireRpcParts(ctx, "erp_document_get", { p_id: id, p_kind: "purchase_orders" }), disabled);
    assert.ok(rpcPartsRequirement(ctx, "erp_document_get", { p_id: id }).all.includes("erp-compras"));
  }, undefined, { parts: { purchases: false } });
  inTransaction(db, ctx => assert.throws(() => requireRpcParts(ctx, "erp_document_get", { p_id: id, p_kind: "sales_orders" }), /owner_mismatch/),
    undefined, { identity: { ...identity, partsControl: { profile: "area", revision: "1", expires_at: Date.now() + 360_000 } }, parts: normalizeErpParts() });
  db.db.close();
});

test("filtros reais fecham o domínio adicional; categoria cadastral e consultas comuns permanecem disponíveis", () => {
  const db = minimal();
  inTransaction(db, ctx => {
    assert.throws(() => requireRpcParts(ctx, "erp_catalog_product_page_v3", { p_stock: "zero" }), disabled);
    assert.throws(() => requireRpcParts(ctx, "erp_fiscal_invoice_list", { p_category_id: id }), disabled);
    assert.throws(() => requireRpcParts(ctx, "erp_document_sales_report", { p_filters: { stock: false } }), disabled);
    requireRpcParts(ctx, "erp_catalog_product_page_v3", { p_category: id });
    requireRpcParts(ctx, "erp_catalog_product_page_v3", { p_filters: { category: id } });
    requireRpcParts(ctx, "erp_fiscal_invoice_list", {});
    requireRpcParts(ctx, "erp_reference_search", { p_table: "municipios" });
    requireRpcParts(ctx, "erp_document_signature", {});
  }, undefined, { parts: { stock: false, finance: false } });
  db.db.close();
});

test("relatório salvo usa fontes persistidas e tipos desconhecidos falham fechados", () => {
  const db = minimal(); db.exec('CREATE TABLE erp_preferences__report(id TEXT, base TEXT, columns TEXT, filters TEXT)');
  db.exec("INSERT INTO erp_preferences__report VALUES(?, 'venda_parcela', '[\"numero\"]', '[]')", id);
  inTransaction(db, ctx => assert.throws(() => requireRpcParts(ctx, "erp_preferences_report_run", { p_base: "contatos" }), disabled), undefined, { parts: { finance: false }, partsReference: { kind: "report", id } });
  assert.equal(erpEntityRequirement("inventado"), null); assert.equal(erpReportRequirement("inventado"), null);
  assert.deepEqual(erpNotificationRequirement("pagamento_recebido").all, ["erp-financeiro", "erp"]);
  db.db.close();
});

test("lista resolve comando salvo e conserva filtro indisponível reenviado sem alteração", () => {
  const db = minimal();
  db.exec("CREATE TABLE erp_list_preferences__preference(user_id TEXT,list_id TEXT,filters TEXT)");
  db.exec("CREATE TABLE erp_list_preferences__command(id TEXT,list_id TEXT)");
  db.exec("INSERT INTO erp_list_preferences__preference VALUES(?,'cadastros.produtos','{\"stock\":\"zero\"}')", admin);
  db.exec("INSERT INTO erp_list_preferences__command VALUES(?,'financeiro.contas_pagar')", id);
  inTransaction(db, ctx => {
    const args = { p_user_id: admin, p_list_id: "cadastros.produtos", p_filters: { stock: "zero" } };
    requireRpcParts(ctx, "erp_list_preferences_save", args);
    assert.throws(() => requireRpcParts(ctx, "erp_list_preferences_save", { ...args, p_filters: { stock: "negative" } }), disabled);
    assert.throws(() => requireRpcParts(ctx, "erp_list_preferences_save", { ...args, p_filters: null }), disabled);
    assert.throws(() => requireRpcParts(ctx, "erp_list_preferences_command", { p_command_id: id }), disabled);
    requireRpcParts(ctx, "erp_list_preferences_get", { p_list_id: "fiscal.entrada" });
  }, undefined, { parts: { stock: false, finance: false } });
  assert.equal(erpListRequirement("desconhecido.contacts"), null);
  db.db.close();
});

test("manutenção só libera compensação vinculada e não autoriza criação", () => {
  const db = minimal();
  db.exec("CREATE TABLE erp_access__membership(user_id TEXT, active INTEGER)"); db.exec("INSERT INTO erp_access__membership VALUES(?,1)", admin);
  db.exec("CREATE TABLE erp_documents__document(id TEXT, kind TEXT)"); db.exec("INSERT INTO erp_documents__document VALUES(?, 'sales_orders')", id);
  db.exec("CREATE TABLE erp_stock__document_posting(id TEXT, document_id TEXT)"); db.exec("INSERT INTO erp_stock__document_posting VALUES('posting', ?)", id);
  inTransaction(db, ctx => {
    const request = { origin: { type: "sales_orders", id }, action: "document_stock_reverse" };
    withErpMaintenance(ctx, request, () => {
      requireRpcParts(ctx, "erp_document_stock_reverse", { p_document_id: id, p_posting_id: "posting" });
      assert.throws(() => invokeRpc(ctx, "erp_catalog_product_list", { p_user_id: admin }), /maintenance_scope_denied/);
      assert.throws(() => requireRpcParts(ctx, "erp_document_stock_post", { p_document_id: id }), /maintenance_scope_denied/);
      assert.throws(() => requireRpcParts(ctx, "erp_document_stock_reverse", { p_document_id: "outro", p_posting_id: "posting" }), /maintenance_scope_denied/);
    });
    assert.equal(maintenanceAllows(ctx, "erp_document_stock_reverse", { p_document_id: id }), false);
    assert.throws(() => requireRpcParts(ctx, "erp_document_stock_reverse", { p_document_id: id }), disabled);
  }, undefined, { identity, parts: { stock: false, sales: false } });
  db.db.close();
});

test("fotografia completa validada atravessa codificador; parcial/falsificada não autoriza", () => {
  const { parts, ...partsControl } = snap();
  const round = decodeIdentity(encodeIdentity({ ...identity, parts, partsControl }));
  assert.deepEqual(round.parts, parts);
  assert.equal(readIdentity({ ...identity, parts: { fiscal: true }, partsControl }).parts, undefined);
  assert.equal(readErpPartsSnapshot({ ...snap(), revision: "01" }), null);
  assert.equal(readErpPartsSnapshot({ ...snap(), expires_at: Date.now() + 400_000 }), null);
  assert.equal(readErpPartsSnapshot(snap(), "outra"), null);
});

test("KV aceita duplicação/renovação, recusa atraso e mesmo número com mapa diferente", async () => {
  const store = kv(), s = snap("2");
  await applyErpPartsSnapshot(store, "area", s);
  await applyErpPartsSnapshot(store, "area", s);
  await assert.rejects(applyErpPartsSnapshot(store, "area", snap("1")), e => e.code === "erp_parts_stale");
  await assert.rejects(applyErpPartsSnapshot(store, "area", snap("2", normalizeErpParts({ finance: false }))), e => e.code === "erp_parts_stale");
  await assert.rejects(requireCurrentErpParts(store, "area", snap("1")), e => e.code === "erp_parts_stale");
  assert.equal(await currentErpParts(store, "area", s.expires_at), null);
  await assert.rejects(applyErpPartsSnapshot(store, "outra", snap()), e => e.code === "erp_parts_unavailable");
});

test("migração aditiva preserva escolhas e revisões na reexecução, triggers e ACK antigo", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE profile_modules(profile_id TEXT, module_id TEXT, enabled INTEGER, updated TEXT, updated_by TEXT, PRIMARY KEY(profile_id,module_id))");
  db.exec("INSERT INTO profile_modules VALUES('a','erp',1,'ontem','admin'),('a','erp-estoque',0,'hoje','admin'),('b','erp',0,'ontem','admin')");
  const sql = readFileSync("migrations/0133_erp_parts.sql", "utf8"); db.exec(sql);
  assert.equal(db.prepare("SELECT count(*) n FROM profile_modules").get().n, 12);
  assert.equal(db.prepare("SELECT enabled FROM profile_modules WHERE profile_id='a' AND module_id='erp-estoque'").get().enabled, 0);
  assert.equal(db.prepare("SELECT sum(enabled) n FROM profile_modules WHERE profile_id='b'").get().n, 0);
  db.exec("UPDATE profile_modules SET enabled=0 WHERE profile_id='a' AND module_id='erp'");
  db.exec(sql);
  assert.deepEqual({ ...db.prepare("SELECT * FROM profile_erp_revision WHERE profile_id='a'").get() }, { profile_id: "a", revision: 2, delivered_revision: 0 });
  db.exec("UPDATE profile_erp_revision SET delivered_revision=1 WHERE profile_id='a'");
  assert.equal(db.prepare("SELECT revision-delivered_revision pending FROM profile_erp_revision WHERE profile_id='a'").get().pending, 1);
  db.exec("DELETE FROM profile_modules WHERE profile_id='a' AND module_id='erp-estoque'");
  assert.equal(db.prepare("SELECT revision FROM profile_erp_revision WHERE profile_id='a'").get().revision, 3);
  db.close();
});

test("requisitos compostos de rota e tipos desconhecidos", () => {
  const req = (path, body, method = "GET") => erpRouteRequirement(method, new URL(path, "https://erp.invalid"), body);
  assert.equal(req("/v1/inventada"), null);
  assert.equal(req("/v1/documentos/inventado"), null);
  assert.ok(req("/v1/recebimentos-compras/" + id).all.includes("erp-estoque"));
  assert.ok(req("/v1/financeiro/actions/account_set_default", { target: "boleto" }, "POST").all.includes("erp-cobranca"));
  assert.ok(req("/v1/cadastros/products/completo", { initial_stock: {} }, "POST").all.includes("erp-estoque"));
  assert.equal(req("/v1/estoque/espelho"), "externo");
});


test("manutenção real estorna lançamento histórico, preserva replay e recusa postagem nova", () => {
  const lite = freshLite(), db = nodeDriver(lite);
  const port = { ...identity, people: [identity.actor], partsControl: { profile: "area", revision: "1", expires_at: Date.now() + 360_000 } };
  const all = { identity: port, parts: normalizeErpParts() };
  const rpc = (name, args, env = all) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, env);
  const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  try {
    const contact = catalog("contacts", { name: "Fornecedor", person_type: "J", roles: ["customer", "supplier"] });
    const product = catalog("products", { name: "Produto", unit: "UN", kind: "P", format: "S", price: "10" });
    const warehouse = catalog("warehouses", { name: "Depósito" });
    let doc = rpc("erp_document_save", { p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
      date: "2026-10-15", contact_id: contact.id, warehouse_id: warehouse.id,
      items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "2", unit_price: "10" }],
    } }).document;
    doc = rpc("erp_document_transition", { p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Preparar compra" }).document;
    const meta = { p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version, p_occurred_on: "2026-10-15", p_reason: "Lançamento anterior" };
    const preview = rpc("erp_document_stock_preview", meta).preview;
    const postArgs = { ...meta, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: preview.ignored.map(i => i.id) };
    rpc("erp_document_stock_post", postArgs);
    const posting = lite.prepare("SELECT id,version FROM erp_stock__document_posting WHERE document_id=? AND state='active'").get(doc.id);
    const version = lite.prepare("SELECT version FROM erp_documents__document WHERE id=?").get(doc.id).version;
    const off = { identity: port, parts: normalizeErpParts({ purchases: false, stock: false }), maintenance: {
      origin: { type: doc.kind, id: doc.id }, action: "document_stock_reverse_preview",
    } };
    const inspection = rpc("erp_document_get", { p_kind: doc.kind, p_id: doc.id }, {
      ...off, maintenance: { ...off.maintenance, action: "inspect" },
    });
    assert.ok(inspection.operations.includes("document_stock_reverse_preview"));
    assert.equal(inspection.links.stock[0].id, posting.id);
    const reverseArgs = { ...meta, p_expected_version: version, p_posting_id: posting.id, p_posting_version: posting.version, p_reason: "Desfazer lançamento" };
    const reversePreview = rpc("erp_document_stock_reverse_preview", reverseArgs, off).preview;
    off.maintenance.action = "document_stock_reverse";
    const command = { ...reverseArgs, p_command_id: randomUUID(), p_preview_hash: reversePreview.preview_hash };
    rpc("erp_document_stock_reverse", command, off);
    assert.equal(lite.prepare("SELECT state FROM erp_stock__document_posting WHERE id=?").get(posting.id).state, "reversed");
    assert.equal(rpc("erp_document_stock_reverse", command, off).replayed, true);
    assert.throws(() => rpc("erp_document_stock_post", postArgs, off), /maintenance_scope_denied/);
    assert.throws(() => rpc("erp_document_stock_reverse", command, { ...off, maintenance: undefined }), disabled);
  } finally { lite.close(); }
});


test("mapa compartilhado cobre os destinos atuais e campos mistos de preferência", () => {
  for (const item of ERP_MANAGEMENT_ITEMS) assert.ok(erpDestinationRequirement(item.target.to), item.target.to);
  assert.equal(erpDestinationRequirement("/formas-pagamento-empresa").owner, "erp");
  assert.equal(erpDestinationRequirement("/painel-produtos-empresa").owner, "erp-estoque");
  assert.ok(erpPreferenceFieldRequirement("vendas-vendas", "vendas.contas_automaticas_pedido").all.includes("erp-financeiro"));
});

test("cancelamento de PDV pode encerrar o pedido na cadeia de manutenção, sem reabrir ou criar venda", () => {
  const lite = freshLite(), db = nodeDriver(lite);
  const all = { identity: { ...identity, people: [identity.actor] }, parts: normalizeErpParts() };
  const rpc = (name, args, env = all) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, env);
  const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  try {
    const contact = catalog("contacts", { name: "Cliente", person_type: "J", roles: ["customer"] });
    const service = catalog("products", { name: "Serviço", unit: "UN", kind: "S", format: "S", price: "10" });
    const data = { sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null,
      account_id: null, cash_session_id: null, contact_id: contact.id, price_list_id: null,
      document: { date: todaySaoPaulo(), items: [{ product_id: service.id, description: service.name, unit: "UN", quantity: "1", unit_price: "10" }] },
      payments: [], destination_account_id: null, to_ledger: false, cash_received_cents: null };
    const sale = rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_save", p_data: data }).record;
    const off = { ...all, parts: normalizeErpParts({ pos: false, sales: false, stock: false, finance: false }),
      maintenance: { origin: { type: "pos_sale", id: sale.id }, action: "pos_sale_cancel" } };
    const cancel = { p_command_id: randomUUID(), p_action: "sale_cancel", p_data: { sale_id: sale.id, expected_version: sale.version, reason: "Cancelar venda anterior" } };
    assert.equal(rpc("erp_pos_sale_execute", cancel, off).record.state, "cancelled");
    assert.equal(rpc("erp_pos_sale_execute", cancel, off).replayed, true);
    assert.throws(() => rpc("erp_pos_sale_execute", { p_command_id: randomUUID(), p_action: "sale_save", p_data: data }, off), /maintenance_scope_denied/);
    assert.throws(() => rpc("erp_document_transition", { p_id: sale.document_id, p_kind: "sales_orders", p_expected_version: 2,
      p_status: "open", p_reason: "Reabrir", p_command_id: randomUUID() }, off), /maintenance_scope_denied/);
  } finally { lite.close(); }
});
