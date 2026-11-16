// public.erp_catalog_product_page: página de produtos (filtros da primeira versão).
import { registerRpc } from "../../../engine/registry.ts";
import { productPage } from "../product-pages.ts";

registerRpc("erp_catalog_product_page", (ctx, a) => productPage(ctx.db, a));
