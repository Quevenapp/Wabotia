import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import * as db from "../src/db";
import { ApiError, uid, type Conversation } from "../src/types";
import { modulesApi, type ModuleContext } from "../src/modules/api";
import * as hooks from "../src/modules/hooks";
import { deliverPaymentHooks, paymentView, providers, refreshFromProvider, type Payment } from "../src/payments";
import { mercadoPago } from "../src/payments-mercadopago";
import { preparePaymentEvidence, paymentEvidenceStatements, type VerifiedProviderPayment } from "../src/integrations/payment-evidence";
import { commercialReceiptStatements } from "../src/integrations/receipts";
import { commercialPaymentEvidence, commercialReceiptFromEvidence } from "../src/payments-commercial-evidence";
import { reverseBookingReceipt, agendaTrigger, manualBookingReceipt, receiptBalance, commercialSource } from "../src/modules/agenda/integration";
import { book, cancel as cancelAppointment, noShow } from "../src/modules/agenda/appointments";
import { agendaConfig } from "../src/modules/agenda/config";
import { saveService } from "../src/modules/agenda/catalog";
import { createBooking, cancelBooking } from "../src/modules/reserva/bookings";
import { expireBooking, paymentUpdated as reservaPaid } from "../src/modules/reserva/deposit";
import { saveUnit } from "../src/modules/reserva/units";
import { addDays, atClock, brasiliaDate, reservaConfig } from "../src/modules/reserva/config";
import { createPlan, createSubscription } from "../src/modules/mensalidade/store";
import { createContract, chargeContract, loadContract } from "../src/modules/mensalidade/contracts";
import { generateInstallments } from "../src/modules/mensalidade/installments";
import { paymentUpdated as mensalidadePaid } from "../src/modules/mensalidade/billing";
import * as listeners from "../src/modules/mensalidade/listeners";
import * as payMessage from "../src/modules/mensalidade/pay-message";
import { today } from "../src/modules/mensalidade/model";
import { mensalidadeStatements } from "../src/modules/mensalidade/integration";
import { createOrder, moveOrder, paymentUpdated as pedidoPaid } from "../src/modules/pedido/orders";
import { providerOrderStatements, CommercePlan } from "../src/modules/pedido/integration";
import { sendOrder, cancelTab, addPayment } from "../src/modules/mesas/tabs";
import { serviceComponents } from "../src/modules/mesas/integration";
import { purchasePaymentUpdated } from "../src/modules/suporte/store";
import { supportIntegrationStatements } from "../src/modules/suporte/integration";
import { createDelivery, deliveryView } from "../src/modules/entrega/store";
import { receiveDelivery, updateDeliveryCommercial } from "../src/modules/entrega/integration";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

const providerId = "corr_produtores";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete providers[providerId]; });
const agendaRules = agendaConfig({});
const reservaRules = reservaConfig({ deposit_type: "percent", deposit_percent: 30 });
const future = () => atClock(addDays(brasiliaDate(Date.now()), 5), "10:00");
async function fixture() {
  const f = await f3Fixture();
  await setParts(f.profile, Object.fromEntries(["mensalidade", "agenda", "reserva", "suporte", "pedido", "mesas", "entrega", "payments"].map(m => [m, true])), Date.now() - 1000);
  const ctx = (module: string): ModuleContext => ({ ...modulesApi(f.env, f.profile, module),
    publish: vi.fn(async () => 1), sendMessage: vi.fn(async () => "message"), note: vi.fn(async () => undefined),
    conversation: vi.fn(async () => { throw new ApiError(404, "not_found", "Conversa ausente."); }),
    conversationByPhone: vi.fn(async () => null),
    customer: vi.fn(async () => ({ profileId: f.profile, namespace: "team", state: "ready", contactId: f.local, verifiedPhone: null, version: 1, erp: { id: f.customer, version: 1 } })) as any,
  });
  return { ...f, ctx };
}
type F = Awaited<ReturnType<typeof fixture>>;
const events = async (f: F, module?: string) => (await all(f.env, `SELECT payload_json FROM module_erp_events WHERE profile_id=?${module ? " AND module_id=?" : ""} ORDER BY source_id,source_revision,seq`, f.profile, ...(module ? [module] : []))).map(r => JSON.parse(r.payload_json));
const receipts = (f: F) => all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? ORDER BY kind", f.profile);
async function payment(f: F, module: string, ref: string, amount: number, conversation = uid()) {
  const id = uid(), at = Date.now();
  let account = await one(f.env, "SELECT id FROM payment_accounts WHERE profile_id=?", f.profile);
  if (!account) { account = { id: uid() }; await exec(f.env, "INSERT INTO payment_accounts(id,profile_id,provider,created,updated) VALUES(?,?,?,?,?)", account.id, f.profile, providerId, at, at); }
  await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,trigger,actor,expires_at,receipt,created,updated)
    VALUES(?,?,?,?,?,'link',?,?,'PRIVADO não exportar',?,'created','module','system',?,0,?,?)`, id, f.profile, conversation, account.id, providerId, module, ref, amount, at + 60000, at, at);
  const remote: VerifiedProviderPayment = { id: uid(), state: "paid", raw_status: "approved", external_reference: id, amount_cents: amount, currency: "BRL", paid_at: at, verified_method: "pix" };
  const row = () => one(f.env, "SELECT * FROM payments WHERE id=?", id);
  const fact = async (status: "paid" | "refunded") => {
    const evidence = await preparePaymentEvidence(f.env, await row(), { ...remote, state: status, refunded_at: status === "refunded" ? at + 1 : null }, Date.now());
    await batch(f.env, [
      ["UPDATE payments SET status=?,provider_payment_id=?,paid_at=?,updated=? WHERE id=?", [status, remote.id, at, Date.now(), id]],
      ...paymentEvidenceStatements(evidence),
    ]);
    return { ...paymentView(await row())!, evidence };
  };
  return { id, account: account.id, remote, row, fact };
}
async function monthly(f: F) {
  vi.spyOn(listeners, "announcePaid").mockResolvedValue(undefined);
  vi.spyOn(listeners, "notifyInstallmentRefunded").mockResolvedValue(undefined);
  vi.spyOn(payMessage, "sendPayMessage").mockResolvedValue(undefined as never);
  const ctx = f.ctx("mensalidade"), day = today(Date.now());
  const plan = await createPlan(ctx, { name: "Plano", amount_cents: 1000, due_day: Number(day.slice(-2)) }, f.actor.id);
  const sub = await createSubscription(ctx, { plan_id: plan.id, phone: "5511999998888", customer_name: "Cliente", start_date: day, end_date: day }, f.actor.id);
  await generateInstallments(ctx, Date.now(), sub.id);
  return { ctx, row: await one(f.env, "SELECT * FROM mensalidade_installments WHERE subscription_id=?", sub.id) };
}
async function booking(f: F, module: "agenda" | "reserva") {
  const ctx = f.ctx(module), conversation = { id: uid(), profile_id: f.profile, external_namespace: "panel", chat_type: "direct", title: "Cliente", phone: "" } as Conversation;
  if (module === "reserva") {
    const unit = await saveUnit(ctx, f.actor, { name: "Unidade", mode: "hourly", kind: "court", price_cents: 1000 });
    return { ctx, row: (await createBooking(ctx, reservaRules, { id: uid(), unit_id: unit.id, starts: future(), duration_minutes: 60, source: "panel", actor: f.actor.id, conversation, deposit: true, staff: true, notify: false })).booking };
  }
  const service = await saveService(ctx, f.actor, { name: "Serviço", duration_minutes: 30, price_cents: 1000 }), pro = uid();
  await exec(f.env, "INSERT INTO agenda_professionals(id,profile_id,name,created,updated) VALUES(?,?,'Equipe',?,?)", pro, f.profile, Date.now(), Date.now());
  const row = (await book(ctx, agendaRules, { id: uid(), service_id: service.id, professional_id: pro, starts: future(), source: "panel", actor: f.actor.id, conversation, force: true, notify: false })).appointment;
  await agendaTrigger(ctx, f.actor, row.id, "charge", {}, uid());
  return { ctx, row };
}
async function order(f: F) {
  return (await createOrder(f.ctx("pedido"), { conversation: null, customer_name: "", source: "panel", sourceKey: uid(),
    lines: [{ item_id: uid(), slot: 0, name: "Produto", quantity: 1, unit_cents: 1000, total_cents: 1000, options: [], note: "" }],
    item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000, fulfillment: "pickup", address: null, note: "", notes: "", actor: f.actor.id })).order;
}
async function support(f: F) {
  const ctx = f.ctx("suporte"), at = Date.now();
  const row = { id: uid(), profile_id: f.profile, conversation_id: uid(), session_id: null, payer_id: null, package_id: "support", price_cents: 1000, status: "pending", created: at };
  await batch(f.env, [
    ["INSERT INTO suporte_purchases(id,profile_id,conversation_id,package_id,package_name,price_cents,mode,method,status,created,updated) VALUES(?,?,?,'support','Suporte',1000,'ticket','link','pending',?,?)", [row.id, f.profile, row.conversation_id, at, at]],
    ...await supportIntegrationStatements(ctx, row, "recognize", at),
  ]);
  return { ctx, row };
}

describe("F3 correção: evidência do núcleo e recuperação real dos produtores", () => {
  it.each(["mensalidade", "pedido", "reserva", "suporte"] as const)("%s: paid pendente seguido de refunded esvazia a fila e conserva ambos os fatos", async module => {
    const f = await fixture();
    const local = module === "mensalidade" ? await monthly(f) : module === "pedido" ? { ctx: f.ctx(module), row: await order(f) }
      : module === "reserva" ? await booking(f, module) : await support(f);
    const p = await payment(f, module, local.row.id, module === "reserva" ? 300 : 1000, local.row.conversation_id ?? uid());
    if (module === "suporte") await exec(f.env, "UPDATE suporte_purchases SET payment_id=? WHERE id=?", p.id, local.row.id);
    let fail = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Só a entrega da porta e a falha são substituídas: o núcleo, evidências,
    // produtor, SQL e alocação executam de verdade, sem ERP falso aprovando-os.
    vi.spyOn(hooks, "paymentHook").mockReturnValue(async (_env, _profile, value, previous) => {
      if (fail) { fail = false; throw new Error("queda antes do gancho"); }
      if (module === "mensalidade") await mensalidadePaid(local.ctx, value, previous);
      else if (module === "pedido") await pedidoPaid(local.ctx, value, previous);
      else if (module === "reserva") await reservaPaid(local.ctx, reservaRules, value, previous);
      else await purchasePaymentUpdated(local.ctx, value);
    });
    const unused = vi.fn(async () => { throw new Error("rede proibida"); });
    providers[providerId] = { id: providerId, name: "Local", methods: ["pix", "link"], getPayment: async () => ({ ...p.remote }), test: unused, createPix: unused, createLink: unused, cancel: unused, verifyWebhook: unused };
    await refreshFromProvider(f.env, p.account, p.remote.id);
    expect(JSON.parse((await p.row()).hook_pending)).toHaveLength(1);
    p.remote.state = "refunded"; p.remote.raw_status = "refunded"; p.remote.refunded_at = Date.now();
    await refreshFromProvider(f.env, p.account, p.remote.id);
    expect((await p.row()).hook_pending).toBeNull();
    await deliverPaymentHooks(f.env, p.id);
    const commercial = await receipts(f);
    expect(commercial.map(r => r.kind)).toEqual(["receive", "reverse"]);
    expect(commercial.every(r => r.method === "pix")).toBe(true);
    expect((await events(f, module)).filter(e => ["receive", "reverse"].includes(e.operation)).map(e => e.operation)).toEqual(["receive", "reverse"]);
    expect(JSON.stringify(commercial)).not.toContain("PRIVADO");
  });

  it("Mensalidade: queda do batch não deixa baixa sem recibo/alocação/saída", async () => {
    const f = await fixture(), local = await monthly(f), p = await payment(f, "mensalidade", local.row.id, 1000);
    const paid = await p.fact("paid"), realBatch = db.batch;
    const fail = vi.spyOn(db, "batch").mockImplementation(async (env, statements) => {
      if (statements.some(([sql]) => sql.includes("UPDATE mensalidade_installments SET status='paid'")))
        return realBatch(env, [...statements, ["SELECT json('queda_simulada')", []]]);
      return realBatch(env, statements);
    });
    await expect(mensalidadePaid(local.ctx, paid, "created")).rejects.toBeDefined();
    expect((await one(f.env, "SELECT status FROM mensalidade_installments WHERE id=?", local.row.id)).status).toBe("open");
    expect(await receipts(f)).toHaveLength(0);
    expect((await events(f, "mensalidade")).filter(e => e.operation === "receive")).toHaveLength(0);
    fail.mockRestore();
    await mensalidadePaid(local.ctx, paid, "created");
    await mensalidadePaid(local.ctx, paid, "created");
    expect(await receipts(f)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it.each(["missing", "conflict"] as const)("contratação de Mensalidade: evidência %s não cria pagador, assinatura, parcela ou aviso", async invalid => {
    const f = await fixture(), ctx = f.ctx("mensalidade"), day = today(Date.now());
    const plan = await createPlan(ctx, { name: "Plano", amount_cents: 1000, due_day: Number(day.slice(-2)), sellable: true }, f.actor.id);
    const contract = await createContract(ctx, { c: { id: uid() } as Conversation, plan, phone: "5511999998888", payer_id: null,
      document: null, name: "Cliente", method: "pix", sourceKey: uid(), actor: f.actor.id });
    const p = await payment(f, "mensalidade", contract.id, 1000, contract.conversation_id);
    let paid: Payment;
    if (invalid === "conflict") {
      paid = await p.fact("paid");
      paid = { ...paid, evidence: { ...paid.evidence!, amount_cents: 2000 } };
    } else {
      await exec(f.env, "UPDATE payments SET status='paid',provider_payment_id=?,paid_at=? WHERE id=?", p.remote.id, p.remote.paid_at, p.id);
      paid = paymentView(await p.row())!;
    }
    vi.mocked(ctx.publish).mockClear();
    await expect(mensalidadePaid(ctx, paid, "created")).rejects.toMatchObject({ code: `payment_evidence_${invalid}` });
    for (const table of ["mensalidade_payers", "mensalidade_subscriptions", "mensalidade_installments"])
      expect(await all(f.env, `SELECT * FROM ${table} WHERE profile_id=?`, f.profile)).toEqual([]);
    expect(await loadContract(ctx, contract.id)).toMatchObject({ status: "pending", payer_id: null, subscription_id: null, installment_id: null });
    expect(await receipts(f)).toEqual([]);
    expect(await events(f, "mensalidade")).toEqual([]);
    expect(ctx.publish).not.toHaveBeenCalled();
  });

  it("primeira Mensalidade usa o instante comprovado e preserva o alias no recebimento e estorno", async () => {
    vi.spyOn(listeners, "announcePaid").mockResolvedValue(undefined);
    vi.spyOn(listeners, "notifyInstallmentRefunded").mockResolvedValue(undefined);
    const f = await fixture(), ctx = f.ctx("mensalidade"), day = today(Date.now());
    const plan = await createPlan(ctx, { name: "Plano", amount_cents: 1000, due_day: Number(day.slice(-2)), sellable: true }, f.actor.id);
    const conversation = { id: uid() } as Conversation;
    const contract = await createContract(ctx, { c: conversation, plan, phone: "5511999998888", payer_id: null,
      document: null, name: "Cliente", method: "link", sourceKey: uid(), actor: f.actor.id });
    const p = await payment(f, "mensalidade", contract.id, 1000, conversation.id);
    ctx.charge = vi.fn(async () => paymentView(await p.row())!);
    await chargeContract(ctx, contract, conversation, "link", "contract-charge");
    const paid = await p.fact("paid"), refunded = await p.fact("refunded");
    // O registro corrente já avançou; o DTO não pode escolher a competência.
    await mensalidadePaid(ctx, { ...paid, paid_at: paid.paid_at! - 40 * 86400000 }, "created");
    await mensalidadePaid(ctx, paid, "created");
    const current = await loadContract(ctx, contract.id);
    expect(current).toMatchObject({ status: "paid", paid_at: paid.evidence!.occurred_ms });
    expect(await all(f.env, "SELECT * FROM mensalidade_payers WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM mensalidade_subscriptions WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM mensalidade_installments WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await one(f.env, "SELECT paid_at,period_key FROM mensalidade_installments WHERE id=?", current.installment_id))
      .toEqual({ paid_at: paid.evidence!.occurred_ms, period_key: today(paid.evidence!.occurred_ms).slice(0, 7) });
    await mensalidadePaid(ctx, refunded, "paid"); await mensalidadePaid(ctx, refunded, "paid");
    expect((await receipts(f)).map(r => r.kind)).toEqual(["receive", "reverse"]);
    const history = await events(f, "mensalidade");
    expect(history.map(e => e.operation)).toEqual(["recognize", "receive", "reverse"]);
    expect(history.every(e => e.source.source_id === `contract:${contract.id}`)).toBe(true);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(2);
    expect((await one(f.env, "SELECT status FROM mensalidade_installments WHERE id=?", current.installment_id)).status).toBe("open");
  });

  it("Mensalidade recupera baixa local antiga bloqueada pela falta do recibo comercial", async () => {
    const f = await fixture(), local = await monthly(f), p = await payment(f, "mensalidade", local.row.id, 1000), paid = await p.fact("paid");
    const legacy = await mensalidadeStatements(local.ctx, { kind: "installment", record: { ...local.row, status: "paid" }, operation: "receive", at: paid.paid_at!, receiptKey: paid.evidence!.receipt_key });
    await batch(f.env, [
      ["UPDATE mensalidade_installments SET status='paid',payment_status='paid',payment_id=?,paid_by='provider',paid_via='link',paid_at=? WHERE id=?", [p.id, paid.paid_at, local.row.id]],
      ...legacy.statements,
    ]);
    expect((await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", legacy.events[0].id)).state).toBe("blocked");
    await mensalidadePaid(local.ctx, paid, "created");
    expect((await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", legacy.events[0].id)).state).toBe("pending");
    expect((await events(f, "mensalidade")).filter(e => e.operation === "receive")).toHaveLength(1);
    expect(await receipts(f)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it.each(["pix", "unknown"] as const)("Pedido por link usa meio comprovado %s", async method => {
    const f = await fixture(), row = await order(f), p = await payment(f, "pedido", row.id, 1000);
    p.remote.verified_method = method;
    const paid = await p.fact("paid");
    await pedidoPaid(f.ctx("pedido"), paid, "created");
    expect((await receipts(f))[0].method).toBe(method);
  });

  it("pagamento legado conclui localmente sem fabricar recibo comercial", async () => {
    const f = await fixture(), row = await order(f), p = await payment(f, "pedido", row.id, 1000);
    await exec(f.env, "UPDATE payments SET status='paid',provider_payment_id=? WHERE id=?", p.remote.id, p.id);
    await batch(f.env, await providerOrderStatements(f.ctx("pedido"), row, p.id));
    expect(await receipts(f)).toEqual([]);
    expect(await one(f.env, "SELECT d.state,d.error_code FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND d.error_code='payment_evidence_required'", f.profile))
      .toMatchObject({ state: "blocked", error_code: "payment_evidence_required" });
    await expect(commercialPaymentEvidence(f.env, f.profile, "pedido", p.id, row.id, "paid")).rejects.toMatchObject({ code: "payment_evidence_missing" });
  });

  it("Mensalidade: recibo comercial isolado não substitui a confirmação persistida pelo núcleo", async () => {
    const f = await fixture(), local = await monthly(f), p = await payment(f, "mensalidade", local.row.id, 1000);
    const fact = await preparePaymentEvidence(f.env, await p.row(), p.remote, Date.now());
    await batch(f.env, [
      ["UPDATE payments SET status='paid',provider_payment_id=?,paid_at=? WHERE id=?", [p.remote.id, p.remote.paid_at, p.id]],
      ...commercialReceiptStatements(commercialReceiptFromEvidence(fact)),
    ]);
    await mensalidadePaid(local.ctx, paymentView(await p.row())!, "created");
    expect((await one(f.env, "SELECT status FROM mensalidade_installments WHERE id=?", local.row.id)).status).toBe("paid");
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE error_code='payment_evidence_required' AND event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile))
      .toMatchObject({ state: "blocked", error_code: "payment_evidence_required" });
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await events(f, "mensalidade")).map(e => e.operation)).toEqual(["recognize", "receive"]);
  });

  it.each(["mensalidade", "pedido", "reserva", "suporte"] as const)("%s: recupera evidência persistida mesmo sem a cópia no DTO", async module => {
    const f = await fixture();
    const local = module === "mensalidade" ? await monthly(f) : module === "pedido" ? { ctx: f.ctx(module), row: await order(f) }
      : module === "reserva" ? await booking(f, module) : await support(f);
    const p = await payment(f, module, local.row.id, module === "reserva" ? 300 : 1000, local.row.conversation_id ?? uid());
    if (module === "suporte") await exec(f.env, "UPDATE suporte_purchases SET payment_id=? WHERE id=?", p.id, local.row.id);
    const fact = (await p.fact("paid")).evidence!;
    const paid = paymentView(await p.row())!;
    expect(paid.evidence).toBeNull();
    const apply = () => module === "mensalidade" ? mensalidadePaid(local.ctx, paid, "created")
      : module === "pedido" ? pedidoPaid(local.ctx, paid, "created")
      : module === "reserva" ? reservaPaid(local.ctx, reservaRules, paid, "created")
      : purchasePaymentUpdated(local.ctx, paid);
    await apply(); await apply();
    expect(await receipts(f)).toHaveLength(1);
    expect((await receipts(f))[0]).toMatchObject({ receipt_key: fact.receipt_key, evidence_hash: fact.evidence_hash, method: "pix" });
    expect((await events(f, module)).filter(e => e.operation === "receive")).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it.each(["mensalidade", "reserva", "suporte"] as const)("%s: legado sem evidência conclui operação local e bloqueia somente ERP", async module => {
    const f = await fixture();
    const local = module === "mensalidade" ? await monthly(f) : module === "reserva" ? await booking(f, module) : await support(f);
    const p = await payment(f, module, local.row.id, module === "reserva" ? 300 : 1000, local.row.conversation_id ?? uid());
    if (module === "suporte") await exec(f.env, "UPDATE suporte_purchases SET payment_id=? WHERE id=?", p.id, local.row.id);
    await exec(f.env, "UPDATE payments SET status='paid',provider_payment_id=? WHERE id=?", p.remote.id, p.id);
    const paid = paymentView(await p.row())!, before = await events(f, module);
    const table = { mensalidade: "mensalidade_installments", reserva: "reserva_bookings", suporte: "suporte_purchases" }[module];
    const apply = () => module === "mensalidade" ? mensalidadePaid(local.ctx, paid, "created")
      : module === "reserva" ? reservaPaid(local.ctx, reservaRules, paid, "created") : purchasePaymentUpdated(local.ctx, paid);
    await apply(); await apply();
    expect(await one(f.env, `SELECT * FROM ${table} WHERE id=?`, local.row.id)).toMatchObject({ status: module === "reserva" ? "confirmed" : "paid" });
    const pending = await all(f.env, "SELECT d.state,d.error_code FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND e.module_id=? AND d.error_code='payment_evidence_required'", f.profile, module);
    expect(pending).toEqual([{ state: "blocked", error_code: "payment_evidence_required" }]);
    expect((await events(f, module)).slice(0, before.length)).toEqual(before);
    expect(await receipts(f)).toEqual([]);
  });

  it("o replay recusa mudança explícita de meio, inclusive unknown, sem apagar a evidência", async () => {
    const f = await fixture(), p = await payment(f, "pedido", uid(), 1000);
    vi.spyOn(hooks, "paymentHook").mockReturnValue(async () => undefined);
    const unused = vi.fn(async () => { throw new Error("rede proibida"); });
    providers[providerId] = { id: providerId, name: "Local", methods: ["pix", "link"], getPayment: async () => ({ ...p.remote }),
      test: unused, createPix: unused, createLink: unused, cancel: unused, verifyWebhook: unused };
    p.remote.verified_method = undefined;
    await refreshFromProvider(f.env, p.account, p.remote.id);
    const original = await all(f.env, "SELECT payload FROM events WHERE profile_id=? AND kind='payment.evidence'", f.profile);
    await refreshFromProvider(f.env, p.account, p.remote.id);
    p.remote.verified_method = "card";
    await expect(refreshFromProvider(f.env, p.account, p.remote.id)).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect(await all(f.env, "SELECT payload FROM events WHERE profile_id=? AND kind='payment.evidence'", f.profile)).toEqual(original);
  });
});

describe("F3 correção: ordem comercial e desligamento", () => {
  it.each(["agenda", "reserva"] as const)("%s: cancelamento operacional pago aguarda todas as devoluções", async module => {
    const f = await fixture(), { ctx, row } = await booking(f, module);
    await manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 300, method: "cash" }, "first");
    await manualBookingReceipt(ctx, f.actor, module, row.id, { amount_cents: 200, method: "cash" }, "second");
    if (module === "agenda") await cancelAppointment(ctx, agendaRules, { id: row.id, actor: f.actor.id, notify: false });
    else await cancelBooking(ctx, reservaRules, { id: row.id, actor: f.actor.id, notify: false });
    expect((await events(f, module)).filter(e => e.operation === "cancel" && e.seq !== null)).toEqual([]);
    const localCancellation = (await events(f, module)).find(e => e.operation === "cancel");
    expect(localCancellation).toMatchObject({ seq: null, eligible: { finance: false }, reason_code: "module_cancellation_pending" });
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", localCancellation.id)).toMatchObject({ state: "blocked", error_code: "module_cancellation_pending" });
    const originals = await receipts(f);
    await reverseBookingReceipt(ctx, f.actor, originals[0], { reason_code: "manual_void", command: "r1" });
    expect((await events(f, module)).filter(e => e.operation === "cancel" && e.seq !== null)).toEqual([]);
    await reverseBookingReceipt(ctx, f.actor, originals[1], { reason_code: "manual_void", command: "r2" });
    await reverseBookingReceipt(ctx, f.actor, originals[1], { reason_code: "manual_void", command: "r2" });
    expect((await events(f, module)).filter(e => e.seq !== null).map(e => e.operation)).toEqual(["recognize", "receive", "receive", "reverse", "reverse", "cancel"]);
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", localCancellation.id)).toMatchObject({ state: "done", error_code: "cancellation_resolved" });
  });

  it.each(["agenda", "reserva"] as const)("%s: recebimento com Financeiro desligado mantém evento durável sem reconhecer passado", async module => {
    const f = await fixture(), active = await booking(f, module);
    await setParts(f.profile, { "erp-financeiro": false });
    await manualBookingReceipt(active.ctx, f.actor, module, active.row.id, { amount_cents: 300, method: "cash" }, "off");
    const receive = (await events(f, module)).find(e => e.operation === "receive");
    expect(receive).toMatchObject({ eligible: { finance: true } });
    expect(await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", receive.id)).toBeTruthy();
    await setParts(f.profile, { "erp-financeiro": true });
    await manualBookingReceipt(active.ctx, f.actor, module, active.row.id, { amount_cents: 300, method: "cash" }, "off");
    expect((await events(f, module)).filter(e => e.operation === "receive")).toHaveLength(1);
    const g = await fixture(); await setParts(g.profile, { "erp-financeiro": false });
    const historical = await booking(g, module); await setParts(g.profile, { "erp-financeiro": true });
    await manualBookingReceipt(historical.ctx, g.actor, module, historical.row.id, { amount_cents: 300, method: "cash" }, "old");
    const historicalEvents = (await events(g, module)).filter(e => ["recognize", "receive"].includes(e.operation));
    expect(historicalEvents).toHaveLength(1);
    expect(historicalEvents[0]).toMatchObject({ operation: "receive", seq: null, eligible: { document: false, stock: false, finance: false } });
    expect(await one(g.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", historicalEvents[0].id)).toMatchObject({ state: "blocked", error_code: "historical_origin_unlinked" });
  });

  it("Reserva expirada revive com unidade livre e mantém recomposição ERP pendente", async () => {
    const f = await fixture(), { ctx, row } = await booking(f, "reserva"), p = await payment(f, "reserva", row.id, 300);
    await expireBooking(ctx, reservaRules, row.id, { reason: "deadline" });
    const paid = await p.fact("paid");
    await reservaPaid(ctx, reservaRules, paid, "expired"); await reservaPaid(ctx, reservaRules, paid, "expired");
    expect(await one(f.env, "SELECT status,payment_status FROM reserva_bookings WHERE id=?", row.id)).toEqual({ status: "confirmed", payment_status: "paid" });
    expect(await receiptBalance(ctx, commercialSource(ctx, "reserva", row.id))).toMatchObject({ received_cents: 300, allocated_cents: 0, excess_cents: 300 });
    expect((await events(f, "reserva")).map(e => e.operation)).toEqual(["recognize", "cancel", "receive"]);
  });

  it("Suporte expirado libera atendimento sem título novo e exige recomposição ERP", async () => {
    const f = await fixture(), { ctx, row } = await support(f), p = await payment(f, "suporte", row.id, 1000, row.conversation_id);
    await exec(f.env, "INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,'panel',?,'',?,?,?,?)", row.conversation_id, f.profile, row.conversation_id, uid(), Date.now(), Date.now(), Date.now());
    vi.mocked(ctx.conversation).mockResolvedValue(await one(f.env, "SELECT * FROM conversations WHERE id=?", row.conversation_id));
    ctx.activeTicket = vi.fn(async () => ({ id: uid(), number: "1" }) as any);
    ctx.handoff = vi.fn(async () => undefined); ctx.recordConsent = vi.fn(async () => undefined);
    await exec(f.env, "UPDATE suporte_purchases SET payment_id=? WHERE id=?", p.id, row.id);
    await purchasePaymentUpdated(ctx, { ...paymentView(await p.row())!, status: "expired" });
    const paid = await p.fact("paid");
    await purchasePaymentUpdated(ctx, paid); await purchasePaymentUpdated(ctx, paid);
    expect(await one(f.env, "SELECT status,attention FROM suporte_purchases WHERE id=?", row.id)).toEqual({ status: "paid", attention: null });
    expect(await all(f.env, "SELECT * FROM suporte_releases WHERE profile_id=? AND status='active'", f.profile)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toEqual([]);
    expect((await events(f, "suporte")).map(e => e.operation)).toEqual(["recognize", "cancel", "receive"]);
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE error_code='obligation_reactivation_required' AND event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile)).toMatchObject({ state: "blocked", error_code: "obligation_reactivation_required" });
    await purchasePaymentUpdated(ctx, await p.fact("refunded"));
    expect((await receipts(f)).map(r => r.kind)).toEqual(["receive", "reverse"]);
  });

  it("Agenda: ausência conserva a cobrança antecipada", async () => {
    const f = await fixture(), { ctx, row } = await booking(f, "agenda"), before = await events(f, "agenda");
    await noShow(ctx, { id: row.id, actor: f.actor.id, at: row.starts + 1 });
    expect(await events(f, "agenda")).toEqual(before);
    expect((await one(f.env, "SELECT status FROM agenda_appointments WHERE id=?", row.id)).status).toBe("no_show");
  });

  it("Mesas cancela taxa junto ao pedido e recolhe componentes restantes ao encerrar", async () => {
    const f = await fixture(), ctx = f.ctx("mesas"), tab = uid(), table = uid(), category = uid(), item = uid(), at = Date.now();
    await batch(f.env, [
      ["INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,'Mesa',?,?)", [table, f.profile, at, at]],
      ["INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,1,?,'Mesa','open',1,100,?,?,?,?)", [tab, f.profile, table, f.actor.id, at, at, at]],
      ["INSERT INTO pedido_categories(id,profile_id,name,created,updated) VALUES(?,?,'Menu',?,?)", [category, f.profile, at, at]],
      ["INSERT INTO pedido_items(id,profile_id,category_id,name,price_cents,created,updated) VALUES(?,?,?,'Produto',1000,?,?)", [item, f.profile, category, at, at]],
    ]);
    await sendOrder(ctx, f.actor, { id: tab, items: [{ item_id: item, quantity: 1 }] }, uid());
    const row = await one(f.env, "SELECT * FROM pedido_orders WHERE tab_id=?", tab);
    await moveOrder(f.ctx("pedido"), row, "cancelled", f.actor.id, "", {}, { notify: false });
    expect((await events(f, "mesas")).filter(e => e.operation === "cancel" && e.source.component.startsWith("service:"))).toHaveLength(1);
    // Componente residual de uma instalação anterior: cancelTab também o recolhe.
    const residual = new CommercePlan(ctx, f.actor.id);
    const tabRow = await one(f.env, "SELECT * FROM mesas_tabs WHERE id=?", tab);
    await serviceComponents(ctx, tabRow, 100, residual);
    await batch(f.env, residual.statements());
    await cancelTab(ctx, f.actor, { id: tab });
    expect((await events(f, "mesas")).filter(e => e.operation === "cancel" && e.source.component.startsWith("service:"))).toHaveLength(2);
  });
});

describe("F3 correção: consulta do Mercado Pago", () => {
  it.each([
    [{ payment_method_id: "pix", payment_type_id: "bank_transfer" }, "pix"],
    [{ payment_type_id: "credit_card" }, "card"],
    [{}, "unknown"],
  ])("usa só o meio da resposta consultada", async (method, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "remote", status: "approved", transaction_amount: 10, currency_id: "BRL", ...method }))));
    expect((await mercadoPago.getPayment({ access_token: "test", webhook_secret: "test" }, "remote")).verified_method).toBe(expected);
  });
  it.each([undefined, 3])("devolução parcial sem total comprovado (%s) fica em conferência manual no núcleo", async refunded => {
    const f = await fixture(), p = await payment(f, "pedido", uid(), 1000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: p.remote.id, status: "refunded", status_detail: "partially_refunded", external_reference: p.id, transaction_amount: 10, transaction_amount_refunded: refunded, currency_id: "BRL" }))));
    const queried = await mercadoPago.getPayment({ access_token: "test", webhook_secret: "test" }, p.remote.id);
    expect(queried.refund_review_required).toBe(true);
    providers[providerId] = { ...mercadoPago, getPayment: async () => queried };
    expect(await refreshFromProvider(f.env, p.account, p.remote.id)).toMatchObject({ review_required: true, ignored: "refund_amount_unconfirmed" });
    expect(paymentView(await p.row())).toMatchObject({ status: "created", review_required: true });
    expect(await all(f.env, "SELECT * FROM events WHERE profile_id=? AND kind='payment.refund_review'", f.profile)).toHaveLength(1);
    expect(await receipts(f)).toEqual([]);
  });
  it("reembolso parcial ainda approved mantém o pagamento original e não cria estorno integral", async () => {
    const f = await fixture(), p = await payment(f, "pedido", uid(), 1000);
    await p.fact("paid");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: p.remote.id, status: "approved",
      status_detail: "partially_refunded", external_reference: p.id, transaction_amount: 10,
      transaction_amount_refunded: 3, currency_id: "BRL", payment_method_id: "pix" }))));
    const queried = await mercadoPago.getPayment({ access_token: "test", webhook_secret: "test" }, p.remote.id);
    providers[providerId] = { ...mercadoPago, getPayment: async () => queried };
    await refreshFromProvider(f.env, p.account, p.remote.id);
    expect(paymentView(await p.row())).toMatchObject({ status: "paid", review_required: true, review_reason: "refund_amount_unconfirmed" });
    const facts = await all(f.env, "SELECT payload FROM events WHERE profile_id=? AND kind='payment.evidence'", f.profile);
    expect(facts).toHaveLength(1);
    expect(JSON.parse(facts[0].payload)).toMatchObject({ kind: "receive", amount_cents: 1000 });
    expect(await receipts(f)).toEqual([]);
  });
});

// Mesmo hospedeiro de hooks usado em f3-painel; elementos React reais, sem DOM.
import React from "react";
import { createIntegrationApi, type IntegrationApi } from "../web/modules/integrations/api";
import { installIntegrationHost } from "../web/modules/integrations/visibility";
import { DeliveryCommercialForm, AppointmentCommercialActions } from "../web/modules/integrations/ReceiptForm";
import { integrationSourceView } from "../src/integrations/routes";
import { acquireIntegrationLease, confirmIntegrationResult } from "../src/integrations/outbox";
import { IntegrationStatus } from "../web/modules/integrations/IntegrationStatus";
import { WorkCommercialPanel } from "../web/modules/os/work/WorkCommercialPanel";
import { createOrder as createWork, changeStatus, loadOrder as loadWork } from "../src/modules/os/store";
import { workCommercialView, patchWorkCommercial } from "../src/modules/os/commercial/routes";
import { entregaConfig } from "../src/modules/entrega/config";
const runtime = vi.hoisted(() => ({ owner: null as any, api: null as IntegrationApi | null }));
vi.mock("../web/modules/integrations/api", async original => ({ ...await original<typeof import("../web/modules/integrations/api")>(), useIntegrationApi: () => runtime.api }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  const state = (initial: any) => {
    const owner = runtime.owner, i = owner.index++;
    if (!(i in owner.slots)) owner.slots[i] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[i], (next: any) => { owner.slots[i] = typeof next === "function" ? next(owner.slots[i]) : next; }];
  };
  return { ...actual, useState: state, useMemo: (f: () => any) => f(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useCallback: (fn: unknown) => fn, useEffect: (run: () => any, deps: unknown[]) => {
    const owner = runtime.owner, i = owner.index++, previous = owner.effects[i];
    if (previous && previous.deps.length === deps.length && deps.every((v, j) => Object.is(v, previous.deps[j]))) return;
    previous?.cleanup?.(); owner.effects[i] = { deps }; owner.pending.push(() => { owner.effects[i].cleanup = run(); });
  } };
});
const ticks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function panel(f: F, request: any, render: () => any) {
  const context = { statusLoaded: true, role: "admin" as const, erpRole: "admin" as const, access: null,
    modules: Object.fromEntries(["os", "pedido", "agenda", "entrega", "erp", "erp-vendas", "erp-produtos", "erp-estoque", "erp-financeiro"].map(m => [m, true])) };
  const root = `v1/profiles/${f.profile}`;
  cleanups.push(installIntegrationHost({ context, api: request, root, actor: f.actor.id, generation: 1 }));
  const values = new Map<string, string>();
  runtime.api = createIntegrationApi(request, root, () => context, f.actor.id, { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: k => { values.delete(k); } });
  const owner = { slots: [] as any[], effects: [] as any[], pending: [] as (() => void)[], index: 0 };
  cleanups.push(() => { owner.effects.forEach(e => e?.cleanup?.()); runtime.api = null; runtime.owner = null; });
  const draw = () => { runtime.owner = owner; owner.index = 0; const result = render(); owner.pending.splice(0).forEach(run => run()); return result; };
  // D1 promises cross tasks; wait on the actual server request, not a timer.
  return { draw, async settle() { draw(); await ticks(); return draw(); } };
}
function nodes(tree: any): any[] { if (!tree || typeof tree !== "object") return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...nodes(tree.props?.children)]; }
function text(tree: any): string { if (tree == null || typeof tree === "boolean") return ""; if (typeof tree !== "object") return String(tree); return Array.isArray(tree) ? tree.map(text).join(" ") : text(tree.props?.children); }
const button = (tree: any, label: string) => nodes(tree).find(n => n.props?.onClick && text(n) === label);

describe("F3 correção: telas usam contratos reais do servidor", () => {
  it("servidor e componente preservam Financeiro manual quando Estoque já confirmou", async () => {
    const f = await fixture(), ctx = f.ctx("os");
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false')) WHERE profile_id=?", f.profile);
    const row = (await createWork(ctx, { item: "Notebook", problem: "Não liga", phone: "5511999999988", customer_name: "Cliente", source: "panel", sourceKey: uid(), actor: f.actor.id, notify: false })).order;
    await patchWorkCommercial(ctx, f.actor, row.id, { version: row.row_version, items: [{ description: "Peça", quantity: 1, unit_cents: 1000, kind: "material" }], authorize_fixed_price: true }, uid());
    await changeStatus(ctx, await loadWork(ctx, row.id), "in_progress", f.actor.id, "", { notify: false });
    // A porta de transporte confirma os efeitos; o DTO vem da projeção real D1.
    for (const event of (await events(f, "os")).filter(e => e.seq !== null)) {
      const token = await acquireIntegrationLease(f.env, event.id);
      expect(token).toBeTruthy();
      await confirmIntegrationResult(f.env, event, token!, { command_id: event.command_id, seq: event.seq, replayed: false, outcome: "applied",
        links: [{ slot: "main:document", kind: "document", id: uid(), version: event.seq }],
        effects: { stock: "posted", finance: "not_requested" }, reason_code: null });
    }
    const source = { profile: f.profile, module: "os" as const, source_id: row.id, component: "main" };
    const view = await integrationSourceView(f.env, f.actor, source);
    expect(view).toMatchObject({ state: "skipped", skipped_reason: "automation_off", pending: true, manual_destinations: ["finance"] });
    expect(view.applied).toContain("stock");
    expect(view.deliveries[0].seq).toBeNull();
    const screen = panel(f, async () => view, () => IntegrationStatus({ module: "os", sourceId: row.id }));
    const content = text(await screen.settle());
    expect(content).toContain("Estoque");
    expect(content).toContain("Lançar financeiro manualmente");
    expect(content).not.toContain("Confirmado no ERP");
  });
  it("Trabalho mostra o DTO plano e a autorização usa version operacional", async () => {
    const f = await fixture(), ctx = f.ctx("os");
    const created = await createWork(ctx, { item: "Notebook", problem: "Não liga", phone: "5511999999988", customer_name: "Cliente", source: "panel", sourceKey: uid(), actor: f.actor.id, type_id: "service_order", notify: false });
    const row = created.order;
    // Preço fixo é autorizado antes de enviar um orçamento ao cliente.
    // saveQuote muda para quoted, estado em que o servidor exige outro fluxo.
    const initial = await workCommercialView(ctx, f.actor, row.id);
    await patchWorkCommercial(ctx, f.actor, row.id, { version: initial.version,
      items: [{ description: "Reparo", quantity: 1, unit_cents: 1000 }] }, "screen-work-items");
    const view = await workCommercialView(ctx, f.actor, row.id);
    let saved: Promise<unknown> | undefined;
    const request = vi.fn(async (_path: string, method: string, body: any) => method === "PATCH"
      ? await (saved = patchWorkCommercial(ctx, f.actor, row.id, body, "screen-work")) : view);
    const screen = panel(f, request, () => WorkCommercialPanel({ workId: row.id }));
    button(screen.draw(), "Conferir dados comerciais").props.onClick();
    let tree = await screen.settle(); expect(text(tree)).toContain("Reparo");
    nodes(tree).find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } });
    button(screen.draw(), "Confirmar autorização de preço fixo").props.onClick(); await ticks(); await saved;
    expect(request.mock.calls.find(c => c[1] === "PATCH")?.[2]).toEqual({ version: view.version, authorize_fixed_price: true });
    expect((await workCommercialView(ctx, f.actor, row.id)).authorization?.kind).toBe("fixed_price");
  });

  it("Entrega lê version/authorized_at e envia authorize aceito pelo servidor", async () => {
    const f = await fixture(), ctx = f.ctx("entrega"), row = await createDelivery(ctx, f.actor, { label: "Entrega", source: "manual" }, "create");
    const raw = await one(f.env, "SELECT * FROM entrega_deliveries WHERE id=?", row.id);
    const view = deliveryView(raw!, entregaConfig({}));
    let saved: Promise<unknown> | undefined;
    const request = vi.fn(async (_path: string, method: string, body: any) => method === "PATCH"
      ? await (saved = updateDeliveryCommercial(ctx, f.actor, { ...body, id: row.id }, "screen-delivery")) : view);
    const screen = panel(f, request, () => DeliveryCommercialForm({ id: row.id }));
    let tree = await screen.settle();
    nodes(tree).find(n => n.props?.label === "Preço contratado (R$)").props.onChange("10,00");
    nodes(tree).find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } });
    button(screen.draw(), "Confirmar preço e autorização").props.onClick(); await ticks(); await saved;
    expect(request.mock.calls.find(c => c[1] === "PATCH")?.[2]).toEqual({ version: view.commercial.version, price_cents: 1000, authorize: true });
    const current = deliveryView((await one(f.env, "SELECT * FROM entrega_deliveries WHERE id=?", row.id))!, entregaConfig({}));
    expect(current.commercial.authorized_at).toBeGreaterThan(0);
    const authorized = panel(f, async () => current, () => DeliveryCommercialForm({ id: row.id }));
    tree = await authorized.settle();
    expect(nodes(tree).find(n => n.type === "input" && n.props.type === "checkbox").props.checked).toBe(true);
    expect(text(tree)).toContain("Preço e autorização registrados");
  });

  it.each([
    ["none", null, "Sem lançamento no ERP"],
    ["skipped", "part_disabled", "A parte necessária estava desligada"],
    ["skipped", "automation_off", "A automação estava desligada"],
    ["blocked", "historical_origin_unlinked", "sem criar dívida retroativa"],
    ["uncertain", null, "a resposta se perdeu"],
    ["done", null, "Financeiro, Documento"],
  ])("estado %s só apresenta confirmação para done", async (state, reason, expected) => {
    const f = await fixture(), view = { source: f.source, revision: 1, confirmed_ms: null, state, pending: ["blocked", "uncertain"].includes(state!),
      skipped_reason: reason, blocked_reason: reason, applied: state === "done" ? ["finance", "document"] : [], deliveries: [], links: [], manual_destinations: [] };
    const screen = panel(f, async () => view, () => IntegrationStatus({ module: "os", sourceId: "work" }));
    const content = text(await screen.settle());
    expect(content).toContain(expected!); expect(content.includes("Confirmado no ERP")).toBe(state === "done");
  });

  it("explica que a ausência mantém cobrança antecipada", async () => {
    const f = await fixture();
    const screen = panel(f, vi.fn(), () => AppointmentCommercialActions({ id: "appointment", version: 1, priceCents: 1000, onSaved() {} }));
    expect(text(screen.draw())).toContain("Marcar ausência mantém a cobrança antecipada devida");
  });
});

describe("F3 correção: produtores irmãos preservam recebimento durante corte", () => {
  it.each(["mensalidade", "suporte", "pedido", "entrega"] as const)("%s mantém a elegibilidade financeira da obrigação anterior", async module => {
    const f = await fixture();
    let run: () => Promise<unknown>;
    if (module === "mensalidade") {
      const local = await monthly(f), p = await payment(f, module, local.row.id, 1000), paid = await p.fact("paid");
      run = () => mensalidadePaid(local.ctx, paid, "created");
    } else if (module === "suporte") {
      const local = await support(f), p = await payment(f, module, local.row.id, 1000, local.row.conversation_id), paid = await p.fact("paid");
      await exec(f.env, "UPDATE suporte_purchases SET payment_id=? WHERE id=?", p.id, local.row.id);
      run = () => purchasePaymentUpdated(local.ctx, paid);
    } else if (module === "pedido") {
      const ctx = f.ctx(module), initial = await order(f);
      const row = await moveOrder(ctx, initial, "received", f.actor.id, "", {}, { notify: false });
      const p = await payment(f, module, row.id, 1000), paid = await p.fact("paid");
      run = () => pedidoPaid(ctx, paid, "created");
    } else {
      const ctx = f.ctx(module), row = await createDelivery(ctx, f.actor, { label: "Entrega" }, "create");
      await updateDeliveryCommercial(ctx, f.actor, { id: row.id, version: 0, price_cents: 1000, authorize: true }, "authorize");
      run = () => receiveDelivery(ctx, f.actor, { id: row.id, amount_cents: 1000, method: "cash" }, "received");
    }
    await setParts(f.profile, { "erp-financeiro": false });
    await run(); await run();
    const received = (await events(f, module)).filter(e => e.operation === "receive");
    expect(received).toHaveLength(1); expect(received[0].eligible.finance).toBe(true);
  });

  it("Mesas herda o mesmo recebimento durável por componente", async () => {
    const f = await fixture(), ctx = f.ctx("mesas"), tab = uid(), table = uid(), category = uid(), item = uid(), at = Date.now();
    await batch(f.env, [
      ["INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,'Mesa',?,?)", [table, f.profile, at, at]],
      ["INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,1,?,'Mesa','open',0,100,?,?,?,?)", [tab, f.profile, table, f.actor.id, at, at, at]],
      ["INSERT INTO pedido_categories(id,profile_id,name,created,updated) VALUES(?,?,'Menu',?,?)", [category, f.profile, at, at]],
      ["INSERT INTO pedido_items(id,profile_id,category_id,name,price_cents,created,updated) VALUES(?,?,?,'Produto',1000,?,?)", [item, f.profile, category, at, at]],
    ]);
    await sendOrder(ctx, f.actor, { id: tab, items: [{ item_id: item, quantity: 1 }] }, "order");
    await setParts(f.profile, { "erp-financeiro": false });
    await addPayment(ctx, f.actor, { id: tab, amount_cents: 1000, method: "cash" }, "received");
    await addPayment(ctx, f.actor, { id: tab, amount_cents: 1000, method: "cash" }, "received");
    const received = (await events(f, "mesas")).filter(e => e.operation === "receive");
    expect(received).toHaveLength(1); expect(received[0].eligible.finance).toBe(true);
  });

  it("Suporte cancela efeitos anteriores mesmo com automação financeira desligada", async () => {
    const f = await fixture(), local = await support(f);
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false')) WHERE profile_id=?", f.profile);
    await batch(f.env, await supportIntegrationStatements(local.ctx, { ...local.row, status: "cancelled" }, "cancel", Date.now()));
    const cancelled = (await events(f, "suporte")).find(e => e.operation === "cancel");
    expect(cancelled.reason_code).not.toBe("manual_requested");
    expect((await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", cancelled.id)).state).not.toBe("waiting_manual");
  });
});
