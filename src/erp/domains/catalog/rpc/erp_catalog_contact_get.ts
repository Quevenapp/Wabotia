// public.erp_catalog_contact_get: a ficha do contato (com a carteira do vendedor).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactRequireVisible } from "../contact.ts";
import { contactDto } from "../contact-core.ts";

export function erpCatalogContactGet(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  requireAccess(ctx.db, user, "contacts", false);
  if (id === null || !one(ctx.db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id))
    raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(ctx.db, user, id);
  return { entity: "contacts", record: contactDto(ctx.db, id), data_mode: "erp_native" };
}

registerRpc("erp_catalog_contact_get", erpCatalogContactGet);
