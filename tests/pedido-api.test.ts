import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, one } from "../src/db";
import { json } from "../src/types";
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

  it("ferramentas MCP do Pedido aparecem e consultam pedidos", async () => {
    const { f } = await pedidoSetup();
    const app = await application(f, ["conversations:read"]);
    const rpc = (method: string, params: any = {}) =>
      SELF.fetch("https://test/api/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json<any>());
    const names = (await rpc("tools/list")).result.tools.map(
      (t: any) => t.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "pedido_cardapio",
        "pedido_consultar",
        "pedido_enviar_carrinho",
      ]),
    );
    await seedMenu(f);
    const menu = await rpc("tools/call", {
      name: "pedido_cardapio",
      arguments: {},
    });
    expect(menu.result.isError).toBeFalsy();
    expect(
      menu.result.structuredContent.categories.map((c: any) => c.name),
    ).toEqual(["Lanches", "Bebidas"]);
    // Pedidos só do cliente da conversa: o telefone de outro cliente
    // (parâmetro inexistente na ferramenta) não muda nada.
    const c = await say(f, "oi", "5511973000009");
    const orders = await rpc("tools/call", {
      name: "pedido_consultar",
      arguments: { conversation_id: c.id, phone: "5511973000001" },
    });
    expect(orders.result.isError).toBeFalsy();
    expect(orders.result.structuredContent.data).toEqual([]);
    // Sem conversa, a ferramenta recusa.
    const bare = await rpc("tools/call", {
      name: "pedido_consultar",
      arguments: { phone: "5511973000001" },
    });
    expect(bare.error.message).toMatch(/conversation_id/);
  });

  it("estorno confirmado pelo provedor fica registrado (pedido.refunded)", async () => {
    const mp = stubMercadoPago();
    const { f } = await pedidoSetup({
      menus: MENUS,
      config: { payments: { pix: true, cash: false, card: false } },
    });
    const account = await paymentAccount(f);
    const menu = await seedMenu(f);
    await say(f, "oi", "5511973000001");
    const c = await say(f, "1", "5511973000001");
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
    mp.remote.get(payment.provider_ref)!.status = "refunded";
    await webhook(account.id, payment.provider_ref);
    const after = await one(
      env,
      "SELECT payment_status,status FROM pedido_orders WHERE id=?",
      order.id,
    );
    expect(after).toEqual({ payment_status: "refunded", status: "received" });
    const refunded = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='pedido.refunded'",
      f.profile,
    );
    expect(refunded.map((r) => json(r.payload))).toEqual([
      expect.objectContaining({ order_id: order.id, amount_cents: 2400 }),
    ]);
    // Todos os eventos publicados são declarados pelo módulo.
    const kinds = await all(
      env,
      "SELECT DISTINCT kind FROM events WHERE profile_id=? AND kind LIKE 'pedido.%'",
      f.profile,
    );
    for (const { kind } of kinds) expect(pedidoModule.events).toContain(kind);
  });
});
