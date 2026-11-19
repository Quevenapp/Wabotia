import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { canonical, commandId, eventKey, hash, F3_NAMESPACES, uuid5 } from "../../../src/integrations/keys.ts";
import { commercialHash } from "../../../src/erp/domains/documents/module-policy.ts";
import { verifyModuleTransport, moduleSystemUser, targetOrigin } from "../../../src/erp/engine/module-origin.ts";
import { documentCopyResponse, parseDocumentCopyRoute } from "../../../src/erp/fagoo/workers/erp-api/src/document-copy.mjs";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const human = { user_id: ADMIN, erp_role: "admin", name: "Pessoa", email: null, is_agent: false, verified_factor: true, session_id: "22222222-2222-4222-8222-222222222222", aal: "aal2" };
const at = Date.UTC(2026, 10, 18, 15);

test("cancelamento usa efeitos históricos mesmo com automação e destinos desligados", async t => {
  for (const module of ["os", "pedido", "mensalidade"]) {
    const f = fixture(t, module);
    await f.run(f.enqueue());
    const input = f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled",
      requested: { document: false, stock: false, finance: false }, policy: { ...f.policy, auto_post: { stock: false, finance: false } } });
    const result = await f.run(input);
    assert.equal(result.effects.finance, "reversed");
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title WHERE cancelled=0").get().n, 0);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_stock__document_posting WHERE state='active'").get().n, 0);
    assert.deepEqual(await f.run(input), { ...result, replayed: true });
  }
});

test("baixa ativa impede confirmar cancelamento mesmo se o chamador omitir estornos", async t => {
  const f = fixture(t); await f.run(f.enqueue());
  await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid") }));
  const before = f.lite.prepare("SELECT * FROM erp_documents__document").get(), count = f.count("erp_documents__command");
  await assert.rejects(f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled",
    requested: { document: true, stock: false, finance: false } })), /reverse_blocked/);
  assert.deepEqual(f.lite.prepare("SELECT * FROM erp_documents__document").get(), before);
  assert.equal(f.count("erp_documents__command"), count);
});

test("título direto de módulo recusa edições, exclusão, cancelamento e baixa genéricos", async t => {
  const f = fixture(t, "mensalidade"), r = await f.run(f.enqueue());
  const id = r.links.find(l => l.kind === "title").id;
  const before = f.lite.prepare("SELECT * FROM erp_finance__title WHERE id=?").get(id);
  const other = f.rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Outro", person_type: "J", roles: ["customer"] } }).record;
  for (const data of [{ amount_cents: "1" }, { contact_id: other.id }, { due_on: "2026-12-18" }, { description: "Alterada" }])
    assert.throws(() => f.rpc("erp_finance_title_execute", { p_command_id: randomUUID(), p_action: "title_edit", p_data: { id, expected_version: 1, ...data } }), /module_title_read_only/);
  for (const [rpc, action, data] of [
    ["erp_finance_title_execute", "title_delete", {}], ["erp_finance_execute", "title_cancel", { note: "Cancelamento" }],
    ["erp_finance_execute", "title_update", { due_on: "2026-12-18" }],
    ["erp_finance_execute", "settle", { account_id: f.account.id, posted_on: "2026-11-18", principal_cents: "1000" }],
  ]) assert.throws(() => f.rpc(rpc, { p_command_id: randomUUID(), p_action: action, p_data: { id, expected_version: 1, ...data } }), /module_title_read_only/);
  assert.deepEqual(f.lite.prepare("SELECT * FROM erp_finance__title WHERE id=?").get(id), before);
  assert.equal(f.count("erp_finance__settlement"), 0);
  const financier = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  assert.equal((await f.run(f.enqueue({ operation: "receive", human: financier, receipt: f.payment("manual"), requested: { document: false, stock: false, finance: true } }))).effects.finance, "settled");
});

test("faturamento agrupado recusa IDs de documentos de módulo aninhados", async t => {
  const f = fixture(t, "pedido"), result = await f.run(f.enqueue({ requested: { document: true, stock: false, finance: false } }));
  const id = result.links.find(l => l.kind === "document").id;
  assert.throws(() => f.rpc("erp_finance_grouped_billing_execute", { p_command_id: randomUUID(), p_action: "grouped_billing_generate", p_data: {
    category_id: f.category.id, items: [{ contact_id: f.contact.id, document_ids: [id], invoice_ids: [], days: [0], total_cents: "1000", condition: "À vista" }],
  } }), /module_document_read_only/);
  assert.equal(f.count("erp_finance__title"), 0); assert.equal(f.count("erp_finance__grouped_billing"), 0);
});

test("manutenção resolve contato vinculado e recusa substituição", async t => {
  for (const module of ["pedido", "mensalidade"]) {
    const f = fixture(t, module); await f.run(f.enqueue({ snapshot: { contact_id: null }, preparedSnapshot: { contact_id: f.contact.id } }));
    const cancel = f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled" });
    assert.equal((await f.run(cancel)).effects.finance, "reversed");
    assert.equal(f.lite.prepare("SELECT contact_id FROM erp_finance__title").get().contact_id, f.contact.id);
    const g = fixture(t, module); await g.run(g.enqueue());
    await assert.rejects(g.run(g.enqueue({ operation: "cancel", reason: "source_cancelled", lifecycle: { base_status: "cancelled" }, preparedSnapshot: { contact_id: randomUUID() } })), /module_commercial_invalid/);
    assert.equal(g.lite.prepare("SELECT cancelled FROM erp_finance__title").get().cancelled, 0);
  }
});

test("eventos operacionais da venda preservam estado comercial e versão", async t => {
  const f = fixture(t, "pedido"); await f.run(f.enqueue());
  const before = f.lite.prepare("SELECT status,version FROM erp_documents__document").get();
  for (const base_status of ["preparing", "ready", "delivered"])
    await f.run(f.enqueue({ operation: "lifecycle", lifecycle: { base_status } }));
  assert.deepEqual(f.lite.prepare("SELECT status,version FROM erp_documents__document").get(), before);
});

test("depósito e padrões novos só afetam componentes novos", async t => {
  for (const module of ["mensalidade", "pedido"]) {
    const f = fixture(t, module); await f.run(f.enqueue());
    const policy = { ...f.policy, warehouse_id: randomUUID(), revenue_category_id: randomUUID(), payment_method_id: randomUUID() };
    assert.equal((await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid"), policy }))).effects.finance, "settled");
    assert.equal(f.lite.prepare("SELECT account_id FROM erp_finance__settlement").get().account_id, f.account.id);
  }
});

test("ajuste e lotes não alteram movimentos de módulo", async t => {
  const f = fixture(t); await f.run(f.enqueue());
  const movement = f.lite.prepare("SELECT movement_id FROM erp_stock__document_posting").get().movement_id;
  assert.throws(() => f.rpc("erp_stock_movement_amend", { p_command_id: randomUUID(), p_movement_id: movement, p_product_id: f.product.id,
    p_expected_revision: 0, p_unit_price: "1", p_unit_cost: null, p_note: "Ajuste" }), /module_document_read_only/);
  assert.throws(() => f.rpc("erp_stock_movement_lots_assign", { p_command_id: randomUUID(), p_movement_id: movement, p_product_id: f.product.id,
    p_warehouse_id: f.warehouse.id, p_expected_lots: 0, p_lots: [{ lot_id: randomUUID(), quantity: "1" }] }), /module_document_read_only/);
  assert.equal(f.count("erp_stock__movement_detail"), 0);
});

test("reversão de pagamento com contato nulo ignora automação, destinos e depósito atuais", async t => {
  const f = fixture(t, "pedido"); await f.run(f.enqueue());
  await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid") }));
  const input = f.enqueue({ operation: "reverse", receipt: f.payment("refunded", "reverse", "paid"), reason: "payment_void",
    snapshot: { contact_id: null }, requested: { document: false, stock: false, finance: false },
    policy: { ...f.policy, warehouse_id: randomUUID(), auto_post: { stock: false, finance: false } } });
  const result = await f.run(input, { stock: false, finance: false });
  assert.equal(result.effects.finance, "reversed");
  assert.equal(f.lite.prepare("SELECT settled_cents FROM erp_finance__title").get().settled_cents, 0);
  assert.deepEqual(await f.run(input), { ...result, replayed: true });
  assert.equal(f.count("erp_finance__settlement"), 2);
});

test("mudança de etapa com contato nulo usa o documento e mantém a venda em andamento", async t => {
  const f = fixture(t, "pedido"); await f.run(f.enqueue());
  await f.run(f.enqueue({ operation: "lifecycle", lifecycle: { base_status: "preparing" }, snapshot: { contact_id: null } }));
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status, "in_progress");
});

test("boleto bloqueia cancelamento automático desligado e conserva estoque e recibos", async t => {
  const f = fixture(t), result = await f.run(f.enqueue());
  const profile = randomUUID(), remittance = randomUUID(), title = result.links.find(l => l.kind === "title").id;
  f.lite.prepare("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,'{}','{}','test',1,0,0)").run(profile, f.account.id);
  f.lite.prepare("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,snapshot,actor,created_at) VALUES(?,?,1,'2026-11-18','{}',?,0)").run(remittance, profile, ADMIN);
  f.lite.prepare("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,snapshot) VALUES(?,?,?,?,'control','document','{}')").run(randomUUID(), title, profile, remittance);
  const commands = f.count("erp_documents__command");
  await assert.rejects(f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled",
    requested: { document: true, stock: false, finance: false }, policy: { ...f.policy, auto_post: { stock: false, finance: false } } })), /reverse_blocked/);
  assert.equal(f.lite.prepare("SELECT state FROM erp_stock__document_posting").get().state, "active");
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status, "in_progress");
  assert.equal(f.count("erp_documents__command"), commands);
});

test("estorno humano de um destino deixa o cancelamento pendente até reverter o restante", async t => {
  const f = fixture(t); await f.run(f.enqueue());
  const financier = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  const input = f.enqueue({ operation: "cancel", human: financier, lifecycle: { base_status: "cancelled" }, reason: "source_cancelled",
    requested: { document: true, stock: false, finance: true } });
  const partial = await f.run(input);
  assert.equal(partial.outcome, "skipped"); assert.equal(partial.reason_code, "module_cancellation_pending");
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status, "in_progress");
  assert.deepEqual(await f.run(input), { ...partial, replayed: true });
  const done = await f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled" }));
  assert.equal(done.outcome, "applied"); assert.equal(done.effects.stock, "reversed");
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status, "cancelled");
});

test("hash de título não depende de depósito e recibos antigos usam os parâmetros gravados", async t => {
  for (const module of ["mensalidade", "pedido"]) {
    const f = fixture(t, module), input = f.enqueue(); await f.run(input);
    if (module === "mensalidade") assert.equal(commercialHash(input.request.body), commercialHash({ ...input.request.body, policy: { ...f.policy, warehouse_id: randomUUID() } }));
    const row = f.lite.prepare("SELECT result FROM erp_documents__command WHERE command_id=?").get(input.request.command_id);
    const legacy = JSON.parse(row.result), state = legacy.components.main, s = state.snapshot;
    delete state.parameters;
    state.commercial_hash = hash({ contact_id: s.contact_id, items: s.items, total: s.total_cents, freight: s.freight_cents, discount: s.discount_cents,
      installments: s.installments, issued_on: s.issued_on, warehouse: f.policy.warehouse_id, description: s.description, technical: s.technical });
    f.lite.prepare("UPDATE erp_documents__command SET result=? WHERE command_id=?").run(canonical(legacy), input.request.command_id);
    assert.equal((await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid"), policy: { ...f.policy, warehouse_id: randomUUID() } }))).effects.finance, "settled");
  }
});

test("consulta de origem usa PK com histórico de 50 mil comandos, inclusive ausência", async t => {
  const f = fixture(t), r = await f.run(f.enqueue()), id = r.links.find(l => l.kind === "document").id;
  const insert = f.lite.prepare("INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,'{}',0)");
  f.db.transaction(() => { for (let i = 0; i < 50000; i++) insert.run(randomUUID(), ADMIN, "0".repeat(64)); });
  const queries = [], indexed = { originProfile: f.source.profile, transaction: f.db.transaction, exec(sql, ...params) {
    queries.push({ sql, params }); return f.db.exec(sql, ...params);
  } };
  assert.equal(targetOrigin(indexed, "document", id).target.id, id);
  assert.equal(targetOrigin(indexed, "document", randomUUID()), null);
  for (const { sql, params } of queries) {
    assert.doesNotMatch(sql, /json_extract/);
    const plan = f.lite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(" ");
    assert.match(plan, /SEARCH.*USING INDEX/); assert.doesNotMatch(plan, /SCAN/);
  }
  // Sem envelope/área, a defesa legada segue encontrando a origem.
  assert.equal(targetOrigin(f.db, "document", id).target.id, id);
  const absent = randomUUID(), average = db => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) assert.equal(targetOrigin(db, "document", absent), null);
    return ((performance.now() - start) / 20).toFixed(3);
  };
  t.diagnostic(`50 mil comandos: ausência por PK ${average({ ...f.db, originProfile: f.source.profile })} ms/busca; fallback sem área (SCAN) ${average(f.db)} ms/busca. Medição Node, sem teto temporal no teste.`);
  const reverse = uuid5(F3_NAMESPACES.reverse_origin, canonical([f.source.profile, "document", id]));
  f.lite.prepare("DELETE FROM erp_documents__command WHERE command_id=?").run(reverse);
  assert.throws(() => targetOrigin(f.db, "document", id), /module_origin_denied/);
});

for (const destination of ["finance", "stock"]) test(`nota vinculada não contorna a origem do módulo em ${destination}`, async t => {
  const f = fixture(t, "pedido"), r = await f.run(f.enqueue({ requested: { document: true, stock: false, finance: false } }));
  const id = randomUUID(), document = r.links.find(l => l.kind === "document").id;
  f.lite.prepare(`INSERT INTO erp_fiscal_invoices__invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,updated_at)
    VALUES(?,'55','1','T',NULL,1,1,42,'Operação','2026-11-18','1','1','0',0,?,'[]','{}',?,'[]','{}',0,0,0,0,0,'{"total":10}',1,?,?,0,0)`)
    .run(id, JSON.stringify({ name: "Cliente", contact_id: f.contact.id }), JSON.stringify({ installments: [{ date: "2026-11-18", amount: "10", method: "15" }] }), ADMIN, ADMIN);
  f.lite.prepare(`INSERT INTO erp_fiscal_invoices__invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
    VALUES(?,1,?,10000,'10',1000,0,0,0,0,?)`).run(id, f.product.id, JSON.stringify({ description: "Material", unit: "UN" }));
  f.lite.prepare("INSERT INTO erp_fiscal_invoices__invoice_order(invoice_id,document_id) VALUES(?,?)").run(id, document);
  if (destination === "finance") {
    const data = { invoice_id: id, expected_version: 1, category_id: f.category.id, account_id: null };
    const preview = f.rpc("erp_finance_invoice_finance_preview", { p_invoice_id: id, p_expected_version: 1, p_category_id: f.category.id, p_account_id: null }).preview;
    assert.throws(() => f.rpc("erp_finance_invoice_finance_post", { p_command_id: randomUUID(), p_data: { ...data, preview_hash: preview.preview_hash } }), /module_document_read_only/);
  } else {
    const args = { p_invoice_id: id, p_expected_version: 1, p_warehouse_id: f.warehouse.id };
    const preview = f.rpc("erp_stock_invoice_preview", args).preview;
    assert.throws(() => f.rpc("erp_stock_invoice_post", { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash }), /module_document_read_only/);
  }
  assert.equal(f.count("erp_finance__title"), 0);
  assert.equal(f.count("erp_stock__invoice_posting"), 0);
});

test("borderô, reclassificação e estorno genéricos não mudam títulos e baixas de módulo", async t => {
  const f = fixture(t, "mensalidade"), r = await f.run(f.enqueue()), id = r.links.find(l => l.kind === "title").id;
  const target = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Outra receita" } }).record;
  assert.throws(() => f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_move",
    p_data: { id: f.category.id, expected_version: 1, target_id: target.id, confirmed: true } }), /module_title_read_only/);
  assert.throws(() => f.rpc("erp_finance_bordero_execute", { p_command_id: randomUUID(), p_action: "settle_batch", p_data: {
    kind: "receivable", grouped: false, note: "Recebimento", items: [{ id, expected_version: 1, account_id: f.account.id, category_id: null,
      posted_on: "2026-11-18", principal_cents: "1000", interest_cents: "0", penalty_cents: "0", discount_cents: "0", fee_cents: "0" }],
  } }), /module_title_read_only/);
  assert.equal(f.count("erp_finance__settlement"), 0); assert.equal(f.count("erp_finance__bordero"), 0);
  await f.run(f.enqueue({ operation: "receive", receipt: f.payment("paid") }));
  const settlement = f.lite.prepare("SELECT id FROM erp_finance__settlement").get().id;
  const movement = f.lite.prepare("SELECT id FROM erp_finance__movement WHERE settlement_id=?").get(settlement).id;
  assert.throws(() => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "reverse", p_data: {
    id, expected_version: 2, settlement_id: settlement, posted_on: "2026-11-18", note: "Estorno",
  } }), /module_title_read_only/);
  assert.throws(() => f.rpc("erp_finance_cash_execute", { p_command_id: randomUUID(), p_action: "line_categorize", p_data: {
    line_kind: "settlement", line_id: movement, expected_category_id: f.category.id, category_id: target.id,
  } }), /module_title_read_only/);
  assert.equal(f.lite.prepare("SELECT settled_cents FROM erp_finance__title").get().settled_cents, 1000);
  assert.equal(f.count("erp_finance__settlement"), 1);
});

test("duas entregas concorrentes do mesmo comando lançam e estornam uma vez", async t => {
  const f = fixture(t), input = f.enqueue();
  const receipts = await Promise.all([f.run(input), f.run(input)]);
  assert.equal(receipts.filter(r => !r.replayed).length, 1);
  assert.equal(f.count("erp_finance__title"), 1); assert.equal(f.count("erp_stock__document_posting"), 1);
  const cancellation = f.enqueue({ operation: "cancel", reason: "source_cancelled", lifecycle: { base_status: "cancelled" },
    requested: { document: false, stock: false, finance: false } });
  const reversals = await Promise.all([f.run(cancellation), f.run(cancellation)]);
  assert.equal(reversals.filter(r => !r.replayed).length, 1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_stock__movement WHERE kind='reversal'").get().n, 1);
  assert.equal(f.lite.prepare("SELECT quantity FROM erp_stock__balance").get().quantity, 100000000);
});

test("faturamento histórico sem âncora impede confirmar cancelamento da venda", async t => {
  const f = fixture(t, "pedido"), result = await f.run(f.enqueue({ requested: { document: true, stock: false, finance: false } }));
  const document = result.links.find(l => l.kind === "document").id, billing = randomUUID();
  const title = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind: "receivable", contact_id: f.contact.id, category_id: f.category.id, description: "Venda", issued_on: "2026-11-18",
    total_cents: "1000", installments: [{ amount_cents: "1000", due_on: "2026-11-18" }],
  } }).items[0].id;
  // Estado persistido pela abertura antiga de grouped_billing_generate (achado 5).
  f.lite.prepare(`INSERT INTO erp_finance__grouped_billing(id,number,contact_id,issued_on,condition,total_cents,state,version,actor,command_id,created_at)
    VALUES(?,1,?,'2026-11-18','À vista',1000,'active',1,?,?,0)`).run(billing, f.contact.id, ADMIN, randomUUID());
  f.lite.prepare("INSERT INTO erp_finance__grouped_billing_document(billing_id,document_id,total_cents,active) VALUES(?,?,1000,1)").run(billing, document);
  f.lite.prepare("INSERT INTO erp_finance__grouped_billing_title(title_id,billing_id,position) VALUES(?,?,1)").run(title, billing);
  await assert.rejects(f.run(f.enqueue({ operation: "cancel", lifecycle: { base_status: "cancelled" }, reason: "source_cancelled" })), /module_cancellation_blocked/);
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status, "in_progress");
  assert.equal(f.lite.prepare("SELECT cancelled FROM erp_finance__title WHERE id=?").get(title).cancelled, 0);
});

test("padrões financeiros ausentes podem ser definidos antes do primeiro lançamento", async t => {
  const f = fixture(t);
  await f.run(f.enqueue({ operation: "prepare", lifecycle: { base_status: "approved" },
    policy: { ...f.policy, revenue_category_id: null, auto_post: { stock: true, finance: false } },
    requested: { document: true, stock: false, finance: false } }));
  assert.equal((await f.run(f.enqueue({ operation: "execute", lifecycle: { base_status: "in_progress" } }))).effects.finance, "posted");
  assert.equal(f.lite.prepare("SELECT category_id FROM erp_finance__title").get().category_id, f.category.id);
});

test("prévia de cópia omite partes desligadas e seu corpo continua aceito pelo salvamento", async t => {
  const f = fixture(t);
  const source = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: "2026-11-18", contact_id: f.contact.id, warehouse_id: f.warehouse.id, category_id: f.category.id, payment_account_id: f.account.id,
    items: [{ product_id: f.product.id, description: "Material", unit: "UN", quantity: "1", unit_price: "10" }],
  } }).document;
  const args = { p_kind: source.kind, p_source_id: source.id };
  const url = `https://erp.invalid/v1/duplicacao-documentos/${source.kind}/${source.id}`;
  const previewRoute = await parseDocumentCopyRoute(new Request(`${url}/preview`));
  const full = f.rpc("erp_document_copy_preview", args).data;
  for (const key of ["warehouse_id", "category_id", "payment_account_id"]) assert.equal(full[key], source[key]);
  const original = f.lite.prepare("SELECT * FROM erp_documents__document WHERE id=?").get(source.id);
  for (const parts of [{ stock: false }, { finance: false }, { stock: false, finance: false }]) {
    const commands = f.count("erp_documents__command");
    const preview = f.rpc("erp_document_copy_preview", args, { parts });
    const parsed = documentCopyResponse(preview, previewRoute);
    assert.equal(f.count("erp_documents__command"), commands);
    assert.deepEqual(f.lite.prepare("SELECT * FROM erp_documents__document WHERE id=?").get(source.id), original);
    const hidden = [...(parts.stock === false ? ["warehouse_id"] : []), ...(parts.finance === false ? ["category_id", "payment_account_id"] : [])];
    for (const value of [preview, parsed]) {
      for (const key of hidden) assert.equal(Object.hasOwn(value.data, key), false, key);
      assert.equal(Object.hasOwn(value.data, "unavailable_parts"), false);
    }
    const copyRoute = await parseDocumentCopyRoute(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: randomUUID(), expected_source_version: source.version, data: parsed.data }) }));
    const copy = f.rpc(copyRoute.rpc, copyRoute.args, { parts });
    for (const value of [copy, documentCopyResponse(copy, copyRoute)])
      for (const key of hidden) assert.equal(Object.hasOwn(value.document, key), false, key);
    const stored = JSON.parse(f.lite.prepare("SELECT body FROM erp_documents__document WHERE id=?").get(copy.document.id).body);
    for (const key of hidden) assert.equal(stored[key] ?? null, null, key);
    assert.equal(f.rpc(copyRoute.rpc, copyRoute.args, { parts }).replayed, true);
  }
});

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
        snapshot: { ...snapshot, ...options.preparedSnapshot }, policy: options.policy ?? policy, eligible: event.eligible, requested: options.requested ?? { document: true, stock: true, finance: true }, epochs,
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

