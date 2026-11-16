// public.erp_catalog_employee_get: ficha do funcionário (só administrador).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { employeeAdmin, employeeDto } from "../employee.ts";

export function erpCatalogEmployeeGet(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const id = ((a.p_id ?? null) as string | null);
  employeeAdmin(ctx.db, user);
  if (id === null || !one(ctx.db, 'SELECT 1 x FROM "erp_catalog__employee" WHERE id=?', id))
    raise("P0002", "erp_catalog_not_found");
  return { entity: "employees", data_mode: "erp_native", item: employeeDto(ctx.db, id) };
}

registerRpc("erp_catalog_employee_get", erpCatalogEmployeeGet);
