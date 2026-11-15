// Mensalidade (módulo "mensalidade"): ganchos e rotas. Cadastros em
// ./store.ts; regras puras em ./model.ts. Carregado por
// src/modules/runtime.ts. Uso: docs/MENSALIDADE.md.
import { now } from "../../types";
import { onCommand, onRead, onRoute, onSchedule, onSettingsSave } from "../api";
import { validateMensalidadeSettings } from "./model";
import { runDue } from "./due";
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
    return installmentView(await payManually(ctx, inst, actor.id, data));
  },
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
    return subscriptionView(sub);
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
    return importSubscriptions(ctx, data.rows, actor.id);
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
