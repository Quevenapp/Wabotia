// Lojas e filiais (Wabotia, sem função no oráculo; versão 27): a primeira loja
// nasce com os dados da empresa e fica com tudo o que existe; com uma loja só,
// nada muda nas listas; a segunda loja traz depósito e caixa próprios; a
// pessoa limitada só vê e opera as lojas dela; o pedido novo leva o depósito
// e o vínculo da loja em uso; o bot soma o próprio limite ao da pessoa; o
// relatório compara as lojas. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE, com1Fixture, com1Identity } from "../comnfe/fixtures.mjs";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { readIdentity } from "../../../src/erp/engine/identity.ts";
import { cleanAddress, cleanCnpj, cleanPhone, cnpjValid } from "../../../src/erp/domains/stores/model.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { ERP_RPC_RULES } from "../../../src/erp/engine/parts-gate.ts";

const code = (c) => (e) => e.code === c || e.message === c || String(e.message).startsWith(`${c}:`);
const count = (f, sql, ...args) => Number(f.db.exec(sql, ...args).rows[0].n);

function stores(t) {
  const f = com1Fixture(t);
  f.seeded = f.order;
  f.read = (name, args = {}, env) => f.rpc(name, { p_args: args }, env);
  f.write = (name, args = {}, env) => f.rpc(name, { p_command_id: randomUUID(), p_args: args }, env);
  f.order = (env, extra = {}) => f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: COM1_DATE, contact_id: f.customer.id, installments: [], ...extra,
    items: [{ product_id: f.product.id, description: "Mercadoria do Ensaio", unit: "UN", quantity: "1", unit_price: "10.00", discount_percent: "0" }],
  } }, env).document;
  f.list = (env) => f.rpc("erp_document_list", { p_kind: "sales_orders", p_limit: 100, p_order: "date_desc", p_date_type: "date", p_origin: "all" }, env).items.map((d) => d.id);
  f.account = (name, type = "cash") => f.rpc("erp_finance_account_execute", { p_command_id: randomUUID(), p_action: "account_create",
    p_data: { account_type: type, name, start_on: "2020-01-01", opening_cents: "0" } }).record;
  // A mesma chamada com o envelope do bot (limite de lojas do bot por quem a pessoa age).
  f.asBot = (name, args, role, scope) => callRpc(f.db, name, { p_user_id: f.people[role].user_id, ...args }, f.clock, {
    identity: readIdentity({ ...com1Identity(role), store_scope: scope }), parts: normalizeErpParts(),
  });
  return f;
}

test("contas puras: endereço, telefone e CNPJ da filial", () => {
  assert.deepEqual(cleanAddress({ postal_code: "01001-000", street: "  Rua  A ", state: "sp" }), { postal_code: "01001000", street: "Rua A", state: "SP" });
  assert.throws(() => cleanAddress({ state: "XX" }), code("erp_store_state_invalid"));
  assert.deepEqual(cleanAddress({ state: "XX", city: "Santos", other: 1 }, true), { city: "Santos" }, "dados da empresa: descarta o que não confere");
  assert.equal(cleanPhone("(11) 3000-0000"), "1130000000");
  assert.throws(() => cleanPhone("123"), code("erp_store_phone_invalid"));
  assert.equal(cnpjValid("11222333000181"), true);
  assert.equal(cnpjValid("11222333000182"), false);
  assert.equal(cleanCnpj("11.222.333/0001-81"), "11222333000181");
  assert.equal(cleanCnpj(""), null);
  assert.throws(() => cleanCnpj("11.222.333/0001-82"), code("erp_store_cnpj_invalid"));
});

test("esquema: versão 27 só com tabelas novas e RPCs classificados na Base", () => {
  assert.equal(ERP_DDL_VERSION, 27);
  const mine = ERP_ENGINE_TABLES.filter((t) => t.since === 27).map((t) => t.table);
  assert.deepEqual(mine.sort(), ["erp_store__account", "erp_store__audit", "erp_store__command", "erp_store__document", "erp_store__person",
    "erp_store__selection", "erp_store__store", "erp_store__title", "erp_store__warehouse"]);
  for (const t of ERP_ENGINE_TABLES.filter((x) => x.since === 27)) for (const s of t.ddl) assert.doesNotMatch(s, /ALTER|DROP/);
  for (const name of ["erp_store_overview", "erp_store_save", "erp_store_person_set", "erp_store_select", "erp_store_assign", "erp_store_operations", "erp_store_report"])
    assert.equal(ERP_RPC_RULES[name], "stores", name);
});

test("uma loja só: a principal nasce com os dados da empresa, fica com tudo e nada filtra nem ganha vínculo", (t) => {
  const f = stores(t);
  const before = f.list();
  const o = f.read("erp_store_overview");
  assert.equal(o.multi, false);
  assert.equal(o.stores.length, 1);
  const main = o.stores[0];
  assert.equal(main.is_main, true);
  assert.equal(main.name, "Ensaio Comercial");
  assert.deepEqual(main.address, { postal_code: "01001000", street: "Praça da Sé", number: "100", district: "Sé", city: "São Paulo", state: "SP" });
  assert.equal(main.phone, "1130000000");
  // Uma segunda leitura não cria outra principal.
  f.read("erp_store_overview");
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_store__store"'), 1);
  const order = f.order(undefined);
  assert.deepEqual(f.list().sort(), [...before, order.id].sort());
  assert.equal(count(f, 'SELECT count(*) n FROM "erp_store__document"'), 0, "com uma loja nada é vinculado");
  assert.equal(f.rpc("erp_document_get", { p_kind: "sales_orders", p_id: order.id }).document?.warehouse_id ?? null, null, "nem o depósito muda");
});

test("duas lojas: depósito e caixa da filial, pessoa limitada, pedido com o depósito e o vínculo da loja, recusa fora dela", (t) => {
  const f = stores(t);
  const w1 = f.catalog("warehouses", { name: "Depósito da matriz" });
  const w2 = f.catalog("warehouses", { name: "Depósito do quiosque" });
  const cash2 = f.account("Caixa do quiosque");
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo inicial", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: w1.id, quantity: "10", expected_version: 0 }, { product_id: f.product.id, warehouse_id: w2.id, quantity: "5", expected_version: 0 }] });
  const oldOrder = f.order(undefined, { warehouse_id: w2.id });

  const created = f.write("erp_store_save", { name: "Quiosque do shopping", address: { city: "Santos", state: "SP" }, phone: "13 99999-0000", cnpj: "11.222.333/0001-81",
    fiscal_series: 2, warehouse_ids: [w2.id], account_ids: [cash2.id], default_warehouse_id: w2.id });
  const kiosk = created.store;
  assert.equal(created.replayed, false);
  assert.equal(kiosk.default_warehouse_id, w2.id);
  assert.deepEqual(kiosk.warehouses.map((w) => w.id), [w2.id]);
  assert.deepEqual(kiosk.accounts.map((a) => a.id), [cash2.id]);
  assert.equal(kiosk.cnpj, "11222333000181");
  const o = f.read("erp_store_overview");
  assert.equal(o.multi, true);
  const main = o.stores.find((s) => s.is_main);
  // O pedido que já existia no depósito que mudou de loja fica na loja em que aconteceu.
  assert.equal(f.db.exec('SELECT store_id FROM "erp_store__document" WHERE document_id=?', oldOrder.id).rows[0].store_id, main.id);
  assert.throws(() => f.write("erp_store_save", { name: "quiosque DO shopping" }), code("erp_store_name_taken"));
  assert.throws(() => f.write("erp_store_save", { id: main.id, expected_version: main.version, active: false }), code("erp_store_main_active"));
  assert.throws(() => f.write("erp_store_save", { id: kiosk.id, expected_version: kiosk.version, default_warehouse_id: w1.id }), code("erp_store_default_warehouse_outside"));

  // Limite: vendas e estoque só no quiosque; o administrador não se limita.
  const vendas = f.people.vendas.user_id, estoque = f.people.estoque.user_id;
  f.write("erp_store_person_set", { user_id: vendas, store_ids: [kiosk.id] });
  f.write("erp_store_person_set", { user_id: estoque, store_ids: [kiosk.id] });
  assert.throws(() => f.write("erp_store_person_set", { user_id: f.people.admin.user_id, store_ids: [kiosk.id] }), code("erp_store_admin_unrestricted"));
  assert.throws(() => f.write("erp_store_person_set", { user_id: vendas, store_ids: [kiosk.id] }, { role: "vendas" }), code("erp_store_admin_only"));
  const me = f.read("erp_store_overview", {}, { role: "vendas" });
  assert.deepEqual(me.me.allowed, [kiosk.id]);
  assert.deepEqual(me.stores.map((s) => s.id), [kiosk.id]);
  assert.equal(me.me.default_store_id, kiosk.id);
  assert.equal(me.warehouses, undefined, "só o administrador recebe depósitos, contas e pessoas");

  // Pedido novo da pessoa do quiosque: o depósito padrão da loja e o vínculo.
  const sale = f.order({ role: "vendas" });
  const saved = f.rpc("erp_document_get", { p_kind: "sales_orders", p_id: sale.id }, { role: "vendas" }).document;
  assert.equal(saved.warehouse_id, w2.id);
  assert.deepEqual({ ...f.db.exec('SELECT store_id, source FROM "erp_store__document" WHERE document_id=?', sale.id).rows[0] }, { store_id: kiosk.id, source: "warehouse" });
  // Fora da loja: depósito da matriz, pedido da matriz e lançamento no depósito da matriz.
  assert.throws(() => f.order({ role: "vendas" }, { warehouse_id: w1.id }), code("erp_store_denied"));
  assert.throws(() => f.rpc("erp_document_get", { p_kind: "sales_orders", p_id: f.seeded.id }, { role: "vendas" }), code("erp_document_not_found"));
  assert.throws(() => f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Fora da loja", p_reference: null,
    p_items: [{ product_id: f.product.id, warehouse_id: w1.id, quantity: "1", expected_version: 1 }] }, { role: "estoque" }), code("erp_store_denied"));

  // Listas: a pessoa do quiosque só vê o quiosque; o administrador vê tudo e estreita pela loja em uso.
  assert.deepEqual(f.list({ role: "vendas" }), [sale.id]);
  const all = f.list();
  assert.ok(all.includes(sale.id) && all.includes(oldOrder.id) && all.length >= 3);
  f.read("erp_store_select", { store_id: kiosk.id });
  assert.deepEqual(f.list(), [sale.id]);
  f.read("erp_store_select", { store_id: null });
  assert.deepEqual(f.list().sort(), all.sort());
  assert.throws(() => f.read("erp_store_select", { store_id: main.id }, { role: "vendas" }), code("erp_store_denied"));

  // Estoque por loja: a posição geral do produto soma só o quiosque para quem é do quiosque.
  const balances = f.rpc("erp_stock_balances", { p_product_id: f.product.id, p_warehouse_id: null }, { role: "estoque" }).items;
  assert.deepEqual(balances.map((b) => b.warehouse_id), [w2.id]);

  // Operações por loja e mudança de loja de um documento.
  const ops = f.read("erp_store_operations", { kind: "sales_orders", store_id: kiosk.id });
  assert.deepEqual(ops.items.map((i) => i.id), [sale.id]);
  assert.equal(ops.items[0].store_name, "Quiosque do shopping");
  assert.throws(() => f.read("erp_store_operations", { kind: "sales_orders", store_id: main.id }, { role: "vendas" }), code("erp_store_denied"));
  f.write("erp_store_assign", { entity: "document", id: oldOrder.id, store_id: kiosk.id });
  assert.deepEqual(f.list({ role: "vendas" }).sort(), [sale.id, oldOrder.id].sort());

  // Relatório por loja: vendas lado a lado e o total.
  const r = f.read("erp_store_report", { from: COM1_DATE, to: COM1_DATE });
  assert.deepEqual(r.stores.map((s) => s.name).sort(), ["Ensaio Comercial", "Quiosque do shopping"]);
  assert.equal(r.sales.orders.by_store[kiosk.id], "2");
  assert.equal(Number(r.sales.orders.total), Number(r.sales.orders.by_store[kiosk.id]) + Number(r.sales.orders.by_store[main.id]));
  assert.equal(r.stock.quantity.by_store[kiosk.id], "5.000000");
  assert.equal(r.stock.quantity.by_store[main.id], "10.000000");
  assert.ok(r.dre && Array.isArray(r.dre.lines));
  const mine = f.read("erp_store_report", { from: COM1_DATE, to: COM1_DATE }, { role: "vendas" });
  assert.deepEqual(mine.stores.map((s) => s.id), [kiosk.id], "a pessoa limitada só compara as lojas dela");
  assert.deepEqual(mine.unavailable.sort(), ["cash", "dre"], "o papel Vendas não vê caixa nem DRE");

  // Bot: pessoa (quiosque) ∩ bot (matriz) = nada; pessoa ∩ bot (quiosque) = quiosque.
  const bot = (scope) => f.asBot("erp_document_list", { p_kind: "sales_orders", p_limit: 100, p_order: "date_desc", p_date_type: "date", p_origin: "all" }, "vendas", scope).items.map((d) => d.id);
  assert.deepEqual(bot([main.id]), []);
  assert.deepEqual(bot([kiosk.id]).sort(), [sale.id, oldOrder.id].sort());
  assert.deepEqual(f.asBot("erp_store_overview", { p_args: {} }, "admin", [kiosk.id]).me.allowed, [kiosk.id], "o administrador pelo bot fica no limite do bot");
});

test("o envelope de identidade: limite do bot válido passa, malformado fecha", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(readIdentity({ ...com1Identity("vendas"), store_scope: [id] }).store_scope, [id]);
  assert.deepEqual(readIdentity({ ...com1Identity("vendas"), store_scope: ["x"] }).store_scope, []);
  assert.equal(readIdentity(com1Identity("vendas")).store_scope, undefined);
});
