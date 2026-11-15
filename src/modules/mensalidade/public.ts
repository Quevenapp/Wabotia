// Interface pública da Mensalidade para módulos que dependem dela (Suporte
// pago, por exemplo). Enquanto o núcleo não formaliza `requires` entre
// módulos, o módulo dependente importa daqui direto e deve conferir
// `mensalidadeAvailable` antes de usar. Todas as funções agem como o módulo
// "mensalidade" (cobranças, eventos e ganchos de pagamento ficam com ele),
// mesmo chamadas de dentro de outro módulo. Contrato: docs/MENSALIDADE.md.
import { all, exec, one } from "../../db";
import { ApiError, type Conversation, type Env, now, uid } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import {
  addDays,
  mensalidadeSettings,
  parseDocument,
  phoneDigits,
  requireDocument,
  today,
} from "./model";
import {
  addPayerPhone,
  ensurePayer,
  listPayers,
  loadPayer,
  payerByDocument,
  payerPhones,
  payersByPhone,
  payerView,
} from "./payers";
import {
  createSubscription,
  installmentView,
  loadPlan,
  planView,
  subscriptionView,
  loadSubscription,
} from "./store";
import { loadInstallment, paymentsReady } from "./installments";
import { resendCharge } from "./billing";

export { onInstallmentPaid, type InstallmentPaid } from "./listeners";

export type PayerStatus = "em_dia" | "em_atraso" | "sem_assinatura";

export interface PayerSituation {
  status: PayerStatus;
  payer: ReturnType<typeof payerView>;
  /** Como o pagador foi encontrado. */
  matched_by: "phone" | "document" | "id";
  /** O telefone consultado está entre os autorizados do pagador. */
  phone_linked: boolean | null;
  /** Assinaturas ativas. */
  subscriptions: {
    id: string;
    plan_id: string;
    plan_name: string | null;
    status: string;
  }[];
  /**
   * Em atraso: a parcela a pagar (a mais antiga vencida além da carência, ou
   * a primeira parcela da contratação ainda sem pagar). Em dia: uma parcela
   * vencida dentro da carência, se houver.
   */
  open_installment: ReturnType<typeof installmentView> | null;
  grace_days: number;
}

const ctxOf = (env: Env, profile: string) =>
  modulesApi(env, profile, "mensalidade");

/** Mensalidade ligada na área (sem ela, nada de plano mensal nem situação). */
export const mensalidadeAvailable = (env: Env, profile: string) =>
  ctxOf(env, profile).enabled();

/** Cobrança configurada (módulo Cobrança ligado e conta ativa). */
export const chargesReady = (env: Env, profile: string) =>
  paymentsReady(ctxOf(env, profile));

const rank: Record<PayerStatus, number> = {
  em_dia: 0,
  em_atraso: 1,
  sem_assinatura: 2,
};

async function situationOf(
  ctx: ModuleContext,
  payer: any,
  at: number,
  matched_by: PayerSituation["matched_by"],
  phone: string | null,
): Promise<PayerSituation> {
  const cfg = mensalidadeSettings(await ctx.settings());
  const phones = await payerPhones(ctx, payer.id);
  const subs = await all(
    ctx.env,
    "SELECT s.id,s.plan_id,s.status,p.name AS plan_name FROM mensalidade_subscriptions s LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE s.payer_id=? AND s.profile_id=? AND s.status='active' ORDER BY s.created",
    payer.id,
    ctx.profile,
  );
  const base = {
    payer: payerView(payer, phones),
    matched_by,
    phone_linked: phone ? phones.some((p) => p.phone === phone) : null,
    subscriptions: subs.map((s) => ({
      id: s.id,
      plan_id: s.plan_id,
      plan_name: s.plan_name,
      status: s.status,
    })),
    grace_days: cfg.grace_days,
  };
  if (!subs.length)
    return { ...base, status: "sem_assinatura", open_installment: null };
  const cutoff = addDays(today(at), -cfg.grace_days);
  const marks = subs.map(() => "?").join(",");
  const pending = await one(
    ctx.env,
    `SELECT * FROM mensalidade_installments WHERE subscription_id IN (${marks}) AND status IN ('open','overdue') AND (due_date<? OR upfront=1) ORDER BY upfront DESC,due_date,id LIMIT 1`,
    ...subs.map((s) => s.id),
    cutoff,
  );
  if (pending)
    return {
      ...base,
      status: "em_atraso",
      open_installment: installmentView(await loadInstallment(ctx, pending.id)),
    };
  const graced = await one(
    ctx.env,
    `SELECT id FROM mensalidade_installments WHERE subscription_id IN (${marks}) AND status='overdue' ORDER BY due_date,id LIMIT 1`,
    ...subs.map((s) => s.id),
  );
  return {
    ...base,
    status: "em_dia",
    open_installment: graced
      ? installmentView(await loadInstallment(ctx, graced.id))
      : null,
  };
}

/**
 * Situação de quem fala por um telefone, entre os pagadores que o
 * autorizaram. Com mais de um, vale o mais favorável (em dia > em atraso >
 * sem assinatura). null: telefone sem pagador.
 */
export async function situationByPhone(
  env: Env,
  profile: string,
  phone: string,
  at = now(),
): Promise<(PayerSituation & { payers: number }) | null> {
  const ctx = ctxOf(env, profile);
  const digits = phoneDigits(phone);
  const payers = await payersByPhone(ctx, digits);
  if (!payers.length) return null;
  let best: PayerSituation | null = null;
  for (const payer of payers) {
    const situation = await situationOf(ctx, payer, at, "phone", digits);
    if (!best || rank[situation.status] < rank[best.status]) best = situation;
  }
  return { ...best!, payers: payers.length };
}

/**
 * Situação pelo CPF ou CNPJ (com dígitos conferidos). Inválido: 400; sem
 * pagador com esse documento: null. `phone` diz se quem pergunta já é um
 * telefone autorizado (`phone_linked`).
 */
export async function situationByDocument(
  env: Env,
  profile: string,
  document: string,
  options: { phone?: string | null; at?: number } = {},
): Promise<PayerSituation | null> {
  const ctx = ctxOf(env, profile);
  const doc = requireDocument(document);
  const payer = await payerByDocument(ctx, doc.document);
  if (!payer) return null;
  return situationOf(
    ctx,
    payer,
    options.at ?? now(),
    "document",
    options.phone ? phoneDigits(options.phone) : null,
  );
}

export async function situationByPayer(
  env: Env,
  profile: string,
  payerId: string,
  options: { phone?: string | null; at?: number } = {},
) {
  const ctx = ctxOf(env, profile);
  return situationOf(
    ctx,
    await loadPayer(ctx, payerId),
    options.at ?? now(),
    "id",
    options.phone ? phoneDigits(options.phone) : null,
  );
}

/** Confere um documento sem consultar nada (para quem pede ao cliente digitar). */
export const validDocument = (value: unknown) => parseDocument(value);

/** Planos ativos marcados como vendáveis pelo WhatsApp. */
export async function sellablePlans(env: Env, profile: string) {
  const ctx = ctxOf(env, profile);
  const rows = await all(
    ctx.env,
    "SELECT * FROM mensalidade_plans WHERE profile_id=? AND active=1 AND sellable=1 ORDER BY amount_cents,name",
    ctx.profile,
  );
  return rows.map(planView);
}

/** Busca de pagadores (nome, documento, telefone), para o painel de outros módulos. */
export const findPayers = (
  env: Env,
  profile: string,
  query: Record<string, string>,
) => listPayers(ctxOf(env, profile), query);

/** Autoriza um telefone a falar pelo pagador (o atendente "vincula com um toque"). */
export async function linkPhone(
  env: Env,
  profile: string,
  payerId: string,
  phone: string,
  actor: string,
  label = "",
) {
  const ctx = ctxOf(env, profile);
  return addPayerPhone(ctx, await loadPayer(ctx, payerId), phone, label, actor);
}

export interface ContractInput {
  conversation: Conversation;
  plan_id: string;
  /** Pagador existente, ou o documento para achar/criar. */
  payer_id?: string | null;
  document?: string | null;
  /** Nome do pagador (empresa ou pessoa) quando ainda não existe. */
  name?: string | null;
  method?: "pix" | "link";
  /** Repetir a chave não cria outra assinatura nem outra cobrança. */
  sourceKey: string;
  actor: string;
}

/**
 * Contrata um plano vendável para o pagador da conversa: acha ou cria o
 * pagador (autorizando o telefone da conversa), cria a assinatura começando
 * hoje e cobra a primeira parcela na hora pela Cobrança (o núcleo entrega o
 * Pix ou o link na conversa). Até ser paga, a situação fica em atraso e as
 * parcelas seguintes não nascem. Se o pagador já tem esse plano ativo, cobra
 * de novo a parcela em aberto em vez de duplicar.
 */
export async function contractPlan(
  env: Env,
  profile: string,
  input: ContractInput,
) {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  const plan = await loadPlan(ctx, input.plan_id);
  if (!plan.active || !plan.sellable)
    throw new ApiError(
      409,
      "plan_not_sellable",
      `O plano "${plan.name}" não está disponível para contratação pelo WhatsApp.`,
    );
  if (!(await paymentsReady(ctx)))
    throw new ApiError(
      409,
      "payments_not_configured",
      "Configure a conta de pagamento em Gestão → Cobrança para vender planos pelo WhatsApp.",
    );
  const c = input.conversation;
  const phone = phoneDigits(c.phone || c.external_id);
  const payer = input.payer_id
    ? await loadPayer(ctx, input.payer_id)
    : await ensurePayer(
        ctx,
        { document: input.document, name: input.name, phone },
        input.actor,
      );
  if (input.payer_id && phone)
    await addPayerPhone(ctx, payer, phone, "", input.actor);
  const existing = await one(
    ctx.env,
    "SELECT id FROM mensalidade_subscriptions WHERE payer_id=? AND plan_id=? AND status='active' AND profile_id=? AND (source_key IS NULL OR source_key<>?)",
    payer.id,
    plan.id,
    ctx.profile,
    input.sourceKey,
  );
  const sub = existing
    ? await loadSubscription(ctx, existing.id)
    : await createSubscription(
        ctx,
        {
          conversation: c,
          plan_id: plan.id,
          payer_id: payer.id,
          customer_name: payer.name || input.name || undefined,
          start_date: today(now()),
          sourceKey: input.sourceKey,
        },
        input.actor,
      );
  let inst = await one(
    ctx.env,
    "SELECT * FROM mensalidade_installments WHERE subscription_id=? AND status IN ('open','overdue') ORDER BY upfront DESC,due_date LIMIT 1",
    sub.id,
  );
  if (!inst && !existing) {
    // Primeira parcela: competência deste mês, vence hoje, cobrada já.
    const at = now(),
      day = today(at),
      id = uid();
    const amount = sub.amount_cents - sub.discount_cents;
    const created = await exec(
      ctx.env,
      "INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,upfront,notice_before_at,notice_due_at,created,updated) VALUES(?,?,?,?,?,?,'open',1,?,?,?,?) ON CONFLICT(subscription_id,period_key) DO NOTHING",
      id,
      ctx.profile,
      sub.id,
      day.slice(0, 7),
      day,
      amount,
      at,
      at,
      at,
      at,
    );
    if (created.meta.changes)
      await ctx.publish(
        "mensalidade.installment_created",
        id,
        {
          installment_id: id,
          subscription_id: sub.id,
          period_key: day.slice(0, 7),
          due_date: day,
          amount_cents: amount,
          status: "open",
          upfront: true,
        },
        { key: id },
      );
    inst = await one(
      ctx.env,
      "SELECT * FROM mensalidade_installments WHERE subscription_id=? AND period_key=?",
      sub.id,
      day.slice(0, 7),
    );
  }
  if (!inst)
    throw new ApiError(
      409,
      "nothing_to_pay",
      `A assinatura do plano "${plan.name}" está em dia: não há parcela a pagar.`,
    );
  const charged = await chargeInstallment(env, profile, {
    conversation: c,
    installment_id: inst.id,
    method: input.method,
    key: `contrato:${input.sourceKey}`,
  });
  return {
    payer: payerView(
      await loadPayer(ctx, payer.id),
      await payerPhones(ctx, payer.id),
    ),
    subscription: subscriptionView(await loadSubscription(ctx, sub.id)),
    installment: charged,
    created: !existing,
  };
}

/**
 * Cobra (de novo) uma parcela aberta ou vencida na conversa: reaproveita o
 * Pix ou link que ainda vale, mandando o código numa mensagem, ou cria outra
 * cobrança (o núcleo entrega). Devolve a parcela com `payment`. Erros:
 * 409 payments_not_configured, 409 installment_not_payable.
 */
export async function chargeInstallment(
  env: Env,
  profile: string,
  input: {
    conversation: Conversation;
    installment_id: string;
    method?: "pix" | "link";
    key: string;
  },
) {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  const inst = await loadInstallment(ctx, input.installment_id);
  return installmentView(
    await resendCharge(
      ctx,
      inst,
      input.conversation,
      input.key,
      now(),
      input.method,
    ),
  );
}

/** Parcela no formato da API (para mostrar ao atendente). */
export async function installmentById(env: Env, profile: string, id: string) {
  return installmentView(await loadInstallment(ctxOf(env, profile), id));
}
