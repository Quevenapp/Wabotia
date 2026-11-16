// Documentos (erp_documents): o que outros domínios usam. Portado de
// erp_documents.allowed.

export * from "./stubs.generated.ts";
export { autoProducts } from "./internal.ts";
export { transitions } from "./preferences.ts";
export { contactUsable, mirrorRequireVisible, mirrorVisible, osPermitted, reportCoverage, requireAccess, requireRole } from "./reads-g.ts";

const KINDS =["sales_proposals", "sales_orders", "purchase_orders", "service_orders"];

/** erp_documents.allowed(role, kind, write) */
export function allowed(role: string | null, kind: string | null, write: boolean): boolean {
  // kind NULL: "p_kind not in (…)" é NULL e o CASE do Postgres segue para as regras do papel
  // (gravar: admin ou vendas; ler: admin, consulta ou financeiro; o resto dá NULL → false).
  if (kind !== null && !KINDS.includes(kind)) return false;
  if (role === null) return false;
  if (write) return kind === "purchase_orders" ? ["admin", "estoque"].includes(role) : ["admin", "vendas"].includes(role);
  if (["admin", "consulta", "financeiro"].includes(role)) return true;
  if (kind === null) return false;
  if (role === "vendas") return ["sales_proposals", "sales_orders", "service_orders"].includes(kind);
  if (["estoque", "fiscal"].includes(role)) return ["sales_orders", "purchase_orders"].includes(kind);
  return false;
}
