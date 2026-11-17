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
test(
  "Catálogo (P): mudança local no produto espelhado marca a origem",
  { todo: "pendente da P: o erp_catalog_product_save não grava erp_catalog.origin.state='local_modified' (o oráculo grava; o motor fica 'synced')" },
  async () => {
    const version = (await f.db.query("select version v from erp_catalog.record where id=$1", [product.id])).rows[0].v;
    await same("erp_catalog_product_save", { p_user_id: u.admin, p_id: product.id, p_expected_version: version, p_command_id: randomUUID(), p_data: { name: "Produto espelhado (mudado)" }, p_acknowledged: null });
    assert.equal((await f.db.query("select state v from erp_catalog.origin where record_id=$1", [product.id])).rows[0].v, "local_modified");
  },
);

// ---------------------------------------------------------------------------
// Leituras do Documentos e PDV (L). Um segundo pedido espelhado, este com a
// linha de erp_documents.origin_mirror (número, situação e total da fonte),
// para o report_coverage, a busca pela fonte e o total da lista.

let sourced;
/** Semeado na primeira chamada (depois do before de cima, que cria o contato e o produto). */
async function seedSourced() {
  if (sourced) return;
  sourced = randomUUID();
  await seed(
    `insert into erp_documents.document(id,kind,number,version,status,contact_id,contact_snapshot,body,total,created_by,updated_by,origin,authority)
     values($1,'sales_orders',9002,1,'verified',$2,'{"name":"Contato espelhado"}',$3::jsonb,null,$4,$4,'origin','origin')`,
    [sourced, contact.id, JSON.stringify({ date: "2026-10-16", contact_id: contact.id }), u.admin],
  );
  await seed(
    `insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,data) values($1,$2,1,$3,null,null,'{"unit":"UN","description":"Item da fonte","quantity":"1.5","unit_price":"14.333"}')`,
    [randomUUID(), sourced, product.id],
  );
  await seed(
    `insert into erp_documents.origin_mirror(entity,source_id,document_id,applied_version,applied_hash,state,source_number,source_status,source_status_label,observed_at,source_deleted,issues,reconciliation,effects,plan_hash)
     values('sales_orders','9002',$1,1,$2,'synced','PV-9002','6','Em andamento',now(),false,'[]','{"source_total":"21.5"}','{}',$2)`,
    [sourced, HASH],
  );
}

const L_GUARD = "pendente da O: mirrorRequireVisible (reads-g.ts) só vale com o documents/mirror.ts dela (sobe com o B5); até lá o motor não recusa o espelho";
const L_ROW = "pendente da L: list_row e metadata do espelho esperam o mirrorMetadata do documents/mirror.ts da O (sobe com o B5)";

test("Documentos (L): histórico do contato com as linhas espelhadas (origin, quantidade e preço observados)", async () => {
  await seedSourced();
  const history = await same("erp_document_history", { p_user_id: u.admin, p_kind: "sales_orders", p_contact_id: contact.id, p_product_id: null, p_query: null, p_limit: 50 });
  const line = history.items.find((i) => i.document_id === sourced);
  assert.deepEqual([line?.origin, line?.quantity, line?.unit_price], ["origin", "1.5", "14.333"], JSON.stringify(history.items));
  await same("erp_document_history", { p_user_id: u.admin, p_kind: "sales_orders", p_contact_id: contact.id, p_product_id: null, p_query: "fonte", p_limit: 50 });
});
test("Documentos (L): relatórios com o espelho fora da cobertura (report_coverage)", async () => {
  await seedSourced();
  for (const user of [u.admin, u.vendas, u.consulta]) {
    await same("erp_document_sales_abc", { p_user_id: user, p_from: "2026-10-01", p_to: "2026-10-31" });
    await same("erp_document_sales_romaneio", { p_user_id: user, p_filters: { from: "2026-10-01", to: "2026-10-31" } });
    await same("erp_document_service_occurrence_report", { p_user_id: user, p_from: "2026-10-01", p_to: "2026-10-31", p_status: null });
  }
  // Só o pedido com linha em origin_mirror (9002, 16/10) conta como deixado de fora.
  const abc = await same("erp_document_sales_abc", { p_user_id: u.admin, p_from: "2026-10-16", p_to: "2026-10-31" });
  assert.deepEqual([abc.mirror_excluded_count, abc.coverage.partial], [1, true]);
  await same("erp_document_sales_abc", { p_user_id: u.admin, p_from: "2026-11-01", p_to: "2026-11-30" });
});
test("Documentos (L): checkout pelo número do espelho (só o nativo é achado)", async () => {
  await seedSourced();
  for (const number of ["9001", "9002"]) await same("erp_document_checkout_lookup", { p_user_id: u.admin, p_number: number });
});
test("Documentos (L): leituras de um documento espelhado passam pela guarda do espelho", { todo: L_GUARD }, async () => {
  await seedSourced();
  for (const id of [mirrored, sourced]) {
    for (const name of ["erp_document_copy_origin", "erp_document_structures", "erp_document_supplier_descriptions", "erp_document_commission_operation", "erp_document_occurrence_list", "erp_document_freight_paid_get"])
      await same(name, { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: id });
    await same("erp_document_pendencies", { p_user_id: u.admin, p_kind: "sales_orders", p_id: id });
    await same("erp_document_checkout_get", { p_user_id: u.admin, p_id: id });
    await same("erp_document_conversion_preview", { p_user_id: u.admin, p_kind: "sales_orders", p_proposal_id: id });
  }
});
test("Documentos (L): lista com busca e total da fonte, e exportação com o espelho", { todo: L_ROW }, async () => {
  await seedSourced();
  for (const q of [null, "pv-9002", "em andamento", "9002", "6"])
    await same("erp_document_list", { p_user_id: u.admin, p_kind: "sales_orders", p_limit: 25, p_origin: "all", p_query: q });
  await same("erp_document_export", { p_user_id: u.admin, p_kind: "sales_orders", p_date_from: "2026-10-01", p_date_to: "2026-10-31", p_page: 1 });
});
test("PDV (L): o pedido espelhado não é venda da frente de caixa", async () => {
  await seedSourced();
  for (const id of [mirrored, sourced]) await same("erp_pos_order", { p_user_id: u.admin, p_document_id: id });
  for (const q of ["9001", "9002", "contato"]) await same("erp_pos_sales", { p_user_id: u.admin, p_query: q });
});
