// public.erp_catalog_product_export: a exportação v2 sem o filtro de componente.
import { registerRpc } from "../../../engine/registry.ts";
import { productExportV2 } from "../product-pages.ts";

registerRpc("erp_catalog_product_export", (ctx, a) => {
  const { p_component_id: _ignored, ...rest } = a;
  return productExportV2(ctx.db, rest);
});
