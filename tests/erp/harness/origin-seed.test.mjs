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

test("Estoque (N): lançamento de pedido espelhado", async () => {
  await same("erp_document_stock_preview", { p_user_id: u.estoque, p_kind: "sales_orders", p_document_id: mirrored, p_expected_version: 1, ...meta });
});
test("Estoque (N): reserva de pedido espelhado (conferência)", async () => {
  await same("erp_stock_reservation_preview", { p_user_id: u.estoque, p_document_id: mirrored, p_expected_version: 1, p_action: "reserve", ...meta, p_reservation_id: null, p_reservation_version: null });
});
test("Estoque (N): leitura da reserva de pedido espelhado", async () => {
  await same("erp_stock_reservation_get", { p_user_id: u.estoque, p_document_id: mirrored, p_limit: 25, p_after: null });
});
test("Estoque (N): lotes das linhas do pedido espelhado", async () => {
  await same("erp_stock_source_lots", { p_user_id: u.estoque, p_source: "document", p_source_id: mirrored, p_product_id: product.id });
});

test("Documentos (O): leitura do pedido espelhado", async () => {
  await same("erp_document_get", { p_user_id: u.admin, p_kind: "sales_orders", p_id: mirrored });
});
test("Documentos (O): lista com o pedido espelhado", async () => {
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

// Escritas locais sobre registro espelhado: o updateRecord (catalog/record.ts)
// marca erp_catalog.origin 'local_modified' como o oráculo; o f.rpc compara a
// tabela tocada. Cada caso volta a origem a 'synced' antes.
const version = async (id) => (await f.db.query("select version v from erp_catalog.record where id=$1", [id])).rows[0].v;
const synced = (id) => seed("update erp_catalog.origin set state='synced' where record_id=$1", [id]);
async function marks(id, call) {
  await synced(id);
  await call();
  assert.equal((await f.db.query("select state v from erp_catalog.origin where record_id=$1", [id])).rows[0].v, "local_modified");
}

test("Catálogo (P): mudança local no produto espelhado marca a origem", async () => {
  await marks(product.id, async () =>
    same("erp_catalog_product_save", { p_user_id: u.admin, p_id: product.id, p_expected_version: await version(product.id), p_command_id: randomUUID(), p_data: { name: "Produto espelhado (mudado)" }, p_acknowledged: null }),
  );
});
test("Catálogo (P): preço do produto espelhado marca a origem", async () => {
  await marks(product.id, async () =>
    same("erp_catalog_product_prices_update", { p_user_id: u.admin, p_command_id: randomUUID(), p_supplier_id: null, p_items: [{ product_id: product.id, expected_version: await version(product.id), price: "12" }] }),
  );
});
test("Catálogo (P): excluir e restaurar o produto espelhado marca a origem", async () => {
  for (const deleted of [true, false])
    await marks(product.id, async () =>
      same("erp_catalog_product_set_deleted", { p_user_id: u.admin, p_id: product.id, p_expected_version: await version(product.id), p_command_id: randomUUID(), p_deleted: deleted }),
    );
});
test("Catálogo (P): cadastro genérico do produto espelhado marca a origem", async () => {
  await marks(product.id, async () =>
    same("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: product.id, p_expected_version: await version(product.id), p_command_id: randomUUID(), p_data: { name: "Produto espelhado (genérico)", unit: "UN", kind: "P", format: "S", price: "10" } }),
  );
});
test("Catálogo (P): mudança local no contato espelhado marca a origem", async () => {
  await marks(contact.id, async () =>
    same("erp_catalog_contact_save", { p_user_id: u.admin, p_id: contact.id, p_expected_version: await version(contact.id), p_command_id: randomUUID(), p_data: { name: "Contato espelhado (mudado)", person_type: "J" }, p_acknowledged: null }),
  );
});
test("Catálogo (P): situação do contato espelhado marca a origem", async () => {
  for (const situation of ["I", "A"])
    await marks(contact.id, async () =>
      same("erp_catalog_contact_set_situation", { p_user_id: u.admin, p_id: contact.id, p_expected_version: await version(contact.id), p_command_id: randomUUID(), p_situation: situation }),
    );
});

// Leituras do espelho: source nas listas, situação vinda do snapshot aplicado
// (contact_source_situation), source_id da exportação e filtros origin_*.
test("Catálogo (P): listas com registros espelhados", async () => {
  for (const entity of ["contacts", "products"]) {
    await same("erp_catalog_list", { p_user_id: u.admin, p_entity: entity, p_limit: 100 });
    await same("erp_catalog_page", { p_user_id: u.admin, p_entity: entity, p_size: 100 });
  }
});
test("Catálogo (P): situação do contato espelhado vem do snapshot", async () => {
  const other = await f.catalog("contacts", { name: "Contato do snapshot", person_type: "F", roles: ["customer"] });
  const hash = "b".repeat(64);
  await seed(
    `insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links,captured_at)
     values('contacts','303',$1,1,'{"id":303,"nome":"Contato do snapshot","situacao":"E"}'::jsonb,'[]'::jsonb,now())`,
    [hash],
  );
  await seed(`insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) values('contacts','303',$1,$2,$2,'synced')`, [other.id, hash]);
  await seed("update erp_catalog.record set active=false where id=$1", [other.id]);
  await same("erp_catalog_contact_get", { p_user_id: u.admin, p_id: other.id });
  for (const situation of ["all", "E", "I"]) await same("erp_catalog_contact_page", { p_user_id: u.admin, p_size: 100, p_situation: situation });
  await same("erp_catalog_list", { p_user_id: u.admin, p_entity: "contacts", p_limit: 100 });
});
test("Catálogo (P): exportação e filtros origin_* dos produtos", async () => {
  await same("erp_catalog_product_export_v2", { p_user_id: u.admin });
  // Última compra só de pedido nativo (authority='brufap'): o espelhado não conta.
  await same("erp_catalog_product_purchase_info", { p_user_id: u.admin, p_product_ids: [product.id], p_supplier_id: null });
  // Uma posição observada do produto espelhado (erp_stock_mirror), físico 3.
  await seed(
    `with o as (insert into erp_stock_mirror.observation(product_source_id,warehouse_source_id,source_version,source_hash,physical,virtual,physical_state,virtual_state,observed_at)
       values('202','',1,$1,3,3,'value','value',now()) returning id)
     insert into erp_stock_mirror.position(product_source_id,warehouse_source_id,observation_id) select '202','',id from o`,
    [HASH],
  );
  for (const stock of ["origin_unlinked", "origin_not_observed", "origin_zero", "origin_positive", "origin_negative"]) {
    await same("erp_catalog_product_page_v2", { p_user_id: u.admin, p_page: 1, p_size: 100, p_stock: stock });
    await same("erp_catalog_product_page_v2", { p_user_id: u.admin, p_page: 1, p_size: 100, p_stock: stock, p_warehouse_id: warehouse.id });
  }
  const positive = await same("erp_catalog_product_page_v2", { p_user_id: u.admin, p_page: 1, p_size: 100, p_stock: "origin_positive" });
  assert.deepEqual(positive.items.map((i) => i.id), [product.id]);
});

// Auxiliares do Catálogo (B): etiquetas e vendedor sobre o contato espelhado.
// Os dois casos que marcam a origem esperavam o conserto da P no contact_apply (24a7b40, já no tronco).
/** O vendedor do contato espelhado (criado pelo caso anterior, ou semeado aqui, para os casos não dependerem um do outro). */
async function mirroredSeller() {
  const found = (await f.db.query("select id from erp_catalog.seller where contact_id=$1", [contact.id])).rows[0];
  if (found) return found.id;
  const id = randomUUID();
  await seed("insert into erp_catalog.seller(id,contact_id,created_by,updated_by) values($1,$2,$3,$3)", [id, contact.id, u.admin]);
  return id;
}
test("Catálogo (B): etiquetas do contato espelhado (gravar e ler)", async () => {
  const tag = (await same("erp_catalog_taxonomy_save", {
    p_user_id: u.admin, p_kind: "tags", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Espelho", tag_type: "contacts" },
  })).item;
  await same("erp_catalog_contact_tags_save", {
    p_user_id: u.admin, p_id: contact.id, p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [tag.id], p_mode: "replace",
  });
  await same("erp_catalog_contact_tags", { p_user_id: u.admin, p_ids: [contact.id] });
});
test("Catálogo (B): Tornar vendedor o contato espelhado marca a origem", async () => {
  await same("erp_catalog_seller_from_contact", { p_user_id: u.admin, p_command_id: randomUUID(), p_contact_id: contact.id });
  assert.equal((await f.db.query("select state v from erp_catalog.origin where record_id=$1", [contact.id])).rows[0].v, "local_modified");
});
test("Catálogo (B): leitura e página do vendedor do contato espelhado", async () => {
  const seller = await mirroredSeller();
  await same("erp_catalog_seller_get", { p_user_id: u.admin, p_id: seller });
  await same("erp_catalog_seller_page", {
    p_user_id: u.admin, p_page: 1, p_size: 25, p_sort: "name_asc", p_query: "espelhado", p_situation: "all", p_type: null,
  });
});
test("Catálogo (B): Vincular a vendedor sobre o contato espelhado marca a origem", async () => {
  const seller = await mirroredSeller();
  // A origem volta a 'synced' para o caso conferir a marca desta escrita, não a do caso anterior.
  await seed("update erp_catalog.origin set state='synced' where record_id=$1", [contact.id]);
  const version = (await f.db.query("select version v from erp_catalog.record where id=$1", [contact.id])).rows[0].v;
  await same("erp_catalog_contact_set_seller", { p_user_id: u.admin, p_id: contact.id, p_expected_version: version, p_command_id: randomUUID(), p_seller_id: seller });
  assert.equal((await f.db.query("select state v from erp_catalog.origin where record_id=$1", [contact.id])).rows[0].v, "local_modified");
});
test("Catálogo (B): etiquetas da NF-e espelhada (raw_record): leitura, carteira e escrita recusada", async () => {
  await seed(
    `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','notas/nfe','8801',$1::jsonb,$2)`,
    [JSON.stringify({ id: 8801, numero: "8801", contato: { id: 101 } }), HASH],
  );
  const tag = (await same("erp_catalog_taxonomy_save", {
    p_user_id: u.admin, p_kind: "tags", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Nota espelhada", tag_type: "invoices" },
  })).item;
  await seed("insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin','55','8801',$1)", [tag.id]);
  const read = await same("erp_catalog_invoice_tags", { p_user_id: u.consulta, p_origin: "origin", p_model: "55", p_ids: ["8801"] });
  assert.deepEqual(read.items[0].tag_ids, [tag.id]);
  // A guarda do espelho é guarda: 42501 nos dois motores, nada gravado.
  const refused = await same("erp_catalog_invoice_tags_save", {
    p_user_id: u.fiscal, p_origin: "origin", p_model: "55", p_id: "8801", p_expected_version: 0, p_command_id: randomUUID(), p_tag_ids: [], p_mode: "replace",
  });
  assert.equal(refused.error, "42501:erp_fiscal_mirror_readonly");
  // Com a carteira, a nota do contato espelhado 101 é do vendedor dele; a de contato nenhum não.
  const seller = await mirroredSeller();
  await seed("update erp_catalog.seller set user_id=$2 where id=$1", [seller, u.consulta]);
  await seed("update erp_catalog.contact_profile set seller_id=$1 where record_id=$2", [seller, contact.id]);
  await seed(
    `insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values('nfe','notas/nfe','8802','{"id":8802}'::jsonb,$1)`,
    [HASH],
  );
  const portfolio = async (value) => {
    const current = (await f.rpc("erp_preferences_page", { p_user_id: u.admin, p_page: "cadastros-contatos" })).items.find((i) => i.key === "contatos.acesso_vendedor");
    await f.rpc("erp_preferences_save", {
      p_user_id: u.admin, p_command_id: randomUUID(), p_page: "cadastros-contatos", p_changes: [{ key: "contatos.acesso_vendedor", expected_version: current.version, value }],
    });
  };
  await portfolio(true);
  try {
    assert.equal((await same("erp_catalog_invoice_tags", { p_user_id: u.consulta, p_origin: "origin", p_model: "55", p_ids: ["8801"] })).items.length, 1);
    const hidden = await same("erp_catalog_invoice_tags", { p_user_id: u.consulta, p_origin: "origin", p_model: "55", p_ids: ["8801", "8802"] });
    assert.equal(hidden.error, "P0002:erp_catalog_not_found");
  } finally {
    await portfolio(false);
    await seed("update erp_catalog.seller set user_id=null where id=$1", [seller]);
  }
});

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
test("Documentos (L): leituras de um documento espelhado passam pela guarda do espelho", async () => {
  await seedSourced();
  for (const id of [mirrored, sourced]) {
    for (const name of ["erp_document_copy_origin", "erp_document_structures", "erp_document_supplier_descriptions", "erp_document_commission_operation", "erp_document_occurrence_list", "erp_document_freight_paid_get"])
      await same(name, { p_user_id: u.admin, p_kind: "sales_orders", p_document_id: id });
    await same("erp_document_pendencies", { p_user_id: u.admin, p_kind: "sales_orders", p_id: id });
    await same("erp_document_checkout_get", { p_user_id: u.admin, p_id: id });
    await same("erp_document_conversion_preview", { p_user_id: u.admin, p_kind: "sales_orders", p_proposal_id: id });
  }
});
test("Documentos (L): lista com busca e total da fonte, e exportação com o espelho", async () => {
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
