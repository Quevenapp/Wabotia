import { tool, toolNames } from "./module-tools-fixture";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, one } from "../src/db";
import { json, uid } from "../src/types";
import { perform } from "../src/service";
import { openapi } from "../src/openapi";
import { moduleRoutes } from "../src/modules/hooks";
import { pedidoModule } from "../src/modules/pedido/definition";
import { application, outbox } from "./service-center-fixture";
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

afterEach(() => vi.unstubAllGlobals());

const toSpec = (path: string) =>
  "/profiles/{profile}/" + path.replace(/:(\w+)/g, "{$1}");

describe("pedido: contrato da API", () => {
  it("toda rota do módulo está no OpenAPI, no grupo Pedido, com esquemas que existem", () => {
    const spec = openapi("https://test");
    const routes = [
      ...moduleRoutes()
        .read.filter((r) => r.path.startsWith("pedido"))
        .map((r) => ["get", r.path]),
      ...moduleRoutes()
        .write.filter((r) => r.path.startsWith("pedido"))
        .map((r) => [r.method.toLowerCase(), r.path]),
    ];
    expect(routes.length).toBeGreaterThan(20);
    for (const [method, path] of routes) {
      const entry = spec.paths[toSpec(path)]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.tags).toEqual(["Pedido"]);
    }
    // Referências resolvidas.
    const refs = new Set<string>();
    const walk = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.$ref === "string") refs.add(value.$ref);
      for (const child of Object.values(value)) walk(child);
    };
    for (const [path, methods] of Object.entries<any>(spec.paths))
      if (path.includes("/pedido")) walk(methods);
    for (const name of Object.keys(spec.components.schemas))
      if (name.startsWith("Pedido")) walk(spec.components.schemas[name]);
    for (const ref of refs)
      expect(
        spec.components.schemas[ref.replace("#/components/schemas/", "")],
        ref,
      ).toBeTruthy();
    expect(
      spec.paths["/profiles/{profile}/pedido/orders"].get.parameters.map(
        (p: any) => p.name,
      ),
    ).toEqual(expect.arrayContaining(["status", "open", "q", "cursor"]));
    expect(
      spec.paths[
        "/profiles/{profile}/pedido/orders/{id}/status"
      ].post.parameters.some((p: any) => p.name === "Idempotency-Key"),
    ).toBe(true);
    expect(spec.components.schemas.PedidoOrder.properties.status.enum).toEqual([
      "awaiting_payment",
      "received",
      "preparing",
      "ready",
      "out_for_delivery",
      "delivered",
      "cancelled",
    ]);
  });

  it("ferramentas em processo do Pedido aparecem e consultam pedidos", async () => {
    const { f } = await pedidoSetup();
    const app = await application(f, ["conversations:read"]);

    const names = await toolNames(app.token);
    expect(names).toEqual(
      expect.arrayContaining([
        "pedido_cardapio",
        "pedido_consultar",
        "pedido_enviar_carrinho",
      ]),
    );
    await seedMenu(f);
    const menu = await tool(app.token, "pedido_cardapio");
    expect(menu.ok).toBe(true);
    expect(
      menu.data.categories.map((c: any) => c.name),
    ).toEqual(["Lanches", "Bebidas"]);
    // Pedidos só do cliente da conversa: o telefone de outro cliente
    // (parâmetro inexistente na ferramenta) não muda nada.
    const c = await say(f, "oi", "5511973000009");
    const orders = await tool(app.token, "pedido_consultar", { conversation_id: c.id, phone: "5511973000001" });
    expect(orders.ok).toBe(true);
    expect(orders.data.data).toEqual([]);
    // Sem conversa, a ferramenta recusa.
    const bare = await tool(app.token, "pedido_consultar", { phone: "5511973000001" });
    expect(bare.error).toMatch(/conversation_id/);
  });

  async function paidPixOrder(phone: string) {
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
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    const refund = async () => {
      mp.remote.get(payment.provider_ref)!.status = "refunded";
      await webhook(account.id, payment.provider_ref);
    };
    return { f, c, order, refund };
  }

  it("estorno antes do preparo cancela o pedido (pedido.refunded, revisão M8)", async () => {
    const { f, order, refund } = await paidPixOrder("5511973000001");
    await refund();
    const after = await one(
      env,
      "SELECT payment_status,status FROM pedido_orders WHERE id=?",
      order.id,
    );
    expect(after).toEqual({ payment_status: "refunded", status: "cancelled" });
    const refunded = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='pedido.refunded'",
      f.profile,
    );
    expect(refunded.map((r) => json(r.payload))).toEqual([
      expect.objectContaining({
        order_id: order.id,
        amount_cents: 2400,
        needs_review: false,
      }),
    ]);
    // Todos os eventos publicados são declarados pelo módulo.
    const kinds = await all(
      env,
      "SELECT DISTINCT kind FROM events WHERE profile_id=? AND kind LIKE 'pedido.%'",
      f.profile,
    );
    for (const { kind } of kinds) expect(pedidoModule.events).toContain(kind);
  });

  it("estorno com o pedido em preparo vira pendência para a equipe", async () => {
    const { f, c, order, refund } = await paidPixOrder("5511973000002");
    await perform(
      env,
      f.admin,
      f.profile,
      "pedido.status",
      { id: order.id, status: "preparing" },
      uid(),
    );
    await refund();
    expect(
      await one(
        env,
        "SELECT payment_status,status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({ payment_status: "refunded", status: "preparing" });
    const [event] = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='pedido.refunded'",
      f.profile,
    );
    expect(json(event.payload)).toMatchObject({ needs_review: true });
    const notes = await all(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note'",
      c.id,
    );
    expect(notes.map((n) => n.text).join("\n")).toContain(
      `Pagamento do pedido nº ${order.number} estornado`,
    );
  });
});
