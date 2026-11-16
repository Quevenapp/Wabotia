// erp_stock_totals e o custo médio (erp_stock.average_costs) nos dois
// motores: preço de venda, custo pelo detalhe do lançamento (preço e custo do
// lançamento, as duas bases), média ponderada com arredondamento em 10 casas,
// depósito ignorado, filtro por depósito e papéis sem custo.
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

const product = (data = {}) => f.catalog("products", { name: "Produto " + randomUUID(), unit: "UN", kind: "P", format: "S", ...data });
const warehouse = () => f.catalog("warehouses", { name: "Depósito " + randomUUID() });
const post = async (p, w, quantity, version = 0, kind = "receipt") =>
  (await f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: "2024-10-15", p_reason: "Estoque sintético",
    p_items: [{ product_id: p.id, warehouse_id: w.id, quantity, expected_version: version }], p_reference: null,
  })).movement.id;
const seed = async (sql, args = []) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
};
const detail = (movement, p, price, cost = null) =>
  seed(
    "insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) values($1,$2,1,$3,$4,'Custo sintético',$5,$6,now())",
    [movement, p.id, price, cost, u.admin, randomUUID()],
  );
const totals = (args = {}) => f.rpc("erp_stock_totals", { p_user_id: u.estoque, p_warehouse_id: null, ...args });

test("totais: venda, custo médio pelas duas bases, depósito ignorado e papéis", async () => {
  await totals();
  const a = await warehouse(),
    b = await warehouse();
  const p = await product({ price: "12.3456" }),
    q = await product(),
    r = await product({ price: "0.0001" });
  const m1 = await post(p, a, "3");
  await detail(m1, p, "10.1234567891", "9.5");
  const m2 = await post(p, a, "1.333333", 1);
  await detail(m2, p, "7.0000000001", null);
  await post(p, a, "-0.5", 2, "issue");
  const m3 = await post(p, a, "2", 3, "adjustment");
  await detail(m3, p, "8", "8.25");
  await post(q, b, "5");
  await post(r, b, "999999.999999");
  await totals();
  await totals({ p_warehouse_id: a.id });
  await totals({ p_warehouse_id: b.id });
  assert.match(await code(totals({ p_warehouse_id: randomUUID() })), /^P0002:erp_stock_warehouse_not_found/);
  for (const role of ["admin", "consulta", "vendas", "fiscal", "financeiro", "inactive"]) await code(totals({ p_user_id: u[role] }));
  // Base de custo "custo do lançamento" e depósito ignorado.
  await seed(
    "insert into erp_preferences.company_value(key,value,version,updated_at,updated_by,command_id) values('estoque.custo_medio_base','\"custo_lancamento\"'::jsonb,1,now(),$1,gen_random_uuid()) on conflict (key) do update set value=excluded.value",
    [u.admin],
  );
  await seed("insert into erp_stock.warehouse_setting(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id) values($1,true,1,now(),$2,$3)", [b.id, u.admin, randomUUID()]);
  const t = await totals();
  assert.equal(t.ignored_warehouses, 1);
  assert.equal(t.cost_basis, "custo_lancamento");
  await totals({ p_warehouse_id: b.id });
});
