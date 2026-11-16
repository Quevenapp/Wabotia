// public.erp_catalog_set_active = erp_catalog.mutate(…, null, true, p_active)
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { boolArg, intArg, textArg, uuidArg } from "../args.ts";
import { mutate } from "../record.ts";

export function erpCatalogSetActive(ctx: RpcContext, a: RpcArgs) {
  return mutate(ctx, {
    user: uuidArg(a, "p_user_id"),
    entity: textArg(a, "p_entity"),
    id: uuidArg(a, "p_id"),
    expected: intArg(a, "p_expected_version"),
    command: uuidArg(a, "p_command_id"),
    data: null,
    setActive: true,
    active: boolArg(a, "p_active"),
  });
}

registerRpc("erp_catalog_set_active", erpCatalogSetActive);
