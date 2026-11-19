import { pageRoute, parseRoute } from "../web/lib/routes";
import { describe, expect, it } from "vitest";
import { api, bearer, configure } from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  pedidoSetup,
  run,
  say,
  seedMenu,
  submitCart,
} from "./pedido-fixture";
import { outbox } from "./service-center-fixture";
import { orderView } from "../src/modules/pedido/orders";
import { wrap } from "../src/modules/pedido/ticket";
import { pedidoDemo } from "../web/modules/pedido/demo";
import {
  areaOfPage,
  canOpenPage,
  pageModules,
  railPages,
} from "../web/workspace-navigation";

describe("pedido: comanda e painel", () => {
  it("comanda com estabelecimento, montagens, adicionais, troco e endereço em 32 colunas", async () => {
    const { f } = await pedidoSetup({
      menus: MENUS,
      config: {
        store_name: "Lanchonete da Ana",
        delivery: true,
        delivery_fee_cents: 700,
        payments: { cash: true, card: false },
      },
    });
    await configure(f, {
      establishment: {
        name: "Lanchonete da Ana",
        document: "11.222.333/0001-81",
        address: "Rua das Flores, 100 - Centro, Campinas/SP",
        phone: "(19) 3333-4444",
        footer: "Obrigado pela preferência!",
      },
    });
    const menu = await seedMenu(f);
    await say(f, "oi", "5511972000001");
    const c = await say(f, "1", "5511972000001");
    const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
    const x = menu.xburger.id;
    await submitCart(codeIn(link.text), {
      [`q_${x}`]: "1",
      [`o_${x}_${menu.ponto.id}`]: "mal",
      [`n_${x}`]: "sem cebola e sem picles, por favor, muito obrigado",
      [`slots_${x}`]: "2",
      [`q_${x}.1`]: "2",
      [`o_${x}.1_${menu.ponto.id}`]: "bem",
      [`o_${x}.1_${menu.adicionais.id}`]: ["bacon", "ovo"],
      fulfillment: "delivery",
      street: "Rua Antônio de Albuquerque Cavalcanti, 1234",
      district: "Jardim das Palmeiras",
      name: "Ana",
      note: "Interfone 12",
      confirm: "1",
    });
    await say(f, "100", "5511972000001");
    const token = await bearer(f.member);
    const list = await (
      await api(token, `/profiles/${f.profile}/pedido/orders`)
    ).json<any>();
    const id = list.data[0].id;
    const ticket = await (
      await api(token, `/profiles/${f.profile}/pedido/orders/${id}/ticket`)
    ).json<any>();
    expect(ticket.columns).toBe(32);
    expect(ticket.establishment).toMatchObject({
      name: "Lanchonete da Ana",
      document_display: "11.222.333/0001-81",
      configured: true,
    });
    // 1x 25,00 + 2x (25,00 + 5,00 + 3,00) + entrega 7,00.
    expect(ticket.order).toMatchObject({ number: 1, total_cents: 9800 });
    const lines = ticket.text.split("\n");
    for (const line of lines)
      expect(Array.from(line as string).length, line).toBeLessThanOrEqual(32);
    const text = ticket.text as string;
    expect(text).toContain("LANCHONETE DA ANA");
    expect(text).toContain("CNPJ 11.222.333/0001-81");
    expect(text).toMatch(/PEDIDO Nº 1\s+\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/);
    expect(text).toContain("ENTREGA · Recebido");
    expect(text).toMatch(/1x X-Burger\s+R\$ 25,00/);
    expect(text).toContain("   + Mal passada");
    expect(text).toContain("   Obs: sem cebola e sem picles,");
    expect(text).toMatch(/2x X-Burger\s+R\$ 66,00/);
    expect(text).toContain("   + Bacon");
    expect(text).toMatch(/Entrega\s+R\$ 7,00/);
    expect(text).toMatch(/TOTAL\s+R\$ 98,00/);
    // Linhas quebradas nas 32 colunas: confere o texto corrido.
    const flat = text.replace(/\n\s*/g, " ");
    expect(flat).toContain(
      "Pagamento: Dinheiro na entrega ou retirada (troco para R$ 100,00)",
    );
    expect(text).toContain("Tel: (11) 97200-0001");
    expect(flat).toContain(
      "Entregar em: Rua Antônio de Albuquerque Cavalcanti, 1234 - Jardim das Palmeiras",
    );
    expect(text).toContain("Obs.: Interfone 12");
    expect(text).toContain("Obrigado pela preferência!");
    const wide = await (
      await api(
        token,
        `/profiles/${f.profile}/pedido/orders/${id}/ticket?columns=48`,
      )
    ).json<any>();
    for (const line of wide.text.split("\n"))
      expect(Array.from(line as string).length).toBeLessThanOrEqual(48);
    expect(
      (
        await api(
          token,
          `/profiles/${f.profile}/pedido/orders/${id}/ticket?columns=40`,
        )
      ).status,
    ).toBe(400);
    // Observação interna não vai para a comanda.
    await run(f, f.member, "pedido.order.update", {
      id,
      notes: "Cliente chato",
    });
    const again = await (
      await api(token, `/profiles/${f.profile}/pedido/orders/${id}/ticket`)
    ).json<any>();
    expect(again.text).not.toContain("Cliente chato");
  });

  it("quebra de linha da comanda respeita as colunas", () => {
    expect(wrap("um dois três quatro", 9)).toEqual([
      "um dois",
      "três",
      "quatro",
    ]);
    expect(wrap("abcdefghijklmnop", 5)).toEqual([
      "abcde",
      "fghij",
      "klmno",
      "p",
    ]);
    expect(wrap("", 10)).toEqual([""]);
  });

  it("navegação: quadro para a equipe, cardápio só para administradores, some com o módulo desligado", () => {
    expect(pageModules.pedidos).toBe("pedido");
    expect(pageModules["pedidos-cardapio"]).toBe("pedido");
    expect(railPages.map((p) => p.page)).not.toContain("pedidos");
    expect(areaOfPage("pedidos")).toBe("erp");
    expect(pageRoute("pedidos")).toEqual({ area: "erp", page: "pedidos" });
    expect(parseRoute("/app/gestao/pedidos")).toEqual({ area: "erp", page: "pedidos" });
    expect(parseRoute("/app/gestao/cardapio-e-loja")).toEqual({ area: "erp", page: "pedidos-cardapio" });
    expect(canOpenPage("pedidos", "operator", { pedido: true })).toBe(true);
    expect(canOpenPage("pedidos-cardapio", "operator", { pedido: true })).toBe(
      false,
    );
    expect(canOpenPage("pedidos-cardapio", "admin", { pedido: true })).toBe(
      true,
    );
    expect(canOpenPage("pedidos", "admin", { pedido: false })).toBe(false);
  });

  it("dados de demonstração têm o mesmo formato das rotas", () => {
    const board = pedidoDemo("pedido/board", new URLSearchParams());
    expect(board.columns.map((c: any) => c.status)).toEqual([
      "awaiting_payment",
      "received",
      "preparing",
      "ready",
      "out_for_delivery",
    ]);
    expect(board.columns.every((c: any) => c.orders.length > 0)).toBe(true);
    const demoOrder = pedidoDemo(
      "pedido/orders/pedido-45",
      new URLSearchParams(),
    );
    expect(
      demoOrder.lines.filter((l: any) => l.name === "X-Burger"),
    ).toHaveLength(2);
    expect(demoOrder.history.length).toBeGreaterThan(0);
    // Mesmas chaves do formato do servidor (orderView).
    const real = orderView({
      id: "x",
      number: 1,
      status: "received",
      fulfillment: "pickup",
      lines: "[]",
      payment_status: "pending",
    });
    for (const key of Object.keys(real))
      expect(demoOrder, key).toHaveProperty(key);
    for (const key of Object.keys(real.payment))
      expect(demoOrder.payment, key).toHaveProperty(key);
    const menu = pedidoDemo("pedido/menu", new URLSearchParams());
    expect(menu.categories[0].items[0]).toMatchObject({
      name: "X-Burger",
      group_ids: ["ponto", "adicionais"],
    });
    const open = pedidoDemo(
      "pedido/orders",
      new URLSearchParams({ open: "1" }),
    );
    expect(
      open.data.every(
        (o: any) => !["delivered", "cancelled"].includes(o.status),
      ),
    ).toBe(true);
    expect(
      pedidoDemo("pedido/orders/pedido-45/ticket", new URLSearchParams()).text,
    ).toContain("PEDIDO Nº 45");
    expect(pedidoDemo("pedido", new URLSearchParams()).config.store_name).toBe(
      "Lanchonete da Ana",
    );
  });
});
