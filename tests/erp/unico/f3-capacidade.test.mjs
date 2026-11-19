import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc, inTransaction, invokeRpc } from "../../../src/erp/engine/registry.ts";
import { canonical, commandId, eventKey, hash, F3_NAMESPACES } from "../../../src/integrations/keys.ts";
import { MODULE_RPCS, verifyModuleTransport, moduleSystemUser, originScope, withModuleExecution, withOriginOperation, originAnchor, targetOrigin } from "../../../src/erp/engine/module-origin.ts";
import { rpcPartsRequirement } from "../../../src/erp/engine/parts-gate.ts";
import { decodeIdentity, encodeIdentity, GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER } from "../../../src/erp/engine/identity.ts";
import { handleRpc } from "../../../src/erp/engine/rpc-endpoint.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { requireAccess as financeAccess } from "../../../src/erp/domains/finance/internal.ts";
import { insertDocument, updateDocument, updateItem } from "../../../src/erp/domains/documents/rows.ts";
import { erpDocumentSave } from "../../../src/erp/domains/documents/rpc/erp_document_save.ts";
import { erpDocumentCopy } from "../../../src/erp/domains/documents/rpc/erp_document_conversions.ts";
import { serviceJournalContext } from "../../../src/erp/domains/documents/rpc/reads-journal.ts";
import { erpFinanceExecute } from "../../../src/erp/domains/finance/rpc/erp_finance_execute.ts";
import { erpFinanceTitleExecute } from "../../../src/erp/domains/finance/rpc/erp_finance_title_execute.ts";
import { dumpAll, restoreAll } from "../../../src/erp/engine/dump.ts";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const human = { user_id: ADMIN, erp_role: "admin", name: "Pessoa", email: null, is_agent: false, verified_factor: true, session_id: "22222222-2222-4222-8222-222222222222", aal: "aal2" };
const at = Date.UTC(2026, 10, 18, 15);
const denied = error => error.code === "42501";

function fixture(t, module = "os") {
  const lite = freshLite(), db = nodeDriver(lite), local = new DatabaseSync(":memory:");
  t.after(() => { lite.close(); local.close(); });
  local.exec("CREATE TABLE os_orders(id TEXT); CREATE TABLE agenda_appointments(id TEXT); CREATE TABLE entrega_deliveries(id TEXT); CREATE TABLE profile_modules(profile_id TEXT,module_id TEXT,enabled INTEGER)");
  local.exec(readFileSync(new URL("../../../migrations/0135_module_erp_integration.sql", import.meta.url), "utf8"));
  const d1 = { prepare(sql) { return { bind(...args) { return { first: async () => local.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: local.prepare(sql).all(...args) }) }; } }; } };
  const source = { profile: "area-f3", module, source_id: randomUUID(), component: "main" };
  const actor = { ...human, user_id: moduleSystemUser(module), name: `Sistema · ${module}`, erp_role: "vendas", is_agent: true, verified_factor: false, session_id: null, aal: "aal1" };
  const identity = { actor, people: [actor, human] };
  const rpc = (name, args = {}, env = {}) => callRpc(db, name, { p_user_id: ADMIN, ...args }, undefined, { identity: { actor: human, people: [actor, human] }, ...env });
  const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  const contact = catalog("contacts", { name: "Cliente", person_type: "J", roles: ["customer", "supplier"] });
  const product = catalog("products", { name: "Material", unit: "UN", kind: "P", format: "S", price: "10" });
  const warehouse = catalog("warehouses", { name: "Depósito" });
  const category = rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Receita" } }).record;
  const account = rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-11-17", p_reason: "Saldo inicial de teste", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "100", expected_version: 0 }] });
  const policy = { profile: source.profile, version: 1, auto_post: { stock: true, finance: true }, warehouse_id: warehouse.id,
    revenue_category_id: category.id, payment_method_id: null, settlement_accounts: { cash: account.id }, consumer_contact_id: null, installment_rule: "single_on_trigger" };
  const epochs = Object.fromEntries([module, "erp", "erp-produtos", "erp-vendas", "erp-estoque", "erp-financeiro"].map(id => [id, 1]));
  for (const id of Object.keys(epochs)) local.prepare("INSERT INTO module_erp_activation VALUES(?,?,1,1,?,?,?)").run(source.profile, id, at - 1000, at - 1000, at - 1000);
  local.prepare("INSERT INTO module_erp_sources(profile_id,module_id,source_id) VALUES(?,?,?)").run(source.profile, module, source.source_id);
  let seq = 0, last = null;
  let snapshot = { schema: 1, source, source_revision: 1, contact_id: contact.id, customer_ref: null, privacy: "commercial", description: "Serviço contratado", issued_on: "2026-11-18",
    items: [{ id: randomUUID(), description: "Material", quantity: "1", unit_cents: 1000, unit: "UN", kind: "material", product_id: product.id }],
    total_cents: 1000, freight_cents: 0, discount_cents: 0, installments: [{ key: "main", due_on: "2026-11-18", amount_cents: 1000, payment_method_id: null }], policy_version: 1,
    lifecycle: { base_status: "in_progress", stage_id: null, quote_version: 1, authorization: "approved_quote", authorized_at: at - 100, first_execution_at: at, delivered_at: null, warranty_until: null }, technical: null };
  function enqueue(options = {}) {
    seq++;
    const operation = options.operation ?? (module === "os" || ["pedido", "mesas", "entrega"].includes(module) ? "execute" : "recognize");
    snapshot = { ...snapshot, ...options.snapshot, source_revision: seq, lifecycle: { ...snapshot.lifecycle, ...options.lifecycle } };
    const event = { id: randomUUID(), command_id: commandId(source, seq), event_key: eventKey(source, operation, seq), source, seq, source_revision: seq,
      operation, occurred_ms: at + seq, epochs, eligible: options.eligible ?? { document: true, stock: true, finance: true }, snapshot,
      receipt_key: options.receipt?.receipt.receipt_key ?? null, reverses_receipt_key: options.receipt?.receipt.reverses_key ?? null,
      reason_code: options.reason ?? null, actor_id: ADMIN };
    const expected = Object.fromEntries((last?.links ?? []).filter(l => l.version !== null).map(l => [`${l.kind === "stock_posting" ? "posting" : l.kind}:${l.id}`, l.version]));
    const request = { schema: 1, command_id: event.command_id, actor_id: options.human ? options.human.user_id : actor.user_id,
      source, seq, event_hash: hash(event), expected, body: { operation, route: module === "os" ? "work" : ["pedido", "mesas", "entrega"].includes(module) ? "sale" : "title",
        snapshot, policy: options.policy ?? policy, eligible: event.eligible, requested: options.requested ?? { document: true, stock: true, finance: true }, epochs,
        occurred_ms: event.occurred_ms, receipt: options.receipt ?? null, reason_code: event.reason_code, mode: options.human ? "human" : "system" } };
    if (options.closeOnly) request.body = { mode: "system", operation, close_only: true };
    local.prepare("INSERT INTO module_erp_events VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(event.id, source.profile, module, source.source_id, seq, seq, event.command_id, event.event_key, event.occurred_ms, hash(event), canonical(event));
    local.prepare("INSERT INTO module_erp_requests VALUES(?,?,?,?,?,?)").run(event.id, request.actor_id, hash(request), canonical(expected), canonical(request.body), at);
    const evidence = { profile: source.profile, module, source_id: source.source_id, seq, event_id: event.id, command_id: request.command_id, event_hash: request.event_hash, request_hash: hash(request), mode: options.human ? "human" : "system" };
    const envelope = { ...identity, actor: options.human ?? actor, people: [actor, human, ...(options.human ? [options.human] : [])], module_execution: evidence };
    const args = { p_user_id: envelope.actor.user_id, p_request: request, p_evidence: evidence };
    return { event, request, evidence, identity: envelope, args };
  }
  async function proof(input, name = input.request.body.mode === "human" ? "erp_module_manual_apply" : "erp_module_apply") {
    return verifyModuleTransport(d1, source.profile, name, input.args, input.identity);
  }
  async function run(input, parts = {}, name = input.request.body.mode === "human" ? "erp_module_manual_apply" : "erp_module_apply") {
    const moduleProof = await proof(input, name);
    const r = callRpc(db, name, input.args, undefined, { identity: input.identity, parts, gate: true, moduleProof });
    if (name.endsWith("apply") || name.endsWith("close")) last = r;
    return r;
  }
  function payment(key, kind = "receive", reverses = null, amount = 1000) {
    const receipt = { profile_id: source.profile, receipt_key: key, owner_module: module, source_id: source.source_id, kind,
      evidence: "manual", reverses_key: reverses, amount_cents: amount, method: "cash", occurred_ms: at + 1000, actor_id: ADMIN, evidence_hash: hash([key, amount]) };
    local.prepare(`INSERT INTO module_commercial_receipts(${Object.keys(receipt).join()}) VALUES(${Object.keys(receipt).map(() => "?").join()})`).run(...Object.values(receipt));
    local.prepare("INSERT INTO module_erp_allocations VALUES(?,?,?,?,?,?,?)").run(source.profile, key, key + ":allocation", module, source.source_id, source.component, amount);
    return { receipt, amount_cents: amount };
  }
  return { lite, db, local, d1, actor, identity, source, rpc, enqueue, run, proof, payment, contact, product, warehouse, category, account, policy,
    count: table => lite.prepare(`SELECT count(*) n FROM ${table}`).get().n };
}

test("classificação dos quatro RPCs F3 exige Base e não concede capacidade", async t => {
  const f = fixture(t);
  for (const name of MODULE_RPCS) {
    const input = f.enqueue({ human: name === "erp_module_manual_apply" ? human : undefined });
    const args = { ...input.args, ...(name === "erp_module_command_close" ? { p_reason_code: "replace_request" } : {}) };
    inTransaction(f.db, ctx => assert.deepEqual(rpcPartsRequirement(ctx, name, args)?.all, ["erp"]));
    // Mesmo uma pessoa administradora precisa da prova interna; classificar
    // o RPC não torna o envelope ou o papel uma autorização de execução.
    for (const identity of [input.identity, { actor: human, people: [human] }])
      assert.throws(() => callRpc(f.db, name, { ...args, p_user_id: identity.actor.user_id }, undefined, { identity, gate: true }), denied);
    const moduleProof = await f.proof(input, name);
    assert.throws(() => callRpc(f.db, name, args, undefined, {
      identity: input.identity, gate: true, moduleProof, parts: { customers: false },
    }), error => error.code === "part_disabled");
  }
  assert.equal(f.count("erp_documents__document"), 0);
  assert.equal(f.count("erp_documents__command"), 0);
  assert.equal(f.count("erp_finance__title"), 0);
  assert.equal(f.count("erp_stock__document_posting"), 0);
});

test("execução integral própria com vendas: lançamento conjunto, baixa, estorno, cancelamento e replay", async t => {
  const f = fixture(t), input = f.enqueue(), r = await f.run(input);
  assert.equal(r.effects.stock, "posted"); assert.equal(r.effects.finance, "posted");
  assert.equal(f.count("erp_finance__title"), 1);
  assert.deepEqual(await f.run(input), { ...r, replayed: true });
  const paid = f.enqueue({ operation: "receive", receipt: f.payment("paid") });
  assert.equal((await f.run(paid)).effects.finance, "settled");
  assert.equal(f.count("erp_finance__settlement"), 1);
  await f.run(paid); assert.equal(f.count("erp_finance__settlement"), 1);
  const reversed = f.enqueue({ operation: "reverse", receipt: f.payment("reverse", "reverse", "paid"), reason: "payment_void" });
  assert.equal((await f.run(reversed, { finance: false })).effects.finance, "reversed");
  const cancelled = f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "work_cancelled" });
  const closed = await f.run(cancelled, { stock: false, finance: false, sales: false });
  assert.equal(closed.effects.finance, "reversed"); assert.equal(closed.effects.stock, "reversed");
  assert.equal(f.lite.prepare("SELECT role FROM erp_access__membership WHERE user_id=?").get(f.actor.user_id).role, "vendas");
});

test("transação conjunta desfaz estoque se financeiro falhar; escopo não permanece", async t => {
  const f = fixture(t), input = f.enqueue({ policy: { ...f.policy, revenue_category_id: randomUUID() } });
  await assert.rejects(f.run(input));
  assert.equal(f.count("erp_documents__document"), 0); assert.equal(f.count("erp_finance__title"), 0);
  assert.equal(f.count("erp_stock__document_posting"), 0);
  assert.equal(f.count("erp_stock__movement"), 1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__command WHERE json_extract(result,'$.policy')='wabotia-module-origin-v1'").get().n, 0);
  inTransaction(f.db, ctx => assert.throws(() => financeAccess(ctx.db, f.actor.user_id, true), denied));
});

for (const stock of [false, true]) for (const finance of [false, true]) test(`destinos ligados/desligados stock=${stock}, finance=${finance}`, async t => {
  const f = fixture(t), input = f.enqueue({ policy: { ...f.policy, warehouse_id: stock ? f.warehouse.id : null } });
  const r = await f.run(input, { stock, finance });
  assert.equal(f.count("erp_stock__document_posting"), stock ? 1 : 0);
  assert.equal(f.count("erp_finance__title"), finance ? 1 : 0);
  assert.equal((await f.run(input)).replayed, true);
  assert.equal(f.count("erp_finance__title"), finance ? 1 : 0);
});

test("somente financeiro: documento interno com linhas livres e Vendas desligada", async t => {
  const f = fixture(t, "pedido"), input = f.enqueue({ requested: { document: true, stock: false, finance: true },
    snapshot: { items: [{ id: randomUUID(), description: "Item livre", quantity: "1", unit_cents: 1000, unit: "UN", kind: "free", product_id: null }] } });
  const r = await f.run(input, { products: false, stock: false, sales: false });
  assert.equal(r.effects.finance, "posted"); assert.equal(f.count("erp_stock__document_posting"), 0);
  assert.equal(f.count("erp_catalog__product"), 1);
});

test("pronto volta à execução sem relançar; cliente/itens/valores ficam congelados", async t => {
  const f = fixture(t), r = await f.run(f.enqueue());
  await f.run(f.enqueue({ operation: "lifecycle", lifecycle: { base_status: "ready" } }));
  await f.run(f.enqueue({ operation: "lifecycle", lifecycle: { base_status: "in_progress" }, reason: "work_resumed" }));
  assert.equal(f.count("erp_stock__document_posting"), 1); assert.equal(f.count("erp_finance__title"), 1);
  const doc = r.links.find(l => l.kind === "document").id;
  inTransaction(f.db, ctx => {
    assert.throws(() => updateDocument(ctx, doc, { contact_id: randomUUID() }), denied);
    const item = f.lite.prepare("SELECT id FROM erp_documents__item WHERE document_id=?").get(doc);
    assert.throws(() => updateItem(ctx, item.id, { quantity: "2000000" }), denied);
    assert.throws(() => serviceJournalContext(ctx.db, ADMIN, doc, true), denied);
    assert.throws(() => erpDocumentCopy(ctx, { p_id: doc }), denied);
  });
  const changed = f.enqueue({ operation: "prepare", snapshot: { contact_id: randomUUID() } });
  await assert.rejects(f.run(changed), /module_commercial_frozen/);
});

test("recibo perdido é recuperado mesmo depois de desligamento; close disputa a mesma chave", async t => {
  const f = fixture(t), input = f.enqueue(), r = await f.run(input);
  f.local.prepare("UPDATE module_erp_activation SET enabled=0,enabled_since_ms=NULL,epoch=2").run();
  const recovered = await f.run(input, { finance: false, stock: false }, "erp_module_origin_get");
  assert.deepEqual(recovered.receipt, { ...r, replayed: true });
  input.args.p_reason_code = "replace_request";
  assert.deepEqual(await f.run(input, {}, "erp_module_command_close"), { ...r, replayed: true });
  delete input.args.p_reason_code;
  assert.equal(f.count("erp_finance__title"), 1);
});

test("comando fechado não produz efeitos; sequência fora de ordem e época encerrada falham", async t => {
  const f = fixture(t), first = f.enqueue();
  first.args.p_reason_code = "superseded";
  assert.equal((await f.run(first, {}, "erp_module_command_close")).outcome, "closed");
  delete first.args.p_reason_code;
  assert.equal((await f.run(first)).outcome, "closed");
  assert.equal(f.count("erp_documents__document"), 0);
  const second = f.enqueue();
  f.local.prepare("UPDATE module_erp_activation SET epoch=2").run();
  await assert.rejects(f.run(second), /epoch_closed/);
  const third = f.enqueue();
  await assert.rejects(f.run(third), /module_sequence_conflict/);
});

for (const module of ["mensalidade", "agenda", "reserva", "suporte"]) test(`${module}: recebível direto próprio, sem produto nem documento`, async t => {
  const f = fixture(t, module), request = f.enqueue({ requested: { document: false, stock: false, finance: true } });
  const r = await f.run(request, { products: false, stock: false, sales: false });
  assert.equal(r.effects.finance, "posted"); assert.equal(f.count("erp_documents__document"), 0);
  const p = f.enqueue({ operation: "receive", receipt: f.payment("paid") });
  assert.equal((await f.run(p)).effects.finance, "settled");
});

test("sem capacidade: vendas e marca de cabeçalho não autorizam RPC financeiro ou humano genérico", async t => {
  const f = fixture(t), input = f.enqueue();
  assert.throws(() => callRpc(f.db, "erp_module_apply", input.args, undefined, { identity: input.identity }), denied);
  for (const name of ["erp_finance_execute", "erp_preferences_page", "erp_stock_post", "erp_document_save"]) {
    const args = name === "erp_preferences_page" ? { p_user_id: f.actor.user_id, p_page: "vendas-vendas" } :
      name === "erp_finance_execute" ? { p_user_id: f.actor.user_id, p_command_id: randomUUID(), p_action: "opening", p_data: {} } :
      name === "erp_document_save" ? { p_user_id: f.actor.user_id, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {} } :
      { p_user_id: f.actor.user_id, p_command_id: randomUUID(), p_kind: "issue", p_occurred_on: "2026-11-18", p_reason: "Teste", p_reference: null, p_items: [] };
    assert.throws(() => callRpc(f.db, name, args, undefined, { identity: input.identity }), denied);
  }
  const ordinary = { ...human, user_id: randomUUID(), erp_role: "vendas" };
  assert.throws(() => f.rpc("erp_finance_execute", { p_user_id: ordinary.user_id, p_command_id: randomUUID(), p_action: "title_create_group", p_data: {} },
    { identity: { actor: ordinary, people: [ordinary] } }), denied);
});

test("transporte recusa troca de área, módulo, origem, corpo, ator e hash; envelope preserva marca sem conceder escopo", async t => {
  const f = fixture(t), input = f.enqueue();
  const decoded = decodeIdentity(encodeIdentity(input.identity));
  assert.deepEqual(decoded.module_execution, input.evidence);
  for (const change of [i => { i.args.p_request.source.profile = "outra"; }, i => { i.args.p_evidence.module = "pedido"; },
    i => { i.args.p_request.source.source_id = randomUUID(); }, i => { i.args.p_request.body.snapshot.total_cents++; },
    i => { i.args.p_request.actor_id = ADMIN; }, i => { i.args.p_evidence.request_hash = "0".repeat(64); }]) {
    const copy = structuredClone(input); change(copy); await assert.rejects(f.proof(copy), denied);
  }
  assert.equal(new Set(Object.values(F3_NAMESPACES)).size, 4);
});

test("capacidade desaparece após sucesso/erro e driver emprestado não autoriza chamadas laterais", async t => {
  const f = fixture(t), input = f.enqueue(), proof = await f.proof(input);
  let borrowed;
  inTransaction(f.db, ctx => {
    assert.throws(() => withModuleExecution(ctx, "erp_module_apply", input.args, proof, () => {
      withOriginOperation(ctx, "title_create", [], [], inner => {
        borrowed = inner;
        assert.throws(() => erpDocumentSave(inner, { p_user_id: f.actor.user_id, p_kind: "service_orders", p_id: null }), denied);
        assert.throws(() => insertDocument(inner, { kind: "service_orders", authority: "brufap" }), denied);
        assert.throws(() => invokeRpc(inner, "erp_finance_execute", { p_user_id: f.actor.user_id, p_command_id: randomUUID(), p_action: "opening", p_data: {} }), denied);
        throw new Error("fall");
      });
    }), /fall/);
    assert.equal(originScope(ctx), undefined); assert.equal(originScope(borrowed), undefined);
    assert.throws(() => financeAccess(borrowed.db, f.actor.user_id, true), denied);
  }, undefined, { identity: input.identity });
});

test("pessoa lança só financeiro preservando autoria; sistema baixa mas não reverte postagem humana", async t => {
  const f = fixture(t), financier = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  const request = f.enqueue({ human: financier, requested: { document: true, stock: false, finance: true } });
  const r = await f.run(request);
  const posting = f.lite.prepare("SELECT actor FROM erp_finance__document_posting").get();
  assert.equal(posting.actor, financier.user_id);
  assert.equal(f.count("erp_stock__document_posting"), 0);
  const received = f.enqueue({ operation: "receive", receipt: f.payment("paid") });
  assert.equal((await f.run(received)).effects.finance, "settled");
  const cancel = f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "work_cancelled" });
  await assert.rejects(f.run(cancel), denied);
  assert.equal(f.count("erp_finance__title"), 1);
});

test("prepare e execute separados com o mesmo marco lançam uma vez; aprovação isolada não lança", async t => {
  const f = fixture(t);
  await f.run(f.enqueue({ operation: "prepare", lifecycle: { base_status: "approved" } }));
  assert.equal(f.count("erp_finance__title"), 0); assert.equal(f.count("erp_stock__document_posting"), 0);
  const executed = f.enqueue({ operation: "execute", lifecycle: { base_status: "in_progress" } });
  assert.equal((await f.run(executed)).effects.finance, "posted");
  assert.equal(f.count("erp_finance__title"), 1);
});

test("serviço livre não exige depósito; recusa e retirada não geram dívida nem estoque", async t => {
  const f = fixture(t);
  const input = f.enqueue({ policy: { ...f.policy, warehouse_id: null }, snapshot: { items: [{ id: randomUUID(), description: "Serviço", quantity: "1", unit_cents: 1000, unit: "UN", kind: "free", product_id: null }] } });
  assert.equal((await f.run(input)).effects.finance, "posted");
  assert.equal(f.count("erp_stock__document_posting"), 0);
  const declined = fixture(t);
  await declined.run(declined.enqueue({ operation: "prepare", lifecycle: { base_status: "quoted", first_execution_at: null } }));
  await declined.run(declined.enqueue({ operation: "lifecycle", lifecycle: { base_status: "declined" } }));
  await declined.run(declined.enqueue({ operation: "lifecycle", lifecycle: { base_status: "ready" } }));
  await declined.run(declined.enqueue({ operation: "lifecycle", lifecycle: { base_status: "delivered", delivered_at: at + 1000 } }));
  assert.equal(declined.count("erp_finance__title"), 0); assert.equal(declined.count("erp_stock__document_posting"), 0);
});

test("automação desligada conserva documento; Financeiro lança depois de pronto, sem relançar estoque", async t => {
  const f = fixture(t), policy = { ...f.policy, auto_post: { stock: true, finance: false } };
  await f.run(f.enqueue({ policy, requested: { document: true, stock: true, finance: false } }));
  await f.run(f.enqueue({ operation: "lifecycle", policy, lifecycle: { base_status: "ready" } }));
  const financier = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  const request = f.enqueue({ operation: "lifecycle", policy, human: financier, requested: { document: true, stock: false, finance: true } });
  assert.equal((await f.run(request)).effects.finance, "posted");
  assert.equal(f.count("erp_stock__document_posting"), 1); assert.equal(f.count("erp_finance__title"), 1);
});

test("autorização, corte histórico, cliente, produto e total continuam sendo obrigatórios", async t => {
  for (const options of [
    { lifecycle: { authorization: null } }, { lifecycle: { quote_version: null } },
    { lifecycle: { first_execution_at: at - 10000, authorized_at: at - 10001 } },
    { snapshot: { contact_id: null } }, { snapshot: { total_cents: 1100 } },
    { snapshot: { items: [{ id: randomUUID(), product_id: randomUUID(), kind: "material", quantity: "1", unit: "UN", unit_cents: 1000, description: "Item" }] } },
  ]) {
    const f = fixture(t); await assert.rejects(f.run(f.enqueue(options)));
    assert.equal(f.count("erp_documents__document"), 0); assert.equal(f.count("erp_finance__title"), 0);
  }
});

test("saldo insuficiente e versão divergente mantêm rollback e não adiantam recibo", async t => {
  const f = fixture(t);
  f.lite.prepare("UPDATE erp_stock__balance SET quantity=0").run();
  await assert.rejects(f.run(f.enqueue()));
  assert.equal(f.count("erp_documents__document"), 0); assert.equal(f.count("erp_finance__title"), 0);
  const g = fixture(t), r = await g.run(g.enqueue());
  g.lite.prepare("UPDATE erp_documents__document SET version=version+1 WHERE id=?").run(r.links.find(l => l.kind === "document").id);
  await assert.rejects(g.run(g.enqueue({ operation: "lifecycle", lifecycle: { base_status: "ready" } })), /module_version_conflict/);
});

test("baixa ativa bloqueia cancelamento conjunto; recebimento excedente não liquida parcialmente", async t => {
  const f = fixture(t);
  await f.run(f.enqueue());
  await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid") }));
  await assert.rejects(f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "work_cancelled" })), /reverse_blocked/);
  assert.equal(f.lite.prepare("SELECT state FROM erp_stock__document_posting").get().state, "active");
  const g = fixture(t); await g.run(g.enqueue());
  await assert.rejects(g.run(g.enqueue({ operation: "receive", receipt: g.payment("excess", "receive", null, 1100) })), /module_receipt_excess/);
  assert.equal(g.count("erp_finance__settlement"), 0);
});

test("tabela A5: nenhum escopo libera pagar, alterar título, conta, transferência, conciliação ou preferência", async t => {
  const f = fixture(t, "agenda"), initial = await f.run(f.enqueue({ requested: { document: false, stock: false, finance: true } }));
  const title = initial.links.find(l => l.kind === "title").id;
  const input = f.enqueue({ operation: "receive", receipt: f.payment("paid") }), proof = await f.proof(input);
  inTransaction(f.db, ctx => withModuleExecution(ctx, "erp_module_apply", input.args, proof, () => {
    withOriginOperation(ctx, "title_settle", [title], [], inner => {
      for (const action of ["title_update", "opening", "account_save", "category_save", "title_create_group", "transfer", "reconcile", "group", "refinance"])
        assert.throws(() => erpFinanceExecute(inner, { p_user_id: f.actor.user_id, p_command_id: randomUUID(), p_action: action, p_data: { id: title } }), denied, action);
      for (const action of ["title_create", "title_edit", "title_delete"])
        assert.throws(() => erpFinanceTitleExecute(inner, { p_user_id: f.actor.user_id, p_command_id: randomUUID(), p_action: action, p_data: { id: title, kind: "payable" } }), denied, action);
      for (const name of ["erp_preferences_page", "erp_catalog_save", "erp_access_security_policy_save", "erp_finance_title_page"])
        assert.throws(() => invokeRpc(inner, name, name === "erp_preferences_page" ? { p_user_id: f.actor.user_id, p_page: "vendas-vendas" } : {}));
    });
  }), undefined, { identity: input.identity });
});

test("source_reference igual não cria propriedade e alvo preexistente não é adotado", async t => {
  const f = fixture(t, "agenda");
  const foreign = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind: "receivable", contact_id: f.contact.id, category_id: f.category.id, description: "Obrigação humana", source_reference: f.source.source_id,
    issued_on: "2026-11-18", total_cents: "1000", installments: [{ amount_cents: "1000", due_on: "2026-11-18" }],
  } }).items[0].id;
  assert.equal(targetOrigin(f.db, "title", foreign), null);
  const input = f.enqueue(), proof = await f.proof(input);
  inTransaction(f.db, ctx => withModuleExecution(ctx, "erp_module_apply", input.args, proof, () => {
    assert.throws(() => withOriginOperation(ctx, "title_settle", [foreign], [], () => null), denied);
  }), undefined, { identity: input.identity });
  const result = await f.run(input);
  assert.notEqual(result.links.find(l => l.kind === "title").id, foreign);
});

test("escopo verifica autoria da baixa e do lançamento antes de reverter", async t => {
  const f = fixture(t); await f.run(f.enqueue());
  const receipt = f.payment("human_paid"), financier = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  await f.run(f.enqueue({ human: financier, operation: "receive", receipt, requested: { document: false, stock: false, finance: true } }));
  await assert.rejects(f.run(f.enqueue({ operation: "reverse", receipt: f.payment("human_reverse", "reverse", "human_paid"), reason: "payment_void" })), denied);
  assert.equal(f.count("erp_finance__settlement"), 1);
});

test("mesma evidência financeira em novo evento não duplica baixa; corpo divergente falha no transporte", async t => {
  const f = fixture(t); await f.run(f.enqueue());
  const receipt = f.payment("paid");
  await f.run(f.enqueue({ operation: "receive", receipt }));
  await f.run(f.enqueue({ operation: "receive", receipt }));
  assert.equal(f.count("erp_finance__settlement"), 1);
  const tampered = f.enqueue({ operation: "receive", receipt: { ...receipt, amount_cents: 999 } });
  await assert.rejects(f.run(tampered), denied);
});

test("close_only encerra pedido sem cliente/padrões e jamais vira aplicação", async t => {
  const f = fixture(t), input = f.enqueue({ closeOnly: true, snapshot: { contact_id: null } });
  assert.deepEqual(await f.run(input, {}, "erp_module_origin_get"), { receipt: null });
  input.args.p_reason_code = "epoch_closed";
  assert.equal((await f.run(input, {}, "erp_module_command_close")).outcome, "closed");
  delete input.args.p_reason_code;
  await assert.rejects(f.run(input), denied);
  assert.equal(f.count("erp_documents__document"), 0);
});

test("projeção sensível inválida não deixa documento, auditoria ou recibo comercial", async t => {
  const f = fixture(t), input = f.enqueue({ snapshot: { privacy: "adult_payer_only", description: "Texto clínico privado" } });
  await assert.rejects(f.run(input), /module_commercial_invalid/);
  assert.equal(f.count("erp_documents__document"), 0); assert.equal(f.count("erp_documents__audit"), 0);
  assert.equal(f.count("erp_documents__command"), 0);
});

test("backup e restauração preservam âncoras, recibos e replay", async t => {
  const f = fixture(t), input = f.enqueue(), result = await f.run(input);
  const storage = { sql: { exec(sql, ...params) {
    const stmt = f.lite.prepare(sql);
    const rows = /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
    return { toArray: () => rows, raw: () => rows.map(row => Object.values(row)) };
  } }, transactionSync: fn => f.db.transaction(fn) };
  const dump = dumpAll(storage);
  const file = dump.files.find(f => f.table === "erp_documents__command");
  assert.ok(file.body.includes("wabotia-module-origin-v1"));
  restoreAll(storage, dump.manifest, new Map(dump.files.map(f => [f.table, f.body])));
  assert.deepEqual(await f.run(input), { ...result, replayed: true });
  assert.ok(originAnchor(f.db, f.source, "document"));
});

test("lançamento e cancelamento humanos ficam restritos ao destino solicitado", async t => {
  for (const destination of ["stock", "finance"]) {
    const f = fixture(t), person = { ...human, user_id: randomUUID(), erp_role: destination === "stock" ? "estoque" : "financeiro" };
    await f.run(f.enqueue());
    const cancelled = await f.run(f.enqueue({ human: person, operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "work_cancelled",
      requested: { document: true, stock: destination === "stock", finance: destination === "finance" } }));
    assert.equal(cancelled.effects[destination], "reversed");
    assert.equal(f.lite.prepare(`SELECT state FROM erp_${destination === "stock" ? "finance" : "stock"}__document_posting`).get().state, "active");
    const g = fixture(t);
    await assert.rejects(g.run(g.enqueue({ human: person, requested: { document: true, stock: true, finance: true } })), /module_manual_denied/);
    assert.equal(g.count("erp_documents__document"), 0);
  }
  const f = fixture(t);
  await assert.rejects(f.run(f.enqueue({ human: { ...human, verified_factor: false, aal: "aal1" }, requested: { document: true, stock: false, finance: true } })), /mfa/);
});

test("cobrança bancária mantém o bloqueio de reversão e o estoque ativo", async t => {
  const f = fixture(t), result = await f.run(f.enqueue());
  const profile = randomUUID(), remittance = randomUUID(), title = result.links.find(l => l.kind === "title").id;
  // Cobrança existente é uma dependência externa ao executor; sem desativar FKs.
  f.lite.prepare("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,'{}','{}','f3-billing',1,0,0)").run(profile, f.account.id);
  f.lite.prepare("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,snapshot,actor,created_at) VALUES(?,?,1,'2026-11-18','{}',?,0)").run(remittance, profile, ADMIN);
  f.lite.prepare("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,snapshot) VALUES(?,?,?,?,'f3-control','f3-document','{}')").run(randomUUID(), title, profile, remittance);
  await assert.rejects(f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "work_cancelled" })), /reverse_blocked/);
  assert.equal(f.lite.prepare("SELECT state FROM erp_stock__document_posting").get().state, "active");
  assert.equal(f.lite.prepare("SELECT cancelled FROM erp_finance__title").get().cancelled, 0);
});

function endpoint(f) {
  const values = new Map();
  const storage = {
    get: async key => values.get(key),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    transaction: async fn => fn(storage),
    transactionSync: fn => f.db.transaction(fn),
    sql: { exec(sql, ...params) {
      const result = f.db.exec(sql, ...params);
      return { ...result, toArray: () => result.rows };
    } },
  };
  const state = { storage };
  return (name, args, identity = { actor: human, people: [human] }) => handleRpc(state, f.source.profile, name,
    new Request("https://erp.invalid/", { method: "POST", headers: {
      "Content-Type": "application/json", [GATE_HEADER]: "1", [SYSTEM_HEADER]: "1",
      [IDENTITY_HEADER]: encodeIdentity({ ...identity, parts: normalizeErpParts(),
        partsControl: { profile: f.source.profile, revision: "1", expires_at: Date.now() + 360_000 } }),
    }, body: canonical(args) }), undefined, f.d1);
}

test("transporte conserva HTTP 400 dos erros humanos comuns fora de F3", async t => {
  const f = fixture(t), request = endpoint(f);
  const seller = { ...human, user_id: randomUUID(), erp_role: "vendas" };
  const deniedResponse = await request("erp_finance_execute", { p_user_id: seller.user_id,
    p_command_id: randomUUID(), p_action: "title_create_group", p_data: {} }, { actor: seller, people: [seller] });
  assert.equal(deniedResponse.status, 400);
  assert.deepEqual(await deniedResponse.json(), { code: "42501", message: "erp_finance_access_denied", details: null, hint: null });

  const args = { p_user_id: ADMIN, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-11-18", contact_id: f.contact.id,
      items: [{ description: "Serviço", unit: "UN", quantity: "1", unit_price: "10" }] } };
  const document = f.rpc("erp_document_save", args).document;
  const conflict = await request("erp_document_save", { ...args, p_command_id: randomUUID(), p_id: document.id,
    p_expected_version: document.version + 1 });
  assert.equal(conflict.status, 400);
  assert.deepEqual(await conflict.json(), { code: "40001", message: "erp_document_version_conflict", details: null, hint: null });
  assert.equal(f.count("erp_documents__document"), 1);
});

test("transporte F3 conserva HTTP 403/409 e não grava em recusa ou conflito", async t => {
  const f = fixture(t), request = endpoint(f), input = f.enqueue();
  const forged = await request("erp_module_apply", { ...input.args, p_request: { ...input.request, actor_id: ADMIN } }, input.identity);
  assert.equal(forged.status, 403);
  assert.equal((await forged.json()).message, "module_origin_denied");
  assert.equal(f.count("erp_documents__command"), 0);
  const applied = await request("erp_module_apply", input.args, input.identity);
  assert.equal(applied.status, 200);
  const receipt = await applied.json();
  assert.deepEqual(receipt.effects, { stock: "posted", finance: "posted" });
  const replay = await request("erp_module_apply", input.args, input.identity);
  assert.deepEqual(await replay.json(), { ...receipt, replayed: true });
  f.enqueue(); // A sequência 2 existe no D1, mas ainda não tem recibo no ERP.
  const later = f.enqueue(), commands = f.count("erp_documents__command");
  const conflict = await request("erp_module_apply", later.args, later.identity);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).message, "module_sequence_conflict");
  assert.equal(f.count("erp_documents__command"), commands);
  assert.equal(f.count("erp_documents__document"), 1);
  assert.equal(f.count("erp_finance__title"), 1);
});

test("transporte exige trabalho com OS ligada e conserva criação humana com OS desligada", async t => {
  const f = fixture(t), request = endpoint(f);
  const args = { p_user_id: ADMIN, p_kind: "service_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-11-18", contact_id: f.contact.id,
      items: [{ description: "Serviço", unit: "UN", quantity: "1", unit_price: "10", group: "service" }] } };
  f.local.prepare("INSERT INTO profile_modules VALUES(?,'os',1)").run(f.source.profile);
  const blocked = await request("erp_document_save", args);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "work_required");
  assert.equal(f.count("erp_documents__document"), 0);
  assert.equal(f.count("erp_documents__command"), 0);

  f.local.prepare("UPDATE profile_modules SET enabled=0 WHERE module_id='os'").run();
  const allowed = await request("erp_document_save", args);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).document.kind, "service_orders");
  assert.equal(f.count("erp_documents__document"), 1);
});
