// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_purchase_receipts.guard_legacy() → trigger */
export const guardLegacy = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.guard_legacy");
/** erp_stock.command_taken(p_id uuid) → boolean */
export const commandTaken = (..._args: unknown[]): never => notPorted("erp_stock.command_taken");
/** erp_stock.composition_own_stock(p_product uuid) → boolean */
export const compositionOwnStock = (..._args: unknown[]): never => notPorted("erp_stock.composition_own_stock");
/** erp_stock.cost_visible(p_actor uuid) → boolean */
export const costVisible = (..._args: unknown[]): never => notPorted("erp_stock.cost_visible");
/** erp_stock.default_supplier(p_product uuid) → TABLE(supplier_id uuid, supplier_name text, code text, purchase_price numeric, cost_price numeric) */
export const defaultSupplier = (..._args: unknown[]): never => notPorted("erp_stock.default_supplier");
/** erp_stock.document_access(p_actor uuid, p_kind text) → void */
export const documentAccess = (..._args: unknown[]): never => notPorted("erp_stock.document_access");
/** erp_stock.document_command_finish(p_actor uuid, p_id uuid, p_action text, p_data jsonb, p_result jsonb) → jsonb */
export const documentCommandFinish = (..._args: unknown[]): never => notPorted("erp_stock.document_command_finish");
/** erp_stock.document_command_start(p_actor uuid, p_id uuid, p_action text, p_data jsonb) → jsonb */
export const documentCommandStart = (..._args: unknown[]): never => notPorted("erp_stock.document_command_start");
/** erp_stock.document_lock(p_actor uuid, p_kind text, p_id uuid, p_version integer) → erp_documents.document */
export const documentLock = (..._args: unknown[]): never => notPorted("erp_stock.document_lock");
/** erp_stock.document_meta(p_day date, p_reason text) → void */
export const documentMeta = (..._args: unknown[]): never => notPorted("erp_stock.document_meta");
/** erp_stock.document_preview_data(d erp_documents.document, p_day date, p_reason text) → jsonb */
export const documentPreviewData = (..._args: unknown[]): never => notPorted("erp_stock.document_preview_data");
/** erp_stock.document_reverse_preview_data(d erp_documents.document, p_id uuid, p_version integer, p_day date, p_reason text) → jsonb */
export const documentReversePreviewData = (..._args: unknown[]): never => notPorted("erp_stock.document_reverse_preview_data");
/** erp_stock.guard_composition() → trigger */
export const guardComposition = (..._args: unknown[]): never => notPorted("erp_stock.guard_composition");
/** erp_stock.guard_composition_command() → trigger */
export const guardCompositionCommand = (..._args: unknown[]): never => notPorted("erp_stock.guard_composition_command");
/** erp_stock.guard_composition_item() → trigger */
export const guardCompositionItem = (..._args: unknown[]): never => notPorted("erp_stock.guard_composition_item");
/** erp_stock.guard_document_posting() → trigger */
export const guardDocumentPosting = (..._args: unknown[]): never => notPorted("erp_stock.guard_document_posting");
/** erp_stock.guard_invoice_stock_delete() → trigger */
export const guardInvoiceStockDelete = (..._args: unknown[]): never => notPorted("erp_stock.guard_invoice_stock_delete");
/** erp_stock.guard_lot() → trigger */
export const guardLot = (..._args: unknown[]): never => notPorted("erp_stock.guard_lot");
/** erp_stock.guard_lot_entry() → trigger */
export const guardLotEntry = (..._args: unknown[]): never => notPorted("erp_stock.guard_lot_entry");
/** erp_stock.guard_negative_insert() → trigger */
export const guardNegativeInsert = (..._args: unknown[]): never => notPorted("erp_stock.guard_negative_insert");
/** erp_stock.guard_reserved_balance() → trigger */
export const guardReservedBalance = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_balance");
/** erp_stock.guard_reserved_posting() → trigger */
export const guardReservedPosting = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_posting");
/** erp_stock.invoice_screen(p_model text, p_direction text) → text */
export const invoiceScreen = (..._args: unknown[]): never => notPorted("erp_stock.invoice_screen");
/** erp_stock.last_purchase(p_product uuid, p_balances boolean) → TABLE(unit_price numeric, unit_cost numeric, occurred_on date, movement_id uuid, source text) */
export const lastPurchase = (..._args: unknown[]): never => notPorted("erp_stock.last_purchase");
/** erp_stock.ledger_origin(p_movement_id uuid) → jsonb */
export const ledgerOrigin = (..._args: unknown[]): never => notPorted("erp_stock.ledger_origin");
/** erp_stock.lot_check(p_code text, p_manufactured date, p_expires date, p_note text) → void */
export const lotCheck = (..._args: unknown[]): never => notPorted("erp_stock.lot_check");
/** erp_stock.lot_dto(p_lot uuid, p_warehouse uuid) → jsonb */
export const lotDto = (..._args: unknown[]): never => notPorted("erp_stock.lot_dto");
/** erp_stock.lot_expiry_state(p_active boolean, p_expires date, p_quantity numeric, p_today date, p_days integer) → text */
export const lotExpiryState = (..._args: unknown[]): never => notPorted("erp_stock.lot_expiry_state");
/** erp_stock.lot_settings() → jsonb */
export const lotSettings = (..._args: unknown[]): never => notPorted("erp_stock.lot_settings");
/** erp_stock.negative_allowed() → boolean */
export const negativeAllowed = (..._args: unknown[]): never => notPorted("erp_stock.negative_allowed");
/** erp_stock.post_document_lots() → trigger */
export const postDocumentLots = (..._args: unknown[]): never => notPorted("erp_stock.post_document_lots");
/** erp_stock.post_physical_025(p_user_id uuid, p_command_id uuid, p_kind text, p_occurred_on date, p_reason text, p_reference text, p_items jsonb, p_reverses_id uuid) → jsonb */
export const postPhysical025 = (..._args: unknown[]): never => notPorted("erp_stock.post_physical_025");
/** erp_stock.reverse_lot_entries() → trigger */
export const reverseLotEntries = (..._args: unknown[]): never => notPorted("erp_stock.reverse_lot_entries");
/** erp_stock.sales_negative_allowed() → boolean */
export const salesNegativeAllowed = (..._args: unknown[]): never => notPorted("erp_stock.sales_negative_allowed");
/** public.erp_stock_product_compose(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid, p_data jsonb, p_acknowledged jsonb, p_composition jsonb) → jsonb */
export const erpStockProductCompose = (..._args: unknown[]): never => notPorted("public.erp_stock_product_compose");
