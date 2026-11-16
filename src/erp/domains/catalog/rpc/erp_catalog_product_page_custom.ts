// public.erp_catalog_product_page_custom: a v2 com filtro obrigatório de campos customizados.
import { registerRpc } from "../../../engine/registry.ts";
import { productPageCustom } from "../product-pages.ts";

registerRpc("erp_catalog_product_page_custom", (ctx, a) => productPageCustom(ctx.db, a));
