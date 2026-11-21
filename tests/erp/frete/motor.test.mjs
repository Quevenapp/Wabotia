// Frete da expedição no motor (src/erp/domains/shipping/freight.ts): a leitura
// do pedido para cotar e contratar (remetente, destinatário, volumes, itens,
// valor declarado e se o frete ainda pode mudar) e a gravação no pedido do
// valor do frete e do prazo (pelo salvamento do próprio pedido) e do código de
// rastreio (na situação do pedido na expedição). Sem rede: motor SQLite da
// fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE, com1Fixture } from "../comnfe/fixtures.mjs";

const code = (c) => (e) => e.code === c || e.message === c || String(e.message).startsWith(`${c}:`);
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];

function freight(t) {
  const f = com1Fixture(t);
  f.warehouse = f.catalog("warehouses", { name: "Depósito do frete" });
  f.item = f.catalog("products", { name: "Caneca de cerâmica", code: "CAN-1", unit: "UN", kind: "P", format: "S", price: "30.00", net_weight: "0.350", gross_weight: "0.400" });
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo inicial do frete", p_reference: null,
    p_items: [{ product_id: f.item.id, warehouse_id: f.warehouse.id, quantity: "50", expected_version: 0 }] });
  f.newOrder = (extra = {}) => f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: COM1_DATE, contact_id: f.customer.id, warehouse_id: f.warehouse.id, installments: [],
    items: [{ product_id: f.item.id, description: f.item.name, unit: "UN", quantity: "2", unit_price: "30.00", discount_percent: "0" }], ...extra,
  } }).document;
  f.read = (args, env) => f.rpc("erp_shipping_freight_context", { p_args: args }, env);
  f.write = (name, args, env, command = randomUUID()) => f.rpc(name, { p_command_id: command, p_args: args }, env);
  f.packed = (extra) => {
    const order = f.newOrder(extra);
    const list = f.write("erp_shipping_pick_create", { document_ids: [order.id] });
    let view = list;
    for (const r of list.rows) view = f.rpc("erp_shipping_pick_mark", { p_args: { list_id: list.list.id, expected_version: view.list.version, key: r.key, picked: r.quantity } });
    f.write("erp_shipping_pick_finish", { list_id: list.list.id, expected_version: view.list.version });
    const detail = f.rpc("erp_shipping_order_get", { p_args: { id: order.id } });
    f.write("erp_shipping_pack", { document_id: order.id, expected_version: detail.order.version,
      volumes: [{ length_cm: "20", width_cm: "15", height_cm: "10", gross_kg: "0,900", items: detail.lines.map((l) => ({ key: l.key, quantity: l.quantity })) }] });
    return order;
  };
  return f;
}

test("leitura para cotar: remetente, destinatário, volumes, itens e valor declarado sem o frete", (t) => {
  const f = freight(t);
  const order = f.packed({ freight: "10.00" });
  const ctx = f.read({ id: order.id });
  assert.equal(ctx.scope, "shipping_freight_context");
  assert.equal(ctx.order.ship_status, "packed");
  assert.equal(ctx.order.freight, "10.00");
  assert.equal(ctx.order.declared_cents, "6000", "o valor declarado é o pedido sem o frete");
  assert.equal(ctx.order.freight_editable, true);
  assert.equal(ctx.volumes.length, 1);
  assert.deepEqual([ctx.volumes[0].length_mm, ctx.volumes[0].width_mm, ctx.volumes[0].height_mm, ctx.volumes[0].gross_weight_g], [200, 150, 100, 900]);
  assert.equal(ctx.items[0].description, "Caneca de cerâmica");
  assert.ok(ctx.sender.name);
  assert.ok(ctx.recipient.name);
  assert.equal(ctx.invoice, null);
  assert.throws(() => f.read({ id: order.id, outro: 1 }), code("erp_shipping_invalid"));
  assert.throws(() => f.read({ id: randomUUID() }), code("erp_shipping_order_not_found"));
});

test("gravar o frete escolhido: valor e prazo pelo salvamento do pedido, com recibo", (t) => {
  const f = freight(t);
  const order = f.packed();
  const command = randomUUID();
  const done = f.write("erp_shipping_freight_apply", { document_id: order.id, freight: "23.5", delivery_days: "4" }, undefined, command);
  assert.equal(done.freight_written, true);
  assert.equal(done.replayed, false);
  const saved = row(f, 'SELECT body, total, version FROM "erp_documents__document" WHERE id=?', order.id);
  const body = JSON.parse(saved.body);
  assert.equal(body.freight, "23.50");
  assert.equal(body.totals.total, "83.50");
  assert.equal(String(saved.total), "8350");
  assert.equal(body.commercial.transport.delivery_days, "4");
  // Repetir o mesmo comando devolve o mesmo resultado, sem salvar de novo.
  const again = f.write("erp_shipping_freight_apply", { document_id: order.id, freight: "23.5", delivery_days: "4" }, undefined, command);
  assert.equal(again.replayed, true);
  assert.equal(row(f, 'SELECT version FROM "erp_documents__document" WHERE id=?', order.id).version, saved.version);
  // Os itens do pedido continuam os mesmos.
  assert.equal(f.db.exec('SELECT count(*) n FROM "erp_documents__item" WHERE document_id=?', order.id).rows[0].n, 1);
});

test("o pedido que não aceita outro frete recusa com o motivo, sem mudar nada", (t) => {
  const f = freight(t);
  const noFreight = f.packed({ commercial: { introduction: null, attention_to: null, seller_reference: null, store_reference: null, business_unit_reference: null,
    transport: { freight_mode: "9", volume_count: null, gross_weight: null, delivery_days: null, carrier_reference: null, service_reference: null, tracking_code: null } } });
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: noFreight.id, freight: "10.00" }), code("erp_shipping_freight_no_freight"));
  const withInstallments = f.packed({ installments: [{ due_date: COM1_DATE, amount: "60.00", method: "pix" }] });
  assert.equal(f.read({ id: withInstallments.id }).order.freight_block, "erp_shipping_freight_installments");
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: withInstallments.id, freight: "10.00" }), code("erp_shipping_freight_installments"));
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: withInstallments.id, freight: "dez" }), code("erp_shipping_freight_value"));
  assert.equal(JSON.parse(row(f, 'SELECT body FROM "erp_documents__document" WHERE id=?', withInstallments.id).body).freight, "0.00");
});

test("rastreio no pedido: grava e apaga sem mudar a situação na expedição; o papel consulta não grava", (t) => {
  const f = freight(t);
  const order = f.packed();
  const put = f.write("erp_shipping_freight_apply", { document_id: order.id, tracking_code: "AB123456789BR" });
  assert.equal(put.tracking_written, true);
  assert.equal(put.order.tracking_code, "AB123456789BR");
  assert.equal(put.order.status, "packed");
  assert.equal(f.rpc("erp_shipping_labels", { p_args: { document_ids: [order.id] } }).labels[0].tracking_code, "AB123456789BR");
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: order.id, tracking_code: "com espaço" }), code("erp_shipping_freight_tracking"));
  const cleared = f.write("erp_shipping_freight_apply", { document_id: order.id, clear_tracking: true });
  assert.equal(cleared.order.tracking_code, null);
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: order.id, tracking_code: "AB123456789BR" }, { role: "consulta" }), code("erp_shipping_role_denied"));
});

test("parte Expedição desligada: as duas recusam antes de ler", (t) => {
  const f = freight(t);
  const order = f.packed();
  const off = { parts: { shipping: false } };
  assert.throws(() => f.read({ id: order.id }, off), (e) => e.code === "module_disabled");
  assert.throws(() => f.write("erp_shipping_freight_apply", { document_id: order.id, tracking_code: "AB123456789BR" }, off), (e) => e.code === "module_disabled");
});
