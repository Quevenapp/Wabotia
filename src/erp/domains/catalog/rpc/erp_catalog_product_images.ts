// public.erp_catalog_product_images: as imagens prontas do produto (na
// ordem), as reservadas e o total em bytes. Produto excluído ainda lista.
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { uuidArg } from "../pricing/args.ts";
import { imageAuthorize, imagesData } from "../product-images.ts";

export function erpCatalogProductImages(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  imageAuthorize(ctx.db, user, product, false);
  return imagesData(ctx.db, product!);
}

registerRpc("erp_catalog_product_images", erpCatalogProductImages);
