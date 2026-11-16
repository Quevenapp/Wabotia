// Documentos (erp_documents): o que outros domínios usam. Portado de
// erp_documents.allowed e guard_trash_child. Dono: O (Documentos); as
// leituras de reads-g.ts foram escritas pela G e assumidas por O.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";

export * from "./stubs.generated.ts";

/**
 * erp_documents.guard_trash_child: gatilho das tabelas filhas de um documento
 * (no Financeiro, grouped_billing_document): nenhuma linha nova, alterada ou
 * apagada aponta para um documento na lixeira. Chame com o document_id da
 * linha (o novo no INSERT/UPDATE, o antigo no DELETE).
 */
export function guardTrashChild(db: SqlDriver, documentId: string | null) {
  if (documentId !== null && one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND deleted_at IS NOT NULL', documentId))
    raise("40001", "erp_document_deleted");
}
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
