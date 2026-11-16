// Vendas: linhas de orçamento e de venda (cópia do produto no momento), com
// preço, desconto por linha e da venda, e o limite de desconto da equipe.
import { ApiError, type Actor, json, requireValue } from "../../types";
import type { ModuleContext } from "../api";
import { productsByIds } from "./catalog";
import {
  cents,
  fromMilli,
  lineCents,
  milli,
  text,
  vendasSettings,
  type ProductFiscal,
} from "./model";

export const MAX_LINES = 200;

export interface Line {
  index: number;
  product_id: string | null;
  name: string;
  sku: string | null;
  ean: string | null;
  unit: string;
  quantity_milli: number;
  unit_cents: number;
  /** Preço × quantidade. */
  gross_cents: number;
  discount_cents: number;
  /** Bruto menos o desconto da linha. */
  total_cents: number;
  /** Total da linha menos a parte do desconto da venda (para devoluções). */
  net_cents: number;
  /** Só produtos do catálogo com controle de estoque baixam saldo. */
  track_stock: boolean;
  cost_cents: number | null;
  fiscal: ProductFiscal;
  returned_milli: number;
  returned_cents: number;
}

export interface Totals {
  lines: Line[];
  subtotal_cents: number;
  /** Descontos das linhas + da venda. */
  discount_cents: number;
  sale_discount_cents: number;
  total_cents: number;
}

const isAdmin = (actor: Actor) =>
  actor.kind === "user" && actor.role === "admin";

/**
 * Monta as linhas a partir do pedido do cliente/equipe:
 * - `{product_id, quantity, discount_cents?, unit_cents?}`: produto do
 *   catálogo, ativo; preço do catálogo, salvo `unit_cents` (outro preço).
 * - `{name, quantity, unit_cents}`: item avulso (serviço, frete), sem estoque.
 * Outro preço e item avulso: administrador, ou `freePrices` (orçamento, em
 * que o cliente aprova o valor). `fixed` reaproveita linhas já precificadas
 * (orçamento convertido em venda).
 */
export async function buildLines(
  ctx: ModuleContext,
  actor: Actor,
  input: any,
  options: { freePrices?: boolean } = {},
): Promise<Line[]> {
  requireValue(
    Array.isArray(input) && input.length >= 1 && input.length <= MAX_LINES,
    `Informe de 1 a ${MAX_LINES} itens (lines).`,
  );
  const ids = input
    .map((l: any) => l?.product_id)
    .filter((id: unknown) => typeof id === "string");
  const products = await productsByIds(ctx, ids);
  const free = options.freePrices || isAdmin(actor);
  return input.map((raw: any, index: number): Line => {
    requireValue(raw && typeof raw === "object", "Item inválido.");
    const product =
      raw.product_id !== undefined && raw.product_id !== null
        ? products.get(String(raw.product_id))
        : null;
    if (raw.product_id !== undefined && raw.product_id !== null && !product)
      throw new ApiError(404, "not_found", "Produto não encontrado no catálogo.");
    if (product && !product.active)
      throw new ApiError(
        409,
        "product_inactive",
        `"${product.name}" está arquivado e não pode ser vendido.`,
      );
    const name = product
      ? product.name
      : text(raw.name, 120, `o nome do item ${index + 1}`, true);
    const quantity = milli(raw.quantity, `Quantidade de "${name}"`, {
      fractional: product ? !!product.fractional : true,
    });
    let unit = product ? product.price_cents : null;
    if (raw.unit_cents !== undefined && raw.unit_cents !== null) {
      const asked = cents(raw.unit_cents, `o preço de "${name}"`);
      if (asked !== unit)
        requireValue(
          free,
          `Só administradores mudam o preço de "${name}". Use desconto.`,
        );
      unit = asked;
    }
    if (!product)
      requireValue(
        free,
        "Só administradores incluem item fora do catálogo numa venda.",
      );
    requireValue(unit !== null, `Informe o preço de "${name}" (unit_cents).`);
    const gross = lineCents(unit!, quantity);
    const discount =
      raw.discount_cents === undefined || raw.discount_cents === null
        ? 0
        : cents(raw.discount_cents, `o desconto de "${name}"`);
    requireValue(
      discount <= gross,
      `O desconto de "${name}" é maior que o valor do item.`,
    );
    return {
      index,
      product_id: product?.id ?? null,
      name,
      sku: product?.sku ?? null,
      ean: product?.ean ?? null,
      unit: product?.unit ?? "UN",
      quantity_milli: quantity,
      unit_cents: unit!,
      gross_cents: gross,
      discount_cents: discount,
      total_cents: gross - discount,
      net_cents: gross - discount,
      track_stock: !!product?.track_stock,
      cost_cents: product?.cost_cents ?? null,
      fiscal: product ? json(product.fiscal, {}) : {},
      returned_milli: 0,
      returned_cents: 0,
    };
  });
}

/**
 * Totais com o desconto da venda (`discount_cents` ou `discount_percent`),
 * rateado nas linhas (net_cents) para as devoluções. Equipe sem ser
 * administrador: desconto total até `max_discount_percent` do bruto.
 */
export async function applyTotals(
  ctx: ModuleContext,
  actor: Actor,
  lines: Line[],
  data: { discount_cents?: unknown; discount_percent?: unknown },
  options: { skipLimit?: boolean } = {},
): Promise<Totals> {
  const subtotal = lines.reduce((s, l) => s + l.gross_cents, 0);
  const afterLines = lines.reduce((s, l) => s + l.total_cents, 0);
  let saleDiscount = 0;
  if (data.discount_percent !== undefined && data.discount_percent !== null) {
    const p = data.discount_percent;
    requireValue(
      typeof p === "number" && p >= 0 && p <= 100,
      "Desconto em percentual: de 0 a 100.",
    );
    saleDiscount = Math.round((afterLines * (p as number)) / 100);
  } else if (data.discount_cents !== undefined && data.discount_cents !== null)
    saleDiscount = cents(data.discount_cents, "o desconto da venda");
  requireValue(
    saleDiscount <= afterLines,
    "O desconto é maior que o total dos itens.",
  );
  const discount = subtotal - afterLines + saleDiscount;
  if (!options.skipLimit && !isAdmin(actor) && discount > 0) {
    const cfg = vendasSettings(await ctx.settings());
    const max = Math.floor((subtotal * cfg.max_discount_percent) / 100);
    if (discount > max)
      throw new ApiError(
        403,
        "discount_limit",
        `Desconto acima do limite da equipe (${cfg.max_discount_percent}% do valor dos itens). Peça a um administrador.`,
      );
  }
  // Rateio do desconto da venda pelas linhas, na proporção do total de cada
  // uma; a última fica com o resto do arredondamento.
  let left = saleDiscount;
  lines.forEach((line, i) => {
    const share =
      i === lines.length - 1
        ? left
        : afterLines
          ? Math.min(
              left,
              Math.floor((saleDiscount * line.total_cents) / afterLines),
            )
          : 0;
    line.net_cents = line.total_cents - share;
    left -= share;
  });
  return {
    lines,
    subtotal_cents: subtotal,
    discount_cents: discount,
    sale_discount_cents: saleDiscount,
    total_cents: afterLines - saleDiscount,
  };
}

/** Linha na API (sem dados fiscais nem custo). */
export const lineView = (line: Line) => ({
  index: line.index,
  product_id: line.product_id,
  name: line.name,
  sku: line.sku,
  ean: line.ean,
  unit: line.unit,
  quantity: fromMilli(line.quantity_milli),
  unit_cents: line.unit_cents,
  gross_cents: line.gross_cents,
  discount_cents: line.discount_cents,
  total_cents: line.total_cents,
  net_cents: line.net_cents,
  returned_quantity: fromMilli(line.returned_milli || 0),
  returned_cents: line.returned_cents || 0,
});
