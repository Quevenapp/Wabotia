// Porta da tela Expedição: /api/v1/profiles/<área>/erp-expedicao. O servidor
// confere e grava; o navegador só manda as escolhas da pessoa. Instalada pelo
// hospedeiro (host-runtime.tsx) em erpPorts().expedicao.
import { createFretePort, type FretePort } from "./frete-api";

export interface ExpedicaoAccess {
  ready: boolean;
  role: string | null;
  demo: boolean;
  /** Partes ligadas: a Expedição (com Vendas e Estoque), o Fiscal (nota) e o módulo Entrega da área. */
  parts: { shipping: boolean; sales: boolean; stock: boolean; fiscal: boolean; delivery: boolean };
}

export class ExpedicaoError extends Error {
  readonly status: number;
  readonly code: string;
  /** A resposta não chegou: o pedido pode ter sido gravado; atualize antes de repetir. */
  readonly uncertain: boolean;
  constructor(message: string, options: { status?: number; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.status = options.status ?? 0;
    this.code = options.code ?? "expedicao_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export type ShippingStatus = "to_pick" | "picking" | "picked" | "packed" | "shipped";
export const STATUS_PARAM: Readonly<Record<ShippingStatus | "all", string>> = {
  to_pick: "a_separar", picking: "em_separacao", picked: "separado", packed: "embalado", shipped: "expedido", all: "todas",
};
export interface Named { id: string; name: string | null }
export interface OrderSummary {
  id: string; number: number; date: string | null; order_status: string; status: ShippingStatus; status_label: string; version: number;
  customer: string; city: string | null; state: string | null; total_cents: string | null; carrier: Named | null; freight_mode: string | null;
  own_delivery: boolean; warehouse: Named | null; pick_list: { id: string; number: number; status: string } | null; pending: number; volumes: number;
  shipped_on: string | null; tracking_code: string | null; delivery_id: string | null;
}
export interface Package { id: string; name: string; length_mm: number | null; width_mm: number | null; height_mm: number | null; empty_weight_g: number | null; active: boolean; version: number }
export interface Overview {
  role: string; can_write: boolean; fiscal: boolean; counts: Record<ShippingStatus, number>; items: OrderSummary[]; truncated: boolean;
  lists: { id: string; number: number; status: string; created_at: string | null; orders: number }[]; packages: Package[];
}
export interface PickRow {
  key: string; product_id: string | null; warehouse: Named | null; location: string | null; description: string; code: string | null; gtin: string | null;
  unit: string | null; quantity: string; picked: string; done: boolean; orders: { document_id: string; number: number; quantity: string; picked: string }[];
}
export interface PickList {
  list: { id: string; number: number; status: "open" | "done" | "cancelled"; version: number; created_at: string | null; finished_at: string | null };
  rows: PickRow[]; orders: { id: string; number: number; customer: string; status: ShippingStatus; status_label: string; quantity: string; picked: string }[];
  pending?: { document_id: string; number: number; description: string; missing: string }[];
}
export interface OrderLine { key: string; product_id: string | null; description: string; code: string | null; gtin: string | null; unit: string | null;
  location: string | null; quantity: string; returned: string; net_weight_g: number | null; gross_weight_g: number | null }
export interface Volume { id: string; number: number; package: Named | null; length_mm: number | null; width_mm: number | null; height_mm: number | null;
  net_weight_g: number | null; gross_weight_g: number | null; items: { key: string; description: string; quantity: string; unit?: string | null }[] }
export interface Recipient { name: string; document: string | null; phone: string | null; street: string | null; number: string | null; complement: string | null;
  district: string | null; city: string | null; state: string | null; postal_code: string | null; delivery_address: boolean }
export interface OrderDetail {
  fiscal: boolean;
  order: OrderSummary & { recipient: Recipient; address: string; transport: { carrier_id: string | null; freight_mode: string | null; tracking_code: string | null; own_delivery: boolean };
    transport_synced_at: string | null; delivery_at: string | null };
  lines: OrderLine[];
  pending: { id: string; list_number: number; description: string; quantity: string; picked: string; missing: string; status: "open" | "resolved"; note: string | null }[];
  volumes: Volume[];
  returns: { id: string; number: number; reason: string; created_at: string | null; movement_id: string | null; warehouse: Named | null;
    items: { description: string; quantity: string; condition: string; condition_label: string }[] }[];
  emission: { id: string; status: string; number: number | null; series: number | null; authorized: boolean; return_path: string | null } | null;
  packages: Package[];
}
export interface PackResult extends OrderDetail { totals: { volumes: number; net_weight_g: number; gross_weight_g: number };
  unpacked: { key: string; description: string; missing: string }[]; transport: { written: boolean; reason: string | null }; items_without_weight: number }
export interface Labels { sender: import("./expedicao-pdf").Party; labels: (import("./expedicao-pdf").VolumeLabel & { document_id: string; address: string })[] }
export interface Manifest { from: string; to: string; sender: import("./expedicao-pdf").Party; carriers: import("./expedicao-pdf").ManifestCarrier[] }
export interface VolumeInput { embalagem?: string | null; comprimento?: string; largura?: string; altura?: string; peso_bruto?: string; itens: { linha: string; quantidade: string }[] }
export interface ReturnInput { motivo: string; deposito?: string | null; itens: { linha: string; quantidade: string; estado: "volta_ao_estoque" | "avariado" | "descarte" }[] }

export interface ExpedicaoPort {
  access(): ExpedicaoAccess;
  overview(query: { situacao?: string; de?: string; ate?: string; transportadora?: string; deposito?: string; busca?: string }, signal?: AbortSignal): Promise<Overview>;
  order(id: string, signal?: AbortSignal): Promise<OrderDetail>;
  pickList(id: string, signal?: AbortSignal): Promise<PickList>;
  createPick(input: { pedidos: string[]; filtros?: Record<string, string> }, command: string): Promise<PickList>;
  mark(list: string, input: { versao: number; linha: string; separado: string }): Promise<PickList>;
  finish(list: string, version: number, command: string): Promise<PickList>;
  cancel(list: string, version: number, command: string): Promise<PickList>;
  resolvePending(id: string, note: string, command: string): Promise<unknown>;
  packages(signal?: AbortSignal): Promise<{ items: Package[] }>;
  savePackage(input: { id?: string; versao?: number; nome: string; comprimento?: string; largura?: string; altura?: string; peso_vazio?: string; ativa?: boolean }, command: string): Promise<{ record: Package }>;
  pack(order: string, input: { versao: number; volumes: VolumeInput[] }, command: string): Promise<PackResult>;
  ship(input: { pedidos: string[]; rastreio?: string }, command: string): Promise<{ shipped: number[]; items: OrderSummary[] }>;
  labels(orders: string[], signal?: AbortSignal): Promise<Labels>;
  manifest(query: { de?: string; ate?: string; transportadora?: string }, signal?: AbortSignal): Promise<Manifest>;
  localDelivery(order: string, input: { entregador?: string }): Promise<{ entrega_id: string; repetida: boolean }>;
  registerReturn(order: string, input: ReturnInput, command: string): Promise<{ return: { number: number; movement_id: string | null }; emission: OrderDetail["emission"] }>;
  /** Um identificador novo por intenção (repetir o mesmo pedido não duplica nada no servidor). */
  command(): string;
  /** Frete e transportadoras: cotação, etiqueta oficial e rastreio (frete-api.ts). Sem ele, a tela não mostra o frete. */
  frete?: FretePort;
}

const UUID = /^[0-9a-f-]{36}$/;
export function createExpedicaoPort(profile: string, options: { access: () => ExpedicaoAccess; fetch?: typeof fetch }): ExpedicaoPort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-expedicao`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!UUID.test(value)) throw new ExpedicaoError("Identificador inválido. Atualize a tela.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  const qs = (query: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
    return q.size ? `?${q}` : "";
  };
  async function request(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<any> {
    if (options.access().demo && method !== "GET") throw new ExpedicaoError("A demonstração não grava na expedição.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ExpedicaoError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O pedido pode ter sido gravado: atualize a tela antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    let value: any = null;
    try { value = await response.json(); } catch { /* resposta sem JSON */ }
    if (!response.ok) {
      const detail = value?.error ?? value ?? {};
      throw new ExpedicaoError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "expedicao_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return value;
  }
  return {
    access: options.access,
    overview: (query, signal) => request("GET", `pedidos${qs(query)}`, undefined, signal),
    order: (order, signal) => request("GET", `pedidos/${id(order)}`, undefined, signal),
    pickList: (list, signal) => request("GET", `separacoes/${id(list)}`, undefined, signal),
    createPick: (input, command) => request("POST", "separacoes", { ...input, comando: command }),
    mark: (list, input) => request("POST", `separacoes/${id(list)}/marcar`, input),
    finish: (list, versao, command) => request("POST", `separacoes/${id(list)}/concluir`, { versao, comando: command }),
    cancel: (list, versao, command) => request("POST", `separacoes/${id(list)}/cancelar`, { versao, comando: command }),
    resolvePending: (pending, note, command) => request("POST", `pendencias/${id(pending)}/resolver`, { observacao: note, comando: command }),
    packages: (signal) => request("GET", "embalagens", undefined, signal),
    savePackage: (input, command) => request("POST", "embalagens", { ...input, comando: command }),
    pack: (order, input, command) => request("POST", `pedidos/${id(order)}/volumes`, { ...input, comando: command }),
    ship: (input, command) => request("POST", "expedir", { ...input, comando: command }),
    labels: (orders, signal) => request("GET", `etiquetas${qs({ pedidos: orders.map((o) => id(o)).join(",") })}`, undefined, signal),
    manifest: (query, signal) => request("GET", `romaneio${qs(query)}`, undefined, signal),
    localDelivery: (order, input) => request("POST", `pedidos/${id(order)}/entrega-local`, input),
    registerReturn: (order, input, command) => request("POST", `pedidos/${id(order)}/devolucoes`, { ...input, comando: command }),
    command: () => crypto.randomUUID(),
    frete: createFretePort(profile, options),
  };
}
