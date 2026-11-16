import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { drain, receive } from "./service-center-fixture";
import { paymentAccount, stubMercadoPago, webhook } from "./pedido-fixture";
import { failure, run, seedCatalog, vendasSetup } from "./vendas-fixture";

afterEach(() => vi.unstubAllGlobals());

const stock = async (id: string) =>
  (await one(env, "SELECT stock_milli FROM vendas_products WHERE id=?", id))!
    .stock_milli as number;

describe("vendas: Pix pelo Mercado Pago", () => {
  it("segura o estoque até o pagamento; pago conclui, vencido devolve", async () => {
    const mp = stubMercadoPago();
    const { f } = await vendasSetup({
      config: { payment_methods: { pix: true } },
    });
    const p = await seedCatalog(f);
    const account = await paymentAccount(f);
    const c = await receive(f, f.line, "oi", "5511963000001");
    await drain(f);
    // Sem conversa: recusa antes de baixar o estoque.
    expect(
      await failure(
        run(f, f.admin, "vendas.sale.create", {
          lines: [{ product_id: p.cafe.id, quantity: 1 }],
          payments: [{ method: "pix", amount_cents: 1890 }],
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(await stock(p.cafe.id)).toBe(2000);

    const sale = await run(f, f.admin, "vendas.sale.create", {
      conversation_id: c.id,
      lines: [{ product_id: p.cafe.id, quantity: 1 }],
      payments: [{ method: "pix", amount_cents: 1890 }],
    });
    expect(sale).toMatchObject({
      status: "awaiting_payment",
      paid_cents: 0,
      payment: { status: "created" },
    });
    expect(sale.payment.pix_code).toContain("00020126PIX");
    expect(await stock(p.cafe.id)).toBe(1000);
    const providerId = [...mp.remote.keys()][0];
    mp.remote.get(providerId)!.status = "approved";
    expect((await webhook(account.id, providerId)).status).toBe(200);
    expect(await one(env, "SELECT status,payment_status,paid_cents FROM vendas_sales WHERE id=?", sale.id)).toEqual({
      status: "completed",
      payment_status: "paid",
      paid_cents: 1890,
    });

    // Segunda venda: a cobrança vence e o estoque volta.
    const second = await run(f, f.admin, "vendas.sale.create", {
      conversation_id: c.id,
      lines: [{ product_id: p.cafe.id, quantity: 1 }],
      payments: [{ method: "pix", amount_cents: 1890 }],
    });
    expect(await stock(p.cafe.id)).toBe(0);
    await exec(env, "UPDATE payments SET expires_at=1 WHERE id=?", second.payment.id);
    const { expirePayments } = await import("../src/payments");
    await expirePayments(env, f.profile);
    const { deliverPaymentHooks } = await import("../src/payments");
    await deliverPaymentHooks(env, second.payment.id);
    expect(await one(env, "SELECT status FROM vendas_sales WHERE id=?", second.id)).toEqual({
      status: "cancelled",
    });
    expect(await stock(p.cafe.id)).toBe(1000);
  });
});
