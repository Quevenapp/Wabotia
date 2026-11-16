// Revisão de segurança M8: estorno, contestação e pagamento em duplicidade.
// Antes: o segundo pagamento da mesma cobrança era ignorado sem aviso; o
// estorno antes do primeiro aviso confirmava a reserva e mandava o
// comprovante; e a reserva estornada continuava confirmada.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now } from "../src/types";
import { outbox, receive } from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  paymentAccount,
  pedidoSetup,
  say,
  seedMenu,
  stubMercadoPago,
  submitCart,
  webhook,
} from "./pedido-fixture";
import { future, reservaSetup } from "./reserva-fixture";

afterEach(() => vi.unstubAllGlobals());

async function pixOrder(phone: string) {
  const mp = stubMercadoPago();
  const { f } = await pedidoSetup({
    menus: MENUS,
    config: { payments: { pix: true, cash: false, card: false } },
  });
  const account = await paymentAccount(f);
  const menu = await seedMenu(f);
  await say(f, "oi", phone);
  const c = await say(f, "1", phone);
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
  await submitCart(codeIn(link.text), {
    [`q_${menu.suco.id}`]: "3",
    fulfillment: "pickup",
    name: "Lia",
    confirm: "1",
  });
  const order = await one(
    env,
    "SELECT * FROM pedido_orders WHERE conversation_id=?",
    c.id,
  );
  const payment = await one(
    env,
    "SELECT * FROM payments WHERE id=?",
    order.payment_id,
  );
  return { mp, f, c, account, order, payment };
}

describe("estorno e duplicidade (revisão M8)", () => {
  it("link pago duas vezes: payment.duplicate uma vez e nota para estornar", async () => {
    const { mp, f, c, account, payment } = await pixOrder("5511973100001");
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    // Segundo pagamento aprovado com a mesma referência e outro id.
    const second = "999000111";
    mp.remote.set(second, {
      status: "approved",
      amount: payment.amount_cents / 100,
      ref: payment.id,
    });
    await webhook(account.id, second);
    await webhook(account.id, second);
    const events = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='payment.duplicate'",
      f.profile,
    );
    expect(events).toHaveLength(1);
    expect(json(events[0].payload)).toMatchObject({
      id: payment.id,
      duplicate_provider_payment_id: second,
      needs_refund: true,
    });
    const row = await one(
      env,
      "SELECT status,duplicate_payments FROM payments WHERE id=?",
      payment.id,
    );
    expect(row.status).toBe("paid");
    expect(JSON.parse(row.duplicate_payments).map((d: any) => d.id)).toEqual([
      second,
    ]);
    const notes = await all(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note'",
      c.id,
    );
    expect(notes.map((n) => n.text).join("\n")).toContain(
      "Pagamento em duplicidade",
    );
  });

  it("N-1: estornar o pagamento duplicado não estorna a cobrança nem cancela o pedido", async () => {
    const { mp, f, c, account, order, payment } =
      await pixOrder("5511973100009");
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    const second = "999000222";
    mp.remote.set(second, {
      status: "approved",
      amount: payment.amount_cents / 100,
      ref: payment.id,
    });
    await webhook(account.id, second);
    // A equipe estorna o segundo pagamento (ou o cliente contesta).
    mp.remote.get(second)!.status = "refunded";
    await webhook(account.id, second);
    await webhook(account.id, second);
    expect(
      (await one(env, "SELECT status FROM payments WHERE id=?", payment.id))
        .status,
    ).toBe("paid");
    expect(
      (await one(env, "SELECT status FROM pedido_orders WHERE id=?", order.id))
        .status,
    ).not.toBe("cancelled");
    const refunded = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='payment.duplicate_refunded'",
      f.profile,
    );
    expect(refunded).toHaveLength(1);
    const dupes = JSON.parse(
      (
        await one(
          env,
          "SELECT duplicate_payments FROM payments WHERE id=?",
          payment.id,
        )
      ).duplicate_payments,
    );
    expect(dupes[0]).toMatchObject({ id: second });
    expect(dupes[0].refunded_at).toBeGreaterThan(0);
    const notes = await all(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note'",
      c.id,
    );
    expect(notes.map((n) => n.text).join("\n")).toContain(
      "Pagamento em duplicidade estornado",
    );
    // Contestação de outro pagamento qualquer também não mexe.
    mp.remote.set("999000333", {
      status: "charged_back",
      amount: payment.amount_cents / 100,
      ref: payment.id,
    });
    await webhook(account.id, "999000333");
    expect(
      (await one(env, "SELECT status FROM payments WHERE id=?", payment.id))
        .status,
    ).toBe("paid");
  });

  it("estorno antes do primeiro aviso: sem comprovante e o módulo vê só o estorno", async () => {
    const { mp, account, c, order, payment } = await pixOrder("5511973100002");
    mp.remote.get(payment.provider_ref)!.status = "refunded";
    await webhook(account.id, payment.provider_ref);
    expect(
      (await one(env, "SELECT status FROM payments WHERE id=?", payment.id))
        .status,
    ).toBe("refunded");
    // O pedido nunca foi para a cozinha: cancelado, sem "Pagamento recebido".
    expect(
      (await one(env, "SELECT status FROM pedido_orders WHERE id=?", order.id))
        .status,
    ).toBe("cancelled");
    const texts = (await outbox(c.id)).map((m) => String(m.text));
    expect(texts.join("\n")).not.toContain("Pagamento recebido");
    expect(texts.join("\n")).not.toContain("Pagamento confirmado");
  });

  it("Reserva: sinal estornado antes da chegada cancela a reserva e libera a unidade", async () => {
    const mp = stubMercadoPago();
    const s = await reservaSetup({
      rules: { deposit_type: "percent", deposit_percent: 30 },
    });
    await exec(
      env,
      "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://pousada.example.com',?)",
      now(),
    );
    const account = await paymentAccount(s.f);
    const c = await receive(s.f, s.f.line, "oi", "5511973100003");
    const booking = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(10),
      nights: 1,
      conversation_id: c.id,
      deposit: true,
    });
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      booking.payment_id,
    );
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    expect(
      (
        await one(
          env,
          "SELECT status FROM reserva_bookings WHERE id=?",
          booking.id,
        )
      ).status,
    ).toBe("confirmed");
    mp.remote.get(payment.provider_ref)!.status = "refunded";
    await webhook(account.id, payment.provider_ref);
    expect(
      await one(
        env,
        "SELECT status,payment_status FROM reserva_bookings WHERE id=?",
        booking.id,
      ),
    ).toEqual({ status: "cancelled", payment_status: "refunded" });
  });
});
