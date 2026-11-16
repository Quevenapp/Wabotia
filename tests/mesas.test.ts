// Mesas: conta da mesa pelo celular do garçom, sobre o cardápio e o quadro da
// cozinha do Pedido.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { json, uid } from "../src/types";
import { perform } from "../src/service";
import { openapi } from "../src/openapi";
import { moduleRoutes } from "../src/modules/hooks";
import { api, bearer } from "./service-center-fixture";
import { pedidoSetup, run, seedMenu, type SeededMenu } from "./pedido-fixture";

async function mesasSetup(options: { config?: any } = {}) {
  const { f } = await pedidoSetup();
  const menu = await seedMenu(f);
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "mesas", enabled: true },
    uid(),
  );
  if (options.config)
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { mesas: options.config },
      uid(),
    );
  const created = await run(f, f.admin, "mesas.table.create", {
    prefix: "Mesa",
    from: 1,
    to: 4,
    section: "Salão",
    seats: 4,
  });
  const card = await run(f, f.admin, "mesas.table.create", {
    name: "Comanda 10",
    kind: "card",
    section: "Bar",
  });
  const tables = [...created.data, ...card.data];
  const waiter = await bearer(f.member);
  const P = `/profiles/${f.profile}`;
  return { f, menu, tables, waiter, P };
}

/** Dois X-Burger com montagens diferentes e dois sucos. */
const items = (menu: SeededMenu) => [
  {
    item_id: menu.xburger.id,
    quantity: 1,
    options: { [menu.ponto.id]: ["mal"], [menu.adicionais.id]: ["bacon"] },
    note: "sem cebola",
  },
  {
    item_id: menu.xburger.id,
    quantity: 1,
    options: { [menu.ponto.id]: ["bem"] },
  },
  { item_id: menu.suco.id, quantity: 2 },
];

const events = async (profile: string, kind: string) =>
  (
    await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
      profile,
      kind,
    )
  ).map((r) => json(r.payload));

describe("mesas: contrato da API", () => {
  it("toda rota do módulo está no OpenAPI, no grupo Mesas, com esquemas que existem", () => {
    const spec = openapi("https://test");
    const toSpec = (path: string) =>
      "/profiles/{profile}/" + path.replace(/:(\w+)/g, "{$1}");
    const routes = [
      ...moduleRoutes()
        .read.filter((r) => r.path.startsWith("mesas"))
        .map((r) => ["get", r.path]),
      ...moduleRoutes()
        .write.filter((r) => r.path.startsWith("mesas"))
        .map((r) => [r.method.toLowerCase(), r.path]),
    ];
    expect(routes.length).toBe(18);
    for (const [method, path] of routes) {
      const entry = spec.paths[toSpec(path)]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.tags).toEqual(["Mesas"]);
    }
    const refs = new Set<string>();
    const walk = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.$ref === "string") refs.add(value.$ref);
      for (const child of Object.values(value)) walk(child);
    };
    for (const [path, methods] of Object.entries<any>(spec.paths))
      if (path.includes("/mesas")) walk(methods);
    for (const name of Object.keys(spec.components.schemas))
      if (name.startsWith("Mesas")) walk(spec.components.schemas[name]);
    for (const r of refs)
      expect(
        spec.components.schemas[r.replace("#/components/schemas/", "")],
        r,
      ).toBeTruthy();
    expect(
      spec.components.schemas.PedidoOrder.properties.fulfillment.enum,
    ).toContain("table");
  });
});

describe("mesas: módulo e cadastro", () => {
  it("vem desligado, depende do Pedido e as rotas respondem 409 module_disabled", async () => {
    const { f } = await pedidoSetup({ enabled: false });
    const token = await bearer(f.admin);
    const res = await api(token, `/profiles/${f.profile}/mesas`);
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe("module_disabled");
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "module.set",
        { id: "mesas", enabled: true },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "module_requires" });
  });

  it("mesas e comandas: várias de uma vez, nome repetido, só administrador cadastra", async () => {
    const { f, tables, waiter, P } = await mesasSetup();
    expect(tables.map((t: any) => t.name)).toEqual([
      "Mesa 1",
      "Mesa 2",
      "Mesa 3",
      "Mesa 4",
      "Comanda 10",
    ]);
    expect(tables[4].kind).toBe("card");
    // Faixa que repete nomes pula os que existem.
    const again = await run(f, f.admin, "mesas.table.create", {
      prefix: "Mesa",
      from: 4,
      to: 5,
    });
    expect(again.data.map((t: any) => t.name)).toEqual(["Mesa 5"]);
    expect(again.skipped).toEqual(["Mesa 4"]);
    await expect(
      run(f, f.admin, "mesas.table.create", { name: "Mesa 1" }),
    ).rejects.toMatchObject({ code: "table_name_taken" });
    const denied = await api(waiter, `${P}/mesas/tables`, "POST", {
      name: "Mesa 99",
    });
    expect(denied.status).toBe(403);
    const map = await (await api(waiter, `${P}/mesas`)).json<any>();
    expect(map.counts).toEqual({ free: 6, occupied: 0, closing: 0 });
    expect(map.sections).toEqual(expect.arrayContaining(["Salão", "Bar"]));
    expect(map.config.service_percent).toBe(10);
  });
});

describe("mesas: conta da mesa", () => {
  it("abre, lança itens com duas montagens e o pedido aparece no quadro da cozinha", async () => {
    const { f, menu, tables, waiter, P } = await mesasSetup();
    const open = await api(waiter, `${P}/mesas/tabs`, "POST", {
      table_id: tables[0].id,
      guests: 3,
    });
    expect(open.status).toBe(200);
    const tab = await open.json<any>();
    expect(tab).toMatchObject({
      status: "open",
      table: { id: tables[0].id, name: "Mesa 1" },
      guests: 3,
      waiter_id: f.member.id,
    });
    // A mesma mesa não abre duas contas.
    const twice = await api(waiter, `${P}/mesas/tabs`, "POST", {
      table_id: tables[0].id,
    });
    expect(twice.status).toBe(409);
    expect((await twice.json<any>()).error.code).toBe("table_occupied");

    const key = uid();
    const sent = await api(
      waiter,
      `${P}/mesas/tabs/${tab.id}/orders`,
      "POST",
      { items: items(menu), note: "mesa da janela" },
      key,
    );
    expect(sent.status).toBe(200);
    const { order, tab: after } = await sent.json<any>();
    // 2500+500 + 2500 + 2x800
    expect(order).toMatchObject({
      status: "received",
      fulfillment: "table",
      fulfillment_label: "Mesa 1",
      table: { tab_id: tab.id, label: "Mesa 1" },
      source: "table",
      total_cents: 7100,
      payment: { status: "tab", status_label: "Na conta da mesa" },
      note: "mesa da janela",
    });
    expect(order.lines.map((l: any) => [l.name, l.slot])).toEqual([
      ["X-Burger", 0],
      ["X-Burger", 1],
      ["Suco de laranja", 0],
    ]);
    expect(order.lines[0].note).toBe("sem cebola");
    expect(after.bill).toMatchObject({
      subtotal_cents: 7100,
      service_cents: 710,
      total_cents: 7810,
      due_cents: 7810,
    });
    expect(after.kitchen_count).toBe(1);

    // Mesma Idempotency-Key: o mesmo pedido, sem outro na cozinha.
    const repeat = await api(
      waiter,
      `${P}/mesas/tabs/${tab.id}/orders`,
      "POST",
      { items: items(menu), note: "mesa da janela" },
      key,
    );
    expect((await repeat.json<any>()).order.id).toBe(order.id);
    const board = await (await api(waiter, `${P}/pedido/board`)).json<any>();
    const received = board.columns.find((c: any) => c.status === "received");
    expect(received.orders.map((o: any) => o.id)).toEqual([order.id]);
    expect(received.orders[0].customer.name).toBe("Mesa 1");

    // Comanda da cozinha com o nome da mesa.
    const ticket = await (
      await api(waiter, `${P}/pedido/orders/${order.id}/ticket?columns=48`)
    ).json<any>();
    expect(ticket.text).toContain("MESA 1 · Recebido");
    expect(ticket.text).toContain("Na conta da mesa");

    // Item esgotado é recusado; o mapa mostra a mesa ocupada.
    const soldOut = await api(
      waiter,
      `${P}/mesas/tabs/${tab.id}/orders`,
      "POST",
      { items: [{ item_id: menu.misto.id, quantity: 1 }] },
    );
    expect(soldOut.status).toBe(400);
    const map = await (await api(waiter, `${P}/mesas`)).json<any>();
    const mesa1 = map.tables.find((t: any) => t.id === tables[0].id);
    expect(mesa1).toMatchObject({
      state: "occupied",
      tab: { id: tab.id, item_count: 4, bill: { total_cents: 7810 } },
    });
    expect(map.counts.occupied).toBe(1);
    expect(await events(f.profile, "mesas.order_sent")).toHaveLength(1);
    expect(
      (await events(f.profile, "pedido.created")).map((e) => e.tab_id),
    ).toEqual([tab.id]);
  });

  it("cozinha: caminho da mesa, pagamento só pela conta e pedido cancelado fora da conta", async () => {
    const { f, menu, tables, waiter, P } = await mesasSetup();
    const tab = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[1].id,
    });
    const first = await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [{ item_id: menu.suco.id, quantity: 1 }],
    });
    const second = await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [
        {
          item_id: menu.xburger.id,
          quantity: 1,
          options: { [menu.ponto.id]: ["bem"] },
        },
      ],
    });
    expect(first.order.next_statuses).toEqual([
      "preparing",
      "ready",
      "cancelled",
    ]);
    const ready = await run(f, f.member, "pedido.status", {
      id: first.order.id,
      status: "ready",
    });
    expect(ready.status_label).toBe("Pronto para servir");
    const served = await run(f, f.member, "pedido.status", {
      id: first.order.id,
      status: "delivered",
    });
    expect(served.status_label).toBe("Servido");
    await expect(
      run(f, f.member, "pedido.payment.paid", { id: first.order.id }),
    ).rejects.toMatchObject({ code: "tab_order" });
    await expect(
      run(f, f.member, "pedido.payment.method", {
        id: first.order.id,
        method: "cash",
      }),
    ).rejects.toMatchObject({ code: "tab_order" });
    await run(f, f.member, "pedido.status", {
      id: second.order.id,
      status: "cancelled",
      reason: "Cliente desistiu",
    });
    const detail = await (
      await api(waiter, `${P}/mesas/tabs/${tab.id}`)
    ).json<any>();
    expect(detail.orders).toHaveLength(2);
    expect(detail.bill).toMatchObject({
      subtotal_cents: 800,
      service_cents: 80,
      total_cents: 880,
    });
    expect(detail).toMatchObject({ orders_count: 1, kitchen_count: 0 });
    expect(detail.history.map((h: any) => h.kind)).toEqual([
      "opened",
      "order",
      "order",
    ]);
  });

  it("conta parcial, dividida, pagamentos e fechamento", async () => {
    const { f, menu, tables, waiter, P } = await mesasSetup();
    const tab = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[0].id,
      guests: 3,
    });
    await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: items(menu),
    });
    // Conta parcial dividida por 3: 7810 = 2604 + 2603 + 2603.
    const partial = await (
      await api(waiter, `${P}/mesas/tabs/${tab.id}/bill?split=3&columns=32`)
    ).json<any>();
    expect(partial.split).toEqual({
      people: 3,
      of: "total",
      shares: [2604, 2603, 2603],
    });
    expect(partial.lines.map((l: any) => [l.quantity, l.name])).toEqual([
      [1, "X-Burger"],
      [1, "X-Burger"],
      [2, "Suco de laranja"],
    ]);
    const flat = partial.text.replace(/\n\s*/g, " ");
    expect(flat).toContain("CONTA Nº");
    expect(flat).toContain("Serviço (10%)");
    expect(flat).toContain("R$ 78,10");
    expect(flat).toContain("Dividido por 3:");
    expect(flat).toContain("Não é documento fiscal");

    // Pedir a conta: mesa "fechando".
    const closing = await run(f, f.member, "mesas.tab.bill", { id: tab.id });
    expect(closing.status).toBe("closing");
    const map = await (await api(waiter, `${P}/mesas`)).json<any>();
    expect(map.counts).toMatchObject({ closing: 1, occupied: 0 });

    // Uma pessoa paga a parte dela em dinheiro, com troco.
    const paid = await run(f, f.member, "mesas.payment.add", {
      id: tab.id,
      method: "cash",
      amount_cents: 2604,
      tendered_cents: 5000,
    });
    expect(paid.payment).toMatchObject({
      method: "cash",
      amount_cents: 2604,
      change_cents: 2396,
    });
    expect(paid.tab.bill).toMatchObject({ paid_cents: 2604, due_cents: 5206 });
    await expect(
      run(f, f.member, "mesas.payment.add", {
        id: tab.id,
        method: "card",
        amount_cents: 6000,
      }),
    ).rejects.toMatchObject({ code: "amount_exceeds_due" });
    // Dividir o que falta entre os outros dois.
    const rest = await (
      await api(waiter, `${P}/mesas/tabs/${tab.id}/bill?split=2`)
    ).json<any>();
    expect(rest.split).toEqual({
      people: 2,
      of: "due",
      shares: [2603, 2603],
    });
    // Fechar sem o resto: recusa e não grava nada.
    await expect(
      run(f, f.member, "mesas.tab.close", {
        id: tab.id,
        payments: [{ method: "card", amount_cents: 2603 }],
      }),
    ).rejects.toMatchObject({ code: "tab_unpaid" });
    expect(
      (await all(env, "SELECT id FROM mesas_payments WHERE tab_id=?", tab.id))
        .length,
    ).toBe(1);
    const closed = await run(f, f.member, "mesas.tab.close", {
      id: tab.id,
      payments: [
        { method: "card", amount_cents: 2603 },
        { method: "pix", amount_cents: 2603 },
      ],
    });
    expect(closed).toMatchObject({
      status: "closed",
      bill: { total_cents: 7810, paid_cents: 7810, due_cents: 0 },
    });
    expect(closed.payments.map((p: any) => p.method)).toEqual([
      "cash",
      "card",
      "pix",
    ]);
    // Mesa livre, pedidos da cozinha pagos, evento com o total por forma.
    const after = await (await api(waiter, `${P}/mesas`)).json<any>();
    expect(after.counts.free).toBe(5);
    const orders = await all(
      env,
      "SELECT payment_status,paid_by FROM pedido_orders WHERE tab_id=?",
      tab.id,
    );
    expect(orders).toEqual([{ payment_status: "paid", paid_by: f.member.id }]);
    const [event] = await events(f.profile, "mesas.tab_closed");
    expect(event).toMatchObject({
      total_cents: 7810,
      service_cents: 710,
      payments: { cash: 2604, card: 2603, pix: 2603 },
    });
    // Fechada: nada mais entra.
    await expect(
      run(f, f.member, "mesas.order.send", {
        id: tab.id,
        items: [{ item_id: menu.suco.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "tab_closed" });
    const receipt = await (
      await api(waiter, `${P}/mesas/tabs/${tab.id}/bill?columns=42`)
    ).json<any>();
    expect(receipt.text).toContain("*** CONTA PAGA ***");
    const history = await (
      await api(waiter, `${P}/mesas/tabs?status=closed`)
    ).json<any>();
    expect(history.data.map((t: any) => t.id)).toEqual([tab.id]);
  });

  it("pedido depois de pedir a conta reabre; taxa de serviço retirada; pagamento desfeito", async () => {
    const { f, menu, tables } = await mesasSetup();
    const tab = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[2].id,
    });
    await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [{ item_id: menu.suco.id, quantity: 2 }],
    });
    await run(f, f.member, "mesas.tab.bill", { id: tab.id });
    const more = await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [{ item_id: menu.suco.id, quantity: 1 }],
    });
    expect(more.tab).toMatchObject({ status: "open", bill_requested_at: null });
    const noService = await run(f, f.member, "mesas.tab.update", {
      id: tab.id,
      service: false,
    });
    expect(noService.bill).toMatchObject({
      service_on: false,
      service_cents: 0,
      total_cents: 2400,
    });
    const p = await run(f, f.member, "mesas.payment.add", {
      id: tab.id,
      method: "card",
      amount_cents: 1000,
    });
    const voided = await run(f, f.member, "mesas.payment.void", {
      id: p.payment.id,
      reason: "Valor errado",
    });
    expect(voided.payment.status).toBe("void");
    expect(voided.tab.bill).toMatchObject({ paid_cents: 0, due_cents: 2400 });
    await expect(
      run(f, f.member, "mesas.tab.update", { id: tab.id, waiter_id: "x" }),
    ).rejects.toMatchObject({ status: 400 });
    const taken = await run(f, f.admin, "mesas.tab.update", {
      id: tab.id,
      waiter_id: "me",
    });
    expect(taken.waiter_id).toBe(f.admin.id);
  });

  it("transfere para mesa livre e junta mesas", async () => {
    const { f, menu, tables, waiter, P } = await mesasSetup();
    const a = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[0].id,
      guests: 2,
    });
    const b = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[1].id,
      guests: 3,
    });
    const sentA = await run(f, f.member, "mesas.order.send", {
      id: a.id,
      items: [{ item_id: menu.suco.id, quantity: 1 }],
    });
    await run(f, f.member, "mesas.order.send", {
      id: b.id,
      items: [{ item_id: menu.suco.id, quantity: 2 }],
    });
    await run(f, f.member, "mesas.payment.add", {
      id: b.id,
      method: "pix",
      amount_cents: 500,
    });
    // Mesa ocupada não recebe transferência.
    await expect(
      run(f, f.member, "mesas.tab.transfer", {
        id: a.id,
        table_id: tables[1].id,
      }),
    ).rejects.toMatchObject({ code: "table_occupied" });
    const moved = await run(f, f.member, "mesas.tab.transfer", {
      id: a.id,
      table_id: tables[3].id,
    });
    expect(moved.table).toEqual({ id: tables[3].id, name: "Mesa 4" });
    const order = await (
      await api(waiter, `${P}/pedido/orders/${sentA.order.id}`)
    ).json<any>();
    expect(order.fulfillment_label).toBe("Mesa 4");
    expect(order.customer.name).toBe("Mesa 4");

    // Junta a Mesa 2 na Mesa 4.
    const merged = await run(f, f.member, "mesas.tab.merge", {
      id: a.id,
      table_id: tables[1].id,
    });
    expect(merged).toMatchObject({
      guests: 5,
      orders_count: 2,
      bill: { subtotal_cents: 2400, paid_cents: 500 },
    });
    const source = await (
      await api(waiter, `${P}/mesas/tabs/${b.id}`)
    ).json<any>();
    expect(source).toMatchObject({ status: "merged", merged_into: a.id });
    expect(source.orders).toEqual([]);
    const map = await (await api(waiter, `${P}/mesas`)).json<any>();
    expect(
      map.tables.filter((t: any) => t.state !== "free").map((t: any) => t.name),
    ).toEqual(["Mesa 4"]);
    const kitchen = await all(
      env,
      "SELECT table_label FROM pedido_orders WHERE tab_id=? ORDER BY number",
      a.id,
    );
    expect(kitchen.map((r) => r.table_label)).toEqual(["Mesa 4", "Mesa 4"]);
    expect(await events(f.profile, "mesas.tab_merged")).toHaveLength(1);
  });

  it("cancela só conta vazia; apagar mesa ocupada é recusado", async () => {
    const { f, menu, tables } = await mesasSetup();
    const empty = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[0].id,
    });
    const cancelled = await run(f, f.member, "mesas.tab.cancel", {
      id: empty.id,
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancel_reason: "Conta aberta por engano.",
    });
    const tab = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[0].id,
    });
    await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [{ item_id: menu.suco.id, quantity: 1 }],
    });
    await expect(
      run(f, f.member, "mesas.tab.cancel", { id: tab.id }),
    ).rejects.toMatchObject({ code: "tab_not_empty" });
    await expect(
      run(f, f.admin, "mesas.table.delete", { id: tables[0].id }),
    ).rejects.toMatchObject({ code: "table_in_use" });
    expect(
      await run(f, f.admin, "mesas.table.delete", { id: tables[2].id }),
    ).toEqual({ deleted: true, id: tables[2].id });
  });

  it("configuração: taxa de serviço e divisão validadas; conta nova sem taxa", async () => {
    const { f, menu, tables } = await mesasSetup({
      config: { service_percent: 12.5, service_default: false },
    });
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "settings",
        { mesas: { service_percent: 30 } },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "settings",
        { mesas: { gorjeta: true } },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const tab = await run(f, f.member, "mesas.tab.open", {
      table_id: tables[0].id,
    });
    expect(tab.bill).toMatchObject({
      service_on: false,
      service_percent: 12.5,
    });
    await run(f, f.member, "mesas.order.send", {
      id: tab.id,
      items: [{ item_id: menu.suco.id, quantity: 1 }],
    });
    const withService = await run(f, f.member, "mesas.tab.update", {
      id: tab.id,
      service: true,
    });
    // 12,5% de 800 = 100.
    expect(withService.bill).toMatchObject({
      service_cents: 100,
      total_cents: 900,
    });
    const row = await one(
      env,
      "SELECT service_permille FROM mesas_tabs WHERE id=?",
      tab.id,
    );
    expect(row?.service_permille).toBe(125);
  });
});
