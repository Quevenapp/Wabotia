// Estoque (erp_stock, erp_purchase_receipts): o que outros domínios chamam
// (docs/ERP-PORTE.md). Porte a função aqui com o nome do stub; o stub sai na
// próxima geração (scripts/erp/gen-ownership.mjs).
export * from "./stubs.generated.ts";
export { movementDto, requireAccess, reservedQuantity } from "./internal.ts";
export { erpStockPost } from "./rpc/erp_stock_post.ts";
