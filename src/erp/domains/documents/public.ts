// Documentos (erp_documents): o que outros domínios usam. Portado de
// erp_documents.allowed.

export * from "./stubs.generated.ts";
export { autoProducts } from "./internal.ts";
export { transitions } from "./preferences.ts";

const KINDS =["sales_proposals", "sales_orders", "purchase_orders", "service_orders"];

/** erp_documents.allowed(role, kind, write) */
export function allowed(role: string | null, kind: string | null, write: boolean): boolean {
  if (kind === null || !KINDS.includes(kind)) return false;
  if (role === null) return false;
  if (write) return kind === "purchase_orders" ? ["admin", "estoque"].includes(role) : ["admin", "vendas"].includes(role);
  if (["admin", "consulta", "financeiro"].includes(role)) return true;
  if (role === "vendas") return ["sales_proposals", "sales_orders", "service_orders"].includes(kind);
  if (["estoque", "fiscal"].includes(role)) return ["sales_orders", "purchase_orders"].includes(kind);
  return false;
}
