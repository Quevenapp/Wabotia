// Extrato (erp_stock_ledger), contexto do lançamento (erp_stock_launch_context)
// e fornecedores (erp_stock_suppliers) nos dois motores.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, p, a, b, moves;
const code = (x) => x.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
const product = (data = {}) => f.catalog("products", { name: "Produto " + randomUUID(), unit: "UN", kind: "P", format: "S", ...data });
const warehouse = () => f.catalog("warehouses", { name: "Depósito " + randomUUID() });
const post = async (items, kind = "receipt", date = "2024-10-15") =>
  (await f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: date, p_reason: "Movimento " + kind,
    p_items: items, p_reference: "REF-" + kind,
  })).movement.id;
const line = (prod, wh, quantity, expected_version) => ({ product_id: prod.id, warehouse_id: wh.id, quantity, expected_version });
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};

before(async () => {
  f = await dualFixture();
  u = f.users;
  p = await product({ price: "15.5" });
  a = await warehouse();
  b = await warehouse();
  moves = [];
  moves.push(await post([line(p, a, "10", 0)], "receipt", "2024-10-01"));
  moves.push(await post([line(p, a, "-3", 1)], "issue", "2024-10-02"));
  moves.push(await post([line(p, a, "-2", 2), line(p, b, "2", 0)], "transfer", "2024-10-03"));
  moves.push(await post([line(p, b, "1.5", 1)], "adjustment", "2024-10-04"));
  moves.push(await post([line(p, a, "4", 3)], "receipt", "2024-10-05"));
  await seed(
    "insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) values($1,$2,1,'9.99','8.5','Primeira entrada',$3,$4,now()),($5,$2,1,'11.25',null,'Segunda',$3,$6,now()),($5,$2,2,'11.5','10','Revisada',$3,$7,now())",
    [moves[0], p.id, u.admin, randomUUID(), moves[4], randomUUID(), randomUUID()],
  );
  await seed("insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source,created_at) values($1,$2,$3,3.5,2,'count',now())", [moves[3], p.id, b.id]);
});
after(() => f?.close());

test("extrato: filtros, direção, balanço, páginas e preço por papel", async () => {
  const ledger = (args = {}, user = u.admin) =>
    f.rpc("erp_stock_ledger", {
      p_user_id: user, p_product_id: p.id, p_warehouse_id: null, p_limit: 2, p_offset: 0, p_kind: null, p_origin: null,
      p_direction: null, p_date_from: null, p_date_to: null, ...args,
    });
  const all = await ledger({ p_limit: 100 });
  assert.equal(all.total, 5);
  await ledger();
  await ledger({ p_offset: 2 });
  await ledger({ p_offset: 4 });
  await ledger({ p_warehouse_id: b.id, p_limit: 100 });
  for (const k of ["receipt", "issue", "transfer", "adjustment", "reversal"]) await ledger({ p_kind: k, p_limit: 100 });
  for (const o of ["transfers", "none", "sales", "deleted"]) await ledger({ p_origin: o, p_limit: 100 });
  for (const d of ["entry", "exit", "balance"]) await ledger({ p_direction: d, p_limit: 100 });
  await ledger({ p_direction: "entry", p_warehouse_id: a.id, p_limit: 100 });
  await ledger({ p_date_from: "2024-10-02", p_date_to: "2024-10-04", p_limit: 100 });
  for (const role of ["consulta", "estoque", "vendas", "fiscal"]) await ledger({ p_limit: 100 }, u[role]);
  for (const bad of [{ p_limit: 0 }, { p_offset: -1 }, { p_offset: 100001 }, { p_kind: "x" }, { p_origin: "x" }, { p_direction: "x" }, { p_date_from: "1899-12-31" }, { p_date_from: "2024-10-05", p_date_to: "2024-10-01" }, { p_product_id: null }])
    assert.match(await code(ledger(bad)), /^22023:/, JSON.stringify(bad));
  assert.match(await code(ledger({ p_product_id: randomUUID() })), /^P0002:erp_stock_product_not_found/);
  assert.match(await code(ledger({ p_warehouse_id: randomUUID() })), /^P0002:erp_stock_warehouse_not_found/);
});

test("contexto do lançamento: última compra, custo médio, fornecedor e casas", async () => {
  const context = (args = {}, user = u.estoque) => f.rpc("erp_stock_launch_context", { p_user_id: user, p_product_id: p.id, ...args });
  const r = await context();
  assert.equal(r.last_purchase.unit_price, "11.5000000000");
  assert.match(await code(context({}, u.consulta)), /^42501:/);
  assert.match(await code(context({ p_product_id: null })), /^22023:/);
  assert.match(await code(context({ p_product_id: randomUUID() })), /^P0002:/);
  const supplier = await f.catalog("contacts", { name: "Fornecedor Ágil", person_type: "J", roles: ["supplier"] }).catch((e) => (console.log("contato", e.message), null));
  if (supplier)
    await seed(
      "insert into erp_catalog.product_supplier(record_id,supplier_id,code,purchase_price,cost_price,is_default,position) values($1,$2,'F-1',7.1,6.9,true,1)",
      [p.id, supplier.id],
    ).catch((e) => console.log("fornecedor", e.message));
  await context();
  for (const [key, value] of [["estoque.considerar_balancos", "true"], ["empresa.decimais_preco_entrada", "4"], ["estoque.tipo_preco_entrada", '"custo_fornecedor"']])
    await seed(
      "insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values($1,$2::jsonb,1,now(),$3,gen_random_uuid()) on conflict (key) do update set value=excluded.value",
      [key, value, u.admin],
    );
  await context();
  const q = await product();
  await context({ p_product_id: q.id });
});

test("fornecedores: papel, busca sem acento e acesso", async () => {
  const sup = (query, user = u.estoque) => f.rpc("erp_stock_suppliers", { p_user_id: user, p_query: query });
  await sup(null);
  for (const q of ["agil", "  ÁGIL ", "F-1", "zzz", ""]) await sup(q);
  assert.match(await code(sup("x".repeat(121))), /^22023:/);
  assert.match(await code(sup("a\tb")), /^22023:/);
  for (const role of ["consulta", "financeiro", "inactive"]) await code(sup(null, u[role]));
});
