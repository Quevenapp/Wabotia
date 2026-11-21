// Produção (ordem de produção): as contas puras, sem banco. Quantidades em
// BigInt na escala 6 (como o Estoque), percentuais na escala 6 e custos na
// escala 10 (o preço do Estoque). Arredondamento metade para longe do zero,
// como o numeric do Postgres (engine/dec.ts).
import { formatScaled, rescale, toScaled } from "../../engine/dec.ts";

export const QTY = 6;
export const COST = 10;
const HUNDRED = 100n * 10n ** 6n; // 100% na escala 6

export const ORDER_STATUSES = ["draft", "released", "in_progress", "done", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const STATUS_LABELS: Readonly<Record<OrderStatus, string>> = Object.freeze({
  draft: "Rascunho", released: "Liberada", in_progress: "Em produção", done: "Concluída", cancelled: "Cancelada",
});
/** Situações em que a ordem ainda conta como produção prevista (planejamento). */
export const OPEN_STATUSES: readonly OrderStatus[] = ["draft", "released", "in_progress"];

const QTY_TEXT = /^(0|[1-9][0-9]{0,11})([.,][0-9]{1,6})?$/;
const MONEY_TEXT = /^(0|[1-9][0-9]{0,12})([.,][0-9]{1,10})?$/;

/** "12,5" ou "12.5" (até 12 inteiros e 6 casas) → escala 6; inválido: null. */
export function parseQuantity(value: unknown): bigint | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !QTY_TEXT.test(text.trim())) return null;
  return toScaled(text.trim().replace(",", "."), QTY);
}
/** Valor em reais (até 13 inteiros e 10 casas) → escala 10; inválido: null. */
export function parseMoney(value: unknown): bigint | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !MONEY_TEXT.test(text.trim())) return null;
  return toScaled(text.trim().replace(",", "."), COST);
}
export const qtyText = (v: bigint) => formatScaled(v, QTY);
export const costText = (v: bigint) => formatScaled(v, COST);

/**
 * Consumo de um insumo: quantidade por unidade × quantidade produzida ×
 * (1 + perda/100), na escala 6. Ex.: 0,25 kg por bolo, 10 bolos, 4% de perda → 2,6 kg.
 */
export function consumption(perUnit: bigint, quantity: bigint, lossPercent: bigint): bigint {
  // perUnit (6) × quantity (6) × (100% + perda) (6) = escala 18; ÷ 100% (escala 6) → escala 18 − 6 = 12 → escala 6.
  return roundDiv(perUnit * quantity * (HUNDRED + lossPercent), HUNDRED * 10n ** 6n);
}
/** round(n/d) com metade para longe do zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  const negative = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n, b = d < 0n ? -d : d;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return negative ? -q : q;
}

/** Custo de uma linha: quantidade (escala 6) × custo unitário (escala 10) → escala 10. */
export const lineCost = (quantity: bigint, unitCost: bigint) => rescale(quantity * unitCost, QTY + COST, COST);

/**
 * Custo unitário do acabado: (custo dos insumos + custo adicional) ÷
 * quantidade produzida, na escala 10 e arredondado às casas do preço de
 * entrada (Preferências › Empresa: casas decimais do preço de entrada).
 */
export function unitCost(total: bigint, quantity: bigint, decimals = 10): bigint {
  if (quantity <= 0n) throw new RangeError("Quantidade produzida precisa ser maior que zero.");
  const exact = roundDiv(total * 10n ** BigInt(QTY), quantity); // escala 10 + 6 − 6 = 10
  const places = Math.max(0, Math.min(10, decimals));
  return rescale(rescale(exact, COST, places), places, COST);
}

/** O que falta de um insumo: necessidade menos o disponível, nunca negativo. */
export const shortage = (needed: bigint, available: bigint) => (needed > available ? needed - available : 0n);

/** Próxima situação de uma ordem depois de um apontamento ou de um estorno. */
export function statusAfter(current: OrderStatus, produced: bigint, quantity: bigint, finish: boolean): OrderStatus {
  if (current === "cancelled") return current;
  if (produced > 0n && (finish || produced >= quantity)) return "done";
  if (produced > 0n) return "in_progress";
  return current === "done" || current === "in_progress" ? "released" : current;
}

/** Ações de situação da ordem: de onde cada uma parte e para onde vai. */
export const STATUS_ACTIONS: Readonly<Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>> = Object.freeze({
  release: { from: ["draft"], to: "released" },
  back_to_draft: { from: ["released"], to: "draft" },
  start: { from: ["draft", "released"], to: "in_progress" },
  finish: { from: ["in_progress"], to: "done" },
  cancel: { from: ["draft", "released", "in_progress"], to: "cancelled" },
});

/** Em que situação a ordem ainda aceita editar dados e insumos. */
export const editableStatus = (status: string) => status === "draft" || status === "released" || status === "in_progress";
/** Em que situação a ordem aceita apontar produção. */
export const completableStatus = (status: string) => status === "draft" || status === "released" || status === "in_progress";
