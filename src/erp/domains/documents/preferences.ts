// Escrita pela G para o domínio 11 (situações das preferências); dono: Documentos.
// erp_documents.transitions(): as transições permitidas de cada tipo de documento
// (a constante do oráculo, na ordem das chaves do jsonb).

const T = {
  sales_proposals: {
    draft: ["open", "pending", "waiting", "approved", "rejected", "cancelled"],
    open: ["draft", "pending", "waiting", "approved", "rejected", "cancelled"],
    pending: ["draft", "open", "waiting", "approved", "rejected", "cancelled"],
    waiting: ["draft", "open", "pending", "approved", "rejected", "cancelled"],
    approved: ["draft", "open", "pending", "waiting", "rejected", "cancelled"],
    rejected: ["draft", "open", "pending", "waiting", "approved", "cancelled"],
    cancelled: ["draft", "open", "pending", "waiting", "approved", "rejected"],
    completed: [],
  },
  sales_orders: {
    draft: ["open", "verified", "in_progress", "agency_sale", "fulfilled", "cancelled"],
    open: ["draft", "verified", "in_progress", "agency_sale", "fulfilled", "cancelled", "checkout_partial"],
    verified: ["draft", "open", "in_progress", "agency_sale", "fulfilled", "cancelled"],
    in_progress: ["draft", "open", "verified", "agency_sale", "partially_fulfilled", "fulfilled", "cancelled"],
    agency_sale: ["draft", "open", "verified", "in_progress", "fulfilled", "cancelled"],
    checkout_partial: ["open", "verified", "in_progress", "cancelled"],
    partially_fulfilled: ["in_progress", "partially_invoiced", "fulfilled", "cancelled"],
    partially_invoiced: ["partially_fulfilled", "cancelled"],
    fulfilled: ["draft", "open", "verified", "in_progress", "agency_sale", "cancelled"],
    cancelled: ["draft", "open", "verified", "in_progress", "agency_sale", "fulfilled"],
  },
  purchase_orders: {
    open: ["in_progress", "fulfilled", "cancelled"],
    in_progress: ["open", "partially_fulfilled", "fulfilled", "cancelled"],
    partially_fulfilled: ["in_progress", "fulfilled", "cancelled"],
    fulfilled: ["open", "in_progress", "cancelled"],
    cancelled: ["open", "in_progress", "fulfilled"],
  },
  service_orders: Object.fromEntries(
    ["open", "quoted", "approved", "rejected", "in_progress", "waiting_parts", "service_done", "finalized", "no_repair", "cancelled"].map((s, _i, all) => [
      s,
      all.filter((x) => x !== s),
    ]),
  ),
} as Record<string, Record<string, string[]>>;

/** erp_documents.transitions() */
export const transitions = (): Record<string, Record<string, string[]>> => structuredClone(T);
