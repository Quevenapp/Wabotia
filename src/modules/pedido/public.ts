// Interface pública do Pedido para módulos que dependem dele (Mesas, Entrega).
// Contrato estável (docs/MODULOS.md, "Dependência entre módulos"): o módulo
// dependente declara `requires: ["pedido"]` e usa só o que está aqui, nunca
// as tabelas pedido_. Todas as funções agem como o módulo "pedido" (eventos
// pedido.*, quadro da cozinha, histórico), mesmo chamadas de outro módulo.
import { all, batch } from "../../db";
import { ApiError, type Env, now } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import { validateCartOrder, validateCatalog } from "../../web-cart";
import { cartCategories, loadMenu } from "./menu";
import { linesToCartInput } from "./manage";
import {
  createOrder,
  orderView,
  visibleOrder,
  type OrderLine,
  type OrderView,
} from "./orders";

export { dateTimeOf, money } from "./model";
export { center, pair, wrap, TICKET_COLUMNS } from "./ticket";
export type { OrderLine, OrderView };

const ctxOf = (env: Env, profile: string) => modulesApi(env, profile, "pedido");

/** Pedido ligado na área. */
export const pedidoAvailable = (env: Env, profile: string) =>
  ctxOf(env, profile).enabled();

export interface TableOrderInput {
  tab_id: string;
  /** Nome da mesa no quadro da cozinha e na comanda ("Mesa 5"). */
  table_label: string;
  /** Mesmo formato do pedido de balcão: [{item_id, quantity, options, note}]. */
  items: unknown;
  /** Observação do pedido inteiro (vai para a comanda). */
  note?: string;
  /** Nome do cliente da mesa; sem ele, o nome da mesa. */
  customer_name?: string;
  /** Repetir a mesma chave devolve o pedido já criado. */
  sourceKey: string;
  actor: string;
}

/**
 * Pedido lançado pelo garçom numa conta de mesa. Itens do cardápio atual
 * (esgotado é recusado), com as mesmas montagens (`slot`), adicionais e
 * observações do carrinho; valores calculados no servidor. Nasce "Recebido"
 * no quadro da cozinha, sem conversa e sem cobrança: `payment.status` "tab"
 * até a conta da mesa fechar (settleTabOrders). Erros: 400 (item, adicionais,
 * quantidade), 404 (item fora do cardápio), 409 empty_menu.
 */
export async function createTableOrder(
  env: Env,
  profile: string,
  input: TableOrderInput,
): Promise<{ order: OrderView; created: boolean }> {
  const ctx = ctxOf(env, profile);
  await ctx.requireEnabled();
  const categories = cartCategories(await loadMenu(ctx));
  if (!categories)
    throw new ApiError(
      409,
      "empty_menu",
      "Cadastre o cardápio do Pedido antes de lançar pedidos na mesa.",
    );
  const catalog = validateCatalog({
    categories,
    fulfillment: {
      pickup: true,
      delivery: false,
      delivery_fee_cents: 0,
      minimum_cents: 0,
    },
  });
  const cart = linesToCartInput(catalog, input.items as any[]);
  Object.assign(cart, {
    fulfillment: ["pickup"],
    name: [
      Array.from((input.customer_name || input.table_label).trim())
        .slice(0, 80)
        .join(""),
    ],
    note: [input.note || ""],
  });
  const checked = validateCartOrder(catalog, cart);
  if (!checked.ok)
    throw new ApiError(
      400,
      "invalid_request",
      Object.values(checked.errors).join(" "),
    );
  const o = checked.order;
  const { order, created } = await createOrder(ctx, {
    conversation: null,
    customer_name: o.customer_name,
    source: "table",
    sourceKey: input.sourceKey,
    lines: o.lines as OrderLine[],
    item_count: o.item_count,
    subtotal_cents: o.subtotal_cents,
    delivery_fee_cents: 0,
    total_cents: o.subtotal_cents,
    fulfillment: "table",
    address: null,
    note: o.note,
    actor: input.actor,
    tab: { id: input.tab_id, label: input.table_label },
  });
  return { order: orderView(order), created };
}

/** Pedidos de uma conta de mesa (inclusive cancelados), do mais antigo. */
export async function tabOrders(
  env: Env,
  profile: string,
  tabId: string,
): Promise<OrderView[]> {
  const rows = await all(
    env,
    "SELECT * FROM pedido_orders WHERE profile_id=? AND tab_id=? ORDER BY number LIMIT 500",
    profile,
    tabId,
  );
  return rows.map((row) => orderView(row));
}

export interface TabTotals {
  /** Soma dos pedidos não cancelados. */
  subtotal_cents: number;
  item_count: number;
  /** Pedidos não cancelados. */
  orders: number;
  /** Ainda na cozinha (recebido ou em preparo). */
  kitchen: number;
  /** Prontos para servir. */
  ready: number;
}

/**
 * Totais dos pedidos ainda não acertados (payment.status "tab") de todas as
 * contas da área, numa consulta: o mapa das mesas.
 */
export async function openTabTotals(
  env: Env,
  profile: string,
): Promise<Map<string, TabTotals>> {
  const rows = await all(
    env,
    "SELECT tab_id,coalesce(sum(CASE WHEN status<>'cancelled' THEN total_cents ELSE 0 END),0) subtotal_cents,coalesce(sum(CASE WHEN status<>'cancelled' THEN item_count ELSE 0 END),0) item_count,coalesce(sum(status<>'cancelled'),0) orders,coalesce(sum(status IN ('received','preparing')),0) kitchen,coalesce(sum(status='ready'),0) ready FROM pedido_orders WHERE profile_id=? AND tab_id IS NOT NULL AND payment_status='tab' GROUP BY tab_id",
    profile,
  );
  return new Map(
    rows.map((r) => [
      r.tab_id as string,
      {
        subtotal_cents: r.subtotal_cents,
        item_count: r.item_count,
        orders: r.orders,
        kitchen: r.kitchen,
        ready: r.ready,
      },
    ]),
  );
}

/**
 * Passa os pedidos ainda não acertados de uma conta para outra (junção de
 * mesas) ou só troca o nome da mesa (transferência: `from` = `to`).
 */
export async function moveTabOrders(
  env: Env,
  profile: string,
  from: string,
  to: string,
  label: string,
) {
  await batch(env, [
    [
      "UPDATE pedido_orders SET tab_id=?,table_label=?,customer_name=CASE WHEN customer_name=table_label THEN ? ELSE customer_name END,updated=? WHERE profile_id=? AND tab_id=? AND payment_status='tab'",
      [to, label, label, now(), profile, from],
    ],
  ]);
}

/**
 * Conta fechada: os pedidos da conta ficam pagos (os cancelados, com a
 * cobrança cancelada). Um pedido cancelado depois disso fica com
 * `needs_refund`, como qualquer pedido pago.
 */
export async function settleTabOrders(
  env: Env,
  profile: string,
  tabId: string,
  actor: string,
) {
  const at = now();
  await batch(env, [
    [
      "UPDATE pedido_orders SET payment_status='paid',paid_at=?,paid_by=?,updated=? WHERE profile_id=? AND tab_id=? AND payment_status='tab' AND status<>'cancelled'",
      [at, actor, at, profile, tabId],
    ],
    [
      "UPDATE pedido_orders SET payment_status='cancelled',updated=? WHERE profile_id=? AND tab_id=? AND payment_status='tab'",
      [at, profile, tabId],
    ],
  ]);
}

/** Visão do pedido para o ator (telefone e notas internas como no Pedido). */
export const orderForActor = (
  ctx: ModuleContext,
  actor: Parameters<typeof visibleOrder>[1],
  order: OrderView,
) => visibleOrder(ctx, actor, order);

// Ganchos para a Entrega (docs/PEDIDO.md, "Para outros módulos").
export {
  onOrderStatusChanged,
  onStatusNotice,
  provideDeliveryInfo,
  provideDeliverySlip,
  type DeliveryInfo,
  type DeliverySlip,
  type DeliverySlipRequest,
  type StatusChange,
  type StatusNotice,
} from "./listeners";
