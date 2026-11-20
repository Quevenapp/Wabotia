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
  onMcpTool,
  onMenuChoice,
  onPaymentUpdated,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
  onSettingsChange,
  onWebStepValidate,
  onWebStepBeforeComplete,
  onWebStepCompleted,
  type ModuleContext,
} from "../api";
import { one } from "../../db";
import { json } from "../../types";
import { osSettings, validateOsSettings } from "./model";
import { runDue } from "./reminders";
import {
  changeStatus,
  createOrder,
  decide,
  handleQuoteReply,
  listOrders,
  orderHistory,
  orderViewForActor,
  visibleOrder,
  ordersOfCustomer,
  saveQuote,
  sendQuote,
  trackText,
  updateOrder,
  reopenQuote,
  validateQuoteLink,
  completeQuoteLink,
} from "./store";
import { createOrderCharge, orderPaymentUpdated, paymentsView, recordManualReceipt } from "./commercial/receipts";

import { validateWorkTypes, validateVocabulary, validateWorkTypeChanges, validateServiceObjectTypes, validateOs2AiAccess } from "./validation";
import { customOpenForm, openingAnswers } from "./forms";
import { resolveWorkType, authorizedOrder } from "./public";
import { customerProjection, mayReadSensitive } from "./privacy";
import { registerMotorRoutes, motorMutationKey, replayOrderMutation } from "./motor-routes";
import { handleStageReply } from "./stage-replies";
import { registerCustomerProvider } from "../../customer/ports";
import { workCustomerProvider, enrichConfirmedWorkCustomer } from "./customer-provider";
import { registerWorkCommercial, requireCommercialWriter } from "./commercial/routes";
import { isObjectOpeningWebStep } from "../hooks";
import { openObjectForm, prepareObjectWebStepCompletion, resumeObjectWebStepCompletion } from "./os2-ports";

registerCustomerProvider("os", workCustomerProvider);
registerWorkCommercial();

// Resposta ao orçamento: lista Aprovar/Recusar (linha oficial), 1/2 (QR) ou
// APROVAR <nº>, antes do menu e do bot.
onConversationTurn("os", async (ctx, c, turn) => await handleStageReply(ctx, c, turn) || handleQuoteReply(ctx, c, turn));

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
    type_id?: string;
  },
) {
  await ctx.requireEnabled();
  const type = await resolveWorkType(ctx, options.type_id);
  if (type.kind === "custom" && type.object_type_id) return openObjectForm(ctx, c, type, options);
  if (type.kind === "custom") return customOpenForm(ctx, c, type, options);
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
      // O aviso com o número da ordem (createOrder) é o único retorno.
      return_message: "module",
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
onSettingsSave("os", "os_work_types", validateWorkTypes);
onSettingsSave("os", "os_object_types", validateServiceObjectTypes);
onSettingsSave("os", "os2_ai_access", validateOs2AiAccess);
onSettingsSave("os", "os_vocabulary", validateVocabulary);
onSettingsChange("os", validateWorkTypeChanges);
registerMotorRoutes();

// Item de menu "Abrir ordem de serviço": link do passo web.
onMenuChoice("os_open", async (ctx, c, item, { rowId }) => {
  try {
    await sendOpenForm(ctx, c, {
      trigger: "menu",
      actor: "system",
      sourceKey: `menu:${rowId}`,
      type_id: item.type_id as string | undefined,
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
onMenuChoice("os_track", async (ctx, c, item, { rowId }) => {
  await ctx.sendMessage(
    c,
    { text: await trackText(ctx, c, (item.type_id as string | undefined) ?? "service_order") },
    { key: `track:${rowId}` },
  );
});

// Ação "Abrir ordem de serviço" na conversa: abre com os dados do atendente,
// ou, com send_form, manda o link para o cliente preencher.
onConversationAction(
  "os",
  "service_order",
  async (ctx, actor, c, data, { requestId }) => {
    // Abrir a OS avisa o cliente: dono da conversa, administrador ou bot em
    // atendimento, como para mandar o link (revisão B9).
    const trigger = mayMessage(actor, c);
    if (data.send_form === true)
      return (
        await sendOpenForm(ctx, c, {
          trigger,
          actor: actor.id,
          sourceKey: `action:${actor.id}:${requestId}`,
          type_id: data.type_id,
        })
      ).step;
    const { order } = await createOrder(ctx, {
      conversation: c,
      type_id: data.type_id,
      object: data.object,
      contact_id: data.contact_id,
      authority: actor,
      extra: data.extra,
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
    await enrichConfirmedWorkCustomer(ctx, actor, order, data.customer, `os:customer:action:${actor.id}:${requestId}`);
    return orderViewForActor(ctx, actor, order);
  },
);

onWebStepBeforeComplete("os", (ctx, step, answers, options) =>
  prepareObjectWebStepCompletion(ctx, step, answers, options),
);

onWebStepValidate("os", async (ctx, step, answers) => {
  if (step.kind === "quote") return validateQuoteLink(ctx, step);
  if (isObjectOpeningWebStep(step)) return;
  if (step.kind !== "open" || !step.ref_id) return;
  try { await openingAnswers(ctx, step, answers); }
  catch (error) { if (error instanceof ApiError) return error.message; throw error; }
});

// Cliente concluiu o link de abertura: a ordem nasce com os termos aceitos.
onWebStepCompleted("os", async (ctx, step, answers) => {
  // OS3: resposta ao orçamento pelo link (aprovar ou recusar com motivo).
  if (step.kind === "quote") return completeQuoteLink(ctx, step, answers);
  if (step.kind !== "open") return;
  if (isObjectOpeningWebStep(step)) return resumeObjectWebStepCompletion(ctx, step);
  const c = await ctx.conversation(step.conversation_id);
  const fixed = await openingAnswers(ctx, step, answers);
  const cfg = osSettings(await ctx.settings());
  const original = !fixed ? await one(ctx.env, "SELECT spec FROM web_steps WHERE profile_id=? AND id=?", ctx.profile, step.id) : null;
  const shownTerms = json(original?.spec, {}).intro?.replace(/^Termos do serviço:\n/, "") ?? cfg.terms;
  await createOrder(ctx, {
    conversation: c,
    item: clip(answers.item, 200) || "Não informado",
    problem: clip(answers.problem, 2000) || "Não informado",
    source: "customer",
    sourceKey: `web_step:${step.id}`,
    actor: "customer",
    terms: answers.terms === true ? shownTerms : null,
    ...(fixed ?? {}),
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
  const page = await listOrders(ctx, ctx.safeQuery(actor, query), actor);
  return page;
});

onRead(
  "os",
  "service-orders/conversation/:id",
  async (ctx, actor, { params, query }) => {
    ctx.access(actor, "conversations:read");
    const c = await ctx.conversation(params.id, actor);
    // Ferramenta do bot: sem telefone nem notas (conferência N-8).
    return ctx.botView(actor, {
      data: (await ordersOfCustomer(ctx, c, query.open === "1", query.type_id)).map((view) =>
        view.type_id === "service_order" ? visibleOrder(ctx, actor, view) : customerProjection(visibleOrder(ctx, actor, view)),
      ),
    });
  },
);

onRead("os", "service-orders/:id", async (ctx, actor, { params, query }) => {
  ctx.access(actor, "conversations:read");
  const { row: order, type } = await authorizedOrder(ctx, actor, params.id);
  const view = await orderViewForActor(ctx, actor, order,
    query.history === "none" ? undefined : await orderHistory(ctx, order.id));
  // Compatibilidade: metadados autorizados do snapshot; valores apenas na rota privada.
  if (await mayReadSensitive(ctx, actor)) view.fields = type.fields;
  return view;
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
    type_id: data.type_id,
    object: data.object,
    contact_id: data.contact_id,
    authority: actor,
    extra: data.extra,
    customer_name: data.customer_name,
    phone: data.phone,
    item: data.item,
    problem: data.problem,
    notes: data.notes,
    assignee: data.assignee,
    due_at: data.due_at,
    // Quem não atende a conversa abre a OS sem avisar o cliente (B9).
    notify: c && !ctx.mayMessage(actor, c) ? false : data.notify,
    source:
      actor.kind === "user" && !actor.id.startsWith("bot:") ? "panel" : "api",
    sourceKey: `command:${actor.id}:${requestId}`,
    actor: actor.id,
  });
  await enrichConfirmedWorkCustomer(ctx, actor, order, data.customer, `os:customer:command:${actor.id}:${requestId}`);
  return orderViewForActor(ctx, actor, order);
});

onRoute("os", { method: "PATCH", path: "service-orders/:id", op: "os.update" });
onCommand("os", "os.update", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.update", requestId);
  const replay = await replayOrderMutation(ctx, actor, data.id, key);
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  return orderViewForActor(ctx, actor, await updateOrder(ctx, order, data, actor.id, key));
});

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/status",
  op: "os.status",
});
onCommand("os", "os.status", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.status", requestId);
  // Aplicação que não atende a conversa muda o estado sem avisar o cliente
  // (segunda conferência, B9).
  const notify = await ctx.mayNotify(actor, order.conversation_id ?? null);
  const replay = await replayOrderMutation(ctx, actor, data.id, key, notify);
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  return orderViewForActor(ctx, actor,
    await changeStatus(ctx, order, data.status, actor.id, data.note, {
      notify, mutationKey: key,
    }));
});

onRoute("os", {
  method: "PUT",
  path: "service-orders/:id/quote",
  op: "os.quote.save",
});
onCommand("os", "os.quote.save", async (ctx, actor, data, { requestId }) => {
  requireCommercialWriter(actor);
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.quote.save", requestId);
  const replay = await replayOrderMutation(ctx, actor, data.id, key, data.notify !== false && await ctx.mayNotify(actor, order.conversation_id));
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  return orderViewForActor(ctx, actor,
    await saveQuote(ctx, order, data, actor.id, key, { notify: await ctx.mayNotify(actor, order.conversation_id),
      human: actor.kind === "user" && !actor.id.startsWith("bot:") }));
});

// OS3: reabrir o orçamento aprovado, com motivo no histórico.
onRoute("os", { method: "POST", path: "service-orders/:id/quote/reopen", op: "os.quote.reopen" });
onCommand("os", "os.quote.reopen", async (ctx, actor, data, { requestId }) => {
  requireCommercialWriter(actor);
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.quote.reopen", requestId);
  const replay = await replayOrderMutation(ctx, actor, data.id, key, false);
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  return orderViewForActor(ctx, actor, await reopenQuote(ctx, order, data, actor.id, key));
});

// OS3: cobrança e recebimento (docs/ORDEM-DE-SERVICO.md, "Cobrança e recebimento").
onRead("os", "service-orders/:id/payments", (ctx, actor, { params }) => paymentsView(ctx, actor, params.id));
onRoute("os", { method: "POST", path: "service-orders/:id/receipts", op: "os.receipt.create" });
onCommand("os", "os.receipt.create", (ctx, actor, data, { requestId }) =>
  recordManualReceipt(ctx, actor, data.id, data, requestId));
onRoute("os", { method: "POST", path: "service-orders/:id/charges", op: "os.charge.create" });
onCommand("os", "os.charge.create", (ctx, actor, data, { requestId }) =>
  createOrderCharge(ctx, actor, data.id, data, requestId));
onPaymentUpdated("os", (ctx, payment) => orderPaymentUpdated(ctx, payment));

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/quote/send",
  op: "os.quote.send",
});
onCommand("os", "os.quote.send", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.quote.send", requestId);
  const replay = await replayOrderMutation(ctx, actor, data.id, key, data.notify !== false && await ctx.mayNotify(actor, order.conversation_id));
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  const notify =
    data.notify !== false &&
    (await ctx.mayNotify(actor, order.conversation_id ?? null));
  return orderViewForActor(ctx, actor,
    await sendQuote(ctx, order, actor.id, { notify, mutationKey: key }));
});

onRoute("os", {
  method: "POST",
  path: "service-orders/:id/decision",
  op: "os.decide",
});
onCommand("os", "os.decide", async (ctx, actor, data, { requestId }) => {
  ctx.access(actor, "conversations:write");
  const { row: order } = await authorizedOrder(ctx, actor, data.id, { write: true });
  const key = motorMutationKey(actor, "os.decide", requestId);
  const replay = await replayOrderMutation(ctx, actor, data.id, key, data.notify !== false && await ctx.mayNotify(actor, order.conversation_id));
  if (replay) return orderViewForActor(ctx, actor, replay.row);
  return orderViewForActor(ctx, actor,
    await decide(
      ctx,
      order,
      data.decision,
      actor.id,
      actor.kind === "user" ? "panel" : "api",
      data.note,
      { mutationKey: key, notify: await ctx.mayNotify(actor, order.conversation_id), quote_version: data.quote_version,
        ...(data.detail !== undefined ? { detail: data.detail } : {}) },
    ));
});

// ---------------------------------------------------------------------------
// Ferramentas MCP para bots (núcleo: onMcpTool).

// Só o cliente da conversa: o bot não consulta por outro telefone, número de
// ordem ou nome citado no texto (a equipe usa a API e o painel para isso).
onMcpTool("os", {
  name: "os_situacao",
  description:
    "Situação das ordens de serviço do contato da conversa: número, item, estado, orçamento e próximos passos. open=true só as abertas. Requer conversations:read.",
  input: {
    conversation_id: { type: "string" },
    open: { type: "boolean" },
  },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/service-orders/conversation/${a.conversation_id}`,
    query: { open: a.open ? "1" : undefined },
  }),
});

onMcpTool("os", {
  name: "os_objetos",
  description: "Consulta os objetos do titular confirmado da conversa, inclusive sem ordens abertas. Não usa placa, telefone ou nome como prova de propriedade.",
  input: {
    conversation_id: { type: "string" },
    type_id: { type: "string" },
    cursor: { type: "string" },
  },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/service-orders/conversation/${a.conversation_id}/objects`,
    query: { type_id: a.type_id, cursor: a.cursor },
  }),
});
