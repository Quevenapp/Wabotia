// Pedido pelo bot de IA que atende o cliente no WhatsApp (modo cliente,
// src/bot-actions/customer.ts) e o desconto aprovado pela equipe
// (ctx.requestApproval). Regras:
// - O modelo nunca informa nem decide preço: o rascunho é calculado aqui com
//   o cardápio, e o resumo com os valores vai ao cliente por este módulo, com
//   os botões dele. O modelo recebe só nomes e quantidades.
// - Tudo é da conversa da execução (o núcleo põe o conversation_id); nada
//   aceita telefone, nome ou número de pedido vindo do texto.
// - O texto do cliente não confirma desconto: só a decisão de uma pessoa da
//   equipe, pela rota de aprovação do núcleo.
import { all, exec, one } from "../../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  now,
  requireValue,
  uid,
} from "../../types";
import type { ModuleContext } from "../api";
import type { ApprovalDecision } from "../../approvals";
import { requireFinancialAal } from "../../mfa";
import { validateCartOrder, validateCatalog } from "../../web-cart";
import { cartCategories, loadMenu, type Menu } from "./menu";
import { linesToCartInput } from "./manage";
import { config, storeSituation } from "./store";
import {
  askPaymentAgain,
  clearChat,
  orderView,
  saveChat,
  type OrderLine,
} from "./orders";
import { dateTimeOf, money } from "./model";
import { routineCustomer } from "../agenda/customer-provider";
import { proceedDraft, type CatalogDraft } from "./chat";

const DRAFT_MINUTES = 30;

async function tell(
  ctx: ModuleContext,
  c: Conversation,
  text: string,
  key: string,
) {
  try {
    await ctx.sendMessage(
      c,
      { text },
      { key, notification: true, purpose: "order" },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
}

/** Quem age na conversa pelo cliente: o bot que atende, o dono ou um admin. */
function mayActOn(actor: Actor, c: Conversation) {
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de montar o pedido do cliente.",
  );
  requireValue(c.chat_type !== "group", "Pedidos só em conversas individuais.");
}

// ---------------------------------------------------------------------------
// Cardápio para o bot, sem preços

/**
 * GET pedido/itens: o que o bot precisa para montar o pedido (ids, nomes,
 * descrição, esgotado e as escolhas de cada item), **sem preços**: quem diz
 * valor ao cliente é o resumo do módulo.
 */
export async function menuForBot(ctx: ModuleContext) {
  const menu = await loadMenu(ctx);
  const groups = new Map(menu.groups.map((g) => [g.id, g]));
  return {
    aviso:
      "Sem preços: para o cliente ver valores, monte o pedido (pedido_montar) ou envie o carrinho; nunca informe preço.",
    categorias: menu.categories
      .filter((cat) => cat.items.length)
      .map((cat) => ({
        nome: cat.name,
        itens: cat.items.map((item) => ({
          item_id: item.id,
          nome: item.name,
          descricao: item.description || "",
          disponivel: item.available,
          maximo: item.max_quantity,
          escolhas: item.group_ids
            .map((id) => groups.get(id))
            .filter((g): g is NonNullable<typeof g> => !!g)
            .map((g) => ({
              grupo_id: g.id,
              nome: g.name,
              minimo: g.min,
              maximo: g.max,
              opcoes: g.options
                .filter((o) => o.available !== false)
                .map((o) => ({ id: o.id, nome: o.name })),
            })),
        })),
      })),
  };
}

/** Itens disponíveis da mesma categoria, para sugerir no lugar. */
function alternatives(menu: Menu, itemId: string | null) {
  const cat =
    menu.categories.find((c) => c.items.some((i) => i.id === itemId)) || null;
  const pool = (cat ? [cat] : menu.categories).flatMap((c) => c.items);
  return pool
    .filter((i) => i.available && i.id !== itemId)
    .slice(0, 5)
    .map((i) => i.name);
}

// ---------------------------------------------------------------------------
// Montar o pedido pela conversa

interface BotItem {
  item_id?: unknown;
  quantidade?: unknown;
  escolhas?: unknown;
  observacao?: unknown;
}

/** Itens do modelo → linhas do pedido, com o preço do cardápio. */
async function priced(ctx: ModuleContext, items: unknown, note: unknown) {
  requireValue(
    Array.isArray(items) && items.length >= 1 && items.length <= 20,
    "Informe de 1 a 20 itens (itens).",
  );
  const menu = await loadMenu(ctx);
  const all = new Map(
    menu.categories.flatMap((c) => c.items).map((i) => [i.id, i]),
  );
  for (const raw of items as BotItem[]) {
    const item = all.get(String(raw?.item_id ?? ""));
    if (!item)
      throw new ApiError(
        404,
        "item_not_found",
        `Item fora do cardápio. Opções disponíveis: ${alternatives(menu, null).join(", ") || "nenhuma agora"}.`,
      );
    if (!item.available)
      throw new ApiError(
        409,
        "sold_out",
        `${item.name} está esgotado. No lugar: ${alternatives(menu, item.id).join(", ") || "nada parecido agora"}.`,
      );
  }
  const categories = cartCategories(menu);
  requireValue(categories, "O cardápio não está disponível agora.");
  const catalog = validateCatalog({
    categories: categories!,
    fulfillment: {
      pickup: true,
      delivery: false,
      delivery_fee_cents: 0,
      minimum_cents: 0,
    },
  });
  const cart = linesToCartInput(
    catalog,
    (items as BotItem[]).map((raw) => ({
      item_id: String(raw.item_id),
      quantity: Number(raw.quantidade ?? 1),
      options: raw.escolhas ?? {},
      ...(raw.observacao ? { note: String(raw.observacao) } : {}),
    })),
  );
  Object.assign(cart, {
    fulfillment: ["pickup"],
    name: ["Cliente"],
    note: [String(note ?? "").slice(0, 300)],
  });
  const checked = validateCartOrder(catalog, cart);
  if (!checked.ok)
    throw new ApiError(
      400,
      "invalid_request",
      Object.values(checked.errors).join(" "),
    );
  return checked.order;
}

function summaryText(
  lines: OrderLine[],
  subtotal: number,
  deliveryFee: number | null,
  minimum: number,
) {
  const body = lines.map((line) => {
    const options = line.options.length
      ? ` (${line.options.map((o) => o.name).join(", ")})`
      : "";
    const note = line.note ? ` — ${line.note}` : "";
    return `${line.quantity}x ${line.name}${options}${note}: ${money(line.total_cents)}`;
  });
  return [
    "Confira o pedido:",
    ...body,
    "",
    `Subtotal: ${money(subtotal)}`,
    ...(deliveryFee !== null
      ? [
          deliveryFee
            ? `Entrega: ${money(deliveryFee)}, se for para entregar`
            : "Entrega sem taxa",
        ]
      : []),
    ...(minimum && subtotal < minimum
      ? [`Pedido mínimo: ${money(minimum)}.`]
      : []),
  ].join("\n");
}

/**
 * Ação "pedido_montar" (ferramenta pedido_montar do bot): confere a loja e
 * os itens, calcula com o cardápio e manda ao cliente o resumo com Confirmar
 * e Cancelar. Ao modelo volta só o que foi entendido, sem valores.
 */
export async function botDraft(
  ctx: ModuleContext,
  actor: Actor,
  c: Conversation,
  data: any,
  requestId: string,
) {
  mayActOn(actor, c);
  const cfg = await config(ctx);
  const store = await storeSituation(ctx, cfg, now());
  if (!store.open)
    throw new ApiError(
      409,
      "store_closed",
      store.message || "A loja está fechada agora.",
    );
  const order = await priced(ctx, data.itens, data.observacao);
  if (order.subtotal_cents < cfg.minimum_cents)
    throw new ApiError(
      409,
      "below_minimum",
      "O pedido ainda não atinge o mínimo da loja: sugira mais itens ao cliente.",
    );
  const id = uid();
  const draft: CatalogDraft & {
    draft_id: string;
    items: unknown;
    note_in: unknown;
  } = {
    lines: order.lines as OrderLine[],
    item_count: order.item_count,
    subtotal_cents: order.subtotal_cents,
    note: order.note,
    row_id: id,
    source: "bot",
    draft_id: id,
    items: data.itens,
    note_in: data.observacao ?? "",
  };
  await saveChat(
    ctx,
    c,
    "confirm",
    null,
    { draft, draft_id: id },
    DRAFT_MINUTES,
  );
  try {
    await ctx.sendInteractive(
      c,
      {
        type: "button",
        body: summaryText(
          draft.lines,
          draft.subtotal_cents,
          cfg.delivery ? cfg.delivery_fee_cents : null,
          cfg.minimum_cents,
        ),
        buttons: [
          { id: `pedido:bot:sim:${id}`, title: "Confirmar pedido" },
          { id: `pedido:bot:nao:${id}`, title: "Cancelar" },
        ],
      },
      { key: `bot-draft:${requestId}`, purpose: "order" },
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  return {
    rascunho: id,
    estado: "aguardando_confirmacao_do_cliente",
    itens: draft.lines.map((l) => ({
      nome: l.name,
      quantidade: l.quantity,
      escolhas: l.options.map((o) => o.name),
    })),
    aviso:
      "O cliente recebeu o resumo com os valores e o botão Confirmar pedido. Não informe preços nem diga que o pedido foi feito.",
  };
}

/** Confirmar ou Cancelar do resumo (botão, ou CONFIRMAR/CANCELAR digitado). */
export async function answerDraft(
  ctx: ModuleContext,
  c: Conversation,
  yes: boolean,
  draftId: string | undefined,
  key: string,
): Promise<boolean> {
  const chat = await one(
    ctx.env,
    "SELECT * FROM pedido_chats WHERE conversation_id=? AND profile_id=?",
    c.id,
    ctx.profile,
  );
  const data = chat ? JSON.parse(chat.data || "{}") : {};
  if (
    !chat ||
    chat.step !== "confirm" ||
    !draftId ||
    data.draft_id !== draftId ||
    chat.expires_at <= now()
  ) {
    await tell(
      ctx,
      c,
      "Este pedido não está mais aberto. Peça de novo, por favor.",
      key,
    );
    return true;
  }
  if (!yes) {
    await clearChat(ctx, c.id);
    await tell(ctx, c, "Tudo bem, não fiz o pedido.", key);
    return true;
  }
  const cfg = await config(ctx);
  const store = await storeSituation(ctx, cfg, now());
  if (!store.open) {
    await clearChat(ctx, c.id);
    await tell(ctx, c, store.message || "A loja está fechada agora.", key);
    return true;
  }
  const draft = data.draft as CatalogDraft & {
    items: unknown;
    note_in: unknown;
  };
  // Preço e disponibilidade de novo, na hora de confirmar.
  let fresh;
  try {
    fresh = await priced(ctx, draft.items, draft.note_in);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await clearChat(ctx, c.id);
    await tell(ctx, c, `Não deu para confirmar: ${error.message}`, key);
    return true;
  }
  if (fresh.subtotal_cents !== draft.subtotal_cents) {
    await clearChat(ctx, c.id);
    await tell(
      ctx,
      c,
      `Os valores do cardápio mudaram desde o resumo (agora ${money(fresh.subtotal_cents)}). Peça de novo para eu montar com os valores atuais.`,
      key,
    );
    return true;
  }
  await proceedDraft(ctx, c, draft, `bot:${draftId}`, "Pedido confirmado");
  return true;
}

// ---------------------------------------------------------------------------
// Desconto com aprovação da equipe

/** Pedido desta conversa que ainda aceita desconto: antes de pagar. */
const discountable = (ctx: ModuleContext, conversationId: string) =>
  one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE profile_id=? AND conversation_id=? AND status='awaiting_payment' AND payment_status IN ('choosing','failed') ORDER BY number DESC LIMIT 1",
    ctx.profile,
    conversationId,
  );

const limitCents = (order: any, percent: number) =>
  Math.floor((order.subtotal_cents * percent) / 100);

/**
 * Ação "pedido_desconto" (ferramenta pedido_pedir_desconto do bot): pede à
 * equipe um desconto no pedido desta conversa que ainda espera o pagamento.
 * O cartão é montado aqui com dados do servidor; o texto do bot vai à parte,
 * como não verificado. Não concede nada.
 */
export async function requestDiscount(
  ctx: ModuleContext,
  actor: Actor,
  c: Conversation,
  data: any,
) {
  mayActOn(actor, c);
  const cfg = await config(ctx);
  if (!cfg.discount.max_percent)
    throw new ApiError(
      409,
      "discount_off",
      "Esta loja não trabalha com desconto pelo WhatsApp.",
    );
  const order = await discountable(ctx, c.id);
  if (!order)
    throw new ApiError(
      409,
      "no_order",
      "Não há pedido desta conversa esperando o pagamento: o desconto só vale antes de pagar.",
    );
  if (order.discount_cents)
    throw new ApiError(
      409,
      "discount_done",
      `O pedido nº ${order.number} já tem desconto.`,
    );
  const view = orderView(order);
  // O histórico ampliado depende do vínculo central, nunca do telefone digitado.
  const customer = await routineCustomer(ctx, c);
  const past = await all(
    ctx.env,
    `SELECT number,total_cents,discount_cents,created FROM pedido_orders WHERE profile_id=? AND id<>? AND status='delivered' AND (${customer ? "contact_id=? OR (contact_id IS NULL AND conversation_id=?)" : "conversation_id=?"}) ORDER BY created DESC LIMIT 5`,
    ctx.profile,
    order.id,
    ...(customer ? [customer.ref.contactId, c.id] : [c.id]),
  );
  const max = limitCents(order, cfg.discount.max_percent);
  const teamMax = limitCents(order, cfg.discount.team_max_percent);
  const approval = await ctx.requestApproval(c, {
    kind: "desconto",
    ref: order.id,
    title: `Desconto no pedido nº ${order.number}`,
    fields: [
      {
        key: "itens",
        label: "Itens",
        value: view.lines
          .map(
            (l) =>
              `${l.quantity}x ${l.name}${l.options.length ? ` (${l.options.map((o) => o.name).join(", ")})` : ""}`,
          )
          .join("; ")
          .slice(0, 500),
      },
      {
        key: "total",
        label: "Total de tabela",
        value: `${money(order.total_cents)}${order.delivery_fee_cents ? ` (com ${money(order.delivery_fee_cents)} de entrega)` : ""}`,
      },
      {
        key: "ultimos",
        label: "Últimos pedidos",
        value: past.length
          ? past
              .map(
                (p) =>
                  `nº ${p.number} em ${dateTimeOf(p.created).split(" às ")[0]}: ${money(p.total_cents)}${p.discount_cents ? ` (com ${money(p.discount_cents)} de desconto)` : ""}`,
              )
              .join("; ")
          : "Primeiro pedido entregue deste cliente.",
      },
      {
        key: "limite",
        label: "Limite",
        value:
          cfg.discount.approvers === "team"
            ? `Equipe até ${cfg.discount.team_max_percent}% (${money(teamMax)}); administrador até ${cfg.discount.max_percent}% (${money(max)}).`
            : `Até ${cfg.discount.max_percent}% do subtotal (${money(max)}).`,
      },
    ],
    approvers:
      cfg.discount.approvers === "team"
        ? { access: "pedido" }
        : { admin: true },
    adjust: {
      label: "Desconto (R$)",
      type: "money",
      min: 0.01,
      max: max / 100,
    },
    ttlMinutes: 30,
    modelSummary: data.observacao
      ? String(data.observacao).slice(0, 500)
      : null,
    botId: actor.via?.bot_id ?? null,
    runId: actor.via?.run_id ?? null,
    key: `desconto:${order.id}`,
  });
  return {
    pedido_de_aprovacao: approval.id,
    estado: "aguardando a equipe",
    aviso:
      "A equipe vai responder; o cliente recebe o resultado por aqui. Não prometa desconto nem valor.",
  };
}

/** Confere o pedido e o limite de quem decide; devolve o desconto em centavos. */
async function checkDiscount(
  ctx: ModuleContext,
  approval: any,
  decision: ApprovalDecision,
) {
  const cfg = await config(ctx);
  const order = await one(
    ctx.env,
    "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
    approval.ref_id,
    ctx.profile,
  );
  // Retomada de uma decisão que travou depois de aplicar (DECIDING_TTL,
  // src/approvals.ts): o desconto deste pedido de aprovação já entrou.
  if (order && order.discount_cents && (await appliedBy(ctx, order, approval)))
    return { order, cents: order.discount_cents as number, already: true };
  if (
    !order ||
    order.status !== "awaiting_payment" ||
    !["choosing", "failed"].includes(order.payment_status) ||
    order.discount_cents
  )
    throw new ApiError(
      409,
      "order_moved",
      "O pedido já seguiu para o pagamento ou o preparo: o desconto não entra mais. Recuse este pedido de aprovação.",
    );
  const cents = Math.round(Number(decision.value) * 100);
  requireValue(
    decision.value !== null && Number.isFinite(cents) && cents >= 1,
    "Informe o valor do desconto (R$).",
  );
  const admin =
    decision.actor?.kind === "user" && decision.actor.role === "admin";
  const percent = admin
    ? cfg.discount.max_percent
    : cfg.discount.team_max_percent;
  if (cents > limitCents(order, percent) || cents >= order.total_cents)
    throw new ApiError(
      403,
      "discount_limit",
      `Seu limite é ${percent}% do subtotal (${money(limitCents(order, percent))}).`,
    );
  return { order, cents, already: false };
}

/** O desconto do pedido foi aplicado por este pedido de aprovação. */
const appliedBy = async (ctx: ModuleContext, order: any, approval: any) =>
  !!(await one(
    ctx.env,
    // instr, não LIKE: o D1 recusa padrão de LIKE longo (mais de 50 bytes).
    "SELECT 1 FROM pedido_history WHERE profile_id=? AND order_id=? AND kind='edit' AND instr(note,?)>0",
    ctx.profile,
    order.id,
    `(pedido de aprovação ${approval.id}).`,
  ));

export const discountHooks = {
  async validate(
    ctx: ModuleContext,
    approval: any,
    decision: ApprovalDecision,
  ) {
    // Conceder desconto é decisão financeira: com a política do segundo fator
    // ("financial" ou "all"), quem aprova precisa da sessão confirmada.
    if (decision.actor) requireFinancialAal(decision.actor);
    await checkDiscount(ctx, approval, decision);
  },
  async decided(ctx: ModuleContext, approval: any, decision: ApprovalDecision) {
    if (decision.status === "handoff") return;
    const c = await ctx
      .conversation(approval.conversation_id)
      .catch(() => null);
    if (decision.status !== "approved") {
      const order = await one(
        ctx.env,
        "SELECT id,number,total_cents,discount_cents FROM pedido_orders WHERE id=? AND profile_id=?",
        approval.ref_id,
        ctx.profile,
      );
      // Uma aprovação que já aplicou o desconto e travou antes de fechar não
      // vira "não aprovou" ao vencer.
      if (order?.discount_cents && (await appliedBy(ctx, order, approval)))
        return;
      if (c && order)
        await tell(
          ctx,
          c,
          decision.status === "expired"
            ? `A equipe não respondeu a tempo sobre o desconto. O total do pedido nº ${order.number} continua ${money(order.total_cents)}.`
            : `A equipe não aprovou o desconto. O total do pedido nº ${order.number} continua ${money(order.total_cents)}.`,
          `discount:${approval.id}:${decision.status}`,
        );
      return;
    }
    const { order, cents, already } = await checkDiscount(
      ctx,
      approval,
      decision,
    );
    const at = now();
    if (!already) {
      // Desconto e histórico juntos (um lote): o histórico com o id do pedido
      // de aprovação é o que torna a retomada idempotente (appliedBy).
      const [applied] = await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          "UPDATE pedido_orders SET discount_cents=?,discount_by=?,total_cents=subtotal_cents+delivery_fee_cents-?,updated=? WHERE id=? AND profile_id=? AND status='awaiting_payment' AND payment_status IN ('choosing','failed') AND discount_cents=0",
        ).bind(cents, decision.actor!.id, cents, at, order.id, ctx.profile),
        ctx.env.DB.prepare(
          "INSERT INTO pedido_history(id,profile_id,order_id,kind,from_status,to_status,actor,note,created) SELECT ?,?,?,'edit',?,?,?,?,? WHERE changes()>0",
        ).bind(
          uid(),
          ctx.profile,
          order.id,
          order.status,
          order.status,
          decision.actor!.id,
          `Desconto de ${money(cents)} aprovado (pedido de aprovação ${approval.id}).`,
          at,
        ),
      ]);
      if (!applied.meta.changes)
        throw new ApiError(
          409,
          "order_moved",
          "O pedido mudou enquanto isso: atualize e decida de novo.",
        );
    }
    const fresh = await one(
      ctx.env,
      "SELECT * FROM pedido_orders WHERE id=? AND profile_id=?",
      order.id,
      ctx.profile,
    );
    await ctx.publish(
      "pedido.discount_applied",
      order.id,
      {
        order_id: order.id,
        number: order.number,
        discount_cents: cents,
        total_cents: fresh.total_cents,
        approval_id: approval.id,
        actor: decision.actor!.id,
        conversation_id: order.conversation_id,
      },
      { key: `discount:${order.id}` },
    );
    if (c) {
      await tell(
        ctx,
        c,
        `A equipe aprovou um desconto de ${money(cents)} no pedido nº ${order.number}. Novo total: ${money(fresh.total_cents)}.`,
        `discount:${approval.id}:approved`,
      );
      // Escolher a forma de pagamento é confirmar o novo total.
      await askPaymentAgain(ctx, c, fresh, `pay-question:${order.id}:discount`);
    }
  },
};
