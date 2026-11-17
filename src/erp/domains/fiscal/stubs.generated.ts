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
/** erp_fiscal_invoices.counts_for_balance(p_invoice uuid) → boolean */
export const countsForBalance = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.counts_for_balance");
/** erp_fiscal_invoices.edit_locks(p_id uuid) → jsonb */
export const editLocks = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.edit_locks");
/** erp_fiscal_invoices.guard_invoice() → trigger */
export const guardInvoice = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.guard_invoice");
/** erp_fiscal_invoices.import_input(p_value jsonb) → jsonb */
export const importInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.import_input");
/** erp_fiscal_invoices.installments_signature(p_payment jsonb) → jsonb */
export const installmentsSignature = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.installments_signature");
/** erp_fiscal_invoices.invoice_envelope(p_record jsonb, p_role text) → jsonb */
export const invoiceEnvelope = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_envelope");
/** erp_fiscal_invoices.invoice_input(p_data jsonb) → jsonb */
export const invoiceInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_input");
/** erp_fiscal_invoices.invoice_record(p_id uuid) → jsonb */
export const invoiceRecord = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_record");
/** erp_fiscal_invoices.invoice_specs() → jsonb */
export const invoiceSpecs = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.invoice_specs");
/** erp_fiscal_invoices.item_input(p_item jsonb, p_crt text, p_direction text) → jsonb */
export const itemInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.item_input");
/** erp_fiscal_invoices.items_signature(p_items jsonb) → jsonb */
export const itemsSignature = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.items_signature");
/** erp_fiscal_invoices.list_query(p_user_id uuid, p_origin text, p_model text, p_direction text, p_page integer, p_limit integer, p_order text, p_query text, p_date_type text, p_date_from date, p_date_to date, p_status text, p_product_id uuid, p_state text, p_nature text, p_carrier text, p_trade_name text, p_person_type text, p_document text, p_email text, p_phone text, p_series integer, p_contact_code text, p_order_number text, p_tracking text, p_seller_id uuid, p_tagged boolean, p_tag text, p_category_id uuid) → jsonb */
export const listQuery = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.list_query");
/** erp_fiscal_invoices.list_rows(p_origin text, p_model text, p_direction text, p_role text) → TABLE(origin text, id text, version integer, number integer, series integer, issue_date date, entry_date date, name text, trade_name text, document text, person_type text, email text, phone text, state text, nature text, status smallint, status_raw text, total numeric, environment text, issue_type text, access_key text, xml_id uuid, xml_hash text, xml_size integer, protocol_present boolean, event_count integer, carrier text, tracking text, contact_code text, product_ids uuid[], product_codes text[], orders jsonb, order_numbers text[]) */
export const listRows = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.list_rows");
/** erp_fiscal_invoices.money_input(p_value jsonb) → numeric */
export const moneyInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.money_input");
/** erp_fiscal_invoices.order_effects(p_id uuid) → jsonb */
export const orderEffects = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.order_effects");
/** erp_fiscal_invoices.orders_finance_locked(p_orders jsonb) → boolean */
export const ordersFinanceLocked = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.orders_finance_locked");
/** erp_fiscal_invoices.origin_seller_ids(p_seller uuid) → text[] */
export const originSellerIds = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.origin_seller_ids");
/** erp_fiscal_invoices.origin_status(p_value jsonb) → smallint */
export const originStatus = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.origin_status");
/** erp_fiscal_invoices.payment_input(p_value jsonb) → jsonb */
export const paymentInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.payment_input");
/** erp_fiscal_invoices.quantity_text(p numeric) → text */
export const quantityText = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.quantity_text");
/** erp_fiscal_invoices.recipient_input(p_value jsonb, p_model text) → jsonb */
export const recipientInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.recipient_input");
/** erp_fiscal_invoices.references_input(p_value jsonb) → jsonb */
export const referencesInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.references_input");
/** erp_fiscal_invoices.require_orders_readable(p_role text, p_id uuid, p_orders jsonb) → void */
export const requireOrdersReadable = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.require_orders_readable");
/** erp_fiscal_invoices.require_single_invoice(p_id uuid, p_direction text, p_orders jsonb) → void */
export const requireSingleInvoice = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.require_single_invoice");
/** erp_fiscal_invoices.sales_balance(p_document uuid) → jsonb */
export const salesBalance = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.sales_balance");
/** erp_fiscal_invoices.sales_full_invoice(p_document uuid) → uuid */
export const salesFullInvoice = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.sales_full_invoice");
/** erp_fiscal_invoices.sales_item_invoiced(p_document uuid) → TABLE(document_item_id uuid, quantity numeric) */
export const salesItemInvoiced = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.sales_item_invoiced");
/** erp_fiscal_invoices.status_group(p_group text) → smallint[] */
export const statusGroup = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.status_group");
/** erp_fiscal_invoices.store_items(p_id uuid, p_items jsonb) → void */
export const storeItems = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.store_items");
/** erp_fiscal_invoices.store_orders(p_id uuid, p_direction text, p_orders jsonb) → void */
export const storeOrders = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.store_orders");
/** erp_fiscal_invoices.transport_input(p_value jsonb) → jsonb */
export const transportInput = (..._args: unknown[]): never => notPorted("erp_fiscal_invoices.transport_input");
/** erp_fiscal_mirror.coverage(p_user_id uuid, p_model text, p_direction text) → jsonb */
export const coverage = (..._args: unknown[]): never => notPorted("erp_fiscal_mirror.coverage");
/** public.erp_fiscal_invoice_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb) → jsonb */
export const erpFiscalInvoiceExecute = (..._args: unknown[]): never => notPorted("public.erp_fiscal_invoice_execute");
