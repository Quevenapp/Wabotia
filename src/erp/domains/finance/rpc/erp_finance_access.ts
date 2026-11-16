// public.erp_finance_access: o que a pessoa pode no Financeiro (leitura,
// escrita e as permissões finas de finanças, comissões, controle de caixa e
// "lançar contas" dos documentos).
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { permissionKeys, permitted } from "../../access/public.ts";
import { requireAccess, uuidArg } from "../internal.ts";

export function erpFinanceAccess(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const role = requireAccess(ctx.db, user, false);
  return {
    read: true,
    write: ["admin", "financeiro"].includes(role),
    permitted: permissionKeys().filter(
      (k) =>
        (k.startsWith("financas.") || k.startsWith("vendas.comissoes") || k.startsWith("vendas.controle_caixa") || k.endsWith(".lancar_contas")) &&
        permitted(ctx.db, user, k),
    ),
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_access", erpFinanceAccess);
