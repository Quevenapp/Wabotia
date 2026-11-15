import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { runModuleSchedules } from "../src/modules/schedule";
import { runDue } from "../src/modules/pedido/schedule";
import {
  api,
  application,
  bearer,
  latest,
  outbox,
  type Fixture,
} from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  pedidoSetup,
  run,
  say,
  seedMenu,
  submitCart,
} from "./pedido-fixture";

const STORE = {
  store_name: "Lanchonete da Ana",
  delivery: true,
  delivery_fee_cents: 700,
  pickup_address: "Rua das Flores, 100",
};

async function setup(config: any = {}) {
  const { f, ctx } = await pedidoSetup({
    menus: MENUS,
    config: { ...STORE, ...config },
  });
  const menu = await seedMenu(f);
  return { f, ctx, menu };
}

/** Pedido pelo carrinho: um suco, retirada ou entrega. */
async function cartOrder(
  f: Fixture,
  menu: Awaited<ReturnType<typeof seedMenu>>,
  phone: string,
  fulfillment: "pickup" | "delivery" = "pickup",
) {
  await say(f, "oi", phone);
  const c = await say(f, "1", phone);
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
  await submitCart(codeIn(link.text), {
    [`q_${menu.suco.id}`]: "2",
    fulfillment,
    name: "Caio",
    street: "Rua C, 30",
    district: "Vila Nova",
    confirm: "1",
  });
  const order = await one(
    env,
    "SELECT * FROM pedido_orders WHERE conversation_id=? ORDER BY number DESC LIMIT 1",
    c.id,
  );
  return { c, order };
}

const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));

describe("pedido: estados e avisos", () => {
  it("recebido → em preparo → pronto → entregue, com aviso e Idempotency-Key", async () => {
    const { f, menu } = await setup({ payments: { cash: false, card: true } });
    const { c, order } = await cartOrder(f, menu, "5511971000001");
    expect(order.status).toBe("received");
    const member = await bearer(f.member);
    const path = `/profiles/${f.profile}/pedido/orders/${order.id}/status`;
    const key = uid();
    const first = await api(member, path, "POST", { status: "preparing" }, key);
    expect(first.status).toBe(200);
    const body = await first.json<any>();
    expect(body).toMatchObject({
      status: "preparing",
      status_label: "Em preparo",
      next_statuses: ["ready", "received", "cancelled"],
    });
    expect((await latest(c.id)).text).toBe("Pedido nº 1 em preparo.");
    // Mesma chave: mesma resposta, nada repetido.
    const again = await api(member, path, "POST", { status: "preparing" }, key);
    expect(await again.json<any>()).toEqual(body);
    expect(
      (await events(f, "pedido.status_changed")).filter(
        (e) => e.to === "preparing",
      ),
    ).toHaveLength(1);
    expect(
      (await outbox(c.id)).filter((m) => m.text === "Pedido nº 1 em preparo."),
    ).toHaveLength(1);
    // Retirada não passa por "Saiu para entrega".
    const wrong = await api(member, path, "POST", {
      status: "out_for_delivery",
    });
    expect(wrong.status).toBe(409);
    expect((await wrong.json<any>()).error.code).toBe("invalid_transition");
    await api(member, path, "POST", { status: "ready" });
    expect((await latest(c.id)).text).toBe(
      "Pedido nº 1 pronto para retirada! Retire em Rua das Flores, 100.",
    );
    const delivered = await (
      await api(member, path, "POST", { status: "delivered" })
    ).json<any>();
    expect(delivered).toMatchObject({ status: "delivered", next_statuses: [] });
    expect(delivered.delivered_at).toBeGreaterThan(0);
    expect((await latest(c.id)).text).toBe(
      "Pedido nº 1 entregue. Obrigado pela preferência!",
    );
    const detail = await (
      await api(member, `/profiles/${f.profile}/pedido/orders/${order.id}`)
    ).json<any>();
    expect(
      detail.history
        .filter((h: any) => h.kind === "status")
        .map((h: any) => [h.from_status, h.to_status]),
    ).toEqual([
      ["awaiting_payment", "received"],
      ["received", "preparing"],
      ["preparing", "ready"],
      ["ready", "delivered"],
    ]);
    expect(detail.history.at(-1).actor).toBe(f.member.id);
  });

  it("entrega sai para entrega; cancelamento com motivo; texto vazio e notify false não avisam", async () => {
    const { f, menu } = await setup({
      payments: { cash: false, card: true },
      texts: { preparing: "" },
    });
    const { c, order } = await cartOrder(f, menu, "5511971000002", "delivery");
    await run(f, f.member, "pedido.status", {
      id: order.id,
      status: "preparing",
    });
    expect((await latest(c.id)).text).not.toContain("em preparo");
    await expect(
      run(f, f.member, "pedido.status", { id: order.id, status: "ready" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await run(f, f.member, "pedido.status", {
      id: order.id,
      status: "out_for_delivery",
    });
    expect((await latest(c.id)).text).toBe("Pedido nº 1 saiu para entrega.");
    const before = (await outbox(c.id)).length;
    await run(f, f.member, "pedido.status", {
      id: order.id,
      status: "preparing",
      notify: false,
      note: "Voltou: faltou o refrigerante",
    });
    expect((await outbox(c.id)).length).toBe(before);
    const second = await cartOrder(f, menu, "5511971000003");
    const cancelled = await run(f, f.member, "pedido.status", {
      id: second.order.id,
      status: "cancelled",
      reason: "Cliente desistiu pelo telefone.",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancel_reason: "Cliente desistiu pelo telefone.",
      cancelled_by: f.member.id,
      payment: expect.objectContaining({ status: "cancelled" }),
    });
    expect((await latest(second.c.id)).text).toBe(
      "Pedido nº 2 cancelado. Cliente desistiu pelo telefone.",
    );
    await expect(
      run(f, f.member, "pedido.status", {
        id: second.order.id,
        status: "received",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("fora da janela de 24 horas o aviso sai como notificação (modelo)", async () => {
    const { f, menu } = await setup({ payments: { cash: false, card: true } });
    const { c, order } = await cartOrder(f, menu, "5511971000004");
    await exec(
      env,
      "UPDATE conversations SET last_customer=? WHERE id=?",
      now() - 2 * 86_400_000,
      c.id,
    );
    await run(f, f.member, "pedido.status", {
      id: order.id,
      status: "preparing",
    });
    const row = await one(
      env,
      "SELECT kind,payload FROM outbox WHERE conversation_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
      c.id,
    );
    expect(row.kind).toBe("notification");
    expect(json(row.payload).text).toBe("Pedido nº 1 em preparo.");
  });
});

describe("pedido: quadro da cozinha e tarefa periódica", () => {
  it("quadro por estado com minutos parados e atraso", async () => {
    const { f, menu } = await setup({
      payments: { cash: true, card: true },
      alerts: { received: 10 },
    });
    const a = await cartOrder(f, menu, "5511971000010");
    // a: esperando a forma de pagamento; b: recebido há 15 minutos.
    const b = await cartOrder(f, menu, "5511971000011");
    await run(f, f.member, "pedido.payment.method", {
      id: b.order.id,
      method: "card",
    });
    await exec(
      env,
      "UPDATE pedido_orders SET status_at=? WHERE id=?",
      now() - 15 * 60_000,
      b.order.id,
    );
    const view = await (
      await api(await bearer(f.member), `/profiles/${f.profile}/pedido/board`)
    ).json<any>();
    expect(view.columns.map((col: any) => col.status)).toEqual([
      "awaiting_payment",
      "received",
      "preparing",
      "ready",
      "out_for_delivery",
    ]);
    expect(view.columns[0].orders.map((o: any) => o.id)).toEqual([a.order.id]);
    const card = view.columns[1].orders[0];
    expect(card).toMatchObject({
      id: b.order.id,
      number: 2,
      late: true,
      payment: expect.objectContaining({ method: "card", status: "pending" }),
    });
    expect(card.minutes_in_status).toBeGreaterThanOrEqual(15);
    expect(card.lines[0]).toMatchObject({
      name: "Suco de laranja",
      quantity: 2,
    });
    expect(view.today).toMatchObject({ orders: 2, total_cents: 3200 });
    expect(view.store).toMatchObject({ open: true, paused: false });
  });

  it("cancela quem não escolheu como pagar no prazo e avisa pedidos parados uma vez", async () => {
    const { f, ctx, menu } = await setup({
      payments: { cash: true, card: true },
      payment_minutes: 30,
      alerts: { received: 10, preparing: 0 },
    });
    const choosing = await cartOrder(f, menu, "5511971000020");
    const working = await cartOrder(f, menu, "5511971000021");
    await run(f, f.member, "pedido.payment.method", {
      id: working.order.id,
      method: "cash",
    });
    const at = now();
    // Antes do prazo: nada.
    expect(await runDue(ctx, at + 5 * 60_000)).toEqual({
      expired: 0,
      stale: 0,
    });
    // 31 minutos depois, pelo gancho periódico do núcleo.
    const outcomes = await runModuleSchedules(env, f.profile, at + 31 * 60_000);
    expect(outcomes).toContainEqual({ module: "pedido", ok: true });
    const cancelled = await one(
      env,
      "SELECT * FROM pedido_orders WHERE id=?",
      choosing.order.id,
    );
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancel_reason: "Pagamento não definido no prazo.",
      payment_status: "cancelled",
    });
    expect((await latest(choosing.c.id)).text).toBe(
      "Pedido nº 1 cancelado. Pagamento não definido no prazo.",
    );
    // A pergunta acabou: "1" volta a ser o menu.
    expect(
      await one(
        env,
        "SELECT * FROM pedido_chats WHERE conversation_id=?",
        choosing.c.id,
      ),
    ).toBeNull();
    const stale = await events(f, "pedido.stale");
    expect(stale).toEqual([
      expect.objectContaining({
        order_id: working.order.id,
        status: "received",
        limit_minutes: 10,
      }),
    ]);
    // Rodada repetida não repete; nova mudança de estado zera o alerta.
    await runDue(ctx, at + 40 * 60_000);
    expect(await events(f, "pedido.stale")).toHaveLength(1);
    await run(f, f.member, "pedido.status", {
      id: working.order.id,
      status: "preparing",
    });
    await runDue(ctx, now() + 300 * 60_000);
    expect(await events(f, "pedido.stale")).toHaveLength(1); // preparing: 0 = sem alerta
  });
});

describe("pedido: equipe e integrações", () => {
  it("pedido de balcão pela API, com duas montagens do mesmo item e a mesma Idempotency-Key", async () => {
    const { f, menu } = await setup();
    const admin = await bearer(f.admin);
    const body = {
      customer_name: "Davi no balcão",
      phone: "(11) 98888-7777",
      fulfillment: "pickup",
      payment_method: "cash",
      items: [
        {
          item_id: menu.xburger.id,
          quantity: 1,
          options: { [menu.ponto.id]: ["mal"] },
          note: "sem cebola",
        },
        {
          item_id: menu.xburger.id,
          quantity: 1,
          options: { [menu.ponto.id]: ["bem"], [menu.adicionais.id]: ["ovo"] },
        },
      ],
      notes: "Mesa 4",
    };
    const key = uid();
    const first = await api(
      admin,
      `/profiles/${f.profile}/pedido/orders`,
      "POST",
      body,
      key,
    );
    expect(first.status).toBe(200);
    const created = await first.json<any>();
    expect(created).toMatchObject({
      number: 1,
      source: "panel",
      status: "received",
      subtotal_cents: 2500 + 2800,
      total_cents: 5300,
      notes: "Mesa 4",
      customer: expect.objectContaining({
        name: "Davi no balcão",
        phone: "5511988887777",
      }),
      payment: expect.objectContaining({ method: "cash", status: "pending" }),
    });
    expect(
      created.lines.map((l: any) => [l.slot, l.total_cents, l.note]),
    ).toEqual([
      [0, 2500, "sem cebola"],
      [1, 2800, ""],
    ]);
    const again = await api(
      admin,
      `/profiles/${f.profile}/pedido/orders`,
      "POST",
      body,
      key,
    );
    expect(await again.json<any>()).toEqual(created);
    expect(
      await all(
        env,
        "SELECT id FROM pedido_orders WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(1);
    // Ponto obrigatório faltando: recusa com a mesma regra da página.
    const missing = await api(
      admin,
      `/profiles/${f.profile}/pedido/orders`,
      "POST",
      {
        ...body,
        items: [{ item_id: menu.xburger.id, quantity: 1 }],
      },
    );
    expect(missing.status).toBe(400);
    expect((await missing.json<any>()).error.message).toContain(
      "Escolha 1 em Ponto da carne",
    );
    // Esgotado: recusa.
    const sold = await api(
      admin,
      `/profiles/${f.profile}/pedido/orders`,
      "POST",
      {
        ...body,
        items: [{ item_id: menu.misto.id, quantity: 1 }],
      },
    );
    expect(sold.status).toBe(400);
    // Grupo de adicionais que não é do item: recusa, em vez de ignorar.
    const foreign = await api(
      admin,
      `/profiles/${f.profile}/pedido/orders`,
      "POST",
      {
        ...body,
        items: [
          {
            item_id: menu.suco.id,
            quantity: 1,
            options: { [menu.adicionais.id]: ["bacon"] },
          },
        ],
      },
    );
    expect(foreign.status).toBe(400);
    expect((await foreign.json<any>()).error.message).toContain(
      "não é de Suco de laranja",
    );

    // Lista, busca pelo número, baixa do pagamento e dados internos.
    const list = await (
      await api(admin, `/profiles/${f.profile}/pedido/orders?open=1&q=1`)
    ).json<any>();
    expect(list.data.map((o: any) => o.number)).toEqual([1]);
    expect(list.counts).toEqual({ received: 1 });
    const paid = await (
      await api(
        await bearer(f.member),
        `/profiles/${f.profile}/pedido/orders/${created.id}/paid`,
        "POST",
        { note: "Dinheiro no caixa" },
      )
    ).json<any>();
    expect(paid.payment).toMatchObject({
      status: "paid",
      paid_by: f.member.id,
    });
    await expect(
      run(f, f.member, "pedido.payment.paid", { id: created.id }),
    ).rejects.toMatchObject({ code: "already_paid" });
    const patched = await run(f, f.member, "pedido.order.update", {
      id: created.id,
      eta_minutes: 35,
      notes: "Mesa 4, sem pressa",
    });
    expect(patched).toMatchObject({
      eta_minutes: 35,
      notes: "Mesa 4, sem pressa",
    });
  });

  it("permissões: aplicação sem conversations:write não muda pedido; módulo desligado responde 409", async () => {
    const { f, menu } = await setup({ payments: { cash: false, card: true } });
    const { order } = await cartOrder(f, menu, "5511971000030");
    const reader = await application(f, ["conversations:read"]);
    const listed = await api(
      reader.token,
      `/profiles/${f.profile}/pedido/orders`,
    );
    expect(listed.status).toBe(200);
    const denied = await api(
      reader.token,
      `/profiles/${f.profile}/pedido/orders/${order.id}/status`,
      "POST",
      { status: "preparing" },
    );
    expect(denied.status).toBe(403);
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "pedido", enabled: false },
      uid(),
    );
    for (const [method, path] of [
      ["GET", "/pedido/board"],
      ["GET", `/pedido/orders/${order.id}`],
      ["POST", `/pedido/orders/${order.id}/status`],
    ] as const) {
      const res = await api(
        await bearer(f.admin),
        `/profiles/${f.profile}${path}`,
        method,
        method === "POST" ? { status: "preparing" } : undefined,
      );
      expect(res.status, path).toBe(409);
      expect((await res.json<any>()).error.code).toBe("module_disabled");
    }
  });

  it("a equipe define a forma de pagamento de quem não respondeu", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: true } });
    const { c, order } = await cartOrder(f, menu, "5511971000040");
    expect(order).toMatchObject({
      status: "awaiting_payment",
      payment_status: "choosing",
    });
    const set = await run(f, f.member, "pedido.payment.method", {
      id: order.id,
      method: "card",
    });
    expect(set).toMatchObject({
      status: "received",
      payment: expect.objectContaining({ method: "card", status: "pending" }),
    });
    expect((await latest(c.id)).text).toContain("Pedido nº 1 recebido!");
    // A pergunta antiga não vale mais: "1" é o menu de novo.
    await say(f, "1", "5511971000040");
    expect(
      await one(
        env,
        "SELECT payment_method FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({ payment_method: "card" });
  });
});
