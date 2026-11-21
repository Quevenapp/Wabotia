// Expedição (Wabotia, sem função no oráculo; parte erp-expedicao, versão 25):
// separação consolidada de vários pedidos, marcação dividida entre os pedidos,
// pendência e ocorrência no pedido quando falta, embalagens e volumes com
// pesos, transporte do pedido com Fiscal ligado, expedição, etiquetas,
// romaneio, entrega local, devolução física com entrada no estoque e parte
// desligada recusando antes de ler. Sem rede: motor SQLite da fatia comercial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COM1_DATE, com1Fixture } from "../comnfe/fixtures.mjs";
import { ERP_PART_DEPENDENCIES, ERP_PART_NAMES, erpPartOffMessage, erpRequirement, normalizeErpParts } from "../../../src/erp/parts.ts";
import { consolidate, distribute, cmToMm, kgToGrams, lineGrams, rowForCode, volumeWeights, volumeBarcode, scaled6 } from "../../../src/erp/domains/shipping/model.ts";

const code = (c) => (e) => e.code === c || e.message === c || String(e.message).startsWith(`${c}:`);
const disabled = (e) => e.code === "module_disabled";
const row = (f, sql, ...args) => f.db.exec(sql, ...args).rows[0];

function shipping(t, options = {}) {
  const f = com1Fixture(t, options);
  f.warehouse = f.catalog("warehouses", { name: "Depósito da expedição" });
  f.screw = f.catalog("products", { name: "Parafuso sextavado", code: "PAR-1", unit: "UN", kind: "P", format: "S", price: "2.00", gtin: "7891234567895",
    location: "A-01", net_weight: "0.050", gross_weight: "0.060" });
  f.box = f.catalog("products", { name: "Caixa de ferramentas", code: "CX-9", unit: "UN", kind: "P", format: "S", price: "80.00", location: "B-07", net_weight: "1.500" });
  f.carrier = f.rpc("erp_catalog_contact_save", { p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_data: {
    name: "Transportes do Ensaio", person_type: "J", document: "11444777000161", roles: ["carrier"], postal_code: "01001000", street: "Rua A", number: "1",
    district: "Sé", city: "São Paulo", state: "SP" }, p_acknowledged: null }).record;
  f.rpc("erp_stock_post", { p_command_id: randomUUID(), p_kind: "receipt", p_occurred_on: COM1_DATE, p_reason: "Saldo inicial da expedição", p_reference: null,
    p_items: [{ product_id: f.screw.id, warehouse_id: f.warehouse.id, quantity: "100", expected_version: 0 }, { product_id: f.box.id, warehouse_id: f.warehouse.id, quantity: "10", expected_version: 0 }] });
  f.newOrder = (items, extra = {}) => f.rpc("erp_document_save", { p_kind: "sales_orders", p_id: null, p_expected_version: 0, p_command_id: randomUUID(), p_body: {
    date: COM1_DATE, contact_id: f.customer.id, warehouse_id: f.warehouse.id, installments: [], ...extra,
    items: items.map(([product, quantity]) => ({ product_id: product.id, description: product.name, unit: "UN", quantity, unit_price: "1.00", discount_percent: "0" })),
  } }).document;
  const save = f.newOrder;
  // O salvamento devolve o número em texto; a expedição devolve número.
  f.newOrder = (items, extra) => { const d = save(items, extra); return { ...d, number: Number(d.number) }; };
  f.ship = (name, args, env) => f.rpc(name, { p_args: args }, env);
  f.write = (name, args, env) => f.rpc(name, { p_command_id: randomUUID(), p_args: args }, env);
  return f;
}
const rowOf = (list, description) => list.rows.find((r) => r.description === description);

test("contas puras: unidades, pesos, soma por endereço e divisão do separado", () => {
  assert.equal(cmToMm("30,5"), 305);
  assert.equal(cmToMm("0"), undefined);
  assert.equal(kgToGrams("1,250"), 1250);
  assert.equal(kgToGrams("abc"), undefined);
  assert.equal(lineGrams(scaled6("3"), scaled6("0.050")), 150);
  assert.deepEqual(volumeWeights([{ quantity: scaled6("3"), net_kg6: scaled6("0.050"), gross_kg6: scaled6("0.060") }, { quantity: scaled6("1"), net_kg6: null, gross_kg6: null }], 200, null),
    { net_g: 150, gross_g: 380, computed_gross_g: 380, items_without_weight: 1 });
  assert.equal(volumeWeights([], 200, 5000).gross_g, 5000, "o bruto da balança vence a conta");
  const line = (number, quantity, location = "A-01") => ({ id: `${number}`, document_id: `d${number}`, number, product_id: "p", warehouse_id: "w", location, description: "Parafuso", code: null, gtin: "789", unit: "UN", quantity: scaled6(quantity), picked: 0n });
  const rows = consolidate([line(2, "3"), line(1, "2"), { ...line(3, "1", null), product_id: "q", description: "Arruela" }]);
  assert.deepEqual(rows.map((r) => [r.description, String(r.quantity), r.orders.map((o) => o.number)]), [["Parafuso", "5000000", [1, 2]], ["Arruela", "1000000", [3]]]);
  assert.deepEqual(distribute([{ number: 2, quantity: scaled6("3") }, { number: 1, quantity: scaled6("2") }], scaled6("4")).map(String), ["2000000", "2000000"]);
  assert.equal(rowForCode(rows, " 789 ").description, "Parafuso");
  assert.equal(volumeBarcode(123, 2), "PV000123-02");
});

test("parte nova: Expedição depende de Vendas e Estoque e diz o que ligar", () => {
  assert.deepEqual([...ERP_PART_DEPENDENCIES["erp-expedicao"]], ["erp-vendas", "erp-estoque"]);
  assert.equal(ERP_PART_NAMES["erp-expedicao"], "Expedição");
  assert.deepEqual([...erpRequirement("erp-expedicao").all].sort(), ["erp", "erp-estoque", "erp-expedicao", "erp-produtos", "erp-vendas"]);
  const off = erpPartOffMessage("erp-expedicao", erpRequirement("erp-expedicao"), { erp: true, "erp-produtos": true, "erp-vendas": true, "erp-estoque": false, "erp-expedicao": false });
  assert.match(off, /Expedição, que está desligado/);
  assert.match(off, /depende de Estoque/);
});

test("separação consolidada: soma por produto e endereço, divide o separado e a falta vira pendência e ocorrência", (t) => {
  const f = shipping(t);
  const a = f.newOrder([[f.screw, "3"], [f.box, "1"]], { carrier_id: f.carrier.id });
  const b = f.newOrder([[f.screw, "2"]], { carrier_id: f.carrier.id });
  const overview = f.ship("erp_shipping_overview", { status: "to_pick", carrier_id: f.carrier.id });
  assert.deepEqual(overview.items.map((o) => o.number).sort(), [a.number, b.number].sort());
  assert.equal(overview.items[0].status_label, "A separar");

  const list = f.write("erp_shipping_pick_create", { document_ids: [a.id, b.id], filters: { carrier_id: f.carrier.id } });
  const screw = rowOf(list, "Parafuso sextavado");
  assert.equal(screw.quantity, "5.000000");
  assert.equal(screw.location, "A-01");
  assert.equal(screw.gtin, "7891234567895");
  assert.deepEqual(screw.orders.map((o) => o.number), [a.number, b.number].sort((x, y) => x - y));
  assert.equal(f.ship("erp_shipping_overview", { status: "picking" }).items.length, 2);
  // O mesmo pedido não entra em duas listas.
  assert.throws(() => f.write("erp_shipping_pick_create", { document_ids: [a.id] }), code("erp_shipping_orders_unavailable"));

  // Marca 4 de 5 parafusos (o mais antigo recebe primeiro) e a caixa inteira.
  let view = f.ship("erp_shipping_pick_mark", { list_id: list.list.id, expected_version: list.list.version, key: screw.key, picked: "4" });
  assert.throws(() => f.ship("erp_shipping_pick_mark", { list_id: list.list.id, expected_version: list.list.version, key: screw.key, picked: "4" }), code("erp_shipping_version_conflict"));
  assert.throws(() => f.ship("erp_shipping_pick_mark", { list_id: list.list.id, expected_version: view.list.version, key: screw.key, picked: "6" }), code("erp_shipping_pick_over"));
  view = f.ship("erp_shipping_pick_mark", { list_id: list.list.id, expected_version: view.list.version, key: rowOf(view, "Caixa de ferramentas").key, picked: "1" });
  assert.deepEqual(rowOf(view, "Parafuso sextavado").orders.map((o) => o.picked), ["3.000000", "1.000000"]);

  const done = f.write("erp_shipping_pick_finish", { list_id: list.list.id, expected_version: view.list.version });
  assert.equal(done.list.status, "done");
  assert.deepEqual(done.pending.map((p) => [p.number, p.missing]), [[b.number, "1.000000"]]);
  const occurrence = row(f, 'SELECT text, status_after FROM "erp_documents__occurrence" WHERE document_id=? ORDER BY sequence DESC LIMIT 1', b.id);
  assert.match(occurrence.text, /faltou 1 UN de Parafuso sextavado/);
  assert.equal(occurrence.status_after, null, "a situação comercial do pedido não muda");
  assert.equal(row(f, 'SELECT status FROM "erp_documents__document" WHERE id=?', b.id).status, b.status);
  const detail = f.ship("erp_shipping_order_get", { id: b.id });
  assert.equal(detail.order.status, "picked");
  assert.equal(detail.pending[0].status, "open");
  f.write("erp_shipping_pending_resolve", { id: detail.pending[0].id, note: "Cliente aceitou receber depois" });
  assert.equal(f.ship("erp_shipping_order_get", { id: b.id }).pending[0].status, "resolved");
});

test("volumes, transporte do pedido com Fiscal, expedição, etiquetas, romaneio e entrega local", (t) => {
  const f = shipping(t);
  const order = f.newOrder([[f.screw, "10"], [f.box, "1"]]);
  const list = f.write("erp_shipping_pick_create", { document_ids: [order.id] });
  let view = list;
  for (const r of list.rows) view = f.ship("erp_shipping_pick_mark", { list_id: list.list.id, expected_version: view.list.version, key: r.key, picked: r.quantity });
  f.write("erp_shipping_pick_finish", { list_id: list.list.id, expected_version: view.list.version });
  const pkg = f.write("erp_shipping_package_save", { name: "Caixa média", length_cm: "40", width_cm: "30", height_cm: "20,5", empty_weight_kg: "0,300" }).record;
  assert.deepEqual([pkg.length_mm, pkg.height_mm, pkg.empty_weight_g], [400, 205, 300]);

  const detail = f.ship("erp_shipping_order_get", { id: order.id });
  const key = (d) => detail.lines.find((l) => l.description === d).key;
  // Pedido ainda não embalado não expede.
  assert.throws(() => f.write("erp_shipping_ship", { document_ids: [order.id] }), code("erp_shipping_not_packed"));
  assert.throws(() => f.write("erp_shipping_pack", { document_id: order.id, expected_version: detail.order.version, volumes: [{ items: [{ key: key("Parafuso sextavado"), quantity: "11" }] }] }),
    code("erp_shipping_volume_exceeds"));
  const packed = f.write("erp_shipping_pack", { document_id: order.id, expected_version: detail.order.version, volumes: [
    { package_id: pkg.id, items: [{ key: key("Parafuso sextavado"), quantity: "10" }] },
    { length_cm: "50", width_cm: "40", height_cm: "30", items: [{ key: key("Caixa de ferramentas"), quantity: "1" }] },
  ] });
  // Parafusos: 10 × 50 g líquido, 10 × 60 g + 300 g da caixa bruto; caixa de ferramentas: 1,5 kg (sem bruto no cadastro).
  assert.deepEqual(packed.volumes.map((v) => [v.number, v.net_weight_g, v.gross_weight_g, v.length_mm]), [[1, 500, 900, 400], [2, 1500, 1500, 500]]);
  assert.deepEqual(packed.totals, { volumes: 2, net_weight_g: 2000, gross_weight_g: 2400 });
  assert.deepEqual(packed.transport, { written: true, reason: null });
  const transport = JSON.parse(row(f, 'SELECT body FROM "erp_documents__document" WHERE id=?', order.id).body).commercial.transport;
  assert.deepEqual([transport.volume_count, transport.gross_weight], ["2.000000", "2.400000"]);
  assert.equal(packed.order.status, "packed");

  const shipped = f.write("erp_shipping_ship", { document_ids: [order.id], tracking_code: "BR123" });
  assert.deepEqual(shipped.shipped, [order.number]);
  const labels = f.ship("erp_shipping_labels", { document_ids: [order.id] });
  assert.deepEqual(labels.labels.map((l) => [l.volume, l.volumes, l.barcode]), [[1, 2, `PV${String(order.number).padStart(6, "0")}-01`], [2, 2, `PV${String(order.number).padStart(6, "0")}-02`]]);
  assert.equal(labels.labels[0].recipient.city, "São Paulo");
  assert.equal(labels.sender.name, "Ensaio Comercial");
  const manifest = f.ship("erp_shipping_manifest", { from: COM1_DATE, to: COM1_DATE });
  assert.equal(manifest.carriers.length, 1);
  assert.deepEqual(manifest.carriers[0].orders.map((o) => [o.number, o.volumes, o.gross_weight_g, o.tracking_code]), [[order.number, 2, 2400, "BR123"]]);

  // Sem transportadora: entrega própria, vira entrega do módulo Entrega uma vez.
  const prepared = f.ship("erp_shipping_delivery_prepare", { document_id: order.id });
  assert.equal(prepared.entrega.label, `Pedido ${order.number}`);
  assert.equal(prepared.entrega.address.postal_code, "01001000");
  f.ship("erp_shipping_delivery_record", { document_id: order.id, delivery_id: "entrega-1" });
  assert.throws(() => f.ship("erp_shipping_delivery_record", { document_id: order.id, delivery_id: "entrega-2" }), code("erp_shipping_delivery_exists"));
  assert.equal(f.ship("erp_shipping_order_get", { id: order.id }).order.delivery_id, "entrega-1");
});

test("Fiscal desligado: volumes não mexem no pedido; com transportadora não há entrega local", (t) => {
  const f = shipping(t);
  const order = f.newOrder([[f.box, "2"]], { carrier_id: f.carrier.id });
  const noFiscal = { parts: { fiscal: false } };
  const list = f.write("erp_shipping_pick_create", { document_ids: [order.id] }, noFiscal);
  f.write("erp_shipping_pick_finish", { list_id: list.list.id, expected_version: list.list.version }, noFiscal);
  const detail = f.ship("erp_shipping_order_get", { id: order.id }, noFiscal);
  const packed = f.write("erp_shipping_pack", { document_id: order.id, expected_version: detail.order.version, volumes: [{ items: [{ key: detail.lines[0].key, quantity: "1" }] }] }, noFiscal);
  assert.deepEqual(packed.transport, { written: false, reason: "fiscal_off" });
  assert.deepEqual(packed.unpacked.map((u) => u.missing), ["1.000000"]);
  assert.equal(packed.emission, null);
  f.write("erp_shipping_ship", { document_ids: [order.id] }, noFiscal);
  assert.throws(() => f.ship("erp_shipping_delivery_prepare", { document_id: order.id }, noFiscal), code("erp_shipping_delivery_not_own"));
});

test("devolução física: volta ao estoque entra por um recebimento; avariado e descarte não", (t) => {
  const f = shipping(t);
  const order = f.newOrder([[f.screw, "5"], [f.box, "2"]]);
  const detail = f.ship("erp_shipping_order_get", { id: order.id });
  const key = (d) => detail.lines.find((l) => l.description === d).key;
  const before = Number(row(f, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', f.screw.id, f.warehouse.id).q);
  const made = f.write("erp_shipping_return_create", { document_id: order.id, reason: "Cliente devolveu na entrega", items: [
    { key: key("Parafuso sextavado"), quantity: "2", condition: "restock" },
    { key: key("Caixa de ferramentas"), quantity: "1", condition: "damaged" },
    { key: key("Parafuso sextavado"), quantity: "1", condition: "discard" },
  ] });
  assert.ok(made.return.movement_id);
  const after = Number(row(f, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?', f.screw.id, f.warehouse.id).q);
  assert.equal(after - before, 2_000_000, "só o que volta ao estoque entra");
  assert.equal(row(f, 'SELECT kind FROM "erp_stock__movement" WHERE id=?', made.return.movement_id).kind, "receipt");
  assert.equal(made.emission, null, "sem nota, sem atalho para a devolução fiscal");
  assert.deepEqual(made.return.items.map((i) => i.condition_label), ["Volta ao estoque", "Avariado", "Descarte"]);
  // Não devolve mais do que o pedido teve (5 parafusos: 3 já voltaram).
  assert.throws(() => f.write("erp_shipping_return_create", { document_id: order.id, reason: "Outra volta", items: [{ key: key("Parafuso sextavado"), quantity: "3", condition: "restock" }] }),
    code("erp_shipping_return_exceeds"));
  const again = f.ship("erp_shipping_order_get", { id: order.id });
  assert.equal(again.lines.find((l) => l.description === "Parafuso sextavado").returned, "3.000000");
  assert.equal(again.returns.length, 1);
});

test("parte desligada recusa antes de ler; consulta não mexe; papel consulta não grava", (t) => {
  const f = shipping(t);
  const order = f.newOrder([[f.box, "1"]]);
  for (const parts of [{ shipping: false }, { stock: false }, { sales: false }])
    assert.throws(() => f.ship("erp_shipping_overview", {}, { parts }), disabled);
  assert.throws(() => f.write("erp_shipping_pick_create", { document_ids: [order.id] }, { parts: { shipping: false } }), disabled);
  assert.equal(normalizeErpParts({ shipping: false }).shipping, false);
  const reader = { role: "consulta" };
  assert.ok(f.ship("erp_shipping_overview", {}, reader).items.length >= 1);
  assert.throws(() => f.write("erp_shipping_pick_create", { document_ids: [order.id] }, reader), code("erp_shipping_role_denied"));
  // Repetir o mesmo comando devolve o mesmo resultado, sem lista nova.
  const command = randomUUID();
  const first = f.rpc("erp_shipping_pick_create", { p_command_id: command, p_args: { document_ids: [order.id] } });
  const again = f.rpc("erp_shipping_pick_create", { p_command_id: command, p_args: { document_ids: [order.id] } });
  assert.equal(again.replayed, true);
  assert.equal(again.list.id, first.list.id);
});
