// Tipos puros compartilhados; nenhum código do Worker entra no painel.
export type { CommercialItem, CommercialPolicy, CommercialSnapshot, Destination, IntegrationModule, IntegrationState, SourceRef } from "../../../src/integrations/contracts";
import type { CommercialSnapshot, Destination, IntegrationModule, IntegrationState, SourceRef } from "../../../src/integrations/contracts";

export type SourceState = "none" | "skipped" | "pending" | "blocked" | "failed" | "uncertain" | "done";
export interface SourceView {
  source: SourceRef;
  revision: number;
  confirmed_ms: number | null;
  state: SourceState;
  skipped_reason?: string | null;
  blocked_reason?: string | null;
  reason_code?: string | null;
  error_code?: string | null;
  applied?: (Destination | "document")[];
  pending: boolean;
  manual_destinations: Destination[];
  deliveries: { id: string; seq?: number; state: IntegrationState; error_code?: string | null; completed_ms: number | null }[];
  links: { slot: string; kind: "document" | "title" | "settlement" | "stock_posting"; id: string; version: number | null }[];
}
export interface ModuleStatus {
  module: IntegrationModule;
  activations: Record<string, { module_id: string; epoch: number; enabled: boolean | number; first_enabled_ms: number | null; enabled_since_ms: number | null }>;
  counters: { state: IntegrationState; count: number }[];
}
export interface DocumentOrigin { document_id: string; source: SourceRef | null; readonly: true }
export interface CatalogLink { erp_item_id: string | null; version: number }
export interface CatalogItem { id: string; name: string; unit?: string; active?: boolean; kind?: string }
export interface StockObservation { warehouse_id: string; warehouse_name: string; quantity: string | null; reserved_quantity: string | null; available_quantity?: string | null; observed_ms: number }
export interface PolicyInitialization {
  version: number;
  warehouse?: { name: string; expected_setting_version: number };
  category?: { name: string };
  payment_method?: { name: string; type: string };
  account?: { name: string; kind: "cash" | "bank" | "other"; method: "cash" | "pix" | "card" | "other" | "unknown" };
  consumer?: boolean;
}
/** A9 não fixa o DTO de B3; manter a projeção comercial isolada do trabalho privado. */
export interface WorkCommercialView {
  id: string; version: number; revision: number; frozen: boolean;
  items: CommercialSnapshot["items"]; installments: CommercialSnapshot["installments"];
  total_cents: number;
  authorization: { kind: "approved_quote" | "fixed_price"; quote_version: number; at: number; channel: string } | null;
}
export interface ManualReceipt { request_id: string; amount_cents: number; method: "cash" | "pix" | "card" | "other" | "unknown"; occurred_ms: number }
export const MODULE_LABELS: Record<IntegrationModule, string> = { os: "Trabalhos", pedido: "Pedidos", mesas: "Mesas", entrega: "Entregas", mensalidade: "Mensalidades", agenda: "Agenda", reserva: "Reservas", suporte: "Suporte" };
