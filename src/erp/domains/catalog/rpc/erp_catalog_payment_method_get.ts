// public.erp_catalog_payment_method_get
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { paymentMethodAccess, paymentMethodAccounts, paymentMethodDto, readRow } from "../payment-method.ts";

export function erpCatalogPaymentMethodGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const role = paymentMethodAccess(ctx.db, user, false);
  if (id === null || !readRow(ctx.db, id)) raise("P0002", "erp_catalog_not_found");
  return {
    entity: "payment_methods",
    data_mode: "erp_native",
    can_write: ["admin", "financeiro"].includes(role),
    item: paymentMethodDto(ctx.db, id),
    accounts: paymentMethodAccounts(ctx.db),
  };
}

registerRpc("erp_catalog_payment_method_get", erpCatalogPaymentMethodGet);
