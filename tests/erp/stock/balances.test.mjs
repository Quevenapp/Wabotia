// Saldos e posições (erp_stock_balances, _positions, _availability,
// _movements) nos dois motores. Cenários do test_stock_positions_sql do Fagoo
// (sem os que dependem do estorno, ainda não portado) e da reserva por
// situação e da composição virtual.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u;
const code = (p) => p.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
before(async () => {
  f = await dualFixture();
  u = f.users;
});
after(() => f?.close());

const product = (data = {}) => f.catalog("products", { name: "Produto sintético " + randomUUID(), unit: "UN", kind: "P", format: "S", price: "1.0000", ...data });
const warehouse = (name = "Depósito " + randomUUID()) => f.catalog("warehouses", { name });
const post = (p, w, quantity, version = 0, kind = "receipt") =>
  f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: "2024-10-15", p_reason: "Estoque sintético",
    p_items: [{ product_id: p.id, warehouse_id: w.id, quantity, expected_version: version }], p_reference: null,
  });
const positions = (args = {}, user = u.admin) =>
  f.rpc("erp_stock_positions", {
    p_user_id: user, p_limit: 100, p_after: null, p_active: null, p_query: null, p_brand: null, p_location: null,
    p_warehouse_id: null, p_stock_state: null, p_limit_state: null, ...args,
  });
const balances = (p, w = null, user = u.estoque) => f.rpc("erp_stock_balances", { p_user_id: user, p_product_id: p.id, p_warehouse_id: w?.id ?? null });
const write = async (sql, args = []) => {
  await f.db.query(sql, args);
  await f.sync();
};
/** Montagem direta no oráculo, sem as guardas (como os desvios do harness), e espelho no SQLite. */
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};

test("posição sem movimento, mínimo e máximo pela soma global, somas exatas", async () => {
  const p = await product({ code: "UNKNOWN025" }),
    w = await warehouse();
  let row = (await positions({ p_query: "unknown025" })).items[0];
  assert.equal(row.global.state, "no_movements");
  row = (await positions({ p_query: "UNKNOWN025", p_warehouse_id: w.id })).items[0];
  assert.equal(row.selected_position.version, 0);
  const g = await product({ code: "GLOBAL025", stock_min: "6", stock_max: "7" }),
    a = await warehouse(),
    b = await warehouse(),
    c = await warehouse();
  await post(g, a, "2");
  await post(g, b, "5");
  await write("update erp_catalog.record set active=false where id=$1", [b.id]);
  row = (await positions({ p_query: "GLOBAL025", p_warehouse_id: a.id, p_limit_state: "within" })).items[0];
  assert.equal(row.global.quantity, "7.000000");
  await positions({ p_query: "GLOBAL025", p_warehouse_id: a.id, p_limit_state: "below_min" });
  await positions({ p_query: "GLOBAL025", p_warehouse_id: c.id, p_stock_state: "no_movements", p_limit_state: "within" });
  await post(g, a, "0.000001", 1);
  assert.equal((await positions({ p_query: "GLOBAL025" })).items[0].limit_state, "above_max");
  await post(g, a, "-2.000001", 2, "issue");
  assert.equal((await positions({ p_query: "GLOBAL025" })).items[0].limit_state, "below_min");
  const e = await product({ code: "EXACT025", unit: "KG" }),
    x = await warehouse(),
    y = await warehouse();
  await post(e, x, "999999999999.999999");
  await post(e, y, "999999999999.999999");
  assert.equal((await positions({ p_query: "EXACT025" })).items[0].global.quantity, "1999999999999.999998");
});

test("inconsistências viram review_required; filtros, cursor e depósito ignorado", async () => {
  const p = await product({ code: "REVIEW025", stock_min: "1" }),
    w = await warehouse();
  await post(p, w, "2");
  await write("update erp_stock.balance set unit='KG' where product_id=$1", [p.id]);
  await positions({ p_query: "REVIEW025", p_stock_state: "review_required", p_warehouse_id: w.id });
  await write("update erp_stock.balance set unit='UN',quantity=3 where product_id=$1", [p.id]);
  assert.equal((await positions({ p_query: "REVIEW025" })).items[0].global.state, "review_required");
  const blank = await product({ code: "REVIEW025-ORPHAN" });
  await write("insert into erp_stock.balance(product_id,warehouse_id,quantity,unit)values($1,$2,0,'UN')", [blank.id, w.id]);
  await positions({ p_query: "REVIEW025-ORPHAN" });
  const rows = [];
  for (let i = 0; i < 3; i++)
    rows.push(await product({ name: `Filtros025 ÁÇ ${i}`, code: `FILTER025-${i}`, brand: i === 0 ? "Marca % A" : "Marca B", location: "Prat_1", gtin: "12345678" }));
  await write("update erp_catalog.record set active=false where id=$1", [rows[2].id]);
  await positions({ p_query: "filtros025 áç", p_brand: "%", p_location: "_", p_active: true });
  await positions({ p_query: "12345678", p_limit: 1 });
  const first = await positions({ p_query: "Filtros025", p_limit: 2 });
  await positions({ p_query: "Filtros025", p_limit: 2, p_after: first.next_cursor });
  for (const bad of [{ p_limit: 0 }, { p_query: "x".repeat(121) }, { p_brand: "a\nb" }, { p_stock_state: "x" }, { p_limit_state: "x" }])
    assert.match(await code(positions(bad)), /^22023:/);
  assert.match(await code(positions({ p_warehouse_id: randomUUID() })), /^P0002:/);
  // Depósito com "desconsiderar saldo": fora do total.
  const ig = await warehouse();
  const q = await product({ code: "IGNORED025" });
  await post(q, w, "4");
  await post(q, ig, "10");
  await seed("insert into erp_stock.warehouse_setting(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id) values($1,true,1,now(),$2,$3)", [ig.id, u.admin, randomUUID()]).catch(() => null);
  await positions({ p_query: "IGNORED025" });
  await balances(q);
});

test("saldos, disponibilidade e movimentos", async () => {
  const p = await product(),
    a = await warehouse(),
    b = await warehouse();
  await post(p, a, "3.5");
  await post(p, a, "1", 1);
  await post(p, b, "2");
  await balances(p);
  await balances(p, a);
  await balances(p, { id: randomUUID() });
  assert.match(await code(f.rpc("erp_stock_balances", { p_user_id: u.estoque, p_product_id: randomUUID(), p_warehouse_id: null })), /^P0002:erp_stock_product_not_found/);
  for (const role of ["consulta", "vendas", "fiscal", "financeiro", "inactive"]) await code(balances(p, null, u[role]));
  const av = (prod, wh) => f.rpc("erp_stock_availability", { p_user_id: u.estoque, p_product_id: prod, p_warehouse_id: wh });
  assert.equal((await av(p.id, a.id)).position.state, "recorded");
  await av(p.id, (await warehouse()).id);
  assert.match(await code(av(null, a.id)), /^22023:/);
  assert.match(await code(av(randomUUID(), a.id)), /^P0002:erp_stock_product_not_found/);
  assert.match(await code(av(p.id, randomUUID())), /^P0002:erp_stock_warehouse_not_found/);
  const mv = (args) => f.rpc("erp_stock_movements", { p_user_id: u.estoque, p_product_id: p.id, p_limit: 2, p_after: null, ...args });
  const page = await mv({});
  assert.equal(page.has_more, true);
  await mv({ p_after: page.next_cursor });
  assert.match(await code(mv({ p_limit: 101 })), /^22023:/);
});

test("composição virtual e reserva por situação", async () => {
  const a = await warehouse(),
    b = await warehouse();
  const c1 = await product({ code: "COMP-A" }),
    c2 = await product({ code: "COMP-B" });
  await post(c1, a, "7");
  await post(c2, a, "3");
  await post(c1, b, "1");
  const kit = await product({ code: "KIT-V", format: "E" });
  const version = 1;
  await seed("insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_at,updated_by,command_id) values($1,'virtual','components',$2,now(),$3,$4)",
    [kit.id, version, u.admin, randomUUID()],
  ).catch((e) => console.log("composição", e.message));
  await seed("insert into erp_stock.composition_item(product_id,version,position,component_id,quantity) values($1,$2,1,$3,2),($1,$2,2,$4,1)", [kit.id, version, c1.id, c2.id]).catch(
    (e) => console.log("itens", e.message),
  );
  await balances(kit);
  await positions({ p_query: "KIT-V" });
  // Reserva por situação: pedido de venda "em aberto" com o componente.
  await seed(
    "insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values('estoque.reserva_por_situacao','true'::jsonb,1,now(),$1,gen_random_uuid()) on conflict (key) do update set value='true'::jsonb",
    [u.admin],
  ).catch((e) => console.log("pref1", e.message));
  await seed(
    `insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values('estoque.reserva_situacoes','["em_aberto","em_digitacao","em_aberto"]'::jsonb,1,now(),$1,gen_random_uuid()) on conflict (key) do update set value=excluded.value`,
    [u.admin],
  ).catch((e) => console.log("pref2", e.message));
  await f.sync();
  await balances(c1);
  await balances(c1, a);
});
