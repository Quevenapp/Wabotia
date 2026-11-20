// Contratação que substitui outra na mesma conversa, com queda do Worker em
// cada ponto: a anterior não pode ficar pendente e pagável ao lado da nova.
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec } from "../src/db";
import { ApiError, uid, type Conversation } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { createPlan } from "../src/modules/mensalidade/store";
import { chargeContract, createContract, loadContract } from "../src/modules/mensalidade/contracts";
import { mensalidadeProducer, reconcileMensalidadeContracts } from "../src/modules/mensalidade/integration";
import { today } from "../src/modules/mensalidade/model";
import * as payMessage from "../src/modules/mensalidade/pay-message";
import { registerIntegrationProducer } from "../src/integrations/registry";
import type { IntegrationEvent } from "../src/integrations/contracts";
import type { Payment } from "../src/payments";
import { f3Fixture, setParts } from "./helpers/f3-fixtures";

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const f = await f3Fixture();
  await setParts(f.profile, { mensalidade: true, "erp-financeiro": true, "erp-vendas": false }, Date.now() - 1000);
  registerIntegrationProducer(mensalidadeProducer);
  vi.spyOn(payMessage, "sendPayMessage").mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Cobranças simuladas: as abertas são as que o cliente ainda consegue pagar.
  const open = new Set<string>();
  const charged: Payment[] = [];
  const ctx = {
    ...modulesApi(f.env, f.profile, "mensalidade"),
    publish: vi.fn().mockResolvedValue(1),
    conversation: vi.fn().mockRejectedValue(new Error("sem conversa")),
    conversationByPhone: vi.fn().mockResolvedValue(null),
    charge: vi.fn(async (_c: Conversation, request: { method: "pix" | "link"; amount_cents: number }) => {
      const payment = { id: uid(), method: request.method, amount_cents: request.amount_cents, status: "created",
        expires_at: Date.now() + 86_400_000, pix_code: "pix", url: null } as unknown as Payment;
      open.add(payment.id); charged.push(payment);
      return payment;
    }),
    // Idempotente como cancelModulePayment: cancelar de novo devolve a cancelada.
    cancelCharge: vi.fn(async (id: string) => {
      open.delete(id);
      return { id, status: "cancelled" } as unknown as Payment;
    }),
  };
  const payer = uid();
  await exec(f.env, "INSERT INTO mensalidade_payers(id,profile_id,name,contact_id,created_by,created,updated) VALUES(?,?,'Responsável',?,?,?,?)", payer, f.profile, f.local, f.actor.id, Date.now(), Date.now());
  const day = today(Date.now());
  const plan = await createPlan(ctx, { name: "Plano", amount_cents: 10000, due_day: Number(day.slice(-2)), sellable: true }, f.actor.id);
  const c = { id: uid() } as Conversation;
  /** O mesmo caminho de contractPlan (public.ts): grava ou retoma, e cobra se ainda não cobrou. */
  const contract = async (sourceKey: string) => {
    const row = await createContract(ctx, { c, plan, phone: "5511999998888", payer_id: payer, document: null, name: "Responsável",
      method: "pix", sourceKey, actor: f.actor.id });
    return row.payment_id && row.status === "pending" ? row : chargeContract(ctx, row, c, "pix", `contrato:${sourceKey}`);
  };
  const events = async () => (await all(f.env, "SELECT payload_json FROM module_erp_events WHERE profile_id=? AND module_id='mensalidade'", f.profile))
    .map(r => JSON.parse(r.payload_json) as IntegrationEvent);
  const cancels = async (id: string) => (await events()).filter(e => e.operation === "cancel" && e.source.source_id === `contract:${id}`);
  /** A anterior cancelada (cobrança e título) antes da cobrança da nova; uma cobrança por contratação. */
  const expectReplaced = async (a: any, b: any) => {
    const old = await loadContract(ctx, a.id);
    expect(old).toMatchObject({ status: "cancelled", payment_id: a.payment_id, payment_status: "cancelled" });
    expect(open.has(a.payment_id)).toBe(false);
    expect(await cancels(a.id)).toEqual([expect.objectContaining({ reason_code: "contract_replaced" })]);
    const fresh = await loadContract(ctx, b.id);
    expect(fresh.status).toBe("pending");
    expect(charged).toHaveLength(2);
    expect(fresh.payment_id).toBe(charged[1].id);
    expect([...open]).toEqual([fresh.payment_id]);
    const cancelledA = ctx.cancelCharge.mock.calls.map((call, i) => call[0] === a.payment_id ? ctx.cancelCharge.mock.invocationCallOrder[i] : 0);
    expect(Math.max(...cancelledA)).toBeGreaterThan(0);
    expect(Math.max(...cancelledA)).toBeLessThan(ctx.charge.mock.invocationCallOrder.at(-1)!);
    expect(await cancels(b.id)).toHaveLength(0);
  };
  return { ...f, ctx, open, charged, contract, cancels, expectReplaced };
}

describe("Mensalidade: contratação que substitui outra, com queda em cada ponto", () => {
  it("sem queda: cancela a cobrança e o título da anterior e cobra a nova", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    const b = await s.contract(uid());
    await s.expectReplaced(a, b);
  });

  it("queda depois de gravar a nova e antes de cancelar a anterior: a retomada cancela antes de cobrar", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    const key = uid();
    s.ctx.cancelCharge.mockRejectedValueOnce(new Error("queda do Worker"));
    await expect(s.contract(key)).rejects.toThrow("queda do Worker");
    // A intenção foi gravada com a nova: a anterior já não está pendente.
    expect((await loadContract(s.ctx, a.id)).status).toBe("cancelled");
    expect(s.charged).toHaveLength(1);
    const b = await s.contract(key);
    await s.expectReplaced(a, b);
  });

  it("queda depois de cancelar a cobrança anterior e antes de cobrar a nova: retoma sem duplicar", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    const key = uid();
    s.ctx.cancelCharge.mockImplementationOnce(async (id: string) => {
      s.open.delete(id);
      throw new Error("queda depois de cancelar");
    });
    await expect(s.contract(key)).rejects.toThrow("queda depois de cancelar");
    expect(s.charged).toHaveLength(1);
    const b = await s.contract(key);
    await s.expectReplaced(a, b);
    expect(s.ctx.cancelCharge.mock.calls.filter(call => call[0] === a.payment_id)).toHaveLength(2);
  });

  it("queda ao cobrar a nova, depois de cancelar a anterior: retoma com um cancelamento só", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    const key = uid();
    s.ctx.charge.mockRejectedValueOnce(new Error("queda ao cobrar"));
    await expect(s.contract(key)).rejects.toThrow("queda ao cobrar");
    const b = await s.contract(key);
    await s.expectReplaced(a, b);
  });

  it("sem retomada: a reconciliação alcança a anterior e cancela cobrança e título, uma vez", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    s.ctx.cancelCharge.mockRejectedValueOnce(new Error("queda do Worker"));
    await expect(s.contract(uid())).rejects.toThrow("queda do Worker");
    expect(s.open.has(a.payment_id)).toBe(true);
    await reconcileMensalidadeContracts(s.ctx);
    await reconcileMensalidadeContracts(s.ctx);
    expect(await loadContract(s.ctx, a.id)).toMatchObject({ status: "cancelled", payment_status: "cancelled" });
    expect(s.open.has(a.payment_id)).toBe(false);
    expect(await s.cancels(a.id)).toEqual([expect.objectContaining({ reason_code: "contract_replaced" })]);
    expect(s.ctx.cancelCharge.mock.calls.filter(call => call[0] === a.payment_id)).toHaveLength(2);
  });

  it("anterior paga durante a troca: volta a pendente e o título dela não é cancelado", async () => {
    const s = await setup();
    const a = await s.contract(uid());
    s.ctx.cancelCharge.mockRejectedValueOnce(new ApiError(409, "payment_closed", "paga"));
    await s.contract(uid());
    expect((await loadContract(s.ctx, a.id)).status).toBe("pending");
    await reconcileMensalidadeContracts(s.ctx);
    expect(await s.cancels(a.id)).toHaveLength(0);
  });
});
