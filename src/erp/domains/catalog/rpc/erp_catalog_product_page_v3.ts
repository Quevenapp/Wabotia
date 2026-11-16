// public.erp_catalog_product_page_v3: a v2 com campos customizados e componente.
import { registerRpc } from "../../../engine/registry.ts";
import { productPageV3 } from "../product-pages.ts";

registerRpc("erp_catalog_product_page_v3", (ctx, a) => productPageV3(ctx.db, a));
