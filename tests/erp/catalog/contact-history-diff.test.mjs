// erp_catalog_contact_sales e erp_catalog_contact_history nos dois motores:
// os 10 últimos pedidos nativos (data desc com nula primeiro, número desc),
// visible=false sem acesso ao tipo, carteira do vendedor, recusas e a
// cobertura do espelho (mirrorReportCoverage) com um pedido espelhado.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { contactsFixture } from "../fagoo/helpers/catalog-contacts-fixture.mjs";

let f;
before(async () => {
  f = await contactsFixture();
});
after(async () => f?.close());

async function same(name, args) {
  try {
    return await f.rpc(name, args);
  } catch (e) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return { error: `${e.code}:${e.message}` };
  }
}
async function seed(sql, args = []) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}

test("vendas e histórico do contato", async () => {
  const product = await f.catalog("products", { name: "Produto do histórico", unit: "UN", kind: "P", format: "S", price: "1" });
  const buyer = (await f.save({ name: "Comprador frequente", types: ["customer", "supplier"] })).record;
  const other = (await f.save({ name: "Sem pedidos", types: ["customer"] })).record;
  const dates = ["2026-10-10", "2026-10-31", "2026-10-31", "2026-11-01", "2026-09-05", "2026-10-10", "2026-12-24", "2026-01-02", "2026-10-31", "2026-08-08", "2026-07-07", "2026-11-30", "2026-06-01"];
  const orders = [];
  for (const [i, date] of dates.entries())
    orders.push(
      (
        await f.rpc("erp_document_save", {
          p_user_id: f.users.admin, p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
          p_body: { date, contact_id: buyer.id, items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: String(i + 1), unit_price: "10.25" }] },
        })
      ).document,
    );
  const purchase = await same("erp_document_save", {
    p_user_id: f.users.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(),
    p_body: { date: "2026-10-01", contact_id: buyer.id, items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "2", unit_price: "3" }] },
  });
  // Pedido sem data (vem primeiro no desc) e um pedido espelhado do Origin (só na cobertura).
  await seed("update erp_documents.document set body=body-'date' where id=$1", [orders[4].id]);
  await seed(
    `insert into erp_documents.origin_mirror(entity,source_id,document_id,applied_version,applied_hash,mapper_version,state,observed_at,source_deleted,issues,reconciliation,effects,plan_hash)
     values('sales_orders','9001',$1,1,$2,1,'synced',now(),false,'[]','{}','{}',$2)`,
    [orders[7].id, "a".repeat(64)],
  );
  const results = [];
  for (const user of [f.users.admin, f.users.consulta, f.users.vendas, f.users.vendedor, f.users.financeiro]) {
    results.push(await same("erp_catalog_contact_sales", { p_user_id: user, p_contact_id: buyer.id }));
    for (const kind of ["sales_orders", "purchase_orders"])
      results.push(await same("erp_catalog_contact_history", { p_user_id: user, p_contact_id: buyer.id, p_kind: kind }));
  }
  const sales = results[0];
  assert.equal(sales.items.length, 10);
  assert.equal(sales.items[0].date, null);
  assert.equal(sales.mirror_excluded_count, 1);
  if (!purchase.error) assert.equal(results[2].items.length, 1);
  assert.ok(results.some((r) => r.visible === false), "algum usuário sem acesso ao tipo de documento");
  await same("erp_catalog_contact_sales", { p_user_id: f.users.admin, p_contact_id: other.id });
  await f.preference("contatos.acesso_vendedor", true);
  try {
    await same("erp_catalog_contact_sales", { p_user_id: f.users.vendedor, p_contact_id: buyer.id });
    await same("erp_catalog_contact_history", { p_user_id: f.users.vendedor, p_contact_id: buyer.id, p_kind: "sales_orders" });
  } finally {
    await f.preference("contatos.acesso_vendedor", false);
  }
  for (const [name, args, code] of [
    ["erp_catalog_contact_sales", { p_contact_id: randomUUID() }, /P0002/],
    ["erp_catalog_contact_sales", { p_contact_id: null }, /P0002/],
    ["erp_catalog_contact_sales", { p_contact_id: product.id }, /P0002/],
    ["erp_catalog_contact_history", { p_contact_id: buyer.id, p_kind: "service_orders" }, /22023/],
    ["erp_catalog_contact_history", { p_contact_id: buyer.id, p_kind: null }, /22023/],
    ["erp_catalog_contact_history", { p_contact_id: randomUUID(), p_kind: "sales_orders" }, /P0002/],
    ["erp_catalog_contact_sales", { p_user_id: f.users.inactive, p_contact_id: buyer.id }, /42501/],
  ])
    assert.match((await same(name, { p_user_id: f.users.admin, ...args })).error, code);
});
