// Interface pública de Vendas para os módulos que dependem dele (Caixa hoje;
// o Pedido, se um dia ligar itens do cardápio a produtos). Contrato estável:
// mudança que quebre algo daqui sobe a `version` de vendas e ajusta os
// dependentes na mesma entrega (docs/MODULOS.md, "Dependência entre módulos").
// Todas as funções agem como o módulo "vendas" (eventos, cobranças e ganchos
// de pagamento ficam com ele), mesmo chamadas de dentro de outro módulo:
// recebem o `ModuleContext` do chamador só para achar a área.
import type { Actor } from "../../types";
import { modulesApi, type ModuleContext } from "../api";
import {
  catalogGrid as grid,
  productByCode as byCode,
  type ProductView,
} from "./catalog";
import {
  createSale as create,
  registerSaleGuard,
  returnSale as giveBack,
  saleView,
  sessionRecords,
  loadSale,
  type SaleGuard,
  type SaleView,
} from "./sales";
import { PAYMENT_LABELS, vendasSettings, type PaymentMethod } from "./model";
import {
  outOfStock,
  stockStatements,
  stockFailure,
  type StockChange,
} from "./stock";
import { batch } from "../../db";

export type { SaleView, ProductView, PaymentMethod, SaleGuard };
export { PAYMENT_LABELS };

const vendas = (ctx: ModuleContext) =>
  modulesApi(ctx.env, ctx.profile, "vendas");

/** Grade de venda por toque: categorias e produtos ativos. */
export const catalogGrid = (ctx: ModuleContext) => grid(vendas(ctx));

/** Produto ativo pelo EAN ou SKU (leitor de código de barras); 404 sem. */
export const productByCode = (ctx: ModuleContext, code: unknown) =>
  byCode(vendas(ctx), code);

/** Formas de pagamento ligadas nas regras de vendas da área. */
export async function paymentMethods(ctx: ModuleContext) {
  const cfg = vendasSettings(await vendas(ctx).settings());
  return (Object.keys(cfg.payment_methods) as PaymentMethod[])
    .filter((m) => cfg.payment_methods[m])
    .map((id) => ({ id, label: PAYMENT_LABELS[id] }));
}

export interface SaleRequest {
  lines: unknown;
  discount_cents?: unknown;
  discount_percent?: unknown;
  payments?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  customer_document?: unknown;
  conversation_id?: unknown;
  note?: unknown;
  notes?: unknown;
}

/**
 * Venda numa sessão do Caixa: mesmas regras de POST /vendas/sales (estoque
 * atômico, limite de desconto, formas de pagamento), com `session_id`.
 * `sourceKey` deriva do requestId do comando do Caixa.
 */
export const createSessionSale = (
  ctx: ModuleContext,
  actor: Actor,
  sessionId: string,
  request: SaleRequest,
  sourceKey: string,
) =>
  create(vendas(ctx), actor, {
    ...request,
    source: "caixa",
    session_id: sessionId,
    sourceKey,
  });

/** Devolução com o dinheiro saindo do caixa da sessão aberta. */
export const returnInSession = (
  ctx: ModuleContext,
  actor: Actor,
  saleId: string,
  sessionId: string,
  data: { items?: unknown; method?: unknown; reason?: unknown },
  requestId: string,
) =>
  giveBack(vendas(ctx), actor, { ...data, id: saleId }, requestId, {
    session_id: sessionId,
  });

/** Venda pelo id (para conferir a sessão). */
export const sale = async (ctx: ModuleContext, id: string) =>
  saleView(await loadSale(vendas(ctx), id));

/** Vendas e devoluções de uma sessão do Caixa, para os totais. */
export const sessionSales = (ctx: ModuleContext, sessionId: string) =>
  sessionRecords(vendas(ctx), sessionId);

/**
 * Trava de cancelamento/devolução registrada pelo dependente no
 * carregamento (o Caixa recusa venda de sessão fechada).
 */
export { registerSaleGuard };

/**
 * Baixa ou devolução de estoque por chave, para outro módulo que venda
 * produtos do catálogo (ex.: o Pedido com itens ligados a produtos). Cada
 * `key` é única na área: repetir não baixa de novo (devolve
 * `{applied: false}`); sem saldo, nada muda e lança 409 out_of_stock.
 */
export async function moveStock(
  ctx: ModuleContext,
  actor: string,
  items: { product_id: string; quantity_milli: number; key: string }[],
  kind: "venda" | "devolucao",
  ref: { type: "sale" | "return"; id: string },
) {
  const v = vendas(ctx);
  const changes: StockChange[] = items.map((i) => ({
    product_id: i.product_id,
    delta_milli: kind === "venda" ? -i.quantity_milli : i.quantity_milli,
    type: kind,
    key: i.key,
    ref_type: ref.type,
    ref_id: ref.id,
  }));
  try {
    await batch(v.env, stockStatements(v, changes, actor));
  } catch (error) {
    const failure = stockFailure(error);
    if (failure === "duplicate") return { applied: false };
    if (failure === "insufficient")
      throw await outOfStock(
        v,
        items.map((i) => ({ product_id: i.product_id, quantity_milli: i.quantity_milli })),
      );
    throw error;
  }
  return { applied: true };
}
