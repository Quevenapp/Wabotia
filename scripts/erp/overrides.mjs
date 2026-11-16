// Decisões do conversor que o catálogo não diz sozinho (PLANO-FAGOO-MOTOR.md,
// seção 3: "decisão por coluna em overrides"). Na fase 2, cada domínio cuida
// das suas entradas.

/**
 * numeric sem precisão no Postgres (20 colunas): a escala vem do uso no
 * Fagoo. Preço e custo unitário: 10 casas (o preço de lista do Fagoo usa até
 * 10); quantidades: 6 casas (como numeric(18,6) do estoque).
 */
const price = { scale: 10, precision: 30 };
const quantity = { scale: 6, precision: 18 };
export const overrides = {
  columns: {
    "erp_catalog.product.price": price,
    "erp_catalog.product_supplier.purchase_price": price,
    "erp_catalog.product_supplier.cost_price": price,
    "erp_documents.item.unit_price": price,
    "erp_fiscal_invoices.invoice_item.quantity": quantity,
    "erp_fiscal_invoices.invoice_item.unit_price": price,
    "erp_fiscal_invoices.invoice_order_item.quantity": quantity,
    "erp_pricing.price_list_item.custom_price": price,
    "erp_stock.checkin_event.quantity": quantity,
    "erp_stock.checkin_event.previous": quantity,
    "erp_stock.checkin_item.quantity": quantity,
    "erp_stock.checkin_item.unit_price": price,
    "erp_stock.checkin_item.received": quantity,
    "erp_stock.checkin_item.issue_quantity": quantity,
    "erp_stock.movement_detail.unit_price": price,
    "erp_stock.movement_detail.unit_cost": price,
    "erp_stock_mirror.observation.physical": quantity,
    "erp_stock_mirror.observation.virtual": quantity,
    "erp_stock_mirror.observation.physical_delta": quantity,
    "erp_stock_mirror.observation.virtual_delta": quantity,
  },
  /** Tabelas que não vêm para o objeto, com o motivo. */
  discardTables: {},
};
