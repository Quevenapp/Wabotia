// Ganchos do Pedido para outros módulos (src/modules/pedido/public.ts), como
// a Entrega usa: mudança de estado, aviso no lugar do Pedido e entregador e
// previsão no quadro da cozinha. Aqui um módulo de mentira ("os") faz o papel
// da Entrega; só é chamado quando está ligado.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { perform } from "../src/service";
import { modulesApi } from "../src/modules/api";
import { board, orderDetail } from "../src/modules/pedido/manage";
import { outbox } from "./service-center-fixture";
import { MENUS, pedidoSetup, run, say, seedMenu } from "./pedido-fixture";
import {
  onOrderStatusChanged,
  onStatusNotice,
  provideDeliveryInfo,
  type StatusChange,
  type StatusNotice,
} from "../src/modules/pedido/public";

const off: (() => void)[] = [];
afterEach(() => {
  while (off.length) off.pop()!();
});

/** Pedido de entrega pago na entrega, já recebido, com conversa. */
async function deliveryOrder() {
  const { f } = await pedidoSetup({
    menus: MENUS,
    config: { delivery: true, payments: { cash: true, card: false } },
  });
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "os", enabled: true },
    uid(),
  );
  const menu = await seedMenu(f);
  const c = await say(f, "oi", "5511977770001");
  const order = await run(f, f.admin, "pedido.order.create", {
    items: [{ item_id: menu.suco.id, quantity: 1 }],
    fulfillment: "delivery",
    address: { street: "Rua A, 10", district: "Centro" },
    conversation_id: c.id,
    payment_method: "cash",
    notify: false,
  });
  return { f, c, order };
}

describe("pedido: ganchos para outros módulos", () => {
  it("avisa a mudança de estado e deixa outro módulo mandar o aviso no lugar", async () => {
    const { f, c, order } = await deliveryOrder();
    const changes: StatusChange[] = [];
    const notices: StatusNotice[] = [];
    off.push(
      onOrderStatusChanged("os", async (_e, profile, change) => {
        expect(profile).toBe(f.profile);
        changes.push(change);
      }),
      onStatusNotice("os", async (_e, _p, notice) => {
        notices.push(notice);
        return notice.status === "out_for_delivery";
      }),
    );
    const before = (await outbox(c.id)).length;
    await run(f, f.admin, "pedido.status", {
      id: order.id,
      status: "out_for_delivery",
    });
    // O aviso "saiu para entrega" ficou com o outro módulo: o Pedido calou.
    expect((await outbox(c.id)).length).toBe(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      status: "out_for_delivery",
      conversation_id: c.id,
      order: { id: order.id, number: order.number },
    });
    expect(notices[0].text).toContain(String(order.number));
    await run(f, f.admin, "pedido.status", {
      id: order.id,
      status: "delivered",
    });
    // "Entregue" o módulo deixou com o Pedido (devolveu false).
    expect((await outbox(c.id)).length).toBe(before + 1);
    expect(changes.map((x) => [x.from, x.to])).toEqual([
      ["received", "out_for_delivery"],
      ["out_for_delivery", "delivered"],
    ]);
    expect(changes[1].order.status).toBe("delivered");
  });

  it("gancho com erro não derruba o Pedido; módulo desligado não é chamado", async () => {
    const { f, c, order } = await deliveryOrder();
    let called = 0;
    off.push(
      onStatusNotice("os", async () => {
        throw new Error("falhou");
      }),
      onOrderStatusChanged("reserva", async () => {
        called++;
      }),
    );
    const before = (await outbox(c.id)).length;
    await run(f, f.admin, "pedido.status", {
      id: order.id,
      status: "out_for_delivery",
    });
    // Com erro, o Pedido manda o aviso dele; Reserva desligada não é chamada.
    expect((await outbox(c.id)).length).toBe(before + 1);
    expect(called).toBe(0);
  });

  it("entregador e previsão no quadro da cozinha e no detalhe", async () => {
    const { f, order } = await deliveryOrder();
    const asked: string[][] = [];
    off.push(
      provideDeliveryInfo("os", async (_e, _p, ids) => {
        asked.push(ids);
        return new Map([
          [
            order.id,
            {
              status: "en_route",
              status_label: "A caminho",
              courier_id: f.member.id,
              courier_name: "Carlos",
              eta_at: 1_800_000_000_000,
              eta_minutes: 12,
              position_at: 1_799_999_990_000,
            },
          ],
        ]);
      }),
    );
    const ctx = modulesApi(env, f.profile, "pedido");
    const view = await board(ctx, Date.now());
    const card = view.columns
      .flatMap((col: any) => col.orders)
      .find((o: any) => o.id === order.id);
    expect(card.delivery).toMatchObject({
      courier_name: "Carlos",
      eta_minutes: 12,
    });
    expect(asked).toEqual([[order.id]]);
    const detail = await orderDetail(ctx, order.id);
    expect(detail.delivery?.courier_name).toBe("Carlos");
    // Sem o módulo ligado, null e nenhuma chamada.
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: false },
      uid(),
    );
    const plain = await orderDetail(ctx, order.id);
    expect(plain.delivery).toBeNull();
    expect(asked).toHaveLength(2);
  });
});
