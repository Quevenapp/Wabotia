/** Contratos comerciais puros. Nenhum tipo depende da execução do Worker. */
export type IntegrationModule = "os" | "pedido" | "mesas" | "entrega" | "mensalidade" | "agenda" | "reserva" | "suporte";
export type Destination = "stock" | "finance";
export type IntegrationRoute = "work" | "sale" | "title" | "delegate";
export type Cents = number;
export type Decimal = string;
export type Statement = [sql: string, bindings: unknown[]];
export interface SourceRef { profile: string; module: IntegrationModule; source_id: string; component: string }
export type IntegrationOperation = "prepare" | "recognize" | "execute" | "lifecycle" | "receive" | "cancel" | "reverse";
export interface ModuleIntegrationDeclaration {
  route: IntegrationRoute;
  uses: readonly ("customers" | "products" | "stock" | "finance")[];
  operations: readonly IntegrationOperation[];
  privacy: "commercial" | "adult_payer_only";
}
export interface CommercialItem {
  id: string; description: string; quantity: Decimal; unit_cents: Cents; unit: string;
  kind: "material" | "service" | "free"; product_id: string | null;
}
export interface Installment { key: string; due_on: string; amount_cents: Cents; payment_method_id: string | null }
export interface CommercialPolicy {
  profile: string; version: number; auto_post: { stock: boolean; finance: boolean };
  warehouse_id: string | null; revenue_category_id: string | null; payment_method_id: string | null;
  settlement_accounts: Partial<Record<"cash" | "pix" | "card" | "other" | "unknown", string>>;
  consumer_contact_id: string | null; installment_rule: "single_on_trigger";
}
export interface CommercialSnapshot {
  schema: 1; source: SourceRef; source_revision: number;
  contact_id: string | null; customer_ref: string | null;
  privacy: "commercial" | "adult_payer_only"; description: string; issued_on: string;
  items: readonly CommercialItem[]; total_cents: Cents; freight_cents: Cents; discount_cents: Cents;
  installments: readonly Installment[]; policy_version: number;
  lifecycle: {
    base_status: string; stage_id: string | null; quote_version: number | null;
    authorization: "approved_quote" | "fixed_price" | null;
    authorized_at: number | null; first_execution_at: number | null;
    delivered_at: number | null; warranty_until: number | null;
  };
  technical: { equipment: string | null; serial_number: string | null; technician: string | null; defect: string | null; solution: string | null } | null;
}
export interface IntegrationEvent {
  id: string; command_id: string; event_key: string; source: SourceRef; seq: number;
  source_revision: number; operation: IntegrationOperation; occurred_ms: number;
  epochs: Readonly<Record<string, number>>;
  eligible: { document: boolean; stock: boolean; finance: boolean };
  snapshot: CommercialSnapshot; receipt_key: string | null; reverses_receipt_key: string | null;
  reason_code: string | null; actor_id: string | null;
}
export interface PreparedErpRequest {
  schema: 1; command_id: string; actor_id: string; source: SourceRef; seq: number;
  event_hash: string; expected: Readonly<Record<string, number>>; body: Readonly<Record<string, unknown>>;
}
export interface IntegrationResult {
  command_id: string; replayed: boolean; seq: number; outcome: "applied" | "skipped" | "closed";
  links: readonly { slot: string; kind: "document" | "title" | "settlement" | "stock_posting"; id: string; version: number | null }[];
  effects: { stock: "posted" | "reversed" | "skipped" | "not_requested"; finance: "posted" | "settled" | "reversed" | "skipped" | "not_requested" };
  reason_code: string | null;
}
export type IntegrationState = "off" | "pending" | "sending" | "waiting_manual" | "blocked" | "failed" | "done";
