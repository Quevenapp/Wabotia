// Relatórios do Estoque nos dois motores: abaixo do mínimo, saldos numa
// data, transferências, maior circulação, movimentação do produto, sem
// movimentação, movimentações por produto, visão financeira e notas de entrada.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, a, b, ig, p1, p2, p3;
const code = (x) => x.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
const product = (data = {}) => f.catalog("products", { name: "Produto " + randomUUID(), unit: "UN", kind: "P", format: "S", ...data });
const warehouse = (name) => f.catalog("warehouses", { name: name ?? "Depósito " + randomUUID() });
const post = async (items, kind, date) =>
  (await f.rpc("erp_stock_post", {
    p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: date, p_reason: "Movimento " + kind,
    p_items: items, p_reference: null,
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
  a = await warehouse("Depósito A");
  b = await warehouse("Depósito B");
  ig = await warehouse("Depósito ignorado");
  p1 = await product({ name: "Água mineral", code: "AG-1", stock_min: "20", stock_max: "50", price: "2.5" });
  p2 = await product({ name: "Biscoito", code: "BI-2", stock_min: "1", price: "3.333" });
  p3 = await product({ name: "Café", code: "CA-3" });
  await post([line(p1, a, "10", 0), line(p2, a, "5", 0)], "receipt", "2024-09-01");
  await post([line(p1, a, "-4", 1)], "issue", "2024-09-10");
  await post([line(p1, a, "-2", 2), line(p1, b, "2", 0)], "transfer", "2024-09-12");
  await post([line(p3, b, "7", 0)], "receipt", "2024-08-01");
  await post([line(p2, ig, "100", 0)], "receipt", "2024-09-15");
  const m = await post([line(p2, a, "1.5", 1)], "adjustment", "2024-09-20");
  await seed("insert into erp_stock.balance_count(movement_id,product_id,warehouse_id,counted,previous,source,created_at) values($1,$2,$3,6.5,5,'count',now())", [m, p2.id, a.id]);
  await seed("insert into erp_stock.warehouse_setting(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id) values($1,true,1,now(),$2,$3)", [ig.id, u.admin, randomUUID()]);
  await seed(
    "insert into erp_stock.movement_detail(movement_id,product_id,revision,unit_price,unit_cost,note,actor,command_id,created_at) select e.movement_id,e.product_id,1,1.75,null,'Nota da entrada',$1,gen_random_uuid(),now() from erp_stock.entry e where e.quantity>0 and e.product_id=$2",
    [u.admin, p1.id],
  );
});
after(() => f?.close());

const R = (name, args, user = u.estoque) => f.rpc(name, { p_user_id: user, ...args });

test("abaixo do mínimo, saldos numa data, sem movimentação e financeiro", async () => {
  for (const w of [null, a.id, ig.id]) {
    await R("erp_stock_report_below_min", { p_warehouse_id: w, p_offset: 0, p_limit: 500 });
    await R("erp_stock_report_balances_at", { p_date: "2024-09-11", p_warehouse_id: w, p_offset: 0, p_limit: 500 });
    await R("erp_stock_report_idle", { p_since: "2024-09-05", p_warehouse_id: w, p_offset: 0, p_limit: 500 });
    await R("erp_stock_report_financial", { p_warehouse_id: w, p_offset: 0, p_limit: 500 });
  }
  await R("erp_stock_report_below_min", { p_warehouse_id: null, p_offset: 1, p_limit: 1 });
  for (const bad of [{ p_offset: -1 }, { p_offset: 100001 }, { p_limit: 0 }, { p_limit: 501 }])
    assert.match(await code(R("erp_stock_report_below_min", { p_warehouse_id: null, p_offset: 0, p_limit: 10, ...bad })), /^22023:/);
  assert.match(await code(R("erp_stock_report_below_min", { p_warehouse_id: randomUUID(), p_offset: 0, p_limit: 10 })), /^P0002:/);
  for (const role of ["vendas", "consulta", "fiscal"]) await code(R("erp_stock_report_financial", { p_warehouse_id: null, p_offset: 0, p_limit: 10 }, u[role]));
});

test("transferências, maior circulação, produto e movimentações", async () => {
  const period = { p_date_from: "2024-08-01", p_date_to: "2024-09-30" };
  for (const w of [null, a.id, b.id]) {
    await R("erp_stock_report_transfers", { ...period, p_warehouse_id: w, p_offset: 0, p_limit: 500 });
    await R("erp_stock_report_top", { ...period, p_warehouse_id: w, p_limit: 2 });
    await R("erp_stock_report_movements", { ...period, p_warehouse_id: w, p_product_id: null, p_offset: 0, p_limit: 500 });
    await R("erp_stock_report_product", { ...period, p_warehouse_id: w, p_product_id: p1.id });
  }
  await R("erp_stock_report_product", { p_date_from: "2024-09-11", p_date_to: "2024-09-30", p_warehouse_id: null, p_product_id: p1.id });
  await R("erp_stock_report_movements", { ...period, p_warehouse_id: null, p_product_id: p2.id, p_offset: 0, p_limit: 500 });
  for (const bad of [
    { p_date_from: "2024-10-01", p_date_to: "2024-09-01" },
    { p_date_from: "1899-12-31", p_date_to: "1900-01-02" },
    { p_date_from: "2000-01-01", p_date_to: "2010-12-31" },
  ])
    assert.match(await code(R("erp_stock_report_top", { ...bad, p_warehouse_id: null, p_limit: 10 })), /^22023:/);
  assert.match(await code(R("erp_stock_report_product", { ...period, p_warehouse_id: null, p_product_id: randomUUID() })), /^P0002:/);
});

test("notas de entrada: agrupamentos, papéis e período", async () => {
  const notes = (group, user = u.admin) => R("erp_stock_report_entry_notes", { p_date_from: "2024-01-01", p_date_to: "2024-12-31", p_group: group }, user);
  const invoice = (nature, recipient, date, total) =>
    seed(
      `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by)
       values(gen_random_uuid(),'55','0','N','2',1,1,$1,$2,'1','1','0',false,$3::jsonb,'[]','{}','{}','[]','{}',false,0,0,0,0,$4::jsonb,1,$5,$5)`,
      [nature, date, JSON.stringify(recipient), JSON.stringify({ total }), u.admin],
    ).then(() => true, (e) => (console.log("nota", e.message), false));
  await invoice("Compra para revenda", { name: "Fornecedor Z", document: "11222333000181" }, "2024-03-05", 100.5);
  await invoice("Compra para revenda", { name: "Fornecedor Y", document: "11222333000181" }, "2024-03-20", 10);
  await invoice("Devolução", { name: "Ana" }, "2024-04-02", 99.999);
  await invoice("Compra para revenda", {}, "2024-04-30", 7);
  for (const g of ["nature", "supplier", "product", "month"]) await notes(g);
  for (const role of ["fiscal", "estoque"]) await code(notes("month", u[role]));
  assert.match(await code(notes("x")), /^22023:/);
  assert.match(await code(notes(null)), /^22023:/);
});
