// Semeadura usada nos testes do Fiscal (sales-balance) e invoice-guards.
// Sem escrita pelo domínio Fiscal: a nota e os itens são espelhados por f.sync.
import { randomUUID } from "node:crypto";
export async function seed(f, sql, args = []) {
  await f.db.exec("set session_replication_role = replica");
  try { await f.db.query(sql, args); }
  finally { await f.db.exec("set session_replication_role = origin"); }
  await f.sync();
}
export async function invoice(f, { direction = "0", status = 1, version = 1, items, contact = null, number = 42 } = {}) {
  const id = randomUUID();
  await seed(f, `insert into erp_fiscal_invoices.invoice(id,model,direction,issue_type,environment,status,series,number,nature_description,issue_date,crt,purpose,presence,final_consumer,recipient,doc_references,transport,payment,authorized_xml,intermediary,auto_tax,freight,insurance,other_expenses,discount,totals,version,created_by,updated_by)
    values($1,'55',$2,'N','2',$3,1,$4,'Compra','2024-09-01','1','1','0',false,$5,'[]','{}','{}','[]','{}',false,0,0,0,0,'{"total":10}',$6,$7,$7)`,
    [id, direction, status, number, JSON.stringify({ name: "Fornecedor", contact_id: contact }), version, f.users.admin]);
  for (const [index, item] of (items ?? []).entries()) {
    const { product_id = null, quantity = "2", unit_price = "5", ...data } = item;
    await seed(f, `insert into erp_fiscal_invoices.invoice_item(invoice_id,position,product_id,quantity,unit_price,total,freight,insurance,other_expenses,discount,data)
      values($1,$2,$3,$4,$5,10,0,0,0,0,$6)`, [id, index + 1, product_id, quantity, unit_price, JSON.stringify({ description: "Item da nota", unit: "UN", ...data })]);
  }
  return id;
}
export const product = (f, extra = {}) => f.catalog("products", { name: `Produto ${randomUUID()}`, unit: "UN", kind: "P", format: "S", price: "10", ...extra });
export const error = (message, code = "22023") => e => e.code === code && e.message === message;
export const readEffects = async (f, product) => {
  await f.rpc("erp_stock_balances", { p_user_id: f.users.estoque, p_product_id: product });
  await f.rpc("erp_stock_movements", { p_user_id: f.users.estoque, p_product_id: product });
};
