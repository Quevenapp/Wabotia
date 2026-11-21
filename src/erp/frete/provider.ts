// Frete: a interface comum dos provedores (cotar, contratar e gerar a etiqueta,
// cancelar e rastrear) e os tipos que o serviço (./service.ts) troca com eles.
// Cada provedor é um adaptador (./correios.ts, ./melhorenvio.ts) que só fala
// HTTP pela função `http` recebida: os testes passam um provedor simulado, sem
// rede. Credenciais chegam na conexão e nunca saem em mensagem de erro nem em
// log (o adaptador não escreve log).
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export const FREIGHT_PROVIDERS = ["correios", "melhorenvio"] as const;
export type FreightProviderId = (typeof FREIGHT_PROVIDERS)[number];
export const isFreightProvider = (v: unknown): v is FreightProviderId => typeof v === "string" && (FREIGHT_PROVIDERS as readonly string[]).includes(v);

/** O HTTP do adaptador: o fetch de verdade no Worker, o simulado nos testes. */
export type FreightHttp = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;

/** Conexão com o provedor: o modo (sandbox ou produção), as credenciais (do cofre) e as opções não secretas. */
export interface FreightConnection {
  sandbox: boolean;
  credentials: Record<string, string>;
  options: Record<string, string>;
}

export interface FreightAddress {
  name: string; document: string | null; phone: string | null; email: string | null;
  street: string | null; number: string | null; complement: string | null; district: string | null;
  city: string | null; state: string | null; postal_code: string;
}
/** Volume em milímetros e gramas, como a Expedição guarda. */
export interface FreightVolume { length_mm: number; width_mm: number; height_mm: number; weight_g: number }

export interface QuoteRequest {
  from_postal_code: string; to_postal_code: string;
  volumes: FreightVolume[];
  /** Valor declarado (o pedido sem o frete), em centavos. */
  declared_cents: number;
}
export interface QuoteOption {
  service_code: string; service_name: string;
  /** Quem leva (Correios, Jadlog…), para o agregador. */
  company: string | null;
  price_cents: number; delivery_days: number | null;
}

export interface ContractRequest {
  /** Identificador do envio no Wabotia: vai junto ao provedor para achar o envio de novo numa resposta incerta. */
  reference: string;
  service_code: string;
  order_number: number;
  from: FreightAddress; to: FreightAddress;
  volumes: FreightVolume[];
  declared_cents: number;
  items: { description: string; quantity: number; unit_cents: number }[];
  invoice: { key: string; number: number | null; series: number | null } | null;
}
export interface ContractResult {
  /** Identificador do envio no provedor. */
  provider_ref: string;
  tracking_code: string | null;
  price_cents: number | null;
}

/** Situação normalizada do rastreio. */
export const TRACKING_STATUSES = ["label_created", "posted", "in_transit", "out_for_delivery", "waiting_pickup", "delivered", "exception", "returned", "cancelled"] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];
export interface TrackingEvent {
  /** Quando aconteceu (ms). */
  at: number;
  code: string; status: TrackingStatus; description: string; location: string | null;
}

export interface FreightProvider {
  id: FreightProviderId;
  name: string;
  /** O provedor tem ambiente de testes (sandbox/homologação). */
  sandbox: boolean;
  /** Campos secretos digitados na tela (vão para o cofre). */
  secretFields: readonly { key: string; label: string; hint: string }[];
  /** Opções não secretas (serviços, e-mail técnico). */
  optionFields: readonly { key: string; label: string; hint: string; required: boolean }[];
  /** Confere as credenciais (uma chamada leve). */
  check(http: FreightHttp, conn: FreightConnection): Promise<{ account: string | null }>;
  quote(http: FreightHttp, conn: FreightConnection, req: QuoteRequest): Promise<QuoteOption[]>;
  /** Contrata o envio e deixa a etiqueta pronta para baixar. */
  contract(http: FreightHttp, conn: FreightConnection, req: ContractRequest): Promise<ContractResult>;
  /**
   * Resposta incerta: procura no provedor o envio desta referência. null =
   * o provedor confirma que não existe (pode contratar de novo).
   */
  find(http: FreightHttp, conn: FreightConnection, reference: string, providerRef: string | null): Promise<(ContractResult & { cancelled: boolean }) | null>;
  /** A etiqueta oficial em PDF. */
  label(http: FreightHttp, conn: FreightConnection, providerRef: string): Promise<Uint8Array>;
  cancel(http: FreightHttp, conn: FreightConnection, providerRef: string): Promise<void>;
  track(http: FreightHttp, conn: FreightConnection, providerRef: string, trackingCode: string | null): Promise<TrackingEvent[]>;
}

/**
 * Falha conhecida do provedor. `uncertain`: a resposta não chegou ou veio
 * quebrada; o pedido pode ter sido feito lá (nunca repetir sem consultar).
 */
export class FreightError extends Error {
  readonly code: string;
  readonly status: number;
  readonly uncertain: boolean;
  /** O envio já existe no provedor com este número (a próxima tentativa continua dele). */
  readonly providerRef: string | null;
  constructor(code: string, message: string, options: { status?: number; uncertain?: boolean; providerRef?: string } = {}) {
    super(message);
    this.code = code;
    this.status = options.status ?? 502;
    this.uncertain = options.uncertain ?? false;
    this.providerRef = options.providerRef ?? null;
  }
}

/** Só dígitos. */
export const digits = (v: unknown) => (typeof v === "string" ? v.replace(/\D/g, "") : typeof v === "number" ? String(v) : "");
/** CEP com 8 dígitos, ou null. */
export const postalCode = (v: unknown) => { const d = digits(v); return d.length === 8 ? d : null; };
/** "25,30", "25.3" ou 25.3 em centavos; null se não for número. */
export function moneyCents(v: unknown): number | null {
  const raw = typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : typeof v === "string" ? v.trim() : "";
  // "1.234,56" (Correios) ou "1234.56" (Melhor Envio).
  const text = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}
/** Milímetros em centímetros inteiros, para cima (o provedor recusa zero). */
export const cmCeil = (mm: number) => Math.max(1, Math.ceil(mm / 10));

/**
 * Chamada HTTP com JSON: rede caída ou tempo esgotado é resposta incerta;
 * 401/403 é credencial recusada; 5xx é incerta numa gravação e indisponível
 * numa leitura. A mensagem nunca leva credencial nem o corpo enviado.
 */
export async function callJson(http: FreightHttp, provider: string, url: string, init: { method: string; headers: Record<string, string>; body?: unknown; write?: boolean }) {
  let response: Response;
  try {
    response = await http(url, { method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new FreightError("freight_provider_unavailable", init.write
      ? `${provider} não respondeu. O envio pode ter sido feito lá: o Wabotia consulta antes de tentar de novo.`
      : `${provider} não respondeu. Tente de novo em instantes.`, { uncertain: !!init.write });
  }
  const text = await response.text().catch(() => "");
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (response.status === 401 || response.status === 403)
    throw new FreightError("freight_provider_auth", `${provider} recusou as credenciais. Confira em Expedição › Frete e transportadoras e teste a conexão.`, { status: 502 });
  if (response.status >= 500 || (response.ok && text && data === null))
    throw new FreightError("freight_provider_unavailable", init.write
      ? `${provider} respondeu com erro. O envio pode ter sido feito lá: o Wabotia consulta antes de tentar de novo.`
      : `${provider} está com problema agora. Tente de novo em instantes.`, { uncertain: !!init.write });
  return { status: response.status, ok: response.ok, data };
}

/** A primeira mensagem legível que o provedor mandou (sem ecoar o corpo inteiro). */
export function providerMessage(data: any): string | null {
  const pick = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
  if (!data || typeof data !== "object") return pick(data);
  if (Array.isArray(data.msgs)) return pick(data.msgs[0]);
  if (data.errors && typeof data.errors === "object") {
    const first = Object.values(data.errors)[0];
    return pick(Array.isArray(first) ? first[0] : first);
  }
  return pick(data.message) ?? pick(data.msg) ?? pick(data.error) ?? pick(data.mensagem);
}
