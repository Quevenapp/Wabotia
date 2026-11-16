// public.erp_catalog_product_variations: o produto pai e as variações, na ordem.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { requireAccess } from "../pricing/deps.ts";
import { variationDto } from "../product-variations.ts";

registerRpc("erp_catalog_product_variations", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  const parent = uuidArg(a, "p_parent");
  requireAccess(ctx.db, user, "products", false);
  if (parent === null || !one(ctx.db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='products'`, parent))
    raise("P0002", "erp_catalog_not_found");
  const v = variationDto(ctx.db, parent);
  return v === null ? null : { scope: "product_variations", data_mode: "erp_native", ...v };
});
