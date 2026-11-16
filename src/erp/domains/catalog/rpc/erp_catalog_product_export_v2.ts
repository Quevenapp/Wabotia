// public.erp_catalog_product_export_v2: exportação (até 250 por vez), com componente.
import { registerRpc } from "../../../engine/registry.ts";
import { productExportV2 } from "../product-pages.ts";

registerRpc("erp_catalog_product_export_v2", (ctx, a) => productExportV2(ctx.db, a));
