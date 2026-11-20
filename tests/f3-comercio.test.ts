import { persistProviderEvidence } from "./helpers/f3-payment-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { uid, type Env as AppEnv } from "../src/types";
import { paymentView } from "../src/payments";
declare global { namespace Cloudflare { interface Env extends AppEnv {} } }
import { modulesApi } from "../src/modules/api";
import { createOrder, loadOrder, moveOrder, paymentUpdated, type NewOrder } from "../src/modules/pedido/orders";
import { markPaid } from "../src/modules/pedido/manage";
import { orderCommerce, orderOwner, saleSource, savedSale, authorizePedidoSource } from "../src/modules/pedido/integration";
import { addPayment, closeTab, mergeTab, sendOrder, transferTab, updateTab, voidPayment } from "../src/modules/mesas/tabs";
import { authorizeTableSource } from "../src/modules/mesas/integration";
import { cancel, createDelivery } from "../src/modules/entrega/store";
import { deliveryCreationStatements, receiveDelivery, updateDeliveryCommercial } from "../src/modules/entrega/integration";
import { canonical } from "../src/integrations/keys";
import { reverseCommercialReceipt } from "../src/integrations/receipts";
import { IntegrationError, validateEvent } from "../src/integrations/privacy";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import { acquireIntegrationLease } from "../src/integrations/outbox";
import { f3Fixture, installFakeErp, setParts, due, type F3Fixture } from "./helpers/f3-fixtures";

// Dependências B2/B8 simuladas pelas portas da base. Não faz chamada ao ERP real.
afterEach(() => vi.restoreAllMocks());
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(on = true) {
  const f = await f3Fixture();
  await setParts(f.profile, { pedido: true, mesas: true, entrega: true, erp: on, "erp-produtos": on, "erp-estoque": on, "erp-financeiro": on, "erp-vendas": on }, Date.now() - 1000);
  await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.consumer_contact_id',?,'$.settlement_accounts.pix',?,'$.settlement_accounts.card',?,'$.settlement_accounts.unknown',?) WHERE profile_id=?", f.customer, uid(), uid(), uid(), f.profile);
  const ctx = (module: string) => {
    const c = modulesApi(f.env, f.profile, module);
    c.publish = vi.fn(async () => 1);
    c.sendMessage = vi.fn(async () => "message");
    c.note = vi.fn(async () => undefined);
    return c;
  };
  const category = uid(), item = uid(), group = uid(), product = uid(), optionProduct = uid();
  await batch(f.env, [
    ["INSERT INTO pedido_categories(id,profile_id,name,created,updated) VALUES(?,?,'Cardápio',?,?)", [category, f.profile, Date.now(), Date.now()]],
    ["INSERT INTO pedido_items(id,profile_id,category_id,name,price_cents,created,updated) VALUES(?,?,?,'Lanche',1000,?,?)", [item, f.profile, category, Date.now(), Date.now()]],
    ["INSERT INTO pedido_groups(id,profile_id,name,min,max,options,created,updated) VALUES(?,?,'Adicionais',0,1,?,?,?)", [group, f.profile, JSON.stringify([{ id: "extra", name: "Queijo", price_cents: 200, available: true }]), Date.now(), Date.now()]],
    ["INSERT INTO pedido_item_groups(profile_id,item_id,group_id) VALUES(?,?,?)", [f.profile, item, group]],
    ["INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,'pedido','item',?,'',?,?,?)", [f.profile, item, product, Date.now(), f.actor.id]],
    ["INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by) VALUES(?,'pedido','option',?,'extra',?,?,?)", [f.profile, group, optionProduct, Date.now(), f.actor.id]],
  ]);
  return { ...f, ctx, item, group, product, optionProduct };
}
function input(f: Fixture, extra: Partial<NewOrder> = {}): NewOrder {
  return { conversation: null, customer_name: "", source: "panel", sourceKey: uid(),
    lines: [{ item_id: f.item, slot: 0, name: "Lanche", quantity: 2, unit_cents: 1200, total_cents: 2400, options: [{ group_id: f.group, group: "Adicionais", id: "extra", name: "Queijo", price_cents: 200 }], note: "PRIVADO: alergia" }],
    item_count: 2, subtotal_cents: 2400, delivery_fee_cents: 500, total_cents: 2900, fulfillment: "delivery", address: null,
    note: "PRIVADO: conversa", notes: "PRIVADO: informação pessoal", actor: f.actor.id, ...extra };
}
async function received(f: Fixture, extra: Partial<NewOrder> = {}) {
  const ctx = f.ctx("pedido"), value = input(f, extra);
  const { order } = await createOrder(ctx, value);
  return order.status === "received" ? order : moveOrder(ctx, order, "received", f.actor.id, "", {}, { notify: false });
}
async function events(f: F3Fixture) {
  return (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? ORDER BY module_id,source_id,source_revision,seq", f.profile)).map(r => JSON.parse(r.payload_json));
}
async function pump(f: F3Fixture, rounds = 10) {
  for (let i = 0; i < rounds; i++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
}
async function table(f: Fixture, number: number, service = false) {
  const id = uid(), tableId = uid(), at = Date.now();
  await batch(f.env, [
    ["INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,?,?,?)", [tableId, f.profile, `Mesa ${number}`, at, at]],
    ["INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,?,?,?,'open',?,100,?,?,?,?)", [id, f.profile, number, tableId, `Mesa ${number}`, service ? 1 : 0, f.actor.id, at, at, at]],
  ]);
  return one(f.env, "SELECT * FROM mesas_tabs WHERE id=?", id);
}
async function tableOrder(f: Fixture, tab: any, request: string = uid()) {
  return sendOrder(f.ctx("mesas"), f.actor, { id: tab.id, items: [{ item_id: f.item, quantity: 1 }] }, request);
}

for (const on of [true, false]) describe(`F3 comércio — partes ${on ? "ligadas" : "desligadas"}`, () => {
  it("Pedido recebido, opções, desconto e frete único; repetição e pagamento manual", async () => {
    const f = await setup(on), remote = installFakeErp(), ctx = f.ctx("pedido");
    const value = input(f);
    const first = await createOrder(ctx, value);
    expect((await createOrder(ctx, value)).order.id).toBe(first.order.id);
    await expect(createOrder(ctx, { ...value, total_cents: 3000 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await exec(f.env, "UPDATE pedido_orders SET discount_cents=100,total_cents=2800 WHERE id=?", first.order.id);
    expect((await createOrder(ctx, value)).order.id).toBe(first.order.id);
    const order = await moveOrder(ctx, await loadOrder(ctx, first.order.id), "received", f.actor.id, "", {}, { notify: false });
    const source = await orderOwner(f.env, f.profile, order), snapshot = (await savedSale(f.env, source))!;
    expect(snapshot.total_cents).toBe(2800); expect(snapshot.freight_cents).toBe(500); expect(snapshot.discount_cents).toBe(100);
    expect(snapshot.items.map(i => [i.unit_cents, i.quantity])).toEqual([[1000, "2"], [200, "2"]]);
    expect(snapshot.items.map(i => i.product_id)).toEqual(on ? [f.product, f.optionProduct] : [null, null]);
    await markPaid(ctx, f.actor, { id: order.id }, "manual-1");
    await markPaid(ctx, f.actor, { id: order.id }, "manual-1");
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(1);
    const serialized = canonical(await events(f)); expect(serialized).not.toContain("PRIVADO");
    (await events(f)).forEach(validateEvent);
    await pump(f);
    expect(remote.mutations.length > 0).toBe(on);
    expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
    if (on) expect((await events(f)).map(e => e.operation)).toEqual(["prepare", "execute", "receive"]);
  });

  it("provedor confirma recebimento e estorno uma única vez, no lote da mudança local", async () => {
    const f = await setup(on), ctx = f.ctx("pedido"), remote = installFakeErp();
    const order = (await createOrder(ctx, input(f))).order, paymentId = uid(), account = uid(), at = Date.now();
    await exec(f.env, "INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated) VALUES(?,?,?,?,'mercadopago','pix','pedido',?,'Pedido',2900,'paid','remote-1','module',?,?,?,?,?)", paymentId, f.profile, uid(), account, order.id, f.actor.id, at + 10000, at, at, at);
    await persistProviderEvidence(f.env, paymentId);
    const paid = paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", paymentId))!;
    await paymentUpdated(ctx, paid, "created"); await paymentUpdated(ctx, paid, "created");
    expect((await loadOrder(ctx, order.id)).status).toBe("received");
    expect((await loadOrder(ctx, order.id)).payment_status).toBe("paid");
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await events(f)).filter(e => e.operation === "receive")).toHaveLength(on ? 1 : 0);
    await exec(f.env, "UPDATE payments SET amount_cents=3000 WHERE id=?", paymentId);
    await expect(paymentUpdated(ctx, paid, "created")).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    await exec(f.env, "UPDATE payments SET amount_cents=2900,status='refunded' WHERE id=?", paymentId);
    await persistProviderEvidence(f.env, paymentId);
    const refunded = paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", paymentId))!;
    await paymentUpdated(ctx, refunded, "paid"); await paymentUpdated(ctx, refunded, "paid");
    expect((await loadOrder(ctx, order.id)).payment_status).toBe("refunded");
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND kind='reverse'", f.profile)).toHaveLength(1);
    await pump(f); expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
  });

  it("estorno do pagamento online excedente conserva o pagamento manual", async () => {
    const f = await setup(on), ctx = f.ctx("pedido"), order = await received(f);
    await markPaid(ctx, f.actor, { id: order.id }, "manual-original");
    const id = uid(), at = Date.now();
    await exec(f.env, "INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated) VALUES(?,?,?,?,'mercadopago','pix','pedido',?,'Pedido',2900,'paid','extra','module',?,?,?,?,?)", id, f.profile, uid(), uid(), order.id, f.actor.id, at + 10000, at, at, at);
    await persistProviderEvidence(f.env, id);
    await paymentUpdated(ctx, paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id))!, "created");
    expect((await loadOrder(ctx, order.id)).needs_refund).toBe(1);
    await exec(f.env, "UPDATE payments SET status='refunded' WHERE id=?", id);
    await persistProviderEvidence(f.env, id);
    const refunded = paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id))!;
    await paymentUpdated(ctx, refunded, "paid"); await paymentUpdated(ctx, refunded, "paid");
    expect(await loadOrder(ctx, order.id)).toMatchObject({ payment_status: "paid", needs_refund: 0, paid_by: f.actor.id, status: "received" });
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("cancelamento pago aguarda anulação; consumo não fabrica retorno ao estoque", async () => {
    const f = await setup(on), remote = installFakeErp(), ctx = f.ctx("pedido");
    let order = await received(f);
    await markPaid(ctx, f.actor, { id: order.id }, "paid-cancel");
    order = await moveOrder(ctx, await loadOrder(ctx, order.id), "preparing", f.actor.id, "", {}, { notify: false });
    await moveOrder(ctx, order, "cancelled", f.actor.id, "PRIVADO", {}, { notify: false });
    expect((await loadOrder(ctx, order.id)).needs_refund).toBe(1);
    expect((await events(f)).filter(e => e.operation === "reverse")).toHaveLength(0);
    const receipt = await one(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND kind='receive'", f.profile);
    await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: receipt.receipt_key, reason_code: "manual_void" }, "reverse-1");
    await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: receipt.receipt_key, reason_code: "manual_void" }, "reverse-1");
    expect((await loadOrder(ctx, order.id)).needs_refund).toBe(0);
    expect((await events(f)).filter(e => e.operation === "cancel").every(e => !e.eligible.stock)).toBe(true);
    await pump(f); expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
  });

  it("pedido, histórico da conta, alias e saída revertem juntos antes do commit", async () => {
    const f = await setup(on), tab = await table(f, 1), ctx = f.ctx("pedido");
    const value = input(f, { source: "table", tab: { id: tab.id, label: tab.table_name }, fulfillment: "table", delivery_fee_cents: 0, total_cents: 2400,
      commit: async () => [["SELECT json('interrupcao')", []]] });
    await expect(createOrder(ctx, value)).rejects.toThrow();
    expect(await all(f.env, "SELECT * FROM pedido_orders WHERE profile_id=?", f.profile)).toHaveLength(0);
    expect(await events(f)).toHaveLength(0);
    expect(await all(f.env, "SELECT * FROM module_erp_aliases WHERE profile_id=?", f.profile)).toHaveLength(0);
    const sent = await tableOrder(f, tab, "send-again");
    await tableOrder(f, tab, "send-again");
    expect(await all(f.env, "SELECT * FROM mesas_history WHERE profile_id=? AND kind='order'", f.profile)).toHaveLength(1);
    expect((await orderOwner(f.env, f.profile, sent.order)).source_id).toBe(tab.id);
    expect((await events(f)).every(e => e.source.module === "mesas")).toBe(true);
  });

  it("pagamento parcial, troco, união, transferência e anulação mantêm proprietários", async () => {
    const f = await setup(on), remote = installFakeErp(), ctx = f.ctx("mesas");
    const a = await table(f, 1), b = await table(f, 2), free = uid();
    const first = await tableOrder(f, a), second = await tableOrder(f, b);
    const payment = await addPayment(ctx, f.actor, { id: a.id, method: "cash", amount_cents: 500, tendered_cents: 1000 }, "partial");
    expect(payment.payment.change_cents).toBe(500);
    await expect(addPayment(ctx, f.actor, { id: a.id, method: "cash", amount_cents: 500, tendered_cents: 1200 }, "partial")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await mergeTab(ctx, f.actor, { id: b.id, tab_id: a.id });
    await mergeTab(ctx, f.actor, { id: b.id, tab_id: a.id });
    await exec(f.env, "INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,'Mesa livre',?,?)", free, f.profile, Date.now(), Date.now());
    await transferTab(ctx, f.actor, { id: b.id, table_id: free });
    expect((await orderOwner(f.env, f.profile, first.order)).source_id).toBe(a.id);
    expect((await orderOwner(f.env, f.profile, second.order)).source_id).toBe(b.id);
    await voidPayment(ctx, f.actor, { id: payment.payment.id, reason: "Valor incorreto" });
    await voidPayment(ctx, f.actor, { id: payment.payment.id, reason: "Valor incorreto" });
    const reversed = await all(f.env, "SELECT a.* FROM module_erp_allocations a JOIN module_commercial_receipts r ON r.profile_id=a.profile_id AND r.receipt_key=a.receipt_key WHERE a.profile_id=? AND r.kind='reverse'", f.profile);
    expect(reversed.map(a => [a.source_id, a.amount_cents])).toEqual([[a.id, 500]]);
    const paid = await addPayment(ctx, f.actor, { id: b.id, method: "pix", amount_cents: 2000 }, "merged-paid");
    await addPayment(ctx, f.actor, { id: b.id, method: "pix", amount_cents: 2000 }, "merged-paid");
    expect(paid.tab.bill.due_cents).toBe(0);
    const allocations = await all(f.env, "SELECT a.source_id,a.amount_cents FROM module_erp_allocations a JOIN module_commercial_receipts r ON r.receipt_key=a.receipt_key AND r.profile_id=a.profile_id WHERE a.profile_id=? AND r.amount_cents=2000", f.profile);
    expect(new Set(allocations.map(a => a.source_id))).toEqual(new Set([a.id, b.id]));
    expect(allocations.reduce((n, a) => n + a.amount_cents, 0)).toBe(2000);
    const salesBefore = (await events(f)).filter(e => e.operation === "execute").length;
    await closeTab(ctx, f.actor, { id: b.id }, "close");
    await closeTab(ctx, f.actor, { id: b.id }, "close");
    expect((await events(f)).filter(e => e.operation === "execute")).toHaveLength(salesBefore);
    await pump(f, 16); expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
  });

  it("taxa tem componentes e complementos; redução de componente pago exige pessoa", async () => {
    const f = await setup(on), ctx = f.ctx("mesas"), tab = await table(f, 1, true);
    await tableOrder(f, tab);
    await addPayment(ctx, f.actor, { id: tab.id, method: "cash", amount_cents: 1100 }, "first-total");
    await expect(updateTab(ctx, f.actor, { id: tab.id, service: false })).rejects.toMatchObject({ code: "service_paid_correction_required" });
    await tableOrder(f, tab);
    await closeTab(ctx, f.actor, { id: tab.id, payments: [{ method: "cash", amount_cents: 1100, tendered_cents: 2000 }] }, "second-total");
    const components = await all(f.env, "SELECT * FROM module_erp_aliases WHERE profile_id=? AND record_kind='service'", f.profile);
    expect(components.map(c => c.component)).toEqual(["service:1", "service:2"]);
    for (const c of components) {
      const snapshot = (await savedSale(f.env, saleSource(f.profile, "mesas", tab.id, c.component)))!;
      expect(snapshot.total_cents).toBe(100); expect(snapshot.items.every(i => i.kind === "service")).toBe(true);
    }
    expect((await events(f)).filter(e => e.source.component.startsWith("service:")).every(e => !e.eligible.stock)).toBe(true);
    const local = await all(f.env, "SELECT amount_cents,change_cents FROM mesas_payments WHERE profile_id=? ORDER BY created,rowid", f.profile);
    expect(local[1]).toMatchObject({ amount_cents: 1100, change_cents: 900 });
  });

  it("dois recebimentos no mesmo fechamento têm chaves válidas e distintas, sem duplicar na repetição", async () => {
    const f = await setup(on), remote = installFakeErp(), ctx = f.ctx("mesas"), tab = await table(f, 1);
    const sent = await tableOrder(f, tab);
    const data = { id: tab.id, payments: [
      { method: "cash", amount_cents: 300, tendered_cents: 500 },
      { method: "pix", amount_cents: 700 },
    ] };
    await closeTab(ctx, f.actor, data, "split-close");
    const beforeReplay = await events(f);
    beforeReplay.forEach(validateEvent);
    const received = beforeReplay.filter(e => e.operation === "receive");
    expect(received).toHaveLength(on ? 2 : 0);
    if (on) {
      expect(new Set(received.map(e => e.source_revision)).size).toBe(1);
      expect(received.map(e => e.source.component)).toEqual([`order:${sent.order.id}`, `order:${sent.order.id}`]);
      expect(new Set(received.map(e => e.event_key)).size).toBe(2);
      expect(new Set(received.map(e => e.receipt_key)).size).toBe(2);
      expect(received.every(e => e.event_key.length <= 200)).toBe(true);
      expect(received[1].seq).toBe(received[0].seq + 1);
    }
    const allocations = await all(f.env, "SELECT receipt_key,source_id,component,amount_cents FROM module_erp_allocations WHERE profile_id=? ORDER BY amount_cents", f.profile);
    expect(allocations.map(a => [a.source_id, a.component, a.amount_cents])).toEqual([
      [tab.id, `order:${sent.order.id}`, 300], [tab.id, `order:${sent.order.id}`, 700],
    ]);
    expect(await all(f.env, "SELECT amount_cents,change_cents FROM mesas_payments WHERE profile_id=? AND method='cash'", f.profile)).toEqual([{ amount_cents: 300, change_cents: 200 }]);
    await closeTab(ctx, f.actor, data, "split-close");
    expect(await events(f)).toEqual(beforeReplay);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(2);
    await expect(closeTab(ctx, f.actor, { ...data, payments: [{ method: "cash", amount_cents: 1000 }] }, "split-close")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await pump(f);
    expect(remote.mutations).toHaveLength(on ? 4 : 0);
    expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
  });

  it("entrega delegada conserva documento e frete; avulsa só reconhece com preço e aceite", async () => {
    const f = await setup(on), remote = installFakeErp(), ctx = f.ctx("entrega");
    const order = await received(f), delivery = uid(), at = Date.now();
    await batch(f.env, [["INSERT INTO entrega_deliveries(id,profile_id,source,source_ref,source_key,label,status,created_by,created,updated) VALUES(?,?,'pedido',?,?,'Entrega','pending',?,?,?)", [delivery, f.profile, order.id, uid(), f.actor.id, at, at]], ...await deliveryCreationStatements(ctx, { id: delivery, source: "pedido", source_ref: order.id })]);
    const alias = await one(f.env, "SELECT * FROM module_erp_aliases WHERE profile_id=? AND record_kind='delivery' AND record_id=?", f.profile, delivery);
    expect(alias).toMatchObject({ module_id: "pedido", source_id: order.id });
    await expect(updateDeliveryCommercial(ctx, f.actor, { id: delivery, version: 0, price_cents: 500, authorize: true }, "delegate-price")).rejects.toMatchObject({ code: "delegated_origin" });
    await expect(receiveDelivery(ctx, f.actor, { id: delivery, amount_cents: 500, method: "cash" }, "delegate-pay")).rejects.toMatchObject({ code: "delegated_origin" });
    const manual = await createDelivery(ctx, f.actor, { label: "PRIVADO", source: "manual", note: "PRIVADO" }, "create");
    expect((await createDelivery(ctx, f.actor, { label: "PRIVADO", source: "manual", note: "PRIVADO" }, "create")).id).toBe(manual.id);
    expect((await events(f)).filter(e => e.source.module === "entrega")).toHaveLength(0);
    const price = { id: manual.id, version: 0, price_cents: 700, authorize: true };
    await updateDeliveryCommercial(ctx, f.actor, price, "price");
    await updateDeliveryCommercial(ctx, f.actor, price, "price");
    await expect(updateDeliveryCommercial(ctx, f.actor, { ...price, price_cents: 701 }, "price")).rejects.toMatchObject({ code: "idempotency_conflict" });
    await receiveDelivery(ctx, f.actor, { id: manual.id, amount_cents: 700, method: "cash" }, "manual-receipt");
    await receiveDelivery(ctx, f.actor, { id: manual.id, amount_cents: 700, method: "cash" }, "manual-receipt");
    await cancel(ctx, f.actor, { id: manual.id, reason: "PRIVADO" });
    await cancel(ctx, f.actor, { id: manual.id, reason: "PRIVADO" });
    const receipt = await one(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND owner_module='entrega'", f.profile);
    await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: receipt.receipt_key, reason_code: "manual_void" }, "delivery-reverse");
    await pump(f);
    expect(canonical(await events(f))).not.toContain("PRIVADO");
    expect((await events(f)).filter(e => e.source.module === "pedido" && e.operation === "execute")).toHaveLength(on ? 1 : 0);
    expect((await events(f)).filter(e => e.source.module === "entrega" && e.operation === "execute")).toHaveLength(on ? 1 : 0);
    expect(new Set(remote.mutations).size).toBe(remote.mutations.length);
  });
});

describe("F3 comércio — recuperação, cortes e autorização", () => {
  it.each(["pedido", "mesas", "entrega"] as const)("%s: queda depois do ERP, repetição e desligamento antes da confirmação", async module => {
    const f = await setup(), remote = installFakeErp();
    if (module === "pedido") await received(f);
    else if (module === "mesas") await tableOrder(f, await table(f, 1));
    else {
      const row = await createDelivery(f.ctx("entrega"), f.actor, { label: "Entrega" }, "create");
      await updateDeliveryCommercial(f.ctx("entrega"), f.actor, { id: row.id, version: 0, price_cents: 500, authorize: true }, "price");
    }
    remote.loseNextReply();
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.mutations).toHaveLength(1);
    await setParts(f.profile, { "erp-financeiro": false });
    await pump(f);
    expect(remote.mutations).toHaveLength(1);
    const first = (await events(f))[0];
    const delivery = await one(f.env, "SELECT * FROM module_erp_delivery WHERE event_id=?", first.id);
    expect(delivery.state).toBe("done");
    await setParts(f.profile, { "erp-financeiro": true }); await pump(f);
    expect(remote.mutations).toHaveLength(1);
  });

  it.each([
    [{ "erp-vendas": false, "erp-produtos": false, "erp-estoque": false }, { document: true, stock: false, finance: true }],
    [{ "erp-vendas": false, "erp-financeiro": false }, { document: true, stock: true, finance: false }],
    [{ "erp-estoque": false, "erp-financeiro": false }, { document: true, stock: false, finance: false }],
  ])("documento interno respeita cada destino: %j", async (parts, eligible) => {
    const f = await setup();
    await setParts(f.profile, parts, Date.now() - 1);
    await received(f);
    expect((await events(f)).find(e => e.operation === "execute").eligible).toEqual(eligible);
  });

  it("ausência de categoria impede só a aplicação e mantém a operação local", async () => {
    const f = await setup(), remote = installFakeErp(), order = await received(f);
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',NULL) WHERE profile_id=?", f.profile);
    await pump(f, 2);
    expect(remote.mutations).toHaveLength(1);
    expect((await one(f.env, "SELECT d.error_code FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND json_extract(e.payload_json,'$.operation')='execute'", f.profile)).error_code).toBe("category_required");
    expect((await loadOrder(f.ctx("pedido"), order.id)).status).toBe("received");
  });

  it("estoque insuficiente deixa ERP pendente sem bloquear cozinha nem alterar available", async () => {
    const f = await setup(), remote = installFakeErp();
    const apply = remote.apply.getMockImplementation()!;
    remote.apply.mockImplementation(async (env, request) => {
      if (request.body.operation === "execute") throw new IntegrationError("invalid_request", 422);
      return apply(env, request);
    });
    const order = await received(f);
    await pump(f);
    expect((await loadOrder(f.ctx("pedido"), order.id)).status).toBe("received");
    expect((await one(f.env, "SELECT available FROM pedido_items WHERE id=?", f.item)).available).toBe(1);
    const blocked = await one(f.env, "SELECT d.state FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND json_extract(e.payload_json,'$.operation')='execute'", f.profile);
    expect(blocked.state).toBe("blocked");
    await moveOrder(f.ctx("pedido"), await loadOrder(f.ctx("pedido"), order.id), "preparing", f.actor.id, "", {}, { notify: false });
    expect((await loadOrder(f.ctx("pedido"), order.id)).status).toBe("preparing");
  });

  it("CAS perdido reverte operação local e não deixa eventos; dois consumidores respeitam sequência", async () => {
    const f = await setup(), remote = installFakeErp(), order = await received(f), ctx = f.ctx("pedido");
    const next = { ...order, status: "preparing", preparing_at: Date.now() };
    const stale = await orderCommerce(ctx, next, f.actor.id, "lifecycle");
    await moveOrder(ctx, order, "preparing", f.actor.id, "", {}, { notify: false });
    await expect(batch(f.env, [["UPDATE pedido_orders SET status='cancelled' WHERE id=?", [order.id]], ...stale])).rejects.toThrow();
    expect((await loadOrder(ctx, order.id)).status).toBe("preparing");
    const list = await events(f); expect(await acquireIntegrationLease(f.env, list[1].id)).toBeNull();
    await Promise.all([drainIntegrationOutbox(f.env, f.profile), drainIntegrationOutbox(f.env, f.profile)]);
    await pump(f); expect(new Set(remote.mutations).size).toBe(list.length);
  });

  it("pedido feito desligado e pago depois não cria venda retroativa", async () => {
    const f = await setup(false), remote = installFakeErp(), order = await received(f);
    await setParts(f.profile, { erp: true, "erp-financeiro": true });
    await markPaid(f.ctx("pedido"), f.actor, { id: order.id }, "late");
    await pump(f);
    expect((await events(f)).map(e => e.operation)).toEqual(["receive"]);
    expect(remote.mutations).toHaveLength(0);
    expect((await one(f.env, "SELECT d.error_code FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=?", f.profile)).error_code).toBe("historical_origin_unlinked");
  });

  it("sem padrão ou cliente completo fica pendente, sem alterar pedido", async () => {
    const f = await setup(), remote = installFakeErp(), ctx = f.ctx("pedido");
    const raw = (await createOrder(ctx, input(f))).order;
    await exec(f.env, "UPDATE pedido_orders SET contact_id=? WHERE id=?", f.local, raw.id);
    const order = await moveOrder(ctx, await loadOrder(ctx, raw.id), "received", f.actor.id, "", {}, { notify: false });
    await exec(f.env, "UPDATE contacts SET name='' WHERE profile_id=?", f.profile);
    await pump(f, 1); expect(remote.mutations).toHaveLength(0);
    expect((await loadOrder(f.ctx("pedido"), order.id)).status).toBe("received");
    const source = await orderOwner(f.env, f.profile, order);
    const other = { ...source, profile: uid() };
    await expect(authorizePedidoSource(f.ctx("pedido"), f.actor, other, true)).rejects.toMatchObject({ status: 404 });
    await expect(authorizeTableSource(f.ctx("mesas"), f.actor, { ...source, module: "mesas", source_id: uid() }, true)).rejects.toMatchObject({ status: 404 });
    const delivery = await createDelivery(f.ctx("entrega"), f.actor, { label: "Entrega" }, "create");
    await expect(updateDeliveryCommercial(f.ctx("entrega"), { ...f.actor, via: { masked: true } } as any, { id: delivery.id, version: 0, price_cents: 100, authorize: true }, "bot")).rejects.toMatchObject({ status: 403 });
  });

  it("total divergente reverte recebimento e preserva evidência original", async () => {
    const f = await setup(), ctx = f.ctx("pedido"), order = (await createOrder(ctx, input(f))).order;
    await exec(f.env, "UPDATE pedido_orders SET total_cents=1 WHERE id=?", order.id);
    await expect(moveOrder(ctx, await loadOrder(ctx, order.id), "received", f.actor.id, "", {}, { notify: false })).rejects.toMatchObject({ code: "total_mismatch" });
    expect((await loadOrder(ctx, order.id)).status).toBe("awaiting_payment");
    expect(await events(f)).toHaveLength(0);
  });
});
