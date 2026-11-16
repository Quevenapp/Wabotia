// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_purchase_receipts.active(p_document uuid) → boolean */
export const active = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.active");
/** erp_purchase_receipts.guard_document() → trigger */
export const guardDocument = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.guard_document");
/** erp_purchase_receipts.guard_item() → trigger */
export const guardItem = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.guard_item");
/** erp_purchase_receipts.guard_legacy() → trigger */
export const guardLegacy = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.guard_legacy");
/** erp_stock.average_costs(p_products uuid[]) → TABLE(product_id uuid, average_cost numeric) */
export const averageCosts = (..._args: unknown[]): never => notPorted("erp_stock.average_costs");
/** erp_stock.balance_kept(p_movement uuid, p_product uuid, p_warehouse uuid) → boolean */
export const balanceKept = (..._args: unknown[]): never => notPorted("erp_stock.balance_kept");
/** erp_stock.command_taken(p_id uuid) → boolean */
export const commandTaken = (..._args: unknown[]): never => notPorted("erp_stock.command_taken");
/** erp_stock.component_problem(p_component uuid) → text */
export const componentProblem = (..._args: unknown[]): never => notPorted("erp_stock.component_problem");
/** erp_stock.component_quantity(p_quantity numeric, p_per_kit numeric) → numeric */
export const componentQuantity = (..._args: unknown[]): never => notPorted("erp_stock.component_quantity");
/** erp_stock.composition_apply_values(p_user_id uuid, p_command_id uuid, p_product uuid, p_skip_base boolean) → jsonb */
export const compositionApplyValues = (..._args: unknown[]): never => notPorted("erp_stock.composition_apply_values");
/** erp_stock.composition_dto(p_product uuid) → jsonb */
export const compositionDto = (..._args: unknown[]): never => notPorted("erp_stock.composition_dto");
/** erp_stock.composition_lines(p_product uuid, p_quantity numeric) → TABLE(product_id uuid, quantity numeric, per_kit numeric, role text) */
export const compositionLines = (..._args: unknown[]): never => notPorted("erp_stock.composition_lines");
/** erp_stock.composition_own_stock(p_product uuid) → boolean */
export const compositionOwnStock = (..._args: unknown[]): never => notPorted("erp_stock.composition_own_stock");
/** erp_stock.composition_totals(p_product uuid, p_items jsonb) → jsonb */
export const compositionTotals = (..._args: unknown[]): never => notPorted("erp_stock.composition_totals");
/** erp_stock.cost_visible(p_actor uuid) → boolean */
export const costVisible = (..._args: unknown[]): never => notPorted("erp_stock.cost_visible");
/** erp_stock.count_physical(p_product uuid, p_warehouse uuid) → numeric */
export const countPhysical = (..._args: unknown[]): never => notPorted("erp_stock.count_physical");
/** erp_stock.default_supplier(p_product uuid) → TABLE(supplier_id uuid, supplier_name text, code text, purchase_price numeric, cost_price numeric) */
export const defaultSupplier = (..._args: unknown[]): never => notPorted("erp_stock.default_supplier");
/** erp_stock.derived_command(p_command uuid, p_part text) → uuid */
export const derivedCommand = (..._args: unknown[]): never => notPorted("erp_stock.derived_command");
/** erp_stock.document_access(p_actor uuid, p_kind text) → void */
export const documentAccess = (..._args: unknown[]): never => notPorted("erp_stock.document_access");
/** erp_stock.document_command_finish(p_actor uuid, p_id uuid, p_action text, p_data jsonb, p_result jsonb) → jsonb */
export const documentCommandFinish = (..._args: unknown[]): never => notPorted("erp_stock.document_command_finish");
/** erp_stock.document_command_start(p_actor uuid, p_id uuid, p_action text, p_data jsonb) → jsonb */
export const documentCommandStart = (..._args: unknown[]): never => notPorted("erp_stock.document_command_start");
/** erp_stock.document_eligible(p_kind text, p_status text) → boolean */
export const documentEligible = (..._args: unknown[]): never => notPorted("erp_stock.document_eligible");
/** erp_stock.document_item_lots(p_data jsonb) → TABLE(lot_id uuid, quantity numeric, ordinal integer) */
export const documentItemLots = (..._args: unknown[]): never => notPorted("erp_stock.document_item_lots");
/** erp_stock.document_lock(p_actor uuid, p_kind text, p_id uuid, p_version integer) → erp_documents.document */
export const documentLock = (..._args: unknown[]): never => notPorted("erp_stock.document_lock");
/** erp_stock.document_meta(p_day date, p_reason text) → void */
export const documentMeta = (..._args: unknown[]): never => notPorted("erp_stock.document_meta");
/** erp_stock.document_posting_summary(p_id uuid) → jsonb */
export const documentPostingSummary = (..._args: unknown[]): never => notPorted("erp_stock.document_posting_summary");
/** erp_stock.document_preview_data(d erp_documents.document, p_day date, p_reason text) → jsonb */
export const documentPreviewData = (..._args: unknown[]): never => notPorted("erp_stock.document_preview_data");
/** erp_stock.document_reverse_preview_data(d erp_documents.document, p_id uuid, p_version integer, p_day date, p_reason text) → jsonb */
export const documentReversePreviewData = (..._args: unknown[]): never => notPorted("erp_stock.document_reverse_preview_data");
/** erp_stock.document_summary(p_id uuid) → jsonb */
export const documentSummary = (..._args: unknown[]): never => notPorted("erp_stock.document_summary");
/** erp_stock.effect_document_allowed(o erp_documents.document, n erp_documents.document) → boolean */
export const effectDocumentAllowed = (..._args: unknown[]): never => notPorted("erp_stock.effect_document_allowed");
/** erp_stock.effect_edit_allowed(o erp_documents.document, n erp_documents.document) → boolean */
export const effectEditAllowed = (..._args: unknown[]): never => notPorted("erp_stock.effect_edit_allowed");
/** erp_stock.effect_item_allowed(p_op text, o erp_documents.item, n erp_documents.item) → boolean */
export const effectItemAllowed = (..._args: unknown[]): never => notPorted("erp_stock.effect_item_allowed");
/** erp_stock.effect_transition_allowed(p_kind text, p_from text, p_to text) → boolean */
export const effectTransitionAllowed = (..._args: unknown[]): never => notPorted("erp_stock.effect_transition_allowed");
/** erp_stock.forget_item_components() → trigger */
export const forgetItemComponents = (..._args: unknown[]): never => notPorted("erp_stock.forget_item_components");
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
/** erp_stock.guard_posted_document() → trigger */
export const guardPostedDocument = (..._args: unknown[]): never => notPorted("erp_stock.guard_posted_document");
/** erp_stock.guard_posted_item() → trigger */
export const guardPostedItem = (..._args: unknown[]): never => notPorted("erp_stock.guard_posted_item");
/** erp_stock.guard_reserved_balance() → trigger */
export const guardReservedBalance = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_balance");
/** erp_stock.guard_reserved_document() → trigger */
export const guardReservedDocument = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_document");
/** erp_stock.guard_reserved_item() → trigger */
export const guardReservedItem = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_item");
/** erp_stock.guard_reserved_posting() → trigger */
export const guardReservedPosting = (..._args: unknown[]): never => notPorted("erp_stock.guard_reserved_posting");
/** erp_stock.ignored_warehouse(p_id uuid) → boolean */
export const ignoredWarehouse = (..._args: unknown[]): never => notPorted("erp_stock.ignored_warehouse");
/** erp_stock.invoice_posted_for_document(p_document uuid) → boolean */
export const invoicePostedForDocument = (..._args: unknown[]): never => notPorted("erp_stock.invoice_posted_for_document");
/** erp_stock.invoice_screen(p_model text, p_direction text) → text */
export const invoiceScreen = (..._args: unknown[]): never => notPorted("erp_stock.invoice_screen");
/** erp_stock.invoice_unit_price(p_price numeric, p_snapshot jsonb, p_position integer, p_product uuid) → numeric */
export const invoiceUnitPrice = (..._args: unknown[]): never => notPorted("erp_stock.invoice_unit_price");
/** erp_stock.item_component_rows(p_item uuid, p_product uuid) → TABLE(component_id uuid, quantity numeric, post_mode text, ordinal integer) */
export const itemComponentRows = (..._args: unknown[]): never => notPorted("erp_stock.item_component_rows");
/** erp_stock.item_composition_lines(p_item uuid, p_product uuid, p_quantity numeric) → TABLE(product_id uuid, quantity numeric, per_kit numeric, role text) */
export const itemCompositionLines = (..._args: unknown[]): never => notPorted("erp_stock.item_composition_lines");
/** erp_stock.last_purchase(p_product uuid, p_balances boolean) → TABLE(unit_price numeric, unit_cost numeric, occurred_on date, movement_id uuid, source text) */
export const lastPurchase = (..._args: unknown[]): never => notPorted("erp_stock.last_purchase");
/** erp_stock.ledger_document_price(p_movement uuid, p_product uuid) → numeric */
export const ledgerDocumentPrice = (..._args: unknown[]): never => notPorted("erp_stock.ledger_document_price");
/** erp_stock.ledger_origin(p_movement_id uuid) → jsonb */
export const ledgerOrigin = (..._args: unknown[]): never => notPorted("erp_stock.ledger_origin");
/** erp_stock.lot_apply(p_movement uuid, p_product uuid, p_warehouse uuid, p_lot uuid, p_quantity numeric) → jsonb */
export const lotApply = (..._args: unknown[]): never => notPorted("erp_stock.lot_apply");
/** erp_stock.lot_check(p_code text, p_manufactured date, p_expires date, p_note text) → void */
export const lotCheck = (..._args: unknown[]): never => notPorted("erp_stock.lot_check");
/** erp_stock.lot_dto(p_lot uuid, p_warehouse uuid) → jsonb */
export const lotDto = (..._args: unknown[]): never => notPorted("erp_stock.lot_dto");
/** erp_stock.lot_expiry_state(p_active boolean, p_expires date, p_quantity numeric, p_today date, p_days integer) → text */
export const lotExpiryState = (..._args: unknown[]): never => notPorted("erp_stock.lot_expiry_state");
/** erp_stock.lot_product_problem(p_product uuid) → text */
export const lotProductProblem = (..._args: unknown[]): never => notPorted("erp_stock.lot_product_problem");
/** erp_stock.lot_quantity(p_lot uuid, p_warehouse uuid) → numeric */
export const lotQuantity = (..._args: unknown[]): never => notPorted("erp_stock.lot_quantity");
/** erp_stock.lot_settings() → jsonb */
export const lotSettings = (..._args: unknown[]): never => notPorted("erp_stock.lot_settings");
/** erp_stock.lots_expiring(p_from date, p_until date) → TABLE(product_id uuid, lot_id uuid, code text, expires_on date, quantity numeric) */
export const lotsExpiring = (..._args: unknown[]): never => notPorted("erp_stock.lots_expiring");
/** erp_stock.negative_allowed() → boolean */
export const negativeAllowed = (..._args: unknown[]): never => notPorted("erp_stock.negative_allowed");
/** erp_stock.post(p_user_id uuid, p_command_id uuid, p_kind text, p_occurred_on date, p_reason text, p_reference text, p_items jsonb, p_reverses_id uuid) → jsonb */
export const post = (..._args: unknown[]): never => notPorted("erp_stock.post");
/** erp_stock.post_document_lots() → trigger */
export const postDocumentLots = (..._args: unknown[]): never => notPorted("erp_stock.post_document_lots");
/** erp_stock.post_physical_025(p_user_id uuid, p_command_id uuid, p_kind text, p_occurred_on date, p_reason text, p_reference text, p_items jsonb, p_reverses_id uuid) → jsonb */
export const postPhysical025 = (..._args: unknown[]): never => notPorted("erp_stock.post_physical_025");
/** erp_stock.reservation_write_access(p_actor uuid) → void */
export const reservationWriteAccess = (..._args: unknown[]): never => notPorted("erp_stock.reservation_write_access");
/** erp_stock.reserve_statuses() → text[] */
export const reserveStatuses = (..._args: unknown[]): never => notPorted("erp_stock.reserve_statuses");
/** erp_stock.reverse_lot_entries() → trigger */
export const reverseLotEntries = (..._args: unknown[]): never => notPorted("erp_stock.reverse_lot_entries");
/** erp_stock.sales_negative_allowed() → boolean */
export const salesNegativeAllowed = (..._args: unknown[]): never => notPorted("erp_stock.sales_negative_allowed");
/** erp_stock.settings_dto() → jsonb */
export const settingsDto = (..._args: unknown[]): never => notPorted("erp_stock.settings_dto");
/** erp_stock.supply_part(p_command uuid, p_part text) → uuid */
export const supplyPart = (..._args: unknown[]): never => notPorted("erp_stock.supply_part");
/** erp_stock.virtual_positions(p_product uuid) → TABLE(warehouse_id uuid, quantity numeric) */
export const virtualPositions = (..._args: unknown[]): never => notPorted("erp_stock.virtual_positions");
/** erp_stock.virtual_quantity(p_product uuid, p_warehouse uuid) → numeric */
export const virtualQuantity = (..._args: unknown[]): never => notPorted("erp_stock.virtual_quantity");
/** public.erp_document_stock_post(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_command_id uuid, p_preview_hash text, p_occurred_on date, p_reason text, p_ignored_item_ids jsonb) → jsonb */
export const erpDocumentStockPost = (..._args: unknown[]): never => notPorted("public.erp_document_stock_post");
/** public.erp_document_stock_preview(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_occurred_on date, p_reason text) → jsonb */
export const erpDocumentStockPreview = (..._args: unknown[]): never => notPorted("public.erp_document_stock_preview");
/** public.erp_document_stock_reverse(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_posting_id uuid, p_posting_version integer, p_command_id uuid, p_preview_hash text, p_occurred_on date, p_reason text) → jsonb */
export const erpDocumentStockReverse = (..._args: unknown[]): never => notPorted("public.erp_document_stock_reverse");
/** public.erp_document_stock_reverse_preview(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_posting_id uuid, p_posting_version integer, p_occurred_on date, p_reason text) → jsonb */
export const erpDocumentStockReversePreview = (..._args: unknown[]): never => notPorted("public.erp_document_stock_reverse_preview");
/** public.erp_stock_product_compose(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid, p_data jsonb, p_acknowledged jsonb, p_composition jsonb) → jsonb */
export const erpStockProductCompose = (..._args: unknown[]): never => notPorted("public.erp_stock_product_compose");
