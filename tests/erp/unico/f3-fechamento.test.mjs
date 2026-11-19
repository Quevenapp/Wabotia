import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uid } from "node:crypto";
import { api, fixture } from "../harness/f3-local.mjs";

const rules = api.reservaConfig({ deposit_type: "percent", deposit_percent: 30 });

test("Trabalho sem material e automação desligada conserva só Financeiro manual", async t => {
  const f = await fixture(t);
  f.local.prepare("UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false'),'$.auto_post.stock',json('false')) WHERE profile_id=?").run(f.profile);
  let row = await f.quote();
  await api.patchWorkCommercial(f.ctx, f.actor, row.id, { version: row.row_version, authorize_fixed_price: true }, uid());
  row = await api.loadOrder(f.ctx, row.id);
  await api.changeStatus(f.ctx, row, "in_progress", f.actor.id, "", { notify: false });
  await f.pump();
  const view = await api.integrationSourceView(f.env, f.actor, f.source);
  assert.equal(view.state, "skipped");
  assert.equal(view.skipped_reason, "automation_off");
  assert.equal(view.pending, true);
  assert.deepEqual(view.manual_destinations, ["finance"]);
});

for (const module of ["agenda", "reserva"]) test(`${module}: recebimento sem obrigação vinculada permanece local após religamento`, async t => {
  const f = await fixture(t), at = Date.now();
  const setParts = async choices => api.batch(f.env, [
    ...Object.entries(choices).map(([id, enabled]) => ["INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated", [f.profile, id, enabled ? 1 : 0, at]]),
    ...api.activationStatements(f.profile, Object.entries(choices).map(([module_id, enabled]) => ({ module_id, enabled })), at),
  ]);
  await setParts({ [module]: true, "erp-financeiro": false });
  const ctx = { ...api.modulesApi(f.env, f.profile, module), publish: async () => 1, sendMessage: async () => "sent" };
  let id = uid(), amount = 1000;
  if (module === "agenda") {
    f.local.prepare("INSERT INTO agenda_appointments(id,profile_id,service_id,professional_id,starts,ends,source,service_name,price_cents,contact_id,booked_at,created_by,created,updated) VALUES(?,?,?,?,?,?,'panel','Serviço',1000,?,?,?,?,?)")
      .run(id, f.profile, uid(), uid(), at, at + 60000, f.localId, at, f.actor.id, at, at);
    await api.agendaTrigger(ctx, f.actor, id, "complete", {}, "complete");
    await api.agendaTrigger(ctx, f.actor, id, "charge", {}, "charge");
    await api.agendaTrigger(ctx, f.actor, id, "charge", {}, "charge");
  } else {
    const unit = await api.saveUnit(ctx, f.actor, { name: "Unidade", mode: "hourly", kind: "court", price_cents: 1000 });
    const booking = await api.createBooking(ctx, rules, { id, unit_id: unit.id, starts: api.atClock(api.addDays(api.brasiliaDate(at), 5), "10:00"),
      duration_minutes: 60, source: "panel", actor: f.actor.id, deposit: true, staff: true, notify: false });
    id = booking.booking.id; amount = 300;
  }
  await api.manualBookingReceipt(ctx, f.actor, module, id, { amount_cents: amount, method: "cash" }, "paid");
  await api.manualBookingReceipt(ctx, f.actor, module, id, { amount_cents: amount, method: "cash" }, "paid");
  const source = { profile: f.profile, module, source_id: id, component: "main" };
  for (const enabled of [false, true]) {
    if (enabled) await setParts({ "erp-financeiro": true });
    await f.drain();
    const rows = f.local.prepare("SELECT e.seq,d.state,d.error_code,d.receipt_json FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND e.source_id=?").all(f.profile, id).map(row => ({ ...row }));
    assert.deepEqual(rows, [{ seq: null, state: "blocked", error_code: "historical_origin_unlinked", receipt_json: null }]);
    const view = await api.integrationSourceView(f.env, f.actor, source);
    assert.equal(view.state, "blocked"); assert.equal(view.reason_code, "historical_origin_unlinked");
    assert.equal(view.pending, true); assert.deepEqual(view.applied, []);
  }
  assert.equal(f.local.prepare("SELECT enqueued_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?").get(f.profile, id).enqueued_seq, 0);
  assert.equal(f.local.prepare("SELECT count(*) n FROM module_erp_requests").get().n, 0);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 0);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__settlement").get().n, 0);
});

async function localFixture(t, module, paymentAmount) {
  const f = await fixture(t), at = Date.now();
  await api.batch(f.env, [
    ...[module, "payments", "mensalidade"].map(id => ["INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=1,updated=excluded.updated", [f.profile, id, at - 1000]]),
    ...api.activationStatements(f.profile, [module, "payments", "mensalidade"].map(module_id => ({ module_id, enabled: true })), at - 1000),
  ]);
  const conversationId = uid();
  f.local.prepare("INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,'panel',?,'',?,?,?,?)").run(conversationId,f.profile,conversationId,uid(),at,at,at);
  const c = f.local.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId);
  const ctx = { ...api.modulesApi(f.env, f.profile, module), publish: async () => 1, note: async () => {},
    sendMessage: async () => "sent", conversation: async () => c, conversationByPhone: async () => null,
    customer: async () => ({ profileId: f.profile, namespace: "team", state: "ready", contactId: f.localId, verifiedPhone: null, version: 1, erp: { id: f.customer.id, version: 1 } }),
    activeTicket: async () => ({ id: uid(), number: "1" }), handoff: async () => {}, recordConsent: async () => {}, verifiedPhone: () => "" };
  let row;
  if (module === "pedido") row = (await api.createSale(ctx, { conversation: null, customer_name: "", source: "panel", sourceKey: uid(),
    lines: [{ item_id: uid(), slot: 0, name: "Produto", quantity: 1, unit_cents: 1000, total_cents: 1000, options: [], note: "" }],
    item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000, fulfillment: "pickup", address: null, note: "", notes: "", actor: f.actor.id })).order;
  if (module === "reserva") {
    const unit = await api.saveUnit(ctx, f.actor, { name: "Unidade", mode: "hourly", kind: "court", price_cents: 1000 });
    row = (await api.createBooking(ctx, rules, { id: uid(), unit_id: unit.id, starts: api.atClock(api.addDays(api.brasiliaDate(at), 5), "10:00"), duration_minutes: 60, source: "panel", actor: f.actor.id, conversation: c, deposit: true, staff: true, notify: false })).booking;
  }
  if (module === "suporte") {
    const payer = uid();
    f.local.prepare("INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Cliente',?,?,?,?)").run(payer,f.profile,f.localId,f.actor.id,at,at);
    row = { id: uid(), profile_id: f.profile, conversation_id: c.id, session_id: null, payer_id: payer, package_id: "support", price_cents: 1000, status: "pending", created: at };
    await api.batch(f.env, [["INSERT INTO suporte_purchases(id,profile_id,conversation_id,package_id,package_name,price_cents,mode,method,status,created,updated) VALUES(?,?,?,'support','Suporte',1000,'ticket','link','pending',?,?)", [row.id, f.profile, c.id, at, at]],
      ...await api.supportIntegrationStatements(ctx, row, "recognize", at)]);
  }
  if (module === "mensalidade") {
    const day = api.today(at), plan = await api.createPlan(ctx, { name: "Plano", amount_cents: 1000, due_day: Number(day.slice(-2)) }, f.actor.id);
    const sub = await api.createSubscription(ctx, { plan_id: plan.id, phone: "5511999998888", customer_name: "Cliente", start_date: day, end_date: day }, f.actor.id);
    await api.generateInstallments(ctx, at, sub.id);
    row = await api.one(f.env, "SELECT * FROM mensalidade_installments WHERE subscription_id=?", sub.id);
  }
  const id = uid(), remote = uid(), account = uid(), amount = paymentAmount ?? (module === "reserva" ? 300 : 1000);
  await api.batch(f.env, [["INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated) VALUES(?,?,?,?,'fake','link',?,?,'PRIVADO',?,'paid',?,'module','system',?,?,?,?)", [id, f.profile, c.id, account, module, row.id, amount, remote, at + 60000, at, at, at]]]);
  if (module === "suporte") f.local.prepare("UPDATE suporte_purchases SET payment_id=? WHERE id=?").run(id, row.id);
  const payment = () => api.one(f.env, "SELECT * FROM payments WHERE id=?", id);
  const evidence = async status => {
    const fact = await api.preparePaymentEvidence(f.env, await payment(), { id: remote, state: status, raw_status: status, amount_cents: amount, currency: "BRL", paid_at: at, verified_method: "pix" }, at + 1);
    await api.batch(f.env, [["UPDATE payments SET status=? WHERE id=?", [status, id]], ...api.paymentEvidenceStatements(fact)]);
    return fact;
  };
  const apply = async (status = "paid") => {
    const p = { ...api.paymentView(await payment()), status };
    if (module === "pedido") return api.pedidoPaid(ctx, p, "created");
    if (module === "reserva") return api.reservaPaid(ctx, rules, p, "created");
    if (module === "suporte") return api.purchasePaymentUpdated(ctx, p);
    return api.mensalidadePaid(ctx, p, "created");
  };
  const table = { pedido: "pedido_orders", reserva: "reserva_bookings", suporte: "suporte_purchases", mensalidade: "mensalidade_installments" }[module];
  return { ...f, ctx, row, payment, evidence, apply, current: () => f.local.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id),
    receipts: () => f.local.prepare("SELECT * FROM module_commercial_receipts WHERE profile_id=? ORDER BY kind").all(f.profile),
    events: () => f.local.prepare("SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id=? ORDER BY source_revision,seq").all(f.profile, module).map(r => JSON.parse(r.payload_json)),
    pending: () => f.local.prepare("SELECT d.* FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND e.module_id=? AND d.state='blocked'").all(f.profile, module) };
}

for (const module of ["pedido", "reserva", "suporte", "mensalidade"]) {
  test(`${module}: legado conclui localmente, recupera evidência e não duplica baixa`, async t => {
    const f = await localFixture(t, module);
    await f.apply(); await f.apply();
    assert.equal(f.current()[module === "pedido" || module === "reserva" ? "payment_status" : "status"], "paid");
    assert.equal(f.receipts().length, 0);
    assert.deepEqual(f.pending().map(d => d.error_code), ["payment_evidence_required"]);
    await f.evidence("paid"); await f.apply(); await f.apply();
    assert.equal(f.receipts().length, 1);
    assert.equal(f.pending().length, 0);
    assert.equal(f.local.prepare("SELECT count(*) n FROM module_erp_allocations WHERE profile_id=?").get(f.profile).n, 1);
    await f.evidence("refunded"); await f.apply("refunded"); await f.apply("refunded");
    assert.deepEqual(f.receipts().map(r => r.kind), ["receive", "reverse"]);
    assert(!JSON.stringify(f.events()).includes("PRIVADO"));
  });
}

for (const failedKind of ["pedido.paid", "pedido.status_changed"]) test(`Pedido retoma publicação de ${failedKind} sem repetir o lote comercial`, async t => {
  const f = await localFixture(t, "pedido"), published = new Map();
  f.local.prepare("UPDATE pedido_orders SET status='awaiting_payment',payment_status='awaiting',payment_id=? WHERE id=?").run((await f.payment()).id, f.row.id);
  let fail = true;
  f.ctx.publish = async (kind, id, payload, options) => {
    if (kind === failedKind && fail) { fail = false; throw new Error("publicação interrompida"); }
    published.set(`${kind}:${options?.key}`, { kind, id, payload });
    return 1;
  };
  await f.evidence("paid");
  await assert.rejects(f.apply(), /publicação interrompida/);
  assert.equal(f.current().payment_status, "paid"); assert.equal(f.current().status, "received");
  const events = f.events(), source = f.local.prepare("SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id='pedido' AND source_id=?").get(f.profile, f.row.id);
  await f.apply(); await f.apply();
  for (const kind of ["pedido.paid", "pedido.status_changed"]) assert.equal([...published.values()].filter(e => e.kind === kind).length, 1);
  assert.deepEqual(f.events(), events);
  assert.deepEqual(f.local.prepare("SELECT * FROM module_erp_sources WHERE profile_id=? AND module_id='pedido' AND source_id=?").get(f.profile, f.row.id), source);
  assert.equal(f.receipts().length, 1);
});

test("Reserva expirada e ocupada mantém aviso unit_taken e recibo sem baixa ERP", async t => {
  const f = await localFixture(t, "reserva"), original = f.current(), warnings = [];
  await api.expireBooking(f.ctx, rules, f.row.id, { reason: "deadline" });
  const taken = (await api.createBooking(f.ctx, rules, { id: uid(), unit_id: original.unit_id, starts: original.starts,
    duration_minutes: 60, source: "panel", actor: f.actor.id, staff: true, notify: false })).booking;
  f.ctx.publish = async (kind, _id, payload) => { if (kind === "reserva.payment_late") warnings.push(payload); return 1; };
  await f.evidence("paid"); await f.apply(); await f.apply();
  assert.equal(f.current().status, "expired"); assert.equal(f.current().payment_status, "paid");
  assert.equal(f.local.prepare("SELECT status FROM reserva_bookings WHERE id=?").get(taken.id).status, "confirmed");
  assert(warnings.length > 0); for (const warning of warnings) { assert.equal(warning.reason, "unit_taken"); assert.equal(warning.needs_refund, true); }
  assert.equal(f.receipts().length, 1);
  assert.equal(f.pending()[0].error_code, "obligation_reactivation_required");
  assert.equal(f.local.prepare("SELECT count(*) n FROM module_erp_allocations WHERE profile_id=?").get(f.profile).n, 0);
});

for (const module of ["reserva", "suporte"]) test(`${module}: pagamento tardio restaura operação e bloqueia recomposição no ERP`, async t => {
  const f = await localFixture(t, module);
  if (module === "reserva") await api.expireBooking(f.ctx, rules, f.row.id, { reason: "deadline" });
  else await api.purchasePaymentUpdated(f.ctx, { ...api.paymentView(await f.payment()), status: "expired" });
  await f.evidence("paid"); await f.apply(); await f.apply();
  assert.equal(f.current().status, module === "reserva" ? "confirmed" : "paid");
  assert.equal(f.pending()[0].error_code, "obligation_reactivation_required");
  assert.equal(f.local.prepare("SELECT count(*) n FROM module_erp_allocations WHERE profile_id=?").get(f.profile).n, 0);
  if (module === "suporte") assert.equal(f.local.prepare("SELECT count(*) n FROM suporte_releases WHERE profile_id=? AND status='active'").get(f.profile).n, 1);
});

test("consulta da evidência recupera gancho legado já concluído, sem novo pagamento", async t => {
  const f = await localFixture(t, "pedido");
  const p = await f.payment(), previous = api.paymentHook("pedido"), seen = [];
  api.registerPaymentHook("pedido", async (_env, _profile, value) => { seen.push(value); await f.apply(); });
  t.after(() => { api.registerPaymentHook("pedido", previous); delete api.providers.fake; });
  const legacy = { id: uid(), status: "paid", previous: "created" };
  f.local.prepare("UPDATE payments SET hook_pending=? WHERE id=?").run(JSON.stringify([legacy]), p.id);
  assert.equal(await api.deliverPaymentHooks(f.env, p.id), true);
  assert.equal(seen.length, 1); assert.equal(seen[0].evidence, null); assert.equal(seen[0].payment_event.id, legacy.id);
  assert.equal(f.current().payment_status, "paid"); assert.equal(f.receipts().length, 0);
  assert.deepEqual(f.pending().map(d => d.error_code), ["payment_evidence_required"]);
  f.local.prepare("INSERT INTO payment_accounts(id,profile_id,provider,created,updated) VALUES(?,?,'fake',?,?)").run(p.account_id, f.profile, p.created, p.created);
  api.providers.fake = { getPayment: async () => ({ id: p.provider_payment_id, external_reference: p.id,
    state: "paid", raw_status: "approved", amount_cents: p.amount_cents, currency: "BRL", paid_at: p.paid_at, verified_method: "pix" }) };
  await api.refreshFromProvider(f.env, p.account_id, p.provider_payment_id);
  await api.refreshFromProvider(f.env, p.account_id, p.provider_payment_id);
  assert.equal((await f.payment()).hook_pending, null);
  assert.equal(f.pending().length, 0);
  assert.equal(f.receipts().length, 1);
  assert.equal(seen.length, 2); assert.equal(seen[1].evidence.receipt_key, f.receipts()[0].receipt_key);
  assert.equal(seen[1].payment_event.id, `recovery:${seen[1].evidence.receipt_key}`);
});

test("recebimento vinculado atravessa desligamento e religamento do Financeiro no motor real", async t => {
  const f = await localFixture(t, "suporte");
  const account = f.rpc("erp_finance_account_execute", { p_command_id: uid(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } }).record;
  f.local.prepare("UPDATE module_erp_policy SET config_json=json_set(config_json,'$.settlement_accounts.pix',?) WHERE profile_id=?").run(account.id, f.profile);
  await f.drain();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 1);
  const toggle = async enabled => api.batch(f.env, [
    ["UPDATE profile_modules SET enabled=?,updated=? WHERE profile_id=? AND module_id='erp-financeiro'", [enabled ? 1 : 0, Date.now(), f.profile]],
    ...api.activationStatements(f.profile, [{ module_id: "erp-financeiro", enabled }], Date.now()),
  ]);
  await toggle(false); await f.evidence("paid"); await f.apply(); await f.drain();
  const receive = f.events().find(e => e.operation === "receive");
  assert.equal(f.delivery(receive).state, "pending");
  assert.equal(f.delivery(receive).error_code, "part_disabled");
  const errors = [];
  f.intercept(async (name, request, run) => {
    const response = await run();
    if (!response.ok) errors.push({ rpc: name, status: response.status, body: await response.clone().json() });
    return response;
  });
  await toggle(true); await f.drain();
  assert.equal(f.delivery(receive).state, "done", JSON.stringify(errors));
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__settlement").get().n, 1);
  await f.apply(); await f.drain();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__settlement").get().n, 1);
});

test("cancelamento parcial conserva bloqueio, destino aplicado e ação manual restante", () => {
  const result = { outcome: "skipped", reason_code: "module_cancellation_pending", links: [
    { kind: "document", id: "doc" }, { kind: "title", id: "title" }, { kind: "stock_posting", id: "stock" },
  ], effects: { stock: "reversed", finance: "not_requested" } };
  const view = api.effectiveSourceState([{ state: "done", receipt_json: JSON.stringify(result) }]);
  assert.equal(view.state, "blocked"); assert.equal(view.reason_code, "module_cancellation_pending");
  assert.deepEqual([...view.manual], ["finance"]);
  assert.deepEqual(view.applied.sort(), ["document", "finance", "stock"]);
});


test("cancelamento com sinal parcial deixa pendência local e enfileira estorno antes de cancelar título", async t => {
  const f = await localFixture(t, "reserva", 100);
  await f.evidence("paid"); await f.apply();
  // Esta fixture de Reserva não promove pagador: a prova usa a saída local,
  // os recibos e a ordem dos comandos, mantendo o cancelamento fora da sequência.
  await api.expireBooking(f.ctx, rules, f.row.id, { reason: "deadline" });
  await api.expireBooking(f.ctx, rules, f.row.id, { reason: "deadline", repeat: true });
  const pending = f.events().find(e => e.operation === "cancel");
  assert.equal(pending.seq, null);
  assert.equal(f.delivery(pending).state, "blocked");
  assert.equal(f.delivery(pending).error_code, "module_cancellation_pending");
  assert.equal(f.events().filter(e => e.operation === "cancel").length, 1);
  await f.evidence("refunded"); await f.apply("refunded"); await f.apply("refunded");
  assert.deepEqual(f.events().filter(e => e.seq !== null).map(e => e.operation), ["recognize", "receive", "reverse", "cancel"]);
  assert.equal(f.delivery(pending).state, "done");
  assert.deepEqual(f.receipts().map(r => r.kind), ["receive", "reverse"]);
});


for (const module of ["pedido", "reserva", "suporte", "mensalidade"]) test(`${module}: estorno comprovado recupera legado sem bloquear efeito local`, async t => {
  const f = await localFixture(t, module);
  await f.apply();
  assert.equal(f.pending().length, 1);
  await f.evidence("refunded"); await f.apply("refunded"); await f.apply("refunded");
  assert.equal(f.current()[module === "suporte" ? "status" : "payment_status"], "refunded");
  assert.deepEqual(f.receipts().map(r => r.kind), ["receive", "reverse"]);
  assert.equal(f.pending().length, 0);
});
