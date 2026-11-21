// Produção (ordem de produção; Vinki, sem função no oráculo): a ordem com os
// insumos da composição, edição com perda, apontamento parcial e total com a
// baixa dos insumos e a entrada do acabado pelo Estoque e o custo do acabado,
// repetição segura, saldo insuficiente, estorno pelas guardas do Estoque (e a
// recusa quando o acabado já saiu), lote do acabado, planejamento pelos
// pedidos de venda em aberto, lista de compras que vira pedido de compra, e a
// parte Produção desligada. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { com1Fixture } from "../comnfe/fixtures.mjs";
import { averageCosts } from "../../../src/erp/domains/stock/public.ts";
import { consumption, parseQuantity, statusAfter, unitCost } from "../../../src/erp/domains/production/model.ts";

const code = (c) => (e) => e.code === c || e.message === c;
const disabled = (e) => e.code === "module_disabled";

function kitchen(t) {
  const f = com1Fixture(t);
  const product = (data) => f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { unit: "KG", kind: "P", format: "S", price: "10", ...data } }).record;
  f.flour = product({ name: "Fubá" });
  f.sugar = product({ name: "Açúcar" });
  f.milk = product({ name: "Doce de leite", unit: "UN", lot_control: true });
  const cake = product({ name: "Bolo de fubá", unit: "UN", format: "E", price: "30" });
  f.warehouse = f.catalog("warehouses", { name: "Cozinha" });
  f.store = f.catalog("warehouses", { name: "Loja" });
  f.rpc("erp_stock_warehouse_set_default", { p_command_id: randomUUID(), p_warehouse_id: f.warehouse.id, p_expected_version: 0 });
  f.supplier = f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { name: "Atacado de Ensaio", person_type: "J", document: "11444777000161", roles: ["supplier"] } }).record;
  f.version = (id, wh = f.warehouse.id) => f.db.exec('SELECT version FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', id, wh).rows[0]?.version ?? 0;
  f.balance = (id, wh = f.warehouse.id) => {
    const row = f.db.exec('SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', id, wh).rows[0];
    return row ? Number(row.q) / 1e6 : 0;
  };
  f.launch = (id, kind, quantity, price, wh = f.warehouse.id) => f.rpc("erp_stock_launch", { p_command_id: randomUUID(), p_kind: kind, p_product_id: id,
    p_warehouse_id: wh, p_quantity: quantity, p_expected_version: f.version(id, wh), p_unit_price: price ?? null, p_unit_cost: price ?? null, p_note: "Ensaio" });
  f.launch(f.flour.id, "receipt", "10", "4");
  f.launch(f.sugar.id, "receipt", "5", "6");
  f.cake = f.rpc("erp_stock_product_compose", { p_id: cake.id, p_expected_version: cake.version, p_command_id: randomUUID(), p_data: { name: "Bolo de fubá" },
    p_acknowledged: [], p_composition: { expected_version: 0, stock_type: "physical", post_mode: "product",
      items: [{ component_id: f.flour.id, quantity: "0.5" }, { component_id: f.sugar.id, quantity: "0.25" }] } }).record;
  f.save = (data, env, command = randomUUID()) => f.rpc("erp_production_save", { p_command_id: command, p_data: data }, env);
  f.status = (order, action, extra = {}, env) => f.rpc("erp_production_status", { p_command_id: randomUUID(), p_data: { id: order.id, expected_version: order.version, action, ...extra } }, env);
  f.complete = (order, data, env, command = randomUUID()) => f.rpc("erp_production_complete", { p_command_id: command, p_data: { id: order.id, expected_version: order.version, ...data } }, env);
  f.reverse = (order, completion, reason = "Lançado errado", env) => f.rpc("erp_production_reverse", { p_command_id: randomUUID(), p_data: { completion_id: completion, expected_version: order.version, reason } }, env);
  f.cost = (id) => f.transaction((ctx) => averageCosts(ctx.db, [id]).get(id));
  return f;
}

test("contas: consumo com perda, custo unitário nas casas do preço de entrada e situação depois do apontamento", () => {
  const q = (v) => parseQuantity(v);
  assert.equal(consumption(q("0.25"), q("10"), q("4")), q("2.6"));
  assert.equal(consumption(q("0.333333"), q("3"), 0n), q("0.999999"));
  assert.equal(consumption(q("0.000001"), q("0.5"), 0n), q("0.000001")); // metade arredonda para longe do zero
  assert.equal(unitCost(100000000000n, q("3")), 33333333333n); // R$ 10,00 ÷ 3 = 3,3333333333
  assert.equal(unitCost(100000000000n, q("3"), 2), 33300000000n); // 3,33 com duas casas
  assert.equal(statusAfter("released", q("2"), q("4"), false), "in_progress");
  assert.equal(statusAfter("in_progress", q("4"), q("4"), false), "done");
  assert.equal(statusAfter("in_progress", q("1"), q("4"), true), "done");
  assert.equal(statusAfter("in_progress", 0n, q("4"), false), "released");
  assert.equal(parseQuantity("1,5"), 1500000n);
  assert.equal(parseQuantity("-1"), null);
});

test("ordem: insumos da composição, edição com perda, apontamento parcial e total com baixa, entrada e custo; repetição e estorno", (t) => {
  const f = kitchen(t);
  let order = f.save({ product_id: f.cake.id, quantity: "4", planned_on: "2026-12-01", responsible: "Dona Maria", notes: "Forno 2" }).order;
  assert.deepEqual([order.label, order.status, order.source_warehouse.id, order.target_warehouse.id], ["OP 1", "draft", f.warehouse.id, f.warehouse.id]);
  assert.deepEqual(order.inputs.map((i) => [i.name, i.per_unit, i.planned, i.from_composition]), [["Fubá", "0.500000", "2.000000", true], ["Açúcar", "0.250000", "1.000000", true]]);
  // Perda prevista de 10% no fubá e o acabado vai para a loja.
  order = f.save({ id: order.id, expected_version: order.version, target_warehouse_id: f.store.id,
    inputs: [{ product_id: f.flour.id, per_unit: "0.5", loss_percent: "10" }, { product_id: f.sugar.id, per_unit: "0.25" }] }).order;
  assert.equal(order.inputs[0].planned, "2.200000");
  assert.throws(() => f.save({ id: order.id, expected_version: order.version - 1, notes: "x" }), code("erp_production_version_conflict"));
  assert.throws(() => f.save({ id: order.id, expected_version: order.version, inputs: [{ product_id: f.cake.id, per_unit: "1" }] }), code("erp_production_input_is_product"));
  assert.throws(() => f.save({ id: order.id, expected_version: order.version, inputs: [{ product_id: f.flour.id, per_unit: "1" }, { product_id: f.flour.id, per_unit: "2" }] }), code("erp_production_duplicate_input"));
  order = f.status(order, "release").order;
  assert.equal(order.status, "released");

  const preview = f.rpc("erp_production_complete_preview", { p_args: { id: order.id, quantity: "2", extra_cost: "2,60" } });
  assert.deepEqual(preview.inputs.map((i) => [i.name, i.quantity, i.total_cost]), [["Fubá", "1.100000", "4.4000000000"], ["Açúcar", "0.500000", "3.0000000000"]]);
  assert.deepEqual([preview.inputs_cost, preview.unit_cost, preview.can_complete], ["7.4000000000", "5.0000000000", true]);

  const command = randomUUID();
  const done = f.complete(order, { quantity: "2", extra_cost: "2.60", note: "Primeira fornada" }, undefined, command);
  assert.equal(done.replayed, false);
  assert.equal(f.complete(order, { quantity: "2", extra_cost: "2.60", note: "Primeira fornada" }, undefined, command).replayed, true);
  assert.throws(() => f.complete(order, { quantity: "3", extra_cost: "2.60" }, undefined, command), code("erp_production_command_conflict"));
  order = done.order;
  assert.deepEqual([order.status, order.produced, order.remaining], ["in_progress", "2.000000", "2.000000"]);
  assert.deepEqual([f.balance(f.flour.id), f.balance(f.sugar.id), f.balance(f.cake.id, f.store.id)], [8.9, 4.5, 2]);
  assert.equal(f.cost(f.cake.id), 50000000000n); // R$ 5,00 no custo médio do acabado
  const c = order.completions[0];
  assert.deepEqual([c.quantity, c.inputs_cost, c.extra_cost, c.unit_cost, c.state], ["2.000000", "7.4000000000", "2.6000000000", "5.0000000000", "active"]);
  const movements = f.db.exec('SELECT kind, reference FROM "erp_stock__movement" WHERE id IN (?,?) ORDER BY kind', c.issue_movement_id, c.receipt_movement_id).rows;
  assert.deepEqual(movements.map((m) => m.kind), ["issue", "receipt"]);

  // Saldo insuficiente: a prévia avisa e a conclusão recusa (o Estoque não permite negativo).
  const big = f.rpc("erp_production_complete_preview", { p_args: { id: order.id, quantity: "100" } });
  assert.equal(big.can_complete, false);
  assert.equal(big.inputs[0].missing, "46.100000");
  assert.throws(() => f.complete(order, { quantity: "100" }), code("erp_production_insufficient_stock"));
  assert.throws(() => f.status(order, "cancel", { reason: "Desistimos" }), code("erp_production_has_completions"));

  // Estorno: devolve os insumos e tira o acabado; a ordem volta a Liberada.
  order = f.reverse(order, c.id).order;
  assert.deepEqual([order.status, order.produced, order.completions[0].state], ["released", "0.000000", "reversed"]);
  assert.deepEqual([f.balance(f.flour.id), f.balance(f.sugar.id), f.balance(f.cake.id, f.store.id)], [10, 5, 0]);
  assert.throws(() => f.reverse(order, c.id), code("erp_production_already_reversed"));

  // O acabado já saiu da loja: o estorno recusa.
  order = f.complete(order, { quantity: "2" }).order;
  f.launch(f.cake.id, "issue", "1", null, f.store.id);
  assert.throws(() => f.reverse(order, order.completions[1].id), code("erp_production_finished_moved"));
  // O restante conclui a ordem; depois de concluída, não cancela.
  order = f.complete(order, { quantity: "2" }).order;
  assert.deepEqual([order.status, order.produced], ["done", "4.000000"]);
  assert.throws(() => f.status(order, "cancel", { reason: "Desistimos" }), code("erp_production_status_invalid"));
  assert.throws(() => f.complete(order, { quantity: "1" }), code("erp_production_not_completable"));
  const list = f.rpc("erp_production_list", { p_args: { status: "done", q: "fubá" } });
  assert.deepEqual(list.items.map((i) => i.label), ["OP 1"]);
  assert.equal(f.rpc("erp_production_list", { p_args: { status: "open" } }).total, 0);
});

test("lote do acabado, produto que não pode ser fabricado, papéis e parte desligada", (t) => {
  const f = kitchen(t);
  let order = f.save({ product_id: f.milk.id, quantity: "10", status: "released", inputs: [{ product_id: f.sugar.id, per_unit: "0.1" }] }).order;
  assert.deepEqual([order.status, order.inputs[0].from_composition], ["released", false]);
  assert.throws(() => f.complete(order, { quantity: "10" }), code("erp_production_lot_required"));
  order = f.complete(order, { quantity: "10", lot: { code: "DL-01", expires_on: "2027-03-01" } }).order;
  const lot = order.completions[0].lot;
  assert.deepEqual([lot.code, lot.expires_on], ["DL-01", "2027-03-01"]);
  const lotBalance = () => Number(f.db.exec('SELECT CAST(quantity AS TEXT) q FROM "erp_stock__lot_balance" WHERE lot_id=?', lot.id).rows[0].q) / 1e6;
  assert.equal(lotBalance(), 10);
  order = f.reverse(order, order.completions[0].id).order;
  assert.equal(lotBalance(), 0);
  assert.throws(() => f.save({ product_id: f.flour.id, quantity: "1", lot: {} }), code("erp_production_invalid"));

  // Kit que lança os componentes na venda: produzir daria baixa dos insumos duas vezes.
  const kit = f.rpc("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_acknowledged: null,
    p_data: { name: "Cesta", unit: "UN", kind: "P", format: "E", price: "50" } }).record;
  f.rpc("erp_stock_product_compose", { p_id: kit.id, p_expected_version: kit.version, p_command_id: randomUUID(), p_data: { name: "Cesta" }, p_acknowledged: [],
    p_composition: { expected_version: 0, stock_type: "physical", post_mode: "both", items: [{ component_id: f.sugar.id, quantity: "1" }] } });
  assert.throws(() => f.save({ product_id: kit.id, quantity: "1" }), code("erp_production_product_kit_components"));
  assert.equal(f.rpc("erp_production_composition", { p_args: { product_id: kit.id } }).problem, "kit_components");

  // Papéis: vendas consulta, não grava; financeiro nem consulta.
  assert.equal(f.rpc("erp_production_list", { p_args: {} }, { role: "vendas" }).total, 1);
  assert.throws(() => f.save({ product_id: f.cake.id, quantity: "1" }, { role: "vendas" }), code("erp_stock_access_denied"));
  assert.throws(() => f.rpc("erp_production_list", { p_args: {} }, { role: "financeiro" }), code("erp_stock_access_denied"));
  // Parte desligada: Produção, ou Estoque de que ela depende, recusa antes de ler.
  assert.throws(() => f.rpc("erp_production_list", { p_args: {} }, { parts: { production: false } }), disabled);
  assert.throws(() => f.rpc("erp_production_options", {}, { parts: { stock: false } }), disabled);
  const options = f.rpc("erp_production_options", {});
  assert.deepEqual([options.default_warehouse_id, options.negative_allowed, options.can_write, options.parts.purchases], [f.warehouse.id, false, true, true]);
});

test("planejamento: sugestões pelos pedidos em aberto, ordens com um clique e lista de compras que vira pedido de compra", (t) => {
  const f = kitchen(t);
  f.launch(f.cake.id, "receipt", "2", "20");
  // Pedido de venda em aberto de 10 bolos: há 2 em estoque, faltam 8 (4 kg de fubá e 2 kg de açúcar).
  f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: "2026-11-19", contact_id: f.customer.id, items: [{ product_id: f.cake.id, description: "Bolo de fubá", unit: "UN", quantity: "10", unit_price: "30", discount_percent: "0" }],
    installments: [{ due_date: "2026-12-19", amount: "300.00" }] } });
  let plan = f.rpc("erp_production_plan", {});
  assert.equal(plan.sales_on, true);
  assert.equal(plan.suggestions.length, 1);
  const s = plan.suggestions[0];
  assert.deepEqual([s.product.name, s.demand, s.stock, s.quantity], ["Bolo de fubá", "10.000000", "2.000000", "8.000000"]);
  assert.deepEqual(s.inputs.map((i) => [i.name, i.needed, i.missing]), [["Fubá", "4.000000", "0.000000"], ["Açúcar", "2.000000", "0.000000"]]);
  assert.deepEqual(plan.shopping, []);

  const generated = f.rpc("erp_production_plan_generate", { p_command_id: randomUUID(), p_data: { items: [{ product_id: f.cake.id, quantity: s.quantity, sales_order_ids: s.sales_orders.map((o) => o.id) }] } });
  assert.equal(generated.orders.length, 1);
  const order = f.rpc("erp_production_get", { p_args: { id: generated.orders[0].id } }).order;
  assert.deepEqual([order.origin, order.status, order.quantity, order.sales_orders.length], ["plan", "draft", "8.000000", 1]);
  // Com a ordem aberta, a sugestão some e os insumos dela ficam comprometidos.
  plan = f.rpc("erp_production_plan", {});
  assert.equal(plan.suggestions.length, 0);

  // Mais um pedido de 20 bolos: faltam insumos, e a lista de compras mostra o que falta
  // (açúcar: 5 kg − 2 kg comprometidos com a ordem aberta = 3 livres para 5 kg; fubá: 10 − 4 = 6 livres para 10 kg).
  f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: "2026-11-19", contact_id: f.customer.id, items: [{ product_id: f.cake.id, description: "Bolo de fubá", unit: "UN", quantity: "20", unit_price: "30", discount_percent: "0" }],
    installments: [{ due_date: "2026-12-19", amount: "600.00" }] } });
  plan = f.rpc("erp_production_plan", {});
  assert.equal(plan.suggestions[0].quantity, "20.000000");
  assert.deepEqual(plan.shopping.map((i) => [i.name, i.missing]), [["Açúcar", "2.000000"], ["Fubá", "4.000000"]]);
  assert.throws(() => f.rpc("erp_production_purchase", { p_command_id: randomUUID(), p_data: { items: [{ product_id: f.flour.id, quantity: "4" }] } }), code("erp_production_supplier_required"));
  const bought = f.rpc("erp_production_purchase", { p_command_id: randomUUID(), p_data: { items: plan.shopping.map((i) => ({ product_id: i.product_id, quantity: i.missing, supplier_id: f.supplier.id })) } });
  assert.equal(bought.documents.length, 1);
  const doc = f.db.exec('SELECT kind, contact_id FROM "erp_documents__document" WHERE id=?', bought.documents[0].id).rows[0];
  assert.deepEqual([doc.kind, doc.contact_id], ["purchase_orders", f.supplier.id]);
  // Sem Compras, a lista não vira pedido; sem Vendas, o planejamento não sugere.
  assert.throws(() => f.rpc("erp_production_purchase", { p_command_id: randomUUID(), p_data: { items: [{ product_id: f.flour.id, quantity: "1", supplier_id: f.supplier.id }] } }, { parts: { purchases: false } }), disabled);
  const off = f.rpc("erp_production_plan", {}, { parts: { sales: false } });
  assert.deepEqual([off.sales_on, off.suggestions.length], [false, 0]);
});
