import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { costApply } from "../../../src/erp/domains/documents/cost-apply.ts";
import { checkCreditLimit } from "../../../src/erp/domains/documents/save-checks.ts";

const admin = "11111111-1111-4111-8111-111111111111";
const actor = { user_id: admin, erp_role: "admin", is_agent: false, verified_factor: false, aal: "aal1", session_id: null, name: "Admin", email: null };
const identity = { actor, people: [actor] };
const disabled = e => e.code === "module_disabled";
const off = { stock: false, finance: false };
const details = (account) => ({ account_id: account, payment_type: null, card_brand: null, integration_type: null,
  acquirer_cnpj: null, authorization_code: null, received_amount: null, fee_amount: "1.00", commission_fee_amount: "0.50" });

function fixture(t) {
  const lite = freshLite(), base = nodeDriver(lite), queries = [];
  const db = { ...base, exec(sql, ...params) { queries.push(sql); return base.exec(sql, ...params); } };
  t.after(() => lite.close());
  const env = parts => ({ identity, parts: normalizeErpParts(parts) });
  const rpc = (name, args = {}, parts = {}) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, env(parts));
  const catalog = (entity, data) => rpc("erp_catalog_save", { p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: data }).record;
  const contact = catalog("contacts", { name: "Cliente e fornecedor", person_type: "J", roles: ["customer", "supplier"] });
  const product = catalog("products", { name: "Produto", unit: "UN", kind: "P", format: "S", price: "10" });
  const warehouse = catalog("warehouses", { name: "Depósito" });
  const category = rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create", p_data: { kind: "receivable", name: "Vendas" } }).record;
  const account = rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-01", p_reason: "Saldo para os testes", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "100", expected_version: 0 }] });
  const body = (extra = {}) => ({ date: "2026-10-15", contact_id: contact.id,
    items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "1", unit_price: "10" }],
    installments: [{ due_date: "2026-11-20", amount: "10" }], ...extra });
  const saveArgs = (input, doc = null, kind = doc?.kind ?? "sales_orders") => ({ p_kind: kind, p_id: doc?.id ?? null,
    p_expected_version: doc?.version ?? 0, p_command_id: randomUUID(), p_body: input });
  const save = (input = body(), parts = {}, doc = null, kind) => rpc("erp_document_save", saveArgs(input, doc, kind), parts);
  const editBody = doc => {
    const stored = JSON.parse(lite.prepare("SELECT body FROM erp_documents__document WHERE id=?").get(doc.id).body);
    delete stored.totals;
    stored.installments = stored.installments.map(({ position, ...p }) => p);
    return { ...stored, items: lite.prepare("SELECT data FROM erp_documents__item WHERE document_id=? ORDER BY position").all(doc.id).map(i => {
      const data = JSON.parse(i.data);
      for (const key of ["total", "position", "gross", "discount"]) delete data[key];
      return data;
    }) };
  };
  const transitionArgs = (doc, status) => ({ p_kind: doc.kind, p_id: doc.id, p_expected_version: doc.version,
    p_command_id: randomUUID(), p_status: status, p_reason: "Mudança explícita de situação" });
  const transition = (doc, status, parts = {}) => rpc("erp_document_transition", transitionArgs(doc, status), parts);
  const rule = (from, to, actions, kind = "sales_orders") => {
    lite.prepare("INSERT OR IGNORE INTO erp_preferences__situation_adoption(kind,migration) VALUES(?, 'f2-test')").run(kind);
    const old = lite.prepare("SELECT version,active,actions FROM erp_preferences__transition WHERE kind=? AND from_key=? AND to_key=?").get(kind, from, to);
    if (old?.active && JSON.stringify(JSON.parse(old.actions)) === JSON.stringify(actions)) return;
    const version = old?.version ?? 0;
    try {
      rpc("erp_preferences_transition_save", { p_command_id: randomUUID(), p_kind: kind, p_from: from, p_to: to,
        p_expected_version: version, p_data: { active: true, actions } });
    } catch (e) {
      if (e.message !== "erp_preferences_transition_unchanged") throw e;
      const current = rpc("erp_document_situations", { p_kind: kind }).transitions.find(r => r.from === from && r.to === to);
      assert.equal(current.active, true);
      assert.deepEqual(current.actions, actions);
    }
  };
  const pref = (page, key, value) => {
    const old = rpc("erp_preferences_page", { p_page: page }).items.find(i => i.key === key);
    rpc("erp_preferences_save", { p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: old.version, value }] });
  };
  const count = (table, id) => lite.prepare(`SELECT count(*) n FROM "${table}" WHERE document_id=?`).get(id).n;
  return { lite, db, queries, env, rpc, contact, product, warehouse, category, account, body, saveArgs, save, editBody, transitionArgs, transition, rule, pref, count };
}

for (const stock of [false, true]) for (const finance of [false, true]) test(`venda atendida: estoque=${stock}, financeiro=${finance}`, t => {
  const f = fixture(t), parts = { stock, finance };
  f.rule("open", "fulfilled", ["post_stock", "post_finance"]);
  const doc = f.save(f.body({ ...(stock ? { warehouse_id: f.warehouse.id } : {}), ...(finance ? { category_id: f.category.id } : {}) }), parts).document;
  const args = f.transitionArgs(doc, "fulfilled");
  const result = f.rpc("erp_document_transition", args, parts);
  assert.equal(result.document.status, "fulfilled");
  for (const [part, enabled] of Object.entries(parts)) {
    const effect = result.effects.find(e => e.action === `post_${part}`);
    assert.equal(effect.outcome, enabled ? "done" : "skipped");
    if (!enabled) assert.equal(effect.reason, "part_disabled");
    assert.equal(f.count(`erp_${part}__document_posting`, doc.id), enabled ? 1 : 0);
  }
  const replay = f.rpc("erp_document_transition", args);
  assert.deepEqual(replay.effects, result.effects);
  assert.equal(replay.replayed, true);
  assert.equal(f.count("erp_stock__document_posting", doc.id), stock ? 1 : 0);
  assert.equal(f.count("erp_finance__document_posting", doc.id), finance ? 1 : 0);
});

test("proposta, compra e OS nascem sem depósito/categoria; compra automática pula antes da prévia", t => {
  const f = fixture(t);
  f.pref("suprimentos-compras", "compras.automacao_contas_pagar", true);
  for (const kind of ["sales_proposals", "purchase_orders", "service_orders"]) {
    const args = f.saveArgs(f.body(), null, kind), r = f.rpc("erp_document_save", args, off);
    assert.equal(r.document.warehouse_id, null);
    assert.equal(f.count("erp_finance__document_posting", r.document.id), 0);
    if (kind === "purchase_orders") assert.deepEqual(r.auto_finance, { outcome: "skipped", reason: "part_disabled" });
    assert.equal(f.rpc("erp_document_save", args).replayed, true);
    assert.equal(f.count("erp_finance__document_posting", r.document.id), 0);
  }
});

test("religar não recompõe; nova edição elegível lança contas e replay conserva a decisão", t => {
  const f = fixture(t);
  f.pref("vendas-vendas", "vendas.contas_automaticas_pedido", true);
  f.rule("open", "verified", []);
  let doc = f.save(f.body({ category_id: f.category.id })).document;
  doc = f.transition(doc, "verified", off).document;
  const args = f.saveArgs(f.editBody(doc), doc);
  const skipped = f.rpc("erp_document_save", args, off);
  assert.equal(skipped.auto_finance.reason, "part_disabled");
  assert.deepEqual(f.rpc("erp_document_save", args).auto_finance, skipped.auto_finance);
  f.rpc("erp_document_get", { p_kind: doc.kind, p_id: doc.id });
  assert.equal(f.count("erp_finance__document_posting", doc.id), 0);
  const next = f.save(f.editBody(skipped.document), {}, skipped.document);
  assert.equal(next.auto_finance.outcome, "done");
  assert.equal(f.count("erp_finance__document_posting", doc.id), 1);
});

test("falha financeira desfaz estoque, situação e recibo da mesma transação", t => {
  const f = fixture(t);
  f.rule("open", "fulfilled", ["post_stock", "post_finance"]);
  const doc = f.save(f.body({ warehouse_id: f.warehouse.id })).document;
  const args = f.transitionArgs(doc, "fulfilled");
  assert.throws(() => f.rpc("erp_document_transition", args), /erp_document_transition_category_required/);
  assert.equal(f.count("erp_stock__document_posting", doc.id), 0);
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document WHERE id=?").get(doc.id).status, "open");
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__command WHERE command_id=?").get(args.p_command_id).n, 0);
  assert.equal(f.rpc("erp_document_transition", args, { finance: false }).document.status, "fulfilled");
});

test("campos suspensos omitidos e iguais são preservados; troca e limpeza são recusadas", t => {
  const f = fixture(t);
  let doc = f.save(f.body({ warehouse_id: f.warehouse.id, category_id: f.category.id, payment_account_id: f.account.id,
    installments: [{ due_date: "2026-11-20", amount: "10", payment_method_id: null, details: details(f.account.id) }] })).document;
  const input = f.editBody(doc);
  for (const key of ["warehouse_id", "category_id", "payment_account_id"]) delete input[key];
  for (const key of ["account_id", "fee_amount", "commission_fee_amount"]) delete input.installments[0].details[key];
  input.installments[0].due_date = "2026-12-01";
  doc = f.save(input, off, doc).document;
  assert.equal(doc.warehouse_id, f.warehouse.id);
  assert.equal(doc.category_id, f.category.id);
  assert.equal(doc.payment_account_id, f.account.id);
  assert.deepEqual(doc.installments[0].details, details(f.account.id));
  assert.equal(doc.installments[0].due_date, "2026-12-01");
  const equalValue = f.editBody(doc); equalValue.installments[0].details.fee_amount = "1";
  doc = f.save(equalValue, off, doc).document;
  const omittedPlan = f.editBody(doc); delete omittedPlan.installments;
  doc = f.save(omittedPlan, off, doc).document;
  assert.deepEqual(doc.installments[0].details, details(f.account.id));
  const smaller = f.editBody(doc); smaller.items[0].unit_price = "0.25"; smaller.installments[0].amount = "0.25";
  doc = f.save(smaller, off, doc).document;
  assert.equal(doc.totals.total, "0.25");
  assert.deepEqual(doc.installments[0].details, details(f.account.id));
  doc = f.save(f.editBody(doc), off, doc).document;
  for (const key of ["warehouse_id", "category_id", "payment_account_id"]) for (const value of [null, randomUUID()])
    assert.throws(() => f.save({ ...f.editBody(doc), [key]: value }, off, doc), disabled);
  for (const key of ["account_id", "fee_amount", "commission_fee_amount"]) {
    const body = f.editBody(doc); body.installments[0].details[key] = null;
    assert.throws(() => f.save(body, off, doc), disabled);
  }
  for (const value of [null, undefined]) {
    const body = f.editBody(doc);
    if (value === undefined) delete body.installments[0].details; else body.installments[0].details = null;
    if (value === null) assert.throws(() => f.save(body, off, doc), disabled);
    else doc = f.save(body, off, doc).document;
  }
  assert.throws(() => f.save({ ...f.editBody(doc), installments: [] }, off, doc), disabled);
  assert.throws(() => f.save({ ...f.editBody(doc), installments: null }, off, doc), disabled);
  assert.throws(() => f.save(f.body({ warehouse_id: randomUUID() }), off), disabled);
  assert.throws(() => f.save(f.body({ category_id: randomUUID() }), off), disabled);
});

test("cópia limpa referências opcionais e continua comercial", t => {
  const f = fixture(t);
  const doc = f.save(f.body({ warehouse_id: f.warehouse.id, category_id: f.category.id, payment_account_id: f.account.id })).document;
  const preview = f.rpc("erp_document_copy_preview", { p_kind: doc.kind, p_source_id: doc.id }, off);
  assert.equal(preview.data.warehouse_id, null);
  assert.equal(preview.data.category_id, null);
  assert.equal(preview.data.payment_account_id, null);
  const copied = f.rpc("erp_document_copy", { p_kind: doc.kind, p_source_id: doc.id, p_expected_source_version: doc.version,
    p_command_id: randomUUID(), p_body: preview.data }, off).document;
  assert.equal(copied.warehouse_id, null);
  assert.equal(copied.category_id, null);
  assert.equal(f.count("erp_finance__document_posting", copied.id), 0);
});

test("efeitos antigos mantêm flags e guardas; estornos funcionam desligados e repetem recibo", t => {
  const f = fixture(t);
  f.rule("open", "verified", ["post_stock", "post_finance"]);
  f.rule("verified", "cancelled", ["reverse_stock", "reverse_finance"]);
  let doc = f.save(f.body({ warehouse_id: f.warehouse.id, category_id: f.category.id })).document;
  doc = f.transition(doc, "verified").document;
  const read = f.rpc("erp_document_get", { p_kind: doc.kind, p_id: doc.id }, off).document;
  assert.equal(read.effect_flags.stock_active, true);
  assert.equal(read.effect_flags.finance_active, true);
  const changed = f.editBody(doc); changed.items[0].unit_price = "11"; changed.installments[0].amount = "11";
  assert.throws(() => f.save(changed, off, doc), /erp_document_active_finance|erp_document_active_stock/);
  const trash = f.rpc("erp_document_trash", { p_kind: doc.kind, p_action: "delete", p_ids: [doc.id], p_reason: "Excluir documento", p_command_id: randomUUID() }, off);
  assert.equal(trash.results[0].ok, false);
  const args = f.transitionArgs(doc, "cancelled"), cancelled = f.rpc("erp_document_transition", args, off);
  assert.ok(cancelled.effects.every(e => e.outcome === "done"));
  assert.equal(cancelled.document.effect_flags.stock_active, false);
  assert.equal(cancelled.document.effect_flags.finance_active, false);
  assert.deepEqual(f.rpc("erp_document_transition", args, off).effects, cancelled.effects);
});

test("estornos sem efeito ativo são pulados com o motivo da parte suspensa", t => {
  const f = fixture(t);
  f.rule("open", "cancelled", ["reverse_stock", "reverse_finance"]);
  const doc = f.save(f.body(), off).document;
  const result = f.transition(doc, "cancelled", off);
  assert.equal(result.effects.length, 2);
  assert.ok(result.effects.every(e => e.outcome === "skipped" && e.reason === "part_disabled"));
});

test("custo exige Vendas, Compras e Estoque, sem consultar fonte suspensa e sem apagar histórico", t => {
  const f = fixture(t);
  f.lite.prepare("INSERT INTO erp_catalog__product_supplier(record_id,position,supplier_id,cost_price,is_default) VALUES(?,1,?,'4',1)").run(f.product.id, f.contact.id);
  f.rule("open", "verified", []);
  const doc = f.transition(f.save(f.body(), off).document, "verified", off).document;
  for (const part of ["sales", "purchases", "stock"]) {
    f.queries.length = 0;
    assert.equal(inTransaction(f.db, ctx => costApply(ctx, doc.id), undefined, f.env({ [part]: false })), 0);
    assert.equal(f.queries.length, 0);
  }
  assert.equal(f.count("erp_documents__item_cost_applied", doc.id), 0);
  assert.equal(inTransaction(f.db, ctx => costApply(ctx, doc.id), undefined, f.env({})), 1);
  assert.equal(inTransaction(f.db, ctx => costApply(ctx, doc.id), undefined, f.env(off)), 0);
  assert.equal(f.count("erp_documents__item_cost_applied", doc.id), 1);
});

test("consultas comerciais omitem seções suspensas sem consultar contas, composição ou custo", t => {
  const f = fixture(t), parts = { ...off, fiscal: false, purchases: false };
  f.pref("vendas-vendas", "vendas.checkout_desmembrar", true);
  const doc = f.save(f.body(), parts).document;
  f.queries.length = 0;
  const access = f.rpc("erp_document_access", {}, parts);
  assert.ok(!access.read.includes("purchase_orders"));
  assert.ok(!Object.hasOwn(access.settings, "cross_docking_days"));
  const payment = f.rpc("erp_document_payment_options", { p_kind: doc.kind }, parts);
  assert.ok(!Object.hasOwn(payment, "accounts"));
  const structure = f.rpc("erp_document_structures", { p_kind: doc.kind, p_document_id: doc.id }, parts);
  assert.ok(!Object.hasOwn(structure, "items"));
  const history = f.rpc("erp_document_history", { p_kind: doc.kind, p_contact_id: f.contact.id, p_limit: 20 }, parts);
  assert.equal(history.finance, null);
  assert.equal(history.invoices_included, false);
  const checkout = f.rpc("erp_document_checkout_get", { p_id: doc.id }, parts);
  assert.equal(checkout.split, false);
  assert.equal(checkout.lines.length, 1);
  const options = f.rpc("erp_document_sales_report_options", {}, parts);
  assert.equal(options.profit_visible, false);
  assert.equal(options.invoice_visible, false);
  assert.ok(!f.queries.some(q => /erp_finance__(account|category|title)|erp_stock__composition|erp_documents__item_cost_applied/.test(q)));
  assert.throws(() => f.rpc("erp_document_sales_report", { p_filters: { from: "2026-10-01", to: "2026-10-31", show_profit: true } }, parts), disabled);
  assert.throws(() => f.rpc("erp_document_sales_report", { p_filters: { from: "2026-10-01", to: "2026-10-31", category_ids: [f.category.id] } }, parts), disabled);
});

test("limite operacional de crédito suspenso antes de qualquer consulta", () => {
  const db = { exec() { throw new Error("Crédito suspenso não pode consultar saldo"); } };
  checkCreditLimit(db, admin, "sales_proposals", {}, null, normalizeErpParts({ finance: false }));
});

test("lotes antigos são preservados sem consultar lote; inclusão, troca e limpeza ficam indisponíveis", t => {
  const f = fixture(t);
  f.rpc("erp_catalog_product_save", { p_id: f.product.id, p_expected_version: f.product.version, p_command_id: randomUUID(),
    p_data: { name: f.product.name, lot_control: true }, p_acknowledged: null });
  const lot = f.rpc("erp_stock_lot_save", { p_command_id: randomUUID(), p_product_id: f.product.id, p_lot_id: null, p_expected_version: 0, p_code: "L-1" }).lot;
  const input = f.body(); input.items[0].lots = [{ lot_id: lot.id, quantity: "1" }];
  let doc = f.save(input).document;
  const next = f.editBody(doc); delete next.items[0].lots;
  f.queries.length = 0;
  doc = f.save(next, off, doc).document;
  assert.deepEqual(doc.items[0].lots, [{ lot_id: lot.id, quantity: "1.000000" }]);
  assert.ok(!f.queries.some(q => /FROM "erp_stock__lot"/.test(q)));
  const equalValue = f.editBody(doc); equalValue.items[0].lots[0].quantity = "1";
  doc = f.save(equalValue, off, doc).document;
  const larger = f.editBody(doc); larger.items[0].quantity = "2"; larger.installments[0].amount = "20";
  doc = f.save(larger, off, doc).document;
  assert.equal(doc.items[0].quantity, "2.000000");
  assert.deepEqual(doc.items[0].lots, [{ lot_id: lot.id, quantity: "1.000000" }]);
  for (const value of [null, [], [{ lot_id: randomUUID(), quantity: "1" }]]) {
    const changed = f.editBody(doc); changed.items[0].lots = value;
    assert.throws(() => f.save(changed, off, doc), disabled);
  }
  assert.throws(() => f.save(input, off), disabled);
});

test("comissão congelada na confirmação, edição e troca de vendedor; cancelamento compensa a anterior", t => {
  const f = fixture(t);
  const seller = () => {
    const contact = f.rpc("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Vendedor" } }).record;
    const s = f.rpc("erp_catalog_seller_from_contact", { p_contact_id: contact.id, p_command_id: randomUUID() }).seller;
    f.lite.prepare("UPDATE erp_catalog__seller SET commission_mode='fixa',commission_rate=70000 WHERE id=?").run(s.id);
    return s.id;
  };
  const first = seller(), second = seller();
  f.rule("open", "verified", []);
  f.rule("verified", "cancelled", []);
  const unposted = f.transition(f.save(f.body({ seller_id: first }), off).document, "verified", off).document;
  assert.equal(f.count("erp_finance__commission_operation", unposted.id), 0);
  let doc = f.transition(f.save(f.body({ seller_id: first })).document, "verified").document;
  const before = { ...f.lite.prepare("SELECT * FROM erp_finance__commission_operation WHERE document_id=?").get(doc.id) };
  assert.ok(before.id);
  const changed = f.editBody(doc); changed.seller_id = second; changed.items[0].unit_price = "12"; changed.installments[0].amount = "12";
  doc = f.save(changed, off, doc).document;
  assert.deepEqual({ ...f.lite.prepare("SELECT * FROM erp_finance__commission_operation WHERE document_id=?").get(doc.id) }, before);
  f.transition(doc, "cancelled", off);
  assert.equal(f.lite.prepare("SELECT state FROM erp_finance__commission_operation WHERE id=?").get(before.id).state, "cancelled");
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__commission_adjustment WHERE operation_id=? AND kind='cancel'").get(before.id).n, 1);
});
