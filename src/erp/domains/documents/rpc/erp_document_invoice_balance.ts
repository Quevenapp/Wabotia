// public.erp_document_invoice_balance: saldo de faturamento do pedido de venda (quanto de cada item já
// saiu em nota e quanto falta). O cálculo é do Fiscal (salesBalance no public.ts da G); aqui fica o acesso.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { salesBalance } from "../../fiscal/public.ts";
import { requireVisible } from "../mirror.ts";
import { contactUsable, requireAccess } from "../reads-g.ts";

export function erpDocumentInvoiceBalance(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = (a.p_user_id as string | null) ?? null;
  const id = (a.p_document_id as string | null | undefined) ?? null;
  requireVisible(db, user, id, false);
  requireAccess(db, user, "sales_orders", false);
  const doc = id === null ? undefined : one(db, `SELECT contact_id FROM "erp_documents__document" WHERE id=? AND kind='sales_orders'`, id);
  if (!doc) raise("P0002", "erp_document_not_found");
  // Contato acessível somente ao vendedor vinculado: o mesmo escopo do próprio pedido.
  if (!contactUsable(db, user, (doc!.contact_id as string | null) ?? null)) raise("P0002", "erp_document_not_found");
  return { scope: "document_invoice_balance", data_mode: "erp_native", ...salesBalance(db, id!) };
}

registerRpc("erp_document_invoice_balance", erpDocumentInvoiceBalance);
