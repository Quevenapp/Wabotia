import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { withErpMaintenance } from "../../../src/erp/engine/parts-gate.ts";
import { todaySaoPaulo } from "../../../src/erp/engine/time.ts";
import { commissionOperationCapture, commissionOperationSync } from "../../../src/erp/domains/finance/document-effects.ts";
import { insertTitle, updateTitle, titleOrigin } from "../../../src/erp/domains/finance/titles.ts";
import { titlesMarkReturned } from "../../../src/erp/domains/finance/title-returns.ts";
import { invoiceAutoFinance } from "../../../src/erp/domains/finance/invoice-guards.ts";
import { invoicePost } from "../../../src/erp/domains/finance/rpc/erp_finance_invoice_finance.ts";
import { erpDocumentFinancePost, erpDocumentFinanceReverse } from "../../../src/erp/domains/finance/rpc/erp_document_finance.ts";
import { erpFinanceGroupedBillingExecute } from "../../../src/erp/domains/finance/rpc/erp_finance_grouped_billing.ts";
import { erpDocumentStockPost, erpDocumentStockReverse } from "../../../src/erp/domains/stock/rpc/document-stock.ts";
import { erpStockReservationApply } from "../../../src/erp/domains/stock/rpc/reservations.ts";
import { applyWarehouse } from "../../../src/erp/domains/stock/rpc/purchase-receipts.ts";
import { saveInvoicePosting } from "../../../src/erp/domains/stock/rpc/invoice-stock.ts";
import { checkinWrite } from "../../../src/erp/domains/stock/rpc/checkin.ts";
import { compositionApplyValues } from "../../../src/erp/domains/stock/composition.ts";
import { post, postPhysical025, erpStockProductCompose, lotApply } from "../../../src/erp/domains/stock/public.ts";
import { orderEffects } from "../../../src/erp/domains/fiscal/invoices.ts";
import { listQuery } from "../../../src/erp/domains/fiscal/invoice-list.ts";

const admin = "11111111-1111-4111-8111-111111111111";
const actor = { user_id: admin, erp_role: "admin", is_agent: false, verified_factor: false, aal: "aal1", session_id: null, name: "Admin", email: null };
const identity = { actor, people: [actor] };
const disabled = error => error.code === "module_disabled";
const scoped = error => error.message === "erp_maintenance_scope_denied";
const day = todaySaoPaulo();
const reason = "Manutenção dos efeitos anteriores";

function fixture(t) {
  const lite = freshLite(), db = nodeDriver(lite);
  t.after(() => lite.close());
  const env = (parts = {}, maintenance) => ({ identity, parts, maintenance });
  const rpc = (name, args = {}, parts = {}, maintenance) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, env(parts, maintenance));
  const direct = (fn, parts = {}, maintenance) => inTransaction(db, ctx => maintenance ? withErpMaintenance(ctx, maintenance, () => fn(ctx)) : fn(ctx), undefined, env(parts));
  const row = (sql, ...args) => lite.prepare(sql).get(...args);
  const rows = (sql, ...args) => lite.prepare(sql).all(...args);
  const run = (sql, ...args) => lite.prepare(sql).run(...args);
  const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  const contact = catalog("contacts", { name: "Cliente e fornecedor", person_type: "J", roles: ["customer", "supplier"] });
  const product = catalog("products", { name: "Peça", unit: "UN", kind: "P", format: "S", price: "10" });
  const warehouse = catalog("warehouses", { name: "Depósito" });
  const seller = rpc("erp_catalog_seller_from_contact", { p_command_id: randomUUID(), p_contact_id: catalog("contacts", { name: "Vendedor" }).id }).seller.id;
  run("UPDATE erp_catalog__seller SET commission_rule='faturamento',commission_mode='fixa',commission_rate=100000,commission_bands='[]' WHERE id=?", seller);
  const version = id => row("SELECT version FROM erp_documents__document WHERE id=?", id).version;
  const transition = (d, status, parts = {}) => rpc("erp_document_transition", { p_kind: d.kind, p_id: d.id, p_expected_version: version(d.id), p_command_id: randomUUID(), p_status: status, p_reason: reason }, parts).document;
  const document = (kind = "sales_orders", parts = {}, extra = {}) => {
    let d = rpc("erp_document_save", { p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
      date: day, contact_id: contact.id, warehouse_id: warehouse.id, seller_id: kind === "sales_orders" ? seller : null,
      items: [{ product_id: product.id, description: "Peça", unit: "UN", quantity: "2", unit_price: "10" }],
      installments: [{ due_date: day, amount: "20" }], ...extra,
    } }, parts).document;
    if (d.status === "draft") d = transition(d, "open", parts);
    return transition(d, kind === "purchase_orders" ? "in_progress" : "verified", parts);
  };
  const stock = (quantity = "10") => rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: day, p_reason: "Saldo inicial", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity, expected_version: row("SELECT version FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product.id, warehouse.id)?.version ?? 0 }] });
  const balance = () => row("SELECT quantity FROM erp_stock__balance WHERE product_id=? AND warehouse_id=?", product.id, warehouse.id)?.quantity ?? 0;
  const origin = d => ({ type: d.kind, id: d.id });
  const maintenance = (d, action) => ({ origin: origin(d), action });
  const meta = d => ({ p_kind: d.kind, p_document_id: d.id, p_expected_version: version(d.id), p_occurred_on: day, p_reason: reason });
  const physicalMeta = d => { const { p_kind, ...args } = meta(d); return args; };
  const financePost = d => {
    const args = { p_kind: d.kind, p_document_id: d.id, p_expected_version: version(d.id), p_category_id: null, p_plan: null };
    const preview = rpc("erp_document_finance_preview", args).preview;
    return rpc("erp_document_finance_post", { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash });
  };
  const invoice = ({ direction = "1", document: d, withSeller = true } = {}) => {
    const id = randomUUID(), stamp = Date.now() * 1000;
    run(`INSERT INTO erp_fiscal_invoices__invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,created_at,updated_at,seller_id)
      VALUES(?,'55',?,'T',NULL,1,1,42,'Operação',?,'1','1','0',0,?,'[]','{}',?,'[]','{}',0,0,0,0,0,'{"total":20}',1,?,?,?,?,?)`,
      id, direction, day, JSON.stringify({ name: contact.name, contact_id: contact.id }), JSON.stringify({ installments: [{ date: day, amount: "20", method: "15" }] }), admin, admin, stamp, stamp, withSeller ? seller : null);
    run(`INSERT INTO erp_fiscal_invoices__invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
      VALUES(?,1,?,20000,'10',2000,0,0,0,0,?)`, id, product.id, JSON.stringify({ description: "Peça", unit: "UN" }));
    if (d) run("INSERT INTO erp_fiscal_invoices__invoice_order(invoice_id,document_id) VALUES(?,?)", id, d.id);
    return id;
  };
  return { db, env, rpc, direct, row, rows, run, contact, product, warehouse, seller, document, transition, version, stock, balance, maintenance, meta, physicalMeta, financePost, invoice };
}

test("comissão com vendedor: confirmação desligada não captura; religamento e leitura não recompõem", t => {
  const f = fixture(t), d = f.document("sales_orders", { finance: false });
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission_operation").n, 0);
  f.direct(ctx => { commissionOperationCapture(ctx, d.id); commissionOperationSync(ctx, d.id); }, { finance: false });
  f.rpc("erp_document_get", { p_kind: d.kind, p_id: d.id });
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission_operation").n, 0);
  f.direct(ctx => commissionOperationSync(ctx, d.id));
  const before = f.row("SELECT * FROM erp_finance__commission_operation WHERE document_id=?", d.id);
  assert.equal(before.estimated_cents, 200);
  f.run("UPDATE erp_documents__document SET total=4000,body=json_set(body,'$.seller_id',NULL) WHERE id=?", d.id);
  f.direct(ctx => commissionOperationCapture(ctx, d.id), { finance: false });
  assert.deepEqual(f.row("SELECT * FROM erp_finance__commission_operation WHERE document_id=?", d.id), before);
  f.transition(d, "cancelled", { finance: false });
  assert.equal(f.row("SELECT state FROM erp_finance__commission_operation WHERE id=?", before.id).state, "cancelled");
  assert.equal(f.row("SELECT amount_cents FROM erp_finance__commission_adjustment WHERE operation_id=?", before.id).amount_cents, -200);
  f.direct(ctx => commissionOperationCapture(ctx, d.id), { finance: false });
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission_adjustment").n, 1);
});

test("produtores diretos recusam criação antes de validar ou gravar efeitos", t => {
  const f = fixture(t), d = f.document(), purchase = f.document("purchase_orders"), invoice = f.invoice();
  const args = { p_user_id: admin, ...f.meta(d) };
  const checks = [
    [{ finance: false }, ctx => erpDocumentFinancePost(ctx, args)],
    [{ sales: false }, ctx => erpDocumentFinancePost(ctx, args)],
    [{ stock: false }, ctx => erpDocumentStockPost(ctx, args)],
    [{ stock: false }, ctx => erpStockReservationApply(ctx, { ...args, p_action: "reserve" })],
    [{ purchases: false }, ctx => applyWarehouse(ctx, admin, purchase.id, purchase.version, "receive", day, reason, [], null, randomUUID(), "x", true, null)],
    [{ finance: false }, ctx => insertTitle(ctx, {})],
    [{ finance: false }, ctx => titlesMarkReturned(ctx, admin, randomUUID(), [], { kind: "document_return", id: d.id })],
    [{ stock: false }, ctx => compositionApplyValues(ctx, admin, randomUUID(), f.product.id)],
    [{ stock: false }, ctx => post(ctx, {})],
    [{ stock: false }, ctx => postPhysical025(ctx, {})],
    [{ stock: false }, ctx => erpStockProductCompose(ctx, {})],
    [{ products: false }, ctx => erpStockProductCompose(ctx, {})],
    [{ stock: false }, ctx => lotApply(ctx, randomUUID(), f.product.id, f.warehouse.id, randomUUID(), 1n)],
    [{ fiscal: false }, ctx => saveInvoicePosting(ctx, { p_invoice_id: invoice }, { id: invoice }, {}, "invoice", "")],
    [{ stock: false }, ctx => checkinWrite(ctx, { p_invoice_id: invoice }, "save")],
  ];
  for (const [parts, fn] of checks) assert.throws(() => f.direct(fn, parts), disabled);
  assert.equal(f.row("SELECT count(*) n FROM erp_stock__movement").n, 0);
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__title").n, 0);
});

test("reserva histórica: liberar exige escopo, mantém saldo e replay; não permite consumir", t => {
  const f = fixture(t); f.stock(); const d = f.document();
  const args = { ...f.physicalMeta(d), p_action: "reserve" };
  const p = f.rpc("erp_stock_reservation_preview", args).preview;
  f.rpc("erp_stock_reservation_apply", { ...args, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_ignored_item_ids: p.ignored.map(i => i.id) });
  const r = f.row("SELECT id,version FROM erp_stock__reservation WHERE document_id=?", d.id);
  const off = { stock: false, sales: false }, scope = f.maintenance(d, "reservation_release_preview");
  const release = { ...f.physicalMeta(d), p_action: "release", p_reservation_id: r.id, p_reservation_version: r.version };
  assert.throws(() => f.rpc("erp_stock_reservation_preview", release, off), disabled);
  const preview = f.rpc("erp_stock_reservation_preview", release, off, scope).preview;
  scope.action = "reservation_release";
  const command = { ...release, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_ignored_item_ids: null };
  assert.throws(() => f.rpc("erp_stock_reservation_apply", { ...command, p_action: "consume" }, off, scope), scoped);
  f.rpc("erp_stock_reservation_apply", command, off, scope);
  assert.equal(f.balance(), 10_000_000);
  assert.equal(f.row("SELECT state FROM erp_stock__reservation WHERE id=?", r.id).state, "released");
  assert.equal(f.rpc("erp_stock_reservation_apply", command, off, scope).replayed, true);
});

test("recebimento físico: bloqueio, estorno com rollback e replay preservam movimentos", t => {
  const f = fixture(t), d = f.document("purchase_orders");
  const item = f.row("SELECT id FROM erp_documents__item WHERE document_id=?", d.id).id;
  const args = { ...f.physicalMeta(d), p_items: [{ item_id: item, quantity: "2" }] };
  const p = f.rpc("erp_purchase_receipts_preview", args).preview;
  const receive = { ...args, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_confirm: true };
  assert.throws(() => f.rpc("erp_purchase_receipts_receive", receive, { stock: false }), disabled);
  assert.equal(f.balance(), 0);
  const receipt = f.rpc("erp_purchase_receipts_receive", receive).receipt.receipt;
  const off = { purchases: false, stock: false }, scope = f.maintenance(d, "purchase_receipt_reverse_preview");
  const reverse = { ...f.physicalMeta(d), p_receipt_id: receipt.id };
  const preview = f.rpc("erp_purchase_receipts_reverse_preview", reverse, off, scope).preview;
  const command = { ...reverse, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash, p_confirm: true };
  scope.action = "purchase_receipt_reverse";
  assert.throws(() => f.direct(ctx => {
    applyWarehouse(ctx, admin, d.id, command.p_expected_version, "reverse", day, reason, null, receipt.id, command.p_command_id, command.p_preview_hash, true, null);
    throw new Error("rollback proposital");
  }, off, scope), /rollback proposital/);
  assert.equal(f.balance(), 2_000_000);
  assert.equal(f.row("SELECT count(*) n FROM erp_purchase_receipts__reversal").n, 0);
  f.rpc("erp_purchase_receipts_reverse", command, off, scope);
  assert.equal(f.balance(), 0);
  assert.equal(f.rpc("erp_purchase_receipts_reverse", command, off, scope).replayed, true);
  assert.equal(f.row("SELECT count(*) n FROM erp_stock__movement").n, 2);
});

test("baixa histórica bloqueia estorno; manutenção desfaz baixa e postagem sem reabrir criação", t => {
  const f = fixture(t), d = f.document(), posted = f.financePost(d), title = posted.titles[0];
  assert.equal(f.row("SELECT commission_cents FROM erp_finance__commission WHERE title_id=?", title.id).commission_cents, 200);
  const invoice = f.invoice({ document: d });
  assert.equal(f.direct(ctx => orderEffects(ctx, invoice), { finance: false, sales: false }).finance, true);
  const account = f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  const first = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: title.id, expected_version: title.version, account_id: account.id, posted_on: day, principal_cents: "1000" } }, { sales: false });
  const settled = f.rpc("erp_finance_execute", { p_command_id: randomUUID(), p_action: "settle", p_data: { id: title.id, expected_version: first.record.version, account_id: account.id, posted_on: day, principal_cents: "1000" } }, { sales: false });
  assert.ok(f.direct(ctx => titleOrigin(ctx.db, title.id), { sales: false }));
  const off = { finance: false, sales: false }, scope = f.maintenance(d, "document_finance_reverse_preview");
  const args = { p_kind: d.kind, p_document_id: d.id, p_expected_version: f.version(d.id), p_posting_id: posted.posting.id, p_posting_version: posted.posting.version };
  assert.throws(() => f.rpc("erp_document_finance_reverse_preview", args, off, scope), /reverse_blocked/);
  const titleScope = { origin: { type: "receivables", id: title.id }, action: "settlement_reverse" };
  const reversePayment = { p_command_id: randomUUID(), p_action: "reverse", p_data: { id: title.id, expected_version: settled.record.version, settlement_id: settled.settlement.id, posted_on: day, note: reason } };
  f.rpc("erp_finance_execute", reversePayment, off, titleScope);
  assert.equal(f.rpc("erp_finance_execute", reversePayment, off, titleScope).replayed, true);
  const partial = f.row("SELECT * FROM erp_finance__title WHERE id=?", title.id);
  assert.equal(partial.settled_cents, 1000);
  assert.throws(() => f.direct(ctx => updateTitle(ctx, title.id, { settled_cents: 0, version: partial.version + 1 }), off, titleScope), scoped);
  f.rpc("erp_finance_execute", { ...reversePayment, p_command_id: randomUUID(), p_data: { ...reversePayment.p_data, settlement_id: first.settlement.id, expected_version: partial.version } }, off, titleScope);
  const preview = f.rpc("erp_document_finance_reverse_preview", args, off, scope).preview;
  scope.action = "document_finance_reverse";
  const command = { ...args, p_command_id: randomUUID(), p_reason: reason, p_preview_hash: preview.preview_hash, p_title_versions: preview.titles.map(t => ({ id: t.id, version: t.version })) };
  assert.throws(() => f.direct(ctx => insertTitle(ctx, {}), off, scope), scoped);
  assert.throws(() => f.direct(ctx => updateTitle(ctx, title.id, { amount_cents: 5000, version: preview.titles[0].version + 1 }), off, scope), scoped);
  assert.throws(() => f.direct(ctx => { erpDocumentFinanceReverse(ctx, { p_user_id: admin, ...command }); throw new Error("rollback financeiro"); }, off, scope), /rollback financeiro/);
  assert.equal(f.row("SELECT state FROM erp_finance__document_posting WHERE id=?", posted.posting.id).state, "active");
  f.rpc("erp_document_finance_reverse", command, off, scope);
  assert.equal(f.rpc("erp_document_finance_reverse", command, off, scope).replayed, true);
  assert.equal(f.row("SELECT cancelled FROM erp_finance__title WHERE id=?", title.id).cancelled, 1);
});

test("agrupamento misto exige as origens selecionadas, filtra candidatos e desfaz histórico", t => {
  const f = fixture(t), d = f.document(), invoice = f.invoice();
  const query = { p_from: day, p_to: day, p_page: 1, p_limit: 50 };
  const onlyFiscal = f.rpc("erp_finance_grouped_billing_candidates", query, { sales: false }).items[0];
  assert.deepEqual(f.rpc("erp_finance_grouped_billing_candidates", query, { sales: false }).unavailable_parts, ["sales"]);
  assert.equal(onlyFiscal.documents, 0); assert.equal(onlyFiscal.invoices, 1); assert.equal(onlyFiscal.total_cents, "2000");
  const onlySales = f.rpc("erp_finance_grouped_billing_candidates", query, { fiscal: false }).items[0];
  assert.equal(onlySales.documents, 1); assert.equal(onlySales.invoices, 0);
  const data = { items: [{ contact_id: f.contact.id, document_ids: [d.id], invoice_ids: [invoice], total_cents: "4000", condition: "À vista", days: [0] }] };
  const args = { p_user_id: admin, p_command_id: randomUUID(), p_action: "grouped_billing_generate", p_data: data };
  for (const parts of [{ sales: false }, { fiscal: false }, { finance: false }])
    assert.throws(() => f.direct(ctx => erpFinanceGroupedBillingExecute(ctx, args), parts), disabled);
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__grouped_billing").n, 0);
  const billing = f.rpc("erp_finance_grouped_billing_execute", args).items[0];
  const scope = { origin: { type: "grouped_billing", id: billing.id }, action: "grouped_billing_delete" }, off = { finance: false, sales: false, fiscal: false };
  const remove = { p_command_id: randomUUID(), p_action: "grouped_billing_delete", p_data: { id: billing.id, expected_version: billing.version } };
  f.rpc("erp_finance_grouped_billing_execute", remove, off, scope);
  assert.equal(f.rpc("erp_finance_grouped_billing_execute", remove, off, scope).replayed, true);
  assert.equal(f.row("SELECT active FROM erp_finance__grouped_billing_document WHERE billing_id=?", billing.id).active, 0);
  assert.equal(f.row("SELECT active FROM erp_finance__grouped_billing_invoice WHERE billing_id=?", billing.id).active, 0);
});

test("nota: produtor financeiro direto e automação obedecem destino e pedido associado", t => {
  const f = fixture(t), d = f.document("purchase_orders"), invoice = f.invoice({ direction: "0", document: d });
  const preview = f.rpc("erp_finance_invoice_finance_preview", { p_invoice_id: invoice, p_expected_version: 1 }).preview;
  const data = { invoice_id: invoice, expected_version: 1, preview_hash: preview.preview_hash };
  for (const parts of [{ finance: false }, { fiscal: false }, { purchases: false }]) {
    assert.throws(() => f.direct(ctx => invoicePost(ctx, admin, randomUUID(), data, "manual"), parts), disabled);
    f.direct(ctx => invoiceAutoFinance(ctx, "INSERT", null, f.row("SELECT * FROM erp_fiscal_invoices__invoice WHERE id=?", invoice)), parts);
  }
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__invoice_posting").n, 0);
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission").n, 0);
  assert.throws(() => f.direct(ctx => listQuery(ctx, { p_category_id: randomUUID() }), { finance: false }), disabled);
  const listed = f.rpc("erp_fiscal_invoice_list", { p_origin: "brufap", p_model: "55", p_direction: "0", p_page: 1, p_limit: 50, p_order: "date_desc", p_date_type: "issue" }, { finance: false });
  assert.ok(listed);
});

test("estoque histórico mantém origem e trava alteração; estorno exige prévia e escopo", t => {
  const f = fixture(t), d = f.document("purchase_orders");
  const args = f.meta(d), p = f.rpc("erp_document_stock_preview", args).preview;
  const posted = f.rpc("erp_document_stock_post", { ...args, p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_ignored_item_ids: p.ignored.map(i => i.id) });
  const lotLine = f.rpc("erp_stock_movement_lots", { p_movement_id: posted.movement.id, p_product_id: f.product.id, p_warehouse_id: f.warehouse.id }, { purchases: false });
  assert.equal(lotLine.line.origin.document_id, d.id);
  assert.throws(() => f.rpc("erp_stock_source_lots", { p_source: "document", p_source_id: d.id, p_product_id: f.product.id }, { purchases: false }), disabled);
  assert.throws(() => f.rpc("erp_document_stock_post", { ...f.meta(d), p_command_id: randomUUID(), p_preview_hash: p.preview_hash, p_ignored_item_ids: [] }), /already_posted/);
  const off = { purchases: false, stock: false }, scope = f.maintenance(d, "document_stock_reverse_preview");
  const reverse = { ...f.meta(d), p_posting_id: posted.posting.id, p_posting_version: posted.posting.version };
  assert.throws(() => f.direct(ctx => erpDocumentStockReverse(ctx, reverse), off), disabled);
  const preview = f.rpc("erp_document_stock_reverse_preview", reverse, off, scope).preview;
  const command = { ...reverse, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash };
  scope.action = "document_stock_reverse";
  assert.throws(() => f.rpc("erp_document_stock_reverse", { ...command, p_preview_hash: "0".repeat(64) }, off, scope), /preview_conflict/);
  assert.equal(f.balance(), 2_000_000);
  f.rpc("erp_document_stock_reverse", command, off, scope);
  assert.equal(f.rpc("erp_document_stock_reverse", command, off, scope).replayed, true);
  assert.equal(f.balance(), 0);
});

test("PDV indisponível não grava pending e cancelamento histórico compensa comissão", t => {
  const f = fixture(t);
  const data = { sale_id: null, expected_version: 0, document_version: null, kind: "balcao", table_number: null, account_id: null, cash_session_id: null,
    contact_id: f.contact.id, price_list_id: null, document: { date: day, seller_id: f.seller, items: [{ product_id: f.product.id, description: "Peça", unit: "UN", quantity: "2", unit_price: "10" }] },
    payments: [], destination_account_id: null, to_ledger: false, cash_received_cents: null };
  const args = { p_command_id: randomUUID(), p_action: "sale_save", p_data: data };
  for (const part of ["pos", "sales", "finance", "stock", "products"]) {
    assert.throws(() => f.rpc("erp_pos_sale_execute", { ...args, p_action: "sale_finish" }, { [part]: false }), disabled);
    assert.throws(() => f.rpc("erp_pos_return_execute", { p_command_id: randomUUID(), p_action: "return", p_data: {} }, { [part]: false }), disabled);
  }
  assert.equal(f.row("SELECT count(*) n FROM erp_pos__sale").n, 0);
  const sale = f.rpc("erp_pos_sale_execute", args).record;
  // Preparação de operação histórica, sem depender do acabamento comercial de outra frente.
  f.run("UPDATE erp_documents__document SET status='verified' WHERE id=?", sale.document_id);
  f.direct(ctx => commissionOperationSync(ctx, sale.document_id));
  const off = { pos: false, sales: false, finance: false, stock: false }, scope = { origin: { type: "pos_sale", id: sale.id }, action: "pos_sale_cancel" };
  const cancel = { p_command_id: randomUUID(), p_action: "sale_cancel", p_data: { sale_id: sale.id, expected_version: sale.version, reason } };
  assert.equal(f.rpc("erp_pos_sale_execute", cancel, off, scope).record.state, "cancelled");
  assert.equal(f.rpc("erp_pos_sale_execute", cancel, off, scope).replayed, true);
  assert.equal(f.row("SELECT state FROM erp_finance__commission_operation WHERE document_id=?", sale.document_id).state, "cancelled");
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission_adjustment").n, 1);
  assert.throws(() => f.rpc("erp_pos_sale_execute", args, off, scope), scoped);
});

test("comissão por nota e títulos históricos: estorno desligado conserva os vínculos", t => {
  const f = fixture(t), invoice = f.invoice();
  const preview = f.rpc("erp_finance_invoice_finance_preview", { p_invoice_id: invoice, p_expected_version: 1 }).preview;
  const postArgs = { p_command_id: randomUUID(), p_data: { invoice_id: invoice, expected_version: 1, preview_hash: preview.preview_hash } };
  assert.throws(() => f.rpc("erp_finance_invoice_finance_post", postArgs, { finance: false }), disabled);
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__commission").n, 0);
  const posted = f.rpc("erp_finance_invoice_finance_post", postArgs);
  const commission = f.row("SELECT * FROM erp_finance__commission WHERE title_id=?", posted.titles[0].id);
  assert.equal(commission.commission_cents, 200);
  const scope = { origin: { type: "nfe", id: invoice }, action: "invoice_finance_reverse" };
  const args = { p_command_id: randomUUID(), p_data: { invoice_id: invoice, posting_id: posted.posting.id, expected_version: 1,
    titles: posted.titles.map(t => ({ id: t.id, version: t.version })), reason } };
  const off = { finance: false, fiscal: false };
  assert.throws(() => f.rpc("erp_finance_invoice_finance_reverse", { ...args, p_data: { ...args.p_data, titles: [] } }, off, scope), /invalid_items/);
  f.rpc("erp_finance_invoice_finance_reverse", args, off, scope);
  assert.equal(f.rpc("erp_finance_invoice_finance_reverse", args, off, scope).replayed, true);
  assert.equal(f.row("SELECT cancelled FROM erp_finance__title WHERE id=?", posted.titles[0].id).cancelled, 1);
  assert.deepEqual(f.row("SELECT * FROM erp_finance__commission WHERE id=?", commission.id), commission);
});

test("check-in só termina com movimento; nota histórica pode estornar com Compras e Estoque desligados", t => {
  const f = fixture(t), d = f.document("purchase_orders"), invoice = f.invoice({ direction: "0", document: d });
  const save = { p_command_id: randomUUID(), p_invoice_id: invoice, p_expected_version: 0, p_items: [{ position: 1, received: "2" }] };
  for (const parts of [{ stock: false }, { purchases: false }, { fiscal: false }])
    assert.throws(() => f.rpc("erp_stock_checkin_save", save, parts), disabled);
  f.rpc("erp_stock_checkin_save", save);
  const args = { p_invoice_id: invoice, p_expected_version: 1, p_warehouse_id: f.warehouse.id };
  const preview = f.rpc("erp_stock_checkin_post_preview", args).preview;
  const finish = { ...args, p_command_id: randomUUID(), p_preview_hash: preview.preview_hash };
  assert.throws(() => f.rpc("erp_stock_checkin_finish_post", finish, { stock: false }), disabled);
  assert.equal(f.row("SELECT state FROM erp_stock__checkin WHERE invoice_id=?", invoice).state, "in_progress");
  assert.equal(f.balance(), 0);
  const posted = f.rpc("erp_stock_checkin_finish_post", finish);
  assert.equal(f.balance(), 2_000_000);
  assert.equal(posted.posting.source, "checkin");
  const off = { stock: false, purchases: false, fiscal: false }, scope = { origin: { type: "nfe", id: invoice }, action: "invoice_stock_reverse_preview" };
  const reverse = { p_invoice_id: invoice, p_posting_id: posted.posting.id, p_posting_version: 1 };
  const p = f.rpc("erp_stock_invoice_reverse_preview", reverse, off, scope).preview;
  scope.action = "invoice_stock_reverse";
  const command = { ...reverse, p_command_id: randomUUID(), p_preview_hash: p.preview_hash };
  f.rpc("erp_stock_invoice_reverse", command, off, scope);
  assert.equal(f.rpc("erp_stock_invoice_reverse", command, off, scope).replayed, true);
  assert.equal(f.balance(), 0);
});

test("automação de nota confere também o agendamento e não escapa pela manutenção", t => {
  const f = fixture(t), invoice = f.invoice({ direction: "0" });
  const current = f.rpc("erp_preferences_page", { p_page: "notas-nfe" }).items.find(p => p.key === "nfe.contas_pagar_entrada");
  f.rpc("erp_preferences_save", { p_page: "notas-nfe", p_command_id: randomUUID(), p_changes: [{ key: current.key, expected_version: current.version, value: true }] });
  const note = f.row("SELECT * FROM erp_fiscal_invoices__invoice WHERE id=?", invoice);
  f.direct(ctx => invoiceAutoFinance(ctx, "INSERT", null, note), { finance: false });
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__invoice_posting").n, 0);
  const d = f.document(), posted = f.financePost(d), scope = f.maintenance(d, "document_finance_reverse");
  assert.throws(() => f.direct(ctx => invoiceAutoFinance(ctx, "INSERT", null, note), {}, scope), scoped);
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__invoice_posting").n, 0);
  assert.throws(() => f.direct(ctx => erpDocumentFinancePost(ctx, { p_document_id: d.id, p_kind: d.kind }), {}, scope), scoped);
  assert.equal(f.row("SELECT state FROM erp_finance__document_posting WHERE id=?", posted.posting.id).state, "active");
  f.direct(ctx => invoiceAutoFinance(ctx, "INSERT", null, note));
  assert.equal(f.row("SELECT count(*) n FROM erp_finance__invoice_posting").n, 1);
});
