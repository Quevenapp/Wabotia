// Recursos por papel compartilhados com o painel, sem dependências do motor.
export const ROLE_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  admin: ["contacts", "products", "sales_orders", "purchase_orders", "sales_proposals", "receivables", "payables", "nfe", "nfce"],
  consulta: ["contacts", "products", "sales_orders", "purchase_orders", "sales_proposals", "receivables", "payables", "nfe", "nfce"],
  vendas: ["contacts", "products", "sales_orders", "sales_proposals"],
  financeiro: ["contacts", "receivables", "payables"],
  estoque: ["contacts", "products", "purchase_orders"],
  fiscal: ["contacts", "products", "sales_orders", "purchase_orders", "nfe", "nfce"],
};
/** erp_access.resources_for_role */
export const resourcesForRole = (role: string | null): string[] => [...(ROLE_RESOURCES[role ?? ""] ?? [])];

