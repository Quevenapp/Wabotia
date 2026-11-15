// Pedido no WhatsApp: item de menu "Cardápio" (imagens + botão Fazer pedido
// que abre a página de carrinho do passo web), conclusão do carrinho virando
// pedido, pergunta da forma de pagamento e do troco, "Acompanhar pedido" e o
// carrinho do catálogo da Meta (retirada/entrega e endereço no chat).
import { ApiError, type Conversation, json, now } from "../../types";
import type { ModuleContext, WebStep } from "../api";
import type { CartOrder } from "../../web-cart";
import { numberedReply } from "../../whatsapp-interactive";
import {
  PAYMENT_METHODS,
  clockOf,
  etaText,
  isOnline,
  money,
  type PaymentMethod,
} from "./model";
import {
  cartCategories,
  itemsByRetailer,
  loadMenu,
  menuImages,
  type Menu,
} from "./menu";
import { config, offeredMethods, storeSituation } from "./store";
import {
  applyMethod,
  choosable,
  clearChat,
  createOrder,
  loadOrder,
  openOrdersFor,
  paymentSpec,
  pickupAddress,
  saveChat,
  sendSummary,
  startPayment,
  storeName,
  trackLines,
  type OrderLine,
} from "./orders";
import { all, exec, one } from "../../db";

const plain = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();

async function say(
  ctx: ModuleContext,
  c: Conversation,
  text: string,
  key: string,
  notification = false,
) {
  try {
    return await ctx.sendMessage(c, { text }, { key, notification });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return null;
  }
}
async function ask(
  ctx: ModuleContext,
  c: Conversation,
  spec: Parameters<ModuleContext["sendInteractive"]>[1],
  key: string,
) {
  try {
    return await ctx.sendInteractive(c, spec, { key });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cardápio e link do carrinho

/**
 * Abre o carrinho (passo web, página "cart") com o cardápio atual e as regras
 * da loja. Com a loja fechada, responde com o horário e não abre. `images`:
 * manda antes as imagens do cardápio (item de menu "Cardápio").
 */
export async function sendCart(
  ctx: ModuleContext,
  c: Conversation,
  options: {
    trigger: "menu" | "agent" | "bot" | "module";
    actor: string;
    sourceKey: string;
    images: boolean;
  },
) {
  await ctx.requireEnabled();
  const cfg = await config(ctx);
  const at = now();
  const store = await storeSituation(ctx, cfg, at);
  if (!store.open) {
    await say(ctx, c, store.message, `closed:${options.sourceKey}`);
    return { sent: false as const, reason: store.reason, step: null };
  }
  const menu = await loadMenu(ctx);
  const categories = cartCategories(menu);
  if (!categories) {
    await say(
      ctx,
      c,
      "O cardápio ainda não está disponível. Envie MENU para ver as opções.",
      `empty:${options.sourceKey}`,
    );
    return { sent: false as const, reason: "empty_menu", step: null };
  }
  if (options.images) {
    const images = await menuImages(ctx);
    for (const [index, image] of images.entries())
      if (image.type)
        await ctx.sendMessage(
          c,
          {
            text: image.caption || (index ? "Cardápio" : "Nosso cardápio"),
            content: {
              type: image.type.startsWith("application/pdf")
                ? "document"
                : "image",
            },
            attachments: [image.media_id],
          },
          {
            key: `menu-image:${options.sourceKey}:${index}`,
            actor: options.actor,
          },
        );
  }
  const title = await storeName(ctx, cfg);
  const pickup = await pickupAddress(ctx, cfg);
  const intro = [
    store.closes_at ? `Aberto até ${clockOf(store.closes_at)}.` : "",
    cfg.minimum_cents ? `Pedido mínimo: ${money(cfg.minimum_cents)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const opened = await ctx.openWebStep(c, {
    kind: "cart",
    ref: null,
    trigger: options.trigger,
    actor: options.actor,
    sourceKey: options.sourceKey,
    ttlMinutes: cfg.cart_minutes,
    text: `Monte o seu pedido pelo link. Ele vale por ${cfg.cart_minutes} minutos.`,
    button: "Fazer pedido",
    spec: {
      page: "cart",
      title,
      ...(intro ? { intro } : {}),
      fields: [],
      done_text:
        "Pedido enviado! O número e o pagamento chegam na conversa do WhatsApp.",
      return_message: "module",
      ticket: "none",
      cart: {
        currency: "BRL",
        categories,
        fulfillment: {
          pickup: cfg.pickup,
          delivery: cfg.delivery,
          delivery_fee_cents: cfg.delivery ? cfg.delivery_fee_cents : 0,
          minimum_cents: cfg.minimum_cents,
          ...(etaText(cfg) ? { eta: etaText(cfg) } : {}),
          ...(cfg.pickup && pickup
            ? { pickup_address: pickup.slice(0, 200) }
            : {}),
        },
        allow_note: true,
      },
    },
  });
  return { sent: true as const, reason: "open", step: opened.step };
}

// ---------------------------------------------------------------------------
// Carrinho concluído

/** Itens ou adicionais que esgotaram depois que o link foi aberto. */
function unavailableNow(menu: Menu, lines: OrderLine[]) {
  const items = new Map(
    menu.categories.flatMap((cat) => cat.items).map((item) => [item.id, item]),
  );
  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  const names = new Set<string>();
  for (const line of lines) {
    const item = items.get(line.item_id);
    if (!item || !item.available) {
      names.add(line.name);
      continue;
    }
    for (const option of line.options) {
      const group = groups.get(option.group_id);
      const current = group?.options.find((o) => o.id === option.id);
      if (!group || !item.group_ids.includes(group.id) || !current?.available)
        names.add(`${line.name} (${option.name})`);
    }
  }
  return [...names];
}

async function reject(
  ctx: ModuleContext,
  c: Conversation,
  step: WebStep,
  reason: "closed" | "unavailable",
  text: string,
  detail: Record<string, unknown> = {},
) {
  await say(ctx, c, text, `rejected:${step.id}`, true);
  await ctx.publish(
    "pedido.rejected",
    step.id,
    {
      web_step_id: step.id,
      reason,
      conversation_id: c.id,
      ...detail,
    },
    { key: `rejected:${step.id}` },
  );
}

/** Loja fechada ou item esgotado desde que o link foi aberto. */
async function cartRefusal(ctx: ModuleContext, cart: CartOrder) {
  const cfg = await config(ctx);
  const store = await storeSituation(ctx, cfg, now());
  if (!store.open)
    return {
      reason: "closed" as const,
      text: `Não conseguimos registrar o seu pedido: ${store.message.charAt(0).toLowerCase()}${store.message.slice(1)}`,
      detail: {},
    };
  const missing = unavailableNow(await loadMenu(ctx), cart.lines);
  if (missing.length)
    return {
      reason: "unavailable" as const,
      text: `Não conseguimos registrar o seu pedido: ${missing.join(", ")} ${missing.length === 1 ? "esgotou" : "esgotaram"} enquanto você montava. Tire ${missing.length === 1 ? "o item" : "os itens"} do carrinho e confira de novo.`,
      detail: { items: missing },
    };
  return null;
}

/**
 * onWebStepValidate da página de carrinho: recusa na própria página, antes
 * de concluir, com o motivo; o link segue aberto para o cliente ajustar.
 */
export async function cartValidate(
  ctx: ModuleContext,
  step: WebStep,
  cart: CartOrder,
) {
  const refusal = await cartRefusal(ctx, cart);
  if (!refusal) return null;
  await ctx.publish(
    "pedido.rejected",
    step.id,
    {
      web_step_id: step.id,
      reason: refusal.reason,
      conversation_id: step.conversation_id,
      via: "page",
      ...refusal.detail,
    },
    { key: `rejected:${step.id}:${refusal.reason}` },
  );
  return refusal.text;
}

/**
 * onWebStepCompleted da página de carrinho: o núcleo já validou e
 * recalculou os valores a partir do catálogo guardado no passo, e
 * cartValidate já conferiu loja e itens. Confere de novo (corrida rara entre
 * a conferência e a conclusão), cria o pedido com o número, manda o resumo e
 * segue para o pagamento.
 */
export async function cartCompleted(
  ctx: ModuleContext,
  step: WebStep,
  cart: CartOrder,
) {
  let c: Conversation;
  try {
    c = await ctx.conversation(step.conversation_id);
  } catch {
    return;
  }
  const refusal = await cartRefusal(ctx, cart);
  if (refusal)
    return reject(ctx, c, step, refusal.reason, refusal.text, refusal.detail);
  const { order, created } = await createOrder(ctx, {
    conversation: c,
    customer_name: cart.customer_name,
    source: "cart",
    sourceKey: `web_step:${step.id}`,
    web_step_id: step.id,
    lines: cart.lines.map((line) => ({ ...line, slot: line.slot ?? 0 })),
    item_count: cart.item_count,
    subtotal_cents: cart.subtotal_cents,
    delivery_fee_cents: cart.delivery_fee_cents,
    total_cents: cart.total_cents,
    fulfillment: cart.fulfillment,
    address: cart.address,
    note: cart.note,
    actor: "customer",
  });
  if (!created) return;
  await sendSummary(ctx, c, order);
  await startPayment(ctx, order, c, { actor: "customer" });
}

// ---------------------------------------------------------------------------
// Carrinho do catálogo da Meta (content.order)

interface CatalogDraft {
  lines: OrderLine[];
  item_count: number;
  subtotal_cents: number;
  note: string;
  row_id: string;
  fulfillment?: "pickup" | "delivery";
}

/**
 * Carrinho enviado pelo catálogo do WhatsApp: vira pedido quando todos os
 * produtos têm retailer_id cadastrado no cardápio (preços do cardápio, nunca
 * os do carrinho). Sem correspondência, devolve false e o núcleo passa à
 * equipe. Itens com escolha obrigatória recebem o link do carrinho.
 */
export async function catalogOrder(
  ctx: ModuleContext,
  c: Conversation,
  content: any,
  rowId: string,
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const products: any[] = Array.isArray(content?.order?.items)
    ? content.order.items
    : [];
  const quantities = new Map<string, number>();
  for (const product of products) {
    const id = String(product?.product_retailer_id || "").trim();
    const quantity = Number(product?.quantity);
    if (!id || !Number.isInteger(quantity) || quantity < 1) return false;
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  if (!quantities.size) return false;
  const items = await itemsByRetailer(ctx, [...quantities.keys()]);
  if (items.length !== quantities.size) return false;
  const key = `catalog:${rowId}`;
  const cfg = await config(ctx);
  const store = await storeSituation(ctx, cfg, now());
  if (!store.open) {
    await say(ctx, c, store.message, `closed:${key}`);
    return true;
  }
  const sold = items.filter((item) => !item.available).map((i) => i.name);
  if (sold.length) {
    await say(
      ctx,
      c,
      `${sold.join(", ")} ${sold.length === 1 ? "está esgotado" : "estão esgotados"} no momento. Envie o carrinho de novo sem ${sold.length === 1 ? "ele" : "eles"} ou toque em Cardápio no menu.`,
      `sold:${key}`,
    );
    return true;
  }
  const required = await all(
    ctx.env,
    `SELECT DISTINCT ig.item_id FROM pedido_item_groups ig JOIN pedido_groups g ON g.id=ig.group_id WHERE ig.profile_id=? AND g.min>0 AND ig.item_id IN (${items.map(() => "?").join(",")})`,
    ctx.profile,
    ...items.map((i) => i.id),
  );
  if (required.length) {
    const names = items
      .filter((i) => required.some((r) => r.item_id === i.id))
      .map((i) => i.name);
    await say(
      ctx,
      c,
      `${names.join(", ")} ${names.length === 1 ? "tem escolhas" : "têm escolhas"} que o catálogo não guarda (ponto, sabor, tamanho). Monte o pedido pelo link:`,
      `choices:${key}`,
    );
    try {
      await sendCart(ctx, c, {
        trigger: "module",
        actor: "system",
        sourceKey: key,
        images: false,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    return true;
  }
  const over = items.find(
    (i) => quantities.get(i.retailer_id)! > i.max_quantity,
  );
  if (over) {
    await say(
      ctx,
      c,
      `${over.name}: até ${over.max_quantity} por pedido. Ajuste o carrinho e envie de novo.`,
      `max:${key}`,
    );
    return true;
  }
  const lines: OrderLine[] = items.map((item) => {
    const quantity = quantities.get(item.retailer_id)!;
    return {
      item_id: item.id,
      slot: 0,
      name: item.name,
      quantity,
      unit_cents: item.price_cents,
      options: [],
      note: "",
      total_cents: item.price_cents * quantity,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.total_cents, 0);
  if (subtotal < cfg.minimum_cents) {
    await say(
      ctx,
      c,
      `O pedido mínimo é de ${money(cfg.minimum_cents)} (sem a entrega). O seu carrinho deu ${money(subtotal)}.`,
      `minimum:${key}`,
    );
    return true;
  }
  const draft: CatalogDraft = {
    lines,
    item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal_cents: subtotal,
    note: String(content?.order?.note || content?.order?.text || "")
      .trim()
      .slice(0, 300),
    row_id: rowId,
  };
  if (cfg.pickup && cfg.delivery) {
    await saveChat(ctx, c, "fulfillment", null, { draft }, 30);
    await ask(
      ctx,
      c,
      {
        type: "button",
        body: `Recebemos o seu carrinho (${draft.item_count} ${draft.item_count === 1 ? "item" : "itens"}, ${money(subtotal)}). Como você quer receber?`,
        buttons: [
          { id: "pedido:receber:pickup", title: "Retirar no local" },
          {
            id: "pedido:receber:delivery",
            title: "Entrega",
            description: cfg.delivery_fee_cents
              ? `taxa de ${money(cfg.delivery_fee_cents)}`
              : "sem taxa",
          },
        ],
      },
      `fulfillment:${key}`,
    );
    return true;
  }
  if (cfg.delivery) {
    await askAddress(ctx, c, { ...draft, fulfillment: "delivery" }, key);
    return true;
  }
  await finishCatalog(ctx, c, { ...draft, fulfillment: "pickup" }, null);
  return true;
}

async function askAddress(
  ctx: ModuleContext,
  c: Conversation,
  draft: CatalogDraft,
  key: string,
) {
  await saveChat(ctx, c, "address", null, { draft }, 30);
  await say(
    ctx,
    c,
    "Envie o endereço da entrega: rua, número e bairro (e um complemento, se houver).",
    `address:${key}`,
  );
}

async function finishCatalog(
  ctx: ModuleContext,
  c: Conversation,
  draft: CatalogDraft,
  address: string | null,
) {
  const cfg = await config(ctx);
  await clearChat(ctx, c.id);
  const fee = draft.fulfillment === "delivery" ? cfg.delivery_fee_cents : 0;
  const contact = await ctx.contact(c);
  const { order, created } = await createOrder(ctx, {
    conversation: c,
    customer_name: contact?.name || c.title || "",
    source: "catalog",
    sourceKey: `catalog:${draft.row_id}`,
    lines: draft.lines,
    item_count: draft.item_count,
    subtotal_cents: draft.subtotal_cents,
    delivery_fee_cents: fee,
    total_cents: draft.subtotal_cents + fee,
    fulfillment: draft.fulfillment || "pickup",
    address: address
      ? { street: address, district: "", complement: "", reference: "" }
      : null,
    note: draft.note,
    actor: "customer",
  });
  if (!created) return;
  await sendSummary(ctx, c, order);
  await startPayment(ctx, order, c, { actor: "customer" });
}

// ---------------------------------------------------------------------------
// Respostas do cliente (onConversationTurn)

const CANCEL_WORDS = ["menu", "voltar", "sair", "cancelar", "0"];

/** Valor em reais digitado ("50", "R$ 100,00", "100.50"), em centavos. */
export function parseAmount(text: string) {
  const clean = text.replace(/r\$|\s/gi, "");
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean.replace(",", ".")) * 100);
}

/**
 * Próxima mensagem do cliente: toque nas opções do Pedido (prefixo
 * "pedido:") ou resposta a uma pergunta aberta em pedido_chats (forma de
 * pagamento, troco, retirada/entrega, endereço). Devolve true só quando é do
 * Pedido; MENU/VOLTAR limpa a pergunta e deixa o menu responder.
 */
export async function pedidoTurn(
  ctx: ModuleContext,
  c: Conversation,
  turn: { text: string; replyId: string | null; rowId: string },
): Promise<boolean> {
  if (c.chat_type === "group") return false;
  const key = `turn:${turn.rowId}`;
  if (turn.replyId) {
    if (!turn.replyId.startsWith("pedido:")) return false;
    const pay = /^pedido:pay:([^:]+):(pix|link|cash|card)$/.exec(turn.replyId);
    if (pay) return choosePayment(ctx, c, pay[1], pay[2] as PaymentMethod, key);
    const receive = /^pedido:receber:(pickup|delivery)$/.exec(turn.replyId);
    const chat = await loadChat(ctx, c.id);
    if (receive && chat?.step === "fulfillment")
      return chooseFulfillment(ctx, c, chat, receive[1] as any, key);
    await say(ctx, c, "Esta opção não está mais disponível.", key);
    return true;
  }
  const chat = await loadChat(ctx, c.id);
  if (!chat) return false;
  const text = plain(turn.text || "");
  if (chat.expires_at <= now() || CANCEL_WORDS.includes(text)) {
    await clearChat(ctx, c.id);
    return false;
  }
  // Conversa com atendente: só respostas claras à pergunta aberta.
  switch (chat.step) {
    case "payment": {
      const methods: PaymentMethod[] = (chat.data.methods || []).filter(
        (m: any) => PAYMENT_METHODS.includes(m),
      );
      const order = await one(
        ctx.env,
        "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
        chat.order_id,
        ctx.profile,
      );
      if (!order || !methods.length) {
        await clearChat(ctx, c.id);
        return false;
      }
      const picked = numberedReply(
        paymentSpec(order, methods),
        turn.text || "",
      );
      const method = picked?.split(":").pop() as PaymentMethod | undefined;
      if (!method || !methods.includes(method)) return false;
      return choosePayment(ctx, c, order.id, method, key);
    }
    case "change": {
      await clearChat(ctx, c.id);
      if (/^(nao|n)(\s|,|$)|^sem troco/.test(text)) {
        await say(ctx, c, "Combinado, sem troco.", key);
        return true;
      }
      const amount = parseAmount(turn.text || "");
      if (amount === null) return false;
      const order = await one(
        ctx.env,
        "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
        chat.order_id,
        ctx.profile,
      );
      if (!order) return false;
      if (amount < order.total_cents) {
        await saveChat(ctx, c, "change", order.id, {}, 30);
        await say(
          ctx,
          c,
          `O total é ${money(order.total_cents)}. Responda com um valor a partir dele ou NÃO.`,
          key,
        );
        return true;
      }
      await exec(
        ctx.env,
        "UPDATE pedido_orders SET change_for_cents=?,updated=? WHERE id=? AND profile_id=?",
        amount,
        now(),
        order.id,
        ctx.profile,
      );
      await ctx.publish(
        "pedido.status_changed",
        order.id,
        {
          order_id: order.id,
          number: order.number,
          from: order.status,
          to: order.status,
          actor: "customer",
          note: `Troco para ${money(amount)}.`,
          conversation_id: order.conversation_id,
          fulfillment: order.fulfillment,
        },
        { key: `change:${order.id}:${amount}` },
      );
      await say(
        ctx,
        c,
        `Anotado: troco para ${money(amount)} (${money(amount - order.total_cents)} de troco).`,
        key,
      );
      return true;
    }
    case "fulfillment": {
      const choice = /^(1|retirar|retirada|retirar no local|buscar)$/.test(text)
        ? "pickup"
        : /^(2|entrega|entregar|delivery)$/.test(text)
          ? "delivery"
          : null;
      if (!choice) return false;
      return chooseFulfillment(ctx, c, chat, choice, key);
    }
    case "address": {
      const address = (turn.text || "").trim();
      if (Array.from(address).length < 6 || Array.from(address).length > 200) {
        await say(
          ctx,
          c,
          "Envie o endereço com rua, número e bairro (até 200 caracteres), ou MENU para desistir.",
          key,
        );
        return true;
      }
      await finishCatalog(ctx, c, chat.data.draft, address);
      return true;
    }
  }
  return false;
}

async function loadChat(ctx: ModuleContext, conversationId: string) {
  const row = await one(
    ctx.env,
    "SELECT * FROM pedido_chats WHERE conversation_id=? AND profile_id=?",
    conversationId,
    ctx.profile,
  );
  return row ? { ...row, data: json(row.data) } : null;
}

async function chooseFulfillment(
  ctx: ModuleContext,
  c: Conversation,
  chat: any,
  choice: "pickup" | "delivery",
  key: string,
) {
  const draft: CatalogDraft = { ...chat.data.draft, fulfillment: choice };
  if (choice === "delivery") await askAddress(ctx, c, draft, key);
  else await finishCatalog(ctx, c, draft, null);
  return true;
}

async function choosePayment(
  ctx: ModuleContext,
  c: Conversation,
  orderId: string,
  method: PaymentMethod,
  key: string,
) {
  const order = await one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE id=? AND profile_id=? AND conversation_id=?",
    orderId,
    ctx.profile,
    c.id,
  );
  if (!order) {
    await say(ctx, c, "Não encontramos este pedido.", key);
    return true;
  }
  if (!choosable(order)) {
    await say(
      ctx,
      c,
      `A forma de pagamento do pedido nº ${order.number} já foi definida.`,
      key,
    );
    return true;
  }
  const cfg = await config(ctx);
  const offered = await offeredMethods(ctx, cfg);
  const allowed =
    order.payment_status === "failed"
      ? offered.filter((m) => !isOnline(m))
      : offered;
  if (!allowed.includes(method)) {
    await say(
      ctx,
      c,
      "Esta forma de pagamento não está disponível agora. Escolha outra.",
      key,
    );
    return true;
  }
  try {
    await applyMethod(ctx, order, c, method, "customer");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await say(ctx, c, error.message, key);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Acompanhar pedido

export async function trackOrders(
  ctx: ModuleContext,
  c: Conversation,
  rowId: string,
) {
  const orders = await openOrdersFor(ctx, c);
  if (!orders.length) {
    await say(
      ctx,
      c,
      "Você não tem pedidos em andamento. Toque em Cardápio no menu para pedir.",
      `track:${rowId}`,
    );
    return;
  }
  await say(
    ctx,
    c,
    [
      orders.length === 1 ? "Seu pedido:" : "Seus pedidos em andamento:",
      ...orders.map(trackLines),
    ].join("\n\n"),
    `track:${rowId}`,
  );
  // Pedido esperando a forma de pagamento: a pergunta volta.
  const choosing = orders.find(
    (o) => o.status === "awaiting_payment" && o.payment_status === "choosing",
  );
  if (choosing && choosing.conversation_id === c.id) {
    const cfg = await config(ctx);
    const methods = await offeredMethods(ctx, cfg);
    if (methods.length > 1) {
      await saveChat(
        ctx,
        c,
        "payment",
        choosing.id,
        { methods },
        cfg.payment_minutes,
      );
      await ask(ctx, c, paymentSpec(choosing, methods), `track-pay:${rowId}`);
    }
  }
}

export { loadOrder };
