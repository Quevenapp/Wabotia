// Acesso: o próprio usuário. public.erp_access_me e erp_access_permissions_me.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { activeRole, gateRequired, resourcesForRole } from "../public.ts";
import { orderedPermissions, scheduleAllows, scheduleUntil } from "../internal.ts";

const user = (a: RpcArgs) => (a.p_user_id === undefined ? null : (a.p_user_id as string | null));

registerRpc("erp_access_me", (ctx: RpcContext, a: RpcArgs) => {
  const id = user(a);
  const role = id ? activeRole(ctx.db, id) : null;
  if (!id || !role) raise("42501", "erp_access_denied");
  return {
    user_id: id,
    role,
    resources: resourcesForRole(role),
    data_mode: "staging_readonly",
    access_window: scheduleAllows(ctx.db, id, ctx.clock.next()) ? "open" : "closed",
    gate_required: gateRequired(ctx.db, id),
  };
});

registerRpc("erp_access_permissions_me", (ctx: RpcContext, a: RpcArgs) => {
  const id = user(a);
  const role = id ? activeRole(ctx.db, id) : null;
  if (!id || !role) raise("42501", "erp_access_denied");
  const c = one(ctx.db, 'SELECT user_type, permissions FROM "erp_access__user_control" WHERE user_id=?', id);
  const now = ctx.clock.next();
  const until = scheduleUntil(ctx.db, id, now);
  return {
    scope: "access_permissions",
    data_mode: "erp_native",
    user_id: id,
    role,
    user_type: (c?.user_type as string) ?? "normal",
    permissions: orderedPermissions(role, c?.permissions === null || c?.permissions === undefined ? null : JSON.parse(String(c.permissions))),
    access: { open: scheduleAllows(ctx.db, id, now), until: until === null ? null : jsonTimestamp(until) },
  };
});
