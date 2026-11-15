import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { expirePayments } from "../src/payments";
import { createOrder } from "../src/modules/pedido/orders";
import {
  api,
  bearer,
  drain,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";
import {
  MENUS,
  codeIn,
  media,
  paymentAccount,
  pedidoSetup,
  run,
  say,
  seedMenu,
  stubMercadoPago,
  submitCart,
  webhook,
  type SeededMenu,
} from "./pedido-fixture";

afterEach(() => vi.unstubAllGlobals());

const STORE = {
  store_name: "Lanchonete da Ana",
  delivery: true,
  delivery_fee_cents: 700,
  minimum_cents: 2000,
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

/** Cliente toca em Cardápio e recebe o link; devolve o código do link. */
async function openCart(f: Fixture, phone: string, line = f.line) {
  await say(f, "oi", phone, line);
  const c = await say(f, "1", phone, line);
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)));
  return { c, code: link ? codeIn(link.text) : "", link };
}

/** Duas montagens do X-Burger, um suco e entrega. Total: R$ 100,00. */
const cartFields = (m: SeededMenu, extra: Record<string, any> = {}) => {
  const x = m.xburger.id;
  return {
    [`q_${x}`]: "1",
    [`o_${x}_${m.ponto.id}`]: "mal",
    [`n_${x}`]: "sem cebola",
    [`slots_${x}`]: "2",
    [`q_${x}.1`]: "2",
    [`o_${x}.1_${m.ponto.id}`]: "bem",
    [`o_${x}.1_${m.adicionais.id}`]: ["bacon"],
    [`q_${m.suco.id}`]: "1",
    fulfillment: "delivery",
    street: "Rua A, 10",
    district: "Centro",
    complement: "Apto 2",
    name: "Ana",
    note: "Interfone 12",
    ...extra,
  };
};

const orders = (f: Fixture) =>
  all(
    env,
    "SELECT * FROM pedido_orders WHERE profile_id=? ORDER BY number",
    f.profile,
  );
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));
const texts = async (id: string) =>
  (await outbox(id)).map((m) => String(m.text));

describe("pedido no WhatsApp: cardápio e carrinho", () => {
  it("Cardápio envia as imagens e o botão Fazer pedido; desligado, some do menu", async () => {
    const { f } = await setup({ payments: { cash: true, card: false } });
    const foto = await media(f);
    const pdf = await media(f, "application/pdf", "cardapio.pdf");
    await run(f, f.admin, "pedido.images.save", {
      images: [
        { media_id: foto, caption: "Lanches da casa" },
        { media_id: pdf, caption: "" },
      ],
    });
    const { c, code, link } = await openCart(f, "5511970000001");
    const sent = await outbox(c.id);
    const images = sent.filter((m) => m.media_id);
    expect(images.map((m) => [m.media_id, m.content.type, m.text])).toEqual([
      [foto, "image", "Lanches da casa"],
      [pdf, "document", "Cardápio"],
    ]);
    // Imagens antes do botão.
    expect(sent.indexOf(images[1])).toBeLessThan(
      sent.findIndex((m) => codeIn(String(m.text))),
    );
    expect(link!.content.interactive).toMatchObject({
      type: "cta_url",
      action: { parameters: { display_text: "Fazer pedido" } },
    });
    expect(link!.text).toContain("Monte o seu pedido pelo link");
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(page).toContain("Lanchonete da Ana");
    expect(page).toContain("X-Burger");
    expect(page).toContain("Ponto da carne");
    expect(page).toContain("Pedido mínimo: R$");
    expect(page).toContain("Rua das Flores, 100");
    expect(page).toContain("Misto quente"); // esgotado aparece, sem quantidade
    const step = await one(
      env,
      "SELECT * FROM web_steps WHERE conversation_id=?",
      c.id,
    );
    expect(step).toMatchObject({ module_id: "pedido", kind: "cart" });

    // Módulo desligado: o item some do menu e a ação recusa.
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "pedido", enabled: false },
      uid(),
    );
    const other = await say(f, "oi", "5511970000002");
    const menu = (await latest(other.id)).text;
    expect(menu).toContain("Falar com atendente");
    expect(menu).not.toContain("Cardápio");
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "conversation.action",
        { id: other.id, action: "pedido_link" },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "module_disabled" });
  });

  it("loja fechada responde com o horário, pela pausa ou fora do horário", async () => {
    const today = new Date(Date.now() - 3 * 3600000).getUTCDay();
    const { f } = await setup({
      hours: [{ weekday: (today + 3) % 7, start: "10:00", end: "11:00" }],
    });
    const { c, code } = await openCart(f, "5511970000003");
    expect(code).toBe("");
    const closed = (await latest(c.id)).text;
    expect(closed).toContain("Estamos fechados agora.");
    expect(closed).toMatch(
      /Abrimos (domingo|segunda|terça|quarta|quinta|sexta|sábado) às 10:00\./,
    );
    expect(closed).toContain("Horário de funcionamento:");
    expect(
      await all(env, "SELECT id FROM web_steps WHERE conversation_id=?", c.id),
    ).toHaveLength(0);

    // Sem horário, mas pausada pela equipe.
    await perform(
      env,
      f.admin,
      f.profile,
      "settings",
      { pedido: STORE },
      uid(),
    );
    await run(f, f.member, "pedido.store.pause", {
      paused: true,
      message: "Voltamos às 19h.",
    });
    await say(f, "oi", "5511970000004");
    const paused = await say(f, "1", "5511970000004");
    expect((await latest(paused.id)).text).toBe(
      "No momento não estamos recebendo pedidos. Tente de novo mais tarde.\n\nVoltamos às 19h.",
    );
  });

  it("carrinho concluído vira pedido numerado, com valores do servidor e duas montagens do mesmo item", async () => {
    const { f, menu } = await setup({ payments: { cash: false, card: true } });
    const { c, code } = await openCart(f, "5511970000005");
    // Revisão: total do servidor, valores forjados ignorados.
    const review = await submitCart(
      code,
      cartFields(menu, { total_cents: "1", unit_cents: "1" }),
    );
    expect(review.status).toBe(200);
    expect(await review.text()).toMatch(/Total<\/td><td>R\$\s100,00/);
    const done = await submitCart(code, { ...cartFields(menu), confirm: "1" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("O número e o pagamento chegam");
    const [order] = await orders(f);
    expect(order).toMatchObject({
      number: 1,
      source: "cart",
      conversation_id: c.id,
      phone: "5511970000005",
      customer_name: "Ana",
      item_count: 4,
      subtotal_cents: 9300,
      delivery_fee_cents: 700,
      total_cents: 10000,
      fulfillment: "delivery",
      note: "Interfone 12",
      // Uma forma só (maquininha): direto para o preparo.
      status: "received",
      payment_method: "card",
      payment_status: "pending",
      eta_minutes: 45,
    });
    expect(json(order.address)).toEqual({
      street: "Rua A, 10",
      district: "Centro",
      complement: "Apto 2",
      reference: "",
    });
    const lines = json(order.lines);
    expect(
      lines.map((l: any) => [
        l.item_id,
        l.slot,
        l.quantity,
        l.unit_cents,
        l.total_cents,
      ]),
    ).toEqual([
      [menu.xburger.id, 0, 1, 2500, 2500],
      [menu.xburger.id, 1, 2, 3000, 6000],
      [menu.suco.id, 0, 1, 800, 800],
    ]);
    expect(lines[0]).toMatchObject({
      note: "sem cebola",
      options: [expect.objectContaining({ id: "mal", name: "Mal passada" })],
    });
    expect(lines[1].options.map((o: any) => o.id)).toEqual(["bem", "bacon"]);
    const sent = await texts(c.id);
    const summary = sent.find((t) =>
      t.startsWith("Pedido nº 1 · Lanchonete da Ana"),
    )!;
    expect(summary).toContain(
      "1x X-Burger (Mal passada) — sem cebola: R$ 25,00",
    );
    expect(summary).toContain("2x X-Burger (Bem passada, Bacon): R$ 60,00");
    expect(summary).toContain("Total: R$ 100,00");
    expect(summary).toContain("Entregar em: Rua A, 10 - Centro, Apto 2");
    expect(sent.at(-1)).toBe(
      "Pedido nº 1 recebido! Previsão: cerca de 45 min.",
    );
    // Sem o retorno padrão do passo web ("Recebemos seu pedido. Total…").
    expect(
      sent.filter((t) => t.startsWith("Recebemos seu pedido")),
    ).toHaveLength(0);
    expect(await events(f, "pedido.created")).toEqual([
      expect.objectContaining({
        number: 1,
        source: "cart",
        total_cents: 10000,
        module_id: "pedido",
      }),
    ]);
    const history = await all(
      env,
      "SELECT kind,from_status,to_status,actor FROM pedido_history WHERE order_id=? ORDER BY created,rowid",
      order.id,
    );
    expect(history.map((h) => [h.kind, h.to_status])).toEqual([
      ["created", "awaiting_payment"],
      ["payment", "awaiting_payment"],
      ["status", "received"],
    ]);
    // Link usado: não cria outro pedido.
    expect(
      (await submitCart(code, { ...cartFields(menu), confirm: "1" })).status,
    ).toBe(410);
    expect(await orders(f)).toHaveLength(1);
    // Segundo pedido da área: número 2.
    const second = await openCart(f, "5511970000006", f.qr);
    await submitCart(second.code, {
      [`q_${menu.suco.id}`]: "3",
      fulfillment: "pickup",
      name: "Bia",
      confirm: "1",
    });
    expect((await orders(f)).map((o) => [o.number, o.total_cents])).toEqual([
      [1, 10000],
      [2, 2400],
    ]);
  });

  it("item esgotado ou loja pausada depois de abrir o link: a página recusa com o motivo e o link segue aberto", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: false } });
    const first = await openCart(f, "5511970000007");
    await run(f, f.member, "pedido.item.availability", {
      id: menu.suco.id,
      available: false,
    });
    const refused = await submitCart(first.code, {
      ...cartFields(menu),
      confirm: "1",
    });
    expect(refused.status).toBe(409);
    const page = await refused.text();
    expect(page).toContain("Suco de laranja esgotou enquanto você montava");
    expect(page).not.toContain("Pedido enviado!");
    expect(await orders(f)).toHaveLength(0);
    // Sem o suco, o mesmo link conclui.
    const { [`q_${menu.suco.id}`]: _suco, ...withoutJuice } = cartFields(menu);
    const done = await submitCart(first.code, {
      ...withoutJuice,
      confirm: "1",
    });
    expect(await done.text()).toContain("Pedido enviado!");
    expect(await orders(f)).toHaveLength(1);

    await run(f, f.member, "pedido.item.availability", {
      id: menu.suco.id,
      available: true,
    });
    const second = await openCart(f, "5511970000008");
    await run(f, f.member, "pedido.store.pause", { paused: true });
    const closed = await submitCart(second.code, {
      ...cartFields(menu),
      confirm: "1",
    });
    expect(closed.status).toBe(409);
    expect(await closed.text()).toContain(
      "Não conseguimos registrar o seu pedido: no momento não estamos recebendo pedidos",
    );
    expect(await orders(f)).toHaveLength(1);
    expect(
      (await events(f, "pedido.rejected")).map((e) => [e.reason, e.via]),
    ).toEqual([
      ["unavailable", "page"],
      ["closed", "page"],
    ]);
  });

  it("numeração sequencial com pedidos simultâneos, separada por área", async () => {
    const { f, ctx } = await setup();
    const other = await setup();
    const base = {
      conversation: null,
      customer_name: "Balcão",
      phone: "11999990000",
      source: "panel" as const,
      lines: [],
      item_count: 1,
      subtotal_cents: 800,
      delivery_fee_cents: 0,
      total_cents: 800,
      fulfillment: "pickup" as const,
      address: null,
      note: "",
      actor: f.admin.id,
    };
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        createOrder(ctx, {
          ...base,
          sourceKey: `simultaneo:${f.profile}:${i}`,
        }),
      ),
    );
    const numbers = created.map((r) => r.order.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Repetir a chave devolve o mesmo pedido.
    const again = await createOrder(ctx, {
      ...base,
      sourceKey: `simultaneo:${f.profile}:3`,
    });
    expect(again.created).toBe(false);
    expect(again.order.id).toBe(created[3].order.id);
    const elsewhere = await createOrder(other.ctx, {
      ...base,
      sourceKey: `simultaneo:${other.f.profile}:0`,
    });
    expect(elsewhere.order.number).toBe(1);
  });
});

describe("pedido no WhatsApp: pagamento", () => {
  it("pagamento na entrega: vai para o preparo e anota o troco", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: false } });
    const { c, code } = await openCart(f, "5511970000010");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    const [order] = await orders(f);
    expect(order).toMatchObject({
      status: "received",
      payment_method: "cash",
      payment_status: "pending",
    });
    expect((await latest(c.id)).text).toContain("Vai precisar de troco?");
    // Valor menor que o total: pede de novo.
    await say(f, "50", "5511970000010");
    expect((await latest(c.id)).text).toContain("O total é R$ 100,00");
    await say(f, "R$ 120,00", "5511970000010");
    expect((await latest(c.id)).text).toBe(
      "Anotado: troco para R$ 120,00 (R$ 20,00 de troco).",
    );
    expect(
      (
        await one(
          env,
          "SELECT change_for_cents FROM pedido_orders WHERE id=?",
          order.id,
        )
      ).change_for_cents,
    ).toBe(12000);
    // A pergunta acabou: "oi" volta ao menu.
    await say(f, "oi", "5511970000010");
    expect((await latest(c.id)).text).toContain("Cardápio");
  });

  it("forma e troco escolhidos na página: sem pergunta no WhatsApp", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: true } });
    const { c, code } = await openCart(f, "5511970000017");
    const page = await (await SELF.fetch(`https://test/api/w/${code}`)).text();
    expect(page).toContain("Como você quer pagar?");
    expect(page).toContain('value="cash"');
    expect(page).toContain('name="change_for"');
    await submitCart(code, {
      ...cartFields(menu),
      payment: "cash",
      change_for: "150",
      confirm: "1",
    });
    const [order] = await orders(f);
    expect(order).toMatchObject({
      status: "received",
      payment_method: "cash",
      payment_status: "pending",
      change_for_cents: 15000,
    });
    const sent = await texts(c.id);
    expect(sent.some((t) => t.includes("Como você quer pagar"))).toBe(false);
    expect(sent.some((t) => t.includes("Vai precisar de troco?"))).toBe(false);
  });

  it("várias formas: pergunta no WhatsApp, toque na linha oficial e número no QR", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: true } });
    const { c, code } = await openCart(f, "5511970000011");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    let [order] = await orders(f);
    expect(order).toMatchObject({
      status: "awaiting_payment",
      payment_status: "choosing",
      payment_method: null,
    });
    const question = await latest(c.id);
    expect(question.content.interactive).toMatchObject({ type: "button" });
    expect(question.text).toContain(
      "Como você quer pagar o pedido nº 1 (R$ 100,00)?",
    );
    // Texto que não é resposta segue para o menu, sem mudar o pedido.
    // Toque em "Cartão na maquininha".
    await receive(f, f.line, "Cartão na maquininha", "5511970000011", {
      interactive_reply_id: `pedido:pay:${order.id}:card`,
    });
    await drain(f);
    [order] = await orders(f);
    expect(order).toMatchObject({
      status: "received",
      payment_method: "card",
      payment_status: "pending",
    });
    // Toque repetido: avisa, não muda.
    await receive(f, f.line, "Dinheiro", "5511970000011", {
      interactive_reply_id: `pedido:pay:${order.id}:cash`,
    });
    await drain(f);
    expect((await latest(c.id)).text).toBe(
      "A forma de pagamento do pedido nº 1 já foi definida.",
    );

    // QR: texto numerado, "1" = dinheiro.
    const qr = await openCart(f, "5511970000012", f.qr);
    await submitCart(qr.code, { ...cartFields(menu), confirm: "1" });
    expect((await latest(qr.c.id)).text).toMatch(
      /1\. Dinheiro[\s\S]*2\. Cartão na maquininha/,
    );
    await say(f, "1", "5511970000012", f.qr);
    const second = (await orders(f))[1];
    expect(second).toMatchObject({
      number: 2,
      status: "received",
      payment_method: "cash",
    });
  });

  it("Pix confirmado por webhook simulado; webhook repetido e mensagem do cliente não mudam nada", async () => {
    const mp = stubMercadoPago();
    const { f, menu } = await setup({
      payments: { pix: true, cash: false, card: false },
    });
    const account = await paymentAccount(f);
    const { c, code } = await openCart(f, "5511970000020");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    let [order] = await orders(f);
    expect(order).toMatchObject({
      status: "awaiting_payment",
      payment_method: "pix",
      payment_status: "awaiting",
    });
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      order.payment_id,
    );
    expect(payment).toMatchObject({
      module_id: "pedido",
      ref_id: order.id,
      amount_cents: 10000,
      method: "pix",
      status: "created",
    });
    expect(payment.description).toBe("Pedido nº 1 · Lanchonete da Ana");
    expect(order.payment_due_at).toBe(payment.expires_at);
    const sent = await texts(c.id);
    expect(sent).toContain(
      "Pedido nº 1 registrado. Ele vai para o preparo assim que o pagamento for confirmado.",
    );
    expect(sent.some((t) => t.startsWith("00020126PIX"))).toBe(true);

    // "Já paguei" não muda nada: só o webhook confirma.
    await say(f, "já paguei", "5511970000020");
    [order] = await orders(f);
    expect(order).toMatchObject({
      status: "awaiting_payment",
      payment_status: "awaiting",
    });

    // Webhook do Mercado Pago com o pagamento aprovado.
    mp.remote.get(payment.provider_ref)!.status = "approved";
    expect((await webhook(account.id, payment.provider_ref)).status).toBe(200);
    [order] = await orders(f);
    expect(order).toMatchObject({
      status: "received",
      payment_status: "paid",
      paid_by: "provider",
    });
    expect(order.confirmed_at).toBeGreaterThan(0);
    expect(await events(f, "pedido.paid")).toEqual([
      expect.objectContaining({
        number: 1,
        amount_cents: 10000,
        method: "pix",
      }),
    ]);
    expect(
      (await texts(c.id)).filter((t) => t.startsWith("Pedido nº 1 recebido!")),
    ).toHaveLength(1);
    // O aviso do módulo é o comprovante: sem o "Pagamento recebido" do núcleo.
    expect(
      (await texts(c.id)).some((t) => t.startsWith("Pagamento recebido")),
    ).toBe(false);
    // Pedido pelo WhatsApp: consentimento de avisos do pedido registrado.
    expect(
      await one(
        env,
        "SELECT purpose,source,module_id,status FROM consents WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual({
      purpose: "order",
      source: "whatsapp",
      module_id: "pedido",
      status: "granted",
    });
    // Repetido: nada novo.
    await webhook(account.id, payment.provider_ref);
    await webhook(account.id, payment.provider_ref);
    expect(await events(f, "pedido.paid")).toHaveLength(1);
    expect(
      (await events(f, "pedido.status_changed")).filter(
        (e) => e.to === "received",
      ),
    ).toHaveLength(1);
    expect(
      (await texts(c.id)).filter((t) => t.startsWith("Pedido nº 1 recebido!")),
    ).toHaveLength(1);
    expect(
      mp.calls.filter((call) => call.path === "/v1/payments"),
    ).toHaveLength(1);
  });

  it("cancelar o pedido com o Pix aberto cancela a cobrança", async () => {
    stubMercadoPago();
    const { f, menu } = await setup({
      payments: { pix: true, cash: false, card: false },
    });
    await paymentAccount(f);
    const { code } = await openCart(f, "5511970000027");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    const [order] = await orders(f);
    expect(order.payment_status).toBe("awaiting");
    await perform(
      env,
      f.member,
      f.profile,
      "pedido.status",
      { id: order.id, status: "cancelled", reason: "Cliente desistiu." },
      uid(),
    );
    expect(
      (
        await one(
          env,
          "SELECT status FROM payments WHERE id=?",
          order.payment_id,
        )
      ).status,
    ).toBe("cancelled");
    const [after] = await orders(f);
    expect(after).toMatchObject({
      status: "cancelled",
      payment_status: "cancelled",
      needs_refund: 0,
    });
  });

  it("balcão só com telefone: com whatsapp_notices abre a conversa e registra o consentimento", async () => {
    const { f, menu } = await setup();
    const admin = await bearer(f.admin);
    const body = (phone: string, extra: any = {}) => ({
      customer_name: "Davi no balcão",
      phone,
      fulfillment: "pickup",
      payment_method: "cash",
      items: [{ item_id: menu.suco.id, quantity: 1 }],
      ...extra,
    });
    // Sem o aceite e sem conversa: nenhum aviso pelo WhatsApp.
    const plain = await (
      await api(
        admin,
        `/profiles/${f.profile}/pedido/orders`,
        "POST",
        body("5511966661111"),
      )
    ).json<any>();
    expect(plain.customer.conversation_id).toBeNull();
    // Com o aceite no balcão: conversa aberta na linha oficial.
    const noticed = await (
      await api(
        admin,
        `/profiles/${f.profile}/pedido/orders`,
        "POST",
        body("(11) 96666-2222", { whatsapp_notices: true }),
      )
    ).json<any>();
    const c = await one(
      env,
      "SELECT * FROM conversations WHERE id=?",
      noticed.customer.conversation_id,
    );
    expect(c).toMatchObject({
      connection_id: f.line,
      phone: "5511966662222",
      last_customer: 0,
    });
    expect(
      await one(
        env,
        "SELECT purpose,source FROM consents WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual({ purpose: "order", source: "panel" });
    // O resumo do pedido sai como notificação de pedido (fora da janela).
    const sent = await outbox(c.id);
    expect(sent.at(-1)).toMatchObject({ consent_purpose: "order" });
  });

  it("cobrança vencida cancela o pedido que esperava o pagamento; paga depois, marca estorno", async () => {
    const mp = stubMercadoPago();
    const { f, menu } = await setup({
      payments: { pix: true, cash: false, card: false },
    });
    const account = await paymentAccount(f);
    const { c, code } = await openCart(f, "5511970000021");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    let [order] = await orders(f);
    await exec(
      env,
      "UPDATE payments SET expires_at=? WHERE id=?",
      now() - 1000,
      order.payment_id,
    );
    await expirePayments(env, f.profile);
    [order] = await orders(f);
    expect(order).toMatchObject({
      status: "cancelled",
      payment_status: "expired",
      cancel_reason: "Pagamento não confirmado no prazo.",
      cancelled_by: "system",
    });
    expect((await latest(c.id)).text).toBe(
      "Pedido nº 1 cancelado. Pagamento não confirmado no prazo.",
    );
    expect(await events(f, "pedido.payment_expired")).toEqual([
      expect.objectContaining({ number: 1, status: "expired" }),
    ]);
    // O dinheiro entrou depois: pedido continua cancelado, com estorno a fazer.
    const payment = await one(
      env,
      "SELECT * FROM payments WHERE id=?",
      order.payment_id,
    );
    mp.remote.get(payment.provider_ref)!.status = "approved";
    await webhook(account.id, payment.provider_ref);
    [order] = await orders(f);
    expect(order).toMatchObject({
      status: "cancelled",
      payment_status: "paid",
      needs_refund: 1,
    });
    expect(await events(f, "pedido.payment_late")).toHaveLength(1);
    expect((await texts(c.id)).at(-1)).toContain(
      "chegou depois que ele foi cancelado",
    );
  });

  it("sem a Cobrança, Pix não é oferecido; falha ao cobrar volta para as formas na hora", async () => {
    const { f, menu } = await setup({
      payments: { pix: true, cash: true, card: true },
    });
    // Sem conta de pagamento: só dinheiro e maquininha na pergunta.
    const first = await openCart(f, "5511970000030");
    await submitCart(first.code, { ...cartFields(menu), confirm: "1" });
    const asked = await latest(first.c.id);
    expect(
      asked.content.interactive.action.buttons.map((b: any) => b.reply.title),
    ).toEqual(["Dinheiro", "Cartão na maquininha"]);
    // Com conta, mas o provedor falha: pergunta de novo sem o Pix.
    await paymentAccount(f);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const second = await openCart(f, "5511970000031");
    await submitCart(second.code, { ...cartFields(menu), confirm: "1" });
    const order = (await orders(f))[1];
    expect(
      (await latest(second.c.id)).content.interactive.action.buttons.map(
        (b: any) => b.reply.id,
      ),
    ).toEqual([
      `pedido:pay:${order.id}:pix`,
      `pedido:pay:${order.id}:cash`,
      `pedido:pay:${order.id}:card`,
    ]);
    await receive(f, f.line, "Pix agora", "5511970000031", {
      interactive_reply_id: `pedido:pay:${order.id}:pix`,
    });
    await drain(f);
    const failed = await one(
      env,
      "SELECT * FROM pedido_orders WHERE id=?",
      order.id,
    );
    expect(failed).toMatchObject({
      status: "awaiting_payment",
      payment_status: "failed",
      payment_method: "pix",
    });
    expect(failed.payment_error).toBeTruthy();
    const retry = await latest(second.c.id);
    expect(
      retry.content.interactive.action.buttons.map((b: any) => b.reply.title),
    ).toEqual(["Dinheiro", "Cartão na maquininha"]);
    expect(await events(f, "pedido.payment_failed")).toHaveLength(1);
    await receive(f, f.line, "Dinheiro", "5511970000031", {
      interactive_reply_id: `pedido:pay:${order.id}:cash`,
    });
    await drain(f);
    expect(
      await one(
        env,
        "SELECT status,payment_method,payment_status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({
      status: "received",
      payment_method: "cash",
      payment_status: "pending",
    });
  });
});

describe("pedido no WhatsApp: catálogo da Meta, acompanhar e ação da equipe", () => {
  const catalogCart = (items: any[]) => ({
    type: "order",
    order: { catalog_id: "cat-1", note: "Sem gelo", items },
  });

  it("carrinho do catálogo com retailer_id vira pedido com os preços do cardápio", async () => {
    const { f } = await setup({ payments: { cash: true, card: false } });
    const phone = "5511970000040";
    let c = await say(
      f,
      "Pedido pelo catálogo",
      phone,
      f.line,
      catalogCart([
        {
          product_retailer_id: "SUCO-500",
          quantity: 3,
          item_price: 1,
          currency: "BRL",
        },
      ]),
    );
    const question = await latest(c.id);
    expect(question.text).toContain(
      "Recebemos o seu carrinho (3 itens, R$ 24,00)",
    );
    expect(question.content.interactive.type).toBe("button");
    await receive(f, f.line, "Entrega", phone, {
      interactive_reply_id: "pedido:receber:delivery",
    });
    await drain(f);
    expect((await latest(c.id)).text).toContain("Envie o endereço da entrega");
    c = await say(f, "Rua B, 20 - Jardim", phone);
    const [order] = await orders(f);
    expect(order).toMatchObject({
      number: 1,
      source: "catalog",
      fulfillment: "delivery",
      subtotal_cents: 2400,
      delivery_fee_cents: 700,
      total_cents: 3100,
      note: "Sem gelo",
      status: "received",
      payment_method: "cash",
    });
    expect(json(order.address).street).toBe("Rua B, 20 - Jardim");
    expect(json(order.lines)).toEqual([
      expect.objectContaining({
        name: "Suco de laranja",
        quantity: 3,
        unit_cents: 800,
      }),
    ]);
    // O resumo do pedido não abre o menu.
    expect((await texts(c.id)).join("\n")).not.toContain("Escolha uma opção");
  });

  it("produto sem retailer_id vai para a equipe; item com escolha obrigatória recebe o link", async () => {
    const { f } = await setup();
    const unknown = await say(
      f,
      "Pedido",
      "5511970000041",
      f.line,
      catalogCart([
        {
          product_retailer_id: "NAO-EXISTE",
          quantity: 1,
          item_price: 5,
          currency: "BRL",
        },
      ]),
    );
    expect(await orders(f)).toHaveLength(0);
    expect((await texts(unknown.id)).join("\n")).not.toContain(
      "Recebemos o seu carrinho",
    );
    const choice = await say(
      f,
      "Pedido",
      "5511970000042",
      f.line,
      catalogCart([
        {
          product_retailer_id: "XB-01",
          quantity: 1,
          item_price: 25,
          currency: "BRL",
        },
      ]),
    );
    const sent = await outbox(choice.id);
    expect(sent.map((m) => String(m.text)).join("\n")).toContain(
      "X-Burger tem escolhas que o catálogo não guarda",
    );
    expect(sent.at(-1).content.interactive.type).toBe("cta_url");
    expect(await orders(f)).toHaveLength(0);
  });

  it("Acompanhar pedido mostra os pedidos em andamento do cliente", async () => {
    const { f, menu } = await setup({ payments: { cash: true, card: true } });
    const { c, code } = await openCart(f, "5511970000050");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    await say(f, "menu", "5511970000050");
    await say(f, "2", "5511970000050");
    const sent = await texts(c.id);
    const track = sent.find((t) => t.startsWith("Seu pedido:"))!;
    expect(track).toContain("Pedido nº 1 · Aguardando pagamento");
    expect(track).toContain("4 itens · R$ 100,00 · Entrega");
    expect(track).toContain("Pagamento: aguardando a sua escolha");
    // A pergunta da forma de pagamento volta.
    expect((await latest(c.id)).text).toContain(
      "Como você quer pagar o pedido nº 1",
    );
    const stranger = await say(f, "oi", "5511970000059");
    await say(f, "2", "5511970000059");
    expect((await latest(stranger.id)).text).toBe(
      "Você não tem pedidos em andamento. Toque em Cardápio no menu para pedir.",
    );
  });

  it("ação Montar pedido para este cliente envia o link do carrinho", async () => {
    const { f } = await setup();
    const c = await say(f, "quero pedir", "5511970000060");
    await expect(
      perform(
        env,
        f.member,
        f.profile,
        "conversation.action",
        { id: c.id, action: "pedido_link" },
        uid(),
      ),
    ).rejects.toThrow(/Assuma a conversa/);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    const sent = await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "pedido_link" },
      uid(),
    );
    expect(sent).toMatchObject({ sent: true, reason: "open" });
    expect(sent.web_step).toMatchObject({
      module_id: "pedido",
      kind: "cart",
      trigger: "agent",
    });
    const link = await latest(c.id);
    expect(link.content.interactive.type).toBe("cta_url");
    expect(codeIn(link.text)).toBeTruthy();
    expect((await conversation(env, c.id, f.profile)).owner).toBe(f.member.id);
  });
});

describe("pedido no WhatsApp: preparo sem esperar o pagamento", () => {
  it("falha ao cobrar mantém o pedido no preparo e aceita a forma na hora", async () => {
    const { f, menu } = await setup({
      payments: { pix: true, cash: true, card: false },
      pay_before_prepare: false,
    });
    await paymentAccount(f);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const { c, code } = await openCart(f, "5511970000070");
    await submitCart(code, { ...cartFields(menu), confirm: "1" });
    const [order] = await orders(f);
    await receive(f, f.line, "Pix agora", "5511970000070", {
      interactive_reply_id: `pedido:pay:${order.id}:pix`,
    });
    await drain(f);
    // Foi para o preparo antes de cobrar; a cobrança falhou.
    expect(
      await one(
        env,
        "SELECT status,payment_status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({ status: "received", payment_status: "failed" });
    expect(
      (await latest(c.id)).content.interactive.action.buttons.map(
        (b: any) => b.reply.title,
      ),
    ).toEqual(["Dinheiro"]);
    await receive(f, f.line, "Dinheiro", "5511970000070", {
      interactive_reply_id: `pedido:pay:${order.id}:cash`,
    });
    await drain(f);
    expect(
      await one(
        env,
        "SELECT status,payment_method,payment_status FROM pedido_orders WHERE id=?",
        order.id,
      ),
    ).toEqual({
      status: "received",
      payment_method: "cash",
      payment_status: "pending",
    });
    expect((await latest(c.id)).text).toContain("Vai precisar de troco?");
  });
});
