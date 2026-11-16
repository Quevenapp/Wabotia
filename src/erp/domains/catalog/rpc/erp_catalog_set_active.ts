// public.erp_catalog_set_active = erp_catalog.mutate(…, null, true, p_active)
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { mutate } from "../record.ts";

export function erpCatalogSetActive(ctx: RpcContext, a: RpcArgs) {
  return mutate(ctx, {
    user: ((a.p_user_id ?? null) as string | null),
    entity: ((a.p_entity ?? null) as string | null),
    id: ((a.p_id ?? null) as string | null),
    expected: ((a.p_expected_version ?? null) as number | null),
    command: ((a.p_command_id ?? null) as string | null),
    data: null,
    setActive: true,
    active: ((a.p_active ?? null) as boolean | null),
  });
}

registerRpc("erp_catalog_set_active", erpCatalogSetActive);
