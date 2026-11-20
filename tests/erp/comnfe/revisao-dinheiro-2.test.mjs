// Segunda revisão independente (dinheiro, estoque e nota): M1 (estoque travado
// depois de compensação concluída), M2 (parte Fiscal desligada), M3 (título com
// cobrança bancária sem saída), B1 (V1 presa em compensacao_pendente) e B2
// (mesmo critério para transição e estorno direto). Sem rede: o cofre é
// simulado pelo store, como em revisao-dinheiro.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture, COM1_DATE, COM1_PEOPLE } from "./fixtures.mjs";
import { installCommercialNfeSlots } from "../../../src/erp/commercial-nfe/slots.ts";
import { applyEffects, reverseEffects } from "../../../src/erp/domains/fiscal/comnfe/effects.ts";
import { guardCom1Transition, FISCAL_PART_REQUIRED, FISCAL_PART_REQUIRED_MESSAGE } from "../../../src/erp/domains/fiscal/comnfe/effect-policy.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import {
  COM1_TABLES as T, com1Hash, com1Reference, savePreparation, claimStoredOperation, recordExternalEvidence,
  getStoredEmission, getEffects, claimStoredCancellation, recordCancellationEvidence,
} from "../../../src/erp/domains/fiscal/comnfe/store.ts";

const connection = com1Hash("cofre-simulado-revisao-2");
const error = message => e => e.message === message;
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
  f.warehouse = f.catalog("warehouses", { name: "Depósito da segunda revisão" });
  f.category = f.rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas da segunda revisão" } }).record;
  f.account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa da segunda revisão", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.orderBody = { ...f.orderBody, warehouse_id: f.warehouse.id, category_id: f.category.id };
  f.order = f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: f.order.id, p_expected_version: version(f),
    p_command_id: randomUUID(), p_body: f.orderBody }).document;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE,
    p_reason: "Saldo inicial da segunda revisão", p_reference: null,
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
  return { kind: "nfe", status: "authorized", provider_ref: `nfe_revisao2_${n}`, reference: emission.reference, environment: "homologacao",
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
    expected_version: view(f, emission.id).version, justification: "Cancelamento da segunda revisão de dinheiro.", connection_fingerprint: connection }));
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
const transition = (f, actions, env = {}) => () => f.transaction(ctx => guardCom1Transition(ctx, f.order.id, "cancelled", actions), env);
const title = (f, id) => id ? row(f, "SELECT * FROM erp_finance__title WHERE id=?", id) : row(f, "SELECT * FROM erp_finance__title");
const titleCancel = (f, t = title(f)) => () => f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_cancel",
  p_data: { id: t.id, expected_version: t.version, note: "Cancelamento direto da conta" } });
const writeoff = (f, t = title(f), extra = {}, env = {}, command = randomUUID()) => f.rpc("erp_finance_execute", { p_command_id: command,
  p_action: "title_bank_writeoff", p_data: { id: t.id, expected_version: t.version, reason: "Boleto baixado no internet banking em 20/11, protocolo 123", ...extra } }, env);
function bankCollection(f, titleId, purpose) {
  const remittance = randomUUID(), at = String(f.clock.next()), n = (f.billed = (f.billed ?? 0) + 1);
  if (!f.cnabProfile) {
    f.cnabProfile = randomUUID();
    f.db.exec("INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", f.cnabProfile, f.account.id, "{}", "{}", "revisao2", 10, at, at);
  }
  f.db.exec("INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,state,snapshot,actor,created_at,purpose) VALUES(?,?,?,?,?,?,?,?,?)", remittance, f.cnabProfile, n, COM1_DATE, "ready", "{}", COM1_PEOPLE.admin.user_id, at, purpose);
  const id = randomUUID();
  f.db.exec("INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES(?,?,?,?,?,?,?,?)", id, titleId, f.cnabProfile, remittance, `controle-${n}`, `DOC-${n}`, `12345${n}`, "{}");
  return { id, remittance };
}
const looseTitle = f => title(f, f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_create_group", p_data: {
  kind: "receivable", contact_id: f.customer.id, category_id: f.category.id, description: "Conta avulsa", issued_on: COM1_DATE,
  total_cents: "10000", installments: [{ due_on: "2026-12-19", amount_cents: "10000" }] } }).items[0].id);
function inspect(f, parts = {}) {
  const env = f.env({ parts });
  return callRpc(f.db, "erp_document_get", { p_user_id: COM1_PEOPLE.admin.user_id, p_kind: "sales_orders", p_id: f.order.id }, f.clock, {
    ...env, identity: { ...env.identity, partsControl: { profile: "area", revision: "1", expires_at: Date.now() + 360_000 } },
    maintenance: { origin: { type: "sales_orders", id: f.order.id }, action: "inspect" },
  });
}

// --- M1 -----------------------------------------------------------------------

test("M1: V1 compensada e pedido lançado de novo: estorno direto e transição voltam a valer, sem estornar duas vezes", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock");
  const c1 = cancelled(f, v1);
  assert.equal(reverse(f, c1, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  assert.equal(balance(f), 100000000);
  f.rpc("erp_document_stock_post", stockArgs(f));
  assert.equal(balance(f), 98000000);
  // Antes da correção: fiscal_order_compensation_required nos dois caminhos.
  transition(f, ["reverse_stock"])();
  assert.equal(directStockReverse(f)().posting.state, "reversed");
  assert.equal(balance(f), 100000000);
  // A compensação já concluída não estorna de novo.
  assert.equal(reverse(f, c1, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  assert.equal(balance(f), 100000000);
});

test("M1: V1 transferida e V2 cancelada e compensada: o lançamento novo do pedido é estornável", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock");
  const c1 = cancelled(f, v1), v2 = authorized(f, 2, c1);
  assert.equal(effect(f, v2, "stock").state, "reconhecido");
  assert.equal(effects(f, v1.id).stock.compensation_state, "transferido");
  const c2 = cancelled(f, v2);
  assert.equal(reverse(f, c2, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
  f.rpc("erp_document_stock_post", stockArgs(f));
  transition(f, ["reverse_stock"])();
  assert.equal(directStockReverse(f)().posting.state, "reversed");
  assert.equal(balance(f), 100000000);
  assert.throws(() => reverse(f, c1, "stock", { physical_return_confirmed: true }), error("com1_effect_transferred"));
});

test("M1: compensação aberta que responde pelo lançamento ativo continua travando o estorno direto e a transição", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock");
  const c1 = cancelled(f, v1);
  assert.throws(directStockReverse(f), error("fiscal_order_compensation_required"));
  assert.throws(transition(f, ["reverse_stock"]), error("fiscal_order_compensation_required"));
  // Pendente por falta de retorno físico: continua aberta.
  assert.equal(reverse(f, c1, "stock").compensation_state, "compensacao_pendente");
  assert.throws(directStockReverse(f), error("fiscal_order_compensation_required"));
  assert.throws(transition(f, ["reverse_stock"]), error("fiscal_order_compensation_required"));
  // Nota vigente continua com a trava própria.
  const v2 = authorized(f, 2, c1);
  effect(f, v2, "stock");
  assert.throws(directStockReverse(f), error("fiscal_order_effect_locked"));
  assert.equal(balance(f), 98000000);
});

// --- M2 -----------------------------------------------------------------------

test("M2: com a Fiscal desligada a inspeção não oferece o estorno e a recusa diz para religar a Fiscal", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock"); effect(f, v1, "finance");
  const c1 = cancelled(f, v1), off = { parts: { fiscal: false } };
  const inspection = inspect(f, { fiscal: false });
  assert.ok(!inspection.operations.includes("document_stock_reverse"), JSON.stringify(inspection.operations));
  assert.ok(!inspection.operations.includes("document_finance_reverse"));
  const blocker = inspection.blockers.find(b => b.kind === "fiscal_compensation" && b.axis === "stock");
  assert.deepEqual({ code: blocker.code, message: blocker.message }, { code: FISCAL_PART_REQUIRED, message: FISCAL_PART_REQUIRED_MESSAGE });
  assert.match(blocker.message, /Ligue a parte Fiscal/);
  assert.throws(directStockReverse(f, off), error(FISCAL_PART_REQUIRED));
  assert.throws(directFinanceReverse(f, off), error(FISCAL_PART_REQUIRED));
  assert.throws(transition(f, ["reverse_stock"], off), error(FISCAL_PART_REQUIRED));
  // A regra fica: a compensação não roda sem a Fiscal.
  assert.throws(() => reverse(f, c1, "stock", { physical_return_confirmed: true }, off));
  assert.equal(balance(f), 98000000);
  // Com a Fiscal ligada a inspeção continua sem oferecer, agora pedindo a compensação.
  const on = inspect(f);
  assert.ok(!on.operations.includes("document_stock_reverse"));
  assert.equal(on.blockers.find(b => b.kind === "fiscal_compensation" && b.axis === "stock").code, "fiscal_order_compensation_required");
  assert.equal(reverse(f, c1, "stock", { physical_return_confirmed: true }).compensation_state, "revertido");
});

test("M2: sem nota envolvida a inspeção com a Fiscal desligada continua oferecendo o estorno", t => {
  const f = fixture(t);
  f.rpc("erp_document_stock_post", stockArgs(f));
  const inspection = inspect(f, { fiscal: false });
  assert.ok(inspection.operations.includes("document_stock_reverse"));
  assert.ok(!inspection.blockers.some(b => b.kind === "fiscal_compensation"));
});

// --- B1 -----------------------------------------------------------------------

test("B1: reconhecimento sem transferência registrada: o estorno da V1 registra a transferência e a pendência sai", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "stock");
  const c1 = cancelled(f, v1);
  assert.equal(reverse(f, c1, "stock").compensation_state, "compensacao_pendente");
  const v2 = authorized(f, 2, c1);
  assert.equal(effect(f, v2, "stock").state, "reconhecido");
  // Efeito da V2 gravado antes da transferência existir: a V1 ficou pendente.
  const pending = effects(f, v1.id).stock.compensation_result.previous_compensation;
  f.db.exec(`UPDATE ${T.effect} SET compensation_state='compensacao_pendente',compensation_command_id=?,compensation_result=? WHERE emission_id=? AND axis='stock'`,
    pending.command_id, JSON.stringify(pending.result), v1.id);
  assert.equal(effects(f, v1.id).stock.compensation_state, "compensacao_pendente");
  const before = balance(f);
  // Antes da correção: lançava com1_effect_transferred e a V1 seguia pendente.
  const moved = reverse(f, c1, "stock", { physical_return_confirmed: true });
  assert.equal(moved.compensation_state, "transferido");
  assert.equal(moved.compensation_result.to_emission_id, v2.id);
  assert.equal(effects(f, v1.id).stock.compensation_state, "transferido");
  assert.equal(balance(f), before);
  assert.equal(row(f, "SELECT state FROM erp_stock__document_posting").state, "active");
  // Depois disso a V1 continua sem poder estornar.
  assert.throws(() => reverse(f, c1, "stock", { physical_return_confirmed: true }), error("com1_effect_transferred"));
});

// --- B2 -----------------------------------------------------------------------

test("B2: transição com reverse_finance e estorno direto de títulos decidem pelo mesmo critério", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "finance");
  const c1 = cancelled(f, v1);
  // Compensação aberta: os dois recusam (antes o estorno direto passava).
  assert.throws(transition(f, ["reverse_finance"]), error("fiscal_order_compensation_required"));
  assert.throws(() => directFinanceReverse(f)(), error("fiscal_order_compensation_required"));
  assert.equal(reverse(f, c1, "finance").compensation_state, "revertido");
  // Compensação concluída e pedido lançado de novo: os dois liberam (antes a transição recusava).
  f.rpc("erp_document_finance_post", financeArgs(f));
  transition(f, ["reverse_finance"])();
  assert.equal(directFinanceReverse(f)().posting.state, "reversed");
});

test("B2: compensação financeira que manda conferir na área não trava o estorno direto, e não estorna duas vezes", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "finance");
  const c1 = cancelled(f, v1), t1 = title(f);
  // Vencimento alterado depois do lançamento: a prova da nota não confere mais.
  f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "title_update", p_data: { id: t1.id, expected_version: t1.version, due_on: "2026-12-29" } });
  const stuck = reverse(f, c1, "finance");
  assert.equal(stuck.compensation_state, "compensacao_pendente");
  assert.equal(stuck.compensation_result.reason, "com1_effect_finance_content_mismatch");
  assert.equal(directFinanceReverse(f)().posting.state, "reversed");
  const proof = reverse(f, c1, "finance");
  assert.equal(proof.compensation_state, "revertido");
  assert.equal(proof.compensation_result.proof, "previous_reversal");
});

test("B2: título recebido continua travando o estorno direto até a compensação", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "finance");
  const c1 = cancelled(f, v1), t1 = title(f);
  f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: t1.id, expected_version: t1.version,
    account_id: f.account.id, posted_on: COM1_DATE, principal_cents: "1000" } });
  assert.equal(reverse(f, c1, "finance").compensation_result.reason, "received_title_requires_manual_review");
  assert.throws(transition(f, ["reverse_finance"]), error("fiscal_order_compensation_required"));
  assert.equal(row(f, "SELECT state FROM erp_finance__document_posting").state, "active");
});

// --- M3 -----------------------------------------------------------------------

test("M3: remessa de homologação não trava o cancelamento nem a compensação do título", t => {
  const f = fixture(t), loose = looseTitle(f);
  bankCollection(f, loose.id, "homologation");
  titleCancel(f, loose)();
  assert.equal(title(f, loose.id).cancelled, 1);
  const v1 = authorized(f);
  effect(f, v1, "finance");
  const order = row(f, "SELECT t.* FROM erp_finance__title t JOIN erp_finance__document_title l ON l.title_id=t.id");
  bankCollection(f, order.id, "homologation");
  const c1 = cancelled(f, v1);
  const compensated = reverse(f, c1, "finance");
  assert.equal(compensated.compensation_state, "revertido", JSON.stringify(compensated.compensation_result));
  assert.equal(title(f, order.id).cancelled, 1);
  // A remessa operacional continua travando.
  const live = looseTitle(f);
  bankCollection(f, live.id, "operational");
  assert.throws(titleCancel(f, live), error("erp_finance_billed_locked"));
});

test("M3: declarar o boleto baixado no banco cancela a conta, audita e libera a compensação da NF-e", t => {
  const f = fixture(t), v1 = authorized(f);
  effect(f, v1, "finance");
  const t1 = row(f, "SELECT t.* FROM erp_finance__title t JOIN erp_finance__document_title l ON l.title_id=t.id");
  const billing = bankCollection(f, t1.id, "operational");
  // Nota vigente: nem a declaração cancela a conta.
  assert.throws(() => writeoff(f, t1), error("fiscal_order_effect_locked"));
  const c1 = cancelled(f, v1);
  assert.equal(reverse(f, c1, "finance").compensation_result.reason, "bank_collection_requires_manual_review");
  assert.throws(titleCancel(f, title(f, t1.id)), error("erp_finance_billed_locked"));
  // Motivo obrigatório; consulta não escreve; sem a permissão de cancelar conta, recusa.
  assert.throws(() => writeoff(f, title(f, t1.id), { reason: "  " }), e => /reason|invalid/.test(e.message));
  assert.throws(() => writeoff(f, title(f, t1.id), {}, { role: "consulta" }), error("erp_finance_access_denied"));
  const financeiro = COM1_PEOPLE.financeiro.user_id, at = String(f.clock.next());
  f.db.exec("INSERT INTO erp_access__user_control(user_id,permissions,version,updated_at,updated_by) VALUES(?,?,1,?,?)",
    financeiro, JSON.stringify(["financas", "financas.contas_receber", "financas.contas_receber.ie"]), at, COM1_PEOPLE.admin.user_id);
  assert.throws(() => writeoff(f, title(f, t1.id), {}, { role: "financeiro" }), error("erp_finance_permission_denied"));
  assert.equal(title(f, t1.id).cancelled, 0);
  const command = randomUUID(), done = writeoff(f, title(f, t1.id), {}, {}, command);
  assert.equal(done.record.cancelled, true);
  assert.equal(done.bank_writeoff.billing_title_id, billing.id);
  assert.equal(done.bank_writeoff.declared_by, COM1_PEOPLE.admin.user_id);
  assert.equal(done.bank_writeoff.bank_instruction_generated, false);
  const audit = row(f, "SELECT * FROM erp_finance__audit WHERE command_id=?", command);
  assert.equal(audit.action, "title_bank_writeoff");
  assert.equal(audit.actor, COM1_PEOPLE.admin.user_id);
  assert.match(JSON.parse(audit.after_data).bank_writeoff.reason, /protocolo 123/);
  assert.ok(row(f, "SELECT 1 x FROM erp_cnab__audit WHERE action='title_bank_writeoff' AND record_id=? AND command_id=?", billing.id, command));
  // O vínculo com a remessa fica (histórico); o título não volta a ser cobrado nem cancelado de novo.
  assert.ok(row(f, "SELECT 1 x FROM erp_cnab__billing_title WHERE id=?", billing.id));
  assert.equal(writeoff(f, t1, {}, {}, command).replayed, true);
  assert.throws(() => writeoff(f, title(f, t1.id)), error("erp_finance_cancelled_title"));
  // A compensação financeira, antes presa na revisão manual, conclui.
  const compensated = reverse(f, c1, "finance");
  assert.equal(compensated.compensation_state, "revertido", JSON.stringify(compensated.compensation_result));
  assert.equal(row(f, "SELECT state FROM erp_finance__document_posting").state, "reversed");
});

test("M3: a declaração recusa conta sem boleto operacional vivo e conta com baixa", t => {
  const f = fixture(t), plain = looseTitle(f);
  assert.throws(() => writeoff(f, plain), error("erp_finance_bank_writeoff_not_applicable"));
  const test = looseTitle(f);
  bankCollection(f, test.id, "homologation");
  assert.throws(() => writeoff(f, test), error("erp_finance_bank_writeoff_not_applicable"));
  const paid = looseTitle(f);
  bankCollection(f, paid.id, "operational");
  f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: paid.id, expected_version: paid.version,
    account_id: f.account.id, posted_on: COM1_DATE, principal_cents: "1000" } });
  assert.throws(() => writeoff(f, title(f, paid.id)), error("erp_finance_active_payments"));
  assert.equal(title(f, paid.id).cancelled, 0);
});
