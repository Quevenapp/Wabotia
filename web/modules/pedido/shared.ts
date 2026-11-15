// Pedido no painel: nomes dos estados, tons e formatos (o mesmo contrato de
// src/modules/pedido/model.ts).
import type { PillTone } from "../../ui/controls";

export const activeStatuses = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready",
  "out_for_delivery",
] as const;

export const statusOrder = [
  ...activeStatuses,
  "delivered",
  "cancelled",
] as const;

export const statusLabels: Record<string, string> = {
  awaiting_payment: "Aguardando pagamento",
  received: "Recebido",
  preparing: "Em preparo",
  ready: "Pronto para retirada",
  out_for_delivery: "Saiu para entrega",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

/** Rótulo curto das colunas do quadro. */
export const columnLabels: Record<string, string> = {
  awaiting_payment: "Aguardando pagamento",
  received: "Novos",
  preparing: "Em preparo",
  ready: "Prontos para retirada",
  out_for_delivery: "Saíram para entrega",
};

export const statusTones: Record<string, PillTone> = {
  awaiting_payment: "warn",
  received: "brand",
  preparing: "bot",
  ready: "ok",
  out_for_delivery: "ticket",
  delivered: "muted",
  cancelled: "muted",
};

/** Texto do botão que leva a cada estado. */
export const moveLabels: Record<string, string> = {
  received: "Enviar para o preparo",
  preparing: "Começar preparo",
  ready: "Pronto para retirada",
  out_for_delivery: "Saiu para entrega",
  delivered: "Entregue",
  cancelled: "Cancelar pedido",
};

export const paymentLabels: Record<string, string> = {
  pix: "Pix",
  link: "Cartão pelo link",
  cash: "Dinheiro",
  card: "Cartão na maquininha",
};

export const paymentTones: Record<string, PillTone> = {
  choosing: "warn",
  pending: "muted",
  awaiting: "warn",
  paid: "ok",
  expired: "danger",
  failed: "danger",
  refunded: "muted",
  cancelled: "muted",
};

export const weekdays = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];

export const money = (cents: number | null | undefined) =>
  typeof cents === "number"
    ? (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "—";

/** "12,50" ou "12.5" → 1250 centavos; inválido → null. */
export function cents(value: string): number | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 100)
    : null;
}
/** 1250 → "12,50" (campo de valor). */
export const centsInput = (value: number | null | undefined) =>
  typeof value === "number" ? (value / 100).toFixed(2).replace(".", ",") : "";

export const clock = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleTimeString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const phoneLabel = (digits: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits || "—";
};

/** "há 12 min", "há 1 h 05 min". */
export function since(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}
