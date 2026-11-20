import { persistProviderEvidence } from "./helpers/f3-payment-evidence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { all, batch, exec, one } from "../src/db";
import { eventStatement } from "../src/events";
import { uid, type Conversation } from "../src/types";
import { paymentView, type Payment } from "../src/payments";
import { identityPort, resolveCustomer } from "../src/customer/ports";
import * as moduleApi from "../src/modules/api";
import type { ModuleContext } from "../src/modules/api";
import * as monthly from "../src/modules/mensalidade/public";
import { installmentPaid } from "../src/modules/suporte/flow";
import { buyPackage, purchasePaymentUpdated } from "../src/modules/suporte/store";
import { supportIntegrationProducer, supportIntegrationStatements, supportIntegrationStatus, supportSource } from "../src/modules/suporte/integration";
import { suporteModule } from "../src/modules/suporte/definition";
import { type SupportPackage } from "../src/modules/suporte/model";
import { registerIntegrationProducer } from "../src/integrations/registry";
import { canonical, hash, commandId, uuid5, F3_NAMESPACES } from "../src/integrations/keys";
import { IntegrationError, validateEvent } from "../src/integrations/privacy";
import { acquireIntegrationLease, integrationCasGuard } from "../src/integrations/outbox";
import { drainIntegrationOutbox } from "../src/integrations/consumer";
import * as adapter from "../src/integrations/erp-adapter";
import * as hub from "../src/erp/hub";
import type { CommercialSnapshot, IntegrationEvent, IntegrationResult, PreparedErpRequest } from "../src/integrations/contracts";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

beforeEach(() => {
  registerIntegrationProducer(supportIntegrationProducer);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(hub, "erpFetch").mockImplementation(async () => { throw new Error("ERP indisponível"); });
});
afterEach(() => vi.restoreAllMocks());

async function fixture(options: { finance?: boolean; products?: boolean; auto?: boolean; base?: boolean } = {}) {
  const f = await f3Fixture();
  await setParts(f.profile, { mensalidade: true, payments: true, suporte: true,
    erp: options.base !== false, "erp-produtos": options.products !== false,
    "erp-financeiro": options.finance !== false, "erp-vendas": false, "erp-estoque": false }, Date.now() - 1000);
  const config = { ...f.policy, auto_post: { stock: true, finance: options.auto !== false },
    settlement_accounts: { pix: uid(), unknown: uid() } };
  const { profile: _, version: __, ...policy } = config;
  await exec(f.env, "UPDATE module_erp_policy SET config_json=? WHERE profile_id=?", canonical(policy), f.profile);
  const conversationId = uid();
  await exec(f.env, `INSERT INTO conversations(id,profile_id,external_namespace,external_id,phone,session,last_customer,created,updated)
    VALUES(?,?,'whatsapp',?,'5511990000000',?,?,?,?)`, conversationId, f.profile, conversationId, uid(), Date.now(), Date.now(), Date.now());
  const c = (await one<Conversation>(f.env, "SELECT * FROM conversations WHERE id=?", conversationId))!;
  const ref = { profileId: f.profile, namespace: "team" as const, state: "ready" as const,
    contactId: f.local, verifiedPhone: "5511990000000", version: 1, erp: { id: f.customer, version: 1 } };
  vi.spyOn(identityPort, "resolve").mockResolvedValue(ref);
  const pkg: SupportPackage = { id: "support-day", name: "Atendimento avulso", price_cents: 9000, mode: "hours", hours: 24, active: true };
  const settings = { suporte: { packages: [pkg] } };
  const account = uid(), ticket = { id: uid(), number: "1" };
  const ctx = {
    env: f.env, profile: f.profile, module: suporteModule,
    enabled: async () => true, settings: async () => settings,
    verifiedPhone: () => ref.verifiedPhone, customer: () => resolveCustomer(f.env, c),
    conversation: vi.fn(async (id: string) => {
      if (id !== c.id) throw new IntegrationError("not_found", 404);
      return c;
    }),
    access: vi.fn(), activeTicket: async () => ticket, recordConsent: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    handoff: vi.fn(async () => { c.state = "waiting"; }),
    publish: vi.fn(async (kind: string, id: string, payload: any, opts: { key: string }) => {
      await batch(f.env, [eventStatement(f.profile, kind, id, { ...payload, module_id: "suporte" },
        `module:suporte:${f.profile}:${kind}:${opts.key}`)]);
    }),
    charge: vi.fn(async (_c: Conversation, input: any) => {
      const id = uid(), at = Date.now();
      await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,
        description,amount_cents,status,trigger,actor,source_key,expires_at,created,updated)
        VALUES(?,?,?,?,'fake',?,'suporte',?,?,?,'created','module','suporte',?,?,?,?)`,
      id, f.profile, c.id, account, input.method, input.ref, input.description, input.amount_cents,
      input.sourceKey, at + 86400000, at, at);
      return paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id));
    }),
    cancelCharge: vi.fn(async (id: string) => {
      await exec(f.env, "UPDATE payments SET status='cancelled' WHERE id=?", id);
    }),
  } as unknown as ModuleContext;
  const input = { c, session: null, pkg, method: "pix" as "pix" | "link", name: "Cliente", sourceKey: uid() };
  const buy = (changes: Partial<typeof input> = {}) => buyPackage(ctx, { ...input, ...changes });
  const payment = async (id: string, status: Payment["status"], remote = `remote-${id}`) => {
    await exec(f.env, `UPDATE payments SET status=?,provider_payment_id=?,paid_at=CASE WHEN ? IN ('paid','refunded')
      THEN coalesce(paid_at,?) ELSE paid_at END,updated=? WHERE id=?`, status, remote, status, Date.now(), Date.now(), id);
    if (["paid", "refunded"].includes(status)) await persistProviderEvidence(f.env, id);
    return paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", id))!;
  };
  const hooks = async (id: string, status: Payment["status"], count = 1) => {
    const value = await payment(id, status);
    for (let n = 0; n < count; n++) await purchasePaymentUpdated(ctx, value);
    return value;
  };
  const events = async () => (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id='suporte' ORDER BY source_id,source_revision,seq", f.profile))
    .map(row => JSON.parse(row.payload_json) as IntegrationEvent);
  const releases = () => all(f.env, "SELECT * FROM suporte_releases WHERE profile_id=?", f.profile);
  const flush = async () => {
    for (let n = 0; n < 6; n++) {
      await exec(f.env, "UPDATE module_erp_delivery SET next_attempt_ms=0 WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile);
      await drainIntegrationOutbox(f.env, f.profile);
    }
  };
  return { ...f, ctx, c, pkg, input, buy, settings, payment, hooks, events, releases, flush };
}

/** Simula exclusivamente a porta B2; não depende de implementação paralela.
 * Confere pedido persistido, replay e uma obrigação/baixa por origem.
 */
function fakeTitles() {
  const receipts = new Map<string, IntegrationResult>();
  const bodies = new Map<string, string>();
  const titles = new Map<string, { id: string; amount: number; paid: number; cancelled: boolean }>();
  const calls: PreparedErpRequest[] = [];
  let lose = false;
  async function verify(env: any, request: PreparedErpRequest) {
    const stored = await one(env, `SELECT r.request_hash FROM module_erp_requests r
      JOIN module_erp_events e ON e.id=r.event_id WHERE e.command_id=?`, request.command_id);
    expect(stored.request_hash).toBe(hash(request));
    const before = bodies.get(request.command_id);
    if (before && before !== hash(request)) throw new IntegrationError("idempotency_conflict", 409);
    bodies.set(request.command_id, hash(request));
  }
  const apply = vi.spyOn(adapter, "applyErpRequest").mockImplementation(async (env, request) => {
    await verify(env, request);
    const previous = receipts.get(request.command_id);
    if (previous) return { ...previous, replayed: true };
    const source = canonical(request.source), snapshot = request.body.snapshot as CommercialSnapshot;
    const op = request.body.operation;
    let title = titles.get(source);
    if (op === "recognize") {
      if (title) throw new IntegrationError("idempotency_conflict", 409);
      title = { id: uuid5(F3_NAMESPACES.origin, source), amount: snapshot.total_cents, paid: 0, cancelled: false };
      titles.set(source, title);
    } else if (!title) throw new IntegrationError("historical_origin_unlinked");
    if (op === "receive") {
      if (title!.cancelled) throw new IntegrationError("version_conflict", 409);
      const receipt = request.body.receipt as any;
      if (title!.paid + receipt.amount_cents > title!.amount) throw new IntegrationError("total_mismatch");
      title!.paid += receipt.amount_cents;
    }
    if (op === "reverse") title!.paid -= (request.body.receipt as any).amount_cents;
    if (op === "cancel") {
      if (title!.paid) throw new IntegrationError("version_conflict", 409);
      title!.cancelled = true;
    }
    const result: IntegrationResult = { command_id: request.command_id, seq: request.seq, replayed: false, outcome: "applied",
      links: [{ slot: "main:title", kind: "title", id: title!.id, version: request.seq }],
      effects: { stock: "not_requested", finance: op === "receive" ? "settled" : op === "reverse" || op === "cancel" ? "reversed" : "posted" }, reason_code: null };
    receipts.set(request.command_id, result); calls.push(request);
    if (lose) { lose = false; throw new Error("resposta perdida: texto privado do provedor"); }
    return result;
  });
  vi.spyOn(adapter, "getErpOrigin").mockImplementation(async (env, request) => {
    await verify(env, request); return { receipt: receipts.get(request.command_id) ?? null };
  });
  const close = vi.spyOn(adapter, "closeErpCommand").mockImplementation(async (env, request) => {
    await verify(env, request);
    const result = receipts.get(request.command_id) ?? { command_id: request.command_id, seq: request.seq,
      replayed: false, outcome: "closed" as const, links: [],
      effects: { stock: "not_requested" as const, finance: "not_requested" as const }, reason_code: "epoch_closed" };
    receipts.set(request.command_id, result); return result;
  });
  return { apply, close, calls, titles, loseReply: () => { lose = true; } };
}

describe("F3 Suporte: origem avulsa e responsabilidade mensal", () => {
  it("aceita uma compra, reconhece uma obrigação e baixa só uma vez", async () => {
    const f = await fixture(), remote = fakeTitles();
    const purchase = await f.buy();
    expect((await f.buy()).id).toBe(purchase.id);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize"]);
    expect(remote.apply).not.toHaveBeenCalled();
    await f.hooks(purchase.payment_id, "paid", 2);
    await f.flush();
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive"]);
    expect([...remote.titles.values()]).toEqual([expect.objectContaining({ amount: 9000, paid: 9000 })]);
    expect(await f.releases()).toHaveLength(1);
    expect(f.ctx.handoff).toHaveBeenCalledTimes(1);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ state: "done", pending: false });
    for (const e of await f.events()) {
      validateEvent(e); expect(e.command_id).toBe(commandId(e.source, e.seq));
      expect(e.eligible).toEqual({ document: false, stock: false, finance: true });
    }
  });

  it("rejeita a mesma chave com outro preço, sem alterar o preço contratado", async () => {
    const f = await fixture(); const purchase = await f.buy();
    await expect(f.buy({ pkg: { ...f.pkg, price_cents: 10000 } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await one(f.env, "SELECT price_cents FROM suporte_purchases WHERE id=?", purchase.id)).price_cents).toBe(9000);
    expect(await f.events()).toHaveLength(1);
  });

  it("rejeita evidência adulterada e repetição da identidade remota com outro valor", async () => {
    const f = await fixture(); const purchase = await f.buy();
    const paid = await f.payment(purchase.payment_id, "paid");
    await expect(purchasePaymentUpdated(f.ctx, { ...paid, amount_cents: 1 })).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.releases()).toHaveLength(0);
    await purchasePaymentUpdated(f.ctx, paid);
    await exec(f.env, "UPDATE payments SET amount_cents=10000 WHERE id=?", paid.id);
    const altered = paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", paid.id))!;
    await expect(purchasePaymentUpdated(f.ctx, altered)).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect((await f.events()).filter(e => e.operation === "receive")).toHaveLength(1);
  });

  it("mantém pacote e preço após renomear, desvincular ou remover o pacote", async () => {
    const f = await fixture(); const product = uid();
    await exec(f.env, `INSERT INTO module_erp_catalog_links(profile_id,module_id,record_kind,record_id,component,erp_item_id,updated_ms,updated_by)
      VALUES(?,'suporte','package',?,'main',?,?,'fixture')`, f.profile, f.pkg.id, product, Date.now());
    const purchase = await f.buy();
    f.settings.suporte.packages = [];
    await exec(f.env, "DELETE FROM module_erp_catalog_links WHERE profile_id=?", f.profile);
    await f.hooks(purchase.payment_id, "paid");
    const events = await f.events();
    expect(events.every(e => e.snapshot.items[0].product_id === product && e.snapshot.total_cents === 9000)).toBe(true);
    expect(events[0].snapshot.items[0].id).toBe(events[1].snapshot.items[0].id);
    expect((await supportIntegrationProducer.project(f.ctx, supportSource(f.profile, purchase.id))).items[0].product_id).toBe(product);
    expect(await f.releases()).toHaveLength(1);
  });

  it("planos mensais e liberação por parcela delegam integralmente à Mensalidade", async () => {
    const f = await fixture(), remote = fakeTitles();
    vi.spyOn(moduleApi, "modulesApi").mockReturnValue(f.ctx);
    const contract = uid(), installment = uid(), session = uid();
    await exec(f.env, `INSERT INTO suporte_sessions(id,profile_id,conversation_id,phone,status,step,offer_kind,contract_id,expires_at,created,updated)
      VALUES(?,?,?,'5511990000000','active','awaiting_payment','plan',?,?,?,?)`,
    session, f.profile, f.c.id, contract, Date.now() + 60000, Date.now(), Date.now());
    // Notificação da porta mensal simulada, já ligada à parcela do contrato.
    const inst: monthly.InstallmentPaid = { id: installment, contract_id: contract, payer_id: null,
      subscription_id: uid(), period_key: "2026-11", paid_by: "provider", paid_at: Date.now(),
      conversation_id: f.c.id, amount_cents: 9900, paid_via: "pix" };
    await installmentPaid(f.env, f.profile, inst);
    await installmentPaid(f.env, f.profile, inst);
    await purchasePaymentUpdated(f.ctx, { id: uid(), module_id: "mensalidade", ref_id: contract, status: "paid" } as Payment);
    expect(await f.events()).toHaveLength(0);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? AND owner_module='suporte'", f.profile)).toHaveLength(0);
    expect((await f.releases()).map(r => r.kind)).toEqual(["subscription"]);
    expect(remote.apply).not.toHaveBeenCalled();
  });
});

describe("F3 Suporte: expiração, cancelamento e estorno", () => {
  it.each(["expired", "cancelled"] as const)("%s cancela saldo e nunca confirma estorno; pagamento tardio libera sem novo título", async status => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    await f.flush();
    await f.hooks(purchase.payment_id, status, 2); await f.flush();
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "cancel"]);
    expect(await f.releases()).toHaveLength(0);
    expect([...remote.titles.values()][0].cancelled).toBe(true);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(0);
    await f.hooks(purchase.payment_id, "paid", 2); await f.flush();
    expect(await f.releases()).toHaveLength(1);
    expect(remote.titles.size).toBe(1);
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ pending: true, message: "Pendente no ERP" });
  });

  it("trocar cobrança mantém uma origem; comprar outro pacote cancela o saldo anterior", async () => {
    const f = await fixture(); const purchase = await f.buy();
    const renewed = await f.buy({ method: "link" });
    expect(renewed.id).toBe(purchase.id);
    expect((await f.events()).filter(e => e.operation === "recognize")).toHaveLength(1);
    await purchasePaymentUpdated(f.ctx, paymentView(await one(f.env, "SELECT * FROM payments WHERE id=?", purchase.payment_id))!);
    expect((await f.events()).filter(e => e.operation === "cancel")).toHaveLength(0);
    await f.buy({ sourceKey: uid(), pkg: { ...f.pkg, id: "other" } });
    expect((await f.events()).filter(e => e.operation === "cancel")).toHaveLength(1);
  });

  it("estorno confirmado encerra liberação e reverte a baixa própria uma vez, mesmo com Financeiro desligado", async () => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    await f.hooks(purchase.payment_id, "paid"); await f.flush();
    await setParts(f.profile, { "erp-financeiro": false });
    await f.hooks(purchase.payment_id, "refunded", 2); await f.flush();
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive", "reverse", "cancel"]);
    expect((await f.releases())[0].status).toBe("ended");
    expect([...remote.titles.values()][0].paid).toBe(0);
    const receipt = await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? ORDER BY kind", f.profile);
    expect(receipt).toHaveLength(2); expect(receipt[1].reverses_key).toBe(receipt[0].receipt_key);
  });

  it("estorno recebido antes do gancho pago conserva ambos os fatos sem liberar atendimento", async () => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    await f.hooks(purchase.payment_id, "refunded", 2); await f.flush();
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive", "reverse", "cancel"]);
    expect(await f.releases()).toHaveLength(0);
    expect([...remote.titles.values()][0].paid).toBe(0);
  });

  it("identidade remota repetida não baixa outra vez; outro recebimento fica para conciliação", async () => {
    const f = await fixture(), remote = fakeTitles(); const first = await f.buy();
    const second = await f.buy({ method: "link" });
    const p1 = await f.payment(first.payment_id, "paid", "same-remote");
    await purchasePaymentUpdated(f.ctx, p1);
    const p2 = await f.payment(second.payment_id, "paid", "same-remote");
    await purchasePaymentUpdated(f.ctx, p2); await f.flush();
    expect((await f.events()).filter(e => e.operation === "receive")).toHaveLength(1);
    expect([...remote.titles.values()][0].paid).toBe(9000);
    expect((await one(f.env, "SELECT attention FROM suporte_purchases WHERE id=?", first.id)).attention).toBeNull();
    const refund = await f.payment(second.payment_id, "refunded", "same-remote");
    await purchasePaymentUpdated(f.ctx, refund); await f.flush();
    expect([...remote.titles.values()][0].paid).toBe(0);
    expect((await f.releases())[0].status).toBe("ended");
  });
});

describe("F3 Suporte: partes, privacidade e recuperação", () => {
  it.each([{ base: false }, { finance: false }, { products: false }])("mantém autorização local com configuração %j", async options => {
    const f = await fixture(options), remote = fakeTitles(); const purchase = await f.buy();
    await f.hooks(purchase.payment_id, "paid", 2); await f.flush();
    expect(await f.releases()).toHaveLength(1);
    if (options.products === false) {
      expect([...remote.titles.values()][0].paid).toBe(9000);
      expect((await f.events())[0].snapshot.items[0]).toMatchObject({ product_id: null, kind: "free" });
    } else {
      expect(remote.apply).not.toHaveBeenCalled();
      await setParts(f.profile, { erp: true, "erp-financeiro": true }); await f.flush();
      expect(remote.titles.size).toBe(0);
      expect((await f.events()).filter(e => e.operation === "recognize")).toHaveLength(0);
      expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ state: "blocked" });
    }
    expect(hub.erpFetch).not.toHaveBeenCalled();
  });

  it("automação desligada conserva proposta manual sem impedir o atendimento", async () => {
    const f = await fixture({ auto: false }), remote = fakeTitles(); const purchase = await f.buy();
    await f.hooks(purchase.payment_id, "paid"); await f.flush();
    expect(remote.apply).not.toHaveBeenCalled();
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ state: "skipped", skipped_reason: "automation_off", manual_destinations: ["finance"], message: "Aguardando lançamento manual" });
    expect(await f.releases()).toHaveLength(1);
  });

  it("desligar automação após a baixa conserva o estorno histórico e encerra atendimento", async () => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    await f.hooks(purchase.payment_id, "paid"); await f.flush();
    await exec(f.env, "UPDATE module_erp_policy SET config_json=json_set(config_json,'$.auto_post.finance',json('false')) WHERE profile_id=?", f.profile);
    await f.hooks(purchase.payment_id, "refunded"); await f.flush();
    expect([...remote.titles.values()][0].paid).toBe(0);
    expect((await f.releases())[0].status).toBe("ended");
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ state: "done", pending: false, manual_destinations: [] });
  });

  it("queda depois da liberação local repete o gancho sem duplicar compra, baixa ou liberação", async () => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    const publish = vi.mocked(f.ctx.publish);
    // A fixture já usa vi.fn: guardar o mock guardaria o mesmo wrapper mutável
    // e a delegação chamaria a si própria. Preserve a implementação original.
    const originalPublish = publish.getMockImplementation()!;
    publish.mockImplementation(async (...args) => {
      if (args[0] === "suporte.released") throw new Error("queda após liberação");
      return originalPublish(...args);
    });
    const paid = await f.payment(purchase.payment_id, "paid");
    await expect(purchasePaymentUpdated(f.ctx, paid)).rejects.toThrow("queda após liberação");
    expect(await f.releases()).toHaveLength(1);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive"]);
    expect(f.ctx.handoff).not.toHaveBeenCalled();
    expect(remote.apply).not.toHaveBeenCalled();
    publish.mockImplementation(originalPublish);
    await purchasePaymentUpdated(f.ctx, paid); await f.flush();
    expect(await f.releases()).toHaveLength(1);
    expect([...remote.titles.values()][0].paid).toBe(9000);
    expect(await all(f.env, "SELECT * FROM suporte_purchases WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize", "receive"]);
    expect(remote.titles.size).toBe(1);
    expect(remote.calls.map(request => request.body.operation)).toEqual(["recognize", "receive"]);
    expect(await all(f.env, "SELECT * FROM module_erp_allocations WHERE profile_id=?", f.profile)).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM events WHERE profile_id=? AND kind='suporte.released'", f.profile)).toHaveLength(1);
    expect(f.ctx.handoff).toHaveBeenCalledTimes(1);
  });

  it("queda após commit ERP recupera o recibo original, inclusive após desligar e religar", async () => {
    const f = await fixture(), remote = fakeTitles(); const purchase = await f.buy();
    remote.loseReply(); await drainIntegrationOutbox(f.env, f.profile);
    expect(remote.titles.size).toBe(1);
    const original = await all(f.env, "SELECT * FROM module_erp_requests WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile);
    await setParts(f.profile, { "erp-financeiro": false }); await f.flush();
    await setParts(f.profile, { "erp-financeiro": true }); await f.flush();
    expect(remote.calls).toHaveLength(1);
    expect(await all(f.env, "SELECT * FROM module_erp_requests WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile)).toEqual(original);
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ state: "done" });
  });

  it("época encerrada fecha sem efeitos e não cria receita ao religar", async () => {
    const f = await fixture(), remote = fakeTitles(); await f.buy();
    await setParts(f.profile, { "erp-financeiro": false });
    await setParts(f.profile, { "erp-financeiro": true }); await f.flush();
    expect(remote.close).toHaveBeenCalledTimes(1); expect(remote.titles.size).toBe(0);
  });

  it("falha dentro do lote reverte pagamento local, histórico, recibo e evento; repetição conclui", async () => {
    const f = await fixture(); const purchase = await f.buy(); const paid = await f.payment(purchase.payment_id, "paid");
    const original = db.batch;
    const fail = vi.spyOn(db, "batch").mockImplementation(async (env, statements) => original(env,
      statements.some(([sql]) => sql.includes("UPDATE suporte_purchases SET status='paid'"))
        ? [...statements, ["SELECT json('queda_simulada')", []]] : statements));
    await expect(purchasePaymentUpdated(f.ctx, paid)).rejects.toThrow(); fail.mockRestore();
    expect((await one(f.env, "SELECT status FROM suporte_purchases WHERE id=?", purchase.id)).status).toBe("pending");
    expect((await f.events()).map(e => e.operation)).toEqual(["recognize"]);
    expect(await all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=?", f.profile)).toHaveLength(0);
    expect(await all(f.env, "SELECT * FROM events WHERE profile_id=? AND kind='suporte.purchase_paid'", f.profile)).toHaveLength(0);
    await purchasePaymentUpdated(f.ctx, paid); expect(await f.releases()).toHaveLength(1);
  });

  it("CAS concorrente reverte a mutação perdedora e consumidor não ultrapassa a primeira sequência", async () => {
    const f = await fixture(); const purchase = await f.buy();
    const next = { ...purchase, status: "cancelled" };
    const a = await supportIntegrationStatements(f.ctx, next, "cancel", Date.now());
    const b = await supportIntegrationStatements(f.ctx, next, "cancel", Date.now());
    await batch(f.env, [["UPDATE suporte_purchases SET status='cancelled' WHERE id=?", [purchase.id]], integrationCasGuard, ...a]);
    await expect(batch(f.env, [["UPDATE suporte_purchases SET status='paid' WHERE id=?", [purchase.id]], integrationCasGuard, ...b])).rejects.toThrow();
    expect((await one(f.env, "SELECT status FROM suporte_purchases WHERE id=?", purchase.id)).status).toBe("cancelled");
    const [first, second] = await f.events();
    expect(await acquireIntegrationLease(f.env, second.id)).toBeNull();
    expect(await acquireIntegrationLease(f.env, first.id)).toBeTruthy();
    expect(await acquireIntegrationLease(f.env, first.id)).toBeNull();
  });

  it.each(["customer", "category", "account", "amount"])("%s ausente/divergente vira pendência sem impedir liberação", async missing => {
    const f = await fixture(), remote = fakeTitles();
    if (missing === "customer") await exec(f.env, "UPDATE contacts SET name='' WHERE id=?", f.local);
    if (missing === "category" || missing === "account") await exec(f.env,
      `UPDATE module_erp_policy SET config_json=json_set(config_json,?,json('null')) WHERE profile_id=?`,
      missing === "category" ? "$.revenue_category_id" : "$.settlement_accounts.pix", f.profile);
    const purchase = await f.buy();
    if (missing === "amount") await exec(f.env, "UPDATE payments SET amount_cents=10000 WHERE id=?", purchase.payment_id);
    await f.hooks(purchase.payment_id, "paid"); await f.flush();
    expect(await f.releases()).toHaveLength(1);
    expect(await supportIntegrationStatus(f.ctx, purchase.id)).toMatchObject({ pending: true });
    expect([...remote.titles.values()].every(title => title.paid === 0)).toBe(true);
  });

  it("projeção sensível não exporta menor, nome de pacote, documento ou texto privado", async () => {
    const f = await fixture(); await setParts(f.profile, { saude: true, ensino: true });
    vi.spyOn(monthly, "payerForReview").mockResolvedValue(null);
    const purchase = await f.buy({ name: "Menor privado", pkg: { ...f.pkg, name: "Prontuário privado" } });
    const e = (await f.events())[0];
    expect(e.snapshot).toMatchObject({ customer_ref: null, contact_id: null, technical: null, privacy: "adult_payer_only" });
    expect(canonical(e)).not.toMatch(/Menor privado|Prontuário privado|5511990000000/);
    expect(canonical(e)).not.toContain(f.local);
    expect((await one(f.env, "SELECT description FROM payments WHERE id=?", purchase.payment_id)).description).toBe("Suporte avulso");
  });

  it("nega área, componente, bot e pacote pelo nome; não expõe alvos financeiros no resumo", async () => {
    const f = await fixture(); const purchase = await f.buy();
    const source = supportSource(f.profile, purchase.id);
    await expect(supportIntegrationProducer.authorizeSource(f.ctx, f.actor, { ...source, profile: uid() }, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(supportIntegrationProducer.authorizeSource(f.ctx, { ...f.actor, kind: "bot" } as any, source, true)).rejects.toMatchObject({ status: 403 });
    await expect(supportIntegrationProducer.authorizeSource(f.ctx, f.actor, { ...source, component: "catalog:package:main", source_id: f.pkg.name }, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(supportIntegrationProducer.authorizeSource(f.ctx, f.actor, { ...source, component: "catalog:package:main", source_id: f.pkg.id }, true)).resolves.toBeUndefined();
    const summary = await supportIntegrationStatus(f.ctx, purchase.id);
    expect(Object.keys(summary).sort()).toEqual(["applied", "blocked_reason", "manual_destinations", "message", "pending", "reason_code", "skipped_reason", "state"]);
    expect(JSON.stringify(summary)).not.toMatch(/title_id|account_id|settlement_id|links/);
  });
});
