// Guarda do "Origin fora" (ERP-PORTE.md, "Regras que valem para todos"):
// uma semeadura mínima do Origin no oráculo — um contato e um produto
// espelhados (erp_catalog.origin, origin_sync.raw_record) e um pedido de
// venda espelhado (origin/authority 'origin', erp_sync.link) — rodada contra
// as leituras e escritas principais de cada domínio nos dois motores. Uma
// leitura que virou constante, ou uma guarda do espelho "sem efeito", diverge
// aqui na rodada do tronco, não por acaso. Um caso por chamada; o que ainda
// diverge fica todo, com o dono e o motivo, e quem porta tira o todo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./dual-fixture.mjs";

let f, u, contact, product, warehouse, mirrored;
const HASH = "a".repeat(64);

/** SQL no oráculo sem os gatilhos (como a semeadura do harness), espelhado no SQLite. */
async function seed(sql, args = []) {
  await f.db.exec("set session_replication_role = replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
}
/** O mesmo resultado, ou o mesmo erro, nos dois motores (o f.rpc falha se divergem). */
async function same(name, args) {
  try {
    return await f.rpc(name, args);
  } catch (e) {
    if (e?.code === "ERR_ASSERTION") throw e;
    return { error: `${e.code}:${e.message}` };
  }
}

before(async () => {
  f = await dualFixture();
  u = f.users;
  contact = await f.catalog("contacts", { name: "Contato espelhado", person_type: "J", roles: ["customer", "supplier"] });
  product = await f.catalog("products", { name: "Produto espelhado", unit: "UN", kind: "P", format: "S", price: "10" });
  warehouse = await f.catalog("warehouses", { name: "Depósito do espelho" });
  for (const [entity, source, record, resource] of [["contacts", "101", contact.id, "contatos"], ["products", "202", product.id, "produtos"]]) {
    await seed(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,$2,$3,$4::jsonb,$5)`, [
      entity, resource, source, JSON.stringify({ id: Number(source), nome: entity === "contacts" ? "Contato espelhado" : "Produto espelhado", codigo: "ESP-" + source }), HASH,
    ]);
    await seed(`insert into erp_catalog.origin(entity,source_id,record_id,latest_hash,state) values($1,$2,$3,$4,'synced')`, [entity, source, record, HASH]);
  }
  mirrored = randomUUID();
  await seed(
    `insert into erp_documents.document(id,kind,number,version,status,contact_id,contact_snapshot,body,total,created_by,updated_by,origin,authority,warehouse_id)
     values($1,'sales_orders',9001,1,'verified',$2,'{"name":"Contato espelhado"}',$3::jsonb,20,$4,$4,'origin','origin',$5)`,
    [mirrored, contact.id, JSON.stringify({ date: "2026-10-15", contact_id: contact.id, warehouse_id: warehouse.id }), u.admin, warehouse.id],
  );
  await seed(`insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,data) values($1,$2,1,$3,2,10,'{"unit":"UN","description":"Item espelhado"}')`, [
    randomUUID(), mirrored, product.id,
  ]);
  await seed(`insert into erp_sync.link(entity,record_id,origin_id) values('sales_orders',$1,'9001')`, [mirrored]);
  await seed(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('sales_orders','pedidos/vendas','9001','{"id":9001,"numero":"9001"}'::jsonb,$1)`, [HASH]);
});
after(() => f?.close());

const meta = { p_occurred_on: "2026-10-15", p_reason: "Lançamento sobre o espelho" };
const MIRROR_VISIBLE = "pendente da O: erp_document_mirror.require_visible (documents/reads-g.ts) ainda é no-op; o oráculo recusa erp_document_mirror_readonly antes do Estoque";

test("Estoque (N): lançamento de pedido espelhado", { todo: MIRROR_VISIBLE }, async () => {
  await same("erp_document_stock_preview", { p_user_id: u.estoque, p_kind: "sales_orders", p_document_id: mirrored, p_expected_version: 1, ...meta });
});
test("Estoque (N): reserva de pedido espelhado (conferência)", { todo: MIRROR_VISIBLE }, async () => {
  await same("erp_stock_reservation_preview", { p_user_id: u.estoque, p_document_id: mirrored, p_expected_version: 1, p_action: "reserve", ...meta, p_reservation_id: null, p_reservation_version: null });
});
test("Estoque (N): leitura da reserva de pedido espelhado", async () => {
  await same("erp_stock_reservation_get", { p_user_id: u.estoque, p_document_id: mirrored, p_limit: 25, p_after: null });
});
test("Estoque (N): lotes das linhas do pedido espelhado", async () => {
  await same("erp_stock_source_lots", { p_user_id: u.estoque, p_source: "document", p_source_id: mirrored, p_product_id: product.id });
});

test("Documentos (O): leitura do pedido espelhado", { todo: "pendente da O: erp_document_mirror.detail sai 0A000 no motor; o oráculo devolve o pedido" }, async () => {
  await same("erp_document_get", { p_user_id: u.admin, p_kind: "sales_orders", p_id: mirrored });
});
test("Documentos (O): lista com o pedido espelhado", { todo: "pendente da O: erp_document_mirror.list_row sai 0A000 no motor; o oráculo lista (origin_totals com o espelho)" }, async () => {
  await same("erp_document_list", { p_user_id: u.admin, p_kind: "sales_orders", p_limit: 25, p_origin: "all" });
});

test("Catálogo (P): leitura do contato espelhado", async () => {
  await same("erp_catalog_contact_get", { p_user_id: u.admin, p_id: contact.id });
});
test("Catálogo (P): leitura do produto espelhado", async () => {
  await same("erp_catalog_product_get", { p_user_id: u.admin, p_id: product.id });
});
// Preferências, Fiscal e CNAB (G). O título importado do Origin
// (erp_finance.origin_import_origin) no CNAB já é semeado no oráculo e
// comparado em tests/erp/cnab/returns.test.mjs ("título importado do Origin
// pede vínculo próprio"): a montagem do perfil e da remessa não cabe aqui.
test("Preferências (G): registros do Origin (origin_sync.raw_record) do contato espelhado", async () => {
  await same("erp_read_records", { p_user_id: u.admin, p_entity: "contacts", p_limit: 25, p_offset: 0 });
});
test("Preferências (G): pedidos de venda no início, com o espelhado", async () => {
  await same("erp_home_summary", { p_user_id: u.admin });
});
test("Preferências (G): relatório de pedidos com o espelhado", async () => {
  await same("erp_preferences_report_run", { p_user_id: u.admin, p_base: "vendas", p_columns: ["numero", "total"], p_filters: [], p_view_limit: 2000, p_offset: 0, p_page: 20 });
});
test("Preferências (G): etiquetas de pedido com o espelhado (erp_document_mirror.visible)", async () => {
  await same("erp_preferences_label_records", { p_user_id: u.admin, p_type: "pedidos", p_query: null });
});
test("Fiscal (G): erp_fiscal_mirror.visible da NF-e espelhada (raw_record) igual ao oráculo", async () => {
  await seed(
    `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','nfe','7001','{"id":7001,"contato":{"id":101}}'::jsonb,$1)`,
    [HASH],
  );
  const { visible } = await import("../../../src/erp/domains/fiscal/public.ts");
  for (const user of Object.values(u))
    for (const [entity, source] of [["nfe", "7001"], ["nfe", "7002"], ["nfce", "7001"]])
      assert.equal(
        visible(f.driver, user, entity, source),
        (await f.db.query("select erp_fiscal_mirror.visible($1,$2,$3) v", [user, entity, source])).rows[0].v,
        `${user} ${entity} ${source}`,
      );
});
test("Fiscal (G): contato espelhado no formulário da nota", async () => {
  await same("erp_fiscal_invoice_contact_source", { p_user_id: u.admin, p_contact_id: contact.id, p_direction: "1" });
});

test(
  "Catálogo (P): mudança local no produto espelhado marca a origem",
  { todo: "pendente da P: o erp_catalog_product_save não grava erp_catalog.origin.state='local_modified' (o oráculo grava; o motor fica 'synced')" },
  async () => {
    const version = (await f.db.query("select version v from erp_catalog.record where id=$1", [product.id])).rows[0].v;
    await same("erp_catalog_product_save", { p_user_id: u.admin, p_id: product.id, p_expected_version: version, p_command_id: randomUUID(), p_data: { name: "Produto espelhado (mudado)" }, p_acknowledged: null });
    assert.equal((await f.db.query("select state v from erp_catalog.origin where record_id=$1", [product.id])).rows[0].v, "local_modified");
  },
);
