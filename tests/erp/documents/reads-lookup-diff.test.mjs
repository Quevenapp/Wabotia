// Diferencial das consultas do Documentos (sessão L, B0,
// documents/rpc/reads-lookup.ts): lot_options, product_search,
// supplier_descriptions, structures e xml_match nos dois motores, com todos os
// papéis e argumentos estragados. Dados que forçam o oráculo: lotes com
// validade nula e código com maiúscula e acento, saldo por depósito, produto
// agrupador de variações (format 'V') fora da busca, quantidade do item vezes
// a do componente com arredondamento em 6 casas, descrição do fornecedor com
// caractere de controle, GTIN e código com maiúsculas, contato pelo CPF.
// Os dados são gravados direto no Postgres e espelhados.
//   node --test tests/erp/documents/reads-lookup-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, products, warehouses, supplier, customer, docs;
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
const KINDS = ["sales_proposals", "sales_orders", "purchase_orders", "service_orders", "x", null];
const users = () => [...Object.values(f.users), randomUUID(), null];

before(async () => {
  f = await dualFixture();
  const { admin } = f.users;
  supplier = await f.catalog("contacts", { name: "Fornecedor Sintético", roles: ["supplier"] });
  customer = await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer"] });
  warehouses = [(await f.catalog("warehouses", { name: "Depósito A" })).id, (await f.catalog("warehouses", { name: "Depósito B" })).id];
  products = [];
  for (const [i, code] of ["ABC-1", "abc-2", "Ção", "x9", "KIT", "Comp"].entries())
    products.push((await f.catalog("products", { name: `Produto ${code} ${i}`, code, ...(i === 0 ? { gtin: "7891234567895" } : {}) })).id);
  docs = {};
  await replica(async () => {
    const lot = async (product, code, expires, active, qty) => {
      const id = randomUUID();
      await sql(
        "insert into erp_stock.lot(id,product_id,code,manufactured_on,expires_on,active,version,created_at,created_by,updated_at,updated_by,command_id) values($1,$2,$3,null,$4,$5,1,now(),$6,now(),$6,$7)",
        [id, product, code, expires, active, admin, randomUUID()],
      );
      for (const [w, q] of qty.entries())
        if (q !== null)
          await sql("insert into erp_stock.lot_balance(lot_id,warehouse_id,quantity,version,updated_at) values($1,$2,$3,1,now())", [id, warehouses[w], q]);
    };
    await lot(products[0], "L-b", "2027-01-01", true, ["1.5", "2.000001"]);
    await lot(products[0], "l-a", "2027-01-01", true, ["0", null]);
    await lot(products[0], "Ção", null, true, [null, "3"]);
    await lot(products[0], "Z", "2026-01-01", false, ["9", null]);
    await sql("update erp_catalog.product_detail set lot_control=true where record_id=$1", [products[0]]);
    await sql("update erp_catalog.product set format='V' where record_id=$1", [products[3]]);
    // Composição do kit: dois componentes, quantidades com 6 casas.
    await sql("insert into erp_stock.composition(product_id,stock_type,post_mode,version,updated_at,updated_by,command_id) values($1,'physical','product',2,now(),$2,$3)", [
      products[4], admin, randomUUID(),
    ]);
    for (const [pos, comp, q, version] of [[1, products[5], "0.333333", 2], [2, products[1], "1.5", 2], [1, products[2], "7", 1]])
      await sql("insert into erp_stock.composition_item(product_id,version,position,component_id,quantity) values($1,$2,$3,$4,$5)", [products[4], version, pos, comp, q]);
    // Descrições no fornecedor (padrão, posição, com controle e em branco).
    for (const [prod, pos, sup, desc, def] of [
      [products[0], 1, customer.id, "Descrição do cliente", true],
      [products[0], 2, supplier.id, "Do\u0007 fornecedor\n", false],
      [products[1], 1, supplier.id, "  ", true],
      [products[2], 1, customer.id, " " + "ç".repeat(119), false],
    ])
      await sql("insert into erp_catalog.product_supplier(record_id,position,supplier_id,description,is_default) values($1,$2,$3,$4,$5)", [prod, pos, sup, desc, def]);
    // Documentos com itens.
    for (const kind of ["sales_orders", "purchase_orders", "service_orders"]) {
      const id = randomUUID();
      docs[kind] = id;
      await sql(
        "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority) values($1,$2,$3,1,'open',$4,0,'{}','{}',$5,$5,now(),now(),'brufap','brufap')",
        [id, kind, 1, kind === "purchase_orders" ? supplier.id : customer.id, admin],
      );
      for (const [pos, prod, q] of [[2, products[4], "3.333333"], [1, products[0], "2"], [3, null, "1"], [4, products[2], "0.5"]])
        await sql("insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,total,data) values($1,$2,$3,$4,$5,0,0,'{}')", [
          randomUUID(), id, pos, prod, q,
        ]);
    }
    // Contato achado pelo documento (só dígitos).
    await sql("update erp_catalog.contact set document='123.456.789-09', person_type='F' where record_id=$1", [customer.id]);
  });
  await f.sync();
});
after(async () => f?.close());

test("lot_options: lotes por validade, código e id, com saldo por depósito", async () => {
  const call = (user, kind, product, wh) => outcome(f.rpc("erp_document_lot_options", { p_user_id: user, p_kind: kind, p_product_id: product, p_warehouse_id: wh }));
  for (const user of users()) for (const kind of KINDS) await call(user, kind, products[0], null);
  for (const product of [products[0], products[1], randomUUID(), null]) for (const wh of [null, warehouses[0], warehouses[1], randomUUID()]) await call(f.users.admin, "service_orders", product, wh);
  const r = await f.rpc("erp_document_lot_options", { p_user_id: f.users.admin, p_kind: "sales_orders", p_product_id: products[0], p_warehouse_id: null });
  assert.equal(r.items.length, 4);
});

test("product_search: termos, limite, agrupador de variações fora e cursor", async () => {
  const call = (user, kind, query, limit) => outcome(f.rpc("erp_document_product_search", { p_user_id: user, p_kind: kind, p_query: query, p_limit: limit }));
  for (const user of users()) for (const kind of KINDS) await call(user, kind, "produto", 3);
  for (const query of ["abc", "  ab ", "ção", "789123", "a", "x".repeat(121), "a\u0001b", null, "produto", "kit comp"])
    for (const limit of [1, 2, 25, 0, 26, null]) await call(f.users.admin, "sales_orders", query, limit);
  const r = await f.rpc("erp_document_product_search", { p_user_id: f.users.admin, p_kind: "sales_orders", p_query: "produto", p_limit: 2 });
  assert.equal(r.has_more, true);
});

test("supplier_descriptions e structures: itens na ordem, fornecedor do pedido de compra primeiro, total do componente", async () => {
  for (const [user, ids] of [...users().map((u) => [u, [docs.sales_orders]]), [f.users.admin, [...Object.values(docs), randomUUID(), null]]])
    for (const kind of KINDS)
      for (const id of ids) {
        await outcome(f.rpc("erp_document_supplier_descriptions", { p_user_id: user, p_kind: kind, p_document_id: id }));
        await outcome(f.rpc("erp_document_structures", { p_user_id: user, p_kind: kind, p_document_id: id }));
      }
  const s = await f.rpc("erp_document_structures", { p_user_id: f.users.admin, p_kind: "sales_orders", p_document_id: docs.sales_orders });
  assert.ok(s.items.some((i) => i.components.length === 2));
});

test("xml_match: contato pelo documento, produto pelo GTIN antes do código, itens estragados", async () => {
  const good = [{ code: "abc-1", gtin: null }, { code: null, gtin: "7891234567895" }, { code: "ABC-2", gtin: "7891234567895" }, { code: "nada", gtin: null }];
  const bad = [[], {}, [{ code: "a" }], [{ code: "a", gtin: null, x: 1 }], [{ code: "", gtin: null }], [{ code: 1, gtin: null }], [{ code: null, gtin: "123" }], [1], null];
  const call = (user, kind, document, items) => outcome(f.rpc("erp_document_xml_match", { p_user_id: user, p_kind: kind, p_document: document, p_items: items }));
  for (const user of users()) for (const kind of KINDS) await call(user, kind, "12345678909", good);
  for (const document of ["12345678909", "123", null, "00000000000000"]) for (const items of [good, ...bad]) await call(f.users.admin, null, document, items);
  for (const items of bad) await call(f.users.admin, "purchase_orders", null, items);
  const r = await f.rpc("erp_document_xml_match", { p_user_id: f.users.admin, p_kind: "sales_orders", p_document: "12345678909", p_items: good });
  assert.equal(r.contact?.id, customer.id);
  // Terceiro item (código ABC-2 e o GTIN do ABC-1): o Fagoo ordena por (gtin bate) DESC, e o produto sem GTIN
  // dá NULL, que vem primeiro no DESC; ganha o ABC-2 pelo código. Comportamento do oráculo, mantido.
  assert.deepEqual(r.products.map((p) => p?.by ?? null), ["code", "gtin", "code", null]);
});
