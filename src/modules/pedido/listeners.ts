// Ganchos do Pedido para outros módulos (Entrega, por exemplo), expostos em
// ./public.ts. O módulo que registra é quem é chamado: o Pedido só chama
// quando ele está ligado na área (e o próprio Pedido roda), então registrar
// não exige `requires: ["pedido"]`. Uma falha num gancho nunca derruba o
// Pedido: é registrada no log e o Pedido segue como se o gancho não
// existisse. Os ganchos devem ser idempotentes (uma mudança de estado pode
// ser anunciada de novo depois de uma falha, revisão A3).
import type { Env } from "../../types";
import { moduleEnabled } from "../registry";
import type { OrderStatus } from "./model";

/** Pedido no formato da API (docs/API.md, Pedido); `any` para não prender o tipo. */
type Order = Record<string, any>;

export interface StatusChange {
  order: Order;
  from: OrderStatus;
  to: OrderStatus;
  /** Pessoa, aplicação, "provider" ou "system". */
  actor: string;
  note: string;
}

export interface StatusNotice {
  order: Order;
  /** Estado avisado (a mensagem configurada desse estado). */
  status: OrderStatus;
  /** Texto pronto (Gestão → Cardápio e loja → Mensagens), já preenchido. */
  text: string;
  conversation_id: string;
  /** Chave do envio do Pedido; derive dela para não repetir mensagem. */
  key: string;
}

export interface DeliveryInfo {
  /** Estado da entrega no módulo que a acompanha (pending, en_route…). */
  status: string;
  status_label: string;
  courier_id: string | null;
  courier_name: string | null;
  /** Previsão de chegada (ms) e minutos que faltam, se houver. */
  eta_at: number | null;
  eta_minutes: number | null;
  /** Hora da última posição do entregador (ms). */
  position_at: number | null;
}

interface Registered<T> {
  module: string;
  fn: T;
}

type StatusListener = (
  env: Env,
  profile: string,
  change: StatusChange,
) => Promise<void>;
type NoticeHandler = (
  env: Env,
  profile: string,
  notice: StatusNotice,
) => Promise<boolean>;
type DeliveryProvider = (
  env: Env,
  profile: string,
  orderIds: string[],
) => Promise<Map<string, DeliveryInfo>>;

const statusListeners: Registered<StatusListener>[] = [];
const noticeHandlers: Registered<NoticeHandler>[] = [];
const deliveryProviders: Registered<DeliveryProvider>[] = [];

function add<T>(list: Registered<T>[], module: string, fn: T) {
  const entry = { module, fn };
  list.push(entry);
  return () => {
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

function logFailure(module: string, hook: string, error: unknown) {
  console.error(
    JSON.stringify({
      component: "pedido",
      hook,
      module,
      error: String((error as Error)?.message || error).slice(0, 300),
    }),
  );
}

/**
 * Depois de cada mudança de estado gravada (quadro da cozinha, pagamento,
 * tarefa periódica, outro módulo). Ex.: a Entrega encerra a entrega aberta
 * quando a cozinha marca "Entregue" ou "Cancelado". Devolve a função que
 * desfaz o registro.
 */
export const onOrderStatusChanged = (
  module: string,
  listener: StatusListener,
) => add(statusListeners, module, listener);

/**
 * Antes de o Pedido mandar ao cliente o aviso de um estado. Devolver true
 * diz que o módulo já mandou esse aviso (por exemplo "Saiu para entrega" com
 * o botão Acompanhar numa mensagem só) e o Pedido não manda o dele. false ou
 * erro: o Pedido manda o texto dele, como sempre.
 */
export const onStatusNotice = (module: string, handler: NoticeHandler) =>
  add(noticeHandlers, module, handler);

/**
 * Entregador e previsão de chegada dos pedidos com entrega, para o quadro da
 * cozinha e o detalhe do pedido (`delivery`). Uma chamada por leitura, com
 * todos os pedidos de entrega em andamento.
 */
export const provideDeliveryInfo = (
  module: string,
  provider: DeliveryProvider,
) => add(deliveryProviders, module, provider);

async function active<T>(env: Env, profile: string, list: Registered<T>[]) {
  const out: Registered<T>[] = [];
  for (const entry of list)
    if (await moduleEnabled(env, profile, entry.module)) out.push(entry);
  return out;
}

export async function emitStatusChange(
  env: Env,
  profile: string,
  change: StatusChange,
) {
  if (!statusListeners.length) return;
  for (const entry of await active(env, profile, statusListeners))
    try {
      await entry.fn(env, profile, change);
    } catch (error) {
      logFailure(entry.module, "status", error);
    }
}

/** true: um módulo já avisou o cliente; o Pedido não manda o texto dele. */
export async function noticeHandled(
  env: Env,
  profile: string,
  notice: StatusNotice,
) {
  if (!noticeHandlers.length) return false;
  for (const entry of await active(env, profile, noticeHandlers))
    try {
      if (await entry.fn(env, profile, notice)) return true;
    } catch (error) {
      logFailure(entry.module, "notice", error);
    }
  return false;
}

export async function deliveryInfo(
  env: Env,
  profile: string,
  orderIds: string[],
): Promise<Map<string, DeliveryInfo>> {
  const out = new Map<string, DeliveryInfo>();
  if (!deliveryProviders.length || !orderIds.length) return out;
  for (const entry of await active(env, profile, deliveryProviders))
    try {
      for (const [id, info] of await entry.fn(env, profile, orderIds))
        if (!out.has(id)) out.set(id, info);
    } catch (error) {
      logFailure(entry.module, "delivery", error);
    }
  return out;
}
