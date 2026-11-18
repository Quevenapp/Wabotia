// Escrito pela G para o domínio 11; dono: Documentos (autorizado pela N).
// Portado de erp_documents.os_permitted, require_role, require_access e
// contact_usable (inteiros) e de erp_document_mirror.visible, require_visible
// e report_coverage. visible e require_visible leem o documento espelhado do
// Origin como qualquer linha (origin/authority 'origin'): sem documento
// espelhado, não fazem nada (require_visible está em documents/mirror.ts).
// report_coverage é a constante native_effects_only sem exclusões.
import { requireVisible } from "./mirror.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { permitted } from "../access/public.ts";
import { contactScope, contactVisibleTo } from "../catalog/public.ts";
import { allowed } from "./public.ts";

/** erp_documents.os_permitted(user, key): o cartão de Ordem de serviço (e o sufixo pedido). */
export const osPermitted = (db: SqlDriver, user: string, key: string | null = null) =>
  permitted(db, user, "servicos.ordem_servico" + (key === null ? "" : "." + key));

/** erp_documents.require_role(user, kind, write) */
export function requireRole(db: SqlDriver, user: string | null, kind: string | null, write: boolean) {
  const r = user === null ? undefined : one(db, 'SELECT role FROM "erp_access__membership" WHERE user_id=? AND active=1', user);
  if (!r || !allowed(String(r.role), kind, write)) raise("42501", "erp_document_access_denied");
}

const CARDS: Record<string, string> = {
  sales_proposals: "vendas.propostas",
  sales_orders: "vendas.pedidos_venda",
  purchase_orders: "suprimentos.pedidos_compra",
};

/** erp_documents.require_access(user, kind, write): papel, cartão da ordem de serviço e cartão do documento (.ie para gravar). */
export function requireAccess(db: SqlDriver, user: string | null, kind: string | null, write: boolean) {
  requireRole(db, user, kind, write);
  if (kind === "service_orders" && !osPermitted(db, user!, write ? "ie" : null)) raise("42501", "erp_document_access_denied");
  const card = kind === null ? undefined : CARDS[kind];
  if (card !== undefined && !permitted(db, user!, write ? card + ".ie" : card)) raise("42501", "erp_document_access_denied");
}

/** erp_documents.contact_usable(user, contact): o contato da carteira do usuário ou o consumidor do PDV. */
export function contactUsable(db: SqlDriver, user: string | null, contact: string | null): boolean {
  return (
    contactVisibleTo(db, contactScope(db, user), contact) ||
    (contact !== null && !!one(db, 'SELECT 1 x FROM "erp_pos__settings" WHERE singleton=1 AND consumer_contact_id=?', contact))
  );
}

/** erp_document_mirror.visible(user, document): o documento nativo é visível quando o contato é usável. */
export function mirrorVisible(db: SqlDriver, user: string | null, document: string | null): boolean {
  const d = document === null ? undefined : one(db, 'SELECT contact_id, origin FROM "erp_documents__document" WHERE id=?', document);
  if (!d) return false;
  const contact = (d.contact_id as string | null) ?? null;
  // O documento espelhado só pela visibilidade do contato; o nativo pelo contact_usable (com o consumidor do PDV).
  return d.origin === "origin" ? contactVisibleTo(db, contactScope(db, user), contact) : contactUsable(db, user, contact);
}

/** erp_document_mirror.require_visible(user, document, write): só age em documento do espelho (documents/mirror.ts). */
export function mirrorRequireVisible(db: SqlDriver, user: string | null, document: string | null, write: boolean): void {
  requireVisible(db, user, document, write);
}
