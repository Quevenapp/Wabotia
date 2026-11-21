// Interface comum das maquininhas que recebem a cobrança pela nuvem: listar
// os terminais da conta, preparar o terminal (modo integrado), enviar a
// cobrança, consultar, achar uma cobrança pela referência (depois de uma
// resposta incerta), cancelar e ler o aviso (webhook). Cada provedor
// (./providers/*.ts) só monta os pedidos HTTP e lê as respostas; quem chama
// o provedor é o transporte (`TerminalHttp`), que nos testes é um provedor
// simulado e no Worker é ./transport.ts. Sem rede e sem D1 aqui: os testes do
// Node importam este arquivo.
//
// Segurança: a credencial só entra no pedido; nenhuma mensagem de erro leva o
// pedido, o cabeçalho ou o corpo inteiro do provedor.
import type { TerminalBrand, TerminalCardKind, TerminalInstallmentsCost, TerminalProviderId } from "./contract.ts";

export interface TerminalHttpRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface TerminalHttpResponse { status: number; body: unknown }
export type TerminalHttp = (request: TerminalHttpRequest) => Promise<TerminalHttpResponse>;

export interface TerminalCredentials { access_token: string; webhook_secret: string }
export interface TerminalContext { http: TerminalHttp; credentials: TerminalCredentials; now?: () => number }

/**
 * Recusa do provedor, com o texto para a tela:
 * - configuracao: falta algo na configuração (credencial, terminal);
 * - credencial: o provedor recusou a credencial;
 * - ocupado: o terminal já tem outra cobrança, ou a cobrança já está na tela dele;
 * - recusado: o provedor recusou o pedido (dados);
 * - indisponivel: o pedido não saiu (ou era só consulta): pode tentar de novo;
 * - incerto: o pedido de cobrança pode ter chegado: consulte antes de enviar outra.
 */
export type TerminalErrorKind = "configuracao" | "credencial" | "ocupado" | "recusado" | "indisponivel" | "incerto";
export class TerminalError extends Error {
  readonly kind: TerminalErrorKind;
  constructor(kind: TerminalErrorKind, message: string) { super(message); this.name = "TerminalError"; this.kind = kind; }
}

export interface TerminalDevice {
  id: string;
  name: string;
  /** Pronto para receber cobrança pela nuvem (no Mercado Pago, o modo PDV). */
  ready: boolean;
  mode: string | null;
  note: string | null;
}

export interface TerminalChargeRequest {
  /** Referência do Wabotia (vai como referência externa): a mesma em cada nova tentativa. */
  reference: string;
  device_id: string;
  amount_cents: number;
  kind: TerminalCardKind;
  installments: number;
  installments_cost: TerminalInstallmentsCost;
  description: string;
}

/** Situação normalizada da cobrança no provedor. */
export type TerminalChargeState = "aguardando" | "processando" | "aprovado" | "recusado" | "cancelado" | "erro";
export interface TerminalCharge {
  /** Id da cobrança no provedor (no Mercado Pago, a intenção de pagamento). */
  ref: string;
  state: TerminalChargeState;
  /** Em palavras, para a tela (recusa, cancelamento, onde a cobrança está). */
  reason: string | null;
  reference: string | null;
  device_id: string | null;
  /** Pagamento no provedor (só depois de passado o cartão). */
  payment_id: string | null;
  amount_cents: number | null;
  kind: TerminalCardKind | null;
  installments: number | null;
  brand: TerminalBrand | null;
  authorization: string | null;
  nsu: string | null;
  last4: string | null;
  paid_at: number | null;
  /** Tarifa do provedor, quando ele informa na consulta. */
  fee_cents: number | null;
}

export interface TerminalWebhookInput { headers: Headers; query: URLSearchParams; body: unknown }

export interface TerminalProvider {
  id: TerminalProviderId;
  name: string;
  /** Até quantas parcelas o provedor aceita no crédito. */
  maxInstallments: number;
  listDevices(ctx: TerminalContext): Promise<TerminalDevice[]>;
  /** Põe o terminal no modo que recebe cobrança pela nuvem (quando preciso). */
  prepareDevice(ctx: TerminalContext, deviceId: string): Promise<void>;
  createCharge(ctx: TerminalContext, request: TerminalChargeRequest): Promise<{ ref: string }>;
  getCharge(ctx: TerminalContext, ref: string): Promise<TerminalCharge>;
  /** Acha a cobrança pela referência do Wabotia (depois de resposta incerta); null se não está no provedor. */
  findCharge(ctx: TerminalContext, input: { reference: string; device_id: string; since: number }): Promise<TerminalCharge | null>;
  cancelCharge(ctx: TerminalContext, input: { ref: string; device_id: string }): Promise<void>;
  /** Confere a assinatura do aviso e devolve os ids citados (nunca o resultado: o pagamento só vale pela consulta). */
  verifyWebhook(ctx: TerminalContext, input: TerminalWebhookInput): Promise<{ refs: string[] }>;
}

/** Texto curto do provedor, sem números longos (podem ser dados do cartão ou do pedido). */
export function shortReason(value: unknown, max = 160): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/\d{6,}/g, "…").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Bandeira do cartão pelo código do provedor (visa, master, debelo…). */
export function brandOf(value: unknown): TerminalBrand | null {
  const code = typeof value === "string" ? value.toLowerCase() : "";
  if (!code) return null;
  if (code.includes("visa")) return "visa";
  if (code.includes("master") || code.includes("maestro")) return "mastercard";
  if (code.includes("elo")) return "elo";
  if (code.includes("amex") || code.includes("american")) return "amex";
  if (code.includes("hiper")) return "hipercard";
  if (code.includes("diners")) return "diners";
  if (code.includes("cabal")) return "cabal";
  return "outros";
}

/** Valor em reais (número ou texto) em centavos inteiros, sem ponto flutuante acumulado. */
export function reaisToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === "string" && /^\d{1,13}(\.\d{1,2})?$/.test(value.trim())) {
    const [whole, fraction = ""] = value.trim().split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }
  return null;
}
