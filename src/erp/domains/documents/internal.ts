// Documentos (erp_documents): funções internas. Portado de
// erp_documents.auto_products, a parte de erp_document_save que chama o
// catálogo (outro domínio) com o comando do documento.
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { arrow, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { autoProductKey, documentProduct } from "../catalog/public.ts";
import * as preferences from "../preferences/public.ts";

/** erp_documents.auto_products(p_user_id, p_kind, p_command, p_items) */
export function autoProducts(ctx: RpcContext, user: string, kind: string | null, command: string | null, items: unknown) {
  const list = () => {
    if (jsonType(items) !== "array")
      raise("22023", `cannot extract elements from ${jsonType(items) === "object" ? "an object" : "a scalar"}`);
    return items as unknown[];
  };
  if (
    preferences.get(ctx.db, autoProductKey(kind)) !== true ||
    !list().some((i) => arrow(i, "product_id") === null) ||
    (kind === "sales_orders" &&
      one(ctx.db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE user_id=? AND allow_unregistered_products=0', user))
  )
    return items;
  return list().map((raw) => {
    if (arrow(raw, "product_id") !== null) return raw;
    const item = raw as Record<string, unknown>;
    const id = documentProduct(
      ctx,
      user,
      kind,
      command,
      kind === "service_orders" && arrow(item, "group") === "service" ? { ...item, kind: "S" } : item,
    );
    return id === null ? raw : { ...item, product_id: id };
  });
}
