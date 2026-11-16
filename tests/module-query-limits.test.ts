// Revisão de segurança B10: lista IN sem tamanho máximo passava do limite de
// 100 parâmetros do D1 (erro 500) e LIMIT não inteiro na listagem também.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { modulesApi } from "../src/modules/api";
import { itemsByRetailer } from "../src/modules/pedido/menu";
import { catalogOrder } from "../src/modules/pedido/chat";
import { api, bearer } from "./service-center-fixture";
import { MENUS, pedidoSetup, say, seedMenu } from "./pedido-fixture";
import { reservaSetup } from "./reserva-fixture";

describe("limites de consulta nos módulos (revisão B10)", () => {
  it("listagens com limit não inteiro respondem normalmente", async () => {
    const s = await reservaSetup();
    await s.run("module.set", { id: "os", enabled: true });
    await s.run("module.set", { id: "pedido", enabled: true });
    const token = await bearer(s.f.admin);
    for (const path of [
      `/profiles/${s.f.profile}/reserva/bookings?limit=10.5`,
      `/profiles/${s.f.profile}/reserva/bookings?limit=abc`,
      `/profiles/${s.f.profile}/service-orders?limit=2.7`,
      `/profiles/${s.f.profile}/pedido/orders?limit=3.3`,
    ])
      expect((await api(token, path)).status, path).toBe(200);
  });

  it("conferência B10: status repetido muitas vezes não estoura o D1", async () => {
    const s = await reservaSetup();
    for (const id of ["os", "pedido", "agenda"])
      await s.run("module.set", { id, enabled: true });
    const token = await bearer(s.f.admin);
    const many = (status: string) => Array(120).fill(status).join(",");
    const p = s.f.profile;
    for (const path of [
      `/profiles/${p}/service-orders?status=${many("received")}`,
      `/profiles/${p}/pedido/orders?status=${many("received")}`,
      `/profiles/${p}/reserva/bookings?status=${many("confirmed")}`,
      `/profiles/${p}/agenda/appointments?status=${many("booked")}&from=${Date.now()}&to=${Date.now() + 86400000}`,
    ])
      expect((await api(token, path)).status, path.split("?")[0]).toBe(200);
  });

  it("muitos retailer_id não estouram o limite de parâmetros", async () => {
    const { f } = await pedidoSetup({ menus: MENUS });
    await seedMenu(f);
    const ctx = modulesApi(env, f.profile, "pedido");
    const ids = Array.from({ length: 250 }, (_, i) => `X-${i}`);
    ids.push("SUCO-500");
    const items = await itemsByRetailer(ctx, ids);
    expect(items.map((i: any) => i.retailer_id)).toEqual(["SUCO-500"]);
    // Carrinho do catálogo com produtos demais vai para a equipe.
    const c = await say(f, "oi", "5511973400001");
    const handled = await catalogOrder(
      ctx,
      c,
      {
        order: {
          items: Array.from({ length: 61 }, (_, i) => ({
            product_retailer_id: `P-${i}`,
            quantity: 1,
          })),
        },
      },
      "row-1",
    );
    expect(handled).toBe(false);
  });
});
