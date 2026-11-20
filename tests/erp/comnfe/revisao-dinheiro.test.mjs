// Correções da revisão de dinheiro, estoque e nota (junção candidata):
// achado 1 (nova versão fiscal adota o lançamento da antiga), achado 2
// (estorno direto contorna a nota) e achado 3 (cancelar título com cobrança
// bancária). Sem rede: o cofre é simulado pelo store, como em efeitos.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { com1Fixture, COM1_DATE, COM1_PEOPLE } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { applyEffects, reverseEffects } from "../../../src/erp/domains/fiscal/comnfe/effects.ts";
import {
  COM1_TABLES as T, com1Hash, com1Reference, savePreparation, claimStoredOperation, recordExternalEvidence,
  getStoredEmission, getEffects, claimStoredCancellation, recordCancellationEvidence,
} from "../../../src/erp/domains/fiscal/comnfe/store.ts";
import { MODULE_ORIGIN_DEVIATIONS, ERP_RULE_DEVIATIONS } from "../../../src/erp/schema/deviations.ts";

const connection = com1Hash("cofre-simulado-revisao");
const error = message => e => e.message === message;
const count = (f, table) => f.db.exec(`SELECT count(*) n FROM ${table}`).rows[0].n;
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];
const current = f => row(f, "SELECT * FROM erp_documents__document WHERE id=?", f.order.id);
const version = f => current(f).version;
const items = f => f.db.exec("SELECT data FROM erp_documents__item WHERE document_id=? ORDER BY position", f.order.id).rows.map(i => JSON.parse(i.data));
const view = (f, id) => f.transaction(ctx => getStoredEmission(ctx, id));
const effects = (f, id) => Object.fromEntries(f.transaction(ctx => getEffects(ctx, id)).map(e => [e.axis, e]));
const balance = f => row(f, "SELECT quantity FROM erp_stock__balance WHERE product_id=?", f.product.id).quantity;
const input = (f, emission, axis, extra = {}) => ({ emission_id: emission.id, command_id: randomUUID(),
  expected_version: view(f, emission.id).version, axis, intent: "apply", ...extra });
const effect = (f, emission, axis, extra = {}, env = {}) => f.rpc("erp_com1_effect_apply", { p_input: input(f, emission, axis, extra) }, env);
const reverse = (f, emission, axis, extra = {}, env = {}) => f.rpc("erp_com1_effect_reverse", { p_input: input(f, emission, axis, { intent: "reverse", ...extra }) }, env);

function fixture(t) {
  const f = com1Fixture(t);
  t.after(installCommercialNfeSlots({ applyEffects, reverseEffects }));
  f.warehouse = f.catalog("warehouses", { name: "Depósito da revisão" });
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas da revisão" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa da revisão", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.orderBody = { ...f.orderBody, warehouse_id: f.warehouse.id, category_id: f.category.id };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_body: f.orderBody }).document;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE,
    p_reason: "Saldo inicial da revisão", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }] });
  f.order = f.rpc("erp_document_transition", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_status: "verified", p_reason: "Conferência do pedido" }).document;
  return f;
}
const key = n => `3526111122233300018155001${String(n).padStart(9, "0")}1000000010`;
function prepared(f, fiscalVersion = 1, previous = null) {
  const d = current(f), body = JSON.parse(d.body), command = randomUUID();
  return f.transaction(ctx => savePreparation(ctx, {
    command_id: command, args: { document_id: d.id, command_id: command }, document_id: d.id,
    expected_document_version: d.version, environment: "homologacao", connection_fingerprint: connection,
    ...(previous ? { new_fiscal_version: true, expected_emission_version: view(f, previous.id).version } : {}),
    snapshot: { document: { ...d, body }, items: items(f), company: f.company, recipient: {}, products: [], nature: {}, payments: [], transport: {}, sources: [] },
    tax_sources: {}, commercial_hash: com1Hash(body), source_fingerprint: com1Hash(body),
    body: { ambiente: "homologacao", referencia: com1Reference(d.id, fiscalVersion), serie: 1, naturezaOperacao: "Venda", emitente: { cnpj: f.company.cnpj },
      destinatario: { cnpj: "19131243000197" }, itens: [{ quantidade: 2, valorUnitario: 25.5 }], pagamentos: [{ forma: "15", valor: 51 }] },
    calculation: { total_cents: "5100" }, blockers: [],
  })).emission;
}
function result(emission, n, changes = {}) {
  return { kind: "nfe", status: "authorized", provider_ref: `nfe_revisao_${n}`, reference: emission.reference, environment: "homologacao",
    series: "1", number: n, access_key: key(n), protocol: `13526000000000${n}`, nfse_number: null, issued_at: "2026-11-19T12:00:00Z",
    authorized_at: "2026-11-19T12:00:01Z", total: 51, qr_code: null, consult_url: null, corrections: 0, messages: [], xml_available: true,
    replayed: false, event_repeated: null, contingency: null, ...changes };
}
function authorized(f, fiscalVersion = 1, previous = null) {
  const p = prepared(f, fiscalVersion, previous);
  const claimed = f.transaction(ctx => claimStoredOperation(ctx, { emission_id: p.id, command_id: randomUUID(), action: "emit",
    expected_version: p.version, body_revision: p.current_body_revision, body_hash: p.revision.body_hash,
    source_fingerprint: p.revision.source_fingerprint, connection_fingerprint: connection }));
  return f.transaction(ctx => recordExternalEvidence(ctx, { emission_id: p.id, command_id: claimed.command.id,
    claim_token: claimed.command.token, connection_fingerprint: connection, result: result(p, fiscalVersion) }));
}
function cancelled(f, emission) {
  const c = f.transaction(ctx => claimStoredCancellation(ctx, { emission_id: emission.id, command_id: randomUUID(),
    expected_version: view(f, emission.id).version, justification: "Cancelamento da revisão de dinheiro.", connection_fingerprint: connection }));
  return f.transaction(ctx => recordCancellationEvidence(ctx, { emission_id: emission.id, command_id: c.command.id,
    claim_token: c.command.token, connection_fingerprint: connection, state: "registrado",
    result: result(emission, emission.fiscal_version, { status: "cancelled" }), event_protocol: "135260000000099", event_at: "1795089660000000" }));
}
function stockArgs(f) {
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_occurred_on: COM1_DATE, p_reason: "Saída da venda" };
  return { ...args, p_command_id: randomUUID(), p_preview_hash: f.rpc("erp_document_stock_preview", args).preview.preview_hash, p_ignored_item_ids: [] };
}
function financeArgs(f) {
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_category_id: null, p_plan: null };
  return { ...args, p_command_id: randomUUID(), p_preview_hash: f.rpc("erp_document_finance_preview", args).preview.preview_hash };
}
function directStockReverse(f, env = {}) {
  const posting = row(f, "SELECT * FROM erp_stock__document_posting WHERE state='active'");
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_posting_id: posting.id,
    p_posting_version: posting.version, p_occurred_on: COM1_DATE, p_reason: "Estorno direto pelo estoque" };
  const preview = f.rpc("erp_document_stock_reverse_preview", args, env).preview;
  return () => f.rpc("erp_document_stock_reverse", { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash }, env);
}
function directFinanceReverse(f, env = {}) {
  const posting = row(f, "SELECT * FROM erp_finance__document_posting WHERE state='active'");
  const args = { p_kind: "sales_orders", p_document_id: f.order.id, p_expected_version: version(f), p_posting_id: posting.id, p_posting_version: posting.version };
  const preview = f.rpc("erp_document_finance_reverse_preview", args, env).preview;
  return () => f.rpc("erp_document_finance_reverse", { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash,
    p_reason: "Estorno direto pelo financeiro", p_title_versions: preview.titles.map(t => ({ id: t.id, version: t.version })) }, env);
}
function titleCancel(f, title = row(f, "SELECT * FROM erp_finance__title")) {
  return () => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_cancel",
    p_data: { id: title.id, expected_version: title.version, note: "Cancelamento direto da conta" } });
}
function bankCollection(f, titleId, purpose = "operational") {
  const remittance = randomUUID(), at = String(f.clock.next()), n = (f.billed = (f.billed ?? 0) + 1);
  if (!f.cnabProfile) {
    f.cnabProfile = randomUUID();
    f.db.exec("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", f.cnabProfile, f.account.id, "{}", "{}", "revisao", 10, at, at);
  }
  f.db.exec("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,state,snapshot,actor,created_at,purpose) VALUES(?,?,?,?,?,?,?,?,?)", remittance, f.cnabProfile, n, COM1_DATE, "ready", "{}", COM1_PEOPLE.admin.user_id, at, purpose);
  f.db.exec("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES(?,?,?,?,?,?,?,?)", randomUUID(), titleId, f.cnabProfile, remittance, `controle-${n}`, `DOC-${n}`, `12345${n}`, "{}");
}

// --- Achado 1 -----------------------------------------------------------------

test("achado 1: a nova versão autorizada adota estoque e títulos; a versão cancelada não os estorna", t => {
  const f = fixture(t), v1 = authorized(f);
  assert.equal(effect(f, v1, "stock").state, "aplicado");
  assert.equal(effect(f, v1, "finance").state, "aplicado");
  const c1 = cancelled(f, v1), before = balance(f);
  // O preparo da versão nova não exige encerrar as compensações da anterior.
  const v2 = authorized(f, 2, c1);
  assert.equal(v2.fiscal_version, 2);
  for (const axis of ["stock", "finance"]) {
    const adopted = effect(f, v2, axis);
    assert.equal(adopted.state, "reconhecido", JSON.stringify(adopted));
    assert.equal(adopted.result.transferred_from.emission_id, v1.id);
    const old = effects(f, v1.id)[axis];
    assert.equal(old.compensation_state, "transferido");
    assert.equal(old.compensation_result.from_emission_id, v1.id);
    assert.equal(old.compensation_result.to_emission_id, v2.id);
    assert.equal(old.compensation_result.command_id, adopted.command_id);
    assert.match(old.compensation_result.transferred_at, /^\d+$/);
    assert.deepEqual(old.ids, adopted.ids);
    assert.ok(row(f, `SELECT 1 x FROM ${T.audit} WHERE emission_id=? AND action='effect_transfer' AND command_id=?`, v1.id, adopted.command_id));
    assert.throws(() => reverse(f, c1, axis, { physical_return_confirmed: true }), error("com1_effect_transferred"), axis);
  }
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
  assert.equal(row(f, "SELECT state FROM erp_finance__document_posting").state, "active");
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title").cancelled, 0);
  assert.equal(balance(f), before);
  // A nova emissão responde pelo lançamento: cancelada, ela compensa.
  const c2 = cancelled(f, v2);
  assert.equal(reverse(f, c2, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  assert.equal(reverse(f, c2, "finance").compensation_state, "revertido");
  assert.equal(balance(f), 100000000);
  assert.throws(() => reverse(f, c1, "stock", { physical_return_confirmed: true }), error("com1_effect_transferred"));
});

test("achado 1: lançamento manual reconhecido pela nova versão não é estornado pela antiga sem registro de efeito", t => {
  const f = fixture(t), v1 = authorized(f);
  assert.equal(effect(f, v1, "stock", {}, { parts: { stock: false } }).state, "pulado");
  f.rpc("erp_document_stock_post", stockArgs(f));
  const c1 = cancelled(f, v1), v2 = authorized(f, 2, c1);
  assert.equal(effect(f, v2, "stock").state, "reconhecido");
  assert.equal(effects(f, v1.id).stock.compensation_state, null, "sem lançamento próprio, nada a transferir");
  assert.throws(() => reverse(f, c1, "stock", { physical_return_confirmed: true }), error("com1_effect_transferred"));
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
});

test("achado 1: mercadoria devolvida antes da nova versão segue o caminho normal", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock");
  const c1 = cancelled(f, v1);
  assert.equal(reverse(f, c1, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  const v2 = authorized(f, 2, c1), applied = effect(f, v2, "stock");
  assert.equal(applied.state, "aplicado");
  assert.equal(applied.result.transferred_from, undefined);
  assert.equal(effects(f, v1.id).stock.compensation_state, "revertido");
  assert.equal(count(f, "erp_stock__document_posting"), 2);
});

// --- Achado 2 -----------------------------------------------------------------

test("achado 2: com NF-e autorizada, estornos e cancelamentos diretos recusam e apontam a compensação da nota", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "stock"); effect(f, a, "finance");
  assert.throws(directStockReverse(f), error("fiscal_order_effect_locked"));
  assert.throws(directStockReverse(f, { role: "estoque" }), error("fiscal_order_effect_locked"));
  assert.throws(directFinanceReverse(f), error("fiscal_order_effect_locked"));
  assert.throws(titleCancel(f), error("fiscal_order_effect_locked"));
  // Fiscal desligada não desfaz a nota enviada: a recusa pede para religá-la.
  assert.throws(directStockReverse(f, { parts: { fiscal: false } }), error("fiscal_compensation_requires_fiscal_part"));
  assert.throws(directFinanceReverse(f, { parts: { fiscal: false } }), error("fiscal_compensation_requires_fiscal_part"));
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
  assert.equal(row(f, "SELECT state FROM erp_finance__document_posting").state, "active");
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title").cancelled, 0);
  assert.equal(balance(f), 98000000);
});

test("achado 2: depois do cancelamento fiscal o estoque direto exige a compensação com retorno físico", t => {
  const f = fixture(t), a = authorized(f);
  effect(f, a, "stock"); effect(f, a, "finance");
  const c = cancelled(f, a);
  assert.throws(directStockReverse(f), error("fiscal_order_compensation_required"));
  assert.throws(() => directStockReverse(f)(), error("fiscal_order_compensation_required"));
  assert.equal(balance(f), 98000000);
  // Financeiro: mesmo critério do estoque (segunda revisão, B2); a compensação estorna.
  assert.throws(() => directFinanceReverse(f)(), error("fiscal_order_compensation_required"));
  assert.equal(reverse(f, c, "finance").compensation_state, "revertido");
  // O caminho da nota continua funcionando, com a confirmação física.
  assert.equal(reverse(f, c, "stock").compensation_state, "compensacao_pendente");
  assert.equal(reverse(f, c, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  assert.equal(balance(f), 100000000);
});

test("achado 2: nota legada vinculada ao pedido com NF-e comercial vigente também é guardada", t => {
  const f = fixture(t), id = randomUUID(), at = String(f.clock.next()), user = COM1_PEOPLE.admin.user_id;
  f.db.exec(`INSERT INTO erp_fiscal_invoices__invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,updated_at)
    VALUES(?,'55','1','T',NULL,1,1,42,'Venda',?,'1','1','0',0,?,'[]','{}',?,'[]','{}',0,0,0,0,0,'{"total":51}',1,?,?,?,?)`,
    id, COM1_DATE, JSON.stringify({ name: f.customer.name, contact_id: f.customer.id }), JSON.stringify({ installments: [{ date: "2026-12-19", amount: "51", method: "15" }] }), user, user, at, at);
  f.db.exec(`INSERT INTO erp_fiscal_invoices__invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
    VALUES(?,1,?,20000,'25.5',5100,0,0,0,0,?)`, id, f.product.id, JSON.stringify({ description: "Mercadoria do Ensaio", unit: "UN" }));
  f.db.exec("INSERT INTO erp_fiscal_invoices__invoice_order(invoice_id,document_id) VALUES(?,?)", id, f.order.id);
  const stock = { p_invoice_id: id, p_expected_version: 1, p_warehouse_id: f.warehouse.id };
  const posted = f.rpc("erp_stock_invoice_post", { ...stock, p_command_id: randomUUID(), p_preview_hash: f.rpc("erp_stock_invoice_preview", stock).preview.preview_hash });
  const finance = { p_invoice_id: id, p_expected_version: 1, p_category_id: null, p_account_id: null };
  const financePosted = f.rpc("erp_finance_invoice_finance_post", { p_command_id: randomUUID(), p_data: { invoice_id: id, expected_version: 1,
    category_id: null, account_id: null, preview_hash: f.rpc("erp_finance_invoice_finance_preview", finance).preview.preview_hash } });
  const a = authorized(f);
  assert.equal(effect(f, a, "stock").state, "reconhecido");
  const reverseArgs = { p_invoice_id: id, p_posting_id: posted.posting.id, p_posting_version: row(f, "SELECT version FROM erp_stock__invoice_posting").version };
  const preview = f.rpc("erp_stock_invoice_reverse_preview", reverseArgs).preview;
  assert.throws(() => f.rpc("erp_stock_invoice_reverse", { ...reverseArgs, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash }), error("fiscal_order_effect_locked"));
  const p = row(f, "SELECT * FROM erp_finance__invoice_posting");
  assert.throws(() => f.rpc("erp_finance_invoice_finance_reverse", { p_command_id: randomUUID(), p_data: { invoice_id: id, posting_id: financePosted.posting.id,
    expected_version: p.version, titles: f.db.exec("SELECT id,version FROM erp_finance__title").rows.map(t => ({ id: t.id, version: t.version })), reason: "Estorno direto" } }),
  error("fiscal_order_effect_locked"));
  assert.equal(row(f, "SELECT state FROM erp_stock__invoice_posting").state, "active");
  assert.equal(row(f, "SELECT state FROM erp_finance__invoice_posting").state, "active");
});

// --- Achado 3 -----------------------------------------------------------------

test("achado 3: title_cancel recusa título com cobrança bancária, de pedido ou avulso", t => {
  const f = fixture(t);
  f.rpc("erp_document_finance_post", financeArgs(f));
  const title = row(f, "SELECT * FROM erp_finance__title");
  bankCollection(f, title.id);
  assert.throws(titleCancel(f, title), error("erp_finance_billed_locked"));
  assert.deepEqual(row(f, "SELECT * FROM erp_finance__title WHERE id=?", title.id), title);
  const loose = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind: "receivable", contact_id: f.customer.id, category_id: f.category.id, description: "Conta avulsa", issued_on: COM1_DATE,
    total_cents: "10000", installments: [{ due_on: "2026-12-19", amount_cents: "10000" }] } });
  const looseTitle = row(f, "SELECT * FROM erp_finance__title WHERE id=?", loose.items[0].id);
  bankCollection(f, looseTitle.id);
  assert.throws(titleCancel(f, looseTitle), error("erp_finance_billed_locked"));
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title WHERE id=?", looseTitle.id).cancelled, 0);
});

test("achado 3: sem cobrança bancária o cancelamento genérico continua igual ao oráculo", t => {
  const f = fixture(t);
  const loose = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
    kind: "receivable", contact_id: f.customer.id, category_id: f.category.id, description: "Conta avulsa", issued_on: COM1_DATE,
    total_cents: "10000", installments: [{ due_on: "2026-12-19", amount_cents: "10000" }] } });
  titleCancel(f, row(f, "SELECT * FROM erp_finance__title WHERE id=?", loose.items[0].id))();
  assert.equal(row(f, "SELECT cancelled FROM erp_finance__title WHERE id=?", loose.items[0].id).cancelled, 1);
});

test("achado 3: o desvio está registrado e o oráculo ainda tem o mesmo furo", () => {
  const deviation = ERP_RULE_DEVIATIONS.find(d => d.id === "titulo-cobranca-bancaria");
  assert.ok(deviation, "desvio registrado");
  assert.ok(!MODULE_ORIGIN_DEVIATIONS.some(d => d.id === deviation.id));
  const sql = readFileSync(new URL(`../oracle/migrations/${deviation.oracle_file}`, import.meta.url), "utf8");
  const branch = sql.slice(sql.indexOf("elsif p_action='title_cancel' then\n"), sql.indexOf("    else\n", sql.indexOf("elsif p_action='title_cancel' then\n")));
  assert.ok(branch.includes(deviation.oracle), "o trecho do oráculo continua o mesmo");
  assert.ok(!branch.includes("billing_title"), "o oráculo não confere a cobrança");
  for (const ref of deviation.tests) assert.ok(readFileSync(new URL(`../../../${ref.file}`, import.meta.url), "utf8").includes(ref.test), ref.test);
});
