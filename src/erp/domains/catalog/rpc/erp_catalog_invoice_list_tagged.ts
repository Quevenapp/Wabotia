import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { invoiceListTagged } from "../invoice-list-tagged.ts";

export function erpCatalogInvoiceListTagged(ctx: RpcContext, args: RpcArgs) {
  return invoiceListTagged(ctx, args);
}

registerRpc("erp_catalog_invoice_list_tagged", erpCatalogInvoiceListTagged);
