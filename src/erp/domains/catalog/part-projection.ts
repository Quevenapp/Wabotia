import type { ErpParts } from "../../parts.ts";

type Data = Record<string, unknown>;
export const CONTACT_FINANCE_FIELDS = ["credit_limit", "credit_limit_mode", "finance_category_id", "finance_category_name"];
export const PAYMENT_FINANCE_FIELDS = ["account_id", "account_name", "interest_rate", "fine_rate", "auto_settle", "fee_type", "fee_rate", "fee_fixed", "settlement_days"];
export const SELLER_FINANCE_FIELDS = ["commission_rule", "commission_mode", "commission_rate", "commission_bands"];
export const PRODUCT_STOCK_FIELDS = ["stock_min", "stock_max", "location", "lot_control"];

/** Só respostas: os escritores continuam comparando e preservando os dados integrais. */
export function projectCatalogRecord(parts: Readonly<ErpParts>, entity: string, value: Data): Data {
  const out = { ...value };
  const unavailable = new Set<string>(Array.isArray(value.unavailable_parts) ? value.unavailable_parts as string[] : []);
  const omit = (keys: string[]) => keys.forEach(key => delete out[key]);
  if (["contacts", "payment_methods", "sellers"].includes(entity) && !parts.finance) {
    unavailable.add("finance");
    omit(entity === "contacts" ? CONTACT_FINANCE_FIELDS : entity === "payment_methods" ? PAYMENT_FINANCE_FIELDS : SELLER_FINANCE_FIELDS);
  }
  if (entity === "contacts" && !parts.fiscal) {
    unavailable.add("fiscal");
    omit(["operation_nature_id", "operation_nature_name"]);
  }
  if (entity === "products") {
    if (!parts.stock) { unavailable.add("stock"); omit(PRODUCT_STOCK_FIELDS); }
    if (!parts.purchases || !parts.stock) {
      if (!parts.purchases) unavailable.add("purchases");
      if (!parts.stock) unavailable.add("stock");
      omit(["cost_price", "suppliers", "supplier_id", "purchase_price", "supplier", "default_supplier"]);
    }
  }
  if (unavailable.size) out.unavailable_parts = [...unavailable];
  return out;
}

/** Recibos antigos são projetados sem reler o cadastro nem repetir seus efeitos. */
export function projectCatalogResult(parts: Readonly<ErpParts>, result: Data): Data {
  const out = { ...result };
  const project = (entity: string, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? projectCatalogRecord(parts, entity, value as Data) : value;
  if (typeof out.entity === "string") {
    for (const key of ["record", "item"]) if (key in out) out[key] = project(out.entity, out[key]);
    if (Array.isArray(out.items)) out.items = out.items.map(value => project(out.entity as string, value));
  }
  if (out.seller) out.seller = project("sellers", out.seller);
  if (out.contact) out.contact = project("contacts", out.contact);
  const unavailable = new Set<string>(Array.isArray(out.unavailable_parts) ? out.unavailable_parts as string[] : []);
  for (const value of [out.record, out.item, out.seller, out.contact, ...(Array.isArray(out.items) ? out.items : [])]) {
    if (value && typeof value === "object" && Array.isArray((value as Data).unavailable_parts))
      for (const part of (value as Data).unavailable_parts as string[]) unavailable.add(part);
  }
  if (out.entity === "products" && (!parts.purchases || !parts.stock)) delete out.supplier_id;
  if (unavailable.size) out.unavailable_parts = [...unavailable];
  return out;
}
