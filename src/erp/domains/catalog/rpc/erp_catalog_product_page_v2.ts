// public.erp_catalog_product_page_v2: página com situação, tipo, imagens, tag, categoria e fornecedor.
import { registerRpc } from "../../../engine/registry.ts";
import { productPageV2 } from "../product-pages.ts";

registerRpc("erp_catalog_product_page_v2", (ctx, a) => productPageV2(ctx.db, a));
