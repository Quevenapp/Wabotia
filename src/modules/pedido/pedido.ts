// Pedido (módulo "pedido"): registra rotas, comandos e ganchos no núcleo
// (src/modules/api.ts). Cardápio em ./menu.ts; regras da loja em ./model.ts
// e ./store.ts. Uso: docs/PEDIDO.md.
import {
  ApiError,
  type Actor,
  type Conversation,
  now,
  requireValue,
} from "../../types";
import {
  onCommand as registerCommand,
  onConversationAction,
  onConversationTurn,
  onInboundContent,
  onMcpTool,
  onMenuChoice,
  onPaymentUpdated,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  onWebStepValidate,
  type ModuleContext,
} from "../api";
import type { CartOrder } from "../../web-cart";
import { validatePedidoConfig } from "./model";
import { overview, setPause } from "./store";
import {
  changeStatus,
  loadOrder,
  openOrdersFor,
  orderView,
  paymentUpdated,
  visibleOrder,
  visibleOrders,
} from "./orders";
import {
  board,
  createFromApi,
  listOrders,
  markPaid,
  orderDetail,
  setMethod,
  updateOrder,
} from "./manage";
import { runDue } from "./schedule";
import { orderDeliverySlip, orderTicket } from "./ticket";
import {
  cartCompleted,
  cartValidate,
  catalogOrder,
  pedidoTurn,
  sendCart,
  trackOrders,
} from "./chat";
import {
  deleteCategory,
  deleteGroup,
  deleteItem,
  getItem,
  loadMenu,
  saveCategory,
  saveGroup,
  saveItem,
  saveMenuImages,
  setItemAvailability,
  setOptionAvailability,
} from "./menu";

const MODULE = "pedido";

/**
 * Ator de outro módulo (ctx.moduleActor; a Entrega em nome do entregador):
 * só leva o pedido de entrega a "Saiu para entrega" ou "Entregue". Nunca
 * cancela, nunca mexe em pagamento, cadastro ou loja (revisão A, credencial
 * por QR, item 3).
 */
export const MODULE_ACTOR_STATUSES = ["out_for_delivery", "delivered"];
function refuseModuleActor(op: string, actor: Actor, data: any) {
  if (!actor.module) return;
  if (op === "pedido.status" && MODULE_ACTOR_STATUSES.includes(data?.status))
    return;
  throw new ApiError(
    403,
    "module_forbidden",
    `O módulo ${actor.module.id} só pode marcar o pedido como saiu para entrega ou entregue.`,
  );
}

/** onCommand do núcleo com a trava do ator de módulo em todo comando. */
const onCommand: typeof registerCommand = (moduleId, op, handler) =>
  registerCommand(moduleId, op, (ctx, actor, data, request) => {
    refuseModuleActor(op, actor, data);
    return handler(ctx, actor, data, request);
  });

// ---------------------------------------------------------------------------
// WhatsApp

async function unavailable(
  ctx: ModuleContext,
  c: Conversation,
  error: unknown,
  key: string,
) {
  if (!(error instanceof ApiError)) throw error;
  try {
    await ctx.sendMessage(
      c,
      {
        text: "O cardápio não está disponível agora. Envie MENU para ver as opções.",
      },
      { key: `menu-unavailable:${key}` },
    );
  } catch (inner) {
    if (!(inner instanceof ApiError)) throw inner;
  }
}

// Item de menu "Cardápio": imagens do cardápio e o botão Fazer pedido.
onMenuChoice("pedido_cardapio", async (ctx, c, _item, { rowId }) => {
  try {
    await sendCart(ctx, c, {
      trigger: "menu",
      actor: "system",
      sourceKey: `menu:${rowId}`,
      images: true,
    });
  } catch (error) {
    await unavailable(ctx, c, error, rowId);
  }
});

// Item de menu "Acompanhar pedido".
onMenuChoice("pedido_acompanhar", async (ctx, c, _item, { rowId }) => {
  await trackOrders(ctx, c, rowId);
});

// Respostas do cliente: forma de pagamento, troco, retirada/entrega, endereço.
onConversationTurn(MODULE, (ctx, c, turn) => pedidoTurn(ctx, c, turn));

// Carrinho do catálogo da Meta (content.order) com retailer_id cadastrado.
onInboundContent(MODULE, "order", (ctx, c, content, { rowId }) =>
  catalogOrder(ctx, c, content, rowId),
);

// Antes de concluir: loja fechada ou item esgotado recusa na própria página.
onWebStepValidate(MODULE, async (ctx, step, answers) =>
  step.page === "cart" && step.kind === "cart"
    ? cartValidate(ctx, step, answers as CartOrder)
    : null,
);

// Página de carrinho concluída: o pedido validado vira pedido numerado. O
// passo já está concluído aqui; uma falha não pode derrubar a página.
onWebStepCompleted(MODULE, async (ctx, step, answers) => {
  if (step.page !== "cart" || step.kind !== "cart") return;
  try {
    await cartCompleted(ctx, step, answers as CartOrder);
  } catch (error) {
    console.error(
      JSON.stringify({
        component: "pedido",
        web_step: step.id,
        error: String((error as Error)?.message || error).slice(0, 300),
      }),
    );
    try {
      await ctx.sendMessage(
        await ctx.conversation(step.conversation_id),
        {
          text: "Recebemos o seu pedido, mas não conseguimos confirmar o número agora. A equipe vai falar com você por aqui.",
        },
        { key: `cart-error:${step.id}`, notification: true },
      );
    } catch {
      // A nota interna do passo web já registra o pedido para a equipe.
    }
  }
});

// Cobrança do pedido: pago vai para o preparo; vencida cancela o pedido.
onPaymentUpdated(MODULE, (ctx, payment, { previous }) =>
  paymentUpdated(ctx, payment, previous),
);

/** Quem age na conversa: o responsável, um administrador ou o bot que atende. */
function mayActOn(actor: Actor, c: Conversation) {
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de enviar o pedido ao cliente.",
  );
  return bot;
}

// Ação "Montar pedido para este cliente": envia o link do carrinho
// (POST /conversations/:id/actions {"action":"pedido_link"}).
onConversationAction(
  MODULE,
  "pedido_link",
  async (ctx, actor, c, _data, { requestId }) => {
    const bot = mayActOn(actor, c);
    requireValue(
      c.chat_type !== "group",
      "Envie pela conversa direta do cliente.",
    );
    const sent = await sendCart(ctx, c, {
      trigger: bot ? "bot" : "agent",
      actor: actor.id,
      sourceKey: `action:${actor.id}:${requestId}`,
      images: false,
    });
    return {
      sent: sent.sent,
      reason: sent.reason,
      web_step: sent.step,
    };
  },
);

// ---------------------------------------------------------------------------
// Pedidos: quadro da cozinha, lista, detalhe e mudanças pela equipe.

onRead(MODULE, "pedido/board", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return visibleOrders(ctx, actor, await board(ctx, now()));
});
onRead(MODULE, "pedido/orders", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return visibleOrders(
    ctx,
    actor,
    await listOrders(ctx, ctx.safeQuery(actor, query)),
  );
});
onRead(MODULE, "pedido/orders/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return visibleOrders(ctx, actor, await orderDetail(ctx, params.id));
});
// Comanda: dados do estabelecimento e do pedido, e o texto em colunas.
onRead(
  MODULE,
  "pedido/orders/:id/ticket",
  async (ctx, actor, { params, query }) => {
    ctx.access(actor, "conversations:read");
    return orderTicket(ctx, params.id, query, actor);
  },
);

// Via de entrega: comanda + QR do entregador (módulo Entrega).
onRoute(MODULE, {
  method: "POST",
  path: "pedido/orders/:id/delivery-slip",
  op: "pedido.delivery_slip",
});
onCommand(MODULE, "pedido.delivery_slip", (ctx, actor, data, { requestId }) =>
  orderDeliverySlip(ctx, actor, data, requestId),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/orders",
  op: "pedido.order.create",
});
onCommand(
  MODULE,
  "pedido.order.create",
  async (ctx, actor, data, { requestId }) =>
    visibleOrders(ctx, actor, await createFromApi(ctx, actor, data, requestId)),
);

onRoute(MODULE, {
  method: "PATCH",
  path: "pedido/orders/:id",
  op: "pedido.order.update",
});
onCommand(MODULE, "pedido.order.update", async (ctx, actor, data) =>
  visibleOrders(ctx, actor, await updateOrder(ctx, actor, data)),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/orders/:id/status",
  op: "pedido.status",
});
onCommand(MODULE, "pedido.status", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  if (actor.module && order.fulfillment !== "delivery")
    throw new ApiError(
      403,
      "module_forbidden",
      `O módulo ${actor.module.id} só muda pedidos de entrega.`,
    );
  return visibleOrder(
    ctx,
    actor,
    orderView(
      await changeStatus(ctx, order, data.status, actor.id, {
        note: data.note,
        reason: data.reason,
        notify: data.notify,
      }),
    ),
  );
});

onRoute(MODULE, {
  method: "POST",
  path: "pedido/orders/:id/paid",
  op: "pedido.payment.paid",
});
onCommand(MODULE, "pedido.payment.paid", async (ctx, actor, data) =>
  visibleOrders(ctx, actor, await markPaid(ctx, actor, data)),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/orders/:id/payment",
  op: "pedido.payment.method",
});
onCommand(MODULE, "pedido.payment.method", async (ctx, actor, data) =>
  visibleOrders(ctx, actor, await setMethod(ctx, actor, data)),
);

// Pedidos sem pagamento no prazo e pedidos parados (gancho periódico).
onSchedule(MODULE, async (ctx, { now: at }) => {
  await runDue(ctx, at);
});

// ---------------------------------------------------------------------------
// Regras da loja: chave "pedido" de PUT /settings (administrador) e a pausa
// manual, que qualquer pessoa da equipe aciona.

onSettingsSave(MODULE, "pedido", validatePedidoConfig);

// GET /profiles/:profile/pedido: regras, loja aberta ou fechada, pagamentos.
onRead(MODULE, "pedido", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return overview(ctx, now());
});

onRoute(MODULE, {
  method: "POST",
  path: "pedido/store/pause",
  op: "pedido.store.pause",
});
onCommand(MODULE, "pedido.store.pause", (ctx, actor, data) =>
  setPause(ctx, actor, data),
);

// ---------------------------------------------------------------------------
// Cardápio: leitura para a equipe e as integrações; cadastro pelo
// administrador; esgotado/disponível por qualquer pessoa da equipe.

onRead(MODULE, "pedido/menu", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return loadMenu(ctx);
});
onRead(MODULE, "pedido/items/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  return getItem(ctx, params.id);
});

onRoute(MODULE, {
  method: "POST",
  path: "pedido/categories",
  op: "pedido.category.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/categories/:id",
  op: "pedido.category.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/categories/:id",
  op: "pedido.category.delete",
});
onCommand(MODULE, "pedido.category.save", (ctx, actor, data) =>
  saveCategory(ctx, actor, data),
);
onCommand(MODULE, "pedido.category.delete", (ctx, actor, data) =>
  deleteCategory(ctx, actor, data.id),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/items",
  op: "pedido.item.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/items/:id",
  op: "pedido.item.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/items/:id",
  op: "pedido.item.delete",
});
onRoute(MODULE, {
  method: "POST",
  path: "pedido/items/:id/availability",
  op: "pedido.item.availability",
});
onCommand(MODULE, "pedido.item.save", (ctx, actor, data) =>
  saveItem(ctx, actor, data),
);
onCommand(MODULE, "pedido.item.delete", (ctx, actor, data) =>
  deleteItem(ctx, actor, data.id),
);
onCommand(MODULE, "pedido.item.availability", (ctx, actor, data) =>
  setItemAvailability(ctx, actor, data),
);

onRoute(MODULE, {
  method: "POST",
  path: "pedido/groups",
  op: "pedido.group.save",
});
onRoute(MODULE, {
  method: "PUT",
  path: "pedido/groups/:id",
  op: "pedido.group.save",
});
onRoute(MODULE, {
  method: "DELETE",
  path: "pedido/groups/:id",
  op: "pedido.group.delete",
});
onRoute(MODULE, {
  method: "POST",
  path: "pedido/groups/:id/availability",
  op: "pedido.group.availability",
});
onCommand(MODULE, "pedido.group.save", (ctx, actor, data) =>
  saveGroup(ctx, actor, data),
);
onCommand(MODULE, "pedido.group.delete", (ctx, actor, data) =>
  deleteGroup(ctx, actor, data.id),
);
onCommand(MODULE, "pedido.group.availability", (ctx, actor, data) =>
  setOptionAvailability(ctx, actor, data),
);

onRoute(MODULE, {
  method: "PUT",
  path: "pedido/menu-images",
  op: "pedido.images.save",
});
onCommand(MODULE, "pedido.images.save", (ctx, actor, data) =>
  saveMenuImages(ctx, actor, data),
);

// ---------------------------------------------------------------------------
// Ferramentas MCP para bots (núcleo: onMcpTool). Viram chamadas à API v1 com
// a chave do bot; permissões e 409 module_disabled valem como na API.

onMcpTool(MODULE, {
  name: "pedido_cardapio",
  description:
    "Cardápio da área: categorias, itens com preço em centavos, esgotados (available=false) e grupos de adicionais com mínimo e máximo. Para o cliente pedir, use pedido_enviar_carrinho. Requer conversations:read.",
  input: {},
  call: (_a, profile) => ({ path: `/profiles/${profile}/pedido/menu` }),
});
// Só o cliente da conversa: o bot não consulta por outro telefone, número de
// pedido ou nome citado no texto (a equipe usa a API e o painel para isso).
onMcpTool(MODULE, {
  name: "pedido_consultar",
  description:
    "Pedidos em andamento do cliente da conversa (desta conversa ou do mesmo telefone): número, estado, itens, total e pagamento. Requer conversations:read.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/pedido/conversations/${a.conversation_id}`,
  }),
});
onRead(MODULE, "pedido/conversations/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  const c = await ctx.conversation(params.id, actor);
  // Ferramenta do bot: sem telefone, endereço nem notas (conferência N-8).
  return ctx.botView(actor, {
    data: (await openOrdersFor(ctx, c)).map((o) =>
      visibleOrder(ctx, actor, orderView(o)),
    ),
  });
});
onMcpTool(MODULE, {
  name: "pedido_enviar_carrinho",
  description:
    "Envia ao cliente da conversa o link do carrinho (botão Fazer pedido). Com a loja fechada, o cliente recebe o horário e sent=false. Exige a conversa assumida pelo bot. Requer conversations:write.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  write: true,
  describe: async () =>
    "Enviar o link do carrinho para você escolher os itens e fazer o pedido.",
  call: (a, profile) => ({
    method: "POST",
    path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`,
    body: { action: "pedido_link" },
  }),
});
