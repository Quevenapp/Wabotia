import { projectCatalogResult } from "../part-projection.ts";
// public.erp_catalog_get: o cadastro pelo dto genérico (contatos fora da
// carteira do vendedor não aparecem, salvo o consumidor padrão do PDV).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { contactUsable } from "../../documents/public.ts";
import { requireAccess } from "../access.ts";
import { dto } from "../internal.ts";

export function erpCatalogGet(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const entity = (a.p_entity ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  requireAccess(ctx.db, user, entity, false);
  if (!one(ctx.db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity=?', id, entity)) raise("P0002", "erp_catalog_not_found");
  if (entity === "contacts" && !contactUsable(ctx.db, user, id)) raise("P0002", "erp_catalog_not_found");
  return projectCatalogResult(ctx.parts, { entity, record: dto(ctx.db, id!), data_mode: "erp_native" });
}

registerRpc("erp_catalog_get", erpCatalogGet);
