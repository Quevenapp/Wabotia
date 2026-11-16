// Pedidos do cliente que só a equipe concede: dispensa ou desconto numa
// mensalidade em aberto (ctx.requestApproval + onApproval, docs/MODULOS.md
// "Pedido de aprovação"). O bot só registra o pedido; o cartão é montado
// aqui com o que está no banco (plano, parcelas pagas e em aberto, atrasos),
// nunca com números do modelo, e só quem hoje pode isentar (administrador,
// regra do `waive`) decide. "Já paguei" e comprovante não mudam nada.
import { exec, one } from "../../db";
import { ApiError, type Actor, type Conversation, now } from "../../types";
import { moduleError, type ApprovalDecision, type ModuleContext } from "../api";
import { openInstallments } from "./chat";
import { resendCharge } from "./billing";
import { loadInstallment, waive } from "./installments";
import { dayLabel, money, periodLabel } from "./model";
import { cancelOpenCharge, manager } from "./store";

export type RequestKind = "dispensa" | "desconto";
export const REQUEST_KINDS: RequestKind[] = ["dispensa", "desconto"];

const BILLING = { notification: true, purpose: "billing" as const };
/** Prazo para a equipe decidir; vencido, a conversa vai para a fila. */
const TTL_MINUTES = 120;

const STATE_LABELS: Record<string, string> = {
  pending: "aguardando a equipe",
  deciding: "aguardando a equipe",
  approved: "aprovado pela equipe",
  declined: "não aprovado pela equipe",
  handoff: "um atendente assumiu a conversa",
  expired: "a equipe não respondeu a tempo; a conversa foi para um atendente",
};

const what = (kind: string) => (kind === "desconto" ? "desconto" : "dispensa");
const label = (inst: any) =>
  `${inst.plan_name ? inst.plan_name + " " : ""}${periodLabel(inst.period_key)}`;
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Parcela com o nome do plano e do cliente (para o cartão e as mensagens). */
async function installmentWithPlan(ctx: ModuleContext, id: string) {
  const row = await one(
    ctx.env,
    "SELECT i.*,p.name AS plan_name,s.customer_name,s.start_date AS sub_start FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE i.id=? AND i.profile_id=?",
    id,
    ctx.profile,
  );
  if (!row) throw moduleError(404, "not_found", "Mensalidade não encontrada.");
  return row;
}

/** Histórico da assinatura da parcela, lido do banco para o cartão. */
async function history(ctx: ModuleContext, subscriptionId: string) {
  // Atraso: paga depois do dia do vencimento (horário de Brasília).
  return one(
    ctx.env,
    `SELECT
       count(*) AS total,
       coalesce(sum(status='paid'),0) AS paid,
       coalesce(sum(CASE WHEN status='paid' THEN amount_cents END),0) AS paid_cents,
       coalesce(sum(status IN ('open','overdue')),0) AS open,
       coalesce(sum(CASE WHEN status IN ('open','overdue') THEN amount_cents END),0) AS open_cents,
       coalesce(sum(status='overdue'),0) AS overdue,
       coalesce(sum(status='paid' AND date(paid_at/1000,'unixepoch','-3 hours')>due_date),0) AS late,
       coalesce(max(CASE WHEN status='paid' THEN julianday(date(paid_at/1000,'unixepoch','-3 hours'))-julianday(due_date) END),0) AS max_late_days,
       coalesce(sum(status='waived'),0) AS waived,
       coalesce(sum(discount_cents>0),0) AS discounted
     FROM mensalidade_installments WHERE subscription_id=?`,
    subscriptionId,
  );
}

/** As linhas do cartão: tudo vem do banco, nada do texto do cliente. */
async function card(ctx: ModuleContext, inst: any) {
  const h = await history(ctx, inst.subscription_id);
  const lateDays = Math.max(0, Math.round(Number(h.max_late_days) || 0));
  return [
    { key: "cliente", label: "Cliente", value: inst.customer_name || "" },
    { key: "plano", label: "Plano", value: inst.plan_name || "sem plano" },
    {
      key: "parcela",
      label: "Parcela",
      value: `${periodLabel(inst.period_key)} · ${money(inst.amount_cents)} · ${inst.status === "overdue" ? "venceu" : "vence"} em ${dayLabel(inst.due_date)}`,
    },
    ...(inst.discount_cents
      ? [
          {
            key: "desconto_atual",
            label: "Desconto já dado nesta parcela",
            value: money(inst.discount_cents),
          },
        ]
      : []),
    {
      key: "desde",
      label: "Assinatura desde",
      value: dayLabel(inst.sub_start) || "—",
    },
    {
      key: "pagas",
      label: "Parcelas pagas",
      value: h.paid ? `${h.paid} (${money(h.paid_cents)})` : "nenhuma",
    },
    {
      key: "abertas",
      label: "Em aberto",
      value: `${h.open} (${money(h.open_cents)})${h.overdue ? `, ${plural(h.overdue, "vencida", "vencidas")}` : ""}`,
    },
    {
      key: "atrasos",
      label: "Histórico de atrasos",
      value: h.late
        ? `${plural(h.late, "paga com atraso", "pagas com atraso")}, maior atraso ${plural(lateDays, "dia", "dias")}`
        : "nenhuma paga com atraso",
    },
    {
      key: "concessoes",
      label: "Dispensas e descontos anteriores",
      value: `${plural(h.waived, "dispensa", "dispensas")}, ${plural(h.discounted, "parcela com desconto", "parcelas com desconto")}`,
    },
  ];
}

/**
 * Ação da conversa `mensalidade_pedido` ({kind, installment_id?,
 * observacao?}): registra o pedido do cliente e manda o cartão à equipe.
 * A parcela é sempre uma em aberto do cliente da conversa (desta conversa ou
 * do telefone verificado); id de outra: 404. Repetir devolve o mesmo pedido.
 */
export async function requestFromCustomer(
  ctx: ModuleContext,
  actor: Actor,
  c: Conversation,
  data: any,
) {
  const kind = data?.kind as RequestKind;
  if (!REQUEST_KINDS.includes(kind))
    throw moduleError(
      400,
      "invalid_request",
      "Tipo do pedido: dispensa ou desconto.",
    );
  // Só o bot que atende o cliente (ou integração) abre o pedido, na conversa
  // individual em atendimento automático.
  if (actor.kind !== "app" || c.state !== "ai")
    throw moduleError(
      409,
      "not_bot_turn",
      "Pedido de dispensa ou desconto só pelo bot que atende o cliente.",
    );
  if (c.chat_type === "group")
    throw moduleError(409, "group", "Pedido só em conversa individual.");
  const open = await openInstallments(ctx, c, { link: false });
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
  const inst = await installmentWithPlan(ctx, target.id);
  const approval = await ctx.requestApproval(c, {
    kind,
    ref: inst.id,
    title: `${kind === "desconto" ? "Desconto" : "Dispensa"} na mensalidade ${label(inst)} de ${inst.customer_name || "cliente"}`,
    fields: await card(ctx, inst),
    // Quem hoje isenta parcela (waive): administrador.
    approvers: { admin: true },
    adjust:
      kind === "desconto"
        ? {
            label: "Desconto (R$)",
            type: "money",
            min: 0.01,
            max: Math.max(0.01, (inst.amount_cents - 1) / 100),
          }
        : null,
    ttlMinutes: TTL_MINUTES,
    modelSummary: typeof data.observacao === "string" ? data.observacao : null,
    botId: actor.via?.bot_id ?? null,
    runId: actor.via?.run_id ?? null,
    key: `${kind}:${inst.id}`,
  });
  const status =
    approval.status === "pending" && approval.expires_at <= now()
      ? "expired"
      : approval.status;
  return {
    pedido: approval.id,
    tipo: kind,
    mensalidade: label(inst),
    estado: STATE_LABELS[status] || status,
    aviso:
      status === "pending" || status === "deciding"
        ? "Nada foi concedido: diga ao cliente que a equipe vai analisar e responder por aqui."
        : "Este pedido já foi analisado; não abra outro.",
  };
}

/** Ajuste aprovado, em centavos (o cartão mostra reais). */
const discountCents = (value: number | null) =>
  value === null ? null : Math.round(value * 100);

/** Antes de aprovar: quem decide pode isentar, e a parcela segue em aberto. */
export async function validateRequest(
  ctx: ModuleContext,
  approval: any,
  decision: ApprovalDecision,
) {
  if (!decision.actor)
    throw moduleError(403, "admin_required", "Decisão sem pessoa.");
  // Mesma regra do waive: administrador e, como a decisão é financeira, o
  // segundo fator pela política da instalação (manager → requireFinancialAal,
  // src/mfa.ts). O ator da rota de decisão é a sessão da pessoa, com o aal.
  manager(
    decision.actor,
    "Somente administradores dispensam ou dão desconto em mensalidade.",
  );
  const inst = await loadInstallment(ctx, approval.ref_id);
  // Gancho repetido depois de aplicar: segue para avisar o cliente.
  if (approval.kind === "dispensa" && inst.status === "waived") return;
  if (approval.kind === "desconto" && inst.discount_ref === approval.id) return;
  if (!["open", "overdue"].includes(inst.status))
    throw moduleError(
      409,
      "installment_not_payable",
      "A mensalidade não está mais em aberto (paga, isenta ou cancelada): recuse o pedido ou assuma a conversa.",
    );
  if (approval.kind === "desconto") {
    const cents = discountCents(decision.value);
    if (cents === null)
      throw moduleError(400, "invalid_request", "Informe o valor do desconto.");
    if (!(cents >= 1 && cents < inst.amount_cents))
      throw moduleError(
        400,
        "invalid_request",
        `Desconto de R$ 0,01 até ${money(inst.amount_cents - 1)}. Para o valor inteiro, use a dispensa.`,
      );
  }
}

/** Aplica a dispensa (waive), idempotente: repetir não isenta de novo. */
async function applyWaiver(ctx: ModuleContext, approval: any, actor: Actor) {
  const inst = await loadInstallment(ctx, approval.ref_id);
  if (inst.status === "waived") return inst;
  return waive(ctx, inst, actor.id, {
    note: `Dispensa pedida pelo cliente e aprovada pela equipe (pedido ${approval.id}).`,
  });
}

/** Aplica o desconto, uma vez por pedido; a cobrança aberta cai antes. */
async function applyDiscount(
  ctx: ModuleContext,
  approval: any,
  actor: Actor,
  cents: number,
) {
  let inst = await loadInstallment(ctx, approval.ref_id);
  if (inst.discount_ref === approval.id) return inst;
  // Cobrança aberta com o valor antigo: cancelada antes de baixar o valor.
  // Se não cancelou (o cliente pode ter acabado de pagar), não aplica.
  await cancelOpenCharge(ctx, inst);
  inst = await loadInstallment(ctx, inst.id);
  if (inst.payment_id && inst.payment_status === "created")
    throw new ApiError(
      409,
      "charge_open",
      "A cobrança aberta desta mensalidade não pôde ser cancelada (pode ter sido paga agora). Tente de novo em instantes.",
    );
  const at = now();
  const result = await exec(
    ctx.env,
    "UPDATE mensalidade_installments SET amount_cents=amount_cents-?,discount_cents=discount_cents+?,discount_ref=?,updated=? WHERE id=? AND profile_id=? AND status IN ('open','overdue') AND amount_cents>? AND coalesce(discount_ref,'')<>?",
    cents,
    cents,
    approval.id,
    at,
    inst.id,
    ctx.profile,
    cents,
    approval.id,
  );
  if (!result.meta.changes)
    throw moduleError(
      409,
      "installment_not_payable",
      "A mensalidade não está mais em aberto ou o desconto passa do valor.",
    );
  await ctx.publish(
    "mensalidade.discounted",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      period_key: inst.period_key,
      discount_cents: cents,
      amount_cents: inst.amount_cents - cents,
      by: actor.id,
      approval_id: approval.id,
    },
    { key: `${inst.id}:discount:${approval.id}` },
  );
  return loadInstallment(ctx, inst.id);
}

/** Efeito da decisão (onApproval): aplica e avisa o cliente na conversa. */
export async function requestDecided(
  ctx: ModuleContext,
  approval: any,
  decision: ApprovalDecision,
) {
  const c = await ctx.conversation(approval.conversation_id);
  const inst = await installmentWithPlan(ctx, approval.ref_id);
  const say = (text: string, suffix: string) =>
    ctx.sendMessage(
      c,
      { text },
      { key: `aprovacao:${approval.id}:${suffix}`, ...BILLING },
    );
  if (decision.status === "approved" && decision.actor) {
    if (approval.kind === "dispensa") {
      await applyWaiver(ctx, approval, decision.actor);
      await say(
        `A equipe aprovou a dispensa da mensalidade ${label(inst)}. Você não precisa pagar esta parcela.`,
        "aprovado",
      );
      return;
    }
    const cents = discountCents(decision.value)!;
    const fresh = await applyDiscount(ctx, approval, decision.actor, cents);
    await say(
      `A equipe aprovou um desconto de ${money(fresh.discount_cents)} na mensalidade ${label(inst)}. Novo valor: ${money(fresh.amount_cents)}.`,
      "aprovado",
    );
    // O código novo, já com o desconto; sem cobrança configurada, o cliente
    // pede a segunda via ou fala com a equipe.
    try {
      await resendCharge(ctx, fresh, c, `aprovacao:${approval.id}:cobranca`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    return;
  }
  if (decision.status === "declined") {
    await say(
      `A equipe analisou o pedido de ${what(approval.kind)} da mensalidade ${label(inst)} e não pôde aprovar desta vez. Se quiser, peça para falar com um atendente.`,
      "recusado",
    );
    return;
  }
  if (decision.status === "expired") {
    await say(
      "A equipe não conseguiu responder ao seu pedido a tempo. Vou passar sua conversa para um atendente.",
      "vencido",
    );
    await ctx.handoff(c, {
      summary: `${approval.title}: pedido sem resposta da equipe.`,
      flags: [`pedido de ${what(approval.kind)} sem resposta`],
      key: `aprovacao:${approval.id}:vencido`,
    });
  }
  // handoff: o núcleo já passou a conversa a quem tocou em Assumir.
}
