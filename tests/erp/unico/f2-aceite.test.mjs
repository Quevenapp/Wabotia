import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import "../../../src/erp/domains/index.ts";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import { callRpc, inTransaction, portedRpcs } from "../../../src/erp/engine/registry.ts";
import { handleRpc } from "../../../src/erp/engine/rpc-endpoint.ts";
import { CUSTOMER_BRIDGE_USER_ID, IDENTITY_HEADER, SYSTEM_HEADER, GATE_HEADER, encodeIdentity } from "../../../src/erp/engine/identity.ts";
import { normalizeErpParts, ERP_PART_KEYS } from "../../../src/erp/parts.ts";
import { ERP_RPC_RULES, inspectErpEffects, withErpMaintenance } from "../../../src/erp/engine/parts-gate.ts";
import { erpRouteRequirement } from "../../../src/erp/parts-requirements.ts";
import { ERP_ROUTE_PATTERNS, erpRouteExists } from "../../../src/erp/blocks.ts";
import { partsMaintenance } from "../../../src/erp/api/parts-maintenance.ts";
import { homeResponse } from "../../../src/erp/fagoo/workers/erp-api/src/home.mjs";
import { documentsResponse } from "../../../src/erp/fagoo/workers/erp-api/src/documents.mjs";
import { cnabFixture } from "../cnab/fixture.mjs";

const admin = "11111111-1111-4111-8111-111111111111";
const actor = { user_id: admin, name: "Administrador", email: null, erp_role: "admin", verified_factor: false, session_id: null, aal: "aal1", is_agent: false };
const baseOnly = Object.fromEntries(ERP_PART_KEYS.map(key => [key, key === "customers"]));

test("rotas com parâmetros camelCase e numéricos reconhecem o identificador inteiro", () => {
  const patterns = ERP_ROUTE_PATTERNS.filter(([, path]) => /:[a-z_]*[A-Z]/.test(path));
  assert.ok(patterns.length > 10);
  for (const [methods, pattern] of patterns) {
    const path = pattern.replace(/\(([^()]+)\)/g, (_, alternatives) => alternatives.split("|")[0])
      .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, admin);
    for (const method of methods.split("|")) {
      assert.equal(erpRouteExists(method, path), true, `${method} ${path}`);
      assert.equal(erpRouteExists(method, `${path}/inexistente`), false, `${method} ${path}/inexistente`);
    }
  }
  assert.ok(erpRouteRequirement("GET", new URL(`https://internal/v1/retornos-operacionais/settlements/${admin}`)).all.includes("erp-cobranca"));
});

function fixture(t) {
  const lite = freshLite(), db = nodeDriver(lite), kv = new Map(); t.after(() => lite.close());
  const storage = {
    sql: { exec(...args) { const r = db.exec(...args); return { ...r, toArray: () => r.rows }; } },
    transactionSync: fn => db.transaction(fn), get: async key => kv.get(key), put: async (key, value) => { kv.set(key, structuredClone(value)); },
    transaction: async fn => fn(storage), getAlarm: async () => null, setAlarm: async () => {},
  };
  let revision = 0, identity;
  const parts = (value = {}, person = actor) => identity = { actor: person, people: [person], parts: normalizeErpParts(value),
    partsControl: { profile: "aceite", revision: String(++revision), expires_at: Date.now() + 360_000 } };
  parts();
  const direct = (name, args = {}) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, { identity: { actor, people: [actor] }, parts: normalizeErpParts() });
  const raw = (name, args = {}, port = identity, extra = {}) => handleRpc({ storage }, "aceite", name,
    new Request(`https://internal/erp-rpc/${name}`, { method: "POST", headers: { [IDENTITY_HEADER]: encodeIdentity(port), [SYSTEM_HEADER]: "1", [GATE_HEADER]: "1", ...extra },
      body: JSON.stringify({ p_user_id: port.actor?.user_id, ...args }) }));
  const wire = async (name, args = {}) => { const r = await raw(name, args), body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); return body; };
  const catalog = (entity, data) => direct("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  const contact = catalog("contacts", { name: "Cliente e fornecedor", person_type: "J", roles: ["customer", "supplier"] });
  const product = catalog("products", { name: "Produto", unit: "UN", kind: "P", format: "S", price: "10" });
  const warehouse = catalog("warehouses", { name: "Depósito" });
  const body = extra => ({ date: "2026-11-19", contact_id: contact.id, items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "1", unit_price: "10" }],
    installments: [{ due_date: "2026-12-19", amount: "10" }], ...extra });
  const save = (kind, extra) => ({ p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: body(extra) });
  const maintenance = (origin, action, args) => partsMaintenance(new Request(action === "inspect"
    ? `https://internal/v1/sistema/manutencao-efeitos?type=${origin.type}&id=${origin.id}` : "https://internal/v1/sistema/manutencao-efeitos", {
    method: action === "inspect" ? "GET" : "POST", ...(action === "inspect" ? {} : { body: JSON.stringify({ origin, action, args }) }),
  }), identity, (url, init) => raw(url.split("/").at(-1), JSON.parse(init.body), identity, init.headers));
  return { lite, db, kv, parts, direct, raw, wire, catalog, contact, product, warehouse, save, maintenance };
}

test("inventário expandido usa os requisitos comuns e todos os RPCs portados têm classificação", () => {
  const { routes, discriminators } = JSON.parse(readFileSync("tests/erp/fixtures/route-blocks.json", "utf8"));
  const registered = new Set(portedRpcs()); let covered = 0;
  for (const route of routes) {
    for (const rpc of route.rpcs) if (registered.has(rpc)) { assert.ok(ERP_RPC_RULES[rpc], rpc); covered++; }
    for (const c of route.cases) assert.ok(erpRouteRequirement(c.method, new URL(c.path, "https://internal")), c.path);
  }
  assert.ok(covered > 600);
  assert.ok(discriminators.length > 10);
  assert.deepEqual([...registered].filter(rpc => !ERP_RPC_RULES[rpc]), []);
});

test("transporte valida fotografia e privacidade juntas; cadastro técnico precisa somente da Base", async t => {
  const f = fixture(t), port = f.parts(baseOnly);
  const args = { p_period: "hoje", p_from: null, p_to: null };
  const home = await f.wire("erp_home_overview", args);
  assert.deepEqual(homeResponse(home, { args }), home);
  assert.equal(home.finance, null); assert.equal(home.stock, null);
  assert.equal((await f.raw("erp_catalog_product_list")).status, 409);
  assert.equal((await f.raw("erp_home_overview", args, { ...port, parts: { customers: true } })).status, 503);
  assert.equal((await f.raw("erp_catalog_contact_get", { p_id: f.contact.id }, { ...port, customer_privacy: { restricted_contact_ids: [f.contact.id] } })).status, 403);
  const technical = { ...actor, user_id: CUSTOMER_BRIDGE_USER_ID, erp_role: "vendas", is_agent: true, is_technical: true };
  f.parts(baseOnly, technical);
  const contact = await f.wire("erp_catalog_contact_get", { p_id: f.contact.id });
  assert.equal(contact.record.name, f.contact.name);
  assert.ok(!("notes" in contact.record));
  assert.equal((await f.raw("erp_home_overview", args)).status, 403);
  assert.equal((await f.raw("erp_catalog_contact_save", { p_id: f.contact.id, p_data: { notes: "Não autorizado" } })).status, 403);
});

for (const stock of [false, true]) for (const finance of [false, true]) test(`transporte comercial e parser: Estoque=${stock}, Financeiro=${finance}`, async t => {
  const f = fixture(t);
  f.direct("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-11-19", p_reason: "Saldo anterior", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "10", expected_version: 0 }] });
  const category = f.direct("erp_finance_category_execute", { p_action: "category_create", p_command_id: randomUUID(), p_data: { kind: "receivable", name: "Vendas" } }).record;
  f.lite.prepare("INSERT OR IGNORE INTO erp_preferences__situation_adoption(kind,migration) VALUES('sales_orders','aceite')").run();
  const old = f.lite.prepare("SELECT version FROM erp_preferences__transition WHERE kind='sales_orders' AND from_key='open' AND to_key='fulfilled'").get();
  f.direct("erp_preferences_transition_save", { p_kind: "sales_orders", p_from: "open", p_to: "fulfilled", p_expected_version: old?.version ?? 0,
    p_command_id: randomUUID(), p_data: { active: true, actions: ["post_stock", "post_finance"] } });
  f.parts({ stock, finance });
  const doc = (await f.wire("erp_document_save", f.save("sales_orders", { ...(stock ? { warehouse_id: f.warehouse.id } : {}), ...(finance ? { category_id: category.id } : {}) }))).document;
  const args = { p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: "fulfilled", p_reason: "Atendimento integrado" };
  const result = await f.wire("erp_document_transition", args);
  assert.equal(result.document.status, "fulfilled");
  const parsed = documentsResponse(result, { kind: doc.kind, id: doc.id }, { type: "document", rpc: "erp_document_transition", args });
  assert.equal(parsed.document.status, result.document.status);
  assert.deepEqual(parsed.effects, result.effects);
  assert.deepEqual(parsed.document.effect_flags, result.document.effect_flags);
  assert.deepEqual(parsed.unavailable_parts, result.unavailable_parts);
  for (const [key, on] of Object.entries({ stock, finance })) {
    const effect = result.effects.find(e => e.action === `post_${key}`);
    assert.equal(effect.outcome, on ? "done" : "skipped"); if (!on) assert.equal(effect.reason, "part_disabled");
  }
  f.parts();
  const replay = await f.wire("erp_document_transition", args);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.effects, result.effects);
  for (const [key, on] of Object.entries({ stock, finance }))
    assert.equal(f.lite.prepare(`SELECT count(*) n FROM erp_${key}__document_posting WHERE document_id=?`).get(doc.id).n, on ? 1 : 0);
});

test("manutenção HTTP inspeciona versões e estorna legado com origem desligada, sem abrir criação", async t => {
  const f = fixture(t);
  let doc = f.direct("erp_document_save", f.save("purchase_orders", { warehouse_id: f.warehouse.id })).document;
  doc = f.direct("erp_document_transition", { p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version, p_command_id: randomUUID(), p_status: "in_progress", p_reason: "Preparar compra" }).document;
  const meta = { p_kind: doc.kind, p_document_id: doc.id, p_expected_version: doc.version, p_occurred_on: "2026-11-19", p_reason: "Efeito anterior" };
  const preview = f.direct("erp_document_stock_preview", meta).preview;
  const post = { ...meta, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: preview.ignored.map(i => i.id) };
  f.direct("erp_document_stock_post", post); f.parts({ purchases: false, stock: false });
  assert.equal((await f.raw("erp_document_get", { p_kind: doc.kind, p_id: doc.id })).status, 409);
  const origin = { type: doc.kind, id: doc.id }, inspect = await f.maintenance(origin, "inspect");
  assert.equal(inspect.status, 200); const view = await inspect.json();
  assert.equal(view.origin_version, f.lite.prepare("SELECT version FROM erp_documents__document WHERE id=?").get(doc.id).version);
  const posting = view.links.stock[0];
  const reverse = { ...meta, p_expected_version: view.origin_version, p_posting_id: posting.id, p_posting_version: posting.version, p_reason: "Desfazer efeito anterior" };
  const check = await f.maintenance(origin, "document_stock_reverse_preview", reverse); assert.equal(check.status, 200);
  const args = { ...reverse, p_command_id: randomUUID(), p_preview_hash: (await check.json()).preview.preview_hash };
  const done = await f.maintenance(origin, "document_stock_reverse", args); assert.equal(done.status, 200);
  const replay = await f.maintenance(origin, "document_stock_reverse", args); assert.equal((await replay.json()).replayed, true);
  assert.equal(f.lite.prepare("SELECT state FROM erp_stock__document_posting WHERE id=?").get(posting.id).state, "reversed");
  assert.equal((await f.raw("erp_document_stock_post", post)).status, 409);
  assert.equal((await f.maintenance(origin, "erp_document_stock_post", post)).status, 400);
});

test("inspeção devolve versões atuais dos títulos efetivamente lançados pela nota", async t => {
  const f = fixture(t), invoice = randomUUID(), stamp = Date.now() * 1000;
  f.lite.prepare(`INSERT INTO erp_fiscal_invoices__invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,updated_at)
    VALUES(?,'55','1','T',NULL,1,1,42,'Operação','2026-11-19','1','1','0',0,?,'[]','{}',?,'[]','{}',0,0,0,0,0,'{"total":10}',1,?,?,?,?)`).run(
    invoice, JSON.stringify({ name: f.contact.name, contact_id: f.contact.id }), JSON.stringify({ installments: [{ date: "2026-12-19", amount: "10", method: "15" }] }), admin, admin, stamp, stamp);
  f.lite.prepare(`INSERT INTO erp_fiscal_invoices__invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
    VALUES(?,1,?,10000,'10',1000,0,0,0,0,'{"description":"Produto","unit":"UN"}')`).run(invoice, f.product.id);
  const preview = f.direct("erp_finance_invoice_finance_preview", { p_invoice_id: invoice, p_expected_version: 1 }).preview;
  const posted = f.direct("erp_finance_invoice_finance_post", { p_command_id: randomUUID(), p_data: { invoice_id: invoice, expected_version: 1, preview_hash: preview.preview_hash } });
  f.parts(baseOnly);
  const response = await f.maintenance({ type: "nfe", id: invoice }, "inspect"); assert.equal(response.status, 200);
  const note = await response.json();
  assert.equal(note.origin_version, f.lite.prepare("SELECT version FROM erp_fiscal_invoices__invoice WHERE id=?").get(invoice).version);
  assert.deepEqual(note.links.finance[0].titles, posted.titles.map(({ id, version }) => ({ id, version })));
});

test("inspeção da remessa histórica informa sequência textual sem alterar sua gravação", async t => {
  const f = await cnabFixture(); t.after(() => f.close());
  const profile = await f.profile(); await f.homologationRemittance(profile, [await f.title()]);
  const row = f.lite.prepare("SELECT id,CAST(sequence AS TEXT) sequence FROM erp_cnab__remittance WHERE profile_id=?").get(profile.id);
  const person = { ...actor, user_id: f.users.admin };
  const view = inTransaction(f.driver, ctx => withErpMaintenance(ctx, { origin: { type: "remittance", id: row.id }, action: "inspect" }, () => inspectErpEffects(ctx)), undefined,
    { identity: { actor: person, people: null }, parts: normalizeErpParts(baseOnly) });
  assert.deepEqual(view.links.remittances.map(link => ({ ...link })), [{ id: row.id, sequence: row.sequence }]);
  assert.ok(view.operations.includes("remittance_exclude"));
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_cnab__remittance_exclusion").get().n, 0);
});

test("famílias fiscais e aliases resolvem requisitos sem abrir caminhos inexistentes", () => {
  const id = randomUUID();
  for (const [method, path] of [
    ["GET", "/v1/a1"], ["POST", "/v1/a1/configure"],
    ["POST", "/v1/fiscal-authorization/preview"], ["POST", "/v1/fiscal-authorization/reviewed/run"],
    ["GET", `/v1/fiscal-danfe/candidates/${id}/preview`], ["POST", "/v1/fiscal-reconciliation/run"],
    ["POST", "/v1/fiscal-signed/run"], ["POST", "/v1/fiscal-unsigned/generate"], ["POST", "/v1/fiscal-wsdl/run"],
  ]) {
    const requirement = erpRouteRequirement(method, new URL(path, "https://internal"));
    assert.deepEqual(new Set(requirement.all), new Set(["erp-fiscal", "erp"]), path);
    assert.equal(erpRouteRequirement(method, new URL(path + "/inexistente", "https://internal")), null);
  }
  for (const [alias, destination] of [["/v1/estoque/checkin", "/v1/estoque/checkin/notas"], ["/v1/frente-caixa/contexto", "/v1/frente-caixa"]])
    assert.deepEqual(erpRouteRequirement("GET", new URL(alias, "https://internal")), erpRouteRequirement("GET", new URL(destination, "https://internal")));
});
