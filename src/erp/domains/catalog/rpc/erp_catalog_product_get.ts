// public.erp_catalog_product_get: o cadastro completo do produto.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { productFull } from "../internal.ts";
import { requireAccess } from "../pricing/deps.ts";

registerRpc("erp_catalog_product_get", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  requireAccess(ctx.db, user, "products", false);
  if (id === null || !one(ctx.db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='products'`, id))
    raise("P0002", "erp_catalog_not_found");
  return { entity: "products", record: productFull(ctx.db, id), data_mode: "erp_native" };
});
