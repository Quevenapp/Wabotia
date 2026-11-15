// Mensalidade (módulo "mensalidade"): ganchos e rotas. Cadastros em
// ./store.ts; regras puras em ./model.ts. Carregado por
// src/modules/runtime.ts. Uso: docs/MENSALIDADE.md.
import { type Actor, now, requireValue } from "../../types";
import {
  filteredHandlers,
  moduleError,
  onConversationTurn,
  onMcpTool,
  onMenuChoice,
  onPaymentUpdated,
  onRoute,
  onSchedule,
  onSettingsSave,
  type ModuleContext,
} from "../api";
import {
  maskDocument,
  parseDocument,
  phoneDigits,
  validateMensalidadeSettings,
  withoutKeys,
} from "./model";

// Dados pessoais (documento, e-mail, telefones) só para aplicação com
// contacts:read, e observações só com notes:read, como no núcleo; pessoas da
// equipe veem. Toda rota de leitura e de escrita passa por este filtro.
const CONTACT_FIELDS = new Set([
  "document",
  "document_display",
  "payer_document",
  "email",
  "phones",
  "phone",
]);
const NOTE_FIELDS = new Set(["notes", "paid_note"]);
function visible(ctx: ModuleContext, actor: Actor, value: any) {
  if (actor.kind !== "app") return value;
  let out = value;
  if (!ctx.mayRead(actor, "contacts")) out = withoutKeys(out, CONTACT_FIELDS);
  if (!ctx.mayRead(actor, "notes")) out = withoutKeys(out, NOTE_FIELDS);
  return out;
}
const { onRead, onCommand, onConversationAction } = filteredHandlers(visible);
import { runDue } from "./due";
import { handleTurn, menuCopy, menuStatement, openInstallments } from "./chat";
import {
  addPayerPhone,
  createPayer,
  listPayers,
  loadPayer,
  payerByDocument,
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
  assertChargeable,
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
  isManager,
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

/**
 * Aceite de cobrança declarado pela equipe (`billing_consent: true`): abre
 * conversa na linha oficial e permite notificação paga em nome do cliente,
 * então só administrador, e com a evidência (`billing_consent_evidence`:
 * onde o cliente aceitou). Devolve a evidência, ou null sem aceite.
 */
function teamConsent(actor: Actor, data: any) {
  if (data?.billing_consent !== true) return null;
  manager(
    actor,
    "Somente administradores registram o aceite de cobrança do cliente.",
  );
  const evidence =
    typeof data.billing_consent_evidence === "string"
      ? data.billing_consent_evidence.trim()
      : "";
  if (Array.from(evidence).length < 5 || Array.from(evidence).length > 500)
    throw moduleError(
      400,
      "consent_evidence_required",
      "Informe onde o cliente aceitou receber cobranças pelo WhatsApp (billing_consent_evidence, de 5 a 500 caracteres).",
    );
  return evidence;
}

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
    // Cobrança antes da conversa: o aviso "sem linha oficial" só vale com a
    // Cobrança pronta.
    await assertChargeable(ctx, inst);
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
  // Lista de pagadores é cadastro de pessoas: aplicação precisa de
  // contacts:read (a busca por documento ou telefone também revelaria quem é
  // cliente).
  ctx.access(actor, "contacts:read");
  const list = await listPayers(ctx, query);
  // Na listagem, atendente vê o documento mascarado; completo no detalhe e
  // para administrador.
  if (actor.kind === "user" && actor.role !== "admin")
    return {
      ...list,
      data: list.data.map((payer: any) => ({
        ...payer,
        document: null,
        document_display: maskDocument(payer.document_display),
      })),
    };
  return list;
});

onRead(
  "mensalidade",
  "mensalidade/payers/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    ctx.access(actor, "contacts:read");
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
    // Documento → pagador é consulta de dado pessoal: aplicação precisa de
    // contacts:read.
    if (query.document || query.phone) ctx.access(actor, "contacts:read");
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
    // Trocar o documento muda quem o cliente prova ser: só administrador.
    if (Object.hasOwn(data || {}, "document")) manager(actor);
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
    // Telefone autorizado fala (e é atendido) em nome do pagador.
    manager(actor);
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

// ---------------------------------------------------------------------------
// Bot de IA: só o pagador da conversa (desta conversa ou do mesmo telefone),
// nunca outro telefone ou CPF/CNPJ citado no texto.

onRead(
  "mensalidade",
  "mensalidade/conversations/:id",
  async (ctx, actor, { params }) => {
    ctx.access(actor, "conversations:read");
    const c = await ctx.conversation(params.id, actor);
    const phone = ctx.verifiedPhone(c);
    return {
      situation: phone
        ? await situationByPhone(ctx.env, ctx.profile, phone)
        : null,
      open: (await openInstallments(ctx, c)).map((inst) => ({
        id: inst.id,
        plan_name: inst.plan_name,
        period_key: inst.period_key,
        amount_cents: inst.amount_cents,
        due_date: inst.due_date,
        status: inst.status,
      })),
    };
  },
);

// Segunda via pela conversa: POST /conversations/:id/actions
// {action:"mensalidade_copy", installment_id?}.
onConversationAction(
  "mensalidade",
  "mensalidade_copy",
  async (ctx, actor, c, data, { requestId }) => {
    requireValue(
      c.owner === actor.id ||
        (actor.kind === "user" && actor.role === "admin") ||
        (actor.id.startsWith("bot:") && c.state === "ai"),
      "Assuma a conversa antes de enviar a segunda via.",
    );
    const open = await openInstallments(ctx, c);
    const wanted =
      typeof data.installment_id === "string" ? data.installment_id : null;
    const target = wanted
      ? open.find((inst) => inst.id === wanted)
      : open.length === 1
        ? open[0]
        : null;
    if (wanted && !target)
      throw moduleError(
        404,
        "not_found",
        "Mensalidade em aberto não encontrada para o cliente desta conversa.",
      );
    if (!target)
      throw moduleError(
        409,
        open.length ? "installment_required" : "nothing_open",
        open.length
          ? "O cliente tem mais de uma mensalidade em aberto: informe installment_id (de mensalidade_situacao)."
          : "O cliente desta conversa não tem mensalidade em aberto.",
      );
    const inst = await loadInstallment(ctx, target.id);
    return installmentView(
      await resendCharge(ctx, inst, c, `segunda-via:${actor.id}:${requestId}`),
    );
  },
);

onMcpTool("mensalidade", {
  name: "mensalidade_situacao",
  description:
    "Situação do pagador da conversa (pelo telefone da conversa): em_dia, em_atraso ou sem_assinatura, com as mensalidades em aberto (id, plano, competência, valor, vencimento). Requer conversations:read.",
  input: { conversation_id: { type: "string" } },
  required: ["conversation_id"],
  call: (a, profile) => ({
    path: `/profiles/${profile}/mensalidade/conversations/${a.conversation_id}`,
  }),
});
onMcpTool("mensalidade", {
  name: "mensalidade_segunda_via",
  description:
    "Envia ao cliente da conversa a segunda via (Pix copia e cola ou link) de uma mensalidade em aberto dele. Com mais de uma em aberto, informe installment_id de mensalidade_situacao. Mensalidade de outro cliente: 404. Exige a conversa assumida pelo bot. Requer conversations:write.",
  input: {
    conversation_id: { type: "string" },
    installment_id: { type: "string" },
  },
  required: ["conversation_id"],
  write: true,
  call: (a, profile) => ({
    method: "POST",
    path: `/profiles/${profile}/conversations/${a.conversation_id}/actions`,
    body: {
      action: "mensalidade_copy",
      ...(a.installment_id ? { installment_id: a.installment_id } : {}),
    },
  }),
});

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
    // Valor e desconto diferentes do plano: só administrador (como a isenção).
    if (
      (data.amount_cents !== undefined && data.amount_cents !== null) ||
      (data.discount_cents !== undefined &&
        data.discount_cents !== null &&
        data.discount_cents !== 0)
    )
      manager(actor, "Somente administradores definem valor ou desconto.");
    // Documento de um pagador existente autoriza o telefone da assinatura
    // nele (vincular telefone): só administrador, se ainda não autorizado.
    if (!isManager(actor) && typeof data.document === "string") {
      const doc = parseDocument(data.document);
      const existing = doc ? await payerByDocument(ctx, doc.document) : null;
      if (existing) {
        const phone = phoneDigits(data.phone || c?.phone || "");
        const phones = await payerPhones(ctx, existing.id);
        if (!phone || !phones.some((p) => p.phone === phone))
          manager(
            actor,
            "Este CPF/CNPJ já tem pagador: somente administradores autorizam um telefone novo nele.",
          );
      }
    }
    const evidence = teamConsent(actor, data);
    // Só os campos do cadastro: nada de chave de origem (sourceKey) ou
    // opções internas vindas do corpo.
    const sub = await createSubscription(
      ctx,
      {
        conversation: c,
        plan_id: data.plan_id,
        customer_name: data.customer_name,
        phone: data.phone,
        amount_cents: data.amount_cents,
        discount_cents: data.discount_cents,
        due_day: data.due_day,
        start_date: data.start_date,
        end_date: data.end_date,
        notes: data.notes,
        payer_id: data.payer_id,
        document: data.document,
        payer_name: data.payer_name,
      },
      actor.id,
    );
    // Um administrador confirma, com a evidência, que o cliente aceitou
    // receber cobranças pelo WhatsApp.
    if (evidence)
      await consentFromTeam(
        ctx,
        sub,
        actor.kind === "app" ? "api" : "panel",
        actor.id,
        evidence,
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
    const evidence = teamConsent(actor, data);
    const result = await importSubscriptions(ctx, data.rows, actor.id);
    if (evidence)
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
          evidence,
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
    // Valor, desconto e plano mudam quanto se cobra: só administrador.
    if (
      ["amount_cents", "discount_cents", "plan_id"].some((key) =>
        Object.hasOwn(data || {}, key),
      )
    )
      manager(
        actor,
        "Somente administradores mudam valor, desconto ou plano da assinatura.",
      );
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
