// Diferencial da sacola, da origem da cópia e do checkout (sessão L, B0,
// documents/rpc/reads-sales.ts) nos dois motores. Casos que forçam o
// oráculo: recibo repetido e com outro pedido, soma acima do teto, produto
// inativo, sacola cheia; checkout desmembrado (componentes com quantidade do
// item vezes a do componente), leituras salvas acima da quantidade da linha
// e de linha que saiu, GTIN "SEM GTIN" e com espaços, número de pedido excluído,
// em rascunho e inexistente.
// Os documentos são gravados direto no Postgres e espelhados.
//   node --test tests/erp/documents/reads-sales-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, products, customer, docs;
const sql = async (text, args = []) => (await f.db.query(text, args)).rows;
const replica = async (fn) => {
  await f.db.exec("set session_replication_role = replica");
  try {
    await fn();
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
};
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (/divergem/.test(e.message)) throw e;
    return { error: e.code };
  }
};
const users = () => [...Object.values(f.users), randomUUID(), null];

before(async () => {
  f = await dualFixture();
  const { admin } = f.users;
  customer = await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer"] });
  products = [];
  for (const [i, code] of ["KIT", "C1", "C2", "P", "Inativo"].entries())
    products.push((await f.catalog("products", { name: `Produto ${code}`, code, ...(i === 3 ? { gtin: "7891234567895" } : {}) })).id);
  docs = {};
  await replica(async () => {
    await sql("update erp_catalog.record set active=false where id=$1", [products[4]]);
    await sql("update erp_catalog.product set gtin=$2 where record_id=$1", [products[3], " sem gtin "]);
    await sql("update erp_catalog.product set location=' A-1 ', gtin=' 7891234567895 ', gtin_tax='SEM GTIN' where record_id=$1", [products[1]]);
    await sql("insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_at,updated_by,command_id) values($1,'physical','product',1,now(),$2,$3)", [
      products[0], admin, randomUUID(),
    ]);
    for (const [pos, comp, q] of [[2, products[2], "0.333333"], [1, products[1], "2.5"]])
      await sql("insert into erp_stock.composition_item(product_id,version,position,component_id,quantity) values($1,1,$2,$3,$4)", [products[0], pos, comp, q]);
    const doc = async (name, number, extra = {}) => {
      const id = randomUUID();
      docs[name] = id;
      await sql(
        "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority,deleted_at,deleted_by,delete_reason) values($1,'sales_orders',$2,3,$3,$4,0,$5,$6,$7,$7,now(),now(),'brufap','brufap',$8,$9,$10)",
        [id, number, extra.status ?? "open", customer.id, JSON.stringify({ name: "Cliente " + "Á".repeat(205) }), JSON.stringify({ date: "2026-11-16" }), admin,
          extra.deleted ? new Date() : null, extra.deleted ? admin : null, extra.deleted ? "excluído no teste" : null],
      );
      for (const [pos, prod, q, data] of [[2, products[0], "3.333333", { description: "Kit", code: "KIT", unit: "UN" }], [1, products[3], "2", { description: "P", code: 7 }], [3, null, "1", { description: "Livre" }]])
        await sql("insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,total,data) values($1,$2,$3,$4,$5,0,0,$6)", [
          randomUUID(), id, pos, prod, q, JSON.stringify(data),
        ]);
      return id;
    };
    await doc("open", 10);
    await doc("split", 11, { status: "checkout_partial" });
    await doc("dupA", 12);
    await doc("other", 15); // número repetido (ambíguo) só com documento do Origin: o índice único document_native_kind_number impede no nativo
    await doc("deleted", 13, { deleted: true });
    await doc("closed", 14, { status: "draft" });
    const items = async (d) => (await sql("select id, product_id from erp_documents.item where document_id=$1", [d]));
    const kit = (await items(docs.split)).find((i) => i.product_id === products[0]).id;
    const plain = (await items(docs.open)).find((i) => i.product_id === products[3]).id;
    await sql("insert into erp_documents.checkout(document_id,reads,split,version,updated_by,updated_at) values($1,$2,true,2,$3,now()),($4,$5,false,1,$3,now())", [
      docs.split,
      JSON.stringify([{ key: `${kit}:${products[1]}`, quantity: "100" }, { key: `${kit}:${products[2]}`, quantity: "0.5" }, { key: "sumiu", quantity: "1" }]),
      admin,
      docs.open,
      JSON.stringify([{ key: plain, quantity: "1.0000005" }]),
    ]);
    await sql("insert into erp_documents.copy_source(destination_id,source_id,source_kind,source_number,source_version,actor,command_id,created_at) values($1,$2,'sales_proposals',77,4,$3,$4,now())", [
      docs.open, randomUUID(), admin, randomUUID(),
    ]);
  });
  await f.sync();
});
after(async () => f?.close());

test("sacola: incluir, somar, alterar, tirar, esvaziar, recibo e recusas", async () => {
  const { vendas, admin } = f.users;
  const change = (user, action, product, quantity, command = randomUUID()) =>
    outcome(f.rpc("erp_document_sales_bag_change", { p_user_id: user, p_command_id: command, p_action: action, p_product_id: product, p_quantity: quantity }));
  const cmd = randomUUID();
  await change(vendas, "add", products[3], "1.5", cmd);
  await change(vendas, "add", products[3], "1.5", cmd); // repetição
  await change(vendas, "add", products[3], "2", cmd); // outro pedido no mesmo comando
  await change(admin, "add", products[3], "1.5", cmd); // outro ator
  await change(vendas, "add", products[3], "999999999.999999");
  await change(vendas, "add", products[0], "0.000001");
  await change(vendas, "set", products[0], "999999999.999999");
  await change(vendas, "add", products[1], "3");
  for (const [action, product, quantity] of [
    ["add", products[4], "1"], ["add", randomUUID(), "1"], ["add", products[1], "0"], ["add", products[1], "1.1234567"], ["add", products[1], "-1"],
    ["add", products[1], null], ["set", null, "1"], ["remove", products[1], "1"], ["clear", products[1], null], ["x", products[1], "1"], [null, null, null],
  ])
    await change(vendas, action, product, quantity);
  for (const user of users()) await outcome(f.rpc("erp_document_sales_bag", { p_user_id: user }));
  await change(vendas, "remove", products[1], null);
  await change(vendas, "remove", products[1], null);
  await change(vendas, "clear", null, null);
  for (const user of [f.users.consulta, f.users.estoque, f.users.inactive, null]) await change(user, "add", products[1], "1");
  assert.equal((await f.rpc("erp_document_sales_bag", { p_user_id: vendas })).count, 0);
});

test("origem da cópia e checkout: leitura, desmembramento, leituras limitadas e busca pelo número", async () => {
  for (const user of users()) {
    for (const kind of ["sales_orders", "sales_proposals", null])
      for (const id of [docs.open, docs.split, randomUUID(), null]) await outcome(f.rpc("erp_document_copy_origin", { p_user_id: user, p_kind: kind, p_document_id: id }));
    for (const id of [...Object.values(docs), randomUUID(), null]) await outcome(f.rpc("erp_document_checkout_get", { p_user_id: user, p_id: id }));
  }
  for (const number of ["10", "11", "12", "13", "14", "99", "0", "01", "12345678901", "1a", null]) await outcome(f.rpc("erp_document_checkout_lookup", { p_user_id: f.users.admin, p_number: number }));
  for (const user of users()) await outcome(f.rpc("erp_document_checkout_lookup", { p_user_id: user, p_number: "10" }));
  const split = await f.rpc("erp_document_checkout_get", { p_user_id: f.users.admin, p_id: docs.split });
  assert.equal(split.split, true);
  assert.equal(split.reads.length, 2, "a leitura de linha que saiu some");
  assert.equal((await f.rpc("erp_document_copy_origin", { p_user_id: f.users.admin, p_kind: "sales_orders", p_document_id: docs.open })).copy_source.number, "77");
});
