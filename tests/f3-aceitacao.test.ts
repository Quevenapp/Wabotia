import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/modules/runtime";
// O motor é real. Carregar o grafo pesado na coleta evita cobrar a compilação
// inicial do Vite apenas do primeiro cenário; cada área ainda migra seu SQLite.
import "../src/erp/hub-engine";
import { all, batch, exec, one } from "../src/db";
import * as database from "../src/db";
import { uid, type Actor, type Conversation } from "../src/types";
import { modulesApi } from "../src/modules/api";
import * as hub from "../src/erp/hub";
import { erpIdentity, erpSystemIdentity } from "../src/modules/erp/identity";
import { GATE_HEADER, IDENTITY_HEADER, SYSTEM_HEADER, encodeIdentity } from "../src/erp/engine/identity";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import { applyErpRequest, closeErpCommand, getErpOrigin, prepareErpRequest } from "../src/integrations/erp-adapter";
import { acquireIntegrationLease, confirmIntegrationResult, persistPreparedRequest, readPreparedRequest } from "../src/integrations/outbox";
import { integrationCommand, integrationOperation, integrationResourceRoute, integrationSourceView } from "../src/integrations/routes";
import { canonical } from "../src/integrations/keys";
import type { IntegrationEvent, SourceRef } from "../src/integrations/contracts";
import { createOrder as createWork, changeStatus, decide, loadOrder as loadWork, saveQuote, sendQuote } from "../src/modules/os/store";
import { patchWorkCommercial, workCommercialView } from "../src/modules/os/commercial/routes";
import { createOrder, moveOrder } from "../src/modules/pedido/orders";
import { markPaid } from "../src/modules/pedido/manage";
import { addPayment, closeTab, sendOrder } from "../src/modules/mesas/tabs";
import { createPlan, createSubscription } from "../src/modules/mensalidade/store";
import { generateInstallments, payManually } from "../src/modules/mensalidade/installments";
import { today } from "../src/modules/mensalidade/model";
import { agendaTrigger, manualBookingReceipt } from "../src/modules/agenda/integration";
import { createBooking } from "../src/modules/reserva/bookings";
import { saveUnit } from "../src/modules/reserva/units";
import { addDays, atClock, brasiliaDate, reservaConfig } from "../src/modules/reserva/config";
import { createDelivery, cancel as cancelDelivery } from "../src/modules/entrega/store";
import { reverseCommercialReceipt } from "../src/integrations/receipts";
import { updateDeliveryCommercial } from "../src/modules/entrega/integration";
import { receiveDelivery } from "../src/modules/entrega/integration";
import { patchCommercialPolicy } from "../src/integrations/policy";
import { pendingPaymentStatements } from "../src/payments-commercial-evidence";
import { supportIntegrationStatements } from "../src/modules/suporte/integration";
import { purchasePaymentUpdated } from "../src/modules/suporte/store";
import { paymentView } from "../src/payments";
import { preparePaymentEvidence, paymentEvidenceStatements } from "../src/integrations/payment-evidence";
import { requestDecided } from "../src/modules/mensalidade/requests";
import { ensureCharge, paymentUpdated as mensalidadePaymentUpdated } from "../src/modules/mensalidade/billing";
import { mensalidadeSettings } from "../src/modules/mensalidade/model";
import { bearer } from "./service-center-fixture";
import { due, f3Fixture, setParts } from "./helpers/f3-fixtures";

// Não usa installFakeErp nem installFixtureProducer. D1, produtores, adaptador,
// identidade, transporte e Coordinator ERP são reais. Só mensagens externas e
// pontos explícitos de queda são substituídos.
afterEach(() => vi.restoreAllMocks());
const quiet = { notify: false };
async function setup(automation = true) {
  const f = await f3Fixture(automation);
  f.actor.sessionId = uid();
  await setParts(f.profile, { pedido: true, mesas: true, entrega: true, mensalidade: true, agenda: true, reserva: true, suporte: true }, Date.now() - 1000);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const identity = await erpIdentity(f.env, f.actor, f.profile, "POST");
    const response = await hub.erpFetch(f.env, f.profile, `/erp-rpc/${name}`, {
      method: "POST", headers: { "Content-Type": "application/json", [GATE_HEADER]: "1", [SYSTEM_HEADER]: "1", [IDENTITY_HEADER]: encodeIdentity(identity) },
      body: JSON.stringify({ p_user_id: f.actor.id, ...args }),
    });
    const body = await response.json<any>();
    expect(response.status, JSON.stringify(body)).toBe(200); return body;
  };
  const catalog = async (entity: string, data: unknown) => (await rpc("erp_catalog_save", {
    p_entity: entity, p_id: null, p_expected_version: 0, p_command_id: uid(), p_data: data,
  })).record;
  const customer = await catalog("contacts", { name: "Cliente", person_type: "J", roles: ["customer"] });
  const product = await catalog("products", { name: "Peça", unit: "UN", kind: "P", format: "S", price: "10" });
  const warehouse = await catalog("warehouses", { name: "Depósito" });
  const category = (await rpc("erp_finance_category_execute", { p_command_id: uid(), p_action: "category_create", p_data: { kind: "receivable", name: "Serviços" } })).record;
  const account = (await rpc("erp_finance_account_execute", { p_command_id: uid(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa", start_on: "2020-01-01", opening_cents: "0" } })).record;
  await rpc("erp_stock_post", { p_command_id: uid(), p_kind: "receipt", p_occurred_on: today(Date.now()), p_reason: "Entrada de teste", p_reference: null,
    p_items: [{ product_id: product.id, warehouse_id: warehouse.id, quantity: "100", expected_version: 0 }] });
  await exec(f.env, "UPDATE contacts SET erp_contact_id=? WHERE id=?", customer.id, f.local);
  const policy = { ...f.policy, warehouse_id: warehouse.id, revenue_category_id: category.id, consumer_contact_id: customer.id,
    settlement_accounts: { cash: account.id, pix: account.id, card: account.id, unknown: account.id } };
  const { profile: _, version: __, ...config } = policy;
  await exec(f.env, "UPDATE module_erp_policy SET config_json=? WHERE profile_id=?", canonical(config), f.profile);
  const ctx = (module: string) => ({ ...modulesApi(f.env, f.profile, module),
    publish: vi.fn(async () => 1), sendMessage: vi.fn(async () => "sent"), sendInteractive: vi.fn(async () => "sent"), note: vi.fn(async () => undefined) });
  const sql = (query: string, ...bindings: (string | number | null)[]) => runInDurableObject(hub.erpStub(f.env, f.profile), (_instance: unknown, state: DurableObjectState) => state.storage.sql.exec(query, ...bindings).toArray() as any[]);
  const count = async (table: "erp_documents__document" | "erp_finance__title" | "erp_finance__settlement" | "erp_stock__document_posting") => Number((await sql(`SELECT count(*) n FROM ${table}`))[0].n);
  return { ...f, customer: customer.id as string, policy, product, warehouse, account, category, rpc, ctx, sql, count };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

describe("Segunda revisão — Worker, produtores e Coordinator reais", () => {
  it("Mensalidade reconcilia paid histórico reembolsado sem liberar Suporte e revoga antes de avisar", async () => {
    const f = await setup(), ctx = f.ctx("mensalidade"), payer = uid(), at = Date.now(), day = today(at), c = await conversation(f);
    await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer, f.profile, f.local, f.actor.id, at, at);
    const plan = await createPlan(ctx, { name: "Plano", amount_cents: 1000, due_day: Number(day.slice(-2)) }, f.actor.id);
    const sub = await createSubscription(ctx, { plan_id: plan.id, payer_id: payer, phone: "5511999998888", customer_name: "Cliente", start_date: day, end_date: day }, f.actor.id);
    await generateInstallments(ctx, at, sub.id); await pump(f);
    const inst = await one(f.env, "SELECT * FROM mensalidade_installments WHERE subscription_id=?", sub.id), id = uid(), remote = uid();
    await exec(f.env, "INSERT INTO suporte_sessions(id,profile_id,conversation_id,step,offer_kind,installment_id,expires_at,created,updated) VALUES(?,?,?,'awaiting_payment','installment',?,?,?,?)", uid(), f.profile, c.id, inst.id, at + 60000, at, at);
    await exec(f.env, "INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated) VALUES(?,?,?,?,'fake','link','mensalidade',?,'Serviço',1000,'paid',?,'module','system',?,?,?,?)", id, f.profile, c.id, uid(), inst.id, remote, at + 60000, at, at, at);
    for (const state of ["paid", "refunded"] as const) {
      const evidence = await preparePaymentEvidence(f.env, await one(f.env, "SELECT * FROM payments WHERE id=?", id), { id: remote, state, amount_cents: 1000, currency: "BRL", paid_at: at, verified_method: "pix", refunded_at: state === "refunded" ? at + 1 : null }, at + 1);
      await batch(f.env, [["UPDATE payments SET status=? WHERE id=?", [state, id]], ...paymentEvidenceStatements(evidence)]);
    }
    ctx.publish.mockClear(); ctx.sendMessage.mockClear();
    ctx.publish.mockRejectedValue(new Error("aviso indisponível")); ctx.sendMessage.mockRejectedValue(new Error("comprovante indisponível"));
    const payment = paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id))!;
    await mensalidadePaymentUpdated(ctx, { ...payment, status: "paid" }, "created");
    expect(ctx.publish).not.toHaveBeenCalled(); expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(await all(f.env, "SELECT * FROM suporte_releases WHERE profile_id=?", f.profile)).toEqual([]);
    // Liberação que já tivesse sido entregue antes da queda também é revogada.
    const release = uid();
    await exec(f.env, "INSERT INTO suporte_releases(id,profile_id,conversation_id,kind,ref_id,actor,source_key,created) VALUES(?,?,?,'installment',?,'provider',?,?)", release, f.profile, c.id, inst.id, uid(), at);
    await expect(mensalidadePaymentUpdated(ctx, payment, "paid")).rejects.toThrow("aviso indisponível");
    expect((await one(f.env, "SELECT status FROM suporte_releases WHERE id=?", release)).status).toBe("ended");
    await pump(f);
    expect((await f.sql("SELECT settled_cents FROM erp_finance__title"))[0].settled_cents).toBe(0);
    expect(await f.count("erp_finance__settlement")).toBe(2);
  });
  it("Entrega parcialmente recebida cancela no ERP somente após a devolução", async () => {
    const f = await setup(), ctx = f.ctx("entrega");
    const row = await createDelivery(ctx, f.actor, { label: "Entrega", source: "manual" }, uid());
    await updateDeliveryCommercial(ctx, f.actor, { id: row.id, version: 0, price_cents: 1000, authorize: true }, uid()); await pump(f);
    const receipt = await receiveDelivery(ctx, f.actor, { id: row.id, amount_cents: 400, method: "cash" }, uid()); await pump(f);
    await cancelDelivery(ctx, f.actor, { id: row.id, reason: "Cancelamento" });
    const source = { profile: f.profile, module: "entrega" as const, source_id: row.id, component: "main" };
    expect((await events(f, row.id)).at(-1)!.seq).toBeNull();
    expect(await integrationSourceView(f.env, f.actor, source)).toMatchObject({ state: "blocked", reason_code: "refund_required", pending: true });
    expect((await f.sql("SELECT cancelled,settled_cents FROM erp_finance__title"))[0]).toMatchObject({ cancelled: 0, settled_cents: 400 });
    await reverseCommercialReceipt(f.env, f.actor, f.profile, { id: receipt.receipt_key, reason_code: "refund_confirmed" }, uid()); await pump(f);
    expect((await f.sql("SELECT cancelled,settled_cents FROM erp_finance__title"))[0]).toMatchObject({ cancelled: 1, settled_cents: 0 });
    expect((await f.sql("SELECT status FROM erp_documents__document"))[0].status).toBe("cancelled");
    expect(await integrationSourceView(f.env, f.actor, source)).toMatchObject({ state: "done", pending: false });
    expect((await events(f, row.id)).filter(e => e.seq !== null).map(e => e.operation)).toEqual(["prepare", "execute", "receive", "reverse", "cancel"]);
  });
  it("Worker pagina o estado por origem e informa o alcance dos contadores", async () => {
    const f = await setup(); await work(f); await work(f); await work(f); await pump(f);
    const token = await bearer(f.actor); let cursor: string | null = "", pages = 0;
    do {
      const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/integrations/os/status?limit=1&after=${encodeURIComponent(cursor ?? "")}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200); const page = await response.json<any>();
      expect(page.scope).toBe("page"); expect(page.counters.reduce((n: number, c: any) => n + c.count, 0)).toBe(1);
      expect(page.next_cursor).not.toBe(cursor); cursor = page.next_cursor; expect(++pages).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(pages).toBe(3);
  });
  it("desconto sobre título reconhecido bloqueia cobrança reduzida e permanece visível", async () => {
    const f = await setup(), ctx = f.ctx("mensalidade"), payer = uid(), day = today(Date.now()), c = await conversation(f);
    await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer,f.profile,f.local,f.actor.id,Date.now(),Date.now());
    const plan = await createPlan(ctx,{name:"Plano",amount_cents:1000,due_day:Number(day.slice(-2))},f.actor.id);
    const sub = await createSubscription(ctx,{plan_id:plan.id,payer_id:payer,phone:"5511999998888",customer_name:"Cliente",start_date:day,end_date:day},f.actor.id);
    await generateInstallments(ctx,Date.now(),sub.id); await pump(f);
    const inst = await one(f.env,"SELECT * FROM mensalidade_installments WHERE subscription_id=?",sub.id);
    await requestDecided(ctx,{id:uid(),ref_id:inst.id,conversation_id:c.id,kind:"desconto"},{status:"approved",actor:f.actor,value:2} as any);
    const fresh=await one(f.env,"SELECT * FROM mensalidade_installments WHERE id=?",inst.id), charge=vi.spyOn(ctx,"charge");
    expect(fresh.amount_cents).toBe(800);
    await expect(ensureCharge(ctx,fresh,c,mensalidadeSettings({}),"manual",Date.now())).rejects.toMatchObject({code:"commercial_correction_required"});
    expect(charge).not.toHaveBeenCalled(); expect((await f.sql("SELECT amount_cents FROM erp_finance__title"))[0].amount_cents).toBe(1000);
    expect(await integrationSourceView(f.env,f.actor,{profile:f.profile,module:"mensalidade",source_id:inst.id,component:"main"})).toMatchObject({state:"blocked",reason_code:"commercial_correction_required",pending:true});
  });

  it("Suporte reembolsado antes do gancho pago reverte e cancela a obrigação no motor", async () => {
    const f=await setup(), ctx=f.ctx("suporte"), c=await conversation(f), at=Date.now(), payer=uid();
    await exec(f.env,"INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)",payer,f.profile,f.local,f.actor.id,at,at);
    const row={id:uid(),profile_id:f.profile,conversation_id:c.id,payer_id:payer,session_id:null,package_id:"avulso",price_cents:1000,status:"pending",created:at};
    await batch(f.env,[["INSERT INTO suporte_purchases(id,profile_id,conversation_id,payer_id,package_id,package_name,price_cents,mode,method,status,created,updated) VALUES(?,?,?,?,'avulso','Suporte',1000,'ticket','link','pending',?,?)",[row.id,f.profile,c.id,payer,at,at]],...await supportIntegrationStatements(ctx,row,"recognize",at)]);
    await pump(f);
    const id=uid(), account=uid(), remote=uid();
    await exec(f.env,"INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated) VALUES(?,?,?,?,'fake','link','suporte',?,'Serviço',1000,'paid',?,'module','system',?,?,?,?)",id,f.profile,c.id,account,row.id,remote,at+60000,at,at,at);
    await exec(f.env,"UPDATE suporte_purchases SET payment_id=? WHERE id=?",id,row.id);
    for(const state of ["paid","refunded"] as const){
      const evidence=await preparePaymentEvidence(f.env,await one(f.env,"SELECT * FROM payments WHERE id=?",id),{id:remote,state,amount_cents:1000,currency:"BRL",paid_at:at,verified_method:"pix",refunded_at:state==="refunded"?at+1:null},at+1);
      await batch(f.env,[["UPDATE payments SET status=? WHERE id=?",[state,id]],...paymentEvidenceStatements(evidence)]);
    }
    const payment=paymentView(await one(f.env,"SELECT * FROM payments WHERE id=?",id))!;
    await purchasePaymentUpdated(ctx,payment); await purchasePaymentUpdated(ctx,payment); await pump(f);
    expect(await all(f.env,"SELECT * FROM suporte_releases WHERE profile_id=? AND status='active'",f.profile)).toEqual([]);
    expect((await f.sql("SELECT cancelled,settled_cents FROM erp_finance__title"))[0]).toMatchObject({cancelled:1,settled_cents:0});
    expect((await events(f,row.id)).map(e=>e.operation)).toEqual(["recognize","receive","reverse","cancel"]);
    expect(await f.count("erp_finance__settlement")).toBe(2);
  });
  it("Worker exige MFA financeiro no recebimento manual e mantém instalação sem exigência", async () => {
    const f = await setup(), ctx = f.ctx("entrega"), token = await bearer(f.actor);
    const row = await createDelivery(ctx, f.actor, { label: "Entrega", source: "manual" }, uid());
    await updateDeliveryCommercial(ctx, f.actor, { id: row.id, version: 0, price_cents: 1000, authorize: true }, uid()); await pump(f);
    const receive = () => SELF.fetch(`https://test/api/v1/profiles/${f.profile}/entrega/deliveries/${row.id}/receipts`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": uid() }, body: JSON.stringify({ amount_cents: 400, method: "cash" }) });
    // A resposta HTTP precede o consumidor do Coordinator. Aguardar o trabalho
    // real antes de bombear evita gastar 30 rodadas disputando sua concessão.
    const background: Promise<unknown>[] = [];
    await runInDurableObject(f.env.COORDINATOR.get(f.env.COORDINATOR.idFromName(f.profile)), (_instance: unknown, state: DurableObjectState) => {
      const waitUntil = state.waitUntil.bind(state);
      vi.spyOn(state, "waitUntil").mockImplementation(work => { background.push(work); waitUntil(work); });
    });
    const finishBackground = async () => {
      while (background.length) await Promise.all(background.splice(0));
    };
    try {
      await exec(f.env, "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy','financial',?) ON CONFLICT(key) DO UPDATE SET value='financial'", Date.now());
      const denied = await receive(); expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ error: { code: "mfa_required" } });
      await finishBackground();
      expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toEqual([]);
      await exec(f.env, "UPDATE instance_settings SET value='off' WHERE key='mfa_policy'");
      const allowed = await receive(); expect(allowed.status).toBe(200); await allowed.json();
      expect(background.length).toBeGreaterThan(0);
      await finishBackground(); await pump(f);
      expect(await f.count("erp_finance__settlement")).toBe(1);
      expect((await f.sql("SELECT settled_cents FROM erp_finance__title"))[0].settled_cents).toBe(400);
    } finally {
      try { await finishBackground(); }
      finally { await exec(f.env, "UPDATE instance_settings SET value='off' WHERE key='mfa_policy'"); }
    }
  });
  it("área nova não lança sozinha; habilitar Financeiro só lança fatos novos desse destino", async () => {
    const f = await setup(false), w = await work(f, false, true);
    expect(f.policy.auto_post).toEqual({ stock: false, finance: false });
    await integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", { module: "os", id: w.row.id, kind: "quote_item", component: JSON.parse(w.row.quote_items)[0].id, erp_item_id: f.product.id, version: 0 }, uid());
    await changeStatus(w.ctx, await loadWork(w.ctx, w.row.id), "in_progress", f.actor.id, "", quiet);
    await pump(f);
    expect(await f.count("erp_finance__title")).toBe(0); expect(await f.count("erp_stock__document_posting")).toBe(0);
    expect(await integrationSourceView(f.env, f.actor, w.source)).toMatchObject({ state: "skipped", skipped_reason: "automation_off", manual_destinations: ["stock", "finance"] });
    await patchCommercialPolicy(f.env, f.actor, f.profile, { version: 1, auto_post: { finance: true } }, uid());
    await pump(f);
    expect(await f.count("erp_finance__title")).toBe(0);
    const fresh = await work(f);
    await changeStatus(fresh.ctx, fresh.row, "in_progress", f.actor.id, "", quiet); await pump(f);
    expect(await f.count("erp_finance__title")).toBe(1); expect(await f.count("erp_stock__document_posting")).toBe(0);
    expect(await integrationSourceView(f.env, f.actor, w.source)).toMatchObject({ state: "skipped", pending: true });
  });

  it.each([false, true])("suspensão não gasta preparação e retoma recebimento vinculado (pedido preparado: %s)", async prepared => {
    const f = await setup(), ctx = f.ctx("entrega");
    const row = await createDelivery(ctx, f.actor, { label: "Entrega", source: "manual" }, uid());
    await updateDeliveryCommercial(ctx, f.actor, { id: row.id, version: 0, price_cents: 1000, authorize: true }, uid()); await pump(f);
    if (!prepared) await setParts(f.profile, { "erp-financeiro": false });
    await receiveDelivery(ctx, f.actor, { id: row.id, amount_cents: 400, method: "cash" }, uid());
    const event = (await events(f, row.id)).at(-1)!;
    if (prepared) {
      const token = await acquireIntegrationLease(f.env, event.id);
      await persistPreparedRequest(f.env, event, await prepareErpRequest(f.env, event), token!);
      await exec(f.env, "UPDATE module_erp_delivery SET state='pending',lease_token=NULL,lease_until_ms=NULL WHERE event_id=?", event.id);
      await setParts(f.profile, { "erp-financeiro": false });
    }
    for (let n = 0; n < 15; n++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    expect(await one(f.env, "SELECT state,error_code,preparation_attempts,attempts,lookup_attempts FROM module_erp_delivery WHERE event_id=?", event.id))
      .toEqual({ state: "pending", error_code: "part_disabled", preparation_attempts: 0, attempts: 0, lookup_attempts: 0 });
    await setParts(f.profile, { "erp-financeiro": true }); await pump(f); await pump(f);
    expect(await f.count("erp_finance__settlement")).toBe(1);
    expect((await f.sql("SELECT settled_cents FROM erp_finance__title"))[0].settled_cents).toBe(400);
  });

  it("lifecycle de venda não resolve execução fechada sem efeito financeiro", async () => {
    const f = await setup(), ctx = f.ctx("entrega");
    const row = await createDelivery(ctx, f.actor, { label: "Entrega", source: "manual" }, uid());
    await updateDeliveryCommercial(ctx, f.actor, { id: row.id, version: 0, price_cents: 1000, authorize: true }, uid());
    await drainIntegrationOutbox(f.env, f.profile); // prepare, sem execute
    await setParts(f.profile, { "erp-financeiro": false }); await setParts(f.profile, { "erp-financeiro": true });
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const { deliveryLifecycleStatements } = await import("../src/modules/entrega/integration");
    await batch(f.env, await deliveryLifecycleStatements(ctx, await one(f.env, "SELECT * FROM entrega_deliveries WHERE id=?", row.id), f.actor.id, false));
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const source = { profile: f.profile, module: "entrega" as const, source_id: row.id, component: "main" };
    expect(await integrationSourceView(f.env, f.actor, source)).toMatchObject({ state: "blocked", pending: true, reason_code: "epoch_closed", manual_destinations: ["finance"] });
    expect(await f.count("erp_finance__title")).toBe(0);
  });

  it.each(["payment_evidence_required", "obligation_reactivation_required", "refund_required"])("retry local preserva %s e não chama ERP", async reason => {
    const f = await setup(), w = await work(f);
    await pump(f);
    const snapshot = (await events(f, w.row.id)).at(-1)!.snapshot;
    await batch(f.env, await pendingPaymentStatements(f.env, snapshot, uid(), "paid", reason));
    const event = (await events(f, w.row.id)).at(-1)!;
    expect(event.seq).toBeNull();
    const before = await one(f.env, "SELECT * FROM module_erp_delivery WHERE event_id=?", event.id), remote = vi.spyOn(hub, "erpFetch");
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.retry", { module: "os", id: w.row.id, event_id: event.id }, uid())).rejects.toMatchObject({ status: 409, code: reason });
    expect(await one(f.env, "SELECT * FROM module_erp_delivery WHERE event_id=?", event.id)).toEqual(before);
    expect(remote).not.toHaveBeenCalled();
  });

  it("sem papel ERP não reserva substituição e Estoque recebe projeção sem valores financeiros", async () => {
    const f = await setup(), w = await work(f), actor = await person(f, ["*"]);
    const event = (await events(f, w.row.id)).at(-1)!;
    await expect(integrationCommand(f.env, actor, f.profile, "integration.replace", { module: "os", id: w.row.id, event_id: event.id, reason_code: "commercial_correction" }, uid())).rejects.toMatchObject({ status: 403 });
    expect(await one(f.env, "SELECT replacement_key,replacement_json FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, w.row.id)).toEqual({ replacement_key: null, replacement_json: null });
    const stock = await person(f, ["*", "erp:estoque"]), view = await workCommercialView(w.ctx, stock, w.row.id);
    expect(view).not.toHaveProperty("installments"); expect(view).not.toHaveProperty("total_cents");
    expect(view.items.length).toBeGreaterThan(0); expect(view.items[0]).not.toHaveProperty("unit_cents");
    expect(view.manual_destinations).not.toContain("finance"); expect(view.applied).not.toContain("finance");
    expect(view.reason_code).toBeNull();
  });
  it("recusa definitiva entre reserva e transporte desfaz a reserva por CAS", async () => {
    const f = await setup(), w = await work(f), event = (await events(f, w.row.id)).at(-1)!;
    for (let n = 0; n < event.seq! - 1; n++) {
      await due(f); await drainIntegrationOutbox(f.env, f.profile);
    }
    expect((await one(f.env, "SELECT applied_seq FROM module_erp_sources WHERE source_id=?", w.row.id)).applied_seq).toBe(event.seq! - 1);
    const original = f.env.DB.batch.bind(f.env.DB), transport = vi.spyOn(hub, "erpFetch");
    const writer = vi.spyOn(f.env.DB, "batch").mockImplementation(async statements => {
      const result = await original(statements);
      if ((await one(f.env, "SELECT replacement_key FROM module_erp_sources WHERE source_id=?", w.row.id))?.replacement_key) f.actor.role = "operator";
      return result;
    });
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.replace", { module: "os", id: w.row.id, event_id: event.id, reason_code: "commercial_correction" }, uid())).rejects.toMatchObject({ status: 403 });
    expect(transport).not.toHaveBeenCalled();
    expect((await one(f.env, "SELECT replacement_key FROM module_erp_sources WHERE source_id=?", w.row.id)).replacement_key).toBeNull();
    writer.mockRestore(); f.actor.role = "admin";
    await integrationCommand(f.env, f.actor, f.profile, "integration.replace", { module: "os", id: w.row.id, event_id: event.id, reason_code: "commercial_correction" }, uid());
    await pump(f); expect(await f.count("erp_documents__document")).toBe(1);
  });
});
async function events(f: Fixture, id?: string): Promise<IntegrationEvent[]> {
  return (await all(f.env, `SELECT payload_json FROM module_erp_events WHERE profile_id=?${id ? " AND source_id=?" : ""} ORDER BY module_id,source_id,source_revision,seq`, f.profile, ...(id ? [id] : []))).map(row => JSON.parse(row.payload_json));
}
async function pump(f: Fixture) {
  for (let n = 0; n < 30; n++) {
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const pending = await all(f.env, "SELECT d.* FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND d.state<>'done'", f.profile);
    if (!pending.length) return;
    expect(pending.filter(d => ["blocked", "failed", "waiting_manual"].includes(d.state)), JSON.stringify(pending)).toEqual([]);
  }
  throw new Error("Fila não concluiu em 30 sequências");
}
async function historicalReceipt(f: Fixture, module: "agenda" | "reserva", id: string) {
  await due(f); await drainIntegrationOutbox(f.env, f.profile);
  const rows = await all(f.env, `SELECT e.seq,d.state,d.error_code,d.receipt_json FROM module_erp_events e
    JOIN module_erp_delivery d ON d.event_id=e.id WHERE e.profile_id=? AND e.source_id=?`, f.profile, id);
  expect(rows).toEqual([{ seq: null, state: "blocked", error_code: "historical_origin_unlinked", receipt_json: null }]);
  expect(await integrationSourceView(f.env, f.actor, { profile: f.profile, module, source_id: id, component: "main" }))
    .toMatchObject({ state: "blocked", reason_code: "historical_origin_unlinked", pending: true, applied: [] });
  expect(await one(f.env, "SELECT enqueued_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, id)).toEqual({ enqueued_seq: 0 });
  await setParts(f.profile, { "erp-financeiro": true });
  await due(f); await drainIntegrationOutbox(f.env, f.profile);
  expect(await all(f.env, "SELECT * FROM module_erp_requests r JOIN module_erp_events e ON e.id=r.event_id WHERE e.profile_id=?", f.profile)).toEqual([]);
  expect(await integrationSourceView(f.env, f.actor, { profile: f.profile, module, source_id: id, component: "main" }))
    .toMatchObject({ state: "blocked", reason_code: "historical_origin_unlinked", pending: true, applied: [] });
}
async function work(f: Fixture, fixed = false, material = false) {
  const ctx = f.ctx("os");
  const opened = (await createWork(ctx, { item: "Notebook", problem: "Não liga", customer_name: "Cliente", phone: "5511999999988",
    source: "panel", sourceKey: uid(), actor: f.actor.id, notify: false })).order;
  await patchWorkCommercial(ctx, f.actor, opened.id, { version: opened.row_version, customer_ref: f.local }, uid());
  let row = await saveQuote(ctx, await loadWork(ctx, opened.id), { items: [{ description: "Reparo", quantity: 1, unit_cents: 1000, kind: material ? "material" : "free" }] }, f.actor.id, uid());
  if (fixed) {
    const view = await workCommercialView(ctx, f.actor, row.id);
    expect(view).toMatchObject({ frozen: false, total_cents: 1000 });
    await patchWorkCommercial(ctx, f.actor, row.id, { version: view.version, authorize_fixed_price: true }, uid());
    row = await loadWork(ctx, row.id);
  } else {
    row = await sendQuote(ctx, row, f.actor.id, { ...quiet, mutationKey: uid() });
    row = await decide(ctx, row, "approve", f.actor.id, "panel", "", { ...quiet, mutationKey: uid(), quote_version: row.quote_version });
  }
  return { ctx, row, source: { profile: f.profile, module: "os" as const, source_id: row.id, component: "main" } };
}
async function prepared(f: Fixture, event: IntegrationEvent) {
  await due(f);
  const token = await acquireIntegrationLease(f.env, event.id); expect(token).not.toBeNull();
  const request = await persistPreparedRequest(f.env, event, await prepareErpRequest(f.env, event), token!);
  return { token: token!, request };
}
async function person(f: Fixture, access: string[]): Promise<Actor> {
  const id = uid();
  await exec(f.env, "INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,'Pessoa','test','operator',?,?,?)",
    id, `${id}@example.test`, JSON.stringify([f.profile]), JSON.stringify(access), Date.now());
  return { ...f.actor, id, role: "operator", access };
}
async function conversation(f: Fixture): Promise<Conversation> {
  const id = uid(), at = Date.now();
  await batch(f.env, [
    ["INSERT INTO conversations(id,profile_id,external_namespace,external_id,session,last_customer,created,updated) VALUES(?,?,'panel',?,?,?,?,?)", [id, f.profile, id, uid(), at, at, at]],
    ["INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)", [id, f.profile, f.local, f.actor.id, at]],
  ]);
  return (await one<Conversation>(f.env, "SELECT * FROM conversations WHERE id=?", id))!;
}

describe("Marco 1 — assistência técnica, Worker e ERP reais", () => {
  it("resposta local independe do ERP; automação integral sem pessoa, regressão, entrega e replay", async () => {
    const f = await setup();
    const unreachable = vi.spyOn(hub, "erpFetch").mockRejectedValue(new Error("ERP parado"));
    const w = await work(f), key = uid();
    let row = await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", { ...quiet, mutationKey: key });
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", { ...quiet, mutationKey: key });
    expect(unreachable).not.toHaveBeenCalled(); unreachable.mockRestore();
    await exec(f.env, "UPDATE users SET disabled=1 WHERE id=?", f.actor.id);
    await pump(f);
    const identity = await erpSystemIdentity(f.env, f.profile, "os");
    expect(identity.actor).toMatchObject({ erp_role: "vendas", is_agent: true, verified_factor: false, session_id: null, aal: "aal1" });
    expect(await f.count("erp_finance__title")).toBe(1);
    row = await changeStatus(w.ctx, row, "ready", f.actor.id, "", quiet);
    row = await changeStatus(w.ctx, row, "in_progress", f.actor.id, "Revisão do reparo", quiet);
    row = await changeStatus(w.ctx, row, "ready", f.actor.id, "", quiet);
    await changeStatus(w.ctx, row, "delivered", f.actor.id, "", quiet);
    await pump(f); await pump(f);
    expect(await f.count("erp_documents__document")).toBe(1);
    expect(await f.count("erp_finance__title")).toBe(1);
    expect(await f.count("erp_finance__settlement")).toBe(0);
    expect((await f.sql("SELECT status FROM erp_documents__document"))[0].status).toBe("finalized");
  });

  it("Base desligada preserva operação, marco de execução e ausência de lançamento retroativo", async () => {
    const f = await setup(); await setParts(f.profile, { erp: false });
    const remote = vi.spyOn(hub, "erpFetch"), w = await work(f);
    const row = await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
    await drainIntegrationOutbox(f.env, f.profile);
    expect(remote).not.toHaveBeenCalled(); remote.mockRestore();
    expect(JSON.parse(row.commercial_json).first_execution_at).toBeGreaterThan(0);
    await setParts(f.profile, { erp: true }); await pump(f);
    expect(await f.count("erp_documents__document")).toBe(0);
    expect(await f.count("erp_finance__title")).toBe(0);
    const localFacts = await all(f.env, "SELECT e.seq,e.payload_json,d.state,d.error_code,d.receipt_json FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=?", f.profile);
    expect(localFacts.length).toBeGreaterThan(0);
    for (const fact of localFacts) {
      const snapshot = JSON.parse(fact.payload_json).snapshot;
      expect(fact).toMatchObject({ seq: null, state: "done", receipt_json: null,
        error_code: snapshot.items.length === 0 && snapshot.total_cents === 0 ? "no_commercial_content" : "part_disabled" });
    }
    expect(await one(f.env, "SELECT enqueued_seq FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, w.row.id)).toEqual({ enqueued_seq: 0 });
    expect(await all(f.env, "SELECT * FROM module_erp_requests r JOIN module_erp_events e ON e.id=r.event_id WHERE e.profile_id=?", f.profile)).toEqual([]);
  });

  it("assistência com peça lança os dois destinos e cancela efeitos próprios após desligá-los", async () => {
    const f = await setup(), w = await work(f, false, true);
    const linkInput = {
      module: "os", id: w.row.id, kind: "quote_item", component: JSON.parse(w.row.quote_items)[0].id, erp_item_id: f.product.id, version: 0,
    };
    const linked = await integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", linkInput, "part");
    const row = await changeStatus(w.ctx, await loadWork(w.ctx, w.row.id), "in_progress", f.actor.id, "", quiet);
    await pump(f);
    expect(await f.count("erp_finance__title")).toBe(1); expect(await f.count("erp_stock__document_posting")).toBe(1);
    expect(await integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", linkInput, "part")).toEqual(linked);
    await setParts(f.profile, { "erp-financeiro": false, "erp-estoque": false });
    await changeStatus(w.ctx, row, "cancelled", f.actor.id, "Cancelamento autorizado", { ...quiet, mutationKey: "cancel" });
    await changeStatus(w.ctx, row, "cancelled", f.actor.id, "Cancelamento autorizado", { ...quiet, mutationKey: "cancel" });
    await pump(f);
    const event = (await events(f, w.row.id)).at(-1)!, request = (await readPreparedRequest(f.env, event))!;
    const result = await applyErpRequest(f.env, request);
    expect(result).toMatchObject({ replayed: true, effects: { stock: "reversed", finance: "reversed" } });
    expect((await f.sql("SELECT status FROM erp_documents__document"))[0].status).toBe("cancelled");
    expect(await f.count("erp_finance__settlement")).toBe(0);
  });

  it("queda do lote reverte trabalho/histórico/fila; dois consumidores preservam ordem", async () => {
    const f = await setup(), w = await work(f), previous = await events(f, w.row.id);
    const original = database.batch;
    const interrupted = vi.spyOn(database, "batch").mockImplementation(async (env, statements) => original(env,
      statements.some(([sql]) => sql.startsWith("UPDATE os_orders SET") && sql.includes("row_version"))
        ? [...statements, ["SELECT json('interrupcao_controlada')", []]] : statements));
    await expect(changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet)).rejects.toThrow();
    interrupted.mockRestore();
    expect((await loadWork(w.ctx, w.row.id)).status).toBe("approved");
    expect(await events(f, w.row.id)).toEqual(previous);
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
    const queued = (await events(f, w.row.id)).filter(e => e.operation !== "prepare");
    expect(await acquireIntegrationLease(f.env, queued.at(-1)!.id)).toBeNull();
    await Promise.all([drainIntegrationOutbox(f.env, f.profile), drainIntegrationOutbox(f.env, f.profile)]);
    await pump(f); expect(await f.count("erp_finance__title")).toBe(1);
  });

  it.each([false, true])("queda após commit ERP, desligamento em voo=%s, recupera antes de decidir corte", async off => {
    const f = await setup(), w = await work(f); await pump(f);
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
    const execute = (await events(f, w.row.id)).at(-1)!;
    const { token, request } = await prepared(f, execute);
    const applied = await applyErpRequest(f.env, request); // Simula perda antes de confirmar no D1.
    expect(await f.count("erp_finance__title")).toBe(1);
    if (off) await setParts(f.profile, { "erp-financeiro": false });
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", execute.id);
    await expect(confirmIntegrationResult(f.env, execute, token, applied)).rejects.toThrow();
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    expect(await readPreparedRequest(f.env, execute)).toEqual(request);
    expect(await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", execute.id)).toMatchObject({ state: "done" });
    await setParts(f.profile, { "erp-financeiro": true });
    expect((await applyErpRequest(f.env, request)).replayed).toBe(true);
    expect(await f.count("erp_finance__title")).toBe(1);
  });

  it("corte após preparação fecha comando; fechamento disputado nunca oculta aplicação", async () => {
    for (const race of [false, true]) {
      const f = await setup(), w = await work(f); await pump(f);
      await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
      const event = (await events(f, w.row.id)).at(-1)!, p = await prepared(f, event);
      if (race) {
        const [applied, closed] = await Promise.all([applyErpRequest(f.env, p.request), closeErpCommand(f.env, p.request, "replace_request")]);
        expect(closed.outcome).toBe(applied.outcome);
        expect(await f.count("erp_finance__title")).toBe(applied.outcome === "applied" ? 1 : 0);
      } else {
        await setParts(f.profile, { "erp-financeiro": false });
        await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", event.id);
        await due(f); await drainIntegrationOutbox(f.env, f.profile);
        expect((await getErpOrigin(f.env, p.request)).receipt?.outcome).toBe("closed");
        await setParts(f.profile, { "erp-financeiro": true });
        expect((await applyErpRequest(f.env, p.request)).outcome).toBe("closed");
        expect(await f.count("erp_finance__title")).toBe(0);
      }
    }
  });

  it("configuração manual, DTO público e autorização idempotente da pessoa", async () => {
    const f = await setup();
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false'),'$.auto_post.stock',json('false')) WHERE profile_id=?", f.profile);
    const w = await work(f, true);
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet); await pump(f);
    const source = await integrationSourceView(f.env, f.actor, w.source);
    expect(source).toMatchObject({ state: "skipped", skipped_reason: "automation_off", pending: true, manual_destinations: ["finance"] }); expect(await f.count("erp_finance__title")).toBe(0);
    const token = await bearer(f.actor);
    const response = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/service-orders/${w.row.id}/commercial`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: expect.any(Number), revision: source.revision, frozen: false, items: expect.any(Array), total_cents: 1000, authorization: { kind: "fixed_price" } });
    const summary = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/integrations/os/status`, { headers: { Authorization: `Bearer ${token}` } });
    expect(summary.status).toBe(200);
    expect((await summary.json<any>()).counters).toContainEqual({ state: "skipped", count: 1 });
    const input = { module: "os", id: w.row.id, event_id: source.deliveries.at(-1)!.id, version: source.revision, destinations: ["finance"] };
    const result = await integrationCommand(f.env, f.actor, f.profile, "integration.post", input, "manual");
    expect(await integrationCommand(f.env, f.actor, f.profile, "integration.post", input, "manual")).toEqual(result);
    expect(await f.count("erp_finance__title")).toBe(1);
    await expect(integrationCommand(f.env, { ...f.actor, via: "bot" }, f.profile, "integration.post", input, "bot")).rejects.toMatchObject({ status: 403 });
    await expect(integrationSourceView(f.env, { ...f.actor, role: "operator", profiles: [] }, w.source)).rejects.toMatchObject({ status: 404 });
  });

  it("HTTP não revela contas para Estoque nem origem operacional para quem só lê o documento", async () => {
    const f = await setup(), w = await work(f); await pump(f);
    const stock = await person(f, ["erp:estoque"]), sales = await person(f, ["erp:vendas"]);
    const read = async (actor: Actor, path: string) => SELF.fetch(`https://test/api/v1/profiles/${f.profile}/integrations/${path}`, { headers: { Authorization: `Bearer ${await bearer(actor)}` } });
    const response = await read(stock, "commercial-policy"), policy = await response.json<any>();
    expect(response.status).toBe(200); expect(policy.warehouse_id).toBe(f.warehouse.id);
    for (const key of ["revenue_category_id", "payment_method_id", "settlement_accounts", "consumer_contact_id"]) expect(policy).not.toHaveProperty(key);
    expect(policy.auto_post).toEqual({ stock: true });
    const document = (await f.sql("SELECT id FROM erp_documents__document"))[0].id;
    const origin = await read(sales, `document-origins?ids=${document}`);
    expect(origin.status).toBe(200);
    expect(await origin.json()).toEqual({ data: [{ document_id: document, source: null, readonly: true }] });
    const source = await read(sales, `os/sources/${w.row.id}`);
    expect(source.status).toBe(403);
    expect(await source.text()).not.toContain(document);
    const patch = await SELF.fetch(`https://test/api/v1/profiles/${f.profile}/integrations/commercial-policy`, {
      method: "PATCH", headers: { Authorization: `Bearer ${await bearer(stock)}`, "Content-Type": "application/json", "Idempotency-Key": "forbidden" },
      body: JSON.stringify({ version: policy.version, auto_post: { finance: true } }),
    });
    expect(patch.status).toBe(403);
  });

  it("exceção HTTP é enumerada e não captura integration.delete do roteador existente", () => {
    expect(integrationResourceRoute("GET", "integrations/commercial-policy")).toBe(true);
    expect(integrationResourceRoute("POST", "integrations/os/sources/opaque/post")).toBe(true);
    expect(integrationResourceRoute("DELETE", "integrations/commercial-policy")).toBe(false);
    expect(integrationResourceRoute("POST", "integrations/erp-rpc/anything")).toBe(false);
    expect(integrationOperation("integration.post")).toBe(true);
    expect(integrationOperation("integration.delete")).toBe(false);
  });

  it("vínculo de peça grava projeção no mesmo lote e estoque insuficiente preserva pendência específica", async () => {
    const f = await setup(), w = await work(f, false, true);
    const component = JSON.parse(w.row.quote_items)[0].id;
    const input = { module: "os", id: w.row.id, kind: "quote_item", component, erp_item_id: f.product.id, version: 0 };
    const linked = await integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", input, "link");
    expect(await integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", input, "link")).toEqual(linked);
    expect((await events(f, w.row.id)).at(-1)!.snapshot.items[0].product_id).toBe(f.product.id);
    await pump(f);
    await f.sql("UPDATE erp_stock__balance SET quantity=0");
    await changeStatus(w.ctx, await loadWork(w.ctx, w.row.id), "in_progress", f.actor.id, "", quiet);
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const event = (await events(f, w.row.id)).at(-1)!;
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", event.id)).toMatchObject({ state: "blocked", error_code: "stock_unavailable" });
    expect(await f.count("erp_finance__title")).toBe(0); expect(await f.count("erp_stock__document_posting")).toBe(0);
    expect((await loadWork(w.ctx, w.row.id)).status).toBe("in_progress");
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.catalog.delete", { ...input, version: 1 }, "unlink")).rejects.toMatchObject({ status: 409 });
  });

  it("congelamento concorrente desfaz vínculo, recibo e evento comercial juntos", async () => {
    const f = await setup(), w = await work(f, false, true), original = database.batch;
    let race = true;
    vi.spyOn(database, "batch").mockImplementation(async (env, statements) => {
      if (race && statements.some(([sql]) => sql.startsWith("INSERT INTO module_erp_catalog_links"))) {
        race = false;
        await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
      }
      return original(env, statements);
    });
    await expect(integrationCommand(f.env, f.actor, f.profile, "integration.catalog.put", {
      module: "os", id: w.row.id, kind: "quote_item", component: JSON.parse(w.row.quote_items)[0].id, erp_item_id: f.product.id, version: 0,
    }, "racing-link")).rejects.toMatchObject({ status: 409 });
    expect(await all(f.env, "SELECT * FROM module_erp_catalog_links WHERE profile_id=?", f.profile)).toEqual([]);
    expect(await all(f.env, "SELECT * FROM receipts WHERE key='racing-link' AND scope=?", `f3-catalog:${f.profile}:${f.actor.id}`)).toEqual([]);
    expect((await events(f, w.row.id)).at(-1)!.operation).toBe("execute");
  });

  it.each(["customer_required", "category_required"])("dado obrigatório ausente preserva trabalho e pendência %s", async code => {
    const f = await setup(), w = await work(f); await pump(f);
    if (code === "customer_required") await exec(f.env, "UPDATE contacts SET name='' WHERE id=?", f.local);
    else await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',NULL) WHERE profile_id=?", f.profile);
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const event = (await events(f, w.row.id)).at(-1)!;
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", event.id)).toMatchObject({ state: "blocked", error_code: code });
    expect(await f.count("erp_finance__title")).toBe(0);
    expect((await loadWork(w.ctx, w.row.id)).status).toBe("in_progress");
  });

  it("erro de transporte não grava nem registra texto privado e repete o pedido imutável", async () => {
    const f = await setup(), w = await work(f); await pump(f);
    await changeStatus(w.ctx, w.row, "in_progress", f.actor.id, "", quiet);
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const remote = vi.spyOn(hub, "erpFetch").mockRejectedValue(new Error("PRIVADO-prontuário do provedor"));
    await due(f); await drainIntegrationOutbox(f.env, f.profile);
    const event = (await events(f, w.row.id)).at(-1)!, request = await readPreparedRequest(f.env, event);
    expect(request).not.toBeNull();
    const row = await one(f.env, "SELECT * FROM module_erp_delivery WHERE event_id=?", event.id);
    expect(row).toMatchObject({ state: "pending", error_code: "integration_unavailable" });
    expect(canonical([row, request, logs.mock.calls, await events(f)])).not.toContain("PRIVADO");
    remote.mockRestore(); await pump(f);
    expect(await readPreparedRequest(f.env, event)).toEqual(request);
    expect(await f.count("erp_finance__title")).toBe(1);
  });
});

describe("Marco 2 — restaurante e Mensalidade", () => {
  it.each([true, false])("Pedido e Mesas não duplicam venda nem pagamento; Financeiro=%s", async finance => {
    const f = await setup(); await setParts(f.profile, { "erp-financeiro": finance });
    const ctx = f.ctx("pedido"), item = uid(), category = uid(), at = Date.now();
    await batch(f.env, [
      ["INSERT INTO pedido_categories(id,profile_id,name,created,updated) VALUES(?,?,'Cardápio',?,?)", [category, f.profile, at, at]],
      ["INSERT INTO pedido_items(id,profile_id,category_id,name,price_cents,created,updated) VALUES(?,?,?,'Lanche',1000,?,?)", [item, f.profile, category, at, at]],
    ]);
    const input = { conversation: null, customer_name: "", source: "panel" as const, sourceKey: uid(), actor: f.actor.id,
      lines: [{ item_id: item, slot: 0, name: "Lanche", quantity: 1, unit_cents: 1000, total_cents: 1000, options: [], note: "PRIVADO-alergia" }],
      item_count: 1, subtotal_cents: 1000, delivery_fee_cents: 0, total_cents: 1000, fulfillment: "pickup" as const, address: null, note: "PRIVADO-conversa" };
    const order = (await createOrder(ctx, input)).order;
    expect((await createOrder(ctx, input)).order.id).toBe(order.id);
    await moveOrder(ctx, order, "received", f.actor.id, "", {}, quiet);
    await markPaid(ctx, f.actor, { id: order.id }, "paid"); await markPaid(ctx, f.actor, { id: order.id }, "paid");
    const table = uid(), tab = uid();
    await batch(f.env, [
      ["INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,'Mesa',?,?)", [table, f.profile, at, at]],
      ["INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,1,?,'Mesa','open',0,100,?,?,?,?)", [tab, f.profile, table, f.actor.id, at, at, at]],
    ]);
    await sendOrder(f.ctx("mesas"), f.actor, { id: tab, items: [{ item_id: item, quantity: 1 }] }, "order");
    await addPayment(f.ctx("mesas"), f.actor, { id: tab, amount_cents: 1000, method: "cash" }, "table-paid");
    await closeTab(f.ctx("mesas"), f.actor, { id: tab }, "closed");
    await pump(f); await pump(f);
    expect(await f.count("erp_documents__document")).toBe(2);
    expect(await f.count("erp_finance__title")).toBe(finance ? 2 : 0);
    expect(await f.count("erp_finance__settlement")).toBe(finance ? 2 : 0);
    expect(canonical(await events(f))).not.toContain("PRIVADO");
  });

  it("Mensalidade reconhece líquido contratado e baixa uma vez, sem texto privado", async () => {
    const f = await setup(), ctx = f.ctx("mensalidade"), payer = uid(), day = today(Date.now());
    await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer, f.profile, f.local, f.actor.id, Date.now(), Date.now());
    const plan = await createPlan(ctx, { name: "PRIVADO-plano", amount_cents: 10000, due_day: Number(day.slice(-2)), sellable: true }, f.actor.id);
    const sub = await createSubscription(ctx, { plan_id: plan.id, payer_id: payer, phone: "5511999998888", customer_name: "PRIVADO-menor", notes: "PRIVADO-clínico", start_date: day, end_date: day, discount_cents: 1500 }, f.actor.id);
    await generateInstallments(ctx, Date.now(), sub.id); await generateInstallments(ctx, Date.now(), sub.id);
    const inst = await one(f.env, "SELECT * FROM mensalidade_installments WHERE subscription_id=?", sub.id);
    await payManually(ctx, inst, f.actor.id, { method: "cash" }, "paid"); await payManually(ctx, inst, f.actor.id, { method: "cash" }, "paid");
    await pump(f);
    expect(await f.count("erp_finance__title")).toBe(1); expect(await f.count("erp_finance__settlement")).toBe(1);
    expect(canonical(await events(f))).not.toContain("PRIVADO");
    expect(canonical(await f.sql("SELECT * FROM erp_finance__title"))).not.toContain("PRIVADO");
    expect(canonical(await f.sql("SELECT * FROM erp_finance__audit"))).not.toContain("PRIVADO");
    expect(canonical(await all(f.env, "SELECT r.body_json FROM module_erp_requests r JOIN module_erp_events e ON e.id=r.event_id WHERE e.profile_id=?", f.profile))).not.toContain("PRIVADO");
    expect((await events(f))[0].snapshot.total_cents).toBe(8500);
  });
});

describe("Marco 3 — demais produtores com transporte real", () => {
  it.each([true, false])("Agenda cobra só no gatilho, repete e recebe; Financeiro=%s", async finance => {
    const f = await setup(); await setParts(f.profile, { "erp-financeiro": finance });
    const id = uid(), at = Date.now(), ctx = f.ctx("agenda");
    await exec(f.env, `INSERT INTO agenda_appointments(id,profile_id,service_id,professional_id,starts,ends,source,service_name,price_cents,contact_id,booked_at,created_by,created,updated,notes)
      VALUES(?,?,?,?,?,?,'panel','PRIVADO-serviço',1000,?,?,?,?,?,'PRIVADO-prontuário')`, id, f.profile, uid(), uid(), at, at + 60000, f.local, at, f.actor.id, at, at);
    expect(await events(f)).toEqual([]);
    await agendaTrigger(ctx, f.actor, id, "complete", {}, "complete");
    await agendaTrigger(ctx, f.actor, id, "charge", {}, "charge");
    await agendaTrigger(ctx, f.actor, id, "charge", {}, "charge");
    await manualBookingReceipt(ctx, f.actor, "agenda", id, { amount_cents: 1000, method: "cash" }, "paid");
    if (finance) await pump(f); else await historicalReceipt(f, "agenda", id);
    expect(await f.count("erp_finance__title")).toBe(finance ? 1 : 0); expect(await f.count("erp_finance__settlement")).toBe(finance ? 1 : 0);
    expect(canonical(await events(f))).not.toContain("PRIVADO");
  });

  it.each([true, false])("Reserva mantém sinal e saldo no mesmo total, sem liquidar o saldo; Financeiro=%s", async finance => {
    const f = await setup(); await setParts(f.profile, { "erp-financeiro": finance });
    const ctx = f.ctx("reserva"), c = await conversation(f);
    const unit = await saveUnit(ctx, f.actor, { name: "PRIVADO-unidade", mode: "hourly", kind: "court", price_cents: 1000 });
    const input = { id: uid(), unit_id: unit.id, starts: atClock(addDays(brasiliaDate(Date.now()), 5), "10:00"), duration_minutes: 60,
      source: "panel" as const, actor: f.actor.id, deposit: true, staff: true, notify: false, conversation: c };
    const config = reservaConfig({ deposit_type: "percent", deposit_percent: 30 });
    const booking = (await createBooking(ctx, config, input)).booking;
    expect((await createBooking(ctx, config, input)).booking.id).toBe(booking.id);
    expect(booking.deposit_cents).toBe(300);
    await manualBookingReceipt(ctx, f.actor, "reserva", booking.id, { amount_cents: 300, method: "cash" }, "deposit");
    await manualBookingReceipt(ctx, f.actor, "reserva", booking.id, { amount_cents: 300, method: "cash" }, "deposit");
    if (finance) await pump(f); else await historicalReceipt(f, "reserva", booking.id);
    expect(await f.count("erp_finance__title")).toBe(finance ? 2 : 0);
    expect(await f.count("erp_finance__settlement")).toBe(finance ? 1 : 0);
    if (finance) {
      expect((await events(f, booking.id))[0].snapshot.installments.map(i => i.amount_cents)).toEqual([300, 700]);
      expect((await f.sql("SELECT sum(principal_cents) amount FROM erp_finance__settlement"))[0].amount).toBe(300);
    }
    expect(canonical(await events(f))).not.toContain("PRIVADO");
  });

  it("origem bloqueada sem cliente não paralisa Entrega e Suporte", async () => {
    const f = await setup(), ctx = f.ctx("reserva");
    const unit = await saveUnit(ctx, f.actor, { name: "PRIVADO-unidade", mode: "hourly", kind: "court", price_cents: 1000 });
    const booking = (await createBooking(ctx, reservaConfig({ deposit_type: "percent", deposit_percent: 30 }), {
      id: uid(), unit_id: unit.id, starts: atClock(addDays(brasiliaDate(Date.now()), 5), "10:00"), duration_minutes: 60,
      source: "panel", actor: f.actor.id, deposit: true, staff: true, notify: false,
      customer_name: "Cliente identificado incompleto",
    })).booking;
    // Uma pessoa identificada sem vínculo não é substituída por Consumidor.
    await drainIntegrationOutbox(f.env, f.profile);
    expect(await all(f.env, "SELECT error_code FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND e.module_id='reserva'", f.profile))
      .toEqual([expect.objectContaining({ error_code: "customer_required" })]);
    expect(await f.count("erp_finance__title")).toBe(0);
    expect((await events(f, booking.id))[0].snapshot.installments.reduce((sum, i) => sum + i.amount_cents, 0)).toBe(1000);
    const delivery = await createDelivery(f.ctx("entrega"), f.actor, { label: "Entrega", source: "manual" }, "delivery");
    await updateDeliveryCommercial(f.ctx("entrega"), f.actor, { id: delivery.id, version: 0, price_cents: 500, authorize: true }, "price");
    const payer = uid(), c = await conversation(f), purchase = { id: uid(), profile_id: f.profile, conversation_id: c.id, session_id: null, payer_id: payer, package_id: "opaque-package", price_cents: 700, status: "pending", created: Date.now() };
    await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer, f.profile, f.local, f.actor.id, Date.now(), Date.now());
    await batch(f.env, [
      ["INSERT INTO suporte_purchases(id,profile_id,conversation_id,payer_id,package_id,package_name,price_cents,mode,method,status,created,updated) VALUES(?,?,?,?,?,'PRIVADO-pacote',700,'ticket','pix','pending',?,?)", [purchase.id, f.profile, c.id, payer, purchase.package_id, purchase.created, purchase.created]],
      ...await supportIntegrationStatements(f.ctx("suporte"), purchase, "recognize", purchase.created),
    ]);
    // A origem bloqueada não impede as outras. Sem repetir os testes de compra
    // do dono, esta fronteira prova o DTO real de Suporte no motor real.
    for (let n = 0; n < 4; n++) { await due(f); await drainIntegrationOutbox(f.env, f.profile); }
    expect(await f.count("erp_documents__document")).toBe(1);
    expect(await f.count("erp_finance__title")).toBe(2);
    const rows = await all(f.env, "SELECT d.state FROM module_erp_delivery d JOIN module_erp_events e ON e.id=d.event_id WHERE e.profile_id=? AND e.module_id IN ('suporte','entrega')", f.profile);
    expect(rows.every(r => r.state === "done")).toBe(true);
  });
});
