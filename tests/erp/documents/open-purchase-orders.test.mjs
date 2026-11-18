// openPurchaseOrders (documents/public.ts, pedido da G para o F7 do Fiscal) contra o mesmo filtro
// escrito no oráculo: erp_stock.document_eligible, sem lançamento de estoque do documento inteiro,
// fora da lixeira; números como o ::text do Postgres.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { openPurchaseOrders } from "../../../src/erp/domains/documents/public.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

const ORACLE = `select coalesce(jsonb_agg(jsonb_build_object('id',d.id::text,'number',d.number::text,'version',d.version,'date',d.body->>'date','status',d.status,'total',d.total::text,
  'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id::text,'position',i.position,'product_id',i.product_id::text,'description',i.data->>'description','unit',i.data->>'unit',
    'quantity',i.quantity::text,'unit_price',i.unit_price::text) order by i.position) from erp_documents.item i where i.document_id=d.id),'[]'::jsonb))
  order by d.body->>'date',d.number,d.id::text),'[]'::jsonb) v
 from erp_documents.document d where d.kind='purchase_orders' and d.contact_id=$1 and d.deleted_at is null
  and erp_stock.document_eligible(d.kind,d.status) and not exists(select 1 from erp_stock.document_posting p where p.document_id=d.id)`;

test("pedidos de compra do fornecedor que ainda podem receber: iguais ao oráculo", async () => {
  const u = f.users;
  const supplier = (await f.catalog("contacts", { roles: ["supplier"], name: "Fornecedor F7" })).id;
  const other = (await f.catalog("contacts", { roles: ["supplier"], name: "Outro F7" })).id;
  const product = (await f.rpc("erp_catalog_save", { p_user_id: u.admin, p_entity: "products", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: { name: "Peça F7", code: "P-F7", unit: "UN", kind: "P", format: "S", price: "15" } })).record.id;
  const save = async (contact, date, items) =>
    (await f.rpc("erp_document_save", { p_user_id: u.admin, p_kind: "purchase_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: { date, contact_id: contact, items, installments: [] } })).document;
  const move = async (d, status) =>
    (await f.rpc("erp_document_transition", { p_user_id: u.admin, p_kind: "purchase_orders", p_id: d.id, p_expected_version: d.version, p_command_id: randomUUID(), p_status: status, p_reason: "Motivo F7" })).document;
  const items = [
    { product_id: product, description: "Peça F7", unit: "UN", quantity: "1.5", unit_price: "7.33", discount_percent: "0" },
    { description: "Frete avulso", unit: "SV", quantity: "2", unit_price: "10", discount_percent: "0" },
  ];
  const a = await move(await save(supplier, "2026-10-12", items), "in_progress");
  const b = await save(supplier, "2026-10-10", items); // em aberto: o recebimento ainda não aceita
  const c = await move(await move(await save(supplier, "2026-10-11", items.slice(0, 1)), "in_progress"), "partially_fulfilled");
  const d = await move(await save(supplier, "2026-10-09", items), "cancelled");
  const e = await move(await save(other, "2026-10-09", items), "in_progress");
  const g = await move(await save(supplier, "2026-10-08", items.slice(1)), "in_progress");
  await f.rpc("erp_document_trash", { p_user_id: u.admin, p_kind: "purchase_orders", p_action: "delete", p_command_id: randomUUID(), p_ids: [g.id], p_reason: "Exclusão F7" });
  for (const contact of [supplier, other, randomUUID(), null]) {
    const want = contact === null ? [] : (await f.db.query(ORACLE, [contact])).rows[0].v;
    assert.deepEqual(JSON.parse(JSON.stringify(openPurchaseOrders(f.driver, contact))), want, `fornecedor ${contact}`);
  }
  const ids = openPurchaseOrders(f.driver, supplier).map((o) => o.id);
  assert.deepEqual(ids, [c.id, a.id]);
  assert.ok(![b.id, d.id, e.id, g.id].some((id) => ids.includes(id)));
});
