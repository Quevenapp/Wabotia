// Frete: o rastreio em palavras de quem usa, a situação normalizada de cada
// evento dos Correios e do Melhor Envio, o próximo horário de consulta e o
// texto do aviso ao cliente pelo WhatsApp. Puro (sem banco nem rede): os
// testes do Node importam este arquivo.
import type { TrackingEvent, TrackingStatus } from "./provider.ts";

export const TRACKING_LABEL: Readonly<Record<TrackingStatus, string>> = Object.freeze({
  label_created: "Etiqueta gerada", posted: "Postado", in_transit: "Em trânsito", out_for_delivery: "Saiu para entrega",
  waiting_pickup: "Aguardando retirada", delivered: "Entregue", exception: "Problema na entrega", returned: "Devolvido ao remetente", cancelled: "Cancelado",
});
/** Situações em que o rastreio para de ser consultado. */
export const TRACKING_FINAL: readonly TrackingStatus[] = ["delivered", "returned", "cancelled"];

/** Evento dos Correios (SRO, código + tipo + descrição) na situação normalizada. */
export function correiosStatus(code: string, type: string, description: string): TrackingStatus {
  const c = code.toUpperCase(), d = description.toLowerCase();
  if (/devolvido ao remetente|devolu[cç][aã]o ao remetente/.test(d) || (c === "BDE" && type === "23")) return "returned";
  if (["BDE", "BDI", "BDR"].includes(c) && type === "01") return "delivered";
  if (/entregue ao destinat/.test(d)) return "delivered";
  if (c === "OEC") return "out_for_delivery";
  if (c === "LDI" || c === "LDE" || /aguardando retirada|dispon[ií]vel para retirada/.test(d)) return "waiting_pickup";
  if (c === "PO" || /postado/.test(d)) return "posted";
  if (["BDE", "BDI", "BDR", "FC"].includes(c)) return "exception";
  return "in_transit";
}

/** Situação do pedido no Melhor Envio (o agregador dá a situação e as datas, não a lista de eventos). */
export function melhorEnvioStatus(status: string): TrackingStatus {
  switch (status) {
    case "posted": return "posted";
    case "delivered": return "delivered";
    case "canceled": case "cancelled": return "cancelled";
    case "undelivered": return "exception";
    case "returned": return "returned";
    case "released": case "generated": case "printed": case "pending": return "label_created";
    default: return "in_transit";
  }
}

/** A situação mais recente da linha do tempo (o último evento por data). */
export function latestStatus(events: readonly Pick<TrackingEvent, "at" | "status">[]): TrackingStatus | null {
  let last: Pick<TrackingEvent, "at" | "status"> | null = null;
  for (const e of events) if (!last || e.at >= last.at) last = e;
  return last?.status ?? null;
}

/** Chave de um evento: o mesmo evento lido de novo não entra duas vezes. */
export const eventKey = (e: Pick<TrackingEvent, "at" | "code" | "description">) => `${e.at}|${e.code}|${e.description}`;

const HOUR = 3_600_000;
/** Consulta a cada 3 horas; falha seguida espera mais (até 12 horas). */
export function nextCheck(now: number, failures: number) {
  return now + Math.min(12, 3 * 2 ** Math.min(failures, 2)) * HOUR;
}
/** Envio expedido há mais disso sem chegar ao fim deixa de ser consultado (a tela ainda atualiza à mão). */
export const TRACKING_MAX_AGE_MS = 90 * 24 * HOUR;

/** O aviso ao cliente, em palavras simples. */
export function trackingMessage(input: { customer: string | null; order_number: number; status: TrackingStatus; description: string; location: string | null; tracking_code: string }) {
  const name = input.customer?.trim().split(/\s+/)[0];
  const where = input.location ? ` (${input.location})` : "";
  const what = input.status === "delivered" ? "foi entregue" : input.status === "out_for_delivery" ? "saiu para entrega" : input.status === "posted" ? "foi postado"
    : input.status === "waiting_pickup" ? "está aguardando retirada" : input.status === "returned" ? "voltou para nós" : input.status === "exception" ? "teve um problema na entrega" : "está a caminho";
  return `${name ? `Olá, ${name}! ` : "Olá! "}Seu pedido ${input.order_number} ${what}: ${input.description}${where}. Código de rastreio: ${input.tracking_code}.`;
}

/** Telefone do cadastro em DDI+DDD+número (só dígitos); null se não der para usar. */
export function whatsappPhone(value: string | null | undefined): string | null {
  const d = (value ?? "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) return d;
  return null;
}
