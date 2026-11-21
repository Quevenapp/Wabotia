// Porta do frete na tela Expedição: /api/v1/profiles/<área>/erp-expedicao/frete.
// Cotar, escolher o serviço, contratar o envio, baixar a etiqueta oficial,
// cancelar, rastrear e configurar os provedores. O servidor confere e grava; o
// navegador só manda as escolhas da pessoa. Criada junto da porta da
// Expedição (expedicao-api.ts, campo frete).
import { ExpedicaoError, type ExpedicaoAccess } from "./expedicao-api";

export interface FreightOption {
  option: string; provider: string; provider_name: string; sandbox: boolean; service_code: string; service_name: string; company: string | null;
  price_cents: number; delivery_days: number | null;
}
export interface FreightQuote {
  id: string; order: { id: string; number: number }; from_postal_code: string; to_postal_code: string; volumes: number; weight_g: number; declared_cents: number;
  options: FreightOption[]; errors: { provider: string; provider_name: string; message: string }[]; expires: number; freight_editable: boolean;
}
export interface FreightShipment {
  id: string; provider: string; provider_name: string; sandbox: boolean; service_code: string; service_name: string; price_cents: number | null;
  status: "contracting" | "uncertain" | "contracted" | "cancelling" | "cancelled" | "failed"; status_label: string; tracking_code: string | null; label_ready: boolean;
  tracking_status: string | null; tracking_label: string | null; tracking_at: number | null; shipped_at: number | null; delivered_at: number | null; error: string | null; created: number;
}
export interface FreightEvent { id: string; at: number; code: string; status: string; status_label: string; description: string; location: string | null; notified: boolean }
export interface FreightOrder {
  can_write: boolean;
  order: { id: string; number: number; ship_status: string; freight: string; delivery_days: string | null; freight_editable: boolean; tracking_code: string | null };
  choice: { quote_id: string; provider: string; sandbox: boolean; service_code: string; service_name: string; company: string | null; price_cents: number;
    delivery_days: number | null; applied: boolean; apply_message: string | null; chosen: number } | null;
  shipment: FreightShipment | null; events: FreightEvent[]; providers: { id: string; name: string }[]; notify_whatsapp: boolean;
  applied?: boolean; message?: string | null; notes?: string[]; repeated?: boolean; added?: number;
}
export interface FreightField { key: string; label: string; hint: string; saved?: boolean; required?: boolean }
export interface FreightProviderView {
  id: string; name: string; enabled: boolean; sandbox: boolean; sandbox_available: boolean; options: Record<string, string>;
  secret_fields: FreightField[]; option_fields: FreightField[]; ready: boolean; check: { at: number; ok: boolean | null; message: string | null } | null; updated: number | null;
}
export interface FreightProviders {
  providers: FreightProviderView[]; settings: { notify_whatsapp: boolean; origin_postal_code: string | null; updated: number | null };
  ok?: boolean; message?: string;
}

export interface FretePort {
  order(id: string, signal?: AbortSignal): Promise<FreightOrder>;
  quote(id: string): Promise<FreightQuote>;
  choose(id: string, input: { cotacao: string; servico: string }): Promise<FreightOrder>;
  contract(id: string): Promise<FreightOrder>;
  cancel(id: string): Promise<FreightOrder>;
  track(id: string): Promise<FreightOrder>;
  /** A etiqueta oficial em PDF. */
  label(id: string): Promise<Uint8Array>;
  providers(signal?: AbortSignal): Promise<FreightProviders>;
  saveProvider(provider: string, input: { ligado?: boolean; sandbox?: boolean; credenciais?: Record<string, string | null>; opcoes?: Record<string, string | null> }): Promise<FreightProviders>;
  testProvider(provider: string): Promise<FreightProviders>;
  saveSettings(input: { avisar_whatsapp?: boolean; cep_origem?: string | null }): Promise<{ settings: FreightProviders["settings"] }>;
}

const UUID = /^[0-9a-f-]{36}$/;
export function createFretePort(profile: string, options: { access: () => ExpedicaoAccess; fetch?: typeof fetch }): FretePort {
  const base = `/api/v1/profiles/${encodeURIComponent(profile)}/erp-expedicao/frete`;
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const id = (value: string) => {
    if (!UUID.test(value)) throw new ExpedicaoError("Identificador inválido. Atualize a tela.", { status: 400, code: "invalid_request" });
    return encodeURIComponent(value);
  };
  async function send(method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<Response> {
    if (options.access().demo && method !== "GET") throw new ExpedicaoError("A demonstração não grava no frete.", { status: 403, code: "demo" });
    let response: Response;
    try {
      response = await transport(`${base}/${path}`, {
        method, credentials: "same-origin", cache: "no-store", signal,
        headers: { Accept: "application/json, application/pdf", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ExpedicaoError(method === "GET" ? "O servidor não respondeu. Confira a conexão e tente de novo." : "A resposta não chegou. O envio pode ter sido feito: atualize a tela antes de repetir.",
        { code: "response_lost", uncertain: method !== "GET" });
    }
    if (!response.ok) {
      let value: any = null;
      try { value = await response.json(); } catch { /* resposta sem JSON */ }
      const detail = value?.error ?? value ?? {};
      throw new ExpedicaoError(typeof detail.message === "string" ? detail.message : `O servidor recusou o pedido (HTTP ${response.status}).`, {
        status: response.status, code: typeof detail.code === "string" ? detail.code : "frete_error", uncertain: response.status === 502 || response.status === 504,
      });
    }
    return response;
  }
  const request = async (method: "GET" | "POST", path: string, body?: object, signal?: AbortSignal): Promise<any> => (await send(method, path, body, signal)).json();
  return {
    order: (order, signal) => request("GET", `pedidos/${id(order)}`, undefined, signal),
    quote: (order) => request("GET", `pedidos/${id(order)}/cotacao`),
    choose: (order, input) => request("POST", `pedidos/${id(order)}/escolha`, input),
    contract: (order) => request("POST", `pedidos/${id(order)}/envio`, {}),
    cancel: (order) => request("POST", `pedidos/${id(order)}/envio/cancelar`, {}),
    track: (order) => request("POST", `pedidos/${id(order)}/rastreio`, {}),
    label: async (order) => new Uint8Array(await (await send("GET", `pedidos/${id(order)}/etiqueta`)).arrayBuffer()),
    providers: (signal) => request("GET", "provedores", undefined, signal),
    saveProvider: (provider, input) => request("POST", `provedores/${encodeURIComponent(provider)}`, input),
    testProvider: (provider) => request("POST", `provedores/${encodeURIComponent(provider)}/testar`, {}),
    saveSettings: (input) => request("POST", "ajustes", input),
  };
}
