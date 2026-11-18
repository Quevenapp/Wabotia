// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_fiscal_invoices.access_key_valid(p_key text) → boolean */
export const accessKeyValid = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.access_key_valid");
/** erp_fiscal_invoices.allocate(p_amount numeric, p_weights numeric[]) → numeric[] */
export const allocate = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.allocate");
/** erp_fiscal_invoices.array_input(p_value jsonb, p_max integer) → jsonb */
export const arrayInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.array_input");
/** erp_fiscal_invoices.authorized_input(p_value jsonb) → jsonb */
export const authorizedInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.authorized_input");
/** erp_fiscal_invoices.check_sales_item_links() → trigger */
export const checkSalesItemLinks = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.check_sales_item_links");
/** erp_fiscal_invoices.import_input(p_value jsonb) → jsonb */
export const importInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.import_input");
/** erp_fiscal_invoices.installments_signature(p_payment jsonb) → jsonb */
export const installmentsSignature = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.installments_signature");
/** erp_fiscal_invoices.invoice_input(p_data jsonb) → jsonb */
export const invoiceInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_input");
/** erp_fiscal_invoices.invoice_specs() → jsonb */
export const invoiceSpecs = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_specs");
/** erp_fiscal_invoices.item_input(p_item jsonb, p_crt text, p_direction text) → jsonb */
export const itemInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.item_input");
/** erp_fiscal_invoices.items_signature(p_items jsonb) → jsonb */
export const itemsSignature = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.items_signature");
/** erp_fiscal_invoices.money_input(p_value jsonb) → numeric */
export const moneyInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.money_input");
/** erp_fiscal_invoices.orders_finance_locked(p_orders jsonb) → boolean */
export const ordersFinanceLocked = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.orders_finance_locked");
/** erp_fiscal_invoices.origin_status(p_value jsonb) → smallint */
export const originStatus = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.origin_status");
/** erp_fiscal_invoices.payment_input(p_value jsonb) → jsonb */
export const paymentInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.payment_input");
/** erp_fiscal_invoices.recipient_input(p_value jsonb, p_model text) → jsonb */
export const recipientInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.recipient_input");
/** erp_fiscal_invoices.references_input(p_value jsonb) → jsonb */
export const referencesInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.references_input");
/** erp_fiscal_invoices.require_orders_readable(p_role text, p_id uuid, p_orders jsonb) → void */
export const requireOrdersReadable = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.require_orders_readable");
/** erp_fiscal_invoices.require_single_invoice(p_id uuid, p_direction text, p_orders jsonb) → void */
export const requireSingleInvoice = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.require_single_invoice");
/** erp_fiscal_invoices.store_items(p_id uuid, p_items jsonb) → void */
export const storeItems = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.store_items");
/** erp_fiscal_invoices.store_orders(p_id uuid, p_direction text, p_orders jsonb) → void */
export const storeOrders = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.store_orders");
/** erp_fiscal_invoices.transport_input(p_value jsonb) → jsonb */
export const transportInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.transport_input");
/** public.erp_fiscal_invoice_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb) → jsonb */
export const erpFiscalInvoiceExecute = (..._args: unknown[]): never => notPorted("public.erp_fiscal_invoice_execute");
