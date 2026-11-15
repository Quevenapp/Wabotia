// Mensalidade (módulo "mensalidade"): ganchos e rotas. Cadastros em
// ./store.ts; regras puras em ./model.ts. Carregado por
// src/modules/runtime.ts. Uso: docs/MENSALIDADE.md.
import { now } from "../../types";
import {
  moduleError,
  onCommand,
  onConversationTurn,
  onMenuChoice,
  onPaymentUpdated,
  onRead,
  onRoute,
  onSchedule,
  onSettingsSave,
} from "../api";
import { validateMensalidadeSettings } from "./model";
import { runDue } from "./due";
import { handleTurn, menuCopy, menuStatement } from "./chat";
import {
  addPayerPhone,
  createPayer,
  listPayers,
  loadPayer,
  payerPhones,
  payerView,
  removePayerPhone,
  updatePayer,
} from "./payers";
import {
  situationByDocument,
  situationByPayer,
  situationByPhone,
} from "./public";
import {
  consentFromTeam,
  conversationFor,
  paymentUpdated,
  resendCharge,
  sendReceipt,
} from "./billing";
import {
  delinquents,
  generateInstallments,
  listInstallments,
  loadInstallment,
  markOverdue,
  payManually,
  summary,
  waive,
} from "./installments";
import {
  createPlan,
  createSubscription,
  deletePlan,
  importSubscriptions,
  listPlans,
  listSubscriptions,
  loadSubscription,
  manager,
  setSubscriptionStatus,
  installmentView,
  subscriptionDetail,
  subscriptionView,
  updatePlan,
  updateSubscription,
} from "./store";

onSettingsSave("mensalidade", "mensalidade", validateMensalidadeSettings);

// Parcelas, vencidas e avisos (gancho periódico do núcleo).
onSchedule("mensalidade", async (ctx, tick) => {
  await runDue(ctx, tick.now);
});

// ---------------------------------------------------------------------------
// Parcelas: /api/v1/profiles/:profile/mensalidade/installments…

onRead(
  "mensalidade",
  "mensalidade/installments",
  async (ctx, actor, { query }) => {
    ctx.access(actor, "conversations:read");
    return listInstallments(ctx, query);
  },
);

onRead(
  "mensalidade",
  "mensalidade/installments/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    return installmentView(await loadInstallment(ctx, params.id));
  },
);

onRead("mensalidade", "mensalidade/summary", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return summary(ctx, query);
});

onRead("mensalidade", "mensalidade/delinquents", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return delinquents(ctx);
});

// Baixa manual (pagou em dinheiro): administrador ou integração.
onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/installments/:id/pay",
  op: "mensalidade.installment.pay",
});
onCommand(
  "mensalidade",
  "mensalidade.installment.pay",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    const inst = await loadInstallment(ctx, data.id);
    const paid = await payManually(ctx, inst, actor.id, data);
    // Comprovante ao cliente, a menos que notify=false.
    if (data.notify !== false) await sendReceipt(ctx, paid.id);
    return installmentView(paid);
  },
);

// Reenviar cobrança: o Pix/link que ainda vale ou uma cobrança nova.
onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/installments/:id/charge",
  op: "mensalidade.installment.charge",
});
onCommand(
  "mensalidade",
  "mensalidade.installment.charge",
  async (ctx, actor, data, { requestId }) => {
    ctx.access(actor, "conversations:write");
    const inst = await loadInstallment(ctx, data.id);
    const c = await conversationFor(ctx, {
      id: inst.subscription_id,
      phone: inst.phone,
      conversation_id: inst.conversation_id,
    });
    if (!c)
      throw moduleError(
        409,
        "no_conversation",
        "Não há conversa no WhatsApp com o telefone desta assinatura. O cliente precisa escrever primeiro.",
      );
    return installmentView(
      await resendCharge(ctx, inst, c, `reenvio:${actor.id}:${requestId}`),
    );
  },
);

// ---------------------------------------------------------------------------
// Pagadores: /api/v1/profiles/:profile/mensalidade/payers…

onRead("mensalidade", "mensalidade/payers", async (ctx, actor, { query }) => {
  ctx.access(actor, "conversations:read");
  return listPayers(ctx, query);
});

onRead(
  "mensalidade",
  "mensalidade/payers/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    const payer = await loadPayer(ctx, params.id);
    const subs = await listSubscriptions(ctx, {
      payer_id: payer.id,
      limit: "200",
    });
    const situation = await situationByPayer(ctx.env, ctx.profile, payer.id);
    return payerView(payer, await payerPhones(ctx, payer.id), {
      subscriptions: subs.data,
      situation: {
        status: situation.status,
        open_installment: situation.open_installment,
        grace_days: situation.grace_days,
      },
    });
  },
);

// GET mensalidade/situation?phone=…|document=…: em_dia, em_atraso ou
// sem_assinatura (404 sem pagador).
onRead(
  "mensalidade",
  "mensalidade/situation",
  async (ctx, actor, { query }) => {
    ctx.access(actor, "conversations:read");
    const found = query.document
      ? await situationByDocument(ctx.env, ctx.profile, query.document, {
          phone: query.phone || null,
        })
      : query.phone
        ? await situationByPhone(ctx.env, ctx.profile, query.phone)
        : (() => {
            throw moduleError(
              400,
              "invalid_request",
              "Informe phone ou document.",
            );
          })();
    if (!found)
      throw moduleError(
        404,
        "payer_not_found",
        "Nenhum pagador com esse dado.",
      );
    return found;
  },
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/payers",
  op: "mensalidade.payer.create",
});
onCommand(
  "mensalidade",
  "mensalidade.payer.create",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const payer = await createPayer(ctx, data, actor.id);
    return payerView(payer, await payerPhones(ctx, payer.id));
  },
);

onRoute("mensalidade", {
  method: "PATCH",
  path: "mensalidade/payers/:id",
  op: "mensalidade.payer.update",
});
onCommand(
  "mensalidade",
  "mensalidade.payer.update",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const payer = await updatePayer(
      ctx,
      await loadPayer(ctx, data.id),
      data,
      actor.id,
    );
    return payerView(payer, await payerPhones(ctx, payer.id));
  },
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/payers/:id/phones",
  op: "mensalidade.payer.phone_add",
});
onCommand(
  "mensalidade",
  "mensalidade.payer.phone_add",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const payer = await loadPayer(ctx, data.id);
    await addPayerPhone(ctx, payer, data.phone, data.label, actor.id);
    return payerView(payer, await payerPhones(ctx, payer.id));
  },
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/payers/:id/phones/remove",
  op: "mensalidade.payer.phone_remove",
});
onCommand(
  "mensalidade",
  "mensalidade.payer.phone_remove",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const payer = await loadPayer(ctx, data.id);
    await removePayerPhone(ctx, payer, data.phone, actor.id);
    return payerView(payer, await payerPhones(ctx, payer.id));
  },
);

// WhatsApp: consulta e segunda via. Nenhuma mensagem do cliente dá baixa.
onMenuChoice("mensalidade_list", (ctx, c, _item, { rowId }) =>
  menuStatement(ctx, c, rowId),
);
onMenuChoice("mensalidade_copy", (ctx, c, _item, { rowId }) =>
  menuCopy(ctx, c, rowId),
);
onConversationTurn("mensalidade", (ctx, c, turn) => handleTurn(ctx, c, turn));

// Confirmação do provedor (webhook assinado + consulta) e comprovante.
onPaymentUpdated("mensalidade", (ctx, payment, { previous }) =>
  paymentUpdated(ctx, payment, previous),
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/installments/:id/waive",
  op: "mensalidade.installment.waive",
});
onCommand(
  "mensalidade",
  "mensalidade.installment.waive",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    const inst = await loadInstallment(ctx, data.id);
    return installmentView(await waive(ctx, inst, actor.id, data));
  },
);

// Gera agora as parcelas que o gancho periódico geraria (sem avisos).
onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/generate",
  op: "mensalidade.generate",
});
onCommand("mensalidade", "mensalidade.generate", async (ctx, actor, data) => {
  ctx.access(actor, "conversations:write");
  manager(actor);
  const at = now();
  const created = await generateInstallments(
    ctx,
    at,
    typeof data.subscription_id === "string" ? data.subscription_id : undefined,
  );
  return { created, overdue: await markOverdue(ctx, at) };
});

// ---------------------------------------------------------------------------
// Planos: /api/v1/profiles/:profile/mensalidade/plans…

onRead("mensalidade", "mensalidade/plans", async (ctx, actor) => {
  ctx.access(actor, "conversations:read");
  return listPlans(ctx);
});

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/plans",
  op: "mensalidade.plan.create",
});
onCommand(
  "mensalidade",
  "mensalidade.plan.create",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    return createPlan(ctx, data, actor.id);
  },
);

onRoute("mensalidade", {
  method: "PATCH",
  path: "mensalidade/plans/:id",
  op: "mensalidade.plan.update",
});
onCommand(
  "mensalidade",
  "mensalidade.plan.update",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    return updatePlan(ctx, data.id, data);
  },
);

onRoute("mensalidade", {
  method: "DELETE",
  path: "mensalidade/plans/:id",
  op: "mensalidade.plan.delete",
});
onCommand(
  "mensalidade",
  "mensalidade.plan.delete",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    return deletePlan(ctx, data.id);
  },
);

// ---------------------------------------------------------------------------
// Assinaturas: /api/v1/profiles/:profile/mensalidade/subscriptions…

onRead(
  "mensalidade",
  "mensalidade/subscriptions",
  async (ctx, actor, { query }) => {
    ctx.access(actor, "conversations:read");
    return listSubscriptions(ctx, query);
  },
);

onRead(
  "mensalidade",
  "mensalidade/subscriptions/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    return subscriptionDetail(ctx, params.id);
  },
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/subscriptions",
  op: "mensalidade.subscription.create",
});
onCommand(
  "mensalidade",
  "mensalidade.subscription.create",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const c =
      data.conversation_id !== undefined && data.conversation_id !== null
        ? await ctx.conversation(String(data.conversation_id), actor)
        : null;
    const sub = await createSubscription(
      ctx,
      { ...data, conversation: c },
      actor.id,
    );
    // A equipe confirma que o cliente aceitou receber cobranças pelo WhatsApp.
    if (data.billing_consent === true)
      await consentFromTeam(
        ctx,
        sub,
        actor.kind === "app" ? "api" : "panel",
        actor.id,
      );
    return subscriptionView(await loadSubscription(ctx, sub.id));
  },
);

onRoute("mensalidade", {
  method: "POST",
  path: "mensalidade/subscriptions/import",
  op: "mensalidade.subscription.import",
});
onCommand(
  "mensalidade",
  "mensalidade.subscription.import",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    manager(actor);
    const result = await importSubscriptions(ctx, data.rows, actor.id);
    if (data.billing_consent === true)
      for (const sub of result.created)
        await consentFromTeam(
          ctx,
          {
            id: sub.id,
            phone: sub.customer.phone,
            conversation_id: sub.customer.conversation_id,
          },
          actor.kind === "app" ? "api" : "panel",
          actor.id,
        );
    return result;
  },
);

onRoute("mensalidade", {
  method: "PATCH",
  path: "mensalidade/subscriptions/:id",
  op: "mensalidade.subscription.update",
});
onCommand(
  "mensalidade",
  "mensalidade.subscription.update",
  async (ctx, actor, data) => {
    ctx.access(actor, "conversations:write");
    const sub = await loadSubscription(ctx, data.id);
    return subscriptionView(await updateSubscription(ctx, sub, data, actor.id));
  },
);

for (const [path, to] of [
  ["pause", "paused"],
  ["resume", "active"],
  ["end", "ended"],
] as const) {
  onRoute("mensalidade", {
    method: "POST",
    path: `mensalidade/subscriptions/:id/${path}`,
    op: `mensalidade.subscription.${path}`,
  });
  onCommand(
    "mensalidade",
    `mensalidade.subscription.${path}`,
    async (ctx, actor, data) => {
      ctx.access(actor, "conversations:write");
      manager(actor);
      const sub = await loadSubscription(ctx, data.id);
      return subscriptionView(
        await setSubscriptionStatus(ctx, sub, to, actor.id),
      );
    },
  );
}
