// Meu Negócio (erp_home_business_panel) na fixture dupla, pela rota do Worker (p_panel + p_args de businessArgs).
// Adaptados de business-dashboards-sql.test.mjs do Fagoo (chamando o painel em vez das funções internas).
// O custo da linha usa o custo congelado, o productCostAt (Catálogo) e o reportLastPurchaseUntil (Documentos), nos dois motores.
// O caso "itens sem produto" cobre agora o resto: períodos, situações, canais, vendedores, estados, carteira, ABC e metas.
// Fora, declarados: GRANT/has_function_privilege, gatilhos de imutabilidade por SQL direto e o bloco gerado de 150.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import {
  captureBusinessQuery,
  businessArgs,
  parseBusinessPanel,
  parseGoals,
  parseGoalResult,
  captureGoalSave,
  captureGoalsQuery,
} from "../../../src/erp/fagoo/packages/erp-domain/src/business-dashboards.mjs";

const fails = (fn, code) => assert.rejects(fn, (e) => e.code === code);
const S = "verified,in_progress,fulfilled";

async function documentOf(f, kind, { contact, date, items, statuses = [], body = {} }) {
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: f.users.admin, p_kind: kind, p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
      p_body: { date, contact_id: contact, ...body, items: items.map((i) => ({ unit: "UN", ...i })) },
    })
  ).document;
  for (const s of statuses) {
    if (d.status === s) continue;
    d = (
      await f.rpc("erp_document_transition", {
        p_user_id: f.users.admin, p_kind: d.kind, p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: s, p_reason: "Transição sintética",
      })
    ).document;
  }
  return d;
}
async function preference(f, page, key, value, user = f.users.admin) {
  const current = (await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page })).items.find((i) => i.key === key);
  return f.rpc("erp_preferences_save", { p_user_id: user, p_command_id: randomUUID(), p_page: page, p_changes: [{ key, expected_version: current.version, value }] });
}
const panel = async (f, name, input, user) => {
  const q = captureBusinessQuery(name, input);
  return parseBusinessPanel(await f.rpc("erp_home_business_panel", { p_user_id: user ?? f.users.admin, p_panel: name, p_args: businessArgs(q) }), q);
};
const raw = (f, name, args, user) => f.rpc("erp_home_business_panel", { p_user_id: user ?? f.users.admin, p_panel: name, p_args: args });

/** A empresa do Fagoo; com products=false os itens são só descrição (sem custo a buscar). */
async function company(products) {
  const f = await dualFixture();
  const a = await f.catalog("contacts", { name: "Cliente Alfa", state: "SP", email: "alfa@sintetico.test", mobile: "11999990000" }),
    b = await f.catalog("contacts", { name: "Cliente Beta", state: "RJ" });
  const pen = products ? await f.catalog("products", { name: "Caneta azul", code: "CAN-1", unit: "UN", kind: "P", format: "S", price: "3", brand: "Marca X" }) : null;
  const pencil = products ? await f.catalog("products", { name: "Lápis", code: "LAP-1", unit: "UN", kind: "P", format: "S", price: "1" }) : null;
  const item = (p, description, quantity, unit_price) => (p ? { product_id: p.id, description, quantity, unit_price } : { description, quantity, unit_price });
  if (products) await documentOf(f, "purchase_orders", { contact: b.id, date: "2026-10-01", items: [item(pen, "Caneta azul", "10", "1.25")] });
  await documentOf(f, "sales_orders", { contact: a.id, date: "2026-09-20", statuses: ["open", "verified"], items: [item(pen, "Caneta azul", "1", "3")] });
  const o1 = await documentOf(f, "sales_orders", {
    contact: a.id, date: "2026-10-10", statuses: ["open", "verified"], body: { freight: "5" },
    items: [item(pen, "Caneta azul", "2", "3"), item(pencil, "Lápis", "5", "1")],
  });
  const o2 = await documentOf(f, "sales_orders", { contact: b.id, date: "2026-10-12", statuses: ["open", "in_progress"], items: [item(pen, "Caneta azul", "4", "2.5")] });
  await documentOf(f, "sales_orders", { contact: b.id, date: "2026-10-13", statuses: ["open", "cancelled"], items: [item(pen, "Caneta azul", "1", "3")] });
  return { f, a, b, pen, pencil, o1, o2 };
}

test("itens sem produto: todos os painéis nos dois motores, papéis e entradas", async () => {
  const { f, b } = await company(false);
  try {
    const v = await panel(f, "mensal", { situacoes: S, de: "2026-10-01", ate: "2026-10-31", comparar_de: "2026-09-01", comparar_ate: "2026-09-30" });
    assert.deepEqual(v.kpis.current, { total: "26.00", orders: 2, units: "11.000000", ticket: "13.00" });
    assert.deepEqual(v.kpis.previous, { total: "3.00", orders: 1, units: "1.000000", ticket: "3.00" });
    assert.equal(v.daily.current.length, 31);
    assert.equal(v.daily.current[9].total, "16.00");
    assert.deepEqual(v.statuses.map((s) => [s.status, s.orders]), [["verified", 1], ["in_progress", 1], ["fulfilled", 0]]);
    assert.deepEqual(v.channels, [{ channel: "Pedido Manual", orders: 2, total: "26.00" }]);
    assert.equal(v.indicators.lines_without_cost, 3, "itens sem produto não têm custo");
    for (const user of [f.users.vendas, f.users.financeiro, f.users.consulta]) await panel(f, "mensal", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" }, user);
    const d = await panel(f, "diario", { situacoes: S, dia: "2026-10-12", comparar: "2026-10-10" });
    assert.deepEqual(d.kpis.current, { total: "10.00", orders: 1, units: "4.000000", ticket: "10.00", new_customers: 1 });
    assert.equal(d.kpis.previous.new_customers, 0);
    const o = await panel(f, "pedidos-venda", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual(o.totals, { orders: 2, units: "11.000000", total: "26.00", freight: "5.00", ticket: "13.00" });
    assert.deepEqual(o.by_state.map((s) => [s.state, s.total]), [["SP", "16.00"], ["RJ", "10.00"]]);
    assert.equal((await panel(f, "pedidos-venda", { situacoes: S, de: "2026-10-01", ate: "2026-10-31", uf: "SP" })).totals.orders, 1);
    const s = await panel(f, "vendas-vendedor", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual(s.by_seller.map((x) => [x.seller, x.orders]), [[null, 2]]);
    assert.equal(s.evolution.length, 31);
    const c = await panel(f, "venda-canal", {});
    assert.equal(c.months.length, 24);
    assert.deepEqual(c.filters.statuses, ["verified", "in_progress", "fulfilled"]);
    const m = await panel(f, "margem-pedido", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual([m.indicators.orders, m.indicators.orders_without_cost], [2, 2]);
    const n = await panel(f, "novos-recorrentes", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual(n.customers.map((x) => [x.name, x.kind]), [["Cliente Alfa", "recorrente"], ["Cliente Beta", "novo"]]);
    assert.equal(n.customers[0].mobile, "11999990000");
    const p = await panel(f, "atividade-carteira", { de: "2026-09-01", ate: "2026-10-31", palavras: "alfa" });
    assert.deepEqual(p.customers.map((x) => [x.name, x.orders, x.first_purchase, x.last_purchase, x.cycle_days, x.state, x.email]), [
      ["Cliente Alfa", 2, "2026-09-20", "2026-10-10", 20, "SP", "alfa@sintetico.test"],
    ]);
    const abc = await panel(f, "curva-abc", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual(abc.products.map((x) => [x.name, x.curve, x.cumulative_pct]), [["Caneta azul", "A", "76.19"], ["Lápis", "C", "100.00"]]);
    const fc = await panel(f, "previsao-estoque", { de: "2026-10-01", ate: "2026-10-31", reserva: "sim", modo: "itens" });
    assert.deepEqual(fc.turnover, [], "previsão só conta itens com produto");
    // Ajustes: Venda Canal segue as situações finalizadas.
    await preference(f, "meu-negocio", "negocio.situacoes_finalizado", ["fulfilled", "in_progress"]);
    assert.deepEqual((await panel(f, "venda-canal", {})).filters.statuses, ["in_progress", "fulfilled"]);
    await preference(f, "meu-negocio", "negocio.situacoes_finalizado", []);
    assert.deepEqual((await panel(f, "venda-canal", {})).filters.statuses, ["verified", "in_progress", "fulfilled"], "vazio volta ao padrão");
    // Entradas recusadas antes de ler; papéis.
    const base = { p_statuses: ["verified"], p_from: "2026-10-01", p_to: "2026-10-31", p_compare_from: null, p_compare_to: null };
    for (const args of [{ ...base, p_statuses: ["x"] }, { ...base, p_statuses: ["verified", "verified"] }, { ...base, p_from: "2026-10-31", p_to: "2026-10-01" },
      { ...base, p_from: "2025-01-01" }, { ...base, p_compare_from: "2026-09-01" }, { ...base, extra: 1 }, { ...base, p_statuses: "verified" }])
      await fails(() => raw(f, "mensal", args), "22023");
    await fails(() => raw(f, "outro", {}), "22023");
    await fails(() => raw(f, "mensal", { ...base, p_from: "x" }), "22007");
    for (const user of [f.users.inactive, randomUUID()]) await fails(() => raw(f, "venda-canal", {}, user), "42501");
    await fails(() => raw(f, "margem-pedido", { p_statuses: ["verified"], p_from: "2026-10-01", p_to: "2026-10-31", p_tab: "todos" }, f.users.vendas), "42501");
    await fails(() => raw(f, "previsao-estoque", { p_from: "2026-10-01", p_to: "2026-10-31", p_warehouse_id: null, p_reserve: false }, f.users.financeiro), "42501");
    await fails(() => raw(f, "previsao-estoque", { p_from: "2026-10-01", p_to: "2026-10-31", p_warehouse_id: randomUUID(), p_reserve: false }), "P0002");
    await fails(() => raw(f, "pedidos-venda", { p_statuses: ["verified"], p_from: "2026-10-01", p_to: "2026-10-31", p_state: "XX" }), "22023");
    await fails(() => raw(f, "atividade-carteira", { p_from: "2026-10-01", p_to: "2026-10-31", p_brand: null, p_min_days: null, p_keywords: [" x"] }), "22023");
    assert.equal((await raw(f, "atividade-carteira", { p_from: "2026-09-01", p_to: "2026-10-31", p_brand: null, p_min_days: 0, p_keywords: ["beta"] })).customers.length, 1);
    assert.ok(b);
  } finally {
    await f.close();
  }
});

test("150 Metas: administrador creates and edits with CAS, the same command replays, others only read; achieved follows Ajustes", async () => {
  const { f } = await company(false);
  try {
    const goalOther = randomUUID();
    await f.db.query("insert into auth.users(id,email) values($1,'outro@sintetico.test')", [goalOther]);
    await f.db.query("insert into erp_access.membership(user_id,role,active) values($1,'admin',true)", [goalOther]);
    await f.sync();
    const input = { command_id: randomUUID(), goal_id: null, expected_version: 0, data: { name: "Meta de outubro", start_on: "2026-10-01", end_on: "2036-09-30", segment: "geral", seller: null, target: "1000", active: true } };
    const sent = captureGoalSave(input);
    const args = { p_command_id: sent.command_id, p_goal_id: null, p_expected_version: 0, p_data: sent.data };
    const save = (a, user) => raw(f, "metas_save", a, user);
    await fails(() => save(args, f.users.vendas), "42501");
    const saved = parseGoalResult(await save(args), { commandId: sent.command_id, input: sent });
    assert.equal(saved.replayed, false);
    assert.equal(saved.goal.achieved, "26.00");
    assert.equal(saved.goal.target, "1000.00");
    assert.equal((await save(args)).replayed, true);
    await fails(() => save({ ...args, p_data: { ...sent.data, target: "2000" } }), "40001");
    const q = captureGoalsQuery({ aba: "andamento" }),
      list = parseGoals(await raw(f, "metas", { p_tab: "andamento" }, f.users.vendas), q);
    assert.equal(list.can_manage, false);
    assert.equal(list.items.length, 1);
    const edit = { p_command_id: randomUUID(), p_goal_id: saved.goal.id, p_expected_version: 1, p_data: { ...sent.data, active: false } };
    await fails(() => save({ ...edit, p_expected_version: 0 }), "22023");
    await fails(() => save({ ...edit, p_expected_version: 2 }), "40001");
    assert.equal((await save(edit)).goal.version, 2);
    await fails(() => save({ ...edit, p_command_id: randomUUID(), p_expected_version: 2 }), "22023");
    assert.equal((await raw(f, "metas", { p_tab: "inativas" })).items.length, 1);
    assert.equal((await raw(f, "metas_command", { p_command_id: sent.command_id })).replayed, true);
    await fails(() => raw(f, "metas_command", { p_command_id: sent.command_id }, goalOther), "42501");
    await fails(() => raw(f, "metas_command", { p_command_id: randomUUID() }), "P0002");
    assert.equal(await f.scalar("select count(*)::int v from erp_home.goal_audit"), 2);
    for (const data of [{ ...sent.data, name: " x" }, { ...sent.data, segment: "vendedor" }, { ...sent.data, target: "0" }, { ...sent.data, start_on: "2026-02-30" }, { ...sent.data, end_on: "2026-09-01" }])
      await fails(() => save({ ...args, p_command_id: randomUUID(), p_data: data }), "22023");
    const seller = await save({ ...args, p_command_id: randomUUID(), p_data: { ...sent.data, name: "Meta do vendedor", segment: "vendedor", seller: "Vendedor X" } });
    assert.equal(seller.goal.achieved, "0.00");
  } finally {
    await f.close();
  }
});

test("produtos com custo no histórico do cadastro: margens, ABC, previsão e o estoque do produto nos dois motores", async () => {
  const { f, pen, pencil } = await company(true);
  try {
    // Custo do cadastro antes das vendas (product_cost_at): a última compra (pendente na O) não é consultada.
    await f.db.query(
      "insert into erp_catalog.product_cost_history(product_id,cost_price,purchase_price,valid_from,source) values($1,1.25,1.25,'2026-01-01T03:00:00Z','cadastro'),($2,0.4,null,'2026-01-01T03:00:00Z','cadastro'),($1,1.3333333333,null,'2026-10-11T03:00:00Z','cadastro')",
      [pen.id, pencil.id],
    );
    await f.sync();
    const S2 = { situacoes: S, de: "2026-10-01", ate: "2026-10-31" };
    const v = await panel(f, "mensal", { ...S2, comparar_de: "2026-09-01", comparar_ate: "2026-09-30" });
    assert.equal(v.indicators.lines_without_cost, 0);
    assert.equal(v.indicators.cost, "9.50", "caneta: custo congelado na confirmação (1.25, item_cost_applied) vence o histórico; lápis: 5×0.40");
    for (const user of [f.users.admin, f.users.vendas, f.users.financeiro, f.users.estoque]) await panel(f, "mensal", S2, user);
    const o = await panel(f, "pedidos-venda", S2);
    assert.deepEqual(o.by_product.map((p) => [p.code, p.cost]), [["CAN-1", "7.50"], ["LAP-1", "2.00"]]);
    for (const name of ["vendas-vendedor", "novos-recorrentes", "curva-abc"]) await panel(f, name, S2);
    const m = await panel(f, "margem-pedido", S2);
    assert.equal(m.indicators.orders_without_cost, 0);
    for (const aba of ["lucro", "prejuizo"]) await panel(f, "margem-pedido", { ...S2, aba });
    assert.equal((await panel(f, "curva-abc", { ...S2, marca: "marca x" })).products.length, 1);
    for (const [reserva, modo] of [["sim", "itens"], ["nao", "desmembrados"]]) {
      const fc = await panel(f, "previsao-estoque", { de: "2026-10-01", ate: "2026-10-31", reserva, modo });
      assert.deepEqual(fc.turnover.map((x) => [x.code, x.sold, x.coverage_days]), [["CAN-1", "6.000000", 0], ["LAP-1", "5.000000", 0]]);
    }
    await panel(f, "diario", { situacoes: S, dia: "2026-10-12" });
  } finally {
    await f.close();
  }
});

test("150 Mensal com produtos: indicadores com o custo da última compra", async () => {
  const { f } = await company(true);
  try {
    const v = await panel(f, "mensal", { situacoes: S, de: "2026-10-01", ate: "2026-10-31", comparar_de: "2026-09-01", comparar_ate: "2026-09-30" });
    assert.deepEqual(v.indicators, { revenue_without_freight: "21.00", cost: "7.50", gross_margin: "13.50", gross_margin_pct: "64.29", lines_without_cost: 1, taxes: "0.00", fees: null, profit: "13.50" });
    assert.deepEqual(v.top_skus.map((s) => [s.code, s.units, s.stock, s.forecast_days]), [["CAN-1", "6.000000", "0.000000", 0], ["LAP-1", "5.000000", "0.000000", 0]]);
    const o = await panel(f, "pedidos-venda", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.deepEqual(o.by_product.map((p) => [p.code, p.total, p.cost, p.margin_pct]), [["CAN-1", "16.00", "7.50", "53.13"], ["LAP-1", "5.00", null, null]]);
    const m = await panel(f, "margem-pedido", { situacoes: S, de: "2026-10-01", ate: "2026-10-31" });
    assert.equal(m.indicators.contribution, "5.00");
    const abc = await panel(f, "curva-abc", { situacoes: S, de: "2026-10-01", ate: "2026-10-31", marca: "marca x" });
    assert.equal(abc.products.length, 1);
    const fc = await panel(f, "previsao-estoque", { de: "2026-10-01", ate: "2026-10-31", reserva: "sim", modo: "itens" });
    assert.deepEqual(fc.turnover.map((x) => [x.code, x.sold, x.coverage_days]), [["CAN-1", "6.000000", 0], ["LAP-1", "5.000000", 0]]);
  } finally {
    await f.close();
  }
});
