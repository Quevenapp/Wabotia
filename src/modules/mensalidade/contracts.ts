// Contratação de plano pelo WhatsApp (contractPlan em ./public.ts). O contrato
// pendente guarda o plano, quem paga (o pagador do telefone já autorizado, ou
// o documento e o nome digitados) e a cobrança. Pagador, assinatura e
// primeira parcela só nascem com o pagamento confirmado pelo provedor, e
// nenhum telefone é vinculado a um pagador que já existia a partir de um
// documento digitado.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, now, uid } from "../../types";
import type { ModuleContext } from "../api";
import type { Payment } from "../../payments";
import { formatDocument } from "../../establishment";
import { money, today } from "./model";
import {
  CONTRACT_ACTOR_PREFIX,
  createPayer,
  loadPayer,
  payerByDocument,
} from "./payers";
import { createSubscription } from "./store";
import { announcePaid } from "./listeners";
import { sendReceipt } from "./billing";
import { sendPayMessage } from "./pay-message";
import { commitMensalidade as batch, mensalidadeCasGuard, mensalidadeHistory, mensalidadePaymentEvidence, mensalidadeSource, mensalidadeStatements, reconcileMensalidadeContracts, recoverMensalidadePayment } from "./integration";

const BILLING = { notification: true, purpose: "billing" as const };

export function contractView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    plan_id: row.plan_id,
    plan_name: row.plan_name,
    conversation_id: row.conversation_id,
    payer_id: row.payer_id,
    payer_linked: !!row.payer_linked,
    document_display: row.document ? formatDocument(row.document) : null,
    name: row.name,
    amount_cents: row.amount_cents,
    method: row.method,
    status: row.status,
    payment: row.payment_id
      ? {
          id: row.payment_id,
          status: row.payment_status,
          pix_code: row.pix_code,
          url: row.pay_url,
          expires_at: row.payment_expires_at,
        }
      : null,
    subscription_id: row.subscription_id,
    installment_id: row.installment_id,
    paid_at: row.paid_at,
    created: row.created,
  };
}

export async function loadContract(ctx: ModuleContext, id: unknown) {
  const row =
    typeof id === "string"
      ? await one(
          ctx.env,
          "SELECT * FROM mensalidade_contracts WHERE id=? AND profile_id=?",
          id,
          ctx.profile,
        )
      : null;
  if (!row) throw new ApiError(404, "not_found", "Contratação não encontrada.");
  return row;
}

/** Contratação não paga guarda o documento digitado por até 30 dias. */
export const CONTRACT_DOCUMENT_RETENTION_MS = 30 * 86_400_000;

/** Grava o contrato pendente (repetir a chave devolve o mesmo). */
export async function createContract(
  ctx: ModuleContext,
  input: {
    c: Conversation;
    plan: { id: string; name: string; amount_cents: number };
    phone: string;
    payer_id: string | null;
    document: { document: string; type: string } | null;
    name: string;
    method: "pix" | "link";
    sourceKey: string;
    actor: string;
  },
) {
  const found = await one(
    ctx.env,
    "SELECT * FROM mensalidade_contracts WHERE source_key=?",
    input.sourceKey,
  );
  if (found) return found;
  const id = uid(),
    at = now();
  await exec(
    ctx.env,
    "INSERT INTO mensalidade_contracts(id,profile_id,plan_id,plan_name,conversation_id,phone,payer_id,document,document_type,name,amount_cents,method,status,actor,source_key,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT(source_key) DO NOTHING",
    id,
    ctx.profile,
    input.plan.id,
    input.plan.name,
    input.c.id,
    input.phone,
    input.payer_id,
    input.document?.document ?? null,
    input.document?.type ?? null,
    input.name,
    input.plan.amount_cents,
    input.method,
    input.actor,
    input.sourceKey,
    at,
    at,
  );
  const row = await one(
    ctx.env,
    "SELECT * FROM mensalidade_contracts WHERE source_key=?",
    input.sourceKey,
  );
  if (row.id === id) {
    // Contratações que não foram pagas: passado o prazo, o documento e o nome
    // digitados saem (a linha fica para o histórico da sessão), aqui mesmo,
    // sem rodada periódica (conferência N-5).
    await exec(
      ctx.env,
      "UPDATE mensalidade_contracts SET document=NULL,document_type=NULL,name='',pix_code=NULL WHERE id IN (SELECT id FROM mensalidade_contracts WHERE profile_id=? AND status IN ('pending','expired','cancelled') AND created<? AND updated<? AND document IS NOT NULL AND (payment_expires_at IS NULL OR payment_expires_at<?) LIMIT 50)",
      ctx.profile,
      at - CONTRACT_DOCUMENT_RETENTION_MS,
      at - CONTRACT_DOCUMENT_RETENTION_MS,
      at,
    );
    // Outra contratação aberta nesta conversa (outra sessão ou plano): a
    // cobrança dela é cancelada, para o cliente não pagar as duas.
    const others = await all(
      ctx.env,
      "SELECT * FROM mensalidade_contracts WHERE conversation_id=? AND profile_id=? AND status='pending' AND id<>?",
      input.c.id,
      ctx.profile,
      id,
    );
    for (const other of others) {
      if (other.payment_id && other.payment_status === "created")
        try {
          await ctx.cancelCharge(other.payment_id);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          if (error.code === "payment_closed") continue;
        }
      await exec(
        ctx.env,
        "UPDATE mensalidade_contracts SET status='cancelled',updated=? WHERE id=? AND status='pending'",
        at,
        other.id,
      );
    }
    await ctx.publish(
      "mensalidade.contract_created",
      id,
      {
        contract_id: id,
        plan_id: input.plan.id,
        payer_id: input.payer_id,
        conversation_id: input.c.id,
        amount_cents: input.plan.amount_cents,
        method: input.method,
        actor: input.actor,
      },
      { key: id },
    );
  }
  return row;
}

/**
 * Cobrança do contrato: reenvia o código da que ainda vale na mesma forma;
 * senão cancela a aberta (outra forma ou vencendo) e cria outra pela
 * Cobrança do núcleo, que entrega o Pix ou o link na conversa.
 */
export async function chargeContract(
  ctx: ModuleContext,
  contract: any,
  c: Conversation,
  method: "pix" | "link",
  key: string,
) {
  await reconcileMensalidadeContracts(ctx);
  if (contract.status === "paid")
    throw new ApiError(
      409,
      "nothing_to_pay",
      "A primeira mensalidade deste plano já foi paga.",
    );
  const at = now();
  // A obrigação nasce antes de enviar a cobrança. Retentativas conservam a
  // fotografia inicial; cobrança anterior à integração não importa passado.
  const obligation = await mensalidadeStatements(ctx, {
    kind: "contract", record: { ...contract, obligation_ms: contract.charge_seq ? contract.created : at },
    operation: contract.charge_seq ? null : "recognize", newObligation: !contract.charge_seq, at, actor: contract.actor,
  });
  await batch(ctx.env, [
    ["UPDATE mensalidade_contracts SET updated=? WHERE id=? AND profile_id=? AND status=? AND charge_seq=? AND amount_cents=? AND payment_id IS ?", [at, contract.id, ctx.profile, contract.status, contract.charge_seq, contract.amount_cents, contract.payment_id ?? null]],
    mensalidadeCasGuard, ...obligation.statements,
  ]);
  if (
    contract.payment_id &&
    contract.payment_status === "created" &&
    (contract.payment_expires_at || 0) > at + 60_000 &&
    contract.method === method
  ) {
    await sendPayMessage(
      ctx,
      c,
      `Plano ${contract.plan_name}: primeira mensalidade de ${money(contract.amount_cents)}.`,
      contract,
      { key, ...BILLING },
    );
    return contract;
  }
  if (contract.payment_id && contract.payment_status === "created") {
    try {
      await ctx.cancelCharge(contract.payment_id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // Paga enquanto trocava: a confirmação do provedor conclui o contrato.
      if (error.code === "payment_closed")
        throw new ApiError(
          409,
          "payment_closed",
          "O pagamento anterior já foi concluído; aguarde a confirmação.",
        );
    }
    // Cancelar a cobrança entrega seu gancho e pode mudar o contrato. Releia
    // antes do próximo CAS, sem sobrescrever pagamento ou troca concorrente.
    const fresh = await loadContract(ctx, contract.id);
    if (fresh.status === "paid" || fresh.charge_seq !== contract.charge_seq || fresh.payment_id !== contract.payment_id)
      throw new ApiError(409, "payment_closed", "O pagamento anterior mudou; aguarde a confirmação.");
    contract = fresh;
  }
  const seq = contract.charge_seq + 1;
  const payment = await ctx.charge(c, {
    method,
    amount_cents: contract.amount_cents,
    description: `Plano ${contract.plan_name}: primeira mensalidade`,
    ref: contract.id,
    sourceKey: `contrato:${contract.id}:${seq}`,
    expiresMinutes: 24 * 60,
    notification: true,
    receipt: false,
  });
  const charged = await mensalidadeStatements(ctx, { kind: "contract", record: contract, operation: null, at });
  await batch(ctx.env, [
    ["UPDATE mensalidade_contracts SET payment_id=?,payment_status=?,payment_expires_at=?,pix_code=?,pay_url=?,method=?,charge_seq=?,status=CASE WHEN status IN ('expired','cancelled') THEN 'pending' ELSE status END,updated=? WHERE id=? AND profile_id=? AND status=? AND charge_seq=? AND payment_id IS ?",
      [payment.id, payment.status, payment.expires_at, payment.pix_code, payment.url, payment.method, seq, at, contract.id, ctx.profile, contract.status, contract.charge_seq, contract.payment_id ?? null]],
    mensalidadeCasGuard, ...charged.statements,
  ]);
  return loadContract(ctx, contract.id);
}

/**
 * Pagamento confirmado: pagador (o do telefone autorizado; senão o novo, com
 * o documento, o nome e o telefone da conversa), assinatura começando no dia
 * do pagamento e a primeira parcela já paga. Se o documento passou a ser de
 * outro pagador nesse meio tempo, a assinatura fica com ele e o telefone NÃO
 * é vinculado (`payer_linked` 0: a equipe confirma). Cada passo é idempotente
 * para a confirmação repetida; o comprovante e o aviso aos módulos saem uma
 * vez.
 */
async function contractPaid(
  ctx: ModuleContext,
  contract: any,
  payment: Payment,
) {
  // Conferir o fato antes de criar pagador/assinatura ou publicar avisos.
  // Um DTO sem evidência não pode deixar efeitos locais ao ser recusado.
  const evidence = await mensalidadePaymentEvidence(ctx, payment);
  if (contract.status === "paid" && contract.payment_id === payment.id) {
    await recoverMensalidadePayment(ctx, "contract", contract, payment);
    // O núcleo repete o gancho até concluir: refaz os avisos (com chave).
    return contractAnnounce(ctx, contract, payment);
  }
  if (contract.status === "paid") {
    if (contract.payment_id !== payment.id)
      await ctx.publish(
        "mensalidade.paid",
        contract.installment_id || contract.id,
        {
          installment_id: contract.installment_id,
          subscription_id: contract.subscription_id,
          contract_id: contract.id,
          amount_cents: payment.amount_cents,
          via: payment.method,
          by: "provider",
          payment_id: payment.id,
          duplicate: true,
        },
        { key: `${contract.id}:duplicate:${payment.id}` },
      );
    return;
  }
  const at = now();
  const paidAt = evidence.receipt.occurred_ms;
  let payerId: string | null = contract.payer_id;
  if (!payerId) {
    const taken = contract.document
      ? await payerByDocument(ctx, contract.document)
      : null;
    const payer =
      taken ||
      (await createPayer(
        ctx,
        {
          document: contract.document,
          name: contract.name,
          phones: contract.phone ? [contract.phone] : [],
        },
        // Provisório: documento e telefone vieram de quem digitou.
        `${CONTRACT_ACTOR_PREFIX}${contract.id}`,
      ));
    await exec(
      ctx.env,
      "UPDATE mensalidade_contracts SET payer_id=?,payer_linked=?,updated=? WHERE id=? AND payer_id IS NULL",
      payer.id,
      taken ? 0 : 1,
      at,
      contract.id,
    );
    contract = await loadContract(ctx, contract.id);
    payerId = contract.payer_id as string;
  }
  const payer = await loadPayer(ctx, payerId);
  let c: Conversation | null = null;
  try {
    c = await ctx.conversation(contract.conversation_id);
  } catch {
    c = null;
  }
  const sub = await createSubscription(
    ctx,
    {
      conversation: c && c.chat_type !== "group" ? c : null,
      phone: contract.phone,
      plan_id: contract.plan_id,
      payer_id: payer.id,
      amount_cents: contract.amount_cents,
      discount_cents: 0,
      customer_name: payer.name || contract.name,
      start_date: today(paidAt),
      sourceKey: `contrato:${contract.id}`,
      paidContract: true,
    },
    contract.actor,
  );
  const day = today(paidAt),
    period = day.slice(0, 7),
    instId = uid();
  const amount = contract.amount_cents;
  const existing = await one(
    ctx.env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? AND period_key=?",
    sub.id,
    period,
  );
  const inst = existing ?? { id: instId, profile_id: ctx.profile, subscription_id: sub.id, period_key: period, due_date: day, amount_cents: amount, status: "paid", created: at };
  const source = await mensalidadeSource(ctx, "contract", contract);
  const commercial = await mensalidadeStatements(ctx, { kind: "contract", record: { ...contract, status: "paid" }, source, operation: "receive", at: evidence.receipt?.occurred_ms ?? paidAt, ...evidence,
    aliases: [{ kind: "installment", id: inst.id }] });
  const writes: import("../../integrations/contracts").Statement[] = [];
  if (existing) {
    // Uma associação tardia não pode adotar uma parcela já reconhecida por
    // outra origem. A guarda desfaz também o pagamento local neste lote.
    writes.push(["SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM module_erp_sources WHERE profile_id=? AND module_id='mensalidade' AND source_id=?) THEN 1 ELSE json('mensalidade_origin_conflict') END", [ctx.profile, inst.id]]);
    writes.push(["UPDATE mensalidade_installments SET status='paid',upfront=1,paid_at=?,paid_via=?,paid_by='provider',payment_id=?,payment_status='paid',updated=? WHERE id=? AND profile_id=? AND amount_cents=? AND (status IN ('open','overdue') OR (status='paid' AND payment_id=? AND paid_by='provider'))", [paidAt, payment.method, payment.id, at, inst.id, ctx.profile, amount, payment.id]], mensalidadeCasGuard);
  } else writes.push([
    "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,upfront,paid_at,paid_via,paid_by,payment_id,payment_status,payment_method,notice_before_at,notice_due_at,created,updated) VALUES(?,?,?,?,?,?,'paid',1,?,?,'provider',?,'paid',?,?,?,?,?)",
    [inst.id, ctx.profile, sub.id, period, day, amount, paidAt, payment.method, payment.id, payment.method, at, at, at, at],
  ]);
  await batch(ctx.env, [
    ...writes,
    ["UPDATE mensalidade_contracts SET status='paid',paid_at=?,payment_id=?,payment_status='paid',subscription_id=?,installment_id=?,updated=? WHERE id=? AND profile_id=? AND status=? AND amount_cents=?", [paidAt, payment.id, sub.id, inst.id, at, contract.id, ctx.profile, contract.status, contract.amount_cents]],
    mensalidadeCasGuard,
    mensalidadeHistory(ctx, "mensalidade.installment_created", inst.id, { installment_id: inst.id, subscription_id: sub.id, period_key: period, due_date: day, amount_cents: amount, status: "paid", upfront: true }, inst.id),
    mensalidadeHistory(ctx, "mensalidade.paid", inst.id, { installment_id: inst.id, subscription_id: sub.id, contract_id: contract.id, period_key: period, amount_cents: amount, via: payment.method, by: "provider", payment_id: payment.id, paid_at: paidAt, previous_status: "contract" }, `${inst.id}:paid:${payment.id}`),
    ...commercial.statements,
  ]);
  return contractAnnounce(ctx, await loadContract(ctx, contract.id), payment);
}

/**
 * Eventos, aviso aos módulos e comprovante de um contrato pago. Tudo com
 * chave: a repetição do gancho pelo núcleo não duplica nada. O aviso vem
 * antes do comprovante; uma falha no envio faz o núcleo repetir.
 */
async function contractAnnounce(
  ctx: ModuleContext,
  contract: any,
  payment: Payment,
) {
  const inst = await one(
    ctx.env,
    "SELECT * FROM mensalidade_installments WHERE id=? AND profile_id=?",
    contract.installment_id,
    ctx.profile,
  );
  if (!inst) return;
  const sub = { id: inst.subscription_id };
  const period = inst.period_key,
    day = inst.due_date,
    amount = inst.amount_cents,
    paidAt = inst.paid_at;
  // Mesma chave do gerador: se ele criou a parcela antes, não repete.
  await ctx.publish(
    "mensalidade.installment_created",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: sub.id,
      period_key: period,
      due_date: day,
      amount_cents: amount,
      status: "paid",
      upfront: true,
    },
    { key: inst.id },
  );
  await ctx.publish(
    "mensalidade.paid",
    inst.id,
    {
      installment_id: inst.id,
      subscription_id: sub.id,
      contract_id: contract.id,
      period_key: period,
      amount_cents: inst.amount_cents,
      via: payment.method,
      by: "provider",
      payment_id: payment.id,
      paid_at: paidAt,
      previous_status: "contract",
    },
    { key: `${inst.id}:paid:${payment.id}` },
  );
  if (!contract.payer_linked) await contractUnlinked(ctx, contract, inst);
  await announcePaid(ctx.env, ctx.profile, inst.id, {
    conversation_id: payment.conversation_id ?? contract.conversation_id,
    contract_id: contract.id,
    rethrow: true,
  });
  await sendReceipt(ctx, inst.id);
}

/**
 * O documento da contratação já era de outro pagador quando o pagamento
 * chegou: a assinatura nasceu nele sem vincular o telefone. A equipe é
 * avisada (evento e nota na conversa), porque uma parcela não paga dessa
 * assinatura deixaria o pagador de verdade em atraso (conferência N-6).
 */
async function contractUnlinked(ctx: ModuleContext, contract: any, inst: any) {
  await ctx.publish(
    "mensalidade.contract_unlinked",
    contract.id,
    {
      contract_id: contract.id,
      payer_id: contract.payer_id,
      subscription_id: inst.subscription_id,
      installment_id: inst.id,
      conversation_id: contract.conversation_id,
    },
    { key: contract.id },
  );
  let c: Conversation | null = null;
  try {
    c = await ctx.conversation(contract.conversation_id);
  } catch {
    return;
  }
  const payer = await loadPayer(ctx, contract.payer_id);
  await ctx.note(
    c,
    `Atenção: o CPF/CNPJ desta contratação já era do pagador ${payer.name || "sem nome"}. A assinatura foi criada nele sem vincular este telefone. Confira com o pagador antes de vincular; se não for ele, encerre a assinatura em Mensalidades.`,
    { key: `desvinculado:${contract.id}` },
  );
}

/**
 * Gancho da Cobrança para cobranças de contrato (`ref` = contrato). Devolve a
 * parcela que o contrato gerou, quando o estorno precisa reabri-la, ou null.
 */
export async function contractPaymentUpdated(
  ctx: ModuleContext,
  contract: any,
  payment: Payment,
) {
  if (payment.status === "paid") {
    await contractPaid(ctx, contract, payment);
    return null;
  }
  if (payment.status === "refunded")
    return contract.status === "paid" && contract.installment_id
      ? one(
          ctx.env,
          "SELECT * FROM mensalidade_installments WHERE id=? AND profile_id=?",
          contract.installment_id,
          ctx.profile,
        )
      : null;
  // Vencida ou cancelada: o contrato espera outra cobrança.
  if (contract.payment_id !== payment.id) return null;
  const at = now(), status = contract.status === "pending" ? payment.status === "cancelled" ? "cancelled" : "expired" : contract.status;
  if (contract.payment_status === payment.status && contract.status === status) return null;
  const commercial = await mensalidadeStatements(ctx, { kind: "contract", record: { ...contract, status }, operation: null, at });
  // Expirar o Pix não cancela o contrato: outra tentativa de cobrança ainda
  // paga a mesma obrigação. Cancelamento operacional é um fato separado.
  await batch(ctx.env, [
    ["UPDATE mensalidade_contracts SET payment_status=?,status=?,updated=? WHERE id=? AND profile_id=? AND payment_id=? AND status=?", [payment.status, status, at, contract.id, ctx.profile, payment.id, contract.status]],
    mensalidadeCasGuard, ...commercial.statements,
  ]);
  return null;
}
