// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_purchase_receipts.guard_legacy() → trigger */
export const guardLegacy = (..._args: unknown[]): never => notPorted("erp_purchase_receipts.guard_legacy");
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
/** erp_stock.lot_check(p_code text, p_manufactured date, p_expires date, p_note text) → void */
export const lotCheck = (..._args: unknown[]): never => notPorted("erp_stock.lot_check");
/** erp_stock.lot_dto(p_lot uuid, p_warehouse uuid) → jsonb */
export const lotDto = (..._args: unknown[]): never => notPorted("erp_stock.lot_dto");
/** erp_stock.lot_expiry_state(p_active boolean, p_expires date, p_quantity numeric, p_today date, p_days integer) → text */
export const lotExpiryState = (..._args: unknown[]): never => notPorted("erp_stock.lot_expiry_state");
/** erp_stock.lot_settings() → jsonb */
export const lotSettings = (..._args: unknown[]): never => notPorted("erp_stock.lot_settings");
/** erp_stock.post_document_lots() → trigger */
export const postDocumentLots = (..._args: unknown[]): never => notPorted("erp_stock.post_document_lots");
/** erp_stock.reverse_lot_entries() → trigger */
export const reverseLotEntries = (..._args: unknown[]): never => notPorted("erp_stock.reverse_lot_entries");
/** erp_stock.sales_negative_allowed() → boolean */
export const salesNegativeAllowed = (..._args: unknown[]): never => notPorted("erp_stock.sales_negative_allowed");
