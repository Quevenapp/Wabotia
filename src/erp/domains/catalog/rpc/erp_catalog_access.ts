// public.erp_catalog_access: o que o papel lê e escreve no catálogo.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { activeRole } from "../../access/public.ts";
import { allowed } from "../access.ts";

const ENTITIES = ["contacts", "products", "warehouses"];

export function erpCatalogAccess(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const role = user === null ? null : activeRole(ctx.db, user);
  if (role === null) raise("42501", "erp_catalog_access_denied");
  return {
    read: ENTITIES.filter((e) => allowed(role, e, false)),
    write: ENTITIES.filter((e) => allowed(role, e, true)),
    data_mode: "erp_native",
  };
}

registerRpc("erp_catalog_access", erpCatalogAccess);
