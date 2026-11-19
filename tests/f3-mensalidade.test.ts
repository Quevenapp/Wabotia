import { afterEach, describe, expect, it, vi } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { uid, type Env } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { createPlan, createSubscription, loadSubscription, setSubscriptionStatus, updatePlan } from "../src/modules/mensalidade/store";
import { chargeContract, contractPaymentUpdated, createContract, loadContract } from "../src/modules/mensalidade/contracts";
import { generateInstallments, loadInstallment, payManually, waive } from "../src/modules/mensalidade/installments";
import { paymentUpdated } from "../src/modules/mensalidade/billing";
import { mensalidadeProducer, mensalidadeSource, mensalidadeStatements, reconcileMensalidadeContracts, reverseMensalidadeReceipt } from "../src/modules/mensalidade/integration";
import { addDays, today } from "../src/modules/mensalidade/model";
import * as listeners from "../src/modules/mensalidade/listeners";
import * as payMessage from "../src/modules/mensalidade/pay-message";
import * as adapter from "../src/integrations/erp-adapter";
import * as policy from "../src/integrations/policy";
import { registerIntegrationProducer } from "../src/integrations/registry";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import { acquireIntegrationLease } from "../src/integrations/outbox";
import { canonical, hash, uuid5, F3_NAMESPACES } from "../src/integrations/keys";
import { commercialReceiptStatements, providerReceiptKey, reverseReceiptKey, type CommercialReceipt } from "../src/integrations/receipts";
import type { IntegrationEvent, IntegrationResult, PreparedErpRequest } from "../src/integrations/contracts";
import { paymentView, type Payment } from "../src/payments";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

afterEach(() => vi.restoreAllMocks());

async function setup(finance = true, discount = 1500) {
  const f = await f3Fixture();
  await setParts(f.profile, { mensalidade: true, "erp-financeiro": finance, "erp-vendas": false }, Date.now() - 1000);
  registerIntegrationProducer(mensalidadeProducer);
  vi.spyOn(listeners, "announcePaid").mockResolvedValue(undefined);
  vi.spyOn(listeners, "notifyInstallmentRefunded").mockResolvedValue(undefined);
  vi.spyOn(payMessage, "sendPayMessage").mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const config = await policy.ensureCommercialPolicy(f.env, f.profile);
  config.settlement_accounts.pix = uid(); config.settlement_accounts.unknown = uid();
  const { profile: _, version: __, ...saved } = config;
  await exec(f.env, "UPDATE module_erp_policy SET config_json=? WHERE profile_id=?", canonical(saved), f.profile);
  const ctx = { ...modulesApi(f.env, f.profile, "mensalidade"),
    publish: vi.fn().mockResolvedValue(1), conversation: vi.fn().mockRejectedValue(new Error("sem conversa")),
    conversationByPhone: vi.fn().mockResolvedValue(null), cancelCharge: vi.fn(),
  };
  const payer = uid();
  await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer, f.profile, f.local, f.actor.id, Date.now(), Date.now());
  const day = today(Date.now());
  const plan = await createPlan(ctx, { name: "Conteúdo privado do plano", amount_cents: 10000, due_day: Number(day.slice(-2)), sellable: true }, f.actor.id);
  const sub = await createSubscription(ctx, { plan_id: plan.id, payer_id: payer, phone: "5511999998888", customer_name: "Nome privado do menor", notes: "Texto clínico privado", start_date: day, end_date: day, discount_cents: discount }, f.actor.id);
  const events = async () => (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id='mensalidade' ORDER BY source_id,seq", f.profile)).map(r => JSON.parse(r.payload_json) as IntegrationEvent);
  const installments = () => all(f.env, "SELECT * FROM mensalidade_installments WHERE profile_id=? ORDER BY due_date,id", f.profile);
  const generate = async () => { await generateInstallments(ctx, Date.now(), sub.id); return (await installments())[0]; };
  const drain = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await exec(f.env, "UPDATE module_erp_delivery SET next_attempt_ms=0 WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile);
      await drainIntegrationOutbox(f.env, f.profile);
    }
  };
  return { ...f, ctx, payer, plan, sub, day, events, installments, generate, drain };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** Simula somente as portas B2: títulos/baixas reais ficam para aceitação. */
function titleErp() {
  const receipts = new Map<string, IntegrationResult>();
  const titles = new Map<string, { id: string; amount: number; cancelled: boolean }>();
  const settlements = new Map<string, { title: string; active: boolean }>();
  const calls: PreparedErpRequest[] = [];
  let lose = false;
  async function validate(env: Env, request: PreparedErpRequest) {
    const stored = await one(env, "SELECT r.* FROM module_erp_requests r JOIN module_erp_events e ON e.id=r.event_id WHERE e.command_id=?", request.command_id);
    expect(stored.request_hash).toBe(hash(request));
    expect(stored.body_json).toBe(canonical(request.body));
  }
  const get = vi.spyOn(adapter, "getErpOrigin").mockImplementation(async (env, request) => {
    await validate(env, request); return { receipt: receipts.get(request.command_id) ?? null };
  });
  const apply = vi.spyOn(adapter, "applyErpRequest").mockImplementation(async (env, request) => {
    await validate(env, request);
    const old = receipts.get(request.command_id);
    if (old) return { ...old, replayed: true };
    calls.push(request);
    const body = request.body as any, source = request.source.source_id;
    let title = titles.get(source);
    const links: IntegrationResult["links"][number][] = [];
    let finance: IntegrationResult["effects"]["finance"] = "not_requested";
    if (body.requested.finance) {
      if (body.operation === "recognize") {
        expect(title).toBeUndefined();
        title = { id: uuid5(F3_NAMESPACES.origin, canonical(request.source)), amount: body.snapshot.total_cents, cancelled: false };
        titles.set(source, title); finance = "posted";
      } else if (body.operation === "receive") {
        expect(title).toBeDefined();
        const receipt = body.receipt.receipt as CommercialReceipt;
        expect(settlements.has(receipt.receipt_key)).toBe(false);
        settlements.set(receipt.receipt_key, { title: title!.id, active: true }); finance = "settled";
      } else if (body.operation === "reverse") {
        const original = settlements.get(body.receipt.receipt.reverses_key);
        expect(original?.title).toBe(title!.id); expect(original?.active).toBe(true);
        original!.active = false; finance = "reversed";
      } else if (body.operation === "cancel" && title) { title.cancelled = true; finance = "reversed"; }
    }
    if (title) links.push({ slot: "main", kind: "title", id: title.id, version: request.seq });
    const result: IntegrationResult = { command_id: request.command_id, seq: request.seq, replayed: false, outcome: "applied", links, effects: { stock: "not_requested", finance }, reason_code: null };
    receipts.set(request.command_id, result);
    if (lose) { lose = false; throw new Error("resposta perdida com texto privado"); }
    return result;
  });
  const close = vi.spyOn(adapter, "closeErpCommand").mockImplementation(async (env, request) => {
    await validate(env, request);
    const result: IntegrationResult = receipts.get(request.command_id) ?? { command_id: request.command_id, seq: request.seq, replayed: false, outcome: "closed", links: [], effects: { stock: "not_requested", finance: "not_requested" }, reason_code: "epoch_closed" };
    receipts.set(request.command_id, result); return result;
  });
  return { calls, receipts, titles, settlements, apply, close, get, loseReply: () => { lose = true; } };
}

/** Simula B8 pela interface compartilhada, sem importar arquivo da frente. */
async function providerPayment(f: Fixture, ref: string, source: string, amount: number, options: { id?: string; remote?: string; status?: "paid" | "refunded"; evidence?: boolean } = {}) {
  const id = options.id ?? uid(), remote = options.remote ?? uid(), status = options.status ?? "paid", at = Date.now();
  let account = await one(f.env, "SELECT id FROM payment_accounts WHERE profile_id=?", f.profile);
  if (!account) {
    account = { id: uid() };
    await exec(f.env, "INSERT INTO payment_accounts(id,profile_id,provider,created,updated) VALUES(?,?,'mercadopago',?,?)", account.id, f.profile, at, at);
  }
  await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,status,provider_payment_id,trigger,actor,expires_at,paid_at,created,updated)
    VALUES(?,?,?,?,'mercadopago','pix','mensalidade',?,'Descrição privada',?,?,?,'module','module:mensalidade',?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated=excluded.updated`, id, f.profile, uid(), account.id, ref, amount, status, remote, at + 86400000, at, at, at);
  const row = await one(f.env, "SELECT * FROM payments WHERE id=?", id);
  const originalKey = providerReceiptKey(f.profile, "mercadopago", account.id, String(row.provider_payment_id));
  const key = status === "refunded" ? reverseReceiptKey(originalKey) : originalKey;
  const receipt: CommercialReceipt = { profile_id: f.profile, receipt_key: key, owner_module: "mensalidade", source_id: source,
    kind: status === "refunded" ? "reverse" : "receive", evidence: "provider", reverses_key: status === "refunded" ? originalKey : null,
    amount_cents: amount, method: "pix", occurred_ms: status === "paid" ? row.paid_at : at, actor_id: null, evidence_hash: hash([originalKey, status, amount]) };
  if (options.evidence !== false) {
    const old = await one(f.env, "SELECT receipt_key FROM module_commercial_receipts WHERE profile_id=? AND receipt_key=?", f.profile, key);
    if (!old) await batch(f.env, commercialReceiptStatements(receipt));
  }
  return { payment: paymentView(row)!, receipt, key, remote: row.provider_payment_id };
}

async function initialContract(f: Fixture) {
  const contract = await createContract(f.ctx, { c: { id: uid() } as any, plan: f.plan, phone: "5511999998888", payer_id: f.payer,
    document: null, name: "Nome privado", method: "pix", sourceKey: uid(), actor: f.actor.id });
  const payment = { id: uid(), method: "pix", amount_cents: contract.amount_cents, status: "created", expires_at: Date.now() + 86400000, pix_code: "pix", url: null } as Payment;
  f.ctx.charge = vi.fn().mockResolvedValue(payment);
  await chargeContract(f.ctx, contract, { id: contract.conversation_id } as any, "pix", uid());
  return loadContract(f.ctx, contract.id);
}

describe("F3 Mensalidade: obrigação, corte e privacidade", () => {
  it.each([true, false])("gera uma vez pelo líquido contratado (Financeiro=%s)", async finance => {
    const f = await setup(finance), erp = titleErp();
    const inst = await f.generate();
    expect(await generateInstallments(f.ctx, Date.now(), f.sub.id)).toBe(0);
    const events = await f.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "recognize", eligible: { finance, document: false, stock: false }, snapshot: { total_cents: 8500, discount_cents: 1500, customer_ref: f.local, technical: null } });
    expect(events[0].snapshot.items[0].unit_cents).toBe(10000);
    expect(inst.amount_cents).toBe(8500);
    expect(JSON.stringify(events)).not.toMatch(/Nome privado|Conteúdo privado|Texto clínico|Descrição privada/);
    await f.drain();
    expect(erp.titles.size).toBe(finance ? 1 : 0);
    expect(erp.settlements.size).toBe(0);
    const result = await payManually(f.ctx, inst, f.actor.id, {}, "manual-1");
    expect(result.status).toBe("paid");
    await payManually(f.ctx, result, f.actor.id, {}, "manual-1");
    await f.drain();
    expect((await f.events()).filter(e => e.operation === "receive")).toHaveLength(1);
    expect(erp.settlements.size).toBe(finance ? 1 : 0);
    await expect(payManually(f.ctx, result, f.actor.id, { note: "outro corpo" }, "manual-1")).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("cobra contrato antes do pagamento e conserva preço e origem da primeira parcela", async () => {
    const f = await setup(), erp = titleErp();
    let contract = await initialContract(f);
    await chargeContract(f.ctx, contract, { id: contract.conversation_id } as any, "pix", uid());
    expect((await f.events()).filter(e => e.operation === "recognize")).toHaveLength(1);
    expect(await f.installments()).toHaveLength(0);
    await f.drain();
    expect(erp.titles.size).toBe(1);
    await updatePlan(f.ctx, f.plan.id, { amount_cents: 50000 });
    const p = await providerPayment(f, contract.id, `contract:${contract.id}`, 10000);
    await contractPaymentUpdated(f.ctx, contract, p.payment);
    contract = await loadContract(f.ctx, contract.id);
    await contractPaymentUpdated(f.ctx, contract, p.payment);
    const inst = await loadInstallment(f.ctx, contract.installment_id);
    expect(inst).toMatchObject({ status: "paid", amount_cents: 10000, upfront: 1 });
    expect((await loadSubscription(f.ctx, contract.subscription_id)).amount_cents).toBe(10000);
    expect(await mensalidadeSource(f.ctx, "installment", inst)).toMatchObject({ source_id: `contract:${contract.id}` });
    await f.drain();
    expect(erp.titles.size).toBe(1); expect(erp.settlements.size).toBe(1);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive"]);
  });

  it("primeira parcela já paga continua com alias quando o gerador roda depois", async () => {
    const f = await setup(), contract = await initialContract(f);
    const p = await providerPayment(f, contract.id, `contract:${contract.id}`, 10000);
    await contractPaymentUpdated(f.ctx, contract, p.payment);
    const paid = await loadContract(f.ctx, contract.id);
    await generateInstallments(f.ctx, Date.now(), paid.subscription_id);
    const inst = await loadInstallment(f.ctx, paid.installment_id);
    expect((await f.events()).filter(e => e.source.source_id === `contract:${contract.id}` && e.operation === "recognize")).toHaveLength(1);
    expect(await one(f.env, "SELECT * FROM module_erp_sources WHERE profile_id=? AND source_id=?", f.profile, inst.id)).toBeNull();
    expect((await f.installments()).filter(i => i.period_key === f.day.slice(0, 7))).toHaveLength(1);
  });

  it("primeira parcela estornada e paga por outra cobrança conserva o título do contrato", async () => {
    const f = await setup(), erp = titleErp(), contract = await initialContract(f);
    const first = await providerPayment(f, contract.id, `contract:${contract.id}`, 10000);
    await paymentUpdated(f.ctx, first.payment, "created"); await f.drain();
    const paid = await loadContract(f.ctx, contract.id);
    const refund = await providerPayment(f, contract.id, `contract:${contract.id}`, 10000, { id: first.payment.id, status: "refunded" });
    await paymentUpdated(f.ctx, refund.payment, "paid"); await f.drain();
    expect((await loadInstallment(f.ctx, paid.installment_id)).status).toBe("open");
    const next = await providerPayment(f, paid.installment_id, paid.installment_id, 10000);
    await paymentUpdated(f.ctx, next.payment, "created"); await f.drain();
    expect(erp.titles.size).toBe(1);
    expect([...erp.settlements.values()].filter(s => s.active)).toHaveLength(1);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive", "reverse", "receive"]);
    expect((await f.events()).every(e => e.source.source_id === `contract:${contract.id}`)).toBe(true);
  });

  it("não importa parcela retroativa nem obrigação antiga paga depois da ativação", async () => {
    const f = await setup(false), erp = titleErp();
    const id = uid(), old = Date.now() - 86400000 * 60;
    await exec(f.env, "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,retroactive,created,updated) VALUES(?,?,?,?,?,8500,'overdue',1,?,?)", id, f.profile, f.sub.id, today(old).slice(0, 7), today(old), old, old);
    await setParts(f.profile, { "erp-financeiro": true }, Date.now() - 1);
    const paid = await payManually(f.ctx, await loadInstallment(f.ctx, id), f.actor.id, {}, uid());
    expect(paid.status).toBe("paid");
    await f.drain();
    expect(erp.titles.size).toBe(0);
    expect((await f.events()).map(e => e.operation)).toEqual(["receive"]);
    expect(await one(f.env, "SELECT error_code FROM module_erp_delivery WHERE event_id=?", (await f.events())[0].id)).toMatchObject({ error_code: "historical_origin_unlinked" });
    const retroSub = await createSubscription(f.ctx, { plan_id: f.plan.id, payer_id: f.payer, phone: "5511999998888", customer_name: "Responsável", start_date: today(old), end_date: addDays(f.day, -1) }, f.actor.id);
    await generateInstallments(f.ctx, Date.now(), retroSub.id);
    expect((await f.events()).filter(e => e.operation === "recognize").every(e => !e.eligible.finance && e.reason_code === "retroactive_installment")).toBe(true);
  });

  it("vincula serviço existente sem recalcular contrato, ignora vínculo novo com Produtos desligado", async () => {
    const f = await setup(), service = uid();
    const rpc = vi.spyOn(policy, "humanReferenceRpc").mockResolvedValue({ record: { id: service, kind: "S", active: true, price: "999.99" } });
    await updatePlan(f.ctx, f.plan.id, { erp_service_id: service, erp_service_version: 0 }, f.actor);
    await f.generate();
    expect((await f.events())[0].snapshot.items[0]).toMatchObject({ product_id: service, kind: "service", unit_cents: 10000 });
    await setParts(f.profile, { "erp-produtos": false, "erp-estoque": false }, Date.now());
    const source = { profile: f.profile, module: "mensalidade" as const, source_id: uid(), component: "main" };
    const record = { id: source.source_id, profile_id: f.profile, subscription_id: f.sub.id, status: "open", created: Date.now(), amount_cents: 8500, due_date: f.day };
    const next = await mensalidadeStatements(f.ctx, { kind: "installment", record, source, operation: "recognize", at: Date.now(), newObligation: true });
    expect(next.snapshot.items[0]).toMatchObject({ product_id: null, kind: "free" });
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ record: { id: service, kind: "P", active: true } });
    await expect(updatePlan(f.ctx, f.plan.id, { erp_service_id: service, erp_service_version: 1 }, f.actor)).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("F3 Mensalidade: recebimento, isenção, cancelamento e estorno", () => {
  it.each([true, false])("deduplica a identidade remota e reverte só o recebimento próprio (Financeiro=%s)", async finance => {
    const f = await setup(finance), erp = titleErp(), inst = await f.generate();
    await f.drain();
    const p = await providerPayment(f, inst.id, inst.id, 8500);
    await paymentUpdated(f.ctx, p.payment, "created");
    await paymentUpdated(f.ctx, p.payment, "created");
    const retry = await providerPayment(f, inst.id, inst.id, 8500, { remote: p.remote });
    await paymentUpdated(f.ctx, retry.payment, "created");
    await f.drain();
    expect((await f.events()).filter(e => e.operation === "receive")).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(erp.settlements.size).toBe(finance ? 1 : 0);
    const refunded = await providerPayment(f, inst.id, inst.id, 8500, { id: p.payment.id, status: "refunded" });
    await paymentUpdated(f.ctx, refunded.payment, "paid");
    await paymentUpdated(f.ctx, refunded.payment, "paid");
    await f.drain();
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("open");
    expect((await f.events()).filter(e => e.operation === "reverse")).toHaveLength(1);
    expect([...erp.settlements.values()].filter(s => s.active)).toHaveLength(0);
  });

  it("isenção nunca desfaz dinheiro recebido; pausa cancela só parcelas abertas", async () => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    await f.drain();
    const paid = await payManually(f.ctx, inst, f.actor.id, {}, uid());
    await expect(waive(f.ctx, paid, f.actor.id, {})).rejects.toMatchObject({ code: "installment_not_payable" });
    await setSubscriptionStatus(f.ctx, await loadSubscription(f.ctx, f.sub.id), "ended", f.actor.id);
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("paid");
    await f.drain();
    expect([...erp.settlements.values()].filter(s => s.active)).toHaveLength(1);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive"]);
  });

  it.each(["waive", "pause"])("cancela saldo com %s sem fabricar estorno", async action => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    await f.drain();
    await setParts(f.profile, { "erp-financeiro": false }, Date.now());
    if (action === "waive") {
      const waived = await waive(f.ctx, inst, f.actor.id, { note: "Texto privado" });
      await waive(f.ctx, waived, f.actor.id, { note: "Texto privado" });
    } else await setSubscriptionStatus(f.ctx, await loadSubscription(f.ctx, f.sub.id), "paused", f.actor.id);
    await f.drain();
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "cancel"]);
    expect(erp.titles.get(inst.id)?.cancelled).toBe(true);
    expect(erp.settlements.size).toBe(0);
    expect(JSON.stringify(await f.events())).not.toContain("Texto privado");
  });

  it("estorno mantém dispensa anterior e recusa reverter baixa de outra cobrança", async () => {
    const f = await setup(), inst = await f.generate();
    await waive(f.ctx, inst, f.actor.id, {});
    const p = await providerPayment(f, inst.id, inst.id, 8500);
    await paymentUpdated(f.ctx, p.payment, "created");
    const another = await providerPayment(f, inst.id, inst.id, 8500);
    await paymentUpdated(f.ctx, another.payment, "created");
    const otherRefund = await providerPayment(f, inst.id, inst.id, 8500, { id: another.payment.id, status: "refunded" });
    await paymentUpdated(f.ctx, otherRefund.payment, "paid");
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("paid");
    const refund = await providerPayment(f, inst.id, inst.id, 8500, { id: p.payment.id, status: "refunded" });
    await paymentUpdated(f.ctx, refund.payment, "paid");
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("waived");
    expect((await f.events()).filter(e => e.operation === "reverse")).toHaveLength(1);
  });

  it("estorno manual idempotente reabre dívida e usa recibo original", async () => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    await f.drain();
    await payManually(f.ctx, inst, f.actor.id, {}, "paid");
    await f.drain();
    const original = (await one<CommercialReceipt>(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND kind='receive'", f.profile))!;
    const input = { reason_code: "receipt_voided", command: uid() };
    expect(await reverseMensalidadeReceipt(f.env, f.actor, original, input)).toMatchObject({ status: "open" });
    await reverseMensalidadeReceipt(f.env, f.actor, original, input);
    await f.drain();
    expect((await f.events()).filter(e => e.operation === "reverse")).toHaveLength(1);
    expect([...erp.settlements.values()][0].active).toBe(false);
    await expect(reverseMensalidadeReceipt(f.env, f.actor, original, { ...input, reason_code: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("retoma evidência ausente sem gerar segunda baixa", async () => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    await f.drain();
    const p = await providerPayment(f, inst.id, inst.id, 8500, { evidence: false });
    await paymentUpdated(f.ctx, p.payment, "created");
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("paid");
    await f.drain(); expect(erp.settlements.size).toBe(0);
    await batch(f.env, commercialReceiptStatements(p.receipt));
    await paymentUpdated(f.ctx, p.payment, "created");
    await f.drain(); expect(erp.settlements.size).toBe(1);
    expect((await f.events()).filter(e => e.operation === "receive")).toHaveLength(1);
  });

  it("valor divergente fica pendente sem alocar excedente ou ajustar título", async () => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    await f.drain();
    const p = await providerPayment(f, inst.id, inst.id, 9000);
    await paymentUpdated(f.ctx, p.payment, "created"); await f.drain();
    expect(erp.titles.get(inst.id)?.amount).toBe(8500);
    expect(erp.settlements.size).toBe(0);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(0);
    const receive = (await f.events()).find(e => e.operation === "receive")!;
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", receive.id)).toMatchObject({ state: "blocked", error_code: "total_mismatch" });
  });
});

describe("F3 Mensalidade: falhas, concorrência e limites", () => {
  it("CAS perdedor e queda antes do lote não deixam saída nem mutação parcial", async () => {
    const f = await setup(), inst = await f.generate();
    const input = { kind: "installment" as const, record: { ...inst, status: "waived" }, operation: "cancel" as const, at: Date.now() };
    const first = await mensalidadeStatements(f.ctx, input), stale = await mensalidadeStatements(f.ctx, input);
    await expect(batch(f.env, [...first.statements, ["SELECT json('queda_controlada')", []]])).rejects.toThrow();
    expect(await f.events()).toHaveLength(1);
    await batch(f.env, first.statements);
    await expect(batch(f.env, [["UPDATE mensalidade_installments SET status='waived' WHERE id=?", [inst.id]], ...stale.statements])).rejects.toThrow();
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("open");
    expect(await f.events()).toHaveLength(2);
  });

  it("queda depois do lote, perda da resposta ERP e dois consumidores não duplicam título", async () => {
    const f = await setup(), erp = titleErp(), inst = await f.generate();
    const event = (await f.events())[0];
    const leases = await Promise.all([acquireIntegrationLease(f.env, event.id), acquireIntegrationLease(f.env, event.id)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    await exec(f.env, "UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?", event.id);
    erp.loseReply(); await f.drain(1);
    expect(erp.titles.size).toBe(1);
    await setParts(f.profile, { "erp-financeiro": false }, Date.now());
    await f.drain();
    expect(erp.titles.get(inst.id)?.amount).toBe(8500);
    expect(erp.calls).toHaveLength(1);
    expect(await one(f.env, "SELECT state FROM module_erp_delivery WHERE event_id=?", event.id)).toMatchObject({ state: "done" });
    const stored = await one(f.env, "SELECT body_json FROM module_erp_requests WHERE event_id=?", event.id);
    expect(stored.body_json).not.toMatch(/Nome privado|Texto clínico|Conteúdo privado|resposta perdida/);
  });

  it("época encerrada fecha o comando; religar não reconhece o fato anterior", async () => {
    const f = await setup(), erp = titleErp(); await f.generate();
    await setParts(f.profile, { "erp-financeiro": false }, Date.now());
    await setParts(f.profile, { "erp-financeiro": true }, Date.now());
    await f.drain();
    expect(erp.titles.size).toBe(0); expect(erp.close).toHaveBeenCalledTimes(1);
    expect(await generateInstallments(f.ctx, Date.now(), f.sub.id)).toBe(0);
  });

  it("Base desligada mantém cobrança local sem chamar ERP", async () => {
    const f = await setup(), erp = titleErp();
    await setParts(f.profile, { erp: false }, Date.now());
    const inst = await f.generate();
    await payManually(f.ctx, inst, f.actor.id, {}, uid()); await f.drain();
    expect(erp.apply).not.toHaveBeenCalled(); expect(erp.get).not.toHaveBeenCalled(); expect(erp.close).not.toHaveBeenCalled();
    expect((await loadInstallment(f.ctx, inst.id)).status).toBe("paid");
  });

  it("sem pagador confirmado fica pendente; outra área não lê a origem", async () => {
    const f = await setup(), erp = titleErp();
    await exec(f.env, "UPDATE mensalidade_payers SET contact_id=NULL WHERE id=?", f.payer);
    const inst = await f.generate(); await f.drain();
    expect(erp.apply).not.toHaveBeenCalled();
    expect((await f.events())[0].snapshot.customer_ref).toBeNull();
    await expect(mensalidadeProducer.authorizeSource(f.ctx, { ...f.actor, role: "operator", profiles: [] }, await mensalidadeSource(f.ctx, "installment", inst), false)).rejects.toMatchObject({ code: "not_found" });
    const foreign = { ...await mensalidadeSource(f.ctx, "installment", inst), profile: uid() };
    await expect(mensalidadeProducer.project(f.ctx, foreign)).rejects.toMatchObject({ code: "not_found" });
  });

  it("categoria ausente ou automação desligada conserva a proposta sem lançar", async () => {
    const f = await setup(), erp = titleErp();
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.revenue_category_id',NULL) WHERE profile_id=?", f.profile);
    await f.generate(); await f.drain();
    const event = (await f.events())[0];
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", event.id)).toMatchObject({ state: "blocked", error_code: "category_required" });
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false')) WHERE profile_id=?", f.profile);
    await exec(f.env, "UPDATE module_erp_delivery SET state='pending' WHERE event_id=?", event.id);
    await f.drain();
    expect(await one(f.env, "SELECT state,error_code FROM module_erp_delivery WHERE event_id=?", event.id)).toMatchObject({ state: "waiting_manual", error_code: "waiting_manual" });
    expect(erp.titles.size).toBe(0);
  });

  it("reconcilia cancelamento de contrato substituído, sem cancelar só por Pix expirado", async () => {
    const f = await setup(), first = await initialContract(f);
    await exec(f.env, "UPDATE mensalidade_contracts SET status='expired' WHERE id=?", first.id);
    await reconcileMensalidadeContracts(f.ctx);
    expect((await f.events()).filter(e => e.operation === "cancel")).toHaveLength(0);
    await exec(f.env, "UPDATE mensalidade_contracts SET status='cancelled' WHERE id=?", first.id);
    await createContract(f.ctx, { c: { id: first.conversation_id } as any, plan: f.plan, phone: "5511999998888", payer_id: f.payer, document: null, name: "Responsável", method: "pix", sourceKey: uid(), actor: f.actor.id });
    await reconcileMensalidadeContracts(f.ctx); await reconcileMensalidadeContracts(f.ctx);
    expect((await f.events()).filter(e => e.operation === "cancel")).toHaveLength(1);
  });
});
