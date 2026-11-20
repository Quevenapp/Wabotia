import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_DATE, COM1_PEOPLE } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { invokeRpc } from "../../../src/erp/engine/registry.ts";
import { runWithCom1Authority } from "../../../src/erp/domains/fiscal/comnfe/access.ts";
import { withCom1Compensation } from "../../../src/erp/domains/fiscal/comnfe/effect-policy.ts";
import { applyEffects, reverseEffects, createCom1EffectHandlers } from "../../../src/erp/domains/fiscal/comnfe/effects.ts";
import {
  COM1_TABLES as T, com1Hash, com1Reference, savePreparation, claimStoredOperation,
  recordExternalEvidence, getStoredEmission, getEffects, getCommand,
  claimStoredCancellation, recordCancellationEvidence,
} from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const connection = com1Hash("cofre-simulado-efeitos");
const error = message => e => e.message === message;
const count = (f, table) => f.db.exec(`SELECT count(*) n FROM ${table}`).rows[0].n;
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];
const current = f => row(f, "SELECT * FROM erp_documents__document WHERE id=?", f.order.id);
const version = f => current(f).version;
const items = f => f.db.exec("SELECT data FROM erp_documents__item WHERE document_id=? ORDER BY position", f.order.id).rows.map(i => JSON.parse(i.data));
const view = (f, id) => f.transaction(ctx => getStoredEmission(ctx, id));
const input = (f, emission, axis, extra = {}) => ({ emission_id: emission.id, command_id: randomUUID(),
  expected_version: view(f, emission.id).version, axis, intent: "apply", ...extra });
const effect = (f, emission, axis, extra = {}, env = {}) => f.rpc("erp_com1_effect_apply", { p_input: input(f, emission, axis, extra) }, env);
const reverse = (f, emission, axis, extra = {}, env = {}) => f.rpc("erp_com1_effect_reverse", { p_input: input(f, emission, axis, { intent: "reverse", ...extra }) }, env);
const policy = (f, timing = "on_authorization") => {
  const settings = f.rpc("erp_com1_config_get");
  return f.rpc("erp_com1_config_save", { p_input: { command_id: randomUUID(), expected_version: settings.version,
    environment: "homologacao", stock_timing: timing, finance_timing: timing } });
};

function fixture(t, options = {}) {
  const f = com1Fixture(t);
  t.after(installCommercialNfeSlots({ applyEffects, reverseEffects }));
  f.warehouse = f.catalog("warehouses", { name: "Depósito do ensaio" });
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas do ensaio" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa do ensaio", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.orderBody = { ...f.orderBody, warehouse_id: f.warehouse.id, category_id: f.category.id };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_body: f.orderBody }).document;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE,
    p_reason: "Saldo inicial do ensaio", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }] });
  f.order = f.rpc("erp_document_transition", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_status: "verified", p_reason: "Conferência do pedido" }).document;
  if (options.policy) policy(f);
  return f;
}

function prepared(f, changes = {}) {
  const d = current(f), body = JSON.parse(d.body);
  const command = randomUUID();
  return f.transaction(ctx => savePreparation(ctx, {
    command_id: command, args: { document_id: d.id, command_id: command }, document_id: d.id,
    expected_document_version: d.version, environment: "homologacao", connection_fingerprint: connection,
    snapshot: { document: { ...d, body }, items: items(f), company: f.company, recipient: {}, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: {}, commercial_hash: com1Hash(body), source_fingerprint: com1Hash(body),
    body: { ambiente: "homologacao", referencia: com1Reference(d.id, 1), serie: 1, naturezaOperacao: "Venda", emitente: { cnpj: f.company.cnpj },
      destinatario: { cnpj: "19131243000197" }, itens: [{ quantidade: 2, valorUnitario: 25.5 }], pagamentos: [{ forma: "15", valor: 51 }] },
    calculation: { total_cents: "5100" }, blockers: [], ...changes,
  })).emission;
}
function claim(f, emission, changes = {}) {
  return f.transaction(ctx => claimStoredOperation(ctx, { emission_id: emission.id, command_id: randomUUID(), action: "emit",
    expected_version: emission.version, body_revision: emission.current_body_revision, body_hash: emission.revision.body_hash,
    source_fingerprint: emission.revision.source_fingerprint, connection_fingerprint: connection, ...changes }));
}
function result(emission, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: "nfe_efeitos", reference: emission.reference, environment: "homologacao",
    series: "1", number: 1, access_key: "35261111222333000181550010000000011000000010", protocol: "135260000000001",
    nfse_number: null, issued_at: "2026-11-19T12:00:00Z", authorized_at: "2026-11-19T12:00:01Z", total: 51,
    qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true, replayed: false, event_repeated: null, contingency: null, ...changes };
}
function record(f, claimed, output, extra = {}) {
  return f.transaction(ctx => recordExternalEvidence(ctx, { emission_id: claimed.emission.id, command_id: claimed.command.id,
    claim_token: claimed.command.token, connection_fingerprint: connection, result: output, ...extra }));
}
function authorized(f) { const p = prepared(f); return record(f, claim(f, p), result(p)); }
function cancelled(f, emission) {
  const c = f.transaction(ctx => claimStoredCancellation(ctx, { emission_id: emission.id, command_id: randomUUID(),
    expected_version: view(f, emission.id).version, justification: "Cancelamento do ensaio comercial.", connection_fingerprint: connection }));
  return f.transaction(ctx => recordCancellationEvidence(ctx, { emission_id: emission.id, command_id: c.command.id,
    claim_token: c.command.token, connection_fingerprint: connection, state: "registrado", result: result(emission, { status: "cancelled" }),
    event_protocol: "135260000000099", event_at: "1795089660000000" }));
}
function stockArgs(f, warehouse = false) {
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_occurred_on: COM1_DATE,
    p_reason: "Saída da venda", ...(warehouse ? { p_warehouse_id: f.warehouse.id } : {}) };
  const name = warehouse ? "erp_stock_document_warehouse_preview" : "erp_document_stock_preview";
  const preview = f.rpc(name, args).preview;
  return { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: [] };
}
function financeArgs(f) {
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_category_id: null, p_plan: null };
  return { ...args, p_command_id: randomUUID(), p_preview_hash: f.rpc("erp_document_finance_preview", args).preview.preview_hash };
}
function groupedArgs(f) {
  return { p_command_id: randomUUID(), p_action: "grouped_billing_generate", p_data: { category_id: f.category.id, items: [{
    contact_id: f.customer.id, document_ids: [f.order.id], invoice_ids: [], total_cents: "5100", condition: "30 dias", days: [30],
  }] } };
}
function reserve(f) {
  const args = { p_document_id: f.order.id, p_expected_version: version(f), p_action: "reserve", p_reservation_id: null,
    p_reservation_version: null, p_occurred_on: COM1_DATE, p_reason: "Separação da venda" };
  const p = f.rpc("erp_stock_reservation_preview", args).preview;
  return f.rpc("erp_stock_reservation_apply", { ...args, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_ignored_item_ids: [] });
}
function setAutomatic(f) {
  const page = f.rpc("erp_preferences_page", { p_page: "vendas-vendas" });
  const pref = page.items.find(i => i.key === "vendas.contas_automaticas_pedido");
  f.rpc("erp_preferences_save", { p_command_id: randomUUID(), p_page: "vendas-vendas", p_changes: [{ key: pref.key, expected_version: pref.version, value: true }] });
}
function editBody(f) {
  const body = { ...JSON.parse(current(f).body), items: items(f) };
  delete body.totals;
  body.installments = body.installments.map(({ position, ...item }) => item);
  body.items = body.items.map(item => {
    const copy = { ...item };
    for (const key of ["total", "position", "gross", "discount", "product_snapshot"]) delete copy[key];
    return copy;
  });
  return body;
}
function rule(f, from, to, actions) {
  f.db.exec("INSERT OR IGNORE INTO erp_preferences__situation_adoption(kind,migration) VALUES('sales_orders','com1-effects-test')");
  const old = row(f, "SELECT version FROM erp_preferences__transition WHERE kind='sales_orders' AND from_key=? AND to_key=?", from, to);
  f.rpc("erp_preferences_transition_save", { p_command_id: randomUUID(), p_kind: "sales_orders", p_from: from, p_to: to,
    p_expected_version: old?.version ?? 0, p_data: { active: true, actions } });
}
function transition(f, status, env = {}) {
  return f.rpc("erp_document_transition", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_status: status, p_reason: "Transição do ensaio" }, env);
}
function legacyInvoice(f) {
  const id = randomUUID(), at = String(f.clock.next()), user = COM1_PEOPLE.admin.user_id;
  f.db.exec(`INSERT INTO erp_fiscal_invoices__invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,updated_at)
    VALUES(?,'55','1','T',NULL,1,1,42,'Venda',?,'1','1','0',0,?,'[]','{}',?,'[]','{}',0,0,0,0,0,'{"total":51}',1,?,?,?,?)`,
    id, COM1_DATE, JSON.stringify({ name: f.customer.name, contact_id: f.customer.id }), JSON.stringify({ installments: [{ date: "2026-12-19", amount: "51", method: "15" }] }), user, user, at, at);
  f.db.exec(`INSERT INTO erp_fiscal_invoices__invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
    VALUES(?,1,?,20000,'25.5',5100,0,0,0,0,?)`, id, f.product.id, JSON.stringify({ description: "Mercadoria do Ensaio", unit: "UN" }));
  f.db.exec("INSERT INTO erp_fiscal_invoices__invoice_order(invoice_id,document_id) VALUES(?,?)", id, f.order.id);
  return id;
}

test("nota legada vinculada comprova ambos efeitos sem criar segunda origem", t => {
  const f = fixture(t), id = legacyInvoice(f);
  const stock = { p_invoice_id: id, p_expected_version: 1, p_warehouse_id: f.warehouse.id };
  const stockPreview = f.rpc("erp_stock_invoice_preview", stock).preview;
  const stockPost = f.rpc("erp_stock_invoice_post", { ...stock, p_command_id: randomUUID(), p_preview_hash: stockPreview.preview_hash });
  const finance = { p_invoice_id: id, p_expected_version: 1, p_category_id: null, p_account_id: null };
  const financePreview = f.rpc("erp_finance_invoice_finance_preview", finance).preview;
  const financePost = f.rpc("erp_finance_invoice_finance_post", { p_command_id: randomUUID(), p_data: {
    invoice_id: id, expected_version: 1, category_id: null, account_id: null, preview_hash: financePreview.preview_hash,
  } });
  const a = authorized(f);
  for (const [axis, posted] of [["stock", stockPost], ["finance", financePost]]) {
    const recognized = effect(f, a, axis);
    assert.equal(recognized.state, "reconhecido", JSON.stringify(recognized));
    assert.equal(recognized.origin, "legacy_invoice");
    assert.equal(recognized.ids.posting_id, posted.posting.id);
  }
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 1);
  const c = cancelled(f, a);
  for (const axis of ["stock", "finance"]) {
    const reversed = reverse(f, c, axis, { physical_return_confirmed: true }, { parts: { [axis]: false } });
    assert.equal(reversed.compensation_state, "revertido", JSON.stringify(reversed));
  }
  assert.equal(row(f, "SELECT state FROM erp_stock__invoice_posting").state, "reversed");
  assert.equal(row(f, "SELECT state FROM erp_finance__invoice_posting").state, "reversed");
});

test("agrupamento somente pela nota legada não desvia a guarda do pedido", t => {
  const f = fixture(t, { policy: true }), id = legacyInvoice(f);
  const args = groupedArgs(f);
  args.p_data.items[0].document_ids = [];
  args.p_data.items[0].invoice_ids = [id];
  assert.throws(() => f.rpc("erp_finance_grouped_billing_execute", args), /awaiting_fiscal_authorization/);
  assert.equal(count(f, "erp_finance__title"), 0);
});

test("automatismos de transição adiam ambos e não repetem quando a política muda", t => {
  const f = fixture(t, { policy: true });
  rule(f, "verified", "fulfilled", ["post_stock", "post_finance"]);
  const args = { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(),
    p_status: "fulfilled", p_reason: "Atender pedido após separação" };
  const output = f.rpc("erp_document_transition", args);
  assert.deepEqual(output.effects.map(({ action, outcome, reason }) => ({ action, outcome, reason })), [
    { action: "post_stock", outcome: "deferred", reason: "awaiting_fiscal_authorization" },
    { action: "post_finance", outcome: "deferred", reason: "awaiting_fiscal_authorization" },
  ]);
  policy(f, "existing");
  f.rpc("erp_document_transition", args);
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 0);
});

test("guardas comerciais protegem nota enviada mesmo com Fiscal desligada e permitem ajustes locais", t => {
  const f = fixture(t), a = authorized(f), body = editBody(f);
  const save = changed => f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_body: changed });
  assert.throws(() => save({ ...body, items: [{ ...body.items[0], description: "Mercadoria alterada" }] }), error("fiscal_order_commercial_locked"));
  assert.throws(() => transition(f, "cancelled", { parts: { fiscal: false } }), error("fiscal_order_transition_locked"));
  const local = save({ ...body, category_id: null });
  assert.ok(local.document.version > a.revision.source_document_version);
  assert.equal(view(f, a.id).reference, a.reference);
  assert.equal(effect(f, a, "stock").state, "aplicado");
});

test("cancelamento comercial não contorna compensação física após cancelamento fiscal", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "stock"); effect(f, a, "finance");
  cancelled(f, a);
  rule(f, "verified", "cancelled", ["reverse_stock", "reverse_finance"]);
  assert.throws(() => transition(f, "cancelled"), error("fiscal_order_compensation_required"));
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
});

test("existing preserva postagem sem vínculo; autorização bloqueia manual, depósito e agrupamento antes do preparo", t => {
  const f = fixture(t);
  assert.equal(f.rpc("erp_com1_config_get").stock_timing, "existing");
  const args = stockArgs(f);
  const posted = f.rpc("erp_document_stock_post", args);
  assert.ok(posted.posting.id);
  policy(f);
  assert.deepEqual(f.rpc("erp_document_stock_post", args), { ...posted, replayed: true }, "replay anterior precede nova política");
  const g = fixture(t, { policy: true });
  for (const [name, a] of [["erp_document_stock_post", stockArgs(g)], ["erp_stock_document_warehouse_post", stockArgs(g, true)],
    ["erp_document_finance_post", financeArgs(g)], ["erp_finance_grouped_billing_execute", groupedArgs(g)]]) {
    assert.throws(() => g.rpc(name, a), /awaiting_fiscal_authorization/, name);
  }
  assert.equal(count(g, "erp_stock__document_posting"), 0);
  assert.equal(count(g, "erp_finance__title"), 0);
  assert.ok(reserve(g).receipt.reservation.id, "reserva continua disponível");
});

test("Fiscal desligada permite venda sem nota e automatismo da política é adiado", t => {
  const f = fixture(t, { policy: true });
  setAutomatic(f);
  const saved = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(), p_body: f.orderBody });
  assert.ok(JSON.stringify(saved).includes("awaiting_fiscal_authorization"));
  assert.equal(count(f, "erp_finance__title"), 0);
  const posted = f.rpc("erp_document_finance_post", financeArgs(f), { parts: { fiscal: false } });
  assert.ok(posted.posting.id);
});

test("bloqueio fiscal não reivindica cofre nem libera efeitos", t => {
  const f = fixture(t, { policy: true });
  const p = prepared(f, { body: null, blockers: [{ code: "fiscal_product_incomplete", field: "items.0.ncm", message: "Complete o NCM.", correction: { screen: "products" } }] });
  assert.throws(() => claim(f, p), error("com1_preparation_blocked"));
  assert.throws(() => f.rpc("erp_document_finance_post", financeArgs(f)), /awaiting_fiscal_authorization/);
  assert.throws(() => effect(f, p, "stock"), error("com1_effect_requires_authorization"));
  assert.equal(count(f, "erp_stock__document_posting"), 0);
});

test("resposta perdida só libera efeitos após autorização persistida pela mesma referência", t => {
  const f = fixture(t, { policy: true }), p = prepared(f), first = claim(f, p);
  const uncertain = record(f, first, null, { error: { code: "timeout", message: "Resposta perdida" } });
  assert.throws(() => effect(f, uncertain, "stock"), error("com1_effect_requires_authorization"));
  f.clock.advance(120000);
  const resumed = claim(f, uncertain, { action: "resume", expected_version: view(f, p.id).version });
  assert.equal(resumed.command.request.reference, first.command.request.reference);
  assert.equal(resumed.command.request.body_text, first.command.request.body_text);
  const a = record(f, resumed, result(p));
  assert.equal(effect(f, a, "stock").state, "aplicado");
  assert.equal(count(f, T.emission), 1);
});

test("duplo clique, duas abas e versão técnica não duplicam movimentos nem parcelas", t => {
  const f = fixture(t, { policy: true }), a = authorized(f), before = version(f);
  const args = input(f, a, "stock");
  const first = f.rpc("erp_com1_effect_apply", { p_input: args });
  assert.equal(first.state, "aplicado", JSON.stringify(first));
  assert.deepEqual(f.rpc("erp_com1_effect_apply", { p_input: args }), first);
  assert.ok(["aplicado", "reconhecido"].includes(effect(f, a, "stock").state));
  assert.equal(effect(f, a, "finance").state, "aplicado");
  assert.ok(["aplicado", "reconhecido"].includes(effect(f, a, "finance").state));
  assert.equal(count(f, "erp_stock__document_posting"), 1);
  assert.equal(count(f, "erp_stock__movement"), 2, "saldo inicial e uma saída");
  assert.equal(count(f, "erp_finance__document_posting"), 1);
  assert.equal(count(f, "erp_finance__title"), 1);
  assert.equal(version(f), before + 2);
  assert.equal(view(f, a.id).fiscal_version, 1);
  assert.throws(() => f.rpc("erp_com1_effect_apply", { p_input: { ...args, intent: "reconcile" } }), error("fiscal_command_conflict"));
  assert.throws(() => f.rpc("erp_com1_effect_apply", { p_input: args }, { role: "estoque" }), error("fiscal_command_conflict"));
});

test("partes desligadas deixam skip durável; religamento exige intenção e comando novos", t => {
  const f = fixture(t), a = authorized(f);
  for (const axis of ["stock", "finance"]) {
    const skipped = effect(f, a, axis, {}, { parts: { [axis]: false } });
    assert.equal(skipped.state, "pulado");
    assert.equal(skipped.reason, "part_disabled");
    assert.equal(effect(f, a, axis).state, "pulado");
    assert.equal(effect(f, a, axis, { intent: "apply_skipped" }).state, "aplicado");
  }
});

test("pessoa fiscal não ganha papel local; responsáveis retomam e autoria permanece", t => {
  const f = fixture(t), a = authorized(f);
  assert.throws(() => f.rpc("erp_com1_claim", { p_input: { emission_id: a.id, command_id: randomUUID(), expected_version: a.version,
    action: "emit", body_revision: 1, body_hash: "a".repeat(64), connection_fingerprint: connection } }, { role: "vendas" }), error("fiscal_forbidden"));
  const pending = f.transaction(ctx => applyEffects(ctx, input(f, a, "stock")), { role: "fiscal" });
  assert.equal(pending.state, "pendente");
  assert.equal(pending.responsible_role, "estoque");
  const done = effect(f, a, "stock", {}, { role: "estoque" });
  assert.equal(done.state, "aplicado");
  assert.equal(done.person_id, COM1_PEOPLE.estoque.user_id);
  assert.equal(done.result.application_person_id, COM1_PEOPLE.estoque.user_id);
  assert.equal(view(f, a.id).status, "autorizada");
});

test("reserva é consumida uma vez e efeito já existente é reconhecido pelo conteúdo", t => {
  const f = fixture(t, { policy: true });
  const reserved = reserve(f), a = authorized(f);
  const output = effect(f, a, "stock");
  assert.equal(output.state, "aplicado");
  assert.equal(row(f, "SELECT state FROM erp_stock__reservation WHERE id=?", reserved.receipt.reservation.id).state, "consumed");
  effect(f, a, "stock");
  assert.equal(count(f, "erp_stock__document_posting"), 1);
  const g = fixture(t);
  const existing = g.rpc("erp_document_finance_post", financeArgs(g)), authorizedAfter = authorized(g);
  const recognized = effect(g, authorizedAfter, "finance");
  assert.equal(recognized.state, "reconhecido");
  assert.ok(JSON.stringify(recognized.ids).includes(existing.posting.id));
  assert.equal(count(g, "erp_finance__title"), 1);
});

test("conteúdo divergente não produz lançamento substituto", t => {
  const f = fixture(t), posted = f.rpc("erp_document_finance_post", financeArgs(f));
  const title = posted.titles[0];
  // Fixture histórica divergente; o escritor atual já impede editar títulos de pedido.
  f.db.exec("UPDATE erp_finance__title SET amount_cents=5000 WHERE id=?", title.id);
  const a = authorized(f), pending = effect(f, a, "finance");
  assert.equal(pending.state, "pendente");
  assert.equal(count(f, "erp_finance__document_posting"), 1);
  assert.equal(count(f, "erp_finance__title"), 1);
});

test("troca de posting depois da aplicação deixa reconciliação pendente e preserva a prova original", t => {
  const f = fixture(t), a = authorized(f), applied = effect(f, a, "stock");
  const posting = row(f, "SELECT * FROM erp_stock__document_posting");
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_posting_id: posting.id,
    p_posting_version: posting.version, p_occurred_on: COM1_DATE, p_reason: "Reversão operacional explícita" };
  const p = f.rpc("erp_document_stock_reverse_preview", args).preview;
  // Histórico simulado: com a nota autorizada, o estorno direto agora é recusado (fiscal_order_effect_locked).
  f.transaction(ctx => withCom1Compensation(ctx, f.order.id, () => invokeRpc(ctx, "erp_document_stock_reverse",
    { p_user_id: COM1_PEOPLE.admin.user_id, ...args, p_command_id: randomUUID(), p_preview_hash: p.preview_hash })));
  const replacement = f.rpc("erp_document_stock_post", stockArgs(f));
  assert.notEqual(replacement.posting.id, posting.id);
  const reconciled = effect(f, a, "stock", { intent: "reconcile" });
  assert.equal(reconciled.result.reconciliation.state, "pendente");
  assert.deepEqual(reconciled.ids, applied.ids);
  assert.equal(count(f, "erp_stock__document_posting"), 2);
});

test("conciliação por outra pessoa gera auditoria própria sem reatribuir a aplicação", t => {
  const f = fixture(t), a = authorized(f), applied = effect(f, a, "stock");
  const args = input(f, a, "stock", { intent: "reconcile" });
  f.rpc("erp_com1_effect_apply", { p_input: args }, { role: "estoque" });
  const audits = f.db.exec(`SELECT person_id,command_id FROM ${T.audit} WHERE command_id=? AND action='effect_apply'`, args.command_id).rows;
  assert.ok(audits.some(event => event.person_id === COM1_PEOPLE.estoque.user_id));
  const original = f.transaction(ctx => getCommand(ctx, applied.command_id));
  assert.equal(original.person_id, COM1_PEOPLE.admin.user_id);
});

test("conferência detecta mudança comercial na décima casa do preço sem arredondar", t => {
  const f = fixture(t), a = authorized(f);
  const original = row(f, "SELECT id,data FROM erp_documents__item WHERE document_id=?", f.order.id);
  const changed = { ...JSON.parse(original.data), unit_price: "25.5000000001" };
  f.db.exec("UPDATE erp_documents__item SET data=? WHERE id=?", JSON.stringify(changed), original.id);
  const output = effect(f, a, "stock");
  assert.equal(output.state, "pendente");
  assert.equal(output.reason, "com1_effect_source_changed");
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  f.db.exec("UPDATE erp_documents__item SET data=? WHERE id=?", original.data, original.id);
  assert.equal(effect(f, a, "stock").state, "aplicado");
});

test("conciliação confere conta financeira salva, além do valor e vencimento", t => {
  const f = fixture(t);
  f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(),
    p_body: { ...editBody(f), payment_account_id: f.account.id } });
  f.rpc("erp_document_finance_post", financeArgs(f));
  const other = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: {
    account_type: "cash", name: "Outra conta", start_on: "2020-01-01", opening_cents: "0",
  } }).record;
  // Fixture de histórico incompatível: não se edita título de pedido pela API.
  f.db.exec("UPDATE erp_finance__title SET account_id=?", other.id);
  const pending = effect(f, authorized(f), "finance");
  assert.equal(pending.state, "pendente", JSON.stringify(pending));
  assert.equal(count(f, "erp_finance__title"), 1);
});

test("correção de conta local após autorização não muda a referência fiscal nem bloqueia títulos", t => {
  const f = fixture(t), a = authorized(f);
  f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(),
    p_body: { ...editBody(f), payment_account_id: f.account.id } });
  const output = effect(f, a, "finance");
  assert.equal(output.state, "aplicado", JSON.stringify(output));
  assert.equal(row(f, "SELECT account_id FROM erp_finance__title").account_id, f.account.id);
  assert.equal(view(f, a.id).reference, a.reference);
});

test("compensação trata posting histórico com parte desligada e sem registro prévio do efeito", t => {
  const f = fixture(t);
  f.rpc("erp_document_stock_post", stockArgs(f));
  f.rpc("erp_document_finance_post", financeArgs(f));
  const c = cancelled(f, authorized(f));
  assert.equal(count(f, T.effect), 0);
  for (const axis of ["stock", "finance"]) {
    const result = reverse(f, c, axis, { physical_return_confirmed: true }, { parts: { [axis]: false } });
    assert.equal(result.compensation_state, "revertido", JSON.stringify(result));
  }
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "reversed");
  assert.equal(row(f, "SELECT state FROM erp_finance__document_posting").state, "reversed");
});

test("skip anterior não impede compensação de posting manual posterior", t => {
  const f = fixture(t), a = authorized(f);
  assert.equal(effect(f, a, "stock", {}, { parts: { stock: false } }).state, "pulado");
  f.rpc("erp_document_stock_post", stockArgs(f));
  const c = cancelled(f, a), result = reverse(f, c, "stock", { physical_return_confirmed: true });
  assert.equal(result.state, "pulado", "compensação não apaga a decisão anterior");
  assert.equal(result.compensation_state, "revertido", JSON.stringify(result));
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "reversed");
});

test("lote escolhido após preparo é conferido; lote incompatível deixa compensação pendente", t => {
  const f = fixture(t);
  const productVersion = row(f, "SELECT version FROM erp_catalog__record WHERE id=?", f.product.id).version;
  f.rpc("erp_catalog_product_save", { p_id: f.product.id, p_expected_version: productVersion, p_command_id: randomUUID(),
    p_data: { name: f.product.name, lot_control: true }, p_acknowledged: null });
  const receipt = f.rpc("erp_stock_lot_launch", { p_command_id: randomUUID(), p_kind: "receipt", p_product_id: f.product.id,
    p_warehouse_id: f.warehouse.id, p_quantity: "10", p_expected_version: 1, p_unit_price: null, p_unit_cost: null, p_note: null,
    p_destination_id: null, p_destination_version: null, p_lot: { code: "L-COMERCIAL", expires_on: "2028-01-31" } });
  const other = f.rpc("erp_stock_lot_save", { p_command_id: randomUUID(), p_product_id: f.product.id, p_lot_id: null,
    p_expected_version: 0, p_code: "L-OUTRO" }).lot;
  const a = authorized(f);
  const assign = lot => {
    const body = editBody(f); body.items[0].lots = [{ lot_id: lot, quantity: "2" }];
    f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f), p_command_id: randomUUID(), p_body: body });
  };
  assign(receipt.lot.id);
  const applied = effect(f, a, "stock");
  assert.equal(applied.state, "aplicado", JSON.stringify(applied));
  const c = cancelled(f, a);
  assert.throws(() => assign(other.id), error("erp_document_active_stock"));
  // Histórico divergente simulado; a API atual já protege a seleção lançada.
  const item = row(f, "SELECT id,data FROM erp_documents__item WHERE document_id=?", f.order.id);
  f.db.exec("UPDATE erp_documents__item SET data=? WHERE id=?", JSON.stringify({ ...JSON.parse(item.data), lots: [{ lot_id: other.id, quantity: "2.000000" }] }), item.id);
  const pending = reverse(f, c, "stock", { physical_return_confirmed: true });
  assert.equal(pending.compensation_state, "compensacao_pendente");
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
  f.db.exec("UPDATE erp_documents__item SET data=? WHERE id=?", item.data, item.id);
  const reversed = reverse(f, c, "stock", { physical_return_confirmed: true });
  assert.equal(reversed.compensation_state, "revertido", JSON.stringify(reversed));
  assert.equal(row(f, "SELECT quantity FROM erp_stock__lot_balance WHERE lot_id=?", receipt.lot.id).quantity, 10000000);
});

test("falha local faz rollback do eixo, conserva autorização e permite financeiro independente", t => {
  const f = fixture(t), a = authorized(f);
  const failing = createCom1EffectHandlers({ invoke(ctx, name, args) {
    const result = invokeRpc(ctx, name, args);
    if (name === "erp_document_stock_post") throw new Error("queda_simulada_apos_posting");
    return result;
  } });
  const original = input(f, a, "stock"), originalVersion = version(f);
  const failed = f.transaction(ctx => failing.applyEffects(ctx, original));
  assert.equal(failed.state, "pendente");
  assert.equal(count(f, "erp_stock__document_posting"), 0);
  const attempt = f.transaction(ctx => getCommand(ctx, original.command_id));
  assert.equal(attempt.request.args.p_expected_version, originalVersion);
  assert.equal(attempt.request.args.p_user_id, COM1_PEOPLE.admin.user_id);
  assert.equal(effect(f, a, "finance").state, "aplicado");
  assert.equal(view(f, a.id).status, "autorizada");
  const retry = effect(f, a, "stock", {}, { role: "estoque" });
  assert.equal(retry.state, "aplicado");
  const retried = f.transaction(ctx => getCommand(ctx, retry.command_id));
  assert.notEqual(retried.request.local_command_id, attempt.request.local_command_id);
  assert.equal(retried.request.args.p_user_id, COM1_PEOPLE.estoque.user_id);
  assert.ok(retried.request.args.p_expected_version > originalVersion);
  assert.deepEqual(f.transaction(ctx => getCommand(ctx, original.command_id)).request, attempt.request);
});

test("queda entre eixos retoma com nova pessoa e versão corrente", t => {
  const f = fixture(t), a = authorized(f);
  assert.equal(effect(f, a, "stock", {}, { role: "estoque" }).state, "aplicado");
  f.db.exec("UPDATE erp_documents__document SET version=version+1 WHERE id=?", f.order.id);
  assert.equal(effect(f, a, "finance", {}, { role: "financeiro" }).state, "aplicado");
  const effects = f.transaction(ctx => getEffects(ctx, a.id));
  assert.equal(effects.length, 2);
  assert.equal(count(f, "erp_stock__document_posting"), 1);
  assert.equal(count(f, "erp_finance__title"), 1);
});

test("cancelamento preserva evento, exige retorno físico e permite manutenção estreita", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "stock"); effect(f, a, "finance");
  const c = cancelled(f, a);
  assert.equal(reverse(f, c, "stock").compensation_state, "compensacao_pendente");
  assert.equal(row(f, "SELECT quantity FROM erp_stock__balance WHERE product_id=?", f.product.id).quantity, 98000000);
  assert.equal(reverse(f, c, "finance", {}, { parts: { finance: false } }).compensation_state, "revertido");
  const args = input(f, c, "stock", { intent: "reverse", physical_return_confirmed: true });
  const reversed = f.rpc("erp_com1_effect_reverse", { p_input: args }, { parts: { stock: false } });
  assert.equal(reversed.compensation_state, "revertido");
  assert.deepEqual(f.rpc("erp_com1_effect_reverse", { p_input: args }, { parts: { stock: false } }), reversed);
  const next = input(f, c, "stock", { intent: "reverse", physical_return_confirmed: true });
  f.rpc("erp_com1_effect_reverse", { p_input: next }, { role: "estoque", parts: { stock: false } });
  assert.equal(row(f, `SELECT person_id FROM ${T.audit} WHERE command_id=? AND action='effect_reverse'`, next.command_id).person_id, COM1_PEOPLE.estoque.user_id);
  assert.equal(row(f, "SELECT quantity FROM erp_stock__balance WHERE product_id=?", f.product.id).quantity, 100000000);
  assert.equal(view(f, a.id).status, "cancelada");
});

test("título recebido permanece recebido depois do cancelamento fiscal", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "finance");
  const title = row(f, "SELECT * FROM erp_finance__title");
  const args = { p_command_id: randomUUID(), p_action: "settle", p_data: { id: title.id, expected_version: title.version,
    account_id: f.account.id, posted_on: COM1_DATE, principal_cents: "5100" } };
  f.rpc("erp_finance_execute", args); f.rpc("erp_finance_execute", args);
  assert.equal(count(f, "erp_finance__settlement"), 1);
  const c = cancelled(f, a);
  assert.equal(reverse(f, c, "finance").compensation_state, "compensacao_pendente");
  assert.equal(row(f, "SELECT settled_cents,cancelled FROM erp_finance__title").settled_cents, 5100);
  assert.equal(count(f, "erp_finance__settlement"), 1);
});

test("cobrança CNAB impede compensação sem tocar banco ou recebimento", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "finance");
  const title = row(f, "SELECT id FROM erp_finance__title"), profile = randomUUID(), remittance = randomUUID(), billing = randomUUID();
  const at = String(f.clock.next());
  f.db.exec("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", profile, f.account.id, "{}", "{}", "ensaio", 2, at, at);
  f.db.exec("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,state,snapshot,actor,created_at,purpose) VALUES(?,?,?,?,?,?,?,?,?)", remittance, profile, 1, COM1_DATE, "reserved", "{}", COM1_PEOPLE.admin.user_id, at, "operational");
  f.db.exec("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES(?,?,?,?,?,?,?,?)", billing, title.id, profile, remittance, "controle", "DOC-1", "123456", "{}");
  const before = row(f, "SELECT * FROM erp_cnab__billing_title");
  assert.equal(reverse(f, cancelled(f, a), "finance").compensation_state, "compensacao_pendente");
  assert.deepEqual(row(f, "SELECT * FROM erp_cnab__billing_title"), before);
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title").cancelled, 0);
});

test("faturamento agrupado é reconhecido e cancelamento exige resolução humana", t => {
  const f = fixture(t);
  f.rpc("erp_finance_grouped_billing_execute", groupedArgs(f));
  const a = authorized(f), recognized = effect(f, a, "finance");
  assert.equal(recognized.state, "reconhecido");
  assert.equal(count(f, "erp_finance__document_posting"), 0);
  assert.equal(count(f, "erp_finance__title"), 1);
  assert.equal(reverse(f, cancelled(f, a), "finance").compensation_state, "compensacao_pendente");
  assert.equal(row(f, "SELECT state FROM erp_finance__grouped_billing").state, "active");
});

test("bot configurado usa o mesmo efeito, auditoria preserva proposta/confirmação e origem externa é recusada", t => {
  const f = fixture(t), a = authorized(f), args = input(f, a, "stock");
  const run = authority => runWithCom1Authority(authority, () => f.rpc("erp_com1_effect_apply", { p_input: args }, { actor: { is_agent: true } }));
  assert.throws(() => run({ origin: "application" }), error("fiscal_confirmation_required"));
  assert.throws(() => run({ origin: "external", autonomous: true }), error("fiscal_external_origin_forbidden"));
  assert.equal(run({ origin: "application", proposed_by: "bot-vendas", confirmed_by: COM1_PEOPLE.admin.user_id, confirmation_id: "approval-1" }).state, "aplicado");
  const command = f.transaction(ctx => getCommand(ctx, args.command_id));
  assert.equal(command.proposed_by, "bot-vendas");
  assert.equal(command.confirmed_by, COM1_PEOPLE.admin.user_id);
});
