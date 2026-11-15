// Revisão de segurança B6: qualquer atendente que via a conversa cancelava a
// cobrança aberta por um módulo (o Pix do Pedido, o sinal da Reserva),
// fora do fluxo do módulo.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { one } from "../src/db";
import { api, bearer, claim, outbox } from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  paymentAccount,
  pedidoSetup,
  say,
  seedMenu,
  stubMercadoPago,
  submitCart,
} from "./pedido-fixture";

afterEach(() => vi.unstubAllGlobals());

describe("cancelar cobrança de módulo (revisão B6)", () => {
  it("atendente que não atende a conversa não cancela; dono e administrador sim", async () => {
    stubMercadoPago();
    const { f } = await pedidoSetup({
      menus: MENUS,
      config: { payments: { pix: true, cash: false, card: false } },
    });
    await paymentAccount(f);
    const menu = await seedMenu(f);
    await say(f, "oi", "5511973300001");
    const c = await say(f, "1", "5511973300001");
    const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
    await submitCart(codeIn(link.text), {
      [`q_${menu.suco.id}`]: "1",
      fulfillment: "pickup",
      name: "Lia",
      confirm: "1",
    });
    const order = await one(
      env,
      "SELECT payment_id FROM pedido_orders WHERE conversation_id=?",
      c.id,
    );
    const path = `/profiles/${f.profile}/payments/${order.payment_id}/cancel`;
    const denied = await api(await bearer(f.member), path, "POST", {});
    expect(denied.status).toBe(403);
    expect(
      (
        await one(
          env,
          "SELECT status FROM payments WHERE id=?",
          order.payment_id,
        )
      ).status,
    ).toBe("created");
    // Quem atende a conversa pode.
    await claim(f, f.member, c.id);
    const owner = await api(await bearer(f.member), path, "POST", {});
    expect(owner.status).toBe(200);
    expect((await owner.json<any>()).status).toBe("cancelled");
  });
});
