// Diferencial de acesso, pendências e comissão (sessão L, B0,
// documents/rpc/reads-commerce.ts) nos dois motores. Casos que forçam o
// oráculo: contatos com cada campo faltando, CPF inválido, estrangeiro, UF
// em minúscula e inválida, município fora do IBGE, frete do destinatário sem
// transportador, item sem produto e produto sem NCM e Origem; comissão
// rateada com arredondamento (base que não divide), item com total nulo e
// operação com itens zerados; faixas de comissão fora de ordem e com nulo;
// vendedor do usuário, depósito padrão e preferências da tela mudadas.
// Os dados são gravados direto no Postgres e espelhados.
//   node --test tests/erp/documents/reads-commerce-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, docs, sellers;
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
  const contacts = [];
  for (const i of [0, 1, 2, 3, 4]) contacts.push((await f.catalog("contacts", { name: `Contato ${i}`, roles: ["customer"] })).id);
  const product = async (name, extra) => (await f.catalog("products", { name, ...extra })).id;
  const good = await product("Bom", { ncm: "12345678" });
  const bare = await product("Sem NCM", {});
  const warehouse = (await f.catalog("warehouses", { name: "Depósito Padrão" })).id;
  docs = {};
  sellers = [];
  await replica(async () => {
    const contact = (id, v) =>
      sql(
        "update erp_catalog.contact set person_type=$2, document=$3, ie=$4, street=$5, number=$6, district=$7, city=$8, state=$9, postal_code=$10 where record_id=$1",
        [id, ...v],
      );
    await contact(contacts[0], ["F", "529.982.247-25", null, "Rua A", "10", "Centro", "São Paulo", "SP", "01001-000"]);
    await contact(contacts[1], ["F", "111.111.111-11", null, " ", null, "", "Cidade Inventada", "sp", "123"]);
    await contact(contacts[2], ["J", null, null, "Rua", "1", "B", "Rio de Janeiro", "XX", "20000000"]);
    await contact(contacts[3], ["E", null, null, "Street", "1", "D", "Paris", "EX", null]);
    await sql("update erp_catalog.product set origin=null where record_id=$1", [bare]);
    await sql(
      "update erp_catalog.contact_profile set taxpayer='1', ie_exempt=false where record_id=$1",
      [contacts[0]],
    );
    const doc = async (name, kind, contact, body, items) => {
      const id = randomUUID();
      docs[name] = id;
      await sql(
        "insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority) values($1,$2,$3,1,'open',$4,0,'{}',$5,$6,$6,now(),now(),'brufap','brufap')",
        [id, kind, Object.keys(docs).length, contact, JSON.stringify(body), admin],
      );
      for (const [pos, prod, total, data] of items)
        await sql("insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,total,data,product_snapshot) values($1,$2,$3,$4,1,0,$5,$6,$7)", [
          randomUUID(), id, pos, prod, total, JSON.stringify(data), prod ? JSON.stringify({ name: "Instantâneo" }) : null,
        ]);
      return id;
    };
    for (const [i, c] of contacts.entries())
      await doc(`p${i}`, "sales_orders", c, i === 1 ? { commercial: { transport: { freight_mode: 1 } } } : i === 2 ? { commercial: { transport: { freight_mode: "2", carrier_reference: null } }, carrier_id: null } : {}, [
        [3, good, "10.00", { description: "Bom", unit: "UN" }],
        [1, bare, "0.01", { description: "Sem NCM", unit: " " }],
        [2, null, "5.00", {}],
      ]);
    await doc("os", "service_orders", contacts[0], {}, [[1, good, "33.33", { description: "Um" }], [2, good, null, {}], [3, bare, "66.67", {}], [4, good, "0.01", {}]]);
    await doc("zero", "sales_orders", contacts[0], {}, [[1, good, "0.00", {}]]);
    const operation = (document, kind, items, base, estimated) =>
      sql(
        `insert into erp_finance.commission_operation(id,document_id,kind,seller_id,state,rule,policy,items_cents,discount_cents,freight_cents,ipi_cents,icms_st_cents,fee_cents,base_cents,rate,estimated_cents,total_cents,confirmed_status,confirmed_on,version,created_at)
         values($1,$2,$3,$4,'active','parcial','{"additions":[]}',$5,0,0,0,0,0,$6,5,$7,$5,'open','2026-11-16',1,now())`,
        [randomUUID(), document, kind, randomUUID(), items, base, estimated],
      );
    await operation(docs.os, "service_orders", 10001, 9999, 501);
    await operation(docs.zero, "sales_orders", 0, 0, 0);
    // Vendedores: um do usuário vendedor, com faixas fora de ordem e uma sem desconto.
    for (const [i, bands] of [[{ discount_up_to: "10", rate: "1.5" }, { discount_up_to: 2.5, rate: 3 }, { rate: "0.12345" }], []].entries()) {
      const id = randomUUID();
      sellers.push(id);
      await sql(
        `insert into erp_catalog.seller(id,contact_id,user_id,allow_unregistered_products,view_stock,access_hours_enabled,access_windows,modules,commission_rule,commission_mode,commission_rate,commission_bands,discount_limit,version,created_by,updated_by,created_at,updated_at)
         values($1,$2,$3,true,false,false,'[]','{}','parcial',$4,$5,$6,12.5,1,$7,$7,now(),now())`,
        [id, contacts[4 - i], i === 0 ? f.users.vendedor : null, i === 0 ? "descontos" : "fixa", i === 0 ? null : 7.25, JSON.stringify(bands), admin],
      );
    }
    await sql("update erp_stock.warehouse_default set warehouse_id=$1, version=version+1, updated_at=now(), updated_by=$2, command_id=$3", [warehouse, admin, randomUUID()]);
  });
  await f.sync();
});
after(async () => f?.close());

test("acesso: tipos lidos e gravados, preferências, vendedor e permissões", async () => {
  for (const user of users()) await outcome(f.rpc("erp_document_access", { p_user_id: user }));
  const control = (user, permissions) =>
    f.db.query(
      "insert into erp_access.user_control(user_id,permissions,version,updated_at,updated_by) values($1,$2,1,now(),$3) on conflict(user_id) do update set permissions=excluded.permissions",
      [user, permissions, f.users.admin],
    );
  await control(f.users.vendas, ["vendas", "vendas.pedidos_venda", "vendas.pedidos_venda.limite_desconto", "servicos", "servicos.ordem_servico", "servicos.ordem_servico.situacoes"]);
  await control(f.users.estoque, []);
  await f.sync();
  for (const user of users()) await outcome(f.rpc("erp_document_access", { p_user_id: user }));
  const r = await f.rpc("erp_document_access", { p_user_id: f.users.vendedor });
  assert.equal(r.seller?.discount_limit, "12.5000");
});

test("pendências: cada campo do cliente, frete, item sem produto e produto incompleto", async () => {
  for (const user of [f.users.admin, f.users.vendas, f.users.consulta, f.users.estoque, null])
    for (const kind of ["sales_orders", "service_orders", "x", null])
      for (const id of [...Object.values(docs), randomUUID(), null]) await outcome(f.rpc("erp_document_pendencies", { p_user_id: user, p_kind: kind, p_id: id }));
  const r = await f.rpc("erp_document_pendencies", { p_user_id: f.users.admin, p_kind: "sales_orders", p_id: docs.p1 });
  assert.ok(r.pendencies.length >= 8);
});

test("comissão: operação rateada pelos itens e a regra do vendedor", async () => {
  for (const user of [f.users.admin, f.users.vendas, f.users.financeiro, f.users.consulta, null])
    for (const kind of ["sales_orders", "service_orders", "purchase_orders", null])
      for (const id of [docs.os, docs.zero, docs.p0, randomUUID(), null]) await outcome(f.rpc("erp_document_commission_operation", { p_user_id: user, p_kind: kind, p_document_id: id }));
  const r = await f.rpc("erp_document_commission_operation", { p_user_id: f.users.admin, p_kind: "service_orders", p_document_id: docs.os });
  assert.equal(r.items.length, 4);
  for (const user of [f.users.admin, f.users.vendas, f.users.consulta, null])
    for (const kind of ["sales_orders", "service_orders", "x"])
      for (const s of [...sellers, randomUUID(), null]) await outcome(f.rpc("erp_document_seller_commission", { p_user_id: user, p_kind: kind, p_seller_id: s }));
  const s = await f.rpc("erp_document_seller_commission", { p_user_id: f.users.admin, p_kind: "sales_orders", p_seller_id: sellers[0] });
  assert.deepEqual(s.bands.map((b) => b.discount_up_to), ["2.5000", "10.0000", null]);
});
