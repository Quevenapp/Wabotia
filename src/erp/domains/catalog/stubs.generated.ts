// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_catalog.acknowledged_valid(p_acknowledged jsonb) → boolean */
export const acknowledgedValid = (..._args: unknown[]): never => notPorted("erp_catalog.acknowledged_valid");
/** erp_catalog.can_read_stock(p_user_id uuid) → boolean */
export const canReadStock = (..._args: unknown[]): never => notPorted("erp_catalog.can_read_stock");
/** erp_catalog.compact(p_value text) → text */
export const compact = (..._args: unknown[]): never => notPorted("erp_catalog.compact");
/** erp_catalog.composition_kits(p_products uuid[]) → uuid[] */
export const compositionKits = (..._args: unknown[]): never => notPorted("erp_catalog.composition_kits");
/** erp_catalog.composition_sync(p_user_id uuid, p_command_id uuid, p_kits uuid[]) → integer */
export const compositionSync = (..._args: unknown[]): never => notPorted("erp_catalog.composition_sync");
/** erp_catalog.composition_sync_on() → boolean */
export const compositionSyncOn = (..._args: unknown[]): never => notPorted("erp_catalog.composition_sync_on");
/** erp_catalog.contact_apply(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid, p_data jsonb, p_acknowledged jsonb, p_audit text, p_required text[]) → jsonb */
export const contactApply = (..._args: unknown[]): never => notPorted("erp_catalog.contact_apply");
/** erp_catalog.contact_check_full(p_id uuid, p jsonb, p_before jsonb, p_required text[]) → void */
export const contactCheckFull = (..._args: unknown[]): never => notPorted("erp_catalog.contact_check_full");
/** erp_catalog.contact_data(p_id uuid) → jsonb */
export const contactData = (..._args: unknown[]): never => notPorted("erp_catalog.contact_data");
/** erp_catalog.contact_dto(p_id uuid) → jsonb */
export const contactDto = (..._args: unknown[]): never => notPorted("erp_catalog.contact_dto");
/** erp_catalog.contact_field_person_type(p_field text) → text */
export const contactFieldPersonType = (..._args: unknown[]): never => notPorted("erp_catalog.contact_field_person_type");
/** erp_catalog.contact_input(p_data jsonb, p_before jsonb) → jsonb */
export const contactInput = (..._args: unknown[]): never => notPorted("erp_catalog.contact_input");
/** erp_catalog.contact_merge(p_user_id uuid, p_id uuid, p_data jsonb, p_before jsonb) → jsonb */
export const contactMerge = (..._args: unknown[]): never => notPorted("erp_catalog.contact_merge");
/** erp_catalog.contact_require_visible(p_user_id uuid, p_id uuid) → void */
export const contactRequireVisible = (..._args: unknown[]): never => notPorted("erp_catalog.contact_require_visible");
/** erp_catalog.contact_required_field(p_option text) → text */
export const contactRequiredField = (..._args: unknown[]): never => notPorted("erp_catalog.contact_required_field");
/** erp_catalog.contact_required_missing(p jsonb, p_fields text[]) → text */
export const contactRequiredMissing = (..._args: unknown[]): never => notPorted("erp_catalog.contact_required_missing");
/** erp_catalog.contact_take_code(p_user_id uuid) → text */
export const contactTakeCode = (..._args: unknown[]): never => notPorted("erp_catalog.contact_take_code");
/** erp_catalog.contact_type_slugs(p_id uuid) → text[] */
export const contactTypeSlugs = (..._args: unknown[]): never => notPorted("erp_catalog.contact_type_slugs");
/** erp_catalog.contact_visible_to(p_scope uuid, p_id uuid) → boolean */
export const contactVisibleTo = (..._args: unknown[]): never => notPorted("erp_catalog.contact_visible_to");
/** erp_catalog.contact_warnings(p_id uuid, p_full jsonb, p_before jsonb) → jsonb */
export const contactWarnings = (..._args: unknown[]): never => notPorted("erp_catalog.contact_warnings");
/** erp_catalog.contact_write(p_id uuid, p jsonb) → void */
export const contactWrite = (..._args: unknown[]): never => notPorted("erp_catalog.contact_write");
/** erp_catalog.document_issue(p_person_type text, p_document text) → text */
export const documentIssue = (..._args: unknown[]): never => notPorted("erp_catalog.document_issue");
/** erp_catalog.guard_deleted_product() → trigger */
export const guardDeletedProduct = (..._args: unknown[]): never => notPorted("erp_catalog.guard_deleted_product");
/** erp_catalog.guard_variation_parent() → trigger */
export const guardVariationParent = (..._args: unknown[]): never => notPorted("erp_catalog.guard_variation_parent");
/** erp_catalog.items_per_box_follow() → trigger */
export const itemsPerBoxFollow = (..._args: unknown[]): never => notPorted("erp_catalog.items_per_box_follow");
/** erp_catalog.mutate(p_user_id uuid, p_entity text, p_id uuid, p_expected_version integer, p_command_id uuid, p_data jsonb, p_set_active boolean, p_active boolean) → jsonb */
export const mutate = (..._args: unknown[]): never => notPorted("erp_catalog.mutate");
/** erp_catalog.origin_contact_roles(p_payload jsonb) → jsonb */
export const originContactRoles = (..._args: unknown[]): never => notPorted("erp_catalog.origin_contact_roles");
/** erp_catalog.origin_count(p_value jsonb) → text */
export const originCount = (..._args: unknown[]): never => notPorted("erp_catalog.origin_count");
/** erp_catalog.origin_decimal(p_value jsonb) → text */
export const originDecimal = (..._args: unknown[]): never => notPorted("erp_catalog.origin_decimal");
/** erp_catalog.origin_mirror_fields(p_entity text, p_payload jsonb) → jsonb */
export const originMirrorFields = (..._args: unknown[]): never => notPorted("erp_catalog.origin_mirror_fields");
/** erp_catalog.origin_mirror_refresh() → trigger */
export const originMirrorRefresh = (..._args: unknown[]): never => notPorted("erp_catalog.origin_mirror_refresh");
/** erp_catalog.origin_text(p_value jsonb, p_max integer) → text */
export const originText = (..._args: unknown[]): never => notPorted("erp_catalog.origin_text");
/** erp_catalog.product_cost_at(p_product uuid, p_day date) → numeric */
export const productCostAt = (..._args: unknown[]): never => notPorted("erp_catalog.product_cost_at");
/** erp_catalog.warnings(p_entity text, p_id uuid, p_data jsonb) → jsonb */
export const warnings = (..._args: unknown[]): never => notPorted("erp_catalog.warnings");
/** erp_catalog.write_fields(p_id uuid, p_entity text, p_data jsonb) → void */
export const writeFields = (..._args: unknown[]): never => notPorted("erp_catalog.write_fields");
/** public.erp_catalog_contact_save(p_user_id uuid, p_id uuid, p_expected_version integer, p_command_id uuid, p_data jsonb, p_acknowledged jsonb) → jsonb */
export const erpCatalogContactSave = (..._args: unknown[]): never => notPorted("public.erp_catalog_contact_save");
