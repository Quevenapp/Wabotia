// Conferência A3 (resíduo médio): no núcleo o gancho repete até concluir,
// mas Pedido e Reserva marcavam "pago" e só depois agiam; se falhassem no
// meio, a repetição encontrava a linha já marcada e saía. O pedido ficava
// parado em awaiting_payment e a reserva confirmada sem aviso.
// A falha é simulada com um gatilho no banco que derruba a gravação do
// evento do módulo uma vez.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { now } from "../src/types";
import { api, bearer, outbox, receive } from "./service-center-fixture";
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

const failEvent = (kind: string) =>
  exec(
    env,
    `CREATE TRIGGER IF NOT EXISTS falha_teste BEFORE INSERT ON events WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'falha simulada'); END`,
  );
const heal = () => exec(env, "DROP TRIGGER IF EXISTS falha_teste");

describe("gancho de pagamento repetido refaz os passos do módulo (conferência A3)", () => {
  it("Pedido: falha depois de marcar pago; a repetição põe o pedido no preparo", async () => {
    const mp = stubMercadoPago();
    const { f } = await pedidoSetup({
      menus: MENUS,
      config: { payments: { pix: true, cash: false, card: false } },
    });
    const account = await paymentAccount(f);
    const menu = await seedMenu(f);
    await say(f, "oi", "5511973500001");
    const c = await say(f, "1", "5511973500001");
    const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
    await submitCart(codeIn(link.text), {
      [`q_${menu.suco.id}`]: "1",
      fulfillment: "pickup",
      name: "Lia",
      confirm: "1",
    });
    const order = await one(
      env,
      "SELECT id,payment_id FROM pedido_orders WHERE conversation_id=?",
      c.id,
    );
    const payment = await one(
      env,
      "SELECT provider_ref FROM payments WHERE id=?",
      order.payment_id,
    );
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await failEvent("pedido.paid");
    try {
      await webhook(account.id, payment.provider_ref);
    } finally {
      await heal();
    }
    expect(
      await one(
        env,
        "SELECT status,payment_status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({ status: "awaiting_payment", payment_status: "paid" });
    // Reenvio do webhook: o núcleo repete o gancho pendente.
    await webhook(account.id, payment.provider_ref);
    expect(
      (await one(env, "SELECT status FROM pedido_orders WHERE id=?", order.id))
        .status,
    ).toBe("received");
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='pedido.paid'",
        f.profile,
      ),
    ).toHaveLength(1);
    expect(
      (
        await one(
          env,
          "SELECT hook_pending FROM payments WHERE id=?",
          order.payment_id,
        )
      ).hook_pending,
    ).toBeNull();
  });

  it("Reserva: confirmada pelo sinal sem o aviso; a repetição publica e avisa uma vez", async () => {
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
    const c = await receive(s.f, s.f.line, "oi", "5511973500002");
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(12),
      nights: 1,
      conversation_id: c.id,
      deposit: true,
    });
    const payment = await one(
      env,
      "SELECT provider_ref FROM payments WHERE id=?",
      b.payment_id,
    );
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await failEvent("reserva.confirmed");
    try {
      await webhook(account.id, payment.provider_ref);
    } finally {
      await heal();
    }
    expect(
      (await one(env, "SELECT status FROM reserva_bookings WHERE id=?", b.id))
        .status,
    ).toBe("confirmed");
    await webhook(account.id, payment.provider_ref);
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='reserva.confirmed'",
        s.f.profile,
      ),
    ).toHaveLength(1);
    // O aviso de confirmação sai uma vez.
    expect(
      await all(
        env,
        "SELECT id FROM outbox WHERE conversation_id=? AND instr(dedupe,?)>0",
        c.id,
        `confirmed:${b.id}`,
      ),
    ).toHaveLength(1);
  });
});

// Pedido com Pix pronto para pagar (cobrança aberta no Mercado Pago simulado).
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
    [`q_${menu.suco.id}`]: "1",
    fulfillment: "pickup",
    name: "Lia",
    confirm: "1",
  });
  const order = await one(
    env,
    "SELECT id,payment_id FROM pedido_orders WHERE conversation_id=?",
    c.id,
  );
  const payment = await one(
    env,
    "SELECT provider_ref FROM payments WHERE id=?",
    order.payment_id,
  );
  return { mp, f, account, c, order, ref: payment.provider_ref as string };
}
const count = async (profile: string, kind: string) =>
  (
    await all(
      env,
      "SELECT id FROM events WHERE profile_id=? AND kind=?",
      profile,
      kind,
    )
  ).length;

describe("segunda conferência N2-2: pago à mão e depois online", () => {
  it("vira pendência de estorno, com evento e nota, em vez de repetição", async () => {
    const { mp, f, account, c, order, ref } = await pixOrder("5511973500014");
    // A cobrança venceu e a equipe recebeu por fora.
    await exec(
      env,
      "UPDATE pedido_orders SET payment_status='expired' WHERE id=?",
      order.id,
    );
    const manual = await api(
      await bearer(f.admin),
      `/profiles/${f.profile}/pedido/orders/${order.id}/paid`,
      "POST",
      { note: "Pago em dinheiro" },
    );
    expect(manual.status).toBe(200);
    // O cliente paga o Pix antigo mesmo assim.
    mp.remote.get(ref)!.status = "approved";
    await webhook(account.id, ref);
    expect(
      (
        await one(
          env,
          "SELECT needs_refund FROM pedido_orders WHERE id=?",
          order.id,
        )
      ).needs_refund,
    ).toBe(1);
    const late = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='pedido.payment_late'",
      f.profile,
    );
    expect(late).toHaveLength(1);
    expect(JSON.parse(late[0].payload).reason).toBe("paid_manually");
    expect(
      await all(
        env,
        "SELECT id FROM messages WHERE conversation_id=? AND external_id LIKE 'note:pedido:double:%'",
        c.id,
      ),
    ).toHaveLength(1);
  });
});

describe("gancho repetido refaz o que se perdeu depois da gravação (segunda conferência A3)", () => {
  it("Pedido: cobrança cancelada com falha no meio; a repetição cancela o pedido", async () => {
    const { mp, f, account, order, ref } = await pixOrder("5511973500011");
    mp.remote.get(ref)!.status = "cancelled";
    await failEvent("pedido.payment_expired");
    try {
      await webhook(account.id, ref);
    } finally {
      await heal();
    }
    expect(
      await one(
        env,
        "SELECT status,payment_status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({ status: "awaiting_payment", payment_status: "cancelled" });
    await webhook(account.id, ref);
    expect(
      (await one(env, "SELECT status FROM pedido_orders WHERE id=?", order.id))
        .status,
    ).toBe("cancelled");
    expect(await count(f.profile, "pedido.payment_expired")).toBe(1);
  });

  it("Pedido: pago e movido, mas o evento do estado falhou; a repetição publica e avisa uma vez", async () => {
    const { mp, f, account, c, order, ref } = await pixOrder("5511973500012");
    mp.remote.get(ref)!.status = "approved";
    await failEvent("pedido.status_changed");
    try {
      await webhook(account.id, ref);
    } finally {
      await heal();
    }
    expect(
      (await one(env, "SELECT status FROM pedido_orders WHERE id=?", order.id))
        .status,
    ).toBe("received");
    expect(await count(f.profile, "pedido.status_changed")).toBe(0);
    await webhook(account.id, ref);
    await webhook(account.id, ref);
    expect(await count(f.profile, "pedido.status_changed")).toBe(1);
    expect(
      await all(
        env,
        "SELECT id FROM outbox WHERE conversation_id=? AND instr(dedupe,?)>0",
        c.id,
        `status:${order.id}:`,
      ),
    ).toHaveLength(1);
  });

  it("Reserva: sinal vencido com falha depois de liberar; a repetição publica e avisa uma vez", async () => {
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
    const c = await receive(s.f, s.f.line, "oi", "5511973500013");
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(13),
      nights: 1,
      conversation_id: c.id,
      deposit: true,
    });
    const payment = await one(
      env,
      "SELECT provider_ref FROM payments WHERE id=?",
      b.payment_id,
    );
    mp.remote.get(payment.provider_ref)!.status = "cancelled";
    await failEvent("reserva.expired");
    try {
      await webhook(account.id, payment.provider_ref);
    } finally {
      await heal();
    }
    expect(
      (await one(env, "SELECT status FROM reserva_bookings WHERE id=?", b.id))
        .status,
    ).toBe("expired");
    expect(await count(s.f.profile, "reserva.expired")).toBe(0);
    await webhook(account.id, payment.provider_ref);
    await webhook(account.id, payment.provider_ref);
    expect(await count(s.f.profile, "reserva.expired")).toBe(1);
    expect(
      await all(
        env,
        "SELECT id FROM outbox WHERE conversation_id=? AND instr(dedupe,?)>0",
        c.id,
        `expired:${b.id}`,
      ),
    ).toHaveLength(1);
  });
});
