// Painéis do Estoque (erp_stock_dashboard_preference_get/set, _idle, _stock)
// e a lista de notas do check-in (erp_stock_checkin_notes) nos dois motores.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, u, a, b, ig, p1, p2, kit, supplier;
const code = (x) => x.then(() => "ok", (e) => (e.code === "ERR_ASSERTION" ? Promise.reject(e) : e.code + ":" + e.message));
const product = (data = {}) => f.catalog("products", { name: "Produto " + randomUUID(), unit: "UN", kind: "P", format: "S", ...data });
const warehouse = (name) => f.catalog("warehouses", { name });
const post = (items, kind = "receipt", date = "2024-09-01") =>
  f.rpc("erp_stock_post", { p_user_id: u.admin, p_command_id: randomUUID(), p_kind: kind, p_occurred_on: date, p_reason: "Movimento", p_items: items, p_reference: null });
const line = (prod, wh, quantity, expected_version = 0) => ({ product_id: prod.id, warehouse_id: wh.id, quantity, expected_version });
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
  a = await warehouse("Depósito Alfa");
  b = await warehouse("Depósito Beta");
  ig = await warehouse("Depósito Ignorado");
  supplier = await f.catalog("contacts", { name: "Fornecedor do painel", person_type: "J", roles: ["supplier"] });
  p1 = await product({ name: "Óleo de soja", code: "OL-01", gtin: "7891234567895", brand: "Marca Ágil", price: "8.99" });
  p2 = await product({ name: "Arroz", code: "AR-02", price: "21.5" });
  await post([line(p1, a, "12"), line(p2, a, "3")]);
  await post([line(p1, b, "4"), line(p2, ig, "50")]);
  await seed("insert into erp_stock.warehouse_setting(warehouse_id,ignore_balance,version,updated_at,updated_by,command_id) values($1,true,1,now(),$2,$3)", [ig.id, u.admin, randomUUID()]);
  await seed("insert into erp_catalog.product_supplier(record_id,supplier_id,code,purchase_price,cost_price,is_default,position) values($1,$2,'F-9',7,6.5,true,1)", [p1.id, supplier.id]);
  kit = await product({ name: "Kit cesta", code: "KIT-1", format: "E", price: "40" });
  await seed("insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_at,updated_by,command_id) values($1,'virtual','components',1,now(),$2,$3)", [kit.id, u.admin, randomUUID()]);
  await seed("insert into erp_stock.composition_item(product_id,version,position,component_id,quantity) values($1,1,1,$2,2),($1,1,2,$3,1)", [kit.id, p1.id, p2.id]);
});
after(() => f?.close());

test("preferência do painel: padrão, validação, comando, versão e repetição", async () => {
  await f.rpc("erp_stock_dashboard_preference_get", { p_user_id: u.estoque });
  const set = (args) =>
    f.rpc("erp_stock_dashboard_preference_set", {
      p_user_id: u.estoque, p_command_id: randomUUID(), p_expected_version: 0, p_purchase_statuses: ["open", "fulfilled"], p_sales_statuses: ["fulfilled", "draft"], ...args,
    });
  for (const bad of [{ p_purchase_statuses: [] }, { p_purchase_statuses: ["x"] }, { p_purchase_statuses: ["open", "open"] }, { p_sales_statuses: [1] }, { p_sales_statuses: null }, { p_command_id: null }, { p_expected_version: -1 }])
    assert.match(await code(set(bad)), /^22023:erp_stock_dashboard_preference_invalid/, JSON.stringify(bad));
  assert.match(await code(set({ p_expected_version: 2 })), /^40001:erp_stock_dashboard_version_conflict/);
  const command = randomUUID();
  await set({ p_command_id: command });
  assert.equal((await set({ p_command_id: command })).replayed, true);
  assert.match(await code(set({ p_command_id: command, p_sales_statuses: ["open"] })), /^40001:/);
  await set({ p_expected_version: 1, p_purchase_statuses: ["cancelled"] });
  await f.rpc("erp_stock_dashboard_preference_get", { p_user_id: u.estoque });
});

test("painel sem venda e painel de estoque: busca, filtros, virtual, custos e papéis", async () => {
  const idle = (args = {}, user = u.admin) => f.rpc("erp_stock_dashboard_idle", { p_user_id: user, p_since: "2024-12-01", p_page: 1, p_size: 10, ...args });
  await idle();
  await idle({ p_size: 1, p_page: 2 });
  for (const bad of [{ p_since: "1899-01-01" }, { p_page: 0 }, { p_size: 101 }]) assert.match(await code(idle(bad)), /^22023:/);
  for (const role of ["estoque", "consulta", "vendas"]) await code(idle({}, u[role]));
  const dash = (args = {}, user = u.admin) =>
    f.rpc("erp_stock_dashboard_stock", {
      p_user_id: user, p_page: 1, p_size: 10, p_search_by: "description", p_query: null, p_brand: null, p_stock_type: null, p_warehouse_id: null, p_supplier_id: null, ...args,
    });
  await dash();
  await dash({ p_query: "oleo" });
  await dash({ p_search_by: "code", p_query: "ol-0" });
  await dash({ p_search_by: "gtin", p_query: " 789123 " });
  await dash({ p_brand: "agil" });
  await dash({ p_supplier_id: supplier.id });
  await dash({ p_stock_type: "virtual" });
  await dash({ p_stock_type: "physical" });
  await dash({ p_warehouse_id: ig.id });
  await dash({ p_warehouse_id: a.id });
  for (const bad of [{ p_search_by: "x" }, { p_stock_type: "x" }, { p_query: "x".repeat(121) }, { p_page: 0 }]) assert.match(await code(dash(bad)), /^22023:/);
  assert.match(await code(dash({ p_warehouse_id: randomUUID() })), /^P0002:erp_stock_warehouse_not_found/);
  assert.match(await code(dash({ p_supplier_id: randomUUID() })), /^P0002:erp_stock_supplier_not_found/);
  for (const role of ["estoque", "consulta", "vendas", "fiscal"]) await code(dash({}, u[role]));
});

test("notas do check-in: busca por chave e número, papéis", async () => {
  const invoice = (number, key, status = 1, direction = "0") =>
    seed(
      `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,access_key,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by)
       values(gen_random_uuid(),'55',$1,'N','2',$2,1,$3,$4,'Compra','2024-09-01','1','1','0',false,$5::jsonb,'[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',1,$6,$6)`,
      [direction, status, number, key, JSON.stringify({ name: "Fornecedor N", document: "11222333000181", person_type: "J" }), u.admin],
    ).then(() => true, (e) => (console.log("nota", e.message), false));
  await invoice(123, "1".repeat(44));
  await invoice(456, null);
  await invoice(789, null, 3);
  const notes = (args = {}, user = u.estoque) => f.rpc("erp_stock_checkin_notes", { p_user_id: user, p_offset: 0, p_limit: 10, p_query: null, ...args });
  await notes();
  for (const q of ["123", "  000456 ", "1".repeat(44), "11111111111111111111111111111111111111111111"]) await notes({ p_query: q });
  for (const q of ["abc", "1234567890", "x".repeat(61)]) assert.match(await code(notes({ p_query: q })), /^22023:/);
  for (const role of ["fiscal", "consulta", "admin"]) await code(notes({}, u[role]));
});
