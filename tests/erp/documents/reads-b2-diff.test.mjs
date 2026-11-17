// Diferencial do B2 do Documentos (sessão L: reads-list.ts e reads-b2.ts) nos
// dois motores: erp_document_list (cada filtro sozinho, ordens, cursor,
// página, busca, busca customizada, excluídos, situações próprias, totais),
// erp_document_export, _get, _situations, _occurrence_list e o frete pago
// (leitura e gravação com recibo). Dados que forçam o oráculo: documentos sem
// data e sem número na ordem DESC (NULL primeiro), excluído, situação própria
// adotada, versão de proposta, vínculo OS↔venda, lote informado no item,
// campo customizado, endereço de entrega, transportador pelo id e pelo rótulo.
// Os documentos são gravados direto no Postgres e espelhados.
//   node --test tests/erp/documents/reads-b2-diff.test.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { dualFixture } from "../harness/dual-fixture.mjs";

let f, customer, other, carrier, products, docs, situation, field, lot;
const sql = async (text, args = []) => (await f.db.query(text, args)).rows;
const outcome = async (p) => {
  try {
    return { ok: await p };
  } catch (e) {
    if (/divergem/.test(e.message)) throw e;
    return { error: e.code };
  }
};
const KINDS = ["sales_orders", "sales_proposals", "purchase_orders", "service_orders", null];

before(async () => {
  f = await dualFixture();
  const { admin } = f.users;
  customer = await f.catalog("contacts", { name: "Cliente Sintético", roles: ["customer", "supplier"] });
  other = await f.catalog("contacts", { name: "Outro Cliente", roles: ["customer", "supplier"] });
  carrier = await f.catalog("contacts", { name: "Transportadora Rápida", roles: ["carrier"] });
  products = [];
  for (const name of ["Parafuso", "Montagem", "Arruela"]) products.push((await f.catalog("products", { name })).id);
  docs = {};
  await f.db.exec("set session_replication_role = replica");
  try {
    situation = randomUUID();
    await sql("insert into erp_preferences.situation_adoption(kind,adopted_at,migration) values('sales_orders',now(),'202610200163') on conflict do nothing");
    await sql(
      "insert into erp_preferences.situation(id,kind,base_status,name,color,active,version,created_at,created_by,updated_at,updated_by,command_id) values($1,'sales_orders','open','Aguardando cliente','#336699',true,1,now(),$2,now(),$2,$3)",
      [situation, admin, randomUUID()],
    );
    field = randomUUID();
    await sql(
      "insert into erp_documents.custom_field(id,kind,field_type,name,required,width,options,active,version,created_by,updated_by,created_at,updated_at) values($1,'service_orders','integer','Horas',false,'small','[]',true,1,$2,$2,now(),now())",
      [field, admin],
    );
    lot = randomUUID();
    await sql(
      "insert into erp_stock.lot(id,product_id,code,active,version,created_at,created_by,updated_at,updated_by,command_id) values($1,$2,'LOTE-A',true,1,now(),$3,now(),$3,$4)",
      [lot, products[0], admin, randomUUID()],
    );
    let n = 0;
    const doc = async (name, kind, contact, body, extra = {}) => {
      const id = randomUUID();
      docs[name] = id;
      n++;
      await sql(
        `insert into erp_documents.document(id,kind,number,version,status,contact_id,total,contact_snapshot,body,created_by,updated_by,created_at,updated_at,origin,authority,source_proposal_id,deleted_at,deleted_by,delete_reason,warehouse_id)
         values($1,$2,$3,2,$4,$5,$6,$7,$8,$9,$9,now(),now(),'brufap','brufap',$10,$11,$12,$13,null)`,
        [id, kind, extra.number === undefined ? n : extra.number, extra.status ?? "open", contact, extra.total ?? "10.00",
          JSON.stringify({ name: extra.name ?? "Cliente Sintético", email: "Cliente@Exemplo.com", city: "São Paulo", state: "sp", district: "Centro", postal_code: "01001-000", phone: "", mobile: "1199", document: "529.982.247-25", code: "C-1" }),
          JSON.stringify(body), admin, extra.source ?? null, extra.deleted ? new Date() : null, extra.deleted ? admin : null, extra.deleted ? "excluído no teste" : null],
      );
      for (const [pos, prod, data] of extra.items ?? [[1, products[0], { description: "Parafuso", code: "P1", unit: "UN" }]])
        await sql("insert into erp_documents.item(id,document_id,position,product_id,quantity,unit_price,total,data) values($1,$2,$3,$4,1,'10',10,$5)", [randomUUID(), id, pos, prod, JSON.stringify(data)]);
      return id;
    };
    await doc("a", "sales_orders", customer.id, {
      date: "2026-10-05", expected_date: "2026-10-20", ship_date: "2026-10-21", customer_po_number: "PO-77", seller_id: randomUUID(),
      carrier_id: carrier.id, delivery_address: { street: "Rua da Entrega", number: "5", city: "Campinas", state: "SP", postal_code: "13000000" },
      commercial: { transport: { tracking_code: "BR123", carrier_reference: { label: "Correios" } } }, totals: { discount: "1.50", freight: "2" }, internal_notes: "Nota interna longa",
    }, { items: [[1, products[0], { description: "Parafuso", lots: [{ lot_id: lot, quantity: "1" }] }], [2, null, { description: "Livre" }]] });
    await doc("b", "sales_orders", other.id, { date: "2026-10-05" }, { total: null, name: "Outro Cliente" });
    await doc("nodate", "sales_orders", customer.id, {}, { number: 999 });
    await doc("del", "sales_orders", customer.id, { date: "2026-10-07" }, { deleted: true });
    await doc("cancel", "sales_orders", customer.id, { date: "2026-10-08" }, { status: "cancelled" });
    await doc("p1", "sales_proposals", customer.id, { date: "2026-10-01", template: true, template_name: "Modelo", next_contact: "2026-11-01" });
    await doc("p2", "sales_proposals", customer.id, { date: "2026-10-02", template: "true" });
    await doc("os", "service_orders", customer.id, { date: "2026-10-03", technician: "Ana", equipment: "Furadeira", serial_number: "SN-1", warranty_days: 30, finish_date: "2026-10-10", custom_fields: { [field]: "12" } });
    await doc("po", "purchase_orders", other.id, { date: "2026-10-04", order_reference: "REF-9", internal_notes: "compra" });
    await sql("insert into erp_documents.document_situation(document_id,kind,situation_id,base_status,actor,command_id,set_at) values($1,'sales_orders',$2,'open',$3,$4,now())", [docs.a, situation, admin, randomUUID()]);
    await sql("insert into erp_documents.proposal_version(document_id,base_id,version_seq,source_id,created_by,created_at) values($1,$2,2,$2,$3,now())", [docs.p2, docs.p1, admin]);
    await sql("insert into erp_documents.sales_service_link(sales_order_id,service_order_id,actor,command_id,created_at) values($1,$2,$3,$4,now())", [docs.a, docs.os, admin, randomUUID()]);
    for (const [seq, before, afterS] of [[1, "open", "in_progress"], [2, "in_progress", null]])
      await sql(
        "insert into erp_documents.occurrence(id,document_id,sequence,occurred_on,occurred_time,text,status_before,status_after,actor_id,actor_role,command_id,document_version,recorded_at) values($1,$2,$3,'2026-10-04','10:00','Nota',$4,$5,$6,'admin',$7,1,now())",
        [randomUUID(), docs.a, seq, before, afterS, admin, randomUUID()],
      );
  } finally {
    await f.db.exec("set session_replication_role = origin");
  }
  await f.sync();
});
after(async () => f?.close());

const list = (args, user = f.users.admin) => outcome(f.rpc("erp_document_list", { p_user_id: user, p_kind: "sales_orders", ...args }));

test("listagem: cada filtro, ordens, cursor, página, busca e busca customizada", async () => {
  for (const user of [...Object.values(f.users), null]) for (const kind of KINDS) await list({ p_kind: kind }, user);
  for (const order of ["id", "date_desc", "date_asc", "number_desc", "number_asc", "x"])
    for (const [limit, page] of [[2, null], [2, 2], [100, null], [0, null], [2, 0]]) await list({ p_order: order, p_limit: limit, p_page: page });
  const first = await f.rpc("erp_document_list", { p_user_id: f.users.admin, p_kind: "sales_orders", p_order: "date_desc", p_limit: 1 });
  for (const order of ["id", "date_desc", "date_asc", "number_desc", "number_asc"]) {
    await list({ p_order: order, p_limit: 1, p_after: first.items[0].id });
    await list({ p_order: order, p_limit: 1, p_after: docs.nodate });
    await list({ p_order: order, p_limit: 1, p_after: randomUUID() });
  }
  const filters = [
    { p_status: "open" }, { p_statuses: ["open", "cancelled"] }, { p_statuses: ["deleted"] }, { p_statuses: ["x"] }, { p_statuses: [] }, { p_status: "open", p_statuses: ["open"] },
    { p_situations: [situation] }, { p_situations: ["open"] }, { p_situations: ["nada"] }, { p_query: "sintético" }, { p_query: "52998" }, { p_query: "529.98" }, { p_query: "1" },
    { p_query: docs.a }, { p_query: "a\u0001" }, { p_date_from: "2026-10-05" }, { p_date_to: "2026-10-04" }, { p_date_from: "2026-10-06", p_date_to: "2026-10-01" },
    { p_date_from: "2026-02-30" }, { p_date_type: "expected_date", p_date_from: "2026-10-01" }, { p_date_type: "ship_date", p_date_to: "2026-12-31" },
    { p_date_type: "next_contact", p_date_from: "2026-01-01" }, { p_city: "paulo" }, { p_city: "  " }, { p_state: "SP" }, { p_state: "sp" }, { p_postal_code: "0100" },
    { p_postal_code: "1300" }, { p_district: "centro" }, { p_tracking_code: "br1" }, { p_customer_po_number: "po-7" }, { p_carrier: "rápida" }, { p_carrier: "correios" },
    { p_seller_id: randomUUID() }, { p_component_id: randomUUID() }, { p_product_id: products[0] }, { p_warehouse_id: randomUUID() }, { p_lots: ["lote-a"] }, { p_lots: [] },
    { p_custom: [{ field: "contact_name", op: "contains", value: "sint" }] }, { p_custom: [{ field: "total", op: "ge", value: "10" }] },
    { p_custom: [{ field: "date", op: "empty", value: null }] }, { p_custom: [{ field: "number", op: "empty", value: null }] }, { p_custom: [{ field: "x", op: "eq", value: "1" }] },
    { p_custom: [] }, { p_origin: "brufap" }, { p_origin: "origin" }, { p_origin: "x" }, { p_technician: "ana" }, { p_contact_email: "a" }, { p_template: true },
  ];
  for (const filter of filters) await list(filter);
  for (const [kind, filter] of [
    ["service_orders", { p_technician: "ana" }], ["service_orders", { p_equipment: "fura" }], ["service_orders", { p_serial_number: "sn" }], ["service_orders", { p_date_type: "warranty_until", p_date_from: "2026-11-01" }],
    ["service_orders", { p_date_type: "finish_date", p_date_to: "2026-10-31" }], ["service_orders", { p_custom: [{ field: `custom:${field}`, op: "gt", value: "10" }] }],
    ["service_orders", { p_query: "01001" }], ["sales_proposals", { p_template: true }], ["sales_proposals", { p_template: false }], ["sales_proposals", { p_contact_email: "exemplo" }],
    ["purchase_orders", { p_internal_note: "COMPRA" }], ["purchase_orders", { p_query: "ref-9" }], [null, { p_status: "open" }], [null, { p_statuses: ["nada"] }],
  ])
    await list({ p_kind: kind, ...filter });
  const all = await f.rpc("erp_document_list", { p_user_id: f.users.admin, p_kind: "sales_orders", p_order: "date_desc", p_limit: 100 });
  assert.equal(all.items[0].id, docs.nodate, "sem data vem primeiro no DESC");
});

test("exportação, documento, situações, ocorrências e frete pago", async () => {
  for (const kind of KINDS)
    for (const [from, to, page] of [["2026-10-01", "2026-10-31", 1], ["2026-10-01", "2026-10-31", 2], ["2026-10-31", "2026-10-01", 1], ["2025-01-01", "2026-10-31", 1], ["2026-1-1", "2026-10-31", 1], ["2026-10-01", "2026-10-31", 0]])
      await outcome(f.rpc("erp_document_export", { p_user_id: f.users.admin, p_kind: kind, p_date_from: from, p_date_to: to, p_page: page }));
  for (const user of [...Object.values(f.users), null]) {
    for (const kind of KINDS) {
      await outcome(f.rpc("erp_document_situations", { p_user_id: user, p_kind: kind }));
      for (const id of [docs.a, docs.p2, docs.os, randomUUID(), null]) {
        await outcome(f.rpc("erp_document_get", { p_user_id: user, p_kind: kind, p_id: id }));
        await outcome(f.rpc("erp_document_occurrence_list", { p_user_id: user, p_kind: kind, p_document_id: id }));
      }
    }
    await outcome(f.rpc("erp_document_freight_paid_get", { p_user_id: user, p_kind: "sales_orders", p_document_id: docs.a }));
  }
  const save = (data, version, command = randomUUID(), user = f.users.admin, id = docs.a) =>
    outcome(f.rpc("erp_document_freight_paid_save", { p_user_id: user, p_kind: "sales_orders", p_document_id: id, p_expected_version: version, p_command_id: command, p_data: data }));
  const cmd = randomUUID();
  await save({ amount: "12.5", note: " Transportadora " }, 0, cmd);
  await save({ amount: "12.5", note: " Transportadora " }, 0, cmd);
  await save({ amount: "13", note: null }, 0, cmd);
  await save({ amount: "13", note: null }, 0);
  await save({ amount: "13", note: null }, 1);
  for (const data of [{ amount: null, note: null }, { amount: "1.234", note: null }, { amount: 1, note: null }, { amount: "1" }, { amount: "1", note: "x", y: 1 }, { amount: "1", note: "a\u0001" }, [], null])
    await save(data, 2);
  await save({ amount: null, note: null }, 0, randomUUID(), f.users.admin, docs.b);
  for (const user of [f.users.vendas, f.users.consulta, f.users.estoque, null]) await save({ amount: "1", note: null }, 2, randomUUID(), user);
  const r = await f.rpc("erp_document_freight_paid_get", { p_user_id: f.users.admin, p_kind: "sales_orders", p_document_id: docs.a });
  assert.equal(r.item.freight_paid, "13.00");
});
