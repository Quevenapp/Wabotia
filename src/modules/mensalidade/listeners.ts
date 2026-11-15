// Avisos internos da Mensalidade para módulos que dependem dela (Suporte):
// parcela paga pelo provedor ou por baixa manual. Registrados ao carregar o
// módulo dependente; chamados no Coordinator da área, logo depois da baixa.
import { one } from "../../db";
import type { Env } from "../../types";

export type InstallmentPaid = {
  id: string;
  subscription_id: string;
  payer_id: string | null;
  period_key: string;
  amount_cents: number;
  /** pix | link (provedor) ou manual (equipe). */
  paid_via: string;
  paid_by: string;
  paid_at: number;
  /**
   * Conversa em que a cobrança paga foi feita (null na baixa manual). Quem
   * libera algo pela parcela confere que é a mesma conversa (ou um telefone
   * autorizado do pagador).
   */
  conversation_id: string | null;
  /** Contratação pelo WhatsApp que gerou a parcela, se foi o caso. */
  contract_id: string | null;
};

type Listener = (
  env: Env,
  profile: string,
  installment: InstallmentPaid,
) => Promise<void>;

const listeners = new Map<string, Listener>();

/** Um ouvinte por módulo (registrar de novo substitui). */
export function onInstallmentPaid(module: string, listener: Listener) {
  listeners.set(module, listener);
}

/** Relê a parcela paga (com o pagador) e avisa os ouvintes. */
export async function announcePaid(
  env: Env,
  profile: string,
  id: string,
  origin: {
    conversation_id?: string | null;
    contract_id?: string | null;
    /** Gancho de pagamento: a falha de um ouvinte faz o núcleo repetir. */
    rethrow?: boolean;
  } = {},
) {
  const row = await one(
    env,
    "SELECT i.*,s.payer_id FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id WHERE i.id=? AND i.profile_id=? AND i.status='paid'",
    id,
    profile,
  );
  if (!row) return;
  await notifyInstallmentPaid(
    env,
    profile,
    {
      id: row.id,
      subscription_id: row.subscription_id,
      payer_id: row.payer_id,
      period_key: row.period_key,
      amount_cents: row.amount_cents,
      paid_via: row.paid_via,
      paid_by: row.paid_by,
      paid_at: row.paid_at,
      conversation_id: origin.conversation_id ?? null,
      contract_id: origin.contract_id ?? null,
    },
    { rethrow: origin.rethrow },
  );
}

export type InstallmentRefunded = {
  id: string;
  subscription_id: string;
  payment_id: string;
  amount_cents: number;
};
type RefundListener = (
  env: Env,
  profile: string,
  installment: InstallmentRefunded,
) => Promise<void>;
const refundListeners = new Map<string, RefundListener>();

/** Pagamento de parcela estornado pelo provedor (a parcela volta a ficar devida). */
export function onInstallmentRefunded(
  module: string,
  listener: RefundListener,
) {
  refundListeners.set(module, listener);
}

/**
 * Roda todos os ouvintes; a falha de um não impede os outros. Com `rethrow`
 * (gancho de pagamento, que o núcleo repete até concluir), a primeira falha
 * sobe depois de todos rodarem, para o gancho ser repetido; os ouvintes são
 * idempotentes. Na baixa manual a falha só vai para o log.
 */
async function runListeners<T extends { id: string }>(
  map: Map<
    string,
    (env: Env, profile: string, installment: T) => Promise<void>
  >,
  env: Env,
  profile: string,
  installment: T,
  extra: Record<string, unknown>,
  rethrow: boolean,
) {
  let failure: unknown = null;
  for (const [module, listener] of map)
    try {
      await listener(env, profile, installment);
    } catch (error) {
      failure ??= error;
      console.error(
        JSON.stringify({
          component: "mensalidade-listener",
          module,
          installment: installment.id,
          ...extra,
          error: String((error as Error)?.message || error),
        }),
      );
    }
  if (failure && rethrow) throw failure;
}

export const notifyInstallmentRefunded = (
  env: Env,
  profile: string,
  installment: InstallmentRefunded,
  options: { rethrow?: boolean } = {},
) =>
  runListeners(
    refundListeners,
    env,
    profile,
    installment,
    { refunded: true },
    options.rethrow === true,
  );

export const notifyInstallmentPaid = (
  env: Env,
  profile: string,
  installment: InstallmentPaid,
  options: { rethrow?: boolean } = {},
) =>
  runListeners(
    listeners,
    env,
    profile,
    installment,
    {},
    options.rethrow === true,
  );
