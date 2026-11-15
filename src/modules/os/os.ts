// Ordem de Serviço (módulo "os"): ganchos e rotas. Regras em ./store.ts e
// ./model.ts; avisos de tempo em ./reminders.ts. Carregado por
// src/modules/runtime.ts. Uso: docs/ORDEM-DE-SERVICO.md.
import {
  ApiError,
  type Actor,
  type Conversation,
  requireValue,
} from "../../types";
import {
  onCommand,
  onConversationAction,
  onConversationTurn,
  onMenuChoice,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";
import { osSettings, validateOsSettings } from "./model";
import { runDue } from "./reminders";
import {
  changeStatus,
  createOrder,
  decide,
  handleQuoteReply,
  listOrders,
  loadOrder,
  orderHistory,
  orderView,
  saveQuote,
  sendQuote,
  trackText,
  updateOrder,
} from "./store";

// Resposta ao orçamento: lista Aprovar/Recusar (linha oficial), 1/2 (QR) ou
// APROVAR <nº>, antes do menu e do bot.
onConversationTurn("os", (ctx, c, turn) => handleQuoteReply(ctx, c, turn));

const clip = (value: unknown, max: number) =>
  Array.from(String(value ?? "").trim())
    .slice(0, max)
    .join("");

/** Link do passo web em que o cliente abre a ordem (item, problema, termos). */
export async function sendOpenForm(
  ctx: ModuleContext,
  c: Conversation,
  options: {
    trigger: "menu" | "agent" | "bot";
    actor: string;
    sourceKey: string;
  },
) {
  await ctx.requireEnabled();
  const cfg = osSettings(await ctx.settings());
  return ctx.openWebStep(c, {
    kind: "open",
    ref: null,
    trigger: options.trigger,
    actor: options.actor,
    sourceKey: options.sourceKey,
    ttlMinutes: 24 * 60,
    text: "Para abrir a ordem de serviço, informe o item e o problema neste link:",
    button: "Abrir ordem",
    spec: {
      title: "Abrir ordem de serviço",
      intro: "Termos do serviço:\n" + cfg.terms,
      fields: [
        {
          id: "item",
          type: "text",
          label: "Item ou equipamento",
          required: true,
          help: "Ex.: celular Samsung A54, notebook, bicicleta aro 29, terno.",
        },
        {
          id: "problem",
          type: "text",
          label: "O que aconteceu?",
          required: true,
          multiline: true,
        },
        {
          id: "terms",
          type: "accept",
          label: "Li e aceito os termos do serviço",
          required: true,
        },
      ],
      submit_label: "Abrir ordem",
      done_text:
        "Recebemos! O número da ordem de serviço chega na conversa do WhatsApp.",
      return_text: "Recebemos os dados da sua ordem de serviço.",
      ticket: "none",
    },
  });
}

/** Mesma regra dos formulários para enviar link ao cliente. */
function mayMessage(actor: Actor, c: Conversation) {
  const bot = actor.id.startsWith("bot:");
  requireValue(
    c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (bot && c.state === "ai"),
    "Assuma a conversa antes de enviar o link ao cliente.",
  );
  return actor.kind === "user" && !bot ? ("agent" as const) : ("bot" as const);
}

// ---------------------------------------------------------------------------
// Ganchos (carregados por src/modules/runtime.ts)

onSettingsSave("os", "service_orders", validateOsSettings);

// Item de menu "Abrir ordem de serviço": link do passo web.
onMenuChoice("os_open", async (ctx, c, _item, { rowId }) => {
  try {
    await sendOpenForm(ctx, c, {
      trigger: "menu",
      actor: "system",
      sourceKey: `menu:${rowId}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await ctx.sendMessage(
      c,
      {
        text: "Não foi possível abrir a ordem de serviço agora. Envie MENU para ver as opções.",
      },
      { key: `menu-unavailable:${rowId}` },
    );
  }
});

// Item de menu "Acompanhar ordem de serviço".
onMenuChoice("os_track", async (ctx, c, _item, { rowId }) => {
  await ctx.sendMessage(
    c,
    { text: await trackText(ctx, c) },
    { key: `track:${rowId}` },
  );
});

// Ação "Abrir ordem de serviço" na conversa: abre com os dados do atendente,
// ou, com send_form, manda o link para o cliente preencher.
onConversationAction(
  "os",
  "service_order",
  async (ctx, actor, c, data, { requestId }) => {
    if (data.send_form === true)
      return (
        await sendOpenForm(ctx, c, {
          trigger: mayMessage(actor, c),
          actor: actor.id,
          sourceKey: `action:${actor.id}:${requestId}`,
        })
      ).step;
    const { order } = await createOrder(ctx, {
      conversation: c,
      customer_name: data.customer_name,
      item: data.item,
      problem: data.problem,
      notes: data.notes,
      assignee: data.assignee,
      due_at: data.due_at,
      notify: data.notify,
      source: "agent",
      sourceKey: `action:${actor.id}:${requestId}`,
      actor: actor.id,
    });
    return orderView(order);
  },
);

// Cliente concluiu o link de abertura: a ordem nasce com os termos aceitos.
onWebStepCompleted("os", async (ctx, step, answers) => {
  if (step.kind !== "open") return;
  const c = await ctx.conversation(step.conversation_id);
  const cfg = osSettings(await ctx.settings());
  await createOrder(ctx, {
    conversation: c,
    item: clip(answers.item, 200) || "Não informado",
    problem: clip(answers.problem, 2000) || "Não informado",
    source: "customer",
    sourceKey: `web_step:${step.id}`,
    actor: "customer",
    terms: answers.terms === true ? cfg.terms : null,
  });
});

// Lembrete de retirada e ordens paradas (gancho periódico do núcleo).
onSchedule("os", async (ctx, { now }) => {
  await runDue(ctx, now);
});

// ---------------------------------------------------------------------------
// Rotas: /api/v1/profiles/:profile/service-orders…

onRead("os", "service-orders", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listOrders(ctx, query);
});

onRead("os", "service-orders/:id", async (ctx, actor, { params }) => {
  ctx.access(actor, "conversations:read");
  const order = await loadOrder(ctx, params.id);
  return orderView(order, await orderHistory(ctx, order.id));
});

onRoute("os", { method: "POST", path: "service-orders", op: "os.create" });
onCommand("os", "os.create", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const c =
    data.conversation_id !== undefined && data.conversation_id !== null
      ? await ctx.conversation(String(data.conversation_id), actor)
      : null;
  const { order } = await createOrder(ctx, {
    conversation: c,
    customer_name: data.customer_name,
    phone: data.phone,
    item: data.item,
    problem: data.problem,
    notes: data.notes,
    assignee: data.assignee,
    due_at: data.due_at,
    notify: data.notify,
    source:
      actor.kind === "user" && !actor.id.startsWith("bot:") ? "panel" : "api",
    sourceKey: `command:${actor.id}:${requestId}`,
    actor: actor.id,
  });
  return orderView(order);
});

onRoute("os", { method: "PATCH", path: "service-orders/:id", op: "os.update" });
onCommand("os", "os.update", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  return orderView(await updateOrder(ctx, order, data, actor.id));
});

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/status",
  op: "os.status",
});
onCommand("os", "os.status", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  return orderView(
    await changeStatus(ctx, order, data.status, actor.id, data.note),
  );
});

onRoute("os", {
  method: "PUT",
  path: "service-orders/:id/quote",
  op: "os.quote.save",
});
onCommand("os", "os.quote.save", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  return orderView(await saveQuote(ctx, order, data, actor.id));
});

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/quote/send",
  op: "os.quote.send",
});
onCommand("os", "os.quote.send", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  return orderView(
    await sendQuote(ctx, order, actor.id, { notify: data.notify !== false }),
  );
});

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/decision",
  op: "os.decide",
});
onCommand("os", "os.decide", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  const order = await loadOrder(ctx, data.id);
  return orderView(
    await decide(
      ctx,
      order,
      data.decision,
      actor.id,
      actor.kind === "user" ? "panel" : "api",
      data.note,
    ),
  );
});
