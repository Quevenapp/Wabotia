// public.erp_catalog_seller_get: o vendedor, o contato dele e, para o
// administrador, as pessoas que podem ser vinculadas. O contato do vendedor é
// um contato: vale a carteira do vendedor ("Contato acessível somente ao
// vendedor vinculado").
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { contactRequireVisible } from "../contact.ts";
import { contactDto } from "../contact-core.ts";
import { sellerAccess, sellerDto, sellerUsers } from "../seller.ts";

export function erpCatalogSellerGet(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const db = ctx.db;
  const role = sellerAccess(db, user, false);
  const row = id === null ? null : one(db, 'SELECT contact_id FROM "erp_catalog__seller" WHERE id=?', id);
  if (!row) raise("P0002", "erp_catalog_not_found");
  const contact = String(row.contact_id);
  contactRequireVisible(db, user, contact);
  return {
    entity: "sellers",
    data_mode: "erp_native",
    can_write: role === "admin",
    seller: sellerDto(db, id!),
    contact: contactDto(db, contact),
    users: role === "admin" ? sellerUsers(db) : [],
  };
}

registerRpc("erp_catalog_seller_get", erpCatalogSellerGet);
