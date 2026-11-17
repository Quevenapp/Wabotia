// public.erp_catalog_contact_tags: as etiquetas de até 100 contatos, na ordem
// pedida, só dos que existem e que a pessoa enxerga (carteira do vendedor).
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactScope, contactVisibleTo } from "../contact.ts";
import { contactTagsData } from "../contact-tags.ts";

export function erpCatalogContactTags(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const ids = (a.p_ids ?? null) as (string | null)[] | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (ids === null || ids.length < 1 || ids.length > 100 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_catalog_invalid_query");
  const scope = contactScope(db, user);
  const items = (ids as string[])
    .filter((id) => one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', id) && contactVisibleTo(db, scope, id))
    .map((id) => contactTagsData(db, id));
  return { entity: "contacts", data_mode: "erp_native", items };
}

registerRpc("erp_catalog_contact_tags", erpCatalogContactTags);
