// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_finance.account_defaults() → trigger */
export const accountDefaults = (..._args: unknown[]): never => notPorted("erp_finance.account_defaults");
/** erp_finance.active_account(p_id uuid) → uuid */
export const activeAccount = (..._args: unknown[]): never => notPorted("erp_finance.active_account");
/** erp_finance.active_category(p_id uuid, p_kind text) → uuid */
export const activeCategory = (..._args: unknown[]): never => notPorted("erp_finance.active_category");
/** erp_finance.audit_permission() → trigger */
export const auditPermission = (..._args: unknown[]): never => notPorted("erp_finance.audit_permission");
/** erp_finance.bank_number(p_data jsonb) → text */
export const bankNumber = (..._args: unknown[]): never => notPorted("erp_finance.bank_number");
/** erp_finance.bordero_immutable() → trigger */
export const borderoImmutable = (..._args: unknown[]): never => notPorted("erp_finance.bordero_immutable");
/** erp_finance.bp(p_data jsonb, p_key text) → integer */
export const bp = (..._args: unknown[]): never => notPorted("erp_finance.bp");
/** erp_finance.cash_account(p_id uuid) → erp_finance.account */
export const cashAccount = (..._args: unknown[]): never => notPorted("erp_finance.cash_account");
/** erp_finance.cash_category(p_value jsonb, p_kind text) → uuid */
export const cashCategory = (..._args: unknown[]): never => notPorted("erp_finance.cash_category");
/** erp_finance.cash_compensate(p_entry uuid, p_user uuid, p_command uuid) → uuid */
export const cashCompensate = (..._args: unknown[]): never => notPorted("erp_finance.cash_compensate");
/** erp_finance.cash_contact(p_value jsonb) → uuid */
export const cashContact = (..._args: unknown[]): never => notPorted("erp_finance.cash_contact");
/** erp_finance.cash_entry_view(p_id uuid) → jsonb */
export const cashEntryView = (..._args: unknown[]): never => notPorted("erp_finance.cash_entry_view");
/** erp_finance.cash_post(p_entry erp_finance.cash_entry, p_category uuid, p_user uuid, p_command uuid) → void */
export const cashPost = (..._args: unknown[]): never => notPorted("erp_finance.cash_post");
/** erp_finance.cash_text(p_data jsonb, p_key text, p_limit integer, p_required boolean) → text */
export const cashText = (..._args: unknown[]): never => notPorted("erp_finance.cash_text");
/** erp_finance.category_tree_guard() → trigger */
export const categoryTreeGuard = (..._args: unknown[]): never => notPorted("erp_finance.category_tree_guard");
/** erp_finance.cents_of(p_value text) → bigint */
export const centsOf = (..._args: unknown[]): never => notPorted("erp_finance.cents_of");
/** erp_finance.cnab_cash_immutable() → trigger */
export const cnabCashImmutable = (..._args: unknown[]): never => notPorted("erp_finance.cnab_cash_immutable");
/** erp_finance.cnab_cash_plan_check() → trigger */
export const cnabCashPlanCheck = (..._args: unknown[]): never => notPorted("erp_finance.cnab_cash_plan_check");
/** erp_finance.commission_amounts(p_document uuid, p_policy jsonb, OUT items_cents bigint, OUT discount_cents bigint, OUT freight_cents bigint, OUT ipi_cents bigint, OUT icms_st_cents bigint, OUT fee_cents bigint, OUT base_cents bigint) → record */
export const commissionAmounts = (..._args: unknown[]): never => notPorted("erp_finance.commission_amounts");
/** erp_finance.commission_capture() → trigger */
export const commissionCapture = (..._args: unknown[]): never => notPorted("erp_finance.commission_capture");
/** erp_finance.commission_capture_invoice() → trigger */
export const commissionCaptureInvoice = (..._args: unknown[]): never => notPorted("erp_finance.commission_capture_invoice");
/** erp_finance.commission_capture_invoice_title(p_title uuid) → uuid */
export const commissionCaptureInvoiceTitle = (..._args: unknown[]): never => notPorted("erp_finance.commission_capture_invoice_title");
/** erp_finance.commission_capture_title(p_title uuid) → uuid */
export const commissionCaptureTitle = (..._args: unknown[]): never => notPorted("erp_finance.commission_capture_title");
/** erp_finance.commission_confirmed(p_kind text, p_status text) → boolean */
export const commissionConfirmed = (..._args: unknown[]): never => notPorted("erp_finance.commission_confirmed");
/** erp_finance.commission_document(p_document uuid, p_seller uuid, OUT base_cents bigint, OUT weighted numeric, OUT items_cents bigint, OUT rule text) → record */
export const commissionDocument = (..._args: unknown[]): never => notPorted("erp_finance.commission_document");
/** erp_finance.commission_invoice(p_invoice uuid, p_seller uuid, OUT base_cents bigint, OUT weighted numeric, OUT items_cents bigint, OUT rule text) → record */
export const commissionInvoice = (..._args: unknown[]): never => notPorted("erp_finance.commission_invoice");
/** erp_finance.commission_operation_capture() → trigger */
export const commissionOperationCapture = (..._args: unknown[]): never => notPorted("erp_finance.commission_operation_capture");
/** erp_finance.commission_operation_frozen() → trigger */
export const commissionOperationFrozen = (..._args: unknown[]): never => notPorted("erp_finance.commission_operation_frozen");
/** erp_finance.commission_operation_sync(p_document uuid) → uuid */
export const commissionOperationSync = (..._args: unknown[]): never => notPorted("erp_finance.commission_operation_sync");
/** erp_finance.commission_return_capture() → trigger */
export const commissionReturnCapture = (..._args: unknown[]): never => notPorted("erp_finance.commission_return_capture");
/** erp_finance.commission_seller(p_reference jsonb) → uuid */
export const commissionSeller = (..._args: unknown[]): never => notPorted("erp_finance.commission_seller");
/** erp_finance.commission_weighted(p_document uuid, p_seller uuid, OUT items_cents bigint, OUT weighted numeric) → record */
export const commissionWeighted = (..._args: unknown[]): never => notPorted("erp_finance.commission_weighted");
/** erp_finance.document_command_finish(p_actor uuid, p_id uuid, p_action text, p_data jsonb, p_result jsonb) → jsonb */
export const documentCommandFinish = (..._args: unknown[]): never => notPorted("erp_finance.document_command_finish");
/** erp_finance.document_command_start(p_actor uuid, p_id uuid, p_action text, p_data jsonb) → jsonb */
export const documentCommandStart = (..._args: unknown[]): never => notPorted("erp_finance.document_command_start");
/** erp_finance.document_lock(p_actor uuid, p_kind text, p_document uuid, p_version integer) → erp_documents.document */
export const documentLock = (..._args: unknown[]): never => notPorted("erp_finance.document_lock");
/** erp_finance.document_posting_summary(p_id uuid) → jsonb */
export const documentPostingSummary = (..._args: unknown[]): never => notPorted("erp_finance.document_posting_summary");
/** erp_finance.document_preview_data(d erp_documents.document, p_category uuid, p_plan jsonb) → jsonb */
export const documentPreviewData = (..._args: unknown[]): never => notPorted("erp_finance.document_preview_data");
/** erp_finance.document_reverse_preview_data(d erp_documents.document, p_posting uuid, p_version integer) → jsonb */
export const documentReversePreviewData = (..._args: unknown[]): never => notPorted("erp_finance.document_reverse_preview_data");
/** erp_finance.document_seller(p_document erp_documents.document) → uuid */
export const documentSeller = (..._args: unknown[]): never => notPorted("erp_finance.document_seller");
/** erp_finance.document_title_number() → trigger */
export const documentTitleNumber = (..._args: unknown[]): never => notPorted("erp_finance.document_title_number");
/** erp_finance.document_title_rows(p_posting uuid) → jsonb */
export const documentTitleRows = (..._args: unknown[]): never => notPorted("erp_finance.document_title_rows");
/** erp_finance.entry_movement_immutable() → trigger */
export const entryMovementImmutable = (..._args: unknown[]): never => notPorted("erp_finance.entry_movement_immutable");
/** erp_finance.find_or_create_category(p_name text, p_kind text) → uuid */
export const findOrCreateCategory = (..._args: unknown[]): never => notPorted("erp_finance.find_or_create_category");
/** erp_finance.guard_document_title() → trigger */
export const guardDocumentTitle = (..._args: unknown[]): never => notPorted("erp_finance.guard_document_title");
/** erp_finance.guard_finance_invoice() → trigger */
export const guardFinanceInvoice = (..._args: unknown[]): never => notPorted("erp_finance.guard_finance_invoice");
/** erp_finance.guard_grouped_title() → trigger */
export const guardGroupedTitle = (..._args: unknown[]): never => notPorted("erp_finance.guard_grouped_title");
/** erp_finance.guard_invoice_order_effect() → trigger */
export const guardInvoiceOrderEffect = (..._args: unknown[]): never => notPorted("erp_finance.guard_invoice_order_effect");
/** erp_finance.guard_invoice_title() → trigger */
export const guardInvoiceTitle = (..._args: unknown[]): never => notPorted("erp_finance.guard_invoice_title");
/** erp_finance.guard_origin_import_billing() → trigger */
export const guardOriginImportBilling = (..._args: unknown[]): never => notPorted("erp_finance.guard_origin_import_billing");
/** erp_finance.guard_origin_import_title() → trigger */
export const guardOriginImportTitle = (..._args: unknown[]): never => notPorted("erp_finance.guard_origin_import_title");
/** erp_finance.guard_posted_document() → trigger */
export const guardPostedDocument = (..._args: unknown[]): never => notPorted("erp_finance.guard_posted_document");
/** erp_finance.guard_posted_item() → trigger */
export const guardPostedItem = (..._args: unknown[]): never => notPorted("erp_finance.guard_posted_item");
/** erp_finance.invoice_auto_finance() → trigger */
export const invoiceAutoFinance = (..._args: unknown[]): never => notPorted("erp_finance.invoice_auto_finance");
/** erp_finance.invoice_blocked_reason(v erp_fiscal_invoices.invoice) → text */
export const invoiceBlockedReason = (..._args: unknown[]): never => notPorted("erp_finance.invoice_blocked_reason");
/** erp_finance.invoice_contact(p_recipient jsonb) → uuid */
export const invoiceContact = (..._args: unknown[]): never => notPorted("erp_finance.invoice_contact");
/** erp_finance.invoice_effect_active(p_invoice uuid) → boolean */
export const invoiceEffectActive = (..._args: unknown[]): never => notPorted("erp_finance.invoice_effect_active");
/** erp_finance.invoice_kind(p_direction text) → text */
export const invoiceKind = (..._args: unknown[]): never => notPorted("erp_finance.invoice_kind");
/** erp_finance.invoice_label(p_model text, p_number integer) → text */
export const invoiceLabel = (..._args: unknown[]): never => notPorted("erp_finance.invoice_label");
/** erp_finance.invoice_lock(p_invoice uuid) → erp_fiscal_invoices.invoice */
export const invoiceLock = (..._args: unknown[]): never => notPorted("erp_finance.invoice_lock");
/** erp_finance.invoice_orders_posted(p_invoice uuid) → jsonb */
export const invoiceOrdersPosted = (..._args: unknown[]): never => notPorted("erp_finance.invoice_orders_posted");
/** erp_finance.invoice_post(p_user_id uuid, p_command_id uuid, p_data jsonb, p_origin text) → jsonb */
export const invoicePost = (..._args: unknown[]): never => notPorted("erp_finance.invoice_post");
/** erp_finance.invoice_posting_summary(p_id uuid) → jsonb */
export const invoicePostingSummary = (..._args: unknown[]): never => notPorted("erp_finance.invoice_posting_summary");
/** erp_finance.invoice_preview_data(v erp_fiscal_invoices.invoice, p_category uuid, p_account uuid) → jsonb */
export const invoicePreviewData = (..._args: unknown[]): never => notPorted("erp_finance.invoice_preview_data");
/** erp_finance.invoice_title_rows(p_posting uuid) → jsonb */
export const invoiceTitleRows = (..._args: unknown[]): never => notPorted("erp_finance.invoice_title_rows");
/** erp_finance.invoice_total_cents(p_totals jsonb) → bigint */
export const invoiceTotalCents = (..._args: unknown[]): never => notPorted("erp_finance.invoice_total_cents");
/** erp_finance.movement_account_start() → trigger */
export const movementAccountStart = (..._args: unknown[]): never => notPorted("erp_finance.movement_account_start");
/** erp_finance.notes_edit_allowed(o erp_documents.document, n erp_documents.document) → boolean */
export const notesEditAllowed = (..._args: unknown[]): never => notPorted("erp_finance.notes_edit_allowed");
/** erp_finance.notes_item_allowed(p_op text, o erp_documents.item, n erp_documents.item) → boolean */
export const notesItemAllowed = (..._args: unknown[]): never => notPorted("erp_finance.notes_item_allowed");
/** erp_finance.owned_entry_guard() → trigger */
export const ownedEntryGuard = (..._args: unknown[]): never => notPorted("erp_finance.owned_entry_guard");
/** erp_finance.payment_method_fee(p_method uuid, p_amount bigint) → bigint */
export const paymentMethodFee = (..._args: unknown[]): never => notPorted("erp_finance.payment_method_fee");
/** erp_finance.payment_method_for(p_method uuid, p_kind text, p_current uuid) → uuid */
export const paymentMethodFor = (..._args: unknown[]): never => notPorted("erp_finance.payment_method_for");
/** erp_finance.post_settlement_movements(p_settlement uuid, p_delta bigint) → void */
export const postSettlementMovements = (..._args: unknown[]): never => notPorted("erp_finance.post_settlement_movements");
/** erp_finance.project_result_link(p_result jsonb) → jsonb */
export const projectResultLink = (..._args: unknown[]): never => notPorted("erp_finance.project_result_link");
/** erp_finance.reconciled_entry_guard() → trigger */
export const reconciledEntryGuard = (..._args: unknown[]): never => notPorted("erp_finance.reconciled_entry_guard");
/** erp_finance.reconciled_movement_guard() → trigger */
export const reconciledMovementGuard = (..._args: unknown[]): never => notPorted("erp_finance.reconciled_movement_guard");
/** erp_finance.seller_for(p_seller uuid, p_kind text, p_current uuid) → uuid */
export const sellerFor = (..._args: unknown[]): never => notPorted("erp_finance.seller_for");
/** erp_finance.settlement_bordero() → trigger */
export const settlementBordero = (..._args: unknown[]): never => notPorted("erp_finance.settlement_bordero");
/** erp_finance.settlement_capture_categories() → trigger */
export const settlementCaptureCategories = (..._args: unknown[]): never => notPorted("erp_finance.settlement_capture_categories");
/** erp_finance.settlement_posting_check() → trigger */
export const settlementPostingCheck = (..._args: unknown[]): never => notPorted("erp_finance.settlement_posting_check");
/** erp_finance.title_defaults() → trigger */
export const titleDefaults = (..._args: unknown[]): never => notPorted("erp_finance.title_defaults");
/** erp_finance.title_history_guard() → trigger */
export const titleHistoryGuard = (..._args: unknown[]): never => notPorted("erp_finance.title_history_guard");
/** erp_finance.title_inherited_seller(p_title uuid) → uuid */
export const titleInheritedSeller = (..._args: unknown[]): never => notPorted("erp_finance.title_inherited_seller");
/** erp_finance.title_long_history() → trigger */
export const titleLongHistory = (..._args: unknown[]): never => notPorted("erp_finance.title_long_history");
/** erp_finance.title_seller(p_title uuid) → uuid */
export const titleSeller = (..._args: unknown[]): never => notPorted("erp_finance.title_seller");
/** erp_finance.title_text(p_data jsonb, OUT description text, OUT history text) → record */
export const titleText = (..._args: unknown[]): never => notPorted("erp_finance.title_text");
/** erp_finance.titles_mark_returned(p_actor uuid, p_command_id uuid, p_titles uuid[], p_source jsonb) → jsonb */
export const titlesMarkReturned = (..._args: unknown[]): never => notPorted("erp_finance.titles_mark_returned");
/** erp_finance.transfer_account(p_id uuid) → jsonb */
export const transferAccount = (..._args: unknown[]): never => notPorted("erp_finance.transfer_account");
/** erp_finance.transfer_immutable() → trigger */
export const transferImmutable = (..._args: unknown[]): never => notPorted("erp_finance.transfer_immutable");
/** erp_finance.transfer_leg_check() → trigger */
export const transferLegCheck = (..._args: unknown[]): never => notPorted("erp_finance.transfer_leg_check");
/** erp_finance.transfer_pair_check() → trigger */
export const transferPairCheck = (..._args: unknown[]): never => notPorted("erp_finance.transfer_pair_check");
/** erp_finance.utf16_length(p_text text) → integer */
export const utf16Length = (..._args: unknown[]): never => notPorted("erp_finance.utf16_length");
/** public.erp_document_finance_post(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_command_id uuid, p_preview_hash text, p_category_id uuid, p_plan jsonb) → jsonb */
export const erpDocumentFinancePost = (..._args: unknown[]): never => notPorted("public.erp_document_finance_post");
/** public.erp_document_finance_preview(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_category_id uuid, p_plan jsonb) → jsonb */
export const erpDocumentFinancePreview = (..._args: unknown[]): never => notPorted("public.erp_document_finance_preview");
/** public.erp_document_finance_reverse(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_posting_id uuid, p_posting_version integer, p_command_id uuid, p_preview_hash text, p_title_versions jsonb, p_reason text) → jsonb */
export const erpDocumentFinanceReverse = (..._args: unknown[]): never => notPorted("public.erp_document_finance_reverse");
/** public.erp_document_finance_reverse_preview(p_user_id uuid, p_kind text, p_document_id uuid, p_expected_version integer, p_posting_id uuid, p_posting_version integer) → jsonb */
export const erpDocumentFinanceReversePreview = (..._args: unknown[]): never => notPorted("public.erp_document_finance_reverse_preview");
/** public.erp_finance_cash_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb) → jsonb */
export const erpFinanceCashExecute = (..._args: unknown[]): never => notPorted("public.erp_finance_cash_execute");
/** public.erp_finance_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb) → jsonb */
export const erpFinanceExecute = (..._args: unknown[]): never => notPorted("public.erp_finance_execute");
/** public.erp_finance_title_execute(p_user_id uuid, p_command_id uuid, p_action text, p_data jsonb) → jsonb */
export const erpFinanceTitleExecute = (..._args: unknown[]): never => notPorted("public.erp_finance_title_execute");
