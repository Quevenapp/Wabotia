// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_documents.advance_received_number() → trigger */
export const advanceReceivedNumber = (..._args: unknown[]): never => notPorted("erp_documents.advance_received_number");
/** erp_documents.approval_situations() → uuid[] */
export const approvalSituations = (..._args: unknown[]): never => notPorted("erp_documents.approval_situations");
/** erp_documents.approval_target() → uuid */
export const approvalTarget = (..._args: unknown[]): never => notPorted("erp_documents.approval_target");
/** erp_documents.auto_finance(p_user_id uuid, p_id uuid, p_command uuid) → jsonb */
export const autoFinance = (..._args: unknown[]): never => notPorted("erp_documents.auto_finance");
/** erp_documents.auto_product_key(p_kind text) → text */
export const autoProductKey = (..._args: unknown[]): never => notPorted("erp_documents.auto_product_key");
/** erp_documents.carrier_usable(p_id text) → boolean */
export const carrierUsable = (..._args: unknown[]): never => notPorted("erp_documents.carrier_usable");
/** erp_documents.category_usable(p_kind text, p_id text) → boolean */
export const categoryUsable = (..._args: unknown[]): never => notPorted("erp_documents.category_usable");
/** erp_documents.check_credit_limit(p_user_id uuid, p_kind text, p_data jsonb, p_before jsonb) → void */
export const checkCreditLimit = (..._args: unknown[]): never => notPorted("erp_documents.check_credit_limit");
/** erp_documents.check_custom_fields(p_kind text, p_values jsonb, p_before jsonb) → void */
export const checkCustomFields = (..._args: unknown[]): never => notPorted("erp_documents.check_custom_fields");
/** erp_documents.check_links(p_kind text, p_data jsonb, p_before jsonb) → void */
export const checkLinks = (..._args: unknown[]): never => notPorted("erp_documents.check_links");
/** erp_documents.check_payment_links(p_kind text, p_data jsonb, p_before jsonb) → void */
export const checkPaymentLinks = (..._args: unknown[]): never => notPorted("erp_documents.check_payment_links");
/** erp_documents.check_preference_rules(p_kind text, p_data jsonb) → void */
export const checkPreferenceRules = (..._args: unknown[]): never => notPorted("erp_documents.check_preference_rules");
/** erp_documents.check_situation_change(p_user_id uuid, p_kind text, p_from_key text, p_to_key text) → void */
export const checkSituationChange = (..._args: unknown[]): never => notPorted("erp_documents.check_situation_change");
/** erp_documents.check_tax_preference(p_data jsonb, p_before jsonb) → void */
export const checkTaxPreference = (..._args: unknown[]): never => notPorted("erp_documents.check_tax_preference");
/** erp_documents.command_replay(p_actor uuid, p_command uuid, p_hash text) → jsonb */
export const commandReplay = (..._args: unknown[]): never => notPorted("erp_documents.command_replay");
/** erp_documents.commercial_data(v jsonb) → jsonb */
export const commercialData = (..._args: unknown[]): never => notPorted("erp_documents.commercial_data");
/** erp_documents.commercial_reference(v jsonb) → jsonb */
export const commercialReference = (..._args: unknown[]): never => notPorted("erp_documents.commercial_reference");
/** erp_documents.contact_usable(p_user_id uuid, p_contact uuid) → boolean */
export const contactUsable = (..._args: unknown[]): never => notPorted("erp_documents.contact_usable");
/** erp_documents.cost_apply(p_document uuid) → integer */
export const costApply = (..._args: unknown[]): never => notPorted("erp_documents.cost_apply");
/** erp_documents.cost_apply_capture() → trigger */
export const costApplyCapture = (..._args: unknown[]): never => notPorted("erp_documents.cost_apply_capture");
/** erp_documents.current_version(p_id uuid) → integer */
export const currentVersion = (..._args: unknown[]): never => notPorted("erp_documents.current_version");
/** erp_documents.custom_field_value(f erp_documents.custom_field, p_value text) → text */
export const customFieldValue = (..._args: unknown[]): never => notPorted("erp_documents.custom_field_value");
/** erp_documents.date_value(p_value jsonb, p_required boolean) → date */
export const dateValue = (..._args: unknown[]): never => notPorted("erp_documents.date_value");
/** erp_documents.decimal_value(p_value jsonb, p_precision integer, p_digits integer) → numeric */
export const decimalValue = (..._args: unknown[]): never => notPorted("erp_documents.decimal_value");
/** erp_documents.delivery_address(v jsonb) → jsonb */
export const deliveryAddress = (..._args: unknown[]): never => notPorted("erp_documents.delivery_address");
/** erp_documents.discount_approver(p_user_id uuid, p_kind text) → boolean */
export const discountApprover = (..._args: unknown[]): never => notPorted("erp_documents.discount_approver");
/** erp_documents.document_finance_category(d erp_documents.document, p_category uuid) → uuid */
export const documentFinanceCategory = (..._args: unknown[]): never => notPorted("erp_documents.document_finance_category");
/** erp_documents.document_situation_json(p_id uuid) → jsonb */
export const documentSituationJson = (..._args: unknown[]): never => notPorted("erp_documents.document_situation_json");
/** erp_documents.document_view(p_id uuid) → jsonb */
export const documentView = (..._args: unknown[]): never => notPorted("erp_documents.document_view");
/** erp_documents.dto(p_id uuid) → jsonb */
export const dto = (..._args: unknown[]): never => notPorted("erp_documents.dto");
/** erp_documents.editable(p_status text) → boolean */
export const editable = (..._args: unknown[]): never => notPorted("erp_documents.editable");
/** erp_documents.effect_flags(p_id uuid) → jsonb */
export const effectFlags = (..._args: unknown[]): never => notPorted("erp_documents.effect_flags");
/** erp_documents.effects_transition_allowed(p_kind text, p_from text, p_to text) → boolean */
export const effectsTransitionAllowed = (..._args: unknown[]): never => notPorted("erp_documents.effects_transition_allowed");
/** erp_documents.extension_data(p_body jsonb) → jsonb */
export const extensionData = (..._args: unknown[]): never => notPorted("erp_documents.extension_data");
/** erp_documents.extension_keys() → text[] */
export const extensionKeys = (..._args: unknown[]): never => notPorted("erp_documents.extension_keys");
/** erp_documents.finance_category(p_kind text, p_category uuid) → uuid */
export const financeCategory = (..._args: unknown[]): never => notPorted("erp_documents.finance_category");
/** erp_documents.finance_payment_preview(d erp_documents.document, p_preview jsonb) → jsonb */
export const financePaymentPreview = (..._args: unknown[]): never => notPorted("erp_documents.finance_payment_preview");
/** erp_documents.guard_trash() → trigger */
export const guardTrash = (..._args: unknown[]): never => notPorted("erp_documents.guard_trash");
/** erp_documents.guard_trash_child() → trigger */
export const guardTrashChild = (..._args: unknown[]): never => notPorted("erp_documents.guard_trash_child");
/** erp_documents.guard_variation_item() → trigger */
export const guardVariationItem = (..._args: unknown[]): never => notPorted("erp_documents.guard_variation_item");
/** erp_documents.has_commercial_data(v jsonb) → boolean */
export const hasCommercialData = (..._args: unknown[]): never => notPorted("erp_documents.has_commercial_data");
/** erp_documents.initial_status(p_kind text) → text */
export const initialStatus = (..._args: unknown[]): never => notPorted("erp_documents.initial_status");
/** erp_documents.installment_details(p_kind text, p_value jsonb, p_amount numeric) → jsonb */
export const installmentDetails = (..._args: unknown[]): never => notPorted("erp_documents.installment_details");
/** erp_documents.legacy_transitions() → jsonb */
export const legacyTransitions = (..._args: unknown[]): never => notPorted("erp_documents.legacy_transitions");
/** erp_documents.next_number(p_kind text) → bigint */
export const nextNumber = (..._args: unknown[]): never => notPorted("erp_documents.next_number");
/** erp_documents.normalize(p_kind text, p_body jsonb) → jsonb */
export const normalize = (..._args: unknown[]): never => notPorted("erp_documents.normalize");
/** erp_documents.normalize_core(p_kind text, p_body jsonb) → jsonb */
export const normalizeCore = (..._args: unknown[]): never => notPorted("erp_documents.normalize_core");
/** erp_documents.number_editable(p_kind text) → boolean */
export const numberEditable = (..._args: unknown[]): never => notPorted("erp_documents.number_editable");
/** erp_documents.optional_amount(p_value jsonb) → text */
export const optionalAmount = (..._args: unknown[]): never => notPorted("erp_documents.optional_amount");
/** erp_documents.os_permitted(p_user_id uuid, p_key text) → boolean */
export const osPermitted = (..._args: unknown[]): never => notPorted("erp_documents.os_permitted");
/** erp_documents.payment_types() → text[] */
export const paymentTypes = (..._args: unknown[]): never => notPorted("erp_documents.payment_types");
/** erp_documents.preference(p_key text) → jsonb */
export const preference = (..._args: unknown[]): never => notPorted("erp_documents.preference");
/** erp_documents.price_decimals(p_price text) → integer */
export const priceDecimals = (..._args: unknown[]): never => notPorted("erp_documents.price_decimals");
/** erp_documents.project_result_flags(p_result jsonb) → jsonb */
export const projectResultFlags = (..._args: unknown[]): never => notPorted("erp_documents.project_result_flags");
/** erp_documents.proposal_superseded(p_id uuid) → boolean */
export const proposalSuperseded = (..._args: unknown[]): never => notPorted("erp_documents.proposal_superseded");
/** erp_documents.proposal_version_json(p_id uuid) → jsonb */
export const proposalVersionJson = (..._args: unknown[]): never => notPorted("erp_documents.proposal_version_json");
/** erp_documents.quantity_decimals() → integer */
export const quantityDecimals = (..._args: unknown[]): never => notPorted("erp_documents.quantity_decimals");
/** erp_documents.record_occurrence(p_document uuid, p_actor uuid, p_command uuid, p_version integer, p_before text, p_after text, p_text text) → erp_documents.occurrence */
export const recordOccurrence = (..._args: unknown[]): never => notPorted("erp_documents.record_occurrence");
/** erp_documents.record_situation_occurrence(p_document uuid, p_actor uuid, p_command uuid, p_version integer, p_before text, p_after text, p_text text, p_situation_before jsonb, p_situation_after jsonb) → erp_documents.occurrence */
export const recordSituationOccurrence = (..._args: unknown[]): never => notPorted("erp_documents.record_situation_occurrence");
/** erp_documents.replace_items(p_document uuid, p_items jsonb) → void */
export const replaceItems = (..._args: unknown[]): never => notPorted("erp_documents.replace_items");
/** erp_documents.report_last_purchase_until(p_product uuid, p_until date, p_balances boolean) → numeric */
export const reportLastPurchaseUntil = (..._args: unknown[]): never => notPorted("erp_documents.report_last_purchase_until");
/** erp_documents.require_access(p_user_id uuid, p_kind text, p_write boolean) → void */
export const requireAccess = (..._args: unknown[]): never => notPorted("erp_documents.require_access");
/** erp_documents.require_commercial_input(p_current jsonb, p_input jsonb) → void */
export const requireCommercialInput = (..._args: unknown[]): never => notPorted("erp_documents.require_commercial_input");
/** erp_documents.require_os_permission(p_user_id uuid, p_kind text, p_key text) → void */
export const requireOsPermission = (..._args: unknown[]): never => notPorted("erp_documents.require_os_permission");
/** erp_documents.require_role(p_user_id uuid, p_kind text, p_write boolean) → void */
export const requireRole = (..._args: unknown[]): never => notPorted("erp_documents.require_role");
/** erp_documents.require_seller(p_seller uuid) → void */
export const requireSeller = (..._args: unknown[]): never => notPorted("erp_documents.require_seller");
/** erp_documents.rich_text(p_value jsonb) → jsonb */
export const richText = (..._args: unknown[]): never => notPorted("erp_documents.rich_text");
/** erp_documents.seller_rules(p_user_id uuid, p_kind text, p_data jsonb) → uuid */
export const sellerRules = (..._args: unknown[]): never => notPorted("erp_documents.seller_rules");
/** erp_documents.situation_adopted(p_kind text) → boolean */
export const situationAdopted = (..._args: unknown[]): never => notPorted("erp_documents.situation_adopted");
/** erp_documents.situation_follow_status() → trigger */
export const situationFollowStatus = (..._args: unknown[]): never => notPorted("erp_documents.situation_follow_status");
/** erp_documents.situation_json(p_kind text, p_status text, p_situation uuid) → jsonb */
export const situationJson = (..._args: unknown[]): never => notPorted("erp_documents.situation_json");
/** erp_documents.situation_key_valid(p_kind text, p_key text) → boolean */
export const situationKeyValid = (..._args: unknown[]): never => notPorted("erp_documents.situation_key_valid");
/** erp_documents.situation_snapshot(p jsonb) → jsonb */
export const situationSnapshot = (..._args: unknown[]): never => notPorted("erp_documents.situation_snapshot");
/** erp_documents.stock_launch_date(p_id uuid) → date */
export const stockLaunchDate = (..._args: unknown[]): never => notPorted("erp_documents.stock_launch_date");
/** erp_documents.text_value(p_value jsonb, p_max integer, p_required boolean, p_multiline boolean) → text */
export const textValue = (..._args: unknown[]): never => notPorted("erp_documents.text_value");
/** erp_documents.transition_action(p_user_id uuid, p_kind text, p_id uuid, p_command uuid, p_action text, p_label text) → jsonb */
export const transitionAction = (..._args: unknown[]): never => notPorted("erp_documents.transition_action");
/** erp_documents.transition_command(p_command uuid, p_action text) → uuid */
export const transitionCommand = (..._args: unknown[]): never => notPorted("erp_documents.transition_command");
/** erp_documents.transition_reason_required(p_kind text, p_from text, p_to text) → boolean */
export const transitionReasonRequired = (..._args: unknown[]): never => notPorted("erp_documents.transition_reason_required");
/** erp_documents.uuid_value(p_value jsonb, p_required boolean) → uuid */
export const uuidValue = (..._args: unknown[]): never => notPorted("erp_documents.uuid_value");
/** public.erp_document_save(p_user_id uuid, p_kind text, p_id uuid, p_expected_version integer, p_command_id uuid, p_body jsonb) → jsonb */
export const erpDocumentSave = (..._args: unknown[]): never => notPorted("public.erp_document_save");
/** public.erp_document_transition(p_user_id uuid, p_kind text, p_id uuid, p_expected_version integer, p_command_id uuid, p_status text, p_reason text) → jsonb */
export const erpDocumentTransition = (..._args: unknown[]): never => notPorted("public.erp_document_transition");
