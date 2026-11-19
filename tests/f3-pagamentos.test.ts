import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { all, batch, exec, one } from "../src/db";
import { uid, type Env } from "../src/types";
import * as hooks from "../src/modules/hooks";
import {
  cancelModulePayment, deliverPaymentHooks, providers, refreshFromProvider, retryPaymentHooks,
  type Payment,
} from "../src/payments";
import {
  allocationKey, manualReceiptKey, providerReceiptKey, reverseReceiptKey,
  readPaymentEvidence, verifiedPaymentMethod, type PaymentEvidenceFact, type VerifiedProviderPayment,
} from "../src/integrations/payment-evidence";
import { commercialReceiptStatements } from "../src/integrations/receipts";
import { commandId } from "../src/integrations/keys";
import { findIntegrationEvent, integrationStatements } from "../src/integrations/ports";
import type { IntegrationEvent, Statement } from "../src/integrations/contracts";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

const providerId = "f3_test";
const paidAt = 1_795_000_000_000;
let log: MockInstance<typeof console.error>;
beforeEach(() => { log = vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); delete providers[providerId]; });

async function fixture(finance = true) {
  const f = await f3Fixture();
  if (!finance) await setParts(f.profile, { erp: false, "erp-financeiro": false });
  const account = uid();
  await exec(f.env, "INSERT INTO payment_accounts(id,profile_id,provider,enabled,created,updated) VALUES(?,?,?,1,?,?)",
    account, f.profile, providerId, Date.now(), Date.now());
  async function local() {
    const id = uid();
    await exec(f.env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,currency,status,trigger,actor,expires_at,receipt,created,updated)
      VALUES(?,?,?,?,?,'link','os',?,'Serviço contratado',1000,'BRL','created','module','system',?,0,?,?)`,
      id, f.profile, uid(), account, providerId, f.source.source_id, Date.now() + 100_000, Date.now(), Date.now());
    return id;
  }
  const id = await local();
  let remote: VerifiedProviderPayment = {
    id: "remote-1", state: "paid", raw_status: "approved", external_reference: id,
    amount_cents: 1000, currency: "BRL", paid_at: paidAt, verified_method: "pix",
  };
  const getPayment = vi.fn(async () => ({ ...remote }));
  const unused = vi.fn(async () => { throw new Error("Chamada indevida ao provedor"); });
  providers[providerId] = {
    id: providerId, name: "Provedor simulado", methods: ["pix", "link"],
    getPayment, test: unused, createPix: unused, createLink: unused,
    cancel: vi.fn(async () => undefined), verifyWebhook: unused,
  };
  const seen: Payment[] = [];
  let failBefore = false, failAfter = false;
  const receipt = (e: PaymentEvidenceFact) => commercialReceiptStatements({
    profile_id: f.profile, receipt_key: e.receipt_key, owner_module: "os", source_id: f.source.source_id,
    kind: e.kind, evidence: "provider", reverses_key: e.reverses_key, amount_cents: e.amount_cents,
    method: e.method, occurred_ms: e.occurred_ms, actor_id: null, evidence_hash: e.evidence_hash,
  });
  // Produtor simulado: uma mutação nativa, recibos e saída comercial no mesmo
  // lote. profiles.name representa aqui o estado local; nenhum módulo paralelo.
  const consumer = vi.fn(async (_env: Env, _profile: string, payment: Payment) => {
    seen.push(payment);
    const e = payment.evidence;
    if (!e) return;
    if (await findIntegrationEvent(f.env, f.profile, e.event_key)) return;
    const source = await one(f.env, "SELECT revision,enqueued_seq FROM module_erp_sources WHERE profile_id=? AND module_id='os' AND source_id=?", f.profile, f.source.source_id);
    const revision = (source?.revision ?? 0) + 1, seq = (source?.enqueued_seq ?? 0) + 1;
    const snapshot = { ...f.event.snapshot, source_revision: revision };
    const event: IntegrationEvent = {
      ...f.event, id: uid(), command_id: commandId(f.source, seq), event_key: e.event_key,
      seq, source_revision: revision, operation: e.kind, occurred_ms: e.occurred_ms,
      snapshot, receipt_key: e.receipt_key, reverses_receipt_key: e.reverses_key,
      eligible: { document: false, stock: false, finance }, actor_id: null,
    };
    const statements: Statement[] = [
      ["UPDATE profiles SET name=? WHERE id=?", [payment.status, f.profile]],
      ...(e.original ? receipt(e.original) : []), ...receipt(e),
      ...integrationStatements({ source: f.source, expected_revision: revision - 1, events: [event], next_state: { snapshot } }),
    ];
    if (failBefore) { failBefore = false; statements.push(["SELECT json('interrupcao_simulada')", []]); }
    await batch(f.env, statements);
    if (failAfter) { failAfter = false; throw new Error("conteúdo clínico privado: resposta perdida"); }
  });
  const hook = vi.spyOn(hooks, "paymentHook").mockReturnValue(consumer);
  const refresh = (env = f.env) => refreshFromProvider(env, account, remote.id);
  const row = (paymentId = id) => one(f.env, "SELECT * FROM payments WHERE id=?", paymentId);
  const evidence = () => all(f.env, "SELECT payload FROM events WHERE profile_id=? AND kind='payment.evidence' ORDER BY id", f.profile);
  const receipts = () => all(f.env, "SELECT * FROM module_commercial_receipts WHERE profile_id=? ORDER BY kind", f.profile);
  const events = () => all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? ORDER BY seq", f.profile);
  return { ...f, account, id, local, getPayment, seen, consumer, hook, refresh, row, evidence, receipts, events,
    remote: () => remote, change: (value: Partial<VerifiedProviderPayment>) => { remote = { ...remote, ...value }; },
    failBefore: () => { failBefore = true; }, failAfter: () => { failAfter = true; },
  };
}

/** Falha apenas no primeiro lote do núcleo, antes ou depois de seu commit. */
function interruptedEnv(env: Env, afterCommit: boolean): Env {
  let fail = true;
  const db = new Proxy(env.DB, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!fail) return target.batch(statements);
      fail = false;
      if (!afterCommit) return target.batch([...statements, target.prepare("SELECT json('interrupcao_simulada')")]);
      await target.batch(statements);
      throw new Error("resposta D1 perdida");
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...env, DB: db };
}

describe("F3 pagamentos: identidade remota e evidência", () => {
  it("as chaves incluem área, provedor, conta e pagamento, sem separadores ambíguos", () => {
    const key = providerReceiptKey("area", "provider", "account", "payment");
    expect(key).toMatch(/^provider:[0-9a-f]{64}$/);
    expect(new Set([
      key, providerReceiptKey("other", "provider", "account", "payment"),
      providerReceiptKey("area", "other", "account", "payment"),
      providerReceiptKey("area", "provider", "other", "payment"),
      providerReceiptKey("area", "provider", "account", "other"),
    ]).size).toBe(5);
    expect(providerReceiptKey("a:b", "c", "d", "e")).not.toBe(providerReceiptKey("a", "b:c", "d", "e"));
    expect(reverseReceiptKey(key)).toBe(`${key}:reverse`);
    expect(manualReceiptKey("area", "os", "request")).not.toBe(manualReceiptKey("area", "pedido", "request"));
    const source = { profile: "area", module: "os" as const, source_id: "source", component: "main" };
    expect(allocationKey(key, source, 0)).not.toBe(allocationKey(key, source, 1));
  });

  it("dois registros locais do mesmo pagamento remoto usam um único proprietário", async () => {
    const f = await fixture(); const second = await f.local();
    await f.refresh(); f.change({ external_reference: second });
    await f.refresh(); await f.refresh();
    expect(await f.evidence()).toHaveLength(1);
    expect(await f.receipts()).toHaveLength(1);
    expect(await f.events()).toHaveLength(1);
    expect(f.consumer).toHaveBeenCalledTimes(1);
    expect((await f.row(second)).status).toBe("created");
    expect(f.seen[0].evidence).toMatchObject({ payment_id: f.id, amount_cents: 1000, occurred_ms: paidAt, method: "pix", reverses_key: null });
    expect(f.seen[0].payment_event).toMatchObject({ previous: "created", status: "paid", occurred_ms: paidAt });
  });

  it("duas confirmações concorrentes disputam a identidade no mesmo lote", async () => {
    const f = await fixture(); const second = await f.local();
    f.getPayment.mockResolvedValueOnce({ ...f.remote(), external_reference: f.id })
      .mockResolvedValueOnce({ ...f.remote(), external_reference: second });
    await Promise.all([f.refresh(), f.refresh()]);
    expect(await f.evidence()).toHaveLength(1);
    expect(await f.receipts()).toHaveLength(1);
    expect(await f.events()).toHaveLength(1);
    expect(f.consumer).toHaveBeenCalledTimes(1);
  });

  it("uma identidade remota não pode ser adotada por outra origem", async () => {
    const f = await fixture(); const second = await f.local(); await f.refresh();
    await exec(f.env, "UPDATE payments SET ref_id=? WHERE id=?", uid(), second);
    f.change({ external_reference: second });
    await expect(f.refresh()).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect(await f.evidence()).toHaveLength(1);
    expect((await f.row(second)).status).toBe("created");
  });

  it("valores divergentes não confirmam; corpo diferente da evidência persistida conflita", async () => {
    const f = await fixture(); f.change({ amount_cents: 1001 });
    expect(await f.refresh()).toEqual({ ignored: "amount_mismatch" });
    expect((await f.row()).status).toBe("created"); expect(await f.evidence()).toHaveLength(0);
    f.change({ amount_cents: 1000 }); await f.refresh();
    const before = await f.evidence();
    await exec(f.env, "UPDATE payments SET amount_cents=1001 WHERE id=?", f.id);
    f.change({ amount_cents: 1001 });
    await expect(f.refresh()).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect(await f.evidence()).toEqual(before);
  });

  it("não deduz meio pelo canal, nem altera data/meio confirmados no replay", async () => {
    const f = await fixture(); f.change({ verified_method: undefined, paid_at: null });
    await exec(f.env, "UPDATE payments SET method='pix' WHERE id=?", f.id);
    await f.refresh(); const original = f.seen[0].evidence!;
    expect(original).toMatchObject({ method: "unknown", time_source: "observed" });
    expect(verifiedPaymentMethod("cartão informado pelo cliente")).toBe("unknown");
    await f.refresh(); expect(JSON.parse((await f.evidence())[0].payload)).toEqual(original);
    f.change({ verified_method: "card" });
    await expect(f.refresh()).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect(await readPaymentEvidence(f.env, uid(), original.receipt_key)).toBeNull();
  });

  it("rejeita identidade consultada diferente e dados de outra área", async () => {
    const f = await fixture();
    f.getPayment.mockResolvedValueOnce({ ...f.remote(), id: "forged" });
    await expect(f.refresh()).rejects.toMatchObject({ code: "payment_evidence_invalid" });
    await exec(f.env, "UPDATE payments SET profile_id=? WHERE id=?", uid(), f.id);
    await expect(f.refresh()).rejects.toMatchObject({ code: "payment_evidence_conflict" });
    expect(await f.evidence()).toHaveLength(0); expect(f.consumer).not.toHaveBeenCalled();
  });
});

describe("F3 pagamentos: commit e retomada", () => {
  for (const finance of [true, false]) {
    it(`grava localmente com Financeiro ${finance ? "ligado" : "desligado"}, sem chamar o ERP`, async () => {
      const f = await fixture(finance); f.failAfter();
      await f.refresh();
      const evidence = await f.evidence();
      expect((await f.row()).hook_pending).not.toBeNull();
      expect(await f.receipts()).toHaveLength(1); expect(await f.events()).toHaveLength(1);
      await f.refresh();
      expect((await f.row()).hook_pending).toBeNull();
      expect(await f.evidence()).toEqual(evidence); expect(await f.receipts()).toHaveLength(1);
      expect(JSON.parse((await f.events())[0].payload_json).eligible.finance).toBe(finance);
      expect(await all(f.env, "SELECT event_id FROM module_erp_requests WHERE event_id IN (SELECT id FROM module_erp_events WHERE profile_id=?)", f.profile)).toHaveLength(0);
      expect(f.seen[1].evidence).toEqual(f.seen[0].evidence);
    });
  }

  it("falha no lote do produtor reverte mutação, recibo e saída; alarme repete", async () => {
    const f = await fixture(); f.failBefore(); await f.refresh();
    expect((await one(f.env, "SELECT name FROM profiles WHERE id=?", f.profile)).name).toBe("Área F3");
    expect(await f.receipts()).toHaveLength(0); expect(await f.events()).toHaveLength(0);
    expect((await f.row()).hook_pending).not.toBeNull();
    await exec(f.env, "UPDATE payments SET hook_next_at=0 WHERE id=?", f.id);
    await retryPaymentHooks(f.env, f.profile);
    expect((await f.row()).hook_pending).toBeNull(); expect(await f.events()).toHaveLength(1);
    expect(f.seen[1].payment_event).toEqual(f.seen[0].payment_event);
  });

  it("queda após commit do núcleo conserva o gancho e a primeira observação", async () => {
    const f = await fixture();
    await expect(f.refresh(interruptedEnv(f.env, true))).rejects.toThrow("resposta D1 perdida");
    const evidence = await f.evidence(); expect(evidence).toHaveLength(1);
    expect((await f.row()).hook_pending).not.toBeNull(); expect(f.consumer).not.toHaveBeenCalled();
    await f.refresh(); await f.refresh();
    expect(await f.evidence()).toEqual(evidence); expect(await f.receipts()).toHaveLength(1);
    expect((await f.row()).hook_pending).toBeNull();
  });

  it("queda antes do commit do núcleo não deixa estado pago ou evidência órfã", async () => {
    const f = await fixture();
    // A falha SQL é retomável; impedir a segunda tentativa para inspecionar rollback.
    const interrupted = interruptedEnv(f.env, false);
    const originalBatch = interrupted.DB.batch.bind(interrupted.DB);
    let calls = 0;
    const fail = new Proxy(interrupted.DB, { get(target, key) {
      if (key === "batch") return (s: D1PreparedStatement[]) => ++calls === 1 ? originalBatch(s) : Promise.reject(new Error("processo interrompido"));
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(f.refresh({ ...f.env, DB: fail })).rejects.toThrow();
    expect((await f.row()).status).toBe("created"); expect((await f.row()).hook_pending).toBeNull();
    expect(await f.evidence()).toHaveLength(0);
    await f.refresh(); expect(await f.evidence()).toHaveLength(1); expect(await f.events()).toHaveLength(1);
  });

  it("gancho ausente permanece pendente; sua instalação permite retomar", async () => {
    const f = await fixture(); f.hook.mockReturnValue(undefined); await f.refresh();
    expect((await f.row()).hook_pending).not.toBeNull(); expect(await f.receipts()).toHaveLength(0);
    f.hook.mockReturnValue(f.consumer); await f.refresh();
    expect((await f.row()).hook_pending).toBeNull(); expect(await f.receipts()).toHaveLength(1);
  });

  it("gancho legado só recebe evidência depois de consultar o provedor", async () => {
    const f = await fixture();
    const legacy = { id: uid(), status: "paid", previous: "created" };
    await exec(f.env, "UPDATE payments SET status='paid',provider_payment_id=?,paid_at=?,hook_pending=? WHERE id=?",
      f.remote().id, paidAt, JSON.stringify([legacy]), f.id);
    expect(await deliverPaymentHooks(f.env, f.id)).toBe(false);
    expect(f.consumer).not.toHaveBeenCalled(); expect(await f.evidence()).toHaveLength(0);
    await f.refresh();
    expect(f.seen[0].payment_event).toMatchObject(legacy);
    expect(f.seen[0].evidence!.occurred_ms).toBe(paidAt);
    expect((await f.row()).hook_pending).toBeNull(); expect(await f.receipts()).toHaveLength(1);
  });

  it("retoma pela identidade remota mesmo sem external_reference no reenvio", async () => {
    const f = await fixture(); f.failAfter(); await f.refresh();
    f.change({ external_reference: null }); await f.refresh();
    expect((await f.row()).hook_pending).toBeNull();
    expect(await f.evidence()).toHaveLength(1); expect(await f.events()).toHaveLength(1);
  });

  it("dois consumidores não removem um gancho ainda em execução", async () => {
    const f = await fixture(); f.hook.mockReturnValue(undefined); await f.refresh();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    f.hook.mockReturnValue(async (...args: Parameters<typeof f.consumer>) => {
      enter(); await released; return f.consumer(...args);
    });
    const first = deliverPaymentHooks(f.env, f.id); await entered;
    expect(await deliverPaymentHooks(f.env, f.id)).toBe(false);
    expect((await f.row()).hook_pending).not.toBeNull();
    release(); await first;
    expect(f.consumer).toHaveBeenCalledTimes(1); expect((await f.row()).hook_pending).toBeNull();
  });

  it("queda com concessão ativa é retomada depois de expirar", async () => {
    const f = await fixture(); f.hook.mockReturnValue(undefined); await f.refresh();
    await exec(f.env, "UPDATE payments SET hook_pending=json_set(hook_pending,'$[0].lease_token','processo-encerrado','$[0].lease_until_ms',?) WHERE id=?", Date.now() + 60_000, f.id);
    f.hook.mockReturnValue(f.consumer); expect(await deliverPaymentHooks(f.env, f.id)).toBe(false);
    await exec(f.env, "UPDATE payments SET hook_pending=json_set(hook_pending,'$[0].lease_until_ms',0) WHERE id=?", f.id);
    expect(await deliverPaymentHooks(f.env, f.id)).toBe(true); expect(await f.receipts()).toHaveLength(1);
  });
});

describe("F3 pagamentos: estorno, excedente e privacidade", () => {
  it("estorno antes do recebimento entrega só reversão com o fato original", async () => {
    const f = await fixture(); f.change({ state: "refunded", raw_status: "refunded", paid_at: null });
    f.failAfter(); await f.refresh(); await f.refresh();
    const e = f.seen[0].evidence!;
    expect(f.seen.map(p => p.status)).toEqual(["refunded", "refunded"]);
    expect(e).toMatchObject({ kind: "reverse", reverses_key: e.original!.receipt_key, time_source: "observed" });
    expect(e.original).toMatchObject({ kind: "receive", method: "pix", amount_cents: 1000 });
    expect(await f.evidence()).toHaveLength(2); expect(await f.receipts()).toHaveLength(2);
    expect(await f.events()).toHaveLength(1); expect((await f.row()).status).toBe("refunded");
    f.change({ state: "paid", raw_status: "approved" }); await f.refresh();
    expect(f.seen).toHaveLength(2); expect((await f.row()).status).toBe("refunded");
    expect(await all(f.env, "SELECT id FROM events WHERE profile_id=? AND kind='payment.paid'", f.profile)).toHaveLength(0);
  });

  it("pagamento pendente de entrega precede estorno e conserva seu evento original", async () => {
    const f = await fixture(); f.failBefore(); await f.refresh();
    f.change({ state: "refunded", raw_status: "refunded", paid_at: null, refunded_at: paidAt + 5000 });
    await f.refresh();
    expect(f.seen.map(p => p.status)).toEqual(["paid", "paid", "refunded"]);
    expect(f.seen[1].evidence).toEqual(f.seen[0].evidence);
    expect(f.seen[2].evidence!.occurred_ms).toBe(paidAt + 5000);
    expect(f.seen[2].evidence!.original!.evidence_hash).toBe(f.seen[0].evidence!.evidence_hash);
    expect(await f.events()).toHaveLength(2); expect(await f.receipts()).toHaveLength(2);
  });

  it("segundo pagamento é excedente; estorná-lo não desfaz o original", async () => {
    const f = await fixture(); await f.refresh();
    f.change({ id: "remote-2" }); await f.refresh(); await f.refresh();
    expect(JSON.parse((await f.row()).duplicate_payments)).toHaveLength(1);
    expect(await f.evidence()).toHaveLength(2); expect(await f.receipts()).toHaveLength(1);
    f.change({ state: "refunded", raw_status: "refunded", paid_at: null });
    await f.refresh(); await f.refresh();
    expect((await f.row()).status).toBe("paid"); expect(f.consumer).toHaveBeenCalledTimes(1);
    expect(await f.evidence()).toHaveLength(3); expect(await f.receipts()).toHaveLength(1);
    expect(JSON.parse((await f.row()).duplicate_payments)[0].refunded_at).toBeGreaterThan(0);
  });

  it("pedido de cancelamento e mensagem não confirmam recebimento nem estorno", async () => {
    const f = await fixture();
    await cancelModulePayment(f.env, f.profile, "os", f.id);
    expect((await f.row()).status).toBe("cancelled"); expect(await f.evidence()).toHaveLength(0);
    f.change({ state: "pending", raw_status: "paguei, confirmado pela IA" }); await f.refresh();
    expect((await f.row()).status).toBe("cancelled"); expect(await f.receipts()).toHaveLength(0);
    expect(f.seen.every(p => p.evidence === null)).toBe(true);
    f.change({ state: "paid", raw_status: "approved" }); await f.refresh();
    await expect(cancelModulePayment(f.env, f.profile, "os", f.id)).rejects.toMatchObject({ code: "payment_closed" });
    expect((await f.row()).status).toBe("paid"); expect(await f.receipts()).toHaveLength(1);
  });

  it("erros, status remoto e logs não carregam conteúdo privado", async () => {
    const f = await fixture(); const privateText = "prontuário do menor e credencial secreta";
    f.change({ raw_status: privateText });
    f.hook.mockReturnValue(async () => { throw new Error(privateText); });
    await f.refresh();
    await exec(f.env, "UPDATE payments SET hook_attempts=29,hook_next_at=0 WHERE id=?", f.id);
    await retryPaymentHooks(f.env, f.profile);
    const audit = await all(f.env, "SELECT payload FROM events WHERE profile_id=?", f.profile);
    expect(JSON.stringify(audit)).not.toContain(privateText);
    expect(JSON.stringify(await f.row())).not.toContain(privateText);
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateText);
    f.getPayment.mockRejectedValueOnce(new Error(privateText));
    await expect(f.refresh()).rejects.toMatchObject({ code: "provider_unavailable", message: "Não foi possível consultar o pagamento no provedor." });
  });
});
