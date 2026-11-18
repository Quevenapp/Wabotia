// Diferencial da última definição (358 + 202610220003). Datas observadas e
// fiscais fixas: o resultado não depende do dia de execução.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { callRpc, isPorted } from "../../../src/erp/engine/registry.ts";
import { auxFixture } from "./aux-fixture.mjs";

const RPC = "erp_catalog_invoice_list_tagged", HASH = "b".repeat(64);
const AT = "2026-10-19T12:34:56.123456Z";
let f, tag, otherTag, productTag, product, client, seller, category, native;
const ids = (page) => page.items.map((r) => r.id);
const list = (args = {}) => f.rpc(RPC, { p_user_id: f.users.admin, p_tag: "none", ...args });
const bad = (args, code = "22023", message = "erp_fiscal_query_invalid") =>
  assert.rejects(list(args), (e) => e.code === code && e.message === message);
async function replica(fn) {
  await f.db.exec("set session_replication_role=replica");
  try { return await fn(); } finally { await f.db.exec("set session_replication_role=origin"); }
}
async function raw(entity, id, payload) {
  await f.db.query(`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash,first_seen_at,last_seen_at,changed_at)
    values($1,$1,$2,$3,$4,$5,$5,$5)`, [entity, id, JSON.stringify(payload), HASH, AT]);
}
async function mirror(id, changes = {}, entity = "nfe") {
  const payload = { id, numero: id, serie: 1, tipo: "1", dataEmissao: "2026-10-10", dataOperacao: "2026-10-12", situacao: 5,
    valorNota: "10.25", contato: { id: "500", nome: "Ágata Cliente", fantasia: "Loja Azul", numeroDocumento: "12345678000199", tipoPessoa: "J",
      email: "agata@example.test", telefone: "(11) 99876-5432", endereco: { uf: "sp" } },
    transporte: { transportador: { nome: "Transportes Azul" }, volumes: [{ codigoRastreamento: "BR123" }] },
    vendedor: { id: "600" }, itens: [{ codigo: "PROD-1" }], ...changes };
  await raw(entity, id, payload);
  // Usa a projeção SQL real para construir o resumo; testa a leitura dele.
  await f.db.query(`select erp_fiscal_mirror.apply(r) from origin_sync.raw_record r where entity=$1 and source_id=$2`, [entity, id]);
}
async function note({ model = "55", direction = "1", number = null, date = "2026-10-10", total = "10.25", type = model === "65" ? "C" : "N", status = 1, deleted = false } = {}) {
  const id = randomUUID();
  await f.db.query(`insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,
    issue_date,exit_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,
    freight,insurance,other_expenses,discount,totals,version,created_by,updated_by,seller_id,deleted_at,deleted_by,delete_reason)
    values($1,$2,$3,$4,case when $4 in('S','X','T') then null else '2' end,$5,1,$6,'Venda especial',$7,'2026-10-12','1','1','1',false,$8,'[]',$9,'{}','[]','{}',false,
    0,0,0,0,$10,1,$11,$11,$12,$13,$14,$15)`, [id, model, direction, type, status, number, date,
    JSON.stringify({ name: "Ágata Cliente", contact_id: client.id, document: "12345678000199", person_type: "J", email: "agata@example.test", phone: "11998765432", state: "SP" }),
    JSON.stringify({ carrier: { name: "Transportes Azul" }, tracking_code: "BR123" }), JSON.stringify({ total }), f.users.admin, seller,
    deleted ? AT : null, deleted ? f.users.admin : null, deleted ? "Exclusão sintética" : null]);
  return id;
}
before(async () => {
  f = await auxFixture();
  tag = (await f.taxonomySave("tags", { name: "Conferir", tag_type: "invoices" }, { user: f.users.fiscal })).item.id;
  otherTag = (await f.taxonomySave("tags", { name: "Outro autor", tag_type: "invoices" })).item.id;
  productTag = (await f.taxonomySave("tags", { name: "Produto", tag_type: "products" })).item.id;
  product = await f.product({ name: "Produto sintético", code: "PROD-1" });
  const sellerContact = await f.contact({ name: "Vendedor sintético" });
  seller = await f.scalar(`insert into erp_catalog.seller(contact_id,user_id,created_by,updated_by) values($1,$2,$3,$3) returning id`, [sellerContact.id, f.users.fiscal, f.users.admin]);
  await f.sync();
  client = await f.contact({ name: "Ágata Cliente", trade_name: "Loja Azul", seller_id: seller, code: "CLI-1" });
  await replica(async () => {
    await f.db.query(`insert into erp_catalog.origin(entity,source_id,record_id,latest_hash,state) values('contacts','500',$1,$3,'synced'),('contacts','501',$2,$3,'synced')`, [client.id, sellerContact.id, HASH]);
    await raw("contacts", "500", { codigo: "CLI-1" });
    await raw("sellers", "600", { contato: { id: 501 } });
    await mirror("101");
    await mirror("102", { numero: "2", dataEmissao: "2026-10-11", dataOperacao: "2026-10-14", valorNota: "20.10", situacao: 6 });
    await mirror("103", { numero: null, serie: 2, dataEmissao: null, valorNota: null, situacao: null,
      contato: { nome: "Outro cliente" }, transporte: {}, vendedor: {}, itens: [] });
    await mirror("104", { numero: "2", dataEmissao: "2026-10-11", valorNota: "-0.15" });
    await mirror("105", { tipo: "0" });
    await mirror("106", {}, "nfce");
    await mirror("107");
    await mirror("108");
    await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('origin','55','107',$1),('origin','55','108',$2)`, [tag, otherTag]);
    native = [await note({ number: 12 }), await note({ number: 3, date: "2026-10-11", status: 7 }), await note(),
      await note({ direction: "0" }), await note({ model: "65" }), await note({ deleted: true })];
    await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('brufap','55',$1,$2)`, [native[2], tag]);
    await f.db.query(`insert into erp_fiscal_invoices.invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
      values($1,1,$2,1,10.25,10.25,0,0,0,0,'{}')`, [native[0], product.id]);
    for (const number of [12, 2]) {
      const document = randomUUID();
      await f.db.query(`insert into erp_documents.document(id,kind,number,status,contact_id,contact_snapshot,body,total,created_by,updated_by)
        values($1,'sales_orders',$2,'draft',$3,'{}','{"date":"2026-10-08"}',10.25,$4,$4)`, [document, number, client.id, f.users.admin]);
      await f.db.query(`insert into erp_fiscal_invoices.invoice_order values($1,$2)`, [native[0], document]);
    }
    await f.db.query(`insert into erp_fiscal_invoices.origin_order_link(order_source_id,invoice_source_id,order_number,order_date,contact_name,source_version,source_hash,updated_at)
      values('901','101','12','2026-10-09','Cliente pedido',1,$1,$2),('902','101','2','2026-10-08','Cliente pedido',1,$1,$2)`, [HASH, AT]);
  });
  await f.sync();
});
after(async () => f?.close());

test("registro, etiquetas globais (inclusive de outro autor), ausência e tipo diferente", async () => {
  assert.ok(isPorted(RPC));
  assert.deepEqual(ids(await list()), ["104", "102", "101", "103"]);
  assert.deepEqual(ids(await list({ p_tag: tag })), ["107"]);
  assert.deepEqual(ids(await list({ p_tag: otherTag, p_user_id: f.users.fiscal })), ["108"]);
  for (const p_tag of [productTag, randomUUID()]) assert.deepEqual(ids(await list({ p_tag })), []);
  assert.deepEqual(ids(await list({ p_origin: "brufap", p_tag: tag })), [native[2]]);
});

test("cada ordenação, desempate por id, nulos por último, página e totais sobre todas as linhas", async () => {
  for (const [p_order, expected] of Object.entries({ date_desc: ["104", "102", "101", "103"], date_asc: ["101", "104", "102", "103"],
    number_desc: ["101", "104", "102", "103"], number_asc: ["104", "102", "101", "103"] })) {
    const whole = await list({ p_order });
    assert.deepEqual(ids(whole), expected);
    const page = await list({ p_order, p_page: 2, p_limit: 1 });
    assert.deepEqual(ids(page), expected.slice(1, 2));
    assert.deepEqual([page.total_count, page.total_amount, page.amount_unknown, page.has_more], [4, "30.20", 1, true]);
    assert.deepEqual(page.coverage, whole.coverage);
    assert.deepEqual(ids(await list({ p_order, p_page: 8, p_limit: 1 })), []);
    await list({ p_origin: "brufap", p_order, p_limit: 1, p_page: 2 });
  }
  assert.equal((await list({ p_query: "inexistente" })).total_amount, "0.00");
});

test("datas de emissão/entrada, busca por nome/fantasia/documento/número e filtros da assinatura", async () => {
  assert.deepEqual(ids(await list({ p_date_from: "2026-10-11", p_date_to: "2026-10-11" })), ["104", "102"]);
  assert.deepEqual(ids(await list({ p_date_type: "entry", p_date_from: "2026-10-14", p_date_to: "2026-10-14" })), ["102"]);
  for (const p_query of ["ÁGATA", "loja AZUL", "12345", "000101", "  101  ", "sem resultado", "ága%", "000"]) await list({ p_query });
  assert.deepEqual(ids(await list({ p_query: "000101" })), ["101"]);
  for (const filter of [{ p_state: "SP" }, { p_person_type: "J" }, { p_series: 1 }, { p_document: "12.345.678/0001-99" },
    { p_email: "AGATA@" }, { p_phone: "(11)99876" }, { p_trade_name: " AZUL " }, { p_carrier: "transportes" },
    { p_tracking: "br123" }, { p_contact_code: "CLI-1" }, { p_product_id: product.id }, { p_seller_id: seller }]) {
    assert.deepEqual(ids(await list(filter)), ["104", "102", "101"]);
    await list({ p_origin: "brufap", ...filter });
  }
  assert.deepEqual(ids(await list({ p_order_number: "12" })), ["101"]);
  assert.deepEqual((await list({ p_query: "101" })).items[0].orders.map((o) => o.number), ["2", "12"]);
  assert.deepEqual(ids(await list({ p_origin: "brufap", p_product_id: product.id })), [native[0]]);
  const ordered = await list({ p_origin: "brufap", p_order_number: "12" });
  assert.deepEqual(ids(ordered), [native[0]]);
  assert.deepEqual(ordered.items[0].orders.map((o) => o.number), ["2", "12"]);
  assert.equal((await list({ p_nature: "Venda" })).total_count, 0);
  assert.equal((await list({ p_origin: "brufap", p_nature: "especial" })).total_count, 2);
  for (const p_status of ["pending", "issued", "authorized", "cancelled", "denied", "registered", "contingency"]) {
    await list({ p_status }); await list({ p_origin: "brufap", p_status });
  }
  for (const filter of [{ p_product_id: randomUUID() }, { p_seller_id: randomUUID() }, { p_state: "EX" }, { p_person_type: "F" }, { p_series: 999 },
    { p_document: "999" }, { p_phone: "999" }, { p_email: "missing" }, { p_tracking: "missing" }, { p_contact_code: "missing" }, { p_order_number: "012" }])
    assert.equal((await list(filter)).total_count, 0);
  await list({ p_document: "---", p_phone: "()", p_nature: " ", p_query: " " });
});

test("origens, modelos, direções, status fiscal, preferências e ordem das chaves JSON", async () => {
  assert.deepEqual(ids(await list({ p_direction: "0" })), ["105"]);
  assert.deepEqual(ids(await list({ p_model: "65" })), ["106"]);
  for (const [p_model, p_direction, expected] of [["55", "0", native[3]], ["65", "1", native[4]]])
    assert.deepEqual(ids(await list({ p_origin: "brufap", p_model, p_direction })), [expected]);
  const p = await list({ p_origin: "brufap" });
  assert.deepEqual([p.items[0].fiscal_status, p.items[0].danfe_emitted, p.coverage], [6, true, null]);
  const args = { p_user_id: f.users.admin, p_tag: "none" };
  const pg = await list(), lite = callRpc(f.driver, RPC, args, f.clock);
  assert.deepEqual(Object.keys(lite), Object.keys(pg));
  assert.deepEqual(Object.keys(lite.items[0]), Object.keys(pg.items[0]));
  assert.deepEqual(Object.keys(lite.coverage), Object.keys(pg.coverage));
  // A página da preferência é descoberta no próprio catálogo do oráculo.
  const page = await f.scalar("select page_id from erp_preferences.definition where key='nfe.exibir_totais'");
  await f.preference(page, "nfe.exibir_totais", false);
  try { assert.equal((await list()).show_totals, false); } finally { await f.preference(page, "nfe.exibir_totais", true); }
});

test("acesso e carteira: fiscal/consulta, administrador, inativo e permissões finas", async () => {
  for (const user of [f.users.vendas, f.users.estoque, f.users.financeiro, f.users.inactive, null])
    await bad({ p_user_id: user, p_page: 0 }, "42501", "erp_fiscal_invoice_forbidden");
  await list({ p_user_id: f.users.consulta });
  await bad({ p_user_id: f.users.consulta, p_origin: "brufap" }, "42501", "erp_fiscal_invoice_forbidden");
  await bad({ p_user_id: f.users.consulta, p_origin: "brufap", p_limit: 0 });
  await f.preference("cadastros-contatos", "contatos.acesso_vendedor", true);
  try {
    const own = await list({ p_user_id: f.users.fiscal });
    assert.deepEqual(ids(own), ["104", "102", "101"]);
    assert.equal(own.coverage.source_count, 5);
    assert.equal((await list()).total_count, 4);
    assert.equal((await list({ p_user_id: f.users.fiscal, p_origin: "brufap" })).total_count, 2);
    await replica(async () => { await f.db.query(`update erp_fiscal_invoices.invoice set recipient='{"name":"Sem carteira"}' where id=$1`, [native[0]]); });
    await f.sync();
    assert.deepEqual(ids(await list({ p_user_id: f.users.fiscal, p_origin: "brufap" })), [native[1]]);
  } finally {
    await replica(async () => { await f.db.query(`update erp_fiscal_invoices.invoice set recipient=jsonb_build_object('name','Ágata Cliente','contact_id',$2::text) where id=$1`, [native[0], client.id]); });
    await f.sync();
    await f.preference("cadastros-contatos", "contatos.acesso_vendedor", false);
  }
  await f.restrict(f.users.consulta, []);
  await bad({ p_user_id: f.users.consulta }, "42501", "erp_fiscal_invoice_forbidden");
});

test("argumentos inválidos: mesmos códigos, mensagens e precedência do SQL", async () => {
  for (const args of [{ p_origin: null }, { p_origin: "x" }, { p_model: null }, { p_model: "57" }, { p_direction: null }, { p_direction: "2" },
    { p_model: "65", p_direction: "0" }, { p_page: null }, { p_page: 0 }, { p_page: 100001 }, { p_limit: null }, { p_limit: 0 }, { p_limit: 101 },
    { p_order: null }, { p_order: "x" }, { p_date_type: null }, { p_date_type: "x" }, { p_date_from: "2026-10-12", p_date_to: "2026-10-10" },
    { p_status: "x" }, { p_status: "__proto__" }, { p_state: "sp" }, { p_person_type: "x" }, { p_series: -1 }, { p_series: 1000 }, { p_tag: null }, { p_tag: "" },
    { p_tag: tag.toUpperCase() }, { p_category_id: randomUUID() }]) await bad(args);
  for (const k of ["query", "nature", "carrier", "trade_name", "document", "email", "phone", "contact_code", "order_number", "tracking"])
    for (const value of ["a".repeat(121), "a\nb", "a\u007fb"]) await bad({ [`p_${k}`]: value });
  await assert.rejects(f.rpc(RPC, { p_user_id: f.users.admin }), (e) => e.code === "22023" && e.message === "erp_fiscal_query_invalid");
  for (const [args, code] of [[{ p_seller_id: "bad" }, "22P02"], [{ p_category_id: "bad" }, "22P02"], [{ p_limit: "bad" }, "22P02"],
    [{ p_date_from: "2026-02-30" }, "22008"], [{ p_date_to: "bad" }, "22007"]]) await assert.rejects(list(args), (e) => e.code === code);
});

test("categoria de lançamento ativo e faturamento agrupado ativo; vínculos inativos não contam", async () => {
  const posting = randomUUID(), billing = randomUUID(), title = randomUUID(), groupedTitle = randomUUID();
  category = randomUUID();
  await replica(async () => {
    await f.db.query(`insert into erp_finance.category(id,name,kind) values($1,'Categoria sintética','receivable')`, [category]);
    for (const id of [title, groupedTitle]) await f.db.query(`insert into erp_finance.title(id,group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,competence_on,original_due_on,amount_cents)
      values($1,$1,1,1,'receivable',$2,$3,'Conta sintética','2026-10-10','2026-10-20','2026-10-10','2026-10-20',1025)`, [id, client.id, category]);
    await f.db.query(`insert into erp_finance.invoice_posting(id,invoice_id,invoice_version,group_id,snapshot,preview_hash,actor,command_id)
      values($1,$2,1,$1,'{}',$3,$4,$1)`, [posting, native[0], HASH, f.users.admin]);
    await f.db.query(`insert into erp_finance.invoice_title values($1,$2,1)`, [title, posting]);
    await f.db.query(`insert into erp_finance.grouped_billing(id,contact_id,issued_on,condition,total_cents,actor,command_id)
      values($1,$2,'2026-10-10','30',1025,$3,$1)`, [billing, client.id, f.users.admin]);
    await f.db.query(`insert into erp_finance.grouped_billing_invoice values($1,$2,1025,true)`, [billing, native[1]]);
    await f.db.query(`insert into erp_finance.grouped_billing_title values($1,$2,1)`, [groupedTitle, billing]);
  });
  await f.sync();
  const args = { p_origin: "brufap", p_category_id: category };
  assert.deepEqual(ids(await list(args)), [native[1], native[0]]);
  assert.deepEqual(ids(await list({ ...args, p_category_id: randomUUID() })), []);
  await replica(async () => {
    await f.db.query(`update erp_finance.invoice_posting set state='reversed',reversed_at=$2,reversed_by=$3,reason='Estorno sintético' where id=$1`, [posting, AT, f.users.admin]);
    await f.db.query(`update erp_finance.grouped_billing_invoice set active=false where billing_id=$1`, [billing]);
  });
  await f.sync();
  assert.deepEqual(ids(await list(args)), []);
  await replica(async () => {
    await f.db.query(`update erp_finance.grouped_billing_invoice set active=true where billing_id=$1`, [billing]);
    await f.db.query(`update erp_finance.grouped_billing set state='deleted',deleted_at=$2,deleted_by=$3 where id=$1`, [billing, AT, f.users.admin]);
  });
  await f.sync();
  assert.deepEqual(ids(await list(args)), []);
});

test("espelho: chave canônica, XML de produção/homologação, exclusão e cobertura independente da etiqueta", async () => {
  const key = "1".repeat(44), homolog = "2".repeat(44);
  await replica(async () => {
    await mirror("201", { chaveAcesso: key });
    await mirror("202", { chaveAcesso: key });
    await mirror("203", { chaveAcesso: homolog });
    await mirror("204", { _brufap_source: { deleted: true } });
    for (const [id, access, environment] of [["202", key, "1"], ["203", homolog, "2"]])
      await f.db.query(`insert into erp_fiscal_mirror.xml_cache(archive_source_id,entity,source_id,access_key,xml_id,xml_hash,xml_size,environment,protocol_present,event_count,events,last_success_at)
        values($1,'nfe',$2,$3,$4,$5,123,$6,true,2,'[]',$7)`, [randomUUID(), id, access, randomUUID(), HASH, environment, AT]);
  });
  await f.sync();
  const p = await list({ p_query: key });
  assert.deepEqual(ids(p), ["202"]);
  assert.deepEqual([p.items[0].xml_size, p.items[0].protocol_present, p.items[0].event_count], [123, true, 2]);
  assert.deepEqual([p.coverage.source_count, p.coverage.visible_count, p.coverage.duplicate_count, p.coverage.homologation_count], [10, 7, 1, 1]);
  assert.deepEqual((await list({ p_tag: tag })).coverage, p.coverage);
  assert.deepEqual(ids(await list({ p_query: homolog })), []);
  assert.equal(p.items[0].observed_at, "2026-10-19T12:34:56.123456+00:00");
});

test("origem e ambiente de XML importado/terceiro; soma antes do arredondamento e deduplicação nativa", async () => {
  let imported, third, entry;
  await replica(async () => {
    imported = await note({ type: "S", number: 20, total: "0.005" });
    third = await note({ type: "T", number: 30, total: "0.005" });
    entry = await note({ type: "X", direction: "0", number: 40, total: "9999999999999.99" });
    for (const id of [imported, third, entry])
      await f.db.query(`insert into erp_catalog.invoice_tag(origin,model,invoice_id,tag_id) values('brufap','55',$1,$2)`, [id, otherTag]);
    for (const [id, environment] of [[imported, "1"], [entry, "2"]])
      await f.db.query(`insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment,recorded_at) values($1,$2,$3,$4)`, [id, HASH, environment, AT]);
    await f.db.query(`update erp_fiscal_invoices.invoice set access_key=$2 where id=$1`, [imported, "1".repeat(44)]);
  });
  await f.sync();
  const p = await list({ p_origin: "brufap", p_tag: otherTag });
  assert.deepEqual(ids(p), [third, imported]);
  assert.deepEqual(p.items.map((i) => [i.source_origin, i.source_environment, i.environment, i.total]),
    [["third_party", null, null, "0.01"], ["xml_import", "1", null, "0.01"]]);
  assert.equal(p.total_amount, "0.01");
  const incoming = await list({ p_origin: "brufap", p_tag: otherTag, p_direction: "0" });
  assert.deepEqual([incoming.items[0].source_environment, incoming.total_amount], ["2", "9999999999999.99"]);
  assert.deepEqual(ids(await list({ p_query: "1".repeat(44) })), []);
});

test("cobertura completa e filas pendentes; pedido ambíguo entre NF-e e NFC-e", async () => {
  const key = "3".repeat(20) + "65" + "3".repeat(22), archive = randomUUID();
  await replica(async () => {
    await f.db.query(`update erp_fiscal_mirror.current set access_key=$1 where entity='nfce' and source_id='106'`, [key]);
    await f.db.query(`insert into origin_fiscal.source(id,entity,source_id,access_key) values($1,'nfce','106',$2)`, [archive, key]);
    await f.db.query(`insert into erp_fiscal_mirror.xml_cache(archive_source_id,entity,source_id,access_key,xml_id,environment,protocol_present,event_count,events,last_success_at)
      values($1,'nfce','106',$2,$3,'1',false,0,'[]',$4)`, [archive, key, randomUUID(), AT]);
  });
  await f.sync();
  assert.equal((await list({ p_model: "65" })).coverage.partial, false);
  await f.db.query(`insert into erp_fiscal_mirror.xml_seed values($1,$2)`, [archive, AT]);
  await f.sync();
  assert.equal((await list({ p_model: "65" })).coverage.partial, true);
  await f.db.query(`delete from erp_fiscal_mirror.xml_seed where archive_source_id=$1`, [archive]);
  await replica(async () => {
    await raw("nfce", "999", { tipo: "1", contato: { id: 500 } });
    await f.db.query(`insert into erp_fiscal_mirror.seed values('nfce','999',$1)`, [AT]);
  });
  await f.sync();
  assert.equal((await list({ p_model: "65" })).coverage.partial, true);
  await f.db.exec(`delete from erp_fiscal_mirror.seed where entity='nfce' and source_id='999'`);
  await replica(async () => { await mirror("101", {}, "nfce"); });
  await f.sync();
  assert.deepEqual((await list({ p_query: "101" })).items[0].orders, []);
  assert.equal((await list({ p_order_number: "12" })).total_count, 0);
});
