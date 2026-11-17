// public.erp_catalog_contact_check: os avisos do formulário sem gravar.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { contactRequireVisible } from "../contact.ts";
import { contactData, contactMerge, contactWarnings } from "../contact-core.ts";

export function erpCatalogContactCheck(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const data = jsonArg(a, "p_data");
  requireAccess(ctx.db, user, "contacts", true);
  let before: Record<string, unknown> = {};
  if (id !== null) {
    if (!one(ctx.db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id)) raise("P0002", "erp_catalog_not_found");
    contactRequireVisible(ctx.db, user, id);
    before = contactData(ctx.db, id) ?? {};
  }
  const full = contactMerge(ctx.db, user, id, data, before);
  return { entity: "contacts", warnings: contactWarnings(ctx.db, id, full, before), data_mode: "erp_native" };
}

registerRpc("erp_catalog_contact_check", erpCatalogContactCheck);
