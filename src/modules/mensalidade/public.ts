// Interface pública da Mensalidade para módulos que dependem dela (Suporte
// pago, por exemplo). Enquanto o núcleo não formaliza `requires` entre
// módulos, o módulo dependente importa daqui direto e deve conferir
// `mensalidadeAvailable` antes de usar. Todas as funções agem como o módulo
// "mensalidade" (cobranças, eventos e ganchos de pagamento ficam com ele),
// mesmo chamadas de dentro de outro módulo. Contrato: docs/MENSALIDADE.md.
import { all, one } from "../../db";
import {
  ApiError,
  type Conversation,
  type Env,
  now,
  requireValue,
} from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import {
  addDays,
  mensalidadeSettings,
  parseDocument,
  phoneDigits,
  requireDocument,
  text,
  today,
} from "./model";
import {
  addPayerPhone,
  listPayers,
  loadPayer,
  payerByDocument,
  payerPhones,
  payersByPhone,
  payerView,
} from "./payers";
import { installmentView, loadPlan, planView } from "./store";
import { loadInstallment, paymentsReady } from "./installments";
import { recordBillingConsent, resendCharge } from "./billing";
import {
  chargeContract,
  contractView,
  createContract,
  loadContract,
} from "./contracts";

export {
  onInstallmentPaid,
  onInstallmentRefunded,
  type InstallmentPaid,
  type InstallmentRefunded,
} from "./listeners";

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
    "SELECT s.id,s.plan_id,s.status,p.name AS plan_name FROM mensalidade_subscriptions s LEFT JOIN mensalidade_plans p ON p.id=s.plan_id WHERE s.payer_id=? AND s.profile_id=? AND s.status='active' ORDER BY s.created LIMIT 50",
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
  /**
   * Pagador que já autorizou o telefone da conversa (achado por
   * situationByPhone). Sem ele, `document` e `name` de um pagador novo: um
   * documento já cadastrado é recusado (409 payer_exists), porque digitar o
   * documento de alguém não dá acesso ao cadastro dele.
   */
  payer_id?: string | null;
  document?: string | null;
  /** Nome do pagador novo (empresa ou pessoa). */
  name?: string | null;
  method?: "pix" | "link";
  /** Repetir a chave não cria outro contrato nem outra cobrança. */
  sourceKey: string;
  actor: string;
}

/**
 * Contrata um plano vendável pela conversa. Cobra a primeira mensalidade na
 * hora pela Cobrança (o núcleo entrega o Pix ou o link) e só com o pagamento
 * confirmado pelo provedor nascem o pagador novo (com o telefone da conversa),
 * a assinatura e a primeira parcela, já paga. Até lá nada muda no cadastro.
 * Quem já assina o plano (pagador do telefone): cobra a parcela em aberto, ou
 * 409 nothing_to_pay. Devolve `{contract, installment}` (um dos dois).
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
  requireValue(
    c.chat_type !== "group",
    "Contratação só em conversa individual.",
  );
  // Só o telefone autenticado pelo canal: em conversa de integração o
  // external_id é escolhido por quem chama.
  const verified = ctx.verifiedPhone(c);
  if (!verified)
    throw new ApiError(
      409,
      "phone_not_verified",
      "Contratação pelo WhatsApp só em conversa com o telefone verificado pelo canal.",
    );
  const phone = phoneDigits(verified);
  const method =
    input.method || mensalidadeSettings(await ctx.settings()).method;
  let payerId: string | null = null;
  let doc: { document: string; type: string } | null = null;
  let name = "";
  if (input.payer_id) {
    const payer = await loadPayer(ctx, input.payer_id);
    const phones = await payerPhones(ctx, payer.id);
    if (!phone || !phones.some((p) => p.phone === phone))
      throw new ApiError(
        403,
        "phone_not_linked",
        "O telefone desta conversa não está autorizado por este pagador; a equipe precisa confirmar antes.",
      );
    payerId = payer.id;
    name = payer.name;
    // Já assina este plano: cobra a parcela em aberto em vez de duplicar.
    const existing = await one(
      ctx.env,
      "SELECT id FROM mensalidade_subscriptions WHERE payer_id=? AND plan_id=? AND status='active' AND profile_id=?",
      payer.id,
      plan.id,
      ctx.profile,
    );
    if (existing) {
      const inst = await one(
        ctx.env,
        "SELECT id FROM mensalidade_installments WHERE subscription_id=? AND status IN ('open','overdue') ORDER BY upfront DESC,due_date LIMIT 1",
        existing.id,
      );
      if (!inst)
        throw new ApiError(
          409,
          "nothing_to_pay",
          `A assinatura do plano "${plan.name}" está em dia: não há parcela a pagar.`,
        );
      return {
        contract: null,
        installment: await chargeInstallment(env, profile, {
          conversation: c,
          installment_id: inst.id,
          method,
          key: `contrato:${input.sourceKey}`,
        }),
      };
    }
  } else {
    doc = requireDocument(input.document);
    if (await payerByDocument(ctx, doc.document))
      throw new ApiError(
        409,
        "payer_exists",
        "Este CPF/CNPJ já tem cadastro: a equipe confirma o telefone antes de contratar por aqui.",
      );
    name = text(input.name, 120, "o nome de quem paga", true);
  }
  const contract = await createContract(ctx, {
    c,
    plan,
    phone,
    payer_id: payerId,
    document: doc,
    name,
    method,
    sourceKey: input.sourceKey,
    actor: input.actor,
  });
  // Contratou pela conversa: aceita receber as cobranças pelo WhatsApp.
  await recordBillingConsent(
    ctx,
    c,
    "whatsapp",
    {
      action: "contract_plan",
      plan_id: plan.id,
      plan_name: plan.name,
      contract_id: contract.id,
      payer_id: payerId,
    },
    `contrato:${input.sourceKey}`,
  );
  const charged =
    contract.payment_id && contract.status === "pending"
      ? contract
      : await chargeContract(
          ctx,
          contract,
          c,
          method,
          `contrato:${input.sourceKey}`,
        );
  return { contract: contractView(charged)!, installment: null };
}

/**
 * Cobra de novo a primeira mensalidade de uma contratação pendente: o código
 * da cobrança que vale (mesma forma) ou outra cobrança, cancelando a aberta.
 */
export async function chargeContractAgain(
  env: Env,
  profile: string,
  input: {
    conversation: Conversation;
    contract_id: string;
    method?: "pix" | "link";
    key: string;
  },
) {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  const contract = await loadContract(ctx, input.contract_id);
  requireValue(
    contract.conversation_id === input.conversation.id,
    "Contratação de outra conversa.",
  );
  return contractView(
    await chargeContract(
      ctx,
      contract,
      input.conversation,
      input.method || contract.method,
      input.key,
    ),
  )!;
}

/** Contratação pelo WhatsApp no formato da API. */
export async function contractById(env: Env, profile: string, id: string) {
  return contractView(await loadContract(ctxOf(env, profile), id))!;
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
