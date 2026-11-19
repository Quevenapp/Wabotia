import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc, inTransaction } from "../../../src/erp/engine/registry.ts";
import { compositionSync, compositionSyncOn } from "../../../src/erp/domains/catalog/composition.ts";
import { erpCatalogContactHistory } from "../../../src/erp/domains/catalog/rpc/erp_catalog_contact_history.ts";
import { contactApply } from "../../../src/erp/domains/catalog/contact-core.ts";

const admin = "11111111-1111-4111-8111-111111111111";
const actor = { user_id: admin, erp_role: "admin", is_agent: false, verified_factor: false,
  aal: "aal1", session_id: null, name: "Admin", email: null };
const identity = { actor, people: [actor] };
const isolated = { stock: false, finance: false, purchases: false, sales: false, fiscal: false, billing: false, pos: false };
const disabled = e => e.code === "module_disabled";
const hidden = (record, keys, parts = ["finance"]) => {
  for (const key of keys) assert.equal(Object.hasOwn(record, key), false, key);
  for (const part of parts) assert.ok(record.unavailable_parts.includes(part), part);
};
const pick = (record, keys) => Object.fromEntries(keys.map(key => [key, record[key]]));
const command = (data, record) => ({ p_id: record?.id ?? null, p_expected_version: record?.version ?? 0,
  p_command_id: randomUUID(), p_data: data });
function fixture(t) {
  const lite = freshLite(), raw = nodeDriver(lite), queries = [];
  const db = { transaction: fn => raw.transaction(fn), exec(sql, ...args) { queries.push(sql); return raw.exec(sql, ...args); } };
  t.after(() => lite.close());
  const rpc = (name, args = {}, parts = {}) => callRpc(db, name, { p_user_id: admin, ...args }, undefined, { identity, parts });
  const product = (data = {}, parts = {}) => rpc("erp_catalog_product_save", command({ name: "Produto", kind: "P", format: "S", unit: "UN", price: "10", ...data }), parts).record;
  const contact = (data = {}, parts = {}) => rpc("erp_catalog_contact_save", command({ name: "Contato", person_type: "J", ...data }), parts).record;
  const account = () => rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  const category = () => rpc("erp_finance_category_execute", { p_command_id: randomUUID(), p_action: "category_create",
    p_data: { kind: "receivable", name: "Receitas" } }).record;
  return { lite, db, queries, rpc, product, contact, account, category };
}
const method = { description: "Dinheiro", payment_type: "01", condition: "30 60", destination: "contas",
  account_id: null, business_days: false, applicable: "ambos", interest_rate: null, fine_rate: null,
  card_brand: null, card_integration: null, card_cnpj: null, auto_settle: false,
  pix_integration: null, pix_cnpj: null, fee_type: "aliquota", fee_rate: null, fee_fixed: null, settlement_days: null };
const sellerSettings = { user_id: null, allow_unregistered_products: false, view_stock: false,
  access_hours_enabled: false, access_windows: [], modules: {}, commission_rule: "parcial",
  commission_mode: "fixa", commission_rate: null, commission_bands: [], discount_limit: "0", notes: null };

test("produto simples sem depósito: listas e exportações não consultam saldo nem fabricam zero", t => {
  const f = fixture(t), product = f.product({}, isolated);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_catalog__warehouse").get().n, 0);
  for (const name of ["erp_catalog_product_page", "erp_catalog_product_page_v2", "erp_catalog_product_page_v3",
    "erp_catalog_product_export", "erp_catalog_product_export_v2"]) {
    f.queries.length = 0;
    const page = f.rpc(name, {}, isolated);
    assert.equal(page.items[0].id, product.id);
    assert.equal(page.items[0].stock, null, name);
    assert.equal(page.stock_visible, false);
    assert.ok(page.unavailable_parts.includes("stock"));
    assert.equal(page.items[0].price, "10.0000");
    assert.deepEqual(f.queries.filter(sql => /erp_stock__|erp_stock_mirror__/i.test(sql)), [], name);
  }
  // Cada chamada tem sua fotografia: desligar não contamina o próximo RPC.
  assert.equal(f.rpc("erp_catalog_product_page").stock_visible, true);
  assert.equal(f.rpc("erp_catalog_product_page", {}, isolated).stock_visible, false);
});

test("filtros físicos, composição e lote recusados; preço cadastral continua editável", t => {
  const f = fixture(t), p = f.product({}, isolated);
  for (const filter of [{ p_stock: "zero" }, { p_stock: "origin_positive" }, { p_warehouse_id: randomUUID() },
    { p_product_type: "composition" }, { p_product_type: "no_composition" }, { p_component_id: p.id }]) {
    assert.throws(() => f.rpc("erp_catalog_product_page_v3", filter, isolated), disabled);
    assert.throws(() => f.rpc("erp_catalog_product_export_v2", filter, isolated), disabled);
  }
  assert.throws(() => f.product({ format: "E" }, isolated), disabled);
  assert.throws(() => f.product({ lot_control: true }, isolated), disabled);
  assert.throws(() => f.product({ stock_min: "2" }, isolated), disabled);
  assert.throws(() => f.rpc("erp_stock_product_create", { p_command_id: randomUUID(),
    p_data: { name: "Com saldo", unit: "UN", kind: "P", format: "S" },
    p_acknowledged: null, p_warehouse_id: randomUUID(), p_quantity: "1" }, isolated), disabled);
  const edited = f.rpc("erp_catalog_product_save", command({ price: "25" }, p), isolated).record;
  assert.equal(edited.price, "25.0000");
  inTransaction(f.db, ctx => {
    assert.equal(compositionSyncOn(ctx), false);
    assert.throws(() => compositionSync(ctx, admin, randomUUID(), [p.id]), disabled);
  }, undefined, { parts: isolated });
});

test("produto existente conserva fornecedores, custo, lote e limites suspensos", t => {
  const f = fixture(t), supplier = f.contact({ types: ["supplier"] });
  const suppliers = [{ supplier_id: supplier.id, is_default: true, purchase_price: "7", cost_price: "8" }];
  let p = f.product({ suppliers, lot_control: true, stock_min: "2" });
  const keys = ["suppliers", "cost_price", "lot_control", "stock_min", "stock_max", "location"];
  const original = pick(p, keys);
  const stored = () => ({
    suppliers: f.lite.prepare("SELECT * FROM erp_catalog__product_supplier WHERE record_id=? ORDER BY position").all(p.id),
    product: f.lite.prepare("SELECT stock_min,stock_max,location FROM erp_catalog__product WHERE record_id=?").get(p.id),
    detail: f.lite.prepare("SELECT * FROM erp_catalog__product_detail WHERE record_id=?").get(p.id),
  });
  const storedBefore = stored();
  const history = () => f.lite.prepare("SELECT * FROM erp_catalog__product_cost_history WHERE product_id=?").all(p.id);
  const before = history();
  p = f.rpc("erp_catalog_product_save", command({ name: "Renomeado" }, p), isolated).record;
  hidden(p, keys, ["purchases", "stock"]);
  assert.deepEqual(stored(), storedBefore);
  p = f.rpc("erp_catalog_product_save", command({ suppliers, lot_control: true, stock_min: "2" }, p), isolated).record;
  assert.deepEqual(history(), before);
  hidden(p, keys, ["purchases", "stock"]);
  assert.deepEqual(stored(), storedBefore);
  assert.throws(() => f.rpc("erp_catalog_product_save", command({ suppliers: [] }, p), isolated), disabled);
  assert.throws(() => f.rpc("erp_catalog_product_save", command({ lot_control: false }, p), isolated), disabled);
  assert.throws(() => f.rpc("erp_catalog_product_save", command({ stock_min: null }, p), isolated), disabled);
  const page = f.rpc("erp_catalog_product_page_v2", {}, isolated);
  const exported = f.rpc("erp_catalog_product_export", {}, isolated);
  hidden(page.items[0], ["cost_price"], ["purchases", "stock"]);
  hidden(exported.items[0], ["cost_price", "supplier"], ["purchases", "stock"]);
  assert.throws(() => f.rpc("erp_catalog_product_purchase_info", { p_product_ids: [p.id] }, isolated), disabled);
  assert.deepEqual(stored(), storedBefore);
  const restored = f.rpc("erp_catalog_product_get", { p_id: p.id }).record;
  assert.equal(restored.suppliers[0].supplier_id, supplier.id);
  assert.deepEqual(pick(restored, keys), original);
});

test("contato comum e importação isolados; vínculos anteriores preservados em gravação completa", t => {
  const f = fixture(t), cat = f.category();
  let c = f.contact({ finance_category_id: cat.id, credit_limit_mode: "value", credit_limit: "100" });
  const keys = ["finance_category_id", "finance_category_name", "credit_limit_mode", "credit_limit"];
  const original = pick(c, keys);
  const stored = () => f.lite.prepare("SELECT * FROM erp_catalog__contact_profile WHERE record_id=?").get(c.id);
  const before = stored();
  c = f.rpc("erp_catalog_contact_save", command({ name: "Nome alterado" }, c), isolated).record;
  hidden(c, keys);
  assert.deepEqual(stored(), before);
  c = f.rpc("erp_catalog_contact_save", command({ name: "Nome completo", finance_category_id: cat.id,
    credit_limit_mode: "value", credit_limit: "100" }, c), isolated).record;
  hidden(c, keys);
  assert.deepEqual(stored(), before);
  for (const patch of [{ finance_category_id: null }, { finance_category_id: randomUUID() }, { credit_limit_mode: "zero", credit_limit: null }])
    assert.throws(() => f.rpc("erp_catalog_contact_save", command(patch, c), isolated), disabled);
  const common = f.contact({}, isolated);
  hidden(common, keys);
  assert.equal(f.lite.prepare("SELECT finance_category_id FROM erp_catalog__contact_profile WHERE record_id=?").get(common.id).finance_category_id, null);
  assert.equal(f.rpc("erp_catalog_contact_get", { p_id: common.id }).record.finance_category_id, null);
  f.queries.length = 0;
  const read = f.rpc("erp_catalog_contact_get", { p_id: c.id }, isolated);
  hidden(read.record, keys);
  assert.deepEqual(f.queries.filter(sql => /erp_finance__/.test(sql)), []);
  assert.deepEqual(stored(), before);
  const restored = f.rpc("erp_catalog_contact_get", { p_id: c.id }).record;
  assert.equal(restored.finance_category_id, cat.id);
  assert.equal(restored.credit_limit, "100.00");
  assert.deepEqual(pick(restored, keys), original);
  for (const dry of [true, false]) {
    const args = { p_command_id: randomUUID(), p_dry_run: dry, p_rows: [{ row: 1, data: { name: "Importado", person_type: "J" } }] };
    assert.equal(f.rpc("erp_catalog_contact_import", args, isolated).items[0].status, dry ? "valid" : "created");
    args.p_rows[0].data.finance_category_id = cat.id;
    args.p_command_id = randomUUID();
    assert.throws(() => f.rpc("erp_catalog_contact_import", args, isolated), disabled);
  }
});

test("forma comum sem conta e preservação de conta/tarifas sem consulta financeira oculta", t => {
  const f = fixture(t), a = f.account();
  const keys = ["account_id", "account_name", "interest_rate", "fine_rate", "auto_settle", "fee_type", "fee_rate", "fee_fixed", "settlement_days"];
  const common = f.rpc("erp_catalog_payment_method_save", command(method), isolated).item;
  hidden(common, keys);
  assert.equal(f.lite.prepare("SELECT account_id FROM erp_catalog__payment_method WHERE id=?").get(common.id).account_id, null);
  assert.equal(f.rpc("erp_catalog_payment_method_get", { p_id: common.id }).item.account_id, null);
  let m = f.rpc("erp_catalog_payment_method_save", command({ ...method, account_id: a.id, fee_rate: "2" })).item;
  const original = pick(m, keys);
  const stored = () => f.lite.prepare("SELECT account_id,interest_rate,fine_rate,auto_settle,fee_type,fee_rate,fee_fixed,settlement_days FROM erp_catalog__payment_method WHERE id=?").get(m.id);
  const before = stored();
  const partial = { ...method, description: "Nova descrição" };
  for (const key of ["account_id", "interest_rate", "fine_rate", "auto_settle", "fee_type", "fee_rate", "fee_fixed", "settlement_days"]) delete partial[key];
  m = f.rpc("erp_catalog_payment_method_save", command(partial, m), isolated).item;
  hidden(m, keys);
  assert.deepEqual(stored(), before);
  m = f.rpc("erp_catalog_payment_method_save", command({ ...method, account_id: a.id, fee_rate: "2" }, m), isolated).item;
  hidden(m, keys);
  assert.deepEqual(stored(), before);
  assert.throws(() => f.rpc("erp_catalog_payment_method_save", command({ ...method, account_id: null, fee_rate: "2.0000" }, m), isolated), disabled);
  assert.throws(() => f.rpc("erp_catalog_payment_method_save", command({ ...method, account_id: a.id }, null), isolated), disabled);
  f.queries.length = 0;
  const get = f.rpc("erp_catalog_payment_method_get", { p_id: m.id }, isolated);
  const page = f.rpc("erp_catalog_payment_method_page", { p_page: 1, p_size: 20 }, isolated);
  assert.deepEqual(get.accounts, []);
  assert.deepEqual(page.accounts, []);
  hidden(get.item, keys);
  assert.deepEqual(f.queries.filter(sql => /erp_finance__/.test(sql)), []);
  assert.throws(() => f.rpc("erp_catalog_payment_method_page", { p_page: 1, p_size: 20, p_account_id: a.id }, isolated), disabled);
  assert.deepEqual(stored(), before);
  const restored = f.rpc("erp_catalog_payment_method_get", { p_id: m.id }).item;
  assert.equal(restored.account_id, a.id);
  assert.equal(restored.fee_rate, "2.0000");
  assert.deepEqual(pick(restored, keys), original);
});

test("vendedor conserva comissão e permite alterar dados comuns", t => {
  const f = fixture(t);
  const save = (settings, saved, parts = {}) => f.rpc("erp_catalog_seller_save", {
    p_id: saved?.seller.id ?? null, p_expected_version: saved?.seller.version ?? 0,
    p_contact_expected_version: saved?.contact.version ?? 0, p_command_id: randomUUID(),
    p_contact: { name: "Vendedor" }, p_settings: settings,
  }, parts);
  let s = save({ ...sellerSettings, commission_rate: "3" });
  const keys = ["commission_rule", "commission_mode", "commission_rate", "commission_bands"];
  const original = pick(s.seller, keys);
  const stored = () => f.lite.prepare("SELECT commission_rule,commission_mode,commission_rate,commission_bands FROM erp_catalog__seller WHERE id=?").get(s.seller.id);
  const before = stored();
  const common = { ...sellerSettings, notes: "Observação" };
  for (const k of ["commission_rule", "commission_mode", "commission_rate", "commission_bands"]) delete common[k];
  s = save(common, s, isolated);
  hidden(s.seller, keys);
  assert.deepEqual(stored(), before);
  s = save({ ...sellerSettings, commission_rate: "3" }, s, isolated);
  hidden(s.seller, keys);
  assert.deepEqual(stored(), before);
  assert.throws(() => save({ ...sellerSettings, commission_rate: null }, s, isolated), disabled);
  const created = save(common, null, isolated).seller;
  hidden(created, keys);
  assert.equal(f.lite.prepare("SELECT commission_rate FROM erp_catalog__seller WHERE id=?").get(created.id).commission_rate, null);
  assert.equal(f.rpc("erp_catalog_seller_get", { p_id: created.id }).seller.commission_rate, null);
  assert.deepEqual(stored(), before);
  const restored = f.rpc("erp_catalog_seller_get", { p_id: s.seller.id }).seller;
  assert.equal(restored.commission_rate, "3.0000");
  assert.deepEqual(pick(restored, keys), original);
});

test("histórico respeita a origem e ficha permanece acessível", t => {
  const f = fixture(t), c = f.contact({ types: ["customer", "supplier"] }), p = f.product();
  const ids = {};
  for (const kind of ["sales_orders", "purchase_orders"]) ids[kind] = f.rpc("erp_document_save", {
    p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date: "2026-10-15", contact_id: c.id,
      items: [{ product_id: p.id, description: p.name, unit: "UN", quantity: "1", unit_price: "10" }] },
  }).document.id;
  for (const [off, available] of [["sales", "purchase_orders"], ["purchases", "sales_orders"]]) {
    const parts = { [off]: false };
    const history = f.rpc("erp_catalog_contact_history", { p_contact_id: c.id, p_kind: available }, parts);
    assert.equal(history.items[0].id, ids[available]);
    const blocked = available === "sales_orders" ? "purchase_orders" : "sales_orders";
    assert.throws(() => f.rpc("erp_catalog_contact_history", { p_contact_id: c.id, p_kind: blocked }, parts), disabled);
    assert.equal(f.rpc("erp_catalog_contact_get", { p_id: c.id }, parts).record.id, c.id);
    f.queries.length = 0;
    const hidden = inTransaction(f.db, ctx => erpCatalogContactHistory(ctx,
      { p_user_id: admin, p_contact_id: c.id, p_kind: blocked }), undefined, { parts, identity });
    assert.equal(hidden.visible, false);
    assert.deepEqual(hidden.items, []);
    assert.ok(hidden.unavailable_parts.includes(off));
    assert.deepEqual(f.queries.filter(sql => /erp_documents__|erp_document_mirror__/.test(sql)), []);
  }
});

test("unidade e tipo de produto movimentado continuam protegidos sem Estoque", t => {
  const f = fixture(t), p = f.product();
  const warehouse = f.rpc("erp_catalog_save", { p_entity: "warehouses", ...command({ name: "Depósito" }) }).record;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: "2026-10-15",
    p_reason: "Saldo anterior", p_reference: null,
    p_items: [{ product_id: p.id, warehouse_id: warehouse.id, quantity: "2", expected_version: 0 }] });
  for (const data of [{ unit: "KG" }, { kind: "S" }]) {
    assert.throws(() => f.rpc("erp_catalog_product_save", command(data, p), isolated), /erp_stock_product_unit_locked/);
    assert.throws(() => f.rpc("erp_catalog_save", { p_entity: "products", ...command(data, p) }, isolated), /erp_stock_product_unit_locked/);
  }
  assert.equal(f.rpc("erp_catalog_product_save", command({ name: "Nome novo" }, p), isolated).record.unit, "UN");
});

test("reajuste e atualização em massa preservam custo suspenso e não recalculam kits", t => {
  const f = fixture(t), supplier = f.contact({ types: ["supplier"] });
  let p = f.product({ suppliers: [{ supplier_id: supplier.id, is_default: true, cost_price: "8" }] });
  const stored = () => f.lite.prepare("SELECT * FROM erp_catalog__product_supplier WHERE record_id=? ORDER BY position").all(p.id);
  const before = stored(), original = p.suppliers;
  const history = f.lite.prepare("SELECT * FROM erp_catalog__product_cost_history").all();
  for (const parts of [{ stock: false }, { purchases: false }]) {
    const args = { p_command_id: randomUUID(), p_supplier_id: supplier.id,
      p_items: [{ product_id: p.id, expected_version: p.version, price: "20", cost_price: "8" }] };
    const result = f.rpc("erp_catalog_product_prices_update", args, parts);
    hidden(result.items[0], ["cost_price"], [parts.stock === false ? "stock" : "purchases"]);
    assert.deepEqual(stored(), before);
    assert.deepEqual(f.lite.prepare("SELECT * FROM erp_catalog__product_cost_history").all(), history);
    p = { ...p, version: f.lite.prepare("SELECT version FROM erp_catalog__record WHERE id=?").get(p.id).version };
    assert.throws(() => f.rpc("erp_catalog_product_prices_update", { ...args, p_command_id: randomUUID(),
      p_items: [{ product_id: p.id, expected_version: p.version, cost_price: "9" }] }, parts), disabled);
  }
  const adjust = { p_command_id: randomUUID(), p_rule: { action: "increase", unit: "amount", value: "1" },
    p_items: null, p_filters: { stock: "zero" } };
  assert.throws(() => f.rpc("erp_catalog_product_price_adjust", adjust, isolated), disabled);
  assert.throws(() => f.rpc("erp_catalog_product_price_adjust", { ...adjust, p_filters: { product_type: "composition" } }, isolated), disabled);
  f.queries.length = 0;
  const result = f.rpc("erp_catalog_product_price_adjust", { ...adjust, p_filters: { situation: "active" } }, isolated);
  assert.equal(result.applied, 1);
  assert.deepEqual(f.queries.filter(sql => /erp_stock__/.test(sql)), []);
  assert.deepEqual(stored(), before);
  assert.deepEqual(f.rpc("erp_catalog_product_get", { p_id: p.id }).record.suppliers, original);
  assert.equal(f.rpc("erp_catalog_product_get", { p_id: p.id }).record.cost_price, original[0].cost_price);
});

test("cadastro de kit histórico e replay não criam custo ao religar", t => {
  const f = fixture(t);
  let kit = f.product({ format: "E" });
  kit = f.rpc("erp_catalog_product_save", command({ name: "Kit preservado", format: "E" }, kit), isolated).record;
  assert.equal(kit.format, "E");
  assert.throws(() => f.rpc("erp_catalog_product_save", command({ format: "S" }, kit), isolated), disabled);
  const args = command({ price: "15" }, kit);
  const saved = f.rpc("erp_catalog_product_save", args, isolated);
  const count = f.lite.prepare("SELECT count(*) n FROM erp_catalog__product_cost_history").get().n;
  assert.equal(f.rpc("erp_catalog_product_save", args).replayed, true);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_catalog__product_cost_history").get().n, count);
  assert.equal(f.lite.prepare("SELECT version FROM erp_catalog__record WHERE id=?").get(kit.id).version, saved.record.version);
});

test("cadastro único conserva privacidade e guarda financeira em aplicação interna", t => {
  const f = fixture(t), c = f.contact(), category = f.category();
  const restricted = { ...identity, customer_privacy: { restricted_contact_ids: [c.id] } };
  assert.throws(() => callRpc(f.db, "erp_catalog_contact_get", { p_user_id: admin, p_id: c.id }, undefined,
    { identity: restricted, parts: isolated }), /erp_customer_restricted/);
  assert.equal(f.rpc("erp_catalog_contact_get", { p_id: c.id }, isolated).record.id, c.id);
  // Última fotografia do driver ligada: a aplicação usa o contexto atual.
  f.rpc("erp_catalog_contact_get", { p_id: c.id });
  assert.throws(() => inTransaction(f.db, ctx => contactApply(ctx, admin, c.id, c.version, randomUUID(),
    { finance_category_id: category.id }, null), undefined, { identity, parts: isolated }), disabled);
  assert.equal(f.lite.prepare("SELECT finance_category_id FROM erp_catalog__contact_profile WHERE record_id=?").get(c.id).finance_category_id, null);
});

test("fonte de custo da compra desaparece com Estoque suspenso, preço cadastral permanece", t => {
  const f = fixture(t), supplier = f.contact({ types: ["supplier"] });
  const p = f.product({ suppliers: [{ supplier_id: supplier.id, is_default: true, purchase_price: "7", cost_price: "8" }] });
  const result = f.rpc("erp_catalog_product_purchase_info", { p_product_ids: [p.id], p_supplier_id: supplier.id }, { stock: false });
  assert.equal(result.items[0].price, "10.0000");
  assert.equal(result.items[0].supplier.cost_price, null);
  assert.equal(result.items[0].supplier.purchase_price, "7.0000");
  assert.ok(result.unavailable_parts.includes("stock"));
});

test("somente Base permite contato, importação, forma comum e vendedor sem Produtos", t => {
  const f = fixture(t), parts = { ...isolated, products: false };
  const c = f.contact({ payment_condition: "30 60" }, parts);
  assert.equal(c.payment_condition, "30 60");
  assert.equal(f.rpc("erp_catalog_payment_method_save", command(method), parts).item.description, "Dinheiro");
  const imported = f.rpc("erp_catalog_contact_import", { p_command_id: randomUUID(), p_dry_run: false,
    p_rows: [{ row: 1, data: { name: "Contato importado" } }] }, parts);
  assert.equal(imported.items[0].status, "created");
  const seller = f.rpc("erp_catalog_seller_save", { p_id: null, p_expected_version: 0,
    p_contact_expected_version: 0, p_command_id: randomUUID(), p_contact: { name: "Vendedor Base" },
    p_settings: sellerSettings }, parts);
  assert.equal(seller.contact.name, "Vendedor Base");
  assert.throws(() => f.product({}, parts), disabled);
});
