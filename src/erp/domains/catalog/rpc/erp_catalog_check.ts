// public.erp_catalog_check: avisos de duplicidade e documento sem gravar.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { warnings } from "../contact-core.ts";
import { validateData } from "../internal.ts";

export function erpCatalogCheck(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const entity = (a.p_entity ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const data = jsonArg(a, "p_data");
  requireAccess(ctx.db, user, entity, false);
  requireAccess(ctx.db, user, entity, true);
  if (entity === null || !["contacts", "products"].includes(entity)) raise("22023", "erp_catalog_invalid_check");
  const v = validateData(entity, data, false);
  if (id !== null && !one(ctx.db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity=?', id, entity)) raise("P0002", "erp_catalog_not_found");
  return { entity, warnings: warnings(ctx.db, entity, id, v), data_mode: "erp_native" };
}

registerRpc("erp_catalog_check", erpCatalogCheck);
