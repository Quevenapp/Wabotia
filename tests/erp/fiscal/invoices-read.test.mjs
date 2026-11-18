// F2a: RPCs nos dois motores, incluindo estado escrito e replay. GRANT/RLS ficam fora, como no F1.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { before, after, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { isPorted } from "../../../src/erp/engine/registry.ts";
import { invoice, item, seed, raw, mirror, key, refused } from "./invoice-fixture.mjs";
let f, product, contact, native, purchase, imported;
const rpc = (suffix, args = {}, user = f.users.admin) => f.rpc(`erp_fiscal_invoice_${suffix}`, { p_user_id: user, ...args });
before(async () => {
  f = await dualFixture();
  for (const suffix of ["get", "list", "xml_get", "xml_source", "key_lookup", "returned", "item_history", "pricing_states", "pricing_record"])
    assert.equal(isPorted(`erp_fiscal_invoice_${suffix}`), true, suffix);
  product = await f.catalog("products", { name: "Produto F2a", code: "F2A", unit: "UN", kind: "P", price: "10" });
  contact = await f.catalog("contacts", {
    name: "Cliente Árvore",
    trade_name: "Fantasia Única",
    code: "CLI-F2A",
    person_type: "J",
    document: "11222333000181",
    roles: ["customer", "supplier"],
  });
  const recipient = {
    contact_id: contact.id,
    name: "Cliente Árvore",
    person_type: "J",
    document: "11222333000181",
    state: "SP",
    email: "cliente@example.test",
    phone: "11998765432",
  };
  native = await invoice(f, { recipient });
  await item(f, native, product.id);
  purchase = await invoice(f, { direction: "0", number: 12, recipient });
  await item(f, purchase, product.id);
  imported = await invoice(f, { issue_type: "S", environment: null, number: 13, access_key: key, status: 6, recipient });
  await item(f, imported, product.id);
});
after(() => f?.close());

test("get: registro completo, itens, valores monetários, envelope e locks", async () => {
  const r = await rpc("get", { p_id: native });
  assert.equal(r.invoice.id, native);
  assert.equal(r.invoice.freight, "1.25");
  assert.equal(r.invoice.items[0].position, 1);
  assert.equal(r.writable, true);
  assert.deepEqual(r.locks, { items: false, installments: false });
  assert.equal((await rpc("get", { p_id: imported })).writable, false);
  await assert.rejects(rpc("get", { p_id: null }), refused("22023"));
  await assert.rejects(rpc("get", { p_id: randomUUID() }), refused("P0002"));
});

test("list nativa: filtros, busca literal/Unicode, ordenação, paginação e totais", async () => {
  const list = (args = {}) => rpc("list", { p_origin: "brufap", ...args });
  const all = await list();
  assert.equal(all.total_count, 2);
  assert.equal(all.total_amount, "246.90");
  assert.equal(all.coverage, null);
  for (const [k, v] of Object.entries({
    query: "árvore",
    state: "SP",
    nature: "à vista",
    carrier: "ágil",
    trade_name: "única",
    person_type: "J",
    document: "11.222.333/0001-81",
    email: "EXAMPLE",
    phone: "(11) 99876",
    series: 1,
    contact_code: "CLI-F2A",
    product_id: product.id,
    tracking: "ra123",
    date_from: "2026-11-12",
    date_to: "2026-11-12",
  })) {
    assert.equal((await list({ [`p_${k}`]: v })).total_count, 2, k);
  }
  assert.equal((await list({ p_query: "00011" })).items[0].id, native);
  assert.equal((await list({ p_query: key })).items[0].id, imported);
  assert.equal((await list({ p_query: "%" })).total_count, 0);
  assert.equal((await list({ p_status: "pending" })).total_count, 1);
  assert.equal((await list({ p_status: "issued" })).total_count, 1);
  assert.equal((await list({ p_date_type: "entry", p_date_from: "2026-11-13", p_date_to: "2026-11-13" })).total_count, 2);
  for (const order of ["date_desc", "date_asc", "number_desc", "number_asc"]) {
    const r = await list({ p_order: order, p_limit: 1 });
    assert.equal(r.has_more, true);
    assert.equal(r.items[0].id, order.endsWith("asc") ? native : imported);
    assert.equal((await list({ p_order: order, p_limit: 1, p_page: 2 })).has_more, false);
  }
  for (const args of [
    { p_state: "XX" },
    { p_person_type: "Z" },
    { p_series: 1000 },
    { p_limit: 0 },
    { p_page: null },
    { p_status: "bad" },
    { p_order: "bad" },
    { p_date_type: null },
    { p_model: "65", p_direction: "0" },
    { p_query: "x\n" },
    { p_nature: "x".repeat(121) },
    { p_date_from: "2026-11-14", p_date_to: "2026-11-12" },
  ])
    await assert.rejects(list(args), refused("22023"));
  for (const args of [
    { p_product_id: randomUUID() },
    { p_seller_id: randomUUID() },
    { p_category_id: randomUUID() },
    { p_state: "MG" },
    { p_order_number: "999" },
  ])
    assert.equal((await list(args)).total_count, 0);
});

test("XML: conteúdo importado, emissor e previsão de numeração", async () => {
  const xml = "<nfeProc><ide><tpAmb>1</tpAmb></ide><infProt><tpAmb>1</tpAmb></infProt></nfeProc>";
  await f.db.query(
    `insert into erp_fiscal_invoices.invoice_xml(invoice_id,sha256,size,content,signed,protocol_status,imported_by) values($1,$2,$3,$4,true,'100',$5)`,
    [imported, createHash("sha256").update(xml).digest("hex"), Buffer.byteLength(xml), xml, f.users.admin],
  );
  await f.sync();
  const x = await rpc("xml_get", { p_id: imported });
  assert.equal(x.xml, xml);
  assert.equal(x.access_key, key);
  const source = await rpc("xml_source", { p_id: native });
  assert.equal(source.envelope.invoice.id, native);
  assert.equal(source.emitter.regime_confirmed, false);
  assert.deepEqual(source.numbering, { series: 1, next_number: null, enabled: null });
  await assert.rejects(rpc("xml_source", { p_id: imported }), refused("22023", "erp_fiscal_invoice_native_xml_unavailable"));
  await assert.rejects(rpc("xml_get", { p_id: native }), refused("P0002"));
  for (const suffix of ["xml_get", "xml_source"]) {
    await assert.rejects(rpc(suffix, { p_id: null }), refused("22023"));
    await assert.rejects(rpc(suffix, { p_id: randomUUID() }), refused("P0002"));
  }
});

test("key_lookup e returned: origem, devoluções válidas e soma das quantidades", async () => {
  assert.equal((await rpc("key_lookup", { p_key: key })).items[0].id, imported);
  const ret = await invoice(f, { direction: "0", purpose: "4", number: 20, doc_references: [{ type: "nfe", key }] });
  await item(f, ret, product.id);
  const ret2 = await invoice(f, { direction: "0", purpose: "4", number: 21, doc_references: [{ key }] });
  await item(f, ret2, product.id, { quantity: "1.2500" });
  for (const status of [3, 10]) {
    const id = await invoice(f, { direction: "0", purpose: "4", status, number: 22, doc_references: [{ key }] });
    await item(f, id, product.id);
  }
  const r = await rpc("returned", { p_key: key });
  assert.equal(r.returns.length, 2);
  assert.equal(r.items[0].quantity, "3.7500");
  for (const suffix of ["key_lookup", "returned"]) {
    await assert.rejects(rpc(suffix, { p_key: "1" }), refused("22023"));
    assert.deepEqual((await rpc(suffix, { p_key: "9".repeat(44) }))[suffix === "returned" ? "returns" : "items"], []);
  }
  await raw(f, "nfe", "1001", { tipo: 0, numero: "000123", serie: "3", dataEmissao: "2026-10-05T00:00:00", contato: { nome: "Fonte" }, valorNota: "12.345" });
  await seed(f, `insert into origin_fiscal.source(entity,source_id,access_key) values('nfe','1001',$1)`, [key]);
  const lookup = await rpc("key_lookup", { p_key: key });
  assert.equal(lookup.items.length, 2);
  assert.equal(lookup.items[1].total, "12.35");
});

test("item_history: nativo e refresh persistente do índice Origin, com atualização e repetição", async () => {
  const args = { p_contact_id: contact.id, p_product_id: product.id, p_direction: "0" };
  assert.equal((await rpc("item_history", args)).items[0].id, purchase);
  await seed(f, `insert into erp_catalog.origin(entity,source_id,record_id,latest_hash,state) values('contacts','contact-origin',$1,repeat('a',64),'synced')`, [
    contact.id,
  ]);
  const p = {
    tipo: "0",
    numero: "00030",
    serie: 2,
    dataEmissao: "2026-11-14",
    contato: { id: "contact-origin" },
    itens: [
      { codigo: "F2A", quantidade: "3.2500", valor: "9.1234567890", valorTotal: "29.651234" },
      { codigo: "INVALID", quantidade: "x", valor: "-1", valorTotal: "bad" },
    ],
  };
  await raw(f, "nfe", "history", p);
  const r = await rpc("item_history", args);
  assert.equal(r.items[0].id, "history");
  assert.equal(r.items[0].total, "29.65");
  assert.equal(await f.scalar("select count(*) from erp_fiscal_invoices.origin_item_index where source_id='history'"), 2);
  await rpc("item_history", args);
  await raw(f, "nfe", "history", { ...p, itens: [{ codigo: "F2A", quantidade: "4", valor: "2", valorTotal: "8" }] }, "b".repeat(64), "2026-11-12T10:01:00Z");
  assert.equal((await rpc("item_history", args)).items[0].quantity, "4");
  assert.equal(await f.scalar("select count(*) from erp_fiscal_invoices.origin_item_index where source_id='history'"), 1);
  for (const patch of [{ p_direction: "2" }, { p_product_id: null }, { p_contact_id: null }])
    await assert.rejects(rpc("item_history", { ...args, ...patch }), refused("22023"));
  await assert.rejects(rpc("item_history", { ...args, p_product_id: randomUUID() }), refused("P0002"));
});

test("pricing: recibo do catálogo, replay, conflito de ator e estados", async () => {
  const command = randomUUID();
  await seed(f, `insert into erp_catalog.command(command_id,actor,request_hash,result) values($1,$2,$3,$4)`, [
    command,
    f.users.admin,
    "c".repeat(64),
    JSON.stringify({ entity: "products", supplier_id: null, items: [{ product_id: product.id }] }),
  ]);
  const args = { p_invoice_id: purchase, p_catalog_command_id: command };
  assert.equal((await rpc("pricing_record", args)).replayed, false);
  assert.equal((await rpc("pricing_record", args)).replayed, true);
  const states = await rpc("pricing_states", { p_invoice_ids: [purchase, purchase, native] }, f.users.consulta);
  assert.equal(states.items.length, 1);
  assert.equal(states.items[0].count, 1);
  await assert.rejects(rpc("pricing_record", args, f.users.fiscal), refused("40001", "erp_fiscal_invoice_pricing_conflict"));
  await assert.rejects(rpc("pricing_record", { ...args, p_catalog_command_id: randomUUID() }), refused("22023", "erp_fiscal_invoice_pricing_unmatched"));
  await assert.rejects(rpc("pricing_record", { ...args, p_invoice_id: native }), refused("P0002"));
  for (const ids of [null, [], [null], Array(101).fill(purchase)]) await assert.rejects(rpc("pricing_states", { p_invoice_ids: ids }), refused("22023"));
});

test("list do espelho: cobertura, duplicação, exclusão, total desconhecido e filtros", async () => {
  const listing = {
    direction: "1",
    number: 41,
    series: 3,
    issue_date: "2026-11-11",
    entry_date: "2026-11-12",
    name: "Espelho Único",
    trade_name: "Loja",
    document: "12345678909",
    person_type: "F",
    state: "MG",
    email: "mirror@example.test",
    phone: "3199999999",
    status: 7,
    total: "15.75",
    product_codes: ["F2A"],
    contact_source_id: "contact-origin",
    carrier: "Carga",
    tracking: "ZZ",
  };
  await mirror(f, "m1", listing, { access_key: "1".repeat(44) });
  await mirror(f, "m2", { ...listing, number: 42 }, { access_key: "1".repeat(44), last_seen_at: "2026-11-13T00:00:00Z" });
  await mirror(f, "m3", { ...listing, number: 43, total: null, status: null });
  await mirror(f, "m4", listing, { source_deleted: true });
  const list = (args = {}) => rpc("list", args, f.users.consulta);
  const r = await list();
  assert.equal(r.total_count, 2);
  assert.equal(r.total_amount, "15.75");
  assert.equal(r.amount_unknown, 1);
  assert.equal(r.coverage.duplicate_count, 1);
  assert.equal(r.coverage.partial, true);
  assert.equal(r.items.find((x) => x.id === "m2").danfe_emitted, true);
  assert.equal(r.items.find((x) => x.id === "m2").fiscal_status, 6);
  assert.equal((await list({ p_query: "único", p_product_id: product.id, p_state: "MG", p_status: "issued" })).items[0].id, "m2");
  await assert.rejects(list({ p_category_id: randomUUID() }), refused("22023"));
});

test("papéis: consulta lê espelho e pricing_states, editor exige escrita; sem acesso é recusado", async () => {
  await rpc("list", {}, f.users.consulta);
  await rpc("pricing_states", { p_invoice_ids: [native] }, f.users.consulta);
  const calls = [
    ["get", { p_id: native }],
    ["list", { p_origin: "brufap" }],
    ["xml_get", { p_id: imported }],
    ["xml_source", { p_id: native }],
    ["key_lookup", { p_key: key }],
    ["returned", { p_key: key }],
    ["item_history", { p_contact_id: contact.id, p_product_id: product.id, p_direction: "1" }],
    ["pricing_record", { p_invoice_id: purchase, p_catalog_command_id: randomUUID() }],
  ];
  for (const [suffix, args] of calls) await assert.rejects(rpc(suffix, args, f.users.consulta), refused("42501", "erp_fiscal_invoice_forbidden"));
  for (const [suffix, args] of [...calls, ["pricing_states", { p_invoice_ids: [native] }]])
    for (const user of [f.users.vendas, f.users.inactive, randomUUID()]) await assert.rejects(rpc(suffix, args, user), refused("42501"));
});

test("xml_source: dados da empresa, tipos do emissor e preferência pela série do CNPJ", async () => {
  await f.rpc("erp_company_save_identity", {
    p_user_id: f.users.admin,
    p_expected_version: 0,
    p_command_id: randomUUID(),
    p_data: {
      legal_name: "EMPRESA F2A",
      trade_name: "F2A",
      cnpj: "11222333000181",
      ie: null,
      postal_code: "13400-000",
      street: "Rua fiscal",
      number: "12",
      complement: null,
      district: "Centro",
      city: "Piracicaba",
      municipality_code: "3538709",
      state: "SP",
      phone: null,
      email: null,
    },
  });
  await seed(
    f,
    `insert into erp_fiscal_numbering.series(issuer_cnpj,cuf,model,environment,series,first_number,next_number,version,identity_version,enabled,exclusive_use_confirmed,reference,created_at)
    values('99999999000199','35','55','2',1,1,9,1,1,true,true,'teste','2026-10-01'),('11222333000181','35','55','2',1,1,33,1,1,true,true,'teste','2026-11-01')`,
  );
  const r = await rpc("xml_source", { p_id: native });
  assert.equal(r.emitter.legal_name, "EMPRESA F2A");
  assert.equal(r.emitter.document, "11222333000181");
  assert.equal(r.emitter.address.street, "Rua fiscal");
  assert.deepEqual(r.numbering, { series: 1, next_number: 33, enabled: true });
  const deleted = await invoice(f, { deleted_at: "2026-11-13", deleted_by: f.users.admin, delete_reason: "Excluída" });
  assert.equal((await rpc("get", { p_id: deleted })).writable, false);
  await assert.rejects(rpc("xml_source", { p_id: deleted }), refused("22023", "erp_fiscal_invoice_native_xml_unavailable"));
});

test("pricing: rejeita recibos incompatíveis e conta registros válidos distintos", async () => {
  const save = async (result, actor = f.users.admin) => {
    const id = randomUUID();
    await seed(f, "insert into erp_catalog.command(command_id,actor,request_hash,result) values($1,$2,$3,$4)", [
      id,
      actor,
      "d".repeat(64),
      JSON.stringify(result),
    ]);
    return id;
  };
  const base = { entity: "products", supplier_id: null, items: [{ product_id: product.id }] };
  for (const result of [
    { ...base, entity: "contacts" },
    { entity: "products", items: base.items },
    { ...base, items: {} },
    { ...base, items: [] },
    { ...base, items: [{ product_id: "bad" }] },
    { ...base, items: [{ product_id: randomUUID() }] },
    { ...base, items: [...base.items, ...base.items] },
  ]) {
    const command = await save(result);
    await assert.rejects(
      rpc("pricing_record", { p_invoice_id: purchase, p_catalog_command_id: command }),
      refused("22023", "erp_fiscal_invoice_pricing_unmatched"),
    );
  }
  const wrongActor = await save(base, f.users.fiscal);
  await assert.rejects(rpc("pricing_record", { p_invoice_id: purchase, p_catalog_command_id: wrongActor }), refused("22023"));
  const command = await save(base);
  await rpc("pricing_record", { p_invoice_id: purchase, p_catalog_command_id: command });
  assert.equal((await rpc("pricing_states", { p_invoice_ids: [purchase] })).items[0].count, 2);
  assert.equal(await f.scalar("select count(*) from erp_fiscal_invoices.invoice_pricing where invoice_id=$1", [purchase]), 2);
  for (const args of [
    { p_invoice_id: null, p_catalog_command_id: command },
    { p_invoice_id: purchase, p_catalog_command_id: null },
  ])
    await assert.rejects(rpc("pricing_record", args), refused("22023"));
});

test("espelho: XML de produção/homologação, preferência de fonte, pedidos e cobertura pendente", async () => {
  const listing = {
    direction: "1",
    number: 60,
    series: 1,
    issue_date: "2026-11-16",
    name: "XML espelhado",
    status: 6,
    total: "10",
    product_codes: [],
    contact_source_id: "contact-origin",
  };
  const k1 = key.slice(0, 40) + "2001",
    k2 = key.slice(0, 40) + "2002",
    archive1 = randomUUID(),
    archive2 = randomUUID();
  await mirror(f, "2001", listing, { access_key: k1 });
  await mirror(f, "2002", { ...listing, number: 61 }, { access_key: k2 });
  for (const [archive, id, keyValue, env] of [
    [archive1, "2001", k1, "1"],
    [archive2, "2002", k2, "2"],
  ]) {
    await seed(f, "insert into origin_fiscal.source(id,entity,source_id,access_key) values($1,'nfe',$2,$3)", [archive, id, keyValue]);
    await seed(
      f,
      `insert into erp_fiscal_mirror.xml_cache(archive_source_id,entity,source_id,access_key,xml_id,xml_hash,xml_size,environment,protocol_present,event_count,events,last_success_at)
      values($1,'nfe',$2,$3,$4,$5,125,$6,true,2,'[]','2026-11-16')`,
      [archive, id, keyValue, randomUUID(), "e".repeat(64), env],
    );
  }
  await seed(
    f,
    `insert into erp_fiscal_invoices.origin_order_link(order_source_id,invoice_source_id,order_number,order_date,contact_name,source_version,source_hash)
    values('3001','2001','7','2026-11-15','Contato do pedido',1,repeat('a',64)),('3002','2001','12','2026-11-15','Contato do pedido',1,repeat('a',64))`,
  );
  const r = await rpc("list", { p_order_number: "7" });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, "2001");
  assert.equal(r.items[0].source_environment, "1");
  assert.equal(r.items[0].event_count, 2);
  assert.deepEqual(
    r.items[0].orders.map((o) => o.number),
    ["7", "12"],
  );
  assert.equal(r.coverage.xml_count, 1);
  assert.equal(r.coverage.homologation_count, 1);
  await seed(f, "insert into erp_fiscal_mirror.xml_seed(archive_source_id) values($1)", [archive1]);
  await rpc("list");
  // Nota nativa importada em produção ganha da mesma chave no espelho.
  const id = await invoice(f, { issue_type: "S", environment: null, access_key: k1 });
  await seed(f, "insert into erp_fiscal_invoices.invoice_source(invoice_id,xml_sha256,source_environment) values($1,repeat('a',64),'1')", [id]);
  const hidden = await rpc("list", { p_query: "XML espelhado" });
  assert.equal(hidden.total_count, 0);
  assert.equal(hidden.coverage.duplicate_count, 2);
});

async function preference(page, key, value) {
  const p = await f.rpc("erp_preferences_page", { p_user_id: f.users.admin, p_page: page });
  await f.rpc("erp_preferences_save", {
    p_user_id: f.users.admin,
    p_command_id: randomUUID(),
    p_page: page,
    p_changes: [{ key, value, expected_version: p.items.find((x) => x.key === key)?.version ?? 0 }],
  });
}
test("list: vendedor nativo/espelhado e carteira; histórico fora da carteira é recusado", async () => {
  const sellerContact = await f.catalog("contacts", { name: "Vendedor F2a", person_type: "F" }),
    seller = randomUUID();
  await seed(f, "insert into erp_catalog.seller(id,contact_id,user_id,created_by,updated_by) values($1,$2,$3,$4,$4)", [
    seller,
    sellerContact.id,
    f.users.fiscal,
    f.users.admin,
  ]);
  await seed(
    f,
    `insert into erp_catalog.contact_profile(record_id,seller_id) values($1,$2) on conflict(record_id) do update set seller_id=excluded.seller_id`,
    [contact.id, seller],
  );
  await seed(f, `insert into erp_catalog.origin(entity,source_id,record_id,latest_hash,state) values('contacts','seller-contact',$1,repeat('a',64),'synced')`, [
    sellerContact.id,
  ]);
  await raw(f, "sellers", "5001", { contato: { id: "seller-contact" } });
  await seed(f, "update erp_fiscal_invoices.invoice set seller_id=$2 where id=$1", [native, seller]);
  await seed(f, `update erp_fiscal_mirror.current set payload=jsonb_set(payload,'{vendedor}','{"id":"5001"}') where source_id='m2'`);
  assert.equal((await rpc("list", { p_origin: "brufap", p_seller_id: seller })).items[0].id, native);
  assert.equal((await rpc("list", { p_seller_id: seller })).items[0].id, "m2");
  await preference("cadastros-contatos", "contatos.acesso_vendedor", true);
  try {
    const mine = await rpc("list", { p_origin: "brufap" }, f.users.fiscal);
    assert.deepEqual(new Set(mine.items.map((x) => x.id)), new Set([native, imported]));
    const visible = await rpc("list", {}, f.users.fiscal);
    assert.ok(visible.items.length > 0);
    assert.ok(visible.items.every((x) => ["m2", "m3"].includes(x.id)));
    const stranger = await f.catalog("contacts", { name: "Fora da carteira", person_type: "F" });
    await assert.rejects(
      rpc("item_history", { p_contact_id: stranger.id, p_product_id: product.id, p_direction: "1" }, f.users.fiscal),
      refused("42501", "erp_catalog_contact_not_visible"),
    );
    await rpc("item_history", { p_contact_id: contact.id, p_product_id: product.id, p_direction: "1" }, f.users.fiscal);
  } finally {
    await preference("cadastros-contatos", "contatos.acesso_vendedor", false);
  }
});

test("get/list: pedidos já vinculados, locks por efeitos e categoria das contas", async () => {
  const order = await f.rpc("erp_document_save", {
    p_user_id: f.users.admin,
    p_kind: "sales_orders",
    p_id: null,
    p_expected_version: 0,
    p_command_id: randomUUID(),
    p_body: {
      date: "2026-11-12",
      contact_id: contact.id,
      items: [{ product_id: product.id, description: "Produto", unit: "UN", quantity: "1", unit_price: "10", discount_percent: "0" }],
      installments: [],
    },
  });
  const doc = order.document?.id ?? order.id;
  await seed(f, "insert into erp_fiscal_invoices.invoice_order(invoice_id,document_id) values($1,$2)", [native, doc]);
  const n = await rpc("get", { p_id: native });
  assert.equal(n.invoice.orders[0].id, doc);
  assert.equal((await rpc("list", { p_origin: "brufap", p_order_number: n.invoice.orders[0].number })).items[0].id, native);
  await seed(
    f,
    `insert into erp_finance.document_posting(document_id,document_version,group_id,snapshot,preview_hash,actor,command_id) values($1,1,$2,'{}',repeat('a',64),$3,$4)`,
    [doc, randomUUID(), f.users.admin, randomUUID()],
  );
  await seed(
    f,
    `insert into erp_stock.document_posting(document_id,document_version,movement_id,snapshot,preview_hash,actor,command_id) values($1,1,$2,'{}',repeat('a',64),$3,$4)`,
    [doc, randomUUID(), f.users.admin, randomUUID()],
  );
  await preference("notas-nfe", "nfe.bloquear_edicao_contas", true);
  await preference("notas-nfe", "nfe.bloquear_edicao_estoque", true);
  assert.deepEqual((await rpc("get", { p_id: native })).locks, { items: true, installments: true });
  const category = randomUUID(),
    posting = randomUUID(),
    group = randomUUID(),
    title = randomUUID();
  await seed(f, "insert into erp_finance.category(id,name,kind) values($1,'Categoria F2a','receivable')", [category]);
  await seed(
    f,
    `insert into erp_finance.title(id,group_id,installment,installments,kind,contact_id,category_id,description,issued_on,due_on,competence_on,original_due_on,amount_cents)
    values($1,$2,1,1,'receivable',$3,$4,'Nota fiscal','2026-11-12','2026-11-12','2026-11-12','2026-11-12',1000)`,
    [title, group, contact.id, category],
  );
  await seed(
    f,
    `insert into erp_finance.invoice_posting(id,invoice_id,invoice_version,group_id,snapshot,preview_hash,actor,command_id)
    values($1,$2,1,$3,'{}',repeat('a',64),$4,$5)`,
    [posting, native, group, f.users.admin, randomUUID()],
  );
  await seed(f, "insert into erp_finance.invoice_title(title_id,posting_id,position) values($1,$2,1)", [title, posting]);
  assert.deepEqual(
    (await rpc("list", { p_origin: "brufap", p_category_id: category })).items.map((x) => x.id),
    [native],
  );
});
