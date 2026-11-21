// Cobrança no núcleo (docs/COBRANCA.md). Uma conta de provedor por área, com
// credenciais cifradas; cobranças Pix e link de pagamento ligadas à conversa e
// a um registro de módulo; confirmação só pelo webhook do provedor, depois de
// validar a assinatura e consultar o pagamento na API.
//
// Estados: created → paid | expired | cancelled; paid → refunded. Dinheiro
// confirmado vence: um pagamento aprovado depois de expirar ou de cancelado
// localmente passa a paid. Nenhuma mensagem do cliente muda o estado.
import { all, batch, exec, one, cachedOne, withReadCache, seedRead, MODULE_STATES_SQL, PROFILE_SETTINGS_SQL } from "./db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  json,
  now,
  requireValue,
  uid,
} from "./types";
import { access, admin, secret, setSecret, unseal } from "./security";
import { event, eventStatement } from "./events";
import { conversation, enqueue, message } from "./service";
import { interactiveLine, sendInteractive } from "./line-service";
import { publicOrigin } from "./web-steps";
import {
  moduleDisabledError,
  moduleEnabled,
  moduleById,
} from "./modules/registry";
import { paymentHook } from "./modules/hooks";
import type {
  PaymentProvider,
  ProviderCredentials,
  WebhookInput,
} from "./payments-provider";
import { mercadoPago } from "./payments-mercadopago";
import { paymentPendingEventKey } from "./payments-commercial-evidence";
import type { IntegrationModule, Statement } from "./integrations/contracts";
import {
  PaymentEvidenceError,
  paymentEvidenceStatements,
  paymentHookFailure,
  preparePaymentEvidence,
  parsePaymentEvidence,
  providerReceiptKey,
  readPaymentEvidence,
  type PaymentEvidence,
  type PaymentHookEvent,
  type VerifiedProviderPayment,
} from "./integrations/payment-evidence";

export const providers: Record<string, PaymentProvider> = {
  mercadopago: mercadoPago,
};
export const paymentStatuses = [
  "created",
  "paid",
  "expired",
  "cancelled",
  "refunded",
] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];
export type PaymentMethod = "pix" | "link";
export type PaymentTrigger = "agent" | "bot" | "module" | "menu";

/** Validade padrão e limites, em minutos (Pix do Mercado Pago: 30 min a 30 dias). */
export const PAYMENT_TTL = { default: 24 * 60, min: 30, max: 30 * 24 * 60 };
export const PAYMENTS_MODULE = "payments";

export const money = (cents: number, currency = "BRL") => {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
};

async function requirePayments(env: Env, profile: string) {
  if (!(await moduleEnabled(env, profile, PAYMENTS_MODULE)))
    throw moduleDisabledError(moduleById(PAYMENTS_MODULE)!);
}

// ---------------------------------------------------------------------------
// Conta do provedor

const secretId = (accountId: string) => `payment-account:${accountId}`;
export const webhookPath = (provider: string, accountId: string) =>
  `/webhooks/payments/${provider}/${accountId}`;

async function accountRow(env: Env, profile: string) {
  return cachedOne(
    env,
    "SELECT * FROM payment_accounts WHERE profile_id=?",
    profile,
  );
}
export async function accountCredentials(
  env: Env,
  accountId: string,
): Promise<ProviderCredentials> {
  const keys = await secret(env, secretId(accountId));
  return {
    access_token: String(keys.access_token || ""),
    webhook_secret: String(keys.webhook_secret || ""),
  };
}

/** Visão da conta, sem segredos: só diz se cada um está guardado. */
async function accountView(env: Env, row: any) {
  if (!row) return { configured: false, providers: providerList() };
  const keys = await accountCredentials(env, row.id);
  const origin = await publicOrigin(env);
  return {
    configured: true,
    id: row.id,
    provider: row.provider,
    enabled: !!row.enabled,
    payer_email: row.payer_email,
    access_token_set: !!keys.access_token,
    webhook_secret_set: !!keys.webhook_secret,
    checked: json(row.checked, null),
    webhook_url: origin ? origin + webhookPath(row.provider, row.id) : null,
    providers: providerList(),
    updated: row.updated,
  };
}
const providerList = () =>
  Object.values(providers).map((p) => ({
    id: p.id,
    name: p.name,
    methods: p.methods,
  }));

export async function getPaymentAccount(
  env: Env,
  actor: Actor,
  profile: string,
) {
  admin(actor);
  return accountView(env, await accountRow(env, profile));
}

const email = (value: unknown) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** payment.account.save: provedor, credenciais (só se informadas) e e-mail. */
export async function savePaymentAccount(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  admin(actor);
  const old = await accountRow(env, profile);
  const provider = data.provider ?? old?.provider;
  requireValue(providers[provider], "Escolha o provedor de pagamento.");
  requireValue(
    !old || old.provider === provider,
    "Para trocar de provedor, remova a conta atual antes.",
  );
  const payerEmail = String(data.payer_email ?? old?.payer_email ?? "").trim();
  requireValue(
    email(payerEmail),
    "Informe o e-mail do pagador usado quando o contato não tem e-mail.",
  );
  for (const [key, label] of [
    ["access_token", "o Access Token"],
    ["webhook_secret", "a assinatura secreta do webhook"],
  ] as const)
    requireValue(
      data[key] === undefined ||
        (typeof data[key] === "string" &&
          data[key].trim().length >= 8 &&
          data[key].length <= 500),
      `Confira ${label}.`,
    );
  const id = old?.id || uid(),
    at = now();
  const previous = old ? await accountCredentials(env, id) : null;
  const keys = {
    access_token: data.access_token?.trim() || previous?.access_token || "",
    webhook_secret:
      data.webhook_secret?.trim() || previous?.webhook_secret || "",
  };
  requireValue(keys.access_token, "Informe o Access Token de produção.");
  requireValue(
    keys.webhook_secret,
    "Informe a assinatura secreta do webhook (Suas integrações → Webhooks).",
  );
  await setSecret(env, secretId(id), keys);
  const enabled =
    data.enabled === undefined
      ? old
        ? !!old.enabled
        : true
      : data.enabled === true;
  await exec(
    env,
    "INSERT INTO payment_accounts(id,profile_id,provider,enabled,payer_email,created,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET enabled=excluded.enabled,payer_email=excluded.payer_email,checked=CASE WHEN ? THEN NULL ELSE checked END,updated=excluded.updated",
    id,
    profile,
    provider,
    enabled ? 1 : 0,
    payerEmail,
    at,
    at,
    data.access_token ? 1 : 0,
  );
  return accountView(env, await accountRow(env, profile));
}

/** Confere as credenciais no provedor e guarda o nome da conta. */
export async function checkPaymentAccount(
  env: Env,
  actor: Actor,
  profile: string,
) {
  admin(actor);
  const row = await accountRow(env, profile);
  requireValue(row, "Configure a conta de pagamento antes de testar.");
  const result = await providers[row.provider].test(
    await accountCredentials(env, row.id),
  );
  await exec(
    env,
    "UPDATE payment_accounts SET checked=?,updated=? WHERE id=?",
    JSON.stringify({ ...result, at: now() }),
    now(),
    row.id,
  );
  return accountView(env, await accountRow(env, profile));
}

// ---------------------------------------------------------------------------
// Cobrança

export function paymentView(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    provider: row.provider,
    method: row.method as PaymentMethod,
    module_id: row.module_id,
    ref_id: row.ref_id,
    description: row.description,
    amount_cents: row.amount_cents,
    currency: row.currency,
    status: row.status as PaymentStatus,
    provider_status: row.provider_status,
    review_required: row.provider_status === "refund_review_required",
    review_reason: row.provider_status === "refund_review_required" ? "refund_amount_unconfirmed" : null,
    pix_code: row.pix_code,
    url: row.url,
    trigger: row.trigger,
    actor: row.actor,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    created: row.created,
    updated: row.updated,
    // Só o gancho recebe a evidência conferida e o evento original persistido.
    evidence: null as PaymentEvidence | null,
    payment_event: null as PaymentHookEvent | null,
  };
}
export type Payment = NonNullable<ReturnType<typeof paymentView>>;

export interface ChargeInput {
  conversation: Conversation;
  method: PaymentMethod;
  amount_cents: number;
  description: string;
  /** Módulo e registro que a cobrança paga (pedido, mensalidade…). */
  module?: string | null;
  ref?: string | null;
  trigger: PaymentTrigger;
  actor: string;
  /** Repetir a chave devolve a mesma cobrança, sem cobrar de novo. */
  sourceKey: string;
  expiresMinutes?: number;
  /**
   * Linha oficial com a janela de 24 h fechada: envia como notificação (modelo
   * configurado) em vez de recusar. Para lembretes de módulos.
   */
  notification?: boolean;
  /**
   * false: o módulo manda o próprio comprovante no onPaymentUpdated e o
   * núcleo não envia o "Pagamento recebido". A nota interna continua.
   */
  receipt?: boolean;
}

/**
 * Se a área pode cobrar agora: módulo Cobrança ligado e conta ativa. Não
 * confere as credenciais no provedor (isso é Gestão → Cobrança → Testar).
 */
export async function paymentsReady(env: Env, profile: string) {
  if (!(await moduleEnabled(env, profile, PAYMENTS_MODULE)))
    return {
      ready: false,
      reason: "payments_disabled" as const,
      message:
        "O módulo Cobrança está desligado. Ligue-o em Gestão → Módulos e configure a conta em Gestão → Cobrança.",
      methods: [] as PaymentMethod[],
    };
  const account = await accountRow(env, profile);
  if (!account?.enabled)
    return {
      ready: false,
      reason: "payments_not_configured" as const,
      message:
        "Nenhuma conta de pagamento ativa. Configure o Mercado Pago em Gestão → Cobrança.",
      methods: [] as PaymentMethod[],
    };
  return {
    ready: true,
    reason: null,
    message: null,
    methods: [...providers[account.provider].methods] as PaymentMethod[],
  };
}

/**
 * Cancela uma cobrança aberta por um módulo (ctx.cancelCharge): a mesma
 * mudança do "Cancelar" da equipe. Já cancelada ou expirada: devolve como
 * está; paga ou estornada: 409 payment_closed.
 */
export async function cancelModulePayment(
  env: Env,
  profile: string,
  module: string,
  id: string,
) {
  const row = await one(
    env,
    "SELECT * FROM payments WHERE id=? AND profile_id=? AND module_id=?",
    id,
    profile,
    module,
  );
  if (!row) throw new ApiError(404, "not_found", "Cobrança não encontrada.");
  if (["cancelled", "expired"].includes(row.status)) return paymentView(row)!;
  if (!(await transition(env, row, "cancelled"))) {
    const current = await one(env, "SELECT * FROM payments WHERE id=?", id);
    if (["cancelled", "expired"].includes(current.status))
      return paymentView(current)!;
    throw new ApiError(
      409,
      "payment_closed",
      "A cobrança já foi paga ou estornada e não pode ser cancelada.",
    );
  }
  if (row.provider_ref)
    try {
      await providers[row.provider].cancel(
        await accountCredentials(env, row.account_id),
        row,
      );
    } catch {
      // Cancelada aqui; o provedor expira pela data.
    }
  return paymentView(await one(env, "SELECT * FROM payments WHERE id=?", id))!;
}

/** Cria a cobrança no provedor e envia ao cliente no WhatsApp. */
export async function createPayment(env: Env, input: ChargeInput) {
  const c = input.conversation;
  await requirePayments(env, c.profile_id);
  // Mesma chave: reaproveita a cobrança aberta e válida, ou a já paga (nunca
  // cobra duas vezes). Vencida ou cancelada vira cobrança nova, com chave
  // derivada (revisão B11: devolvia a cobrança velha sem reenviar).
  let sourceKey = input.sourceKey;
  let old = await one(
    env,
    "SELECT * FROM payments WHERE source_key=?",
    sourceKey,
  );
  for (let step = 0; old?.provider_ref && step < 20; step++) {
    const open = old.status === "created" && old.expires_at > now();
    // Aberta mas nunca entregue (o envio falhou depois de criar no provedor:
    // consentimento, política da linha), ou com o envio cancelado ou falho na
    // fila: tenta entregar de novo, com chave por tentativa (conferência B11
    // e segunda conferência, N2-4).
    const sends = open
      ? await all(
          env,
          "SELECT status FROM outbox WHERE dedupe=? OR dedupe LIKE ?",
          `payment:${old.id}`,
          `payment:${old.id}#%`,
        )
      : [];
    if (
      open &&
      old.conversation_id === c.id &&
      !sends.some((s) => !["cancelled", "failed"].includes(s.status))
    ) {
      const official = await interactiveLine(env, c);
      const windowOpen = now() - c.last_customer < 86400000;
      if (official && !windowOpen && !input.notification)
        throw new ApiError(
          409,
          "window_closed",
          "O cliente precisa ter escrito nas últimas 24 horas para receber a cobrança.",
        );
      await deliver(
        env,
        c,
        old,
        input.actor,
        official && !windowOpen,
        sends.length ? `#${sends.length}` : "",
      );
    }
    if (open || old.status === "paid" || old.status === "refunded")
      return { payment: paymentView(old)!, created: false };
    sourceKey = `${input.sourceKey}#${old.id}`;
    old = await one(
      env,
      "SELECT * FROM payments WHERE source_key=?",
      sourceKey,
    );
  }
  if (old?.provider_ref) return { payment: paymentView(old)!, created: false };
  requireValue(
    c.chat_type !== "group",
    "Cobranças são enviadas só em conversas individuais.",
  );
  requireValue(["pix", "link"].includes(input.method), "Escolha Pix ou link.");
  requireValue(
    Number.isInteger(input.amount_cents) &&
      input.amount_cents >= 1 &&
      input.amount_cents <= 100_000_00,
    "Informe um valor entre R$ 0,01 e R$ 100.000,00.",
  );
  const description = String(input.description || "").trim();
  requireValue(
    description && Array.from(description).length <= 120,
    "Informe a descrição da cobrança (até 120 caracteres).",
  );
  const account = await accountRow(env, c.profile_id);
  if (!account?.enabled)
    throw new ApiError(
      409,
      "payments_not_configured",
      "Configure a conta de pagamento em Gestão → Cobrança.",
    );
  const provider = providers[account.provider];
  requireValue(
    provider.methods.includes(input.method),
    "Forma de pagamento indisponível neste provedor.",
  );
  const official = await interactiveLine(env, c);
  const windowOpen = now() - c.last_customer < 86400000;
  if (official && !windowOpen && !input.notification)
    throw new ApiError(
      409,
      "window_closed",
      "O cliente precisa ter escrito nas últimas 24 horas para receber a cobrança.",
    );
  const origin = await publicOrigin(env);
  if (!origin)
    throw new ApiError(
      409,
      "origin_unknown",
      "O endereço público desta instalação ainda não é conhecido. Abra o painel pelo endereço usado pelos clientes e tente de novo.",
    );
  const ttl = Math.min(
    PAYMENT_TTL.max,
    Math.max(
      PAYMENT_TTL.min,
      Math.round(input.expiresMinutes || PAYMENT_TTL.default),
    ),
  );
  // A linha nasce antes da chamada: o id é a chave de idempotência no
  // provedor; uma falha de rede repetida com a mesma sourceKey não cobra duas
  // vezes.
  let row = old;
  if (!row) {
    const at = now();
    const id = uid();
    await exec(
      env,
      "INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,currency,status,trigger,actor,source_key,expires_at,receipt,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,'BRL','created',?,?,?,?,?,?,?)",
      id,
      c.profile_id,
      c.id,
      account.id,
      account.provider,
      input.method,
      input.module || null,
      input.ref || null,
      description,
      input.amount_cents,
      input.trigger,
      input.actor,
      sourceKey,
      at + ttl * 60000,
      input.receipt === false ? 0 : 1,
      at,
      at,
    );
    row = await one(env, "SELECT * FROM payments WHERE id=?", id);
  }
  const contact = await one(
    env,
    "SELECT ct.email FROM conversation_contacts l JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=l.profile_id WHERE l.conversation_id=?",
    c.id,
  );
  const request = {
    id: row.id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    description,
    payer_email: email(contact?.email) ? contact.email : account.payer_email,
    expires_at: row.expires_at,
    notification_url: origin + webhookPath(account.provider, account.id),
  };
  const creds = await accountCredentials(env, account.id);
  const created =
    input.method === "pix"
      ? await provider.createPix(creds, request)
      : await provider.createLink(creds, request);
  await exec(
    env,
    "UPDATE payments SET provider_ref=?,provider_status=?,pix_code=?,pix_qr=?,url=?,updated=? WHERE id=?",
    created.provider_ref,
    created.provider_status,
    created.pix_code || null,
    created.pix_qr || null,
    created.url || null,
    now(),
    row.id,
  );
  row = await one(env, "SELECT * FROM payments WHERE id=?", row.id);
  await deliver(env, c, row, input.actor, official && !windowOpen);
  await message(
    env,
    c,
    "note",
    "system",
    `Cobrança enviada: ${description} · ${money(row.amount_cents)} (${row.method === "pix" ? "Pix" : "link de pagamento"}).`,
  );
  await event(env, c.profile_id, "payment.created", row.id, paymentEvent(row));
  return { payment: paymentView(row)!, created: true };
}

/**
 * Cobrança sem conversa (conta a receber do ERP, src/erp/conversa/charges.ts):
 * cria o Pix ou o link no provedor e não envia nada ao cliente. A confirmação
 * é a mesma de sempre (webhook assinado, consulta na API, gancho do módulo).
 * Sem conversa, conversation_id fica vazio até o envio pela conversa ligá-la; a
 * nota interna e o "Pagamento recebido" só saem depois de ligada a uma.
 */
export async function createDetachedPayment(env: Env, input: {
  profile: string; method: PaymentMethod; amount_cents: number; description: string;
  module: string; ref: string; actor: string; sourceKey: string; expiresMinutes?: number; payerEmail?: string | null;
}) {
  await requirePayments(env, input.profile);
  let sourceKey = input.sourceKey;
  let old = await one(env, "SELECT * FROM payments WHERE source_key=?", sourceKey);
  // Mesma chave: a aberta e válida ou a paga voltam; vencida ou cancelada vira nova.
  for (let step = 0; old?.provider_ref && step < 20; step++) {
    if ((old.status === "created" && old.expires_at > now()) || old.status === "paid" || old.status === "refunded")
      return { payment: { ...paymentView(old)!, pix_qr: old.pix_qr ?? null }, created: false };
    sourceKey = `${input.sourceKey}#${old.id}`;
    old = await one(env, "SELECT * FROM payments WHERE source_key=?", sourceKey);
  }
  if (old && old.profile_id !== input.profile) throw new ApiError(409, "payment_conflict", "Esta cobrança pertence a outra área.");
  requireValue(["pix", "link"].includes(input.method), "Escolha Pix ou link.");
  requireValue(Number.isInteger(input.amount_cents) && input.amount_cents >= 1 && input.amount_cents <= 100_000_00,
    "A Cobrança aceita valores entre R$ 0,01 e R$ 100.000,00.");
  const description = Array.from(String(input.description || "").trim()).slice(0, 120).join("");
  requireValue(description, "Informe a descrição da cobrança.");
  const account = await accountRow(env, input.profile);
  if (!account?.enabled)
    throw new ApiError(409, "payments_not_configured", "Nenhuma conta de pagamento ativa. Configure o Mercado Pago em Gestão → Cobrança.");
  const provider = providers[account.provider];
  if (!provider.methods.includes(input.method))
    throw new ApiError(409, "payment_method_unavailable", "Esta forma de cobrança não existe no provedor configurado em Gestão → Cobrança.");
  const origin = await publicOrigin(env);
  if (!origin)
    throw new ApiError(409, "origin_unknown", "O endereço público desta instalação ainda não é conhecido. Abra o painel pelo endereço usado pelos clientes e tente de novo.");
  const ttl = Math.min(PAYMENT_TTL.max, Math.max(PAYMENT_TTL.min, Math.round(input.expiresMinutes || PAYMENT_TTL.default)));
  let row = old;
  if (!row) {
    const at = now(), id = uid();
    await exec(env,
      "INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,ref_id,description,amount_cents,currency,status,trigger,actor,source_key,expires_at,receipt,created,updated) VALUES(?,?,'',?,?,?,?,?,?,?,'BRL','created','module',?,?,?,1,?,?)",
      id, input.profile, account.id, account.provider, input.method, input.module, input.ref, description, input.amount_cents,
      input.actor, sourceKey, at + ttl * 60000, at, at);
    row = await one(env, "SELECT * FROM payments WHERE id=?", id);
  }
  const creds = await accountCredentials(env, account.id);
  const request = {
    id: row.id, amount_cents: row.amount_cents, currency: row.currency, description,
    payer_email: email(input.payerEmail) ? input.payerEmail! : account.payer_email,
    expires_at: row.expires_at, notification_url: origin + webhookPath(account.provider, account.id),
  };
  const created = input.method === "pix" ? await provider.createPix(creds, request) : await provider.createLink(creds, request);
  await exec(env, "UPDATE payments SET provider_ref=?,provider_status=?,pix_code=?,pix_qr=?,url=?,updated=? WHERE id=?",
    created.provider_ref, created.provider_status, created.pix_code || null, created.pix_qr || null, created.url || null, now(), row.id);
  row = await one(env, "SELECT * FROM payments WHERE id=?", row.id);
  await event(env, input.profile, "payment.created", row.id, paymentEvent(row));
  return { payment: { ...paymentView(row)!, pix_qr: row.pix_qr ?? null }, created: true };
}

/** Dados da cobrança para o módulo que a abriu (inclui o QR do Pix). */
export async function modulePayment(env: Env, profile: string, module: string, id: string) {
  const row = await one(env, "SELECT * FROM payments WHERE id=? AND profile_id=? AND module_id=?", id, profile, module);
  return row ? { ...paymentView(row)!, pix_qr: row.pix_qr ?? null } : null;
}

/** O que falta para a Cobrança confirmar pagamentos sozinha (null: nada). */
export async function paymentsMissing(env: Env, profile: string): Promise<{ code: string; message: string } | null> {
  const ready = await paymentsReady(env, profile);
  if (!ready.ready) return { code: ready.reason!, message: ready.message! };
  const account = await accountRow(env, profile);
  const keys = await accountCredentials(env, account.id);
  if (!keys.access_token) return { code: "payments_not_configured", message: "Falta o Access Token do Mercado Pago em Gestão → Cobrança." };
  if (!keys.webhook_secret)
    return { code: "payments_webhook_missing", message: "Falta a assinatura secreta do webhook em Gestão → Cobrança: sem ela, nenhum pagamento é confirmado." };
  return null;
}

const paymentEvent = (row: any, extra: Record<string, unknown> = {}) => ({
  id: row.id,
  conversation_id: row.conversation_id,
  module_id: row.module_id,
  ref_id: row.ref_id,
  method: row.method,
  amount_cents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  ...extra,
});

/** Mensagens ao cliente: botão com URL (oficial) ou link no texto (QR) e o Pix. */
async function deliver(
  env: Env,
  c: Conversation,
  row: any,
  actor: string,
  asNotification: boolean,
  // Reenvio depois de um envio cancelado (segunda conferência, N2-4): chave
  // nova por tentativa, para sair de novo e no máximo uma vez.
  suffix = "",
) {
  const value = money(row.amount_cents, row.currency);
  const pix = row.method === "pix";
  const body = pix
    ? `${row.description}\nValor: ${value}\n\nPague com Pix: toque no botão para ver o QR Code ou copie o código na próxima mensagem.`
    : `${row.description}\nValor: ${value}\n\nToque no botão para pagar.`;
  if (asNotification) {
    await enqueue(
      env,
      c,
      actor,
      "notification",
      {
        text: `${body}\n${row.url}${pix ? `\n\nPix copia e cola:\n${row.pix_code}` : ""}`,
        automation: "payment",
        payment_id: row.id,
        // Fora da janela, exige o consentimento de cobrança.
        consent_purpose: "billing",
      },
      `payment:${row.id}${suffix}`,
    );
    return;
  }
  if (row.url)
    await sendInteractive(
      env,
      actor,
      c,
      {
        type: "cta_url",
        body,
        display_text: pix ? "Ver QR Code Pix" : "Pagar agora",
        url: row.url,
      },
      `payment:${row.id}${suffix}`,
      "payment",
    );
  else
    await enqueue(
      env,
      c,
      actor,
      "text",
      { text: body, automation: "payment", payment_id: row.id },
      `payment:${row.id}${suffix}`,
    );
  // O código sozinho, para copiar e colar no app do banco.
  if (pix && row.pix_code)
    await enqueue(
      env,
      c,
      actor,
      "text",
      { text: row.pix_code, automation: "payment", payment_id: row.id },
      `payment-pix:${row.id}${suffix}`,
    );
}

// ---------------------------------------------------------------------------
// Mudanças de estado

const transitions: Record<string, PaymentStatus[]> = {
  paid: ["created", "expired", "cancelled"],
  refunded: ["created", "expired", "cancelled", "paid"],
  expired: ["created"],
  cancelled: ["created"],
};

/** Completa somente ganchos antigos que ainda aguardam entrega. */
function attachHookEvidence(paymentId: string, evidence: PaymentEvidence): Statement {
  return [
    "UPDATE payments SET hook_pending=(SELECT json_group_array(json(CASE WHEN (json_extract(value,'$.status')='paid' OR (json_extract(value,'$.status')='refunded' AND ? IS NOT NULL)) AND json_extract(value,'$.evidence_key') IS NULL THEN json_set(value,'$.evidence_key',CASE WHEN json_extract(value,'$.status')='paid' THEN ? ELSE ? END,'$.occurred_ms',CASE WHEN json_extract(value,'$.status')='paid' THEN ? ELSE ? END) ELSE value END)) FROM json_each(payments.hook_pending)) WHERE id=? AND hook_pending IS NOT NULL",
    [evidence.reverses_key, evidence.reverses_key ?? evidence.receipt_key,
      evidence.kind === "reverse" ? evidence.receipt_key : null,
      evidence.original?.occurred_ms ?? evidence.occurred_ms, evidence.occurred_ms, paymentId],
  ];
}

/**
 * Muda o estado com UPDATE condicionado (webhooks repetidos e corridas não
 * duplicam efeitos) e dispara evento, mensagens e o gancho do módulo.
 */
async function transition(
  env: Env,
  row: any,
  next: PaymentStatus,
  extra: {
    provider_status?: string;
    provider_payment_id?: string;
    paid_at?: number;
    evidence?: PaymentEvidence;
  } = {},
) {
  const from = transitions[next];
  if (!from?.includes(row.status)) return false;
  const evidence = extra.evidence;
  if ((next === "paid" || next === "refunded") &&
      (!evidence || evidence.payment_id !== row.id || evidence.kind !== (next === "paid" ? "receive" : "reverse")))
    throw new PaymentEvidenceError("payment_evidence_missing");
  const at = now();
  // O gancho do módulo entra na fila de pendentes no mesmo UPDATE (A3).
  const pending = JSON.stringify({
    id: evidence?.event_key ?? uid(),
    status: next,
    previous: row.status,
    occurred_ms: evidence?.occurred_ms ?? at,
    evidence_key: evidence?.receipt_key ?? null,
  });
  const paidAt = evidence?.original?.occurred_ms ?? evidence?.occurred_ms ?? extra.paid_at;
  let fresh: any;
  try {
    const results = await batch(env, [
      ["UPDATE payments SET status=?,provider_status=coalesce(?,provider_status),provider_payment_id=coalesce(?,provider_payment_id),paid_at=coalesce(paid_at,?),updated=?,hook_pending=CASE WHEN module_id IS NULL THEN NULL ELSE json_insert(coalesce(hook_pending,'[]'),'$[' || json_array_length(coalesce(hook_pending,'[]')) || ']',json(?)) END,hook_next_at=NULL WHERE id=? AND status=? AND provider_payment_id IS ? RETURNING *",
        [next, extra.provider_status ?? null, extra.provider_payment_id ?? null,
          evidence ? paidAt : null, at, pending, row.id, row.status, row.provider_payment_id ?? null]],
      ...(!evidence ? [["SELECT CASE WHEN changes()=1 THEN 1 ELSE json('payment_state_conflict') END", []] as Statement] : []),
      ...(evidence ? [...paymentEvidenceStatements(evidence, true), ...(json(row.hook_pending, []).some((entry: any) => !entry.evidence_key) ? [attachHookEvidence(row.id, evidence)] : [])] : []),
    ]);
    fresh = results[0].results[0];
  } catch (error) {
    // D1 não fornece o literal de json inválido em todas as versões.
    if (!evidence && /malformed JSON|payment_state_conflict/i.test(String(error))) return false;
    if (/malformed JSON|payment_(state|evidence)_conflict/i.test(String(error)))
      throw new PaymentEvidenceError("payment_state_conflict");
    throw error;
  }
  await event(
    env,
    fresh.profile_id,
    `payment.${next}`,
    fresh.id,
    paymentEvent(fresh, { previous_status: row.status }),
    `payment.${next}:${fresh.id}`,
  );
  let c: Conversation | null = null;
  try {
    const row = await one(env, `SELECT c.*,
      (SELECT json_object('id',p.id,'name',p.name,'settings',p.settings,'enabled',p.enabled,'created',p.created,
        'module_states',(SELECT json_group_object(module_id,enabled) FROM profile_modules WHERE profile_id=p.id)) FROM profiles p WHERE p.id=c.profile_id) profile_json,
      (SELECT json_object('config',config) FROM connections WHERE id=c.connection_id) connection_json,
      (SELECT json_object('connection_id',connection_id) FROM meta_numbers WHERE connection_id=c.connection_id) number_json,
      (SELECT json_object('timezone',a.timezone) FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=c.connection_id) timezone_json
      FROM conversations c WHERE c.id=? AND c.profile_id=?`, fresh.conversation_id, fresh.profile_id);
    if (row) {
      const { profile_json, connection_json, number_json, timezone_json, ...record } = row;
      c = record as Conversation;
      const profile = json(profile_json, null);
      if (profile) {
        const states = typeof profile.module_states === "string" ? json(profile.module_states, {}) : profile.module_states ?? {};
        profile.module_states = JSON.stringify(states);
        seedRead(env, { sql: PROFILE_SETTINGS_SQL, args: [fresh.profile_id], first: true }, [profile]);
        seedRead(env, { sql: MODULE_STATES_SQL, args: [fresh.profile_id] }, Object.entries(states).map(([module_id, enabled]) => ({ module_id, enabled })));
      }
      for (const [sql, payload] of [
        ["SELECT config FROM connections WHERE id=?", connection_json],
        ["SELECT connection_id FROM meta_numbers WHERE connection_id=?", number_json],
        ["SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=?", timezone_json],
      ]) seedRead(env, { sql, args: [c.connection_id], first: true }, payload ? [JSON.parse(payload)] : []);
    }
  } catch {
    c = null;
  }
  if (c) {
    const value = money(fresh.amount_cents, fresh.currency);
    const notes: Record<string, string> = {
      paid: `Pagamento confirmado pelo provedor: ${fresh.description} · ${value}.`,
      refunded: `Pagamento estornado: ${fresh.description} · ${value}.`,
      expired: `Cobrança expirou sem pagamento: ${fresh.description} · ${value}.`,
      cancelled: `Cobrança cancelada: ${fresh.description} · ${value}.`,
    };
    await message(env, c, "note", "system", notes[next]);
    // receipt: false → o módulo manda o próprio comprovante.
    if (next === "paid" && fresh.receipt !== 0)
      try {
        await enqueue(
          env,
          c,
          "system",
          "notification",
          {
            text: `Pagamento recebido: ${value} (${fresh.description}). Obrigado!`,
            automation: "payment",
            payment_id: fresh.id,
            consent_purpose: "billing",
          },
          `payment-paid:${fresh.id}`,
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
  }
  if (fresh.module_id)
    await deliverPaymentHooks(env, fresh.id);
  return true;
}

/**
 * O pagamento em duplicidade foi estornado (o que a nota pede): marca na
 * lista, publica payment.duplicate_refunded e deixa nota, uma vez. A
 * cobrança continua paga pelo pagamento original (conferência N-1).
 */
async function recordDuplicateRefund(env: Env, row: any, remoteId: string, evidence: PaymentEvidence) {
  if (!(json(row.duplicate_payments, []) as { id: string }[]).some(item => item.id === remoteId)) return false;
  const [marked] = await batch(env, [
    ["UPDATE payments SET duplicate_payments=(SELECT json_group_array(CASE WHEN json_extract(value,'$.id')=? THEN json_set(value,'$.refunded_at',?) ELSE json(value) END) FROM json_each(payments.duplicate_payments)),updated=? WHERE id=? AND EXISTS (SELECT 1 FROM json_each(coalesce(payments.duplicate_payments,'[]')) WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.refunded_at') IS NULL)",
      [remoteId, evidence.occurred_ms, now(), row.id, remoteId]],
    ...paymentEvidenceStatements(evidence),
  ]);
  if (!marked.meta?.changes) return false;
  const fresh = await one(env, "SELECT * FROM payments WHERE id=?", row.id);
  await event(
    env,
    fresh.profile_id,
    "payment.duplicate_refunded",
    fresh.id,
    paymentEvent(fresh, { duplicate_provider_payment_id: remoteId }),
    `payment.duplicate_refunded:${fresh.id}:${remoteId}`,
  );
  try {
    const c = await conversation(env, fresh.conversation_id, fresh.profile_id);
    await message(
      env,
      c,
      "note",
      "system",
      `Pagamento em duplicidade estornado (pagamento ${remoteId} no provedor). A cobrança ${fresh.description} continua paga pelo pagamento original.`,
    );
  } catch {
    // Cobrança sem conversa: fica o evento.
  }
  return true;
}

/**
 * Segundo pagamento aprovado da mesma cobrança (link pago duas vezes): outro
 * id no provedor. Guarda, publica payment.duplicate e avisa a equipe numa
 * nota interna para estornar; cada id só uma vez (revisão M8).
 */
async function recordDuplicate(
  env: Env,
  row: any,
  remote: { id: string; amount_cents: number },
  evidence: PaymentEvidence,
) {
  const entry = JSON.stringify({
    id: String(remote.id),
    amount_cents: remote.amount_cents,
    at: evidence.occurred_ms,
    evidence_key: evidence.receipt_key,
  });
  const [result] = await batch(env, [
    ["UPDATE payments SET duplicate_payments=json_insert(coalesce(duplicate_payments,'[]'),'$[' || json_array_length(coalesce(duplicate_payments,'[]')) || ']',json(?)),updated=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM json_each(coalesce(payments.duplicate_payments,'[]')) WHERE json_extract(value,'$.id')=?)",
      [entry, now(), row.id, String(remote.id)]],
    ...paymentEvidenceStatements(evidence),
  ]);
  if (!result.meta?.changes) return false;
  const fresh = await one(env, "SELECT * FROM payments WHERE id=?", row.id);
  await event(
    env,
    fresh.profile_id,
    "payment.duplicate",
    fresh.id,
    paymentEvent(fresh, {
      duplicate_provider_payment_id: String(remote.id),
      duplicate_amount_cents: remote.amount_cents,
      needs_refund: true,
    }),
    `payment.duplicate:${fresh.id}:${remote.id}`,
  );
  try {
    const c = await conversation(env, fresh.conversation_id, fresh.profile_id);
    await message(
      env,
      c,
      "note",
      "system",
      `Pagamento em duplicidade: ${fresh.description} foi pago de novo (${money(remote.amount_cents, fresh.currency)}, pagamento ${remote.id} no provedor). Estorne o valor a mais pelo painel do Mercado Pago.`,
    );
  } catch {
    // Cobrança sem conversa: fica o evento.
  }
  return true;
}

/** Até 1 h entre tentativas; depois de HOOK_MAX_ATTEMPTS, só o reenvio do webhook. */
const HOOK_MAX_ATTEMPTS = 30;
const hookDelay = (attempts: number) =>
  Math.min(60_000 * 2 ** attempts, 3_600_000);

/**
 * Roda, em ordem, os ganchos onPaymentUpdated pendentes da cobrança. Cada
 * entrada sai da fila só depois de o gancho concluir (os ganchos são
 * idempotentes por chave); a falha fica registrada e é repetida pelo alarme
 * ou pelo reenvio do webhook. Devolve false se algum ficou pendente.
 */
export async function deliverPaymentHooks(env: Env, paymentId: string) {
  for (let step = 0; step < 10; step++) {
    const token = uid();
    const row = await one(env, `UPDATE payments SET hook_pending=json_set(hook_pending,'$[0].lease_token',?,'$[0].lease_until_ms',?)
      WHERE id=? AND json_array_length(hook_pending)>0 AND coalesce(json_extract(hook_pending,'$[0].lease_until_ms'),0)<=?
      RETURNING *, (SELECT payload FROM events WHERE profile_id=payments.profile_id AND kind='payment.evidence'
        AND source_key='payment.evidence:' || json_extract(payments.hook_pending,'$[0].evidence_key')) hook_evidence_json`,
      token, now() + 60_000, paymentId, now());
    if (!row) {
      const current = await one(env, "SELECT hook_pending FROM payments WHERE id=?", paymentId);
      return !json(current?.hook_pending, []).length;
    }
    const queue: (PaymentHookEvent & { evidence_key?: string })[] = json(row.hook_pending, []);
    const entry = queue[0];
    const hook = row.module_id ? paymentHook(row.module_id) : undefined;
    try {
      if (!hook) throw new PaymentEvidenceError("payment_hook_missing");
      const evidence = entry.evidence_key
        ? parsePaymentEvidence(row.hook_evidence_json, row.profile_id, entry.evidence_key) : null;
      // Ganchos legados sem evidência concluem o efeito local; o produtor
      // registra payment_evidence_required sem fabricar recibo comercial.
      if (evidence && (evidence.payment_id !== row.id || evidence.module_id !== row.module_id || evidence.ref_id !== row.ref_id ||
          evidence.amount_cents !== row.amount_cents || evidence.currency !== row.currency ||
          evidence.kind !== (entry.status === "paid" ? "receive" : "reverse")))
        throw new PaymentEvidenceError("payment_evidence_conflict");
      // Resolver este Promise confirma o commit local do produtor: mutação,
      // recibo e saída no mesmo batch. Não chamar o ERP dentro deste gancho.
      await hook(
        env,
        row.profile_id,
        { ...paymentView(row), status: entry.status, evidence,
          paid_at: evidence ? (evidence.original?.occurred_ms ?? evidence.occurred_ms) : row.paid_at,
          payment_event: { id: entry.id, status: entry.status, previous: entry.previous, occurred_ms: entry.occurred_ms ?? row.updated },
        },
        entry.previous,
      );
    } catch (error) {
      const safe = paymentHookFailure(error);
      const failed = await exec(
        env,
        "UPDATE payments SET hook_pending=json_remove(hook_pending,'$[0].lease_token','$[0].lease_until_ms'),hook_attempts=hook_attempts+1,hook_next_at=?,hook_error=? WHERE id=? AND json_extract(hook_pending,'$[0].id')=? AND json_extract(hook_pending,'$[0].lease_token')=?",
        now() + hookDelay(row.hook_attempts || 0),
        safe.message,
        paymentId,
        entry.id,
        token,
      );
      if (!failed.meta?.changes) return false;
      console.error(
        JSON.stringify({
          component: "payments",
          error: safe.code,
        }),
      );
      // Última tentativa automática (conferência N-10): avisa a equipe uma
      // vez; o efeito no módulo ficou pendente e só o reenvio do webhook (ou
      // a equipe) resolve.
      if ((row.hook_attempts || 0) + 1 === HOOK_MAX_ATTEMPTS)
        await hookExhausted(env, row, entry.status, safe.message);
      return false;
    }
    const finished = await one(
      env,
      "UPDATE payments SET hook_pending=CASE WHEN json_array_length(hook_pending)<=1 THEN NULL ELSE json_remove(hook_pending,'$[0]') END,hook_attempts=0,hook_next_at=NULL,hook_error=NULL WHERE id=? AND json_extract(hook_pending,'$[0].id')=? AND json_extract(hook_pending,'$[0].lease_token')=? RETURNING hook_pending",
      paymentId,
      entry.id,
      token,
    );
    if (!finished) return false;
    if (!json(finished.hook_pending, []).length) return true;
  }
  return false;
}

async function hookExhausted(
  env: Env,
  row: any,
  status: string,
  error: string,
) {
  await event(
    env,
    row.profile_id,
    "payment.hook_failed",
    row.id,
    paymentEvent(row, {
      hook_status: status,
      error,
      attempts: HOOK_MAX_ATTEMPTS,
    }),
    `payment.hook_failed:${row.id}:${status}`,
  );
  try {
    const c = await conversation(env, row.conversation_id, row.profile_id);
    await message(
      env,
      c,
      "note",
      "system",
      `O módulo não concluiu o efeito da cobrança depois de ${HOOK_MAX_ATTEMPTS} tentativas: ${error}. Confira o pedido, a reserva ou a mensalidade e conclua à mão.`,
    );
  } catch {
    // Cobrança sem conversa: fica o evento.
  }
}

/** Alarme da área: repete os ganchos de pagamento que ficaram pendentes. */
export async function retryPaymentHooks(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT id FROM payments WHERE profile_id=? AND hook_pending IS NOT NULL AND hook_attempts<? AND coalesce(hook_next_at,0)<=? ORDER BY updated LIMIT 10",
    profile,
    HOOK_MAX_ATTEMPTS,
    now(),
  ))
    await deliverPaymentHooks(env, row.id);
}

/**
 * Webhook recebido e assinado: consulta o pagamento na API do provedor e só
 * então muda o estado. Roda no Coordinator da área.
 */
export async function refreshFromProvider(
  env: Env,
  accountId: string,
  providerPaymentId: string,
) {
  env = withReadCache(env);
  const account = await one(
    env,
    "SELECT a.*,(SELECT value FROM secrets WHERE id=?) credentials_cipher FROM payment_accounts a WHERE a.id=?",
    secretId(accountId), accountId,
  );
  if (!account) return { ignored: "account" };
  let remote: VerifiedProviderPayment;
  try {
    const keys = account.credentials_cipher ? await unseal(env, account.credentials_cipher) : {};
    remote = await providers[account.provider].getPayment({
      access_token: String(keys.access_token || ""), webhook_secret: String(keys.webhook_secret || ""),
    }, providerPaymentId);
  } catch {
    // O erro do adaptador pode incluir resposta bruta, credencial ou texto privado.
    throw new PaymentEvidenceError("provider_unavailable");
  }
  if (remote.id !== providerPaymentId || !["paid", "refunded", "pending", "rejected", "expired", "cancelled"].includes(remote.state))
    throw new PaymentEvidenceError("payment_evidence_invalid");
  const receiptKey = providerReceiptKey(account.profile_id, account.provider, account.id, remote.id);
  let known = remote.external_reference ? undefined : await readPaymentEvidence(env, account.profile_id, receiptKey);
  const reference = remote.external_reference ?? known?.payment_id;
  const referenced = reference
    ? await one(env, `SELECT p.*,(SELECT payload FROM events WHERE profile_id=p.profile_id AND kind='payment.evidence' AND source_key=?) evidence_json
      FROM payments p WHERE p.id=? AND p.account_id=?`, `payment.evidence:${receiptKey}`, reference, account.id) : null;
  known ??= parsePaymentEvidence(referenced?.evidence_json, account.profile_id, receiptKey);
  if (!referenced) return { ignored: "unknown_payment" };
  if (referenced.profile_id !== account.profile_id || referenced.provider !== account.provider)
    throw new PaymentEvidenceError("payment_evidence_conflict");
  if (
    !Number.isSafeInteger(remote.amount_cents) || remote.amount_cents <= 0 ||
    remote.amount_cents !== referenced.amount_cents ||
    remote.currency !== referenced.currency
  ) {
    console.error(
      JSON.stringify({
        component: "payments",
        error: "amount_mismatch",
      }),
    );
    return { ignored: "amount_mismatch" };
  }
  if (remote.refund_review_required || remote.state === "refunded" && remote.refunded_amount_cents != null && remote.refunded_amount_cents !== remote.amount_cents) {
    const at = now();
    await batch(env, [
      ["UPDATE payments SET provider_status='refund_review_required',updated=? WHERE id=? AND profile_id=?", [at, referenced.id, account.profile_id]],
      eventStatement(account.profile_id, "payment.refund_review", referenced.id,
        { payment_id: referenced.id, reason_code: "refund_amount_unconfirmed", amount_cents: Number.isSafeInteger(remote.refunded_amount_cents) && remote.refunded_amount_cents! >= 0 ? remote.refunded_amount_cents : null },
        `payment.refund_review:${receiptKey}`),
    ]);
    // A fila histórica continua avançando; não enfileira estorno inventado.
    await deliverPaymentHooks(env, referenced.id);
    return { status: referenced.status, changed: false, review_required: true, ignored: "refund_amount_unconfirmed" };
  }
  // Preservar códigos conhecidos, jamais um texto livre devolvido pelo provedor.
  const providerStatus = ["approved", "pending", "in_process", "authorized", "in_mediation", "rejected", "cancelled", "expired", "refunded", "charged_back"].includes(remote.raw_status)
    ? remote.raw_status : remote.state;
  const extra = {
    provider_status: providerStatus,
    provider_payment_id: remote.id,
    ...(remote.paid_at ? { paid_at: remote.paid_at } : {}),
  };
  const next: PaymentStatus | null =
    remote.state === "paid"
      ? "paid"
      : remote.state === "refunded"
        ? "refunded"
        : remote.state === "expired"
          ? "expired"
          : remote.state === "cancelled"
            ? "cancelled"
            : null;
  // O CAS e a identidade remota disputam a mesma transação. Quem perde relê
  // o vencedor e retoma seu gancho, sem outra evidência nem outro proprietário.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let row = attempt === 0 ? referenced : await one(env, "SELECT * FROM payments WHERE id=?", referenced.id);
      if (!row) return { ignored: "unknown_payment" };
      const evidence = next === "paid" || next === "refunded"
        ? await preparePaymentEvidence(env, row, remote, now(), attempt === 0 ? known : undefined) : null;
      if (evidence && evidence.payment_id !== row.id) {
        row = await one(env, "SELECT * FROM payments WHERE id=? AND profile_id=? AND account_id=? AND provider=?",
          evidence.payment_id, account.profile_id, account.id, account.provider);
        if (!row || row.module_id !== evidence.module_id || row.ref_id !== evidence.ref_id || row.amount_cents !== evidence.amount_cents || row.currency !== evidence.currency)
          throw new PaymentEvidenceError("payment_evidence_conflict");
      }
      if (!next) {
        await exec(env, "UPDATE payments SET provider_status=?,updated=? WHERE id=?", providerStatus, now(), row.id);
        if (row.hook_pending) await deliverPaymentHooks(env, row.id);
        return { status: row.status, changed: false };
      }
      // Outro pagamento aprovado da mesma cobrança (link pago duas vezes).
      if (next === "paid" && (row.status === "paid" || row.status === "refunded") &&
          row.provider_payment_id && remote.id !== row.provider_payment_id) {
        const recorded = await recordDuplicate(env, row, remote, evidence!);
        if (row.hook_pending) await deliverPaymentHooks(env, row.id);
        return { status: row.status, changed: false, duplicate: recorded };
      }
      // Estorno/cancelamento de outra tentativa não desfaz o pagamento original.
      if (next !== "paid" && row.provider_payment_id && remote.id !== row.provider_payment_id) {
        const duplicate = next === "refunded"
          ? await recordDuplicateRefund(env, row, remote.id, evidence!) : false;
        if (row.hook_pending) await deliverPaymentHooks(env, row.id);
        return { status: row.status, changed: false, ignored: duplicate ? "duplicate_refunded" : "other_payment" };
      }
      // Tentativa de checkout cancelada/vencida não fecha o link ainda pagável.
      if ((next === "cancelled" || next === "expired") && row.method === "link" && row.status === "created") {
        if (row.hook_pending) await deliverPaymentHooks(env, row.id);
        return { status: row.status, changed: false, ignored: "attempt" };
      }
      // Estorno primeiro: original e reversão no mesmo lote, um só gancho.
      // Não há estado intermediário pago que possa liberar o serviço.
      const changed = await transition(env, row, next, { ...extra, ...(evidence ? { evidence } : {}) });
      let recovered = false;
      if (!changed && evidence) {
        // Uma consulta real pode completar a pendência de um gancho legado já
        // entregue. Só essa pendência autoriza repetir o mesmo efeito local.
        const status = evidence.kind === "receive" ? "paid" : "refunded";
        const pendingKey = paymentPendingEventKey({ profile: row.profile_id, module: row.module_id as IntegrationModule, source_id: row.ref_id, component: "main" }, row.id, status);
        const recovery = { id: `recovery:${evidence.receipt_key}`, status, previous: row.status,
          occurred_ms: evidence.occurred_ms, evidence_key: evidence.receipt_key };
        const results = await batch(env, [...paymentEvidenceStatements(evidence), attachHookEvidence(row.id, evidence),
          [`UPDATE payments SET hook_pending=json_array(json(?)),hook_next_at=NULL WHERE id=? AND status=?
            AND coalesce(json_array_length(hook_pending),0)=0 AND EXISTS(
              SELECT 1 FROM module_erp_events e JOIN module_erp_delivery d ON d.event_id=e.id
              WHERE e.profile_id=payments.profile_id AND e.module_id=payments.module_id
                AND d.state='blocked' AND d.error_code='payment_evidence_required'
                AND (e.event_key=? OR json_extract(e.payload_json,'$.receipt_key')=?))`,
            [JSON.stringify(recovery), row.id, status, pendingKey, evidence.receipt_key]],
        ]);
        recovered = results.at(-1)!.meta.changes === 1;
      }
      if (!changed && (row.hook_pending || recovered)) await deliverPaymentHooks(env, row.id);
      return { status: changed ? next : row.status, changed };
    } catch (error) {
      if ((error instanceof PaymentEvidenceError && error.code === "payment_state_conflict") ||
          /malformed JSON|payment_evidence_conflict/i.test(String(error))) {
        if (attempt < 2) continue;
        throw new PaymentEvidenceError("payment_state_conflict");
      }
      throw error;
    }
  }
  throw new PaymentEvidenceError("payment_state_conflict");
}

/** Alarme da área: cobranças vencidas viram expired (e são canceladas no provedor). */
export async function expirePayments(env: Env, profile: string) {
  for (const row of await all(
    env,
    "SELECT * FROM payments WHERE profile_id=? AND status='created' AND expires_at<=? LIMIT 20",
    profile,
    now(),
  )) {
    if (!(await transition(env, row, "expired"))) continue;
    if (row.provider_ref)
      try {
        await providers[row.provider].cancel(
          await accountCredentials(env, row.account_id),
          row,
        );
      } catch {
        // Melhor esforço: o provedor também expira a cobrança pela data.
      }
  }
}

/** payment.cancel: atendente ou integração cancela uma cobrança aberta. */
export async function cancelPayment(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "conversations:write");
  const row = await one(
    env,
    "SELECT * FROM payments WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Cobrança não encontrada.");
  const c = await conversation(env, row.conversation_id, profile, actor);
  // Cobrança aberta por um módulo (sinal da Reserva, Pix do Pedido, compra do
  // Suporte): cancelar fora do fluxo do módulo só o administrador, quem
  // atende a conversa ou aplicação com billing:write (revisão B6).
  if (
    row.module_id &&
    !(actor.kind === "user" && actor.role === "admin") &&
    !(actor.kind === "user" && c.owner === actor.id) &&
    !(actor.kind === "app" && actor.scopes.includes("billing:write"))
  )
    throw new ApiError(
      403,
      "forbidden",
      "Esta cobrança foi aberta por um módulo: só o administrador, quem atende a conversa ou uma integração com billing:write pode cancelar.",
    );
  if (!(await transition(env, row, "cancelled")))
    throw new ApiError(
      409,
      "payment_closed",
      "Só cobranças abertas podem ser canceladas.",
    );
  if (row.provider_ref)
    try {
      await providers[row.provider].cancel(
        await accountCredentials(env, row.account_id),
        row,
      );
    } catch {
      // A cobrança já está cancelada aqui; o provedor expira pela data.
    }
  return paymentView(await one(env, "SELECT * FROM payments WHERE id=?", id));
}

export async function listPayments(
  env: Env,
  actor: Actor,
  profile: string,
  conversationId: string,
) {
  access(actor, profile, "conversations:read");
  await conversation(env, conversationId, profile, actor);
  return {
    data: (
      await all(
        env,
        "SELECT * FROM payments WHERE profile_id=? AND conversation_id=? ORDER BY created DESC,id DESC LIMIT 50",
        profile,
        conversationId,
      )
    ).map(paymentView),
  };
}

export async function getPayment(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "conversations:read");
  const row = await one(
    env,
    "SELECT * FROM payments WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!row) throw new ApiError(404, "not_found", "Cobrança não encontrada.");
  await conversation(env, row.conversation_id, profile, actor);
  return { ...paymentView(row), pix_qr: row.pix_qr };
}

/** Webhook do provedor: valida a assinatura e devolve o id notificado. */
export async function verifyPaymentWebhook(
  env: Env,
  providerId: string,
  accountId: string,
  input: WebhookInput,
) {
  const account = await one(
    env,
    "SELECT * FROM payment_accounts WHERE id=? AND provider=?",
    accountId,
    providerId,
  );
  if (!account) throw new ApiError(404, "not_found", "Conta não encontrada.");
  const { paymentId } = await providers[account.provider].verifyWebhook(
    await accountCredentials(env, account.id),
    input,
  );
  return { account, paymentId };
}
