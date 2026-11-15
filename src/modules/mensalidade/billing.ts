// Mensalidade: cobrança e avisos ao cliente. A cobrança sai pela interface
// do núcleo (ctx.charge: Pix copia e cola ou link, docs/COBRANCA.md); a
// parcela só vira paga pelo webhook do provedor (onPaymentUpdated) ou pela
// baixa manual da equipe, nunca por mensagem do cliente.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, now } from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
import {
  DAY,
  addDays,
  dayLabel,
  daysBetween,
  endOfDay,
  mensalidadeSettings,
  money,
  periodLabel,
  stamp,
  today,
  type MensalidadeSettings,
} from "./model";
import { loadInstallment, paymentsReady } from "./installments";
import { announcePaid, notifyInstallmentRefunded } from "./listeners";
import { contractPaymentUpdated } from "./contracts";
import { cancelOpenCharge } from "./store";

const BATCH = 50;
/** Erros da cobrança que significam "não dá para cobrar por aqui agora". */
const SETUP_ERRORS = new Set([
  "payments_not_configured",
  "module_disabled",
  "origin_unknown",
]);

export type NoticeKind = "before" | "due" | "overdue";

interface ChargeResult {
  /** Cobrança criada agora (null quando reaproveitou ou falhou). */
  payment: Payment | null;
  created: boolean;
  /** Parcela relida (com o código e o link em uso). */
  inst: any;
  /** Código do erro da cobrança (payments_not_configured…). */
  error?: string;
  message?: string;
}

/** Plano + competência, até 120 caracteres (descrição da cobrança). */
export function chargeDescription(inst: any, kind: NoticeKind | "manual") {
  const base = `Mensalidade ${inst.plan_name ? inst.plan_name + " " : ""}${periodLabel(inst.period_key)}`;
  const tail =
    kind === "overdue"
      ? ` · venceu em ${dayLabel(inst.due_date)}`
      : ` · vence em ${dayLabel(inst.due_date)}`;
  return (
    Array.from(base)
      .slice(0, 120 - tail.length)
      .join("") + tail
  );
}

/** Texto do aviso; o código Pix e o link vão no fim, quando há. */
export function noticeText(inst: any, kind: NoticeKind, at: number) {
  const who = inst.customer_name
    ? `Olá, ${inst.customer_name.split(" ")[0]}! `
    : "";
  const what = `mensalidade ${inst.plan_name ? inst.plan_name + " " : ""}de ${periodLabel(inst.period_key)} (${money(inst.amount_cents)})`;
  if (kind === "overdue") {
    const days = daysBetween(inst.due_date, today(at));
    return `${who}A ${what} venceu em ${dayLabel(inst.due_date)} e está em aberto há ${days} ${days === 1 ? "dia" : "dias"}.`;
  }
  if (kind === "due" || inst.due_date === today(at))
    return `${who}A ${what} vence hoje (${dayLabel(inst.due_date)}).`;
  return `${who}A ${what} vence em ${dayLabel(inst.due_date)}.`;
}

const payLines = (inst: any) =>
  [
    inst.pay_url ? `Pagar: ${inst.pay_url}` : "",
    inst.pix_code ? `Pix copia e cola:\n${inst.pix_code}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * Conversa do cliente da assinatura: a guardada, ou a conversa individual
 * mais recente da área com o mesmo telefone (que passa a ser guardada).
 * O módulo não abre conversa nova: sem conversa, o aviso não sai.
 */
export async function conversationFor(
  ctx: ModuleContext,
  sub: { id: string; phone: string; conversation_id: string | null },
  options: { open?: boolean } = {},
): Promise<Conversation | null> {
  if (sub.conversation_id)
    try {
      const c = await ctx.conversation(sub.conversation_id);
      if (c.chat_type !== "group") return c;
    } catch {
      // Conversa apagada ou de outra área: procura pelo telefone.
    }
  if (!sub.phone) return null;
  // A conversa do telefone (com ou sem o 9); quem nunca escreveu ganha uma na
  // linha oficial, que só recebe notificação por modelo até responder.
  const found = await ctx.conversationByPhone(sub.phone, {
    open: options.open !== false,
  });
  if (!found || found.chat_type === "group") return null;
  await exec(
    ctx.env,
    "UPDATE mensalidade_subscriptions SET conversation_id=? WHERE id=? AND profile_id=?",
    found.id,
    sub.id,
    ctx.profile,
  );
  return found;
}

/**
 * Aceite de receber cobranças pelo WhatsApp (finalidade "billing"): sem ele,
 * avisos fora da janela de 24 horas esperam o cliente escrever. Registrado
 * na contratação pelo WhatsApp ("whatsapp") ou quando a equipe confirma o
 * aceite no cadastro ("panel", "contract", "api").
 */
export async function recordBillingConsent(
  ctx: ModuleContext,
  c: Conversation,
  source: string,
  evidence: Record<string, unknown>,
  key: string,
) {
  return ctx.recordConsent(c, { purpose: "billing", source, evidence, key });
}

/**
 * A equipe confirma no cadastro que o cliente aceitou receber cobranças pelo
 * WhatsApp (`billing_consent: true`): registra na conversa do telefone,
 * abrindo uma na linha oficial se ele nunca escreveu.
 */
export async function consentFromTeam(
  ctx: ModuleContext,
  sub: { id: string; phone: string; conversation_id: string | null },
  source: string,
  actor: string,
) {
  const c = await conversationFor(ctx, sub);
  if (!c) return null;
  return recordBillingConsent(
    ctx,
    c,
    source,
    { action: "subscription", subscription_id: sub.id, registered_by: actor },
    `assinatura:${sub.id}`,
  );
}

/** Notificação de cobrança: fora da janela, só com o aceite "billing". */
const BILLING = { notification: true, purpose: "billing" as const };

/** Avisa o administrador (evento) no máximo uma vez a cada 24 horas. */
export async function warnSetup(
  ctx: ModuleContext,
  reason: string,
  at: number,
) {
  const flag = await one(
    ctx.env,
    "SELECT updated FROM mensalidade_flags WHERE profile_id=? AND key='setup_warned'",
    ctx.profile,
  );
  if (flag && flag.updated > at - DAY) return false;
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_flags(profile_id,key,value,updated) VALUES(?,'setup_warned',?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    ctx.profile,
    reason,
    at,
  );
  await ctx.publish("mensalidade.setup_needed", ctx.profile, {
    reason,
    message:
      reason === "origin_unknown"
        ? "O endereço público do Wabotia ainda não é conhecido: abra o painel pelo endereço usado pelos clientes. Enquanto isso, as mensalidades saem sem Pix e a baixa é manual."
        : "A Cobrança não está configurada nesta área (Gestão → Cobrança). As mensalidades saem sem Pix e a baixa é manual.",
  });
  return true;
}

/**
 * Cobrança válida da parcela: reaproveita a que ainda vale por mais de uma
 * hora; senão cria outra (charge_seq + 1) pela interface do núcleo, que já
 * entrega o botão ou link e o código ao cliente. Devolve o erro da cobrança
 * quando ela não pode sair por aqui.
 */
export async function ensureCharge(
  ctx: ModuleContext,
  inst: any,
  c: Conversation,
  cfg: MensalidadeSettings,
  kind: NoticeKind | "manual",
  at: number,
  method: "pix" | "link" = cfg.method,
): Promise<ChargeResult> {
  if (
    inst.payment_id &&
    inst.payment_status === "created" &&
    (inst.payment_expires_at || 0) > at + 3600_000 &&
    (!inst.payment_method || inst.payment_method === method)
  )
    return { payment: null, created: false, inst };
  // Outra forma ou vencendo: a cobrança aberta é cancelada antes, para não
  // haver duas valendo ao mesmo tempo.
  await cancelOpenCharge(ctx, inst);
  const seq = inst.charge_seq + 1;
  // Vale até 7 dias depois do vencimento (ou de hoje, se já venceu).
  const base = inst.due_date > today(at) ? inst.due_date : today(at);
  const minutes = Math.round((endOfDay(addDays(base, 7)) - at) / 60000);
  let payment: Payment;
  try {
    payment = await ctx.charge(c, {
      method,
      amount_cents: inst.amount_cents,
      description: chargeDescription(inst, kind),
      ref: inst.id,
      sourceKey: `parcela:${inst.id}:${seq}`,
      expiresMinutes: Math.min(30 * 24 * 60, Math.max(60, minutes)),
      notification: true,
      // O comprovante é do módulo (sendReceipt): sem o "Pagamento recebido".
      receipt: false,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET notice_error=?,updated=? WHERE id=?",
      error.message,
      at,
      inst.id,
    );
    return {
      payment: null,
      created: false,
      inst,
      error: error.code,
      message: error.message,
    };
  }
  await exec(
    ctx.env,
    "UPDATE mensalidade_installments SET payment_id=?,payment_method=?,payment_status=?,payment_expires_at=?,pix_code=?,pay_url=?,charge_seq=?,charged_at=?,notice_error=NULL,updated=? WHERE id=?",
    payment.id,
    payment.method,
    payment.status,
    payment.expires_at,
    payment.pix_code,
    payment.url,
    seq,
    at,
    at,
    inst.id,
  );
  await ctx.publish(
    "mensalidade.charged",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      payment_id: payment.id,
      method: payment.method,
      amount_cents: payment.amount_cents,
      expires_at: payment.expires_at,
      conversation_id: c.id,
      kind,
    },
    { key: payment.id },
  );
  return { payment, created: true, inst: await loadInstallment(ctx, inst.id) };
}

/**
 * Um aviso ao cliente. Com a Cobrança configurada: cobrança nova (o núcleo
 * manda a mensagem com o valor, o botão e o código, numa só notificação fora
 * da janela) ou o código da cobrança que ainda vale, numa mensagem do módulo.
 * Sem Cobrança: o aviso com as instruções de pagamento e um alerta ao
 * administrador. Sem conversa para o telefone: registra e publica falha.
 */
export async function sendNotice(
  ctx: ModuleContext,
  inst: any,
  kind: NoticeKind,
  at: number,
  key: string,
) {
  const cfg = mensalidadeSettings(await ctx.settings());
  // Sem linha oficial para abrir a conversa, o aviso falha com o motivo, sem
  // derrubar a rodada periódica das outras parcelas.
  let c: Conversation | null = null;
  let reason = "Sem conversa no WhatsApp com o telefone desta assinatura.";
  try {
    c = await conversationFor(ctx, {
      id: inst.subscription_id,
      phone: inst.phone,
      conversation_id: inst.conversation_id,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    reason = error.message;
  }
  if (!c) {
    const message = reason;
    await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET notice_error=?,updated=? WHERE id=?",
      message,
      at,
      inst.id,
    );
    await ctx.publish("mensalidade.notice_failed", inst.id, {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      kind,
      reason: "no_conversation",
      message,
    });
    return { sent: false, reason: "no_conversation" };
  }
  let fallback: string | null = null;
  if (await paymentsReady(ctx)) {
    const result = await ensureCharge(ctx, inst, c, cfg, kind, at);
    if (!result.error && result.created) {
      await published(ctx, inst, kind, c, true, key);
      return { sent: true, charged: true };
    }
    if (!result.error) {
      await ctx.sendMessage(
        c,
        { text: `${noticeText(inst, kind, at)}\n\n${payLines(result.inst)}` },
        { key, ...BILLING },
      );
      await published(ctx, inst, kind, c, false, key);
      return { sent: true, charged: false };
    }
    if (!SETUP_ERRORS.has(result.error)) {
      await ctx.publish("mensalidade.notice_failed", inst.id, {
        installment_id: inst.id,
        subscription_id: inst.subscription_id,
        kind,
        reason: result.error,
        message: result.message,
      });
      return { sent: false, reason: result.error };
    }
    fallback = result.error;
  } else fallback = "payments_not_configured";
  await warnSetup(ctx, fallback, at);
  const how = cfg.manual_instructions
    ? cfg.manual_instructions
    : "Para pagar, fale com a nossa equipe.";
  await ctx.sendMessage(
    c,
    { text: `${noticeText(inst, kind, at)}\n\n${how}` },
    { key, ...BILLING },
  );
  await published(ctx, inst, kind, c, false, key);
  return { sent: true, charged: false, fallback };
}

const published = (
  ctx: ModuleContext,
  inst: any,
  kind: NoticeKind,
  c: Conversation,
  charged: boolean,
  key: string,
) =>
  ctx.publish(
    "mensalidade.notice_sent",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: inst.subscription_id,
      kind,
      charged,
      conversation_id: c.id,
    },
    { key },
  );

const SELECT_FULL =
  "SELECT i.*,s.customer_name,s.phone,s.conversation_id,s.status AS subscription_status,p.name AS plan_name FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id LEFT JOIN mensalidade_plans p ON p.id=s.plan_id";

/**
 * Avisos da rodada: antes do vencimento (com a cobrança), no dia e de atraso
 * (até `overdue_max`, a cada `overdue_every_days`). Cada parcela é marcada com
 * UPDATE condicionado antes do envio e a chave de envio vem da parcela e do
 * número do aviso: rodada repetida não repete nada. Parcelas retroativas
 * (geradas já vencidas) não recebem aviso automático.
 */
export async function runNotices(ctx: ModuleContext, at: number) {
  const cfg = mensalidadeSettings(await ctx.settings());
  const day = today(at);
  let before = 0,
    due = 0,
    overdue = 0;
  const upcoming = await all(
    ctx.env,
    `${SELECT_FULL} WHERE i.profile_id=? AND i.status='open' AND i.retroactive=0 AND i.notice_before_at IS NULL AND s.status='active' AND i.due_date>=? AND i.due_date<=? ORDER BY i.due_date,i.id LIMIT ?`,
    ctx.profile,
    day,
    addDays(day, cfg.days_before),
    BATCH,
  );
  for (const inst of upcoming) {
    // No próprio dia, o aviso de antes também conta como o do dia.
    const claimed = await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET notice_before_at=?,notice_due_at=CASE WHEN due_date=? THEN ? ELSE notice_due_at END,updated=? WHERE id=? AND notice_before_at IS NULL AND status='open'",
      at,
      day,
      at,
      at,
      inst.id,
    );
    if (!claimed.meta.changes) continue;
    await sendNotice(ctx, inst, "before", at, `aviso:antes:${inst.id}`);
    before++;
  }
  if (cfg.due_today) {
    const today_ = await all(
      ctx.env,
      `${SELECT_FULL} WHERE i.profile_id=? AND i.status='open' AND i.retroactive=0 AND i.notice_due_at IS NULL AND s.status='active' AND i.due_date=? ORDER BY i.id LIMIT ?`,
      ctx.profile,
      day,
      BATCH,
    );
    for (const inst of today_) {
      const claimed = await exec(
        ctx.env,
        "UPDATE mensalidade_installments SET notice_due_at=?,updated=? WHERE id=? AND notice_due_at IS NULL AND status='open'",
        at,
        at,
        inst.id,
      );
      if (!claimed.meta.changes) continue;
      await sendNotice(ctx, inst, "due", at, `aviso:dia:${inst.id}`);
      due++;
    }
  }
  if (cfg.overdue_max > 0) {
    const late = await all(
      ctx.env,
      `${SELECT_FULL} WHERE i.profile_id=? AND i.status='overdue' AND i.retroactive=0 AND i.overdue_notices<? AND (i.overdue_notice_at IS NULL OR i.overdue_notice_at<=?) AND i.due_date<? ORDER BY i.due_date,i.id LIMIT ?`,
      ctx.profile,
      cfg.overdue_max,
      at - cfg.overdue_every_days * DAY,
      day,
      BATCH,
    );
    for (const inst of late) {
      const claimed = await exec(
        ctx.env,
        "UPDATE mensalidade_installments SET overdue_notices=overdue_notices+1,overdue_notice_at=?,updated=? WHERE id=? AND overdue_notices=? AND status='overdue'",
        at,
        at,
        inst.id,
        inst.overdue_notices,
      );
      if (!claimed.meta.changes) continue;
      await sendNotice(
        ctx,
        inst,
        "overdue",
        at,
        `aviso:atraso:${inst.id}:${inst.overdue_notices + 1}`,
      );
      overdue++;
    }
  }
  return { before, due, overdue };
}

// ---------------------------------------------------------------------------
// Reenvio pela equipe e segunda via pelo cliente

/**
 * Manda de novo o Pix ou o link da parcela: a cobrança que ainda vale numa
 * mensagem do módulo, ou uma cobrança nova (o núcleo entrega). `key` deve vir
 * do pedido (requestId ou rowId do menu).
 */
/**
 * Antes de procurar ou abrir a conversa: parcela em aberto e Cobrança pronta.
 * O que a equipe resolve no painel (Cobrança) vem antes do aviso da linha.
 */
export async function assertChargeable(ctx: ModuleContext, inst: any) {
  if (!["open", "overdue"].includes(inst.status))
    throw new ApiError(
      409,
      "installment_not_payable",
      "Esta parcela não está em aberto.",
    );
  if (!(await paymentsReady(ctx)))
    throw new ApiError(
      409,
      "payments_not_configured",
      "Configure a conta de pagamento em Gestão → Cobrança para enviar Pix ou link. Sem ela, registre o pagamento com a baixa manual.",
    );
}

export async function resendCharge(
  ctx: ModuleContext,
  inst: any,
  c: Conversation,
  key: string,
  at = now(),
  method?: "pix" | "link",
) {
  await assertChargeable(ctx, inst);
  const cfg = mensalidadeSettings(await ctx.settings());
  const kind: NoticeKind = inst.status === "overdue" ? "overdue" : "before";
  const result = await ensureCharge(
    ctx,
    inst,
    c,
    cfg,
    kind,
    at,
    method || cfg.method,
  );
  if (result.error)
    throw new ApiError(
      SETUP_ERRORS.has(result.error) ? 409 : 502,
      result.error,
      result.message || "Não foi possível criar a cobrança.",
    );
  if (!result.created)
    await ctx.sendMessage(
      c,
      {
        text: `Segunda via: ${noticeText(inst, kind, at)}\n\n${payLines(result.inst)}`,
      },
      { key, ...BILLING },
    );
  return loadInstallment(ctx, inst.id);
}

// ---------------------------------------------------------------------------
// Confirmação (webhook) e comprovante

/** Comprovante em texto: cliente, plano, competência, valor, data e forma. */
export function receiptText(
  inst: any,
  shop?: { name: string; document_display?: string | null } | null,
) {
  const via =
    inst.paid_via === "pix"
      ? "Pix"
      : inst.paid_via === "link"
        ? "link de pagamento"
        : "pagamento registrado pela equipe";
  return [
    "Comprovante de pagamento",
    shop?.name
      ? `${shop.name}${shop.document_display ? ` (${shop.document_display})` : ""}`
      : "",
    inst.customer_name ? `Cliente: ${inst.customer_name}` : "",
    `Mensalidade: ${inst.plan_name ? inst.plan_name + " — " : ""}${periodLabel(inst.period_key)} (vencimento ${dayLabel(inst.due_date)})`,
    `Valor: ${money(inst.amount_cents)}`,
    `Pago em ${stamp(inst.paid_at)} (${via})`,
    `Código: ${String(
      inst.payment_id && inst.paid_via !== "manual" ? inst.payment_id : inst.id,
    )
      .slice(0, 8)
      .toUpperCase()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendReceipt(ctx: ModuleContext, instId: string) {
  const inst = await loadInstallment(ctx, instId);
  const c = await conversationFor(ctx, {
    id: inst.subscription_id,
    phone: inst.phone,
    conversation_id: inst.conversation_id,
  });
  if (!c) return null;
  return ctx.sendMessage(
    c,
    { text: receiptText(inst, await ctx.establishment()) },
    { key: `comprovante:${inst.id}:${inst.paid_at}`, ...BILLING },
  );
}

/**
 * Gancho da Cobrança (onPaymentUpdated): roda uma vez por mudança, depois do
 * webhook assinado e da consulta ao provedor. `paid` dá baixa (dinheiro
 * confirmado vence: vale também para parcela vencida, cancelada ou isenta) e
 * envia o comprovante; um segundo pagamento da mesma parcela só é registrado
 * em evento para a equipe estornar. `refunded` reabre a parcela.
 */
export async function paymentUpdated(
  ctx: ModuleContext,
  payment: Payment,
  previous: string,
) {
  if (!payment.ref_id) return;
  let inst = await one(
    ctx.env,
    "SELECT * FROM mensalidade_installments WHERE id=? AND profile_id=?",
    payment.ref_id,
    ctx.profile,
  );
  if (!inst) {
    // Contratação pelo WhatsApp: a parcela só nasce com o pagamento.
    const contract = await one(
      ctx.env,
      "SELECT * FROM mensalidade_contracts WHERE id=? AND profile_id=?",
      payment.ref_id,
      ctx.profile,
    );
    if (!contract) return;
    inst = await contractPaymentUpdated(ctx, contract, payment);
    if (!inst) return;
  }
  const at = now();
  if (payment.status === "paid") {
    const result = await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET status='paid',paid_at=?,paid_via=?,paid_by='provider',payment_id=?,payment_status='paid',updated=? WHERE id=? AND status IN ('open','overdue','cancelled','waived')",
      payment.paid_at || at,
      payment.method,
      payment.id,
      at,
      inst.id,
    );
    if (!result.meta.changes) {
      // Já paga (baixa manual ou outra cobrança): dinheiro em dobro.
      await ctx.publish(
        "mensalidade.paid",
        inst.id,
        {
          installment_id: inst.id,
          subscription_id: inst.subscription_id,
          period_key: inst.period_key,
          amount_cents: payment.amount_cents,
          via: payment.method,
          by: "provider",
          payment_id: payment.id,
          duplicate: true,
          previous,
        },
        { key: `${inst.id}:duplicate:${payment.id}` },
      );
      return;
    }
    await ctx.publish(
      "mensalidade.paid",
      inst.id,
      {
        installment_id: inst.id,
        subscription_id: inst.subscription_id,
        period_key: inst.period_key,
        amount_cents: inst.amount_cents,
        via: payment.method,
        by: "provider",
        payment_id: payment.id,
        paid_at: payment.paid_at || at,
        previous_status: inst.status,
      },
      { key: `${inst.id}:paid:${payment.id}` },
    );
    // O aviso aos módulos antes do comprovante: uma falha no envio (linha sem
    // modelo, por exemplo) não impede a liberação de quem pagou.
    await announcePaid(ctx.env, ctx.profile, inst.id, {
      conversation_id: payment.conversation_id ?? null,
    });
    try {
      await sendReceipt(ctx, inst.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "mensalidade-receipt",
          installment: inst.id,
          error: String((error as Error)?.message || error),
        }),
      );
    }
    return;
  }
  if (payment.status === "refunded") {
    const result = await exec(
      ctx.env,
      "UPDATE mensalidade_installments SET status=CASE WHEN due_date<? THEN 'overdue' ELSE 'open' END,paid_at=NULL,paid_via=NULL,paid_by=NULL,payment_status='refunded',updated=? WHERE id=? AND status='paid' AND payment_id=? AND paid_by='provider'",
      today(at),
      at,
      inst.id,
      payment.id,
    );
    if (result.meta.changes) {
      await ctx.publish(
        "mensalidade.refunded",
        inst.id,
        {
          installment_id: inst.id,
          subscription_id: inst.subscription_id,
          payment_id: payment.id,
          amount_cents: payment.amount_cents,
        },
        { key: `${inst.id}:refunded:${payment.id}` },
      );
      // Quem foi liberado por esta parcela (Suporte pago) perde a liberação.
      await notifyInstallmentRefunded(ctx.env, ctx.profile, {
        id: inst.id,
        subscription_id: inst.subscription_id,
        payment_id: payment.id,
        amount_cents: payment.amount_cents,
      });
    }
    return;
  }
  // expired / cancelled: a próxima cobrança cria outra.
  await exec(
    ctx.env,
    "UPDATE mensalidade_installments SET payment_status=?,updated=? WHERE id=? AND payment_id=?",
    payment.status,
    at,
    inst.id,
    payment.id,
  );
}
