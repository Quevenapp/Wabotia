import { ERP_MAINTENANCE_ACTIONS, maintenanceReadRpc, type ErpMaintenanceRequest } from "../parts-requirements.ts";
export { ERP_MAINTENANCE_HEADER, ERP_MAINTENANCE_ACTIONS, maintenanceReadRpc, readErpMaintenance, type ErpMaintenanceRequest, type ErpMaintenanceAction } from "../parts-requirements.ts";
import type { RpcArgs, RpcContext } from "./registry.ts";
import { one, type SqlDriver, type Row } from "./driver.ts";
import { ErpError } from "./errors.ts";
import { COM1_REVERSE_MESSAGES, com1DirectReverseBlocker } from "../domains/fiscal/comnfe/effect-policy.ts";
import { ERP_PART_KEYS, erpRequirement, erpRequirementMet, type ErpModuleId, type ErpRequirement } from "../parts.ts";
import { erpEntityRequirement, erpImportRequirement, erpPreferenceRequirement, erpReportRequirement, erpNotificationRequirement, erpFieldRequirement, erpListRequirement, erpTaskRequirement } from "../parts-requirements.ts";

export const ERP_PARTS_DENIED_HEADER = "x-erp-parts-denied";
/** Somente recebimento de evidência de uma operação externa já reivindicada. */
export const COM1_EVIDENCE_RPCS: ReadonlySet<string> = new Set([
  "erp_com1_record", "erp_com1_cancel_record", "erp_com1_cancel_xml_record",
]);
export class ErpPartDisabled extends ErpError {
  constructor() { super("module_disabled", "Esta rotina depende de uma parte desligada."); }
}
export const requireErpParts = (ctx: Pick<RpcContext, "parts">, requirement: ErpRequirement | null): void => {
  if (!requirement) throw new ErpError("22023", "erp_parts_unknown_type");
  if (!erpRequirementMet(ctx.parts, requirement)) throw new ErpPartDisabled();
};

/** Inventário explícito dos RPCs registrados. Novos nomes exigem classificação. */
const RPC_GROUPS = {
  com1_prepare: `erp_com1_prepare erp_com1_nfce_prepare`,
  com1_claim: `erp_com1_claim`,
  com1_read: `erp_com1_config_get erp_com1_config_save erp_com1_get erp_com1_list erp_com1_cancel_claim
    erp_com1_nfce_config_get erp_com1_nfce_config_save erp_com1_nfce_sales
    erp_com1_nfse_config_get erp_com1_nfse_config_save erp_com1_os_notes erp_com1_os_prepare
    erp_com1_events_get erp_com1_correction_claim erp_com1_correction_record erp_com1_correction_file
    erp_com1_void_list erp_com1_void_claim erp_com1_void_record
    erp_com1_return_prepare erp_com1_return_claim erp_com1_return_record erp_com1_return_get`,
  com1_effect: `erp_com1_effect_apply erp_com1_effect_reverse erp_com1_nfce_sale_cancel erp_com1_return_effects`,
  com1_evidence: `erp_com1_record erp_com1_cancel_record erp_com1_cancel_xml_record`,
  // Compra pela nota recebida: Compras; Estoque, Financeiro e Fiscal são conferidos por efeito dentro do RPC.
  inbound: `erp_inbound_list erp_inbound_get erp_inbound_register erp_inbound_fetch_claim erp_inbound_fetch_record erp_inbound_review
    erp_inbound_supplier_create erp_inbound_enter erp_inbound_reverse erp_inbound_settings_get erp_inbound_settings_save
    erp_inbound_manifest_claim erp_inbound_manifest_record`,
  base: `erp_access_storage erp_access_gate_v2 erp_access_me erp_access_permissions_me erp_access_profile_me erp_access_security_policy_get
    erp_access_security_policy_save erp_access_user_controls_get erp_access_user_controls_save erp_activity_detail erp_activity_list
    erp_attachment_contact_claim erp_attachment_contact_delete erp_attachment_contact_finish erp_attachment_contact_list erp_attachment_contact_object
    erp_attachment_contact_reserve erp_attachment_contact_stop erp_attachment_employee_claim erp_attachment_employee_delete erp_attachment_employee_finish
    erp_attachment_employee_list erp_attachment_employee_object erp_attachment_employee_reserve erp_attachment_employee_stop erp_catalog_access
    erp_catalog_contact_carrier_complement erp_catalog_contact_check erp_catalog_contact_code erp_catalog_contact_code_set erp_catalog_contact_comment_add
    erp_catalog_contact_comments erp_catalog_contact_export erp_catalog_contact_export_tagged erp_catalog_contact_get erp_catalog_contact_history
    erp_catalog_contact_import erp_catalog_contact_labels erp_catalog_contact_options erp_catalog_contact_page erp_catalog_contact_page_tagged
    erp_catalog_contact_sales erp_catalog_contact_save erp_catalog_contact_set_seller erp_catalog_contact_set_situation erp_catalog_contact_summary
    erp_catalog_contact_tags erp_catalog_contact_tags_save erp_catalog_contact_type_create erp_catalog_contact_type_delete erp_catalog_contact_types
    erp_catalog_employee_get erp_catalog_employee_page erp_catalog_employee_save erp_catalog_payment_method_action erp_catalog_payment_method_get
    erp_catalog_payment_method_page erp_catalog_payment_method_save erp_catalog_seller_from_contact erp_catalog_seller_get erp_catalog_seller_options
    erp_catalog_seller_page erp_catalog_seller_save erp_company_access erp_company_confirm_fiscal erp_company_extra_get
    erp_company_extra_save erp_company_file_claim erp_company_file_delete erp_company_file_finish erp_company_file_object
    erp_company_file_reserve erp_company_file_stop erp_company_get erp_company_logo_claim erp_company_logo_delete
    erp_company_logo_finish erp_company_logo_get erp_company_logo_object erp_company_logo_reserve erp_company_logo_stop
    erp_company_partners_get erp_company_partners_save erp_company_save_identity erp_document_access erp_files_list_v2
    erp_home_charts_get erp_home_charts_save erp_home_expiring erp_home_notifications erp_home_notifications_read
    erp_home_overview erp_home_shortcuts_get erp_home_shortcuts_save erp_home_summary erp_platform_export_chunk
    erp_platform_export_complete erp_platform_export_expired erp_platform_export_link erp_platform_export_plan erp_platform_export_removed
    erp_platform_export_request erp_platform_exports erp_platform_notifications_run erp_platform_schedule erp_platform_task_claim
    erp_platform_task_finish erp_platform_task_progress erp_platform_tasks erp_preferences_framework_delete erp_preferences_labels
    erp_preferences_reports erp_reference_search erp_document_signature erp_document_signature_save
    erp_module_apply erp_module_origin_get erp_module_command_close erp_module_manual_apply
    erp_catalog_contact_fields erp_catalog_contact_field_save erp_catalog_contact_field_delete erp_catalog_contact_field_values
    erp_catalog_contact_field_values_save erp_catalog_contact_field_bulk erp_catalog_contact_field_bulk_save erp_catalog_contact_field_page`,
  billing: `erp_cnab_access erp_cnab_approve erp_cnab_file erp_cnab_files erp_cnab_finalize
    erp_cnab_human_review_get erp_cnab_human_review_history erp_cnab_human_review_list erp_cnab_human_review_save erp_cnab_human_review_verify
    erp_cnab_itau_boleto_context erp_cnab_itau_boleto_items erp_cnab_itau_net_credit_command erp_cnab_itau_net_credit_preview erp_cnab_itau_net_credit_settle
    erp_cnab_operational_approve erp_cnab_operational_approve_v2 erp_cnab_operational_bind erp_cnab_operational_command_v2 erp_cnab_operational_event
    erp_cnab_operational_events erp_cnab_operational_file erp_cnab_operational_file_v2 erp_cnab_operational_files erp_cnab_operational_files_v2
    erp_cnab_operational_finalize erp_cnab_operational_finalize_v2 erp_cnab_operational_profiles erp_cnab_operational_profiles_v2 erp_cnab_operational_reservation
    erp_cnab_operational_reservation_v2 erp_cnab_operational_reserve erp_cnab_operational_reserve_v2 erp_cnab_operational_return_commit erp_cnab_operational_return_file
    erp_cnab_operational_return_profile erp_cnab_operational_return_verify erp_cnab_operational_settle erp_cnab_operational_settlement_get erp_cnab_profile_context
    erp_cnab_profile_save erp_cnab_profiles erp_cnab_remittance_candidates erp_cnab_remittance_detail erp_cnab_remittance_exclude
    erp_cnab_remittance_page erp_cnab_reservation erp_cnab_reserve erp_cnab_return_commit erp_cnab_return_context
    erp_cnab_return_detail erp_cnab_return_exclude erp_cnab_return_page erp_cnab_review erp_contact_billing_get
    erp_contact_billing_save`,
  document: `erp_attachment_claim erp_attachment_delete erp_attachment_finish erp_attachment_list erp_attachment_object
    erp_attachment_reserve erp_attachment_stop erp_document_categories erp_document_checkout_get erp_document_checkout_lookup
    erp_document_checkout_save erp_document_commission_operation erp_document_conversion_preview erp_document_copy erp_document_copy_origin
    erp_document_copy_preview erp_document_custom_field_delete erp_document_custom_field_save erp_document_custom_fields erp_document_discount_approval
    erp_document_discount_approval_save erp_document_export erp_document_freight_paid_get erp_document_freight_paid_save erp_document_get
    erp_document_history erp_document_invoice_balance erp_document_list erp_document_list_view_get erp_document_list_view_save
    erp_document_lot_options erp_document_lot_products erp_document_next_number erp_document_notes_save erp_document_numbering_set
    erp_document_occurrence_add erp_document_occurrence_list erp_document_occurrence_remove erp_document_payment_options erp_document_pendencies
    erp_document_print_header erp_document_print_header_save erp_document_product_search erp_document_proposal_version erp_document_sales_abc
    erp_document_sales_bag erp_document_sales_bag_change erp_document_sales_report erp_document_sales_report_options erp_document_sales_romaneio
    erp_document_save erp_document_seller_commission erp_document_service_occurrence_report erp_document_service_report
    erp_document_situations erp_document_structures erp_document_supplier_codes erp_document_supplier_descriptions
    erp_document_transition erp_document_trash erp_document_xml_match erp_proposal_convert erp_proposal_convert_to_service
    erp_sales_order_convert_to_service erp_service_journal_append erp_service_journal_get erp_service_journal_list`,
  document_finance: `erp_document_finance_get erp_document_finance_list erp_document_finance_post erp_document_finance_preview erp_document_finance_reverse
    erp_document_finance_reverse_preview`,
  document_stock: `erp_document_stock_get erp_document_stock_list erp_document_stock_post erp_document_stock_preview erp_document_stock_reverse
    erp_document_stock_reverse_preview erp_stock_document_warehouse_post erp_stock_document_warehouse_preview`,
  entity: `erp_catalog_check erp_catalog_get erp_catalog_list erp_catalog_page erp_catalog_save
    erp_catalog_save_checked erp_catalog_set_active erp_read_records`,
  external: `erp_catalog_origin_categories erp_catalog_origin_deletions erp_catalog_origin_mirror_get erp_history_backups erp_stock_mirror_list
    erp_stock_mirror_project erp_wabotia_state`,
  finance: `erp_finance_access erp_finance_account_detail erp_finance_account_execute erp_finance_account_page erp_finance_bordero_execute
    erp_finance_bordero_get erp_finance_bordero_page erp_finance_cash_entry_get erp_finance_cash_execute erp_finance_cash_session_execute
    erp_finance_cash_session_get erp_finance_cash_session_page erp_finance_category_execute erp_finance_category_tree erp_finance_commission_execute
    erp_finance_commission_page erp_finance_commission_report erp_finance_commission_statement erp_finance_contact_ledger erp_finance_contact_ledger_page
    erp_finance_contact_open_titles erp_finance_due_report erp_finance_execute erp_finance_file_claim erp_finance_file_delete
    erp_finance_file_finish erp_finance_file_list erp_finance_file_object erp_finance_file_reserve erp_finance_file_stop
    erp_finance_get erp_finance_grouped_billing_candidates erp_finance_grouped_billing_documents erp_finance_grouped_billing_execute erp_finance_grouped_billing_page
    erp_finance_import_execute erp_finance_import_preview erp_finance_list erp_finance_payment_methods erp_finance_reconciliation_candidates
    erp_finance_reconciliation_dismiss erp_finance_reconciliation_execute erp_finance_reconciliation_page erp_finance_recurrence_execute erp_finance_recurrence_get
    erp_finance_recurrence_page erp_finance_report erp_finance_statement_page erp_finance_title_detail erp_finance_title_execute
    erp_finance_title_page erp_finance_title_page_v2 erp_finance_transfer_command erp_finance_transfer_get erp_finance_transfer_list
    erp_finance_transfer_post`,
  fiscal: `erp_catalog_invoice_list_tagged erp_catalog_invoice_tags erp_catalog_invoice_tags_save erp_fiscal_invoice_contact_source erp_fiscal_invoice_context
    erp_fiscal_invoice_get erp_fiscal_invoice_item_history erp_fiscal_invoice_key_lookup erp_fiscal_invoice_list erp_fiscal_invoice_payment_methods
    erp_fiscal_invoice_pricing_record erp_fiscal_invoice_pricing_states erp_fiscal_invoice_product_groups erp_fiscal_invoice_returned erp_fiscal_invoice_xml_get
    erp_fiscal_invoice_xml_source erp_fiscal_nature_execute erp_fiscal_nature_get erp_fiscal_nature_list erp_fiscal_nature_review_confirm
    erp_fiscal_reform_nature_class_get erp_fiscal_reform_nature_class_save erp_fiscal_tax_estimate_context erp_fiscal_tax_estimate_context_v2 erp_fiscal_tax_settings_get
    erp_fiscal_tax_settings_save erp_platform_new_invoices erp_platform_new_invoices_seen`,
  fiscal_finance: `erp_finance_invoice_finance_flags erp_finance_invoice_finance_get erp_finance_invoice_finance_post erp_finance_invoice_finance_preview erp_finance_invoice_finance_reverse
    erp_finance_invoice_order_titles`,
  fiscal_stock: `erp_stock_checkin_batch erp_stock_checkin_finish erp_stock_checkin_finish_post erp_stock_checkin_get erp_stock_checkin_issue
    erp_stock_checkin_notes erp_stock_checkin_post_preview erp_stock_checkin_restart erp_stock_checkin_save erp_stock_invoice_flags
    erp_stock_invoice_get erp_stock_invoice_post erp_stock_invoice_preview erp_stock_invoice_reverse erp_stock_invoice_reverse_preview
    erp_stock_invoice_unit_save erp_stock_invoice_units erp_stock_report_entry_notes`,
  import: `erp_preferences_import_batch erp_preferences_import_job erp_preferences_import_jobs`,
  label: `erp_preferences_label_invoice_products erp_preferences_label_records erp_preferences_label_save`,
  list: `erp_list_preferences_command erp_list_preferences_get erp_list_preferences_save`,
  pos: `erp_pos_cash_summary erp_pos_context erp_pos_favorites erp_pos_order erp_pos_return_execute
    erp_pos_sale_execute erp_pos_sale_get erp_pos_sales erp_pos_settings_execute`,
  preference: `erp_preferences_command erp_preferences_page erp_preferences_save`,
  product_purchase: `erp_catalog_product_purchase_info`,
  products: `erp_catalog_custom_field_delete erp_catalog_custom_field_save erp_catalog_custom_fields erp_catalog_custom_fields_screen erp_catalog_product_export
    erp_catalog_product_export_v2 erp_catalog_product_form_context erp_catalog_product_get erp_catalog_product_image_claim erp_catalog_product_image_delete
    erp_catalog_product_image_finish erp_catalog_product_image_object erp_catalog_product_image_order erp_catalog_product_image_reserve erp_catalog_product_image_stop
    erp_catalog_product_images erp_catalog_product_list erp_catalog_product_page erp_catalog_product_page_custom erp_catalog_product_page_v2
    erp_catalog_product_page_v3 erp_catalog_product_price_adjust erp_catalog_product_price_preview erp_catalog_product_prices_update erp_catalog_product_save
    erp_catalog_product_set_deleted erp_catalog_product_variation_add erp_catalog_product_variations erp_pricing_applicable_lists erp_pricing_applicable_lists_v2
    erp_pricing_list_clone erp_pricing_list_delete erp_pricing_list_get erp_pricing_list_import erp_pricing_list_items
    erp_pricing_list_prices erp_pricing_list_save erp_pricing_lists erp_pricing_product_lists`,
  purchase_stock: `erp_purchase_receipts_command erp_purchase_receipts_get erp_purchase_receipts_preview erp_purchase_receipts_receive erp_purchase_receipts_reverse
    erp_purchase_receipts_reverse_preview erp_stock_purchase_receive erp_stock_purchase_receive_preview erp_stock_purchase_reverse_all erp_stock_purchase_suggestion
    erp_stock_report_purchase_orders`,
  report: `erp_preferences_report_run erp_preferences_report_save`,
  sales: `erp_home_business_panel erp_home_top_products erp_catalog_contact_timeline`,
  sales_stock: `erp_stock_product_reservations erp_stock_reservation_apply erp_stock_reservation_command erp_stock_reservation_get erp_stock_reservation_preview`,
  situation: `erp_preferences_situation_save erp_preferences_situations erp_preferences_transition_save erp_preferences_transitions_delete`,
  stock: `erp_stock_mirror_product_summary erp_stock_availability erp_stock_balances erp_stock_composition_components erp_stock_composition_export erp_stock_composition_get
    erp_stock_composition_launch erp_stock_composition_launches erp_stock_count_balance erp_stock_count_delete erp_stock_count_get
    erp_stock_count_read erp_stock_count_restart erp_stock_count_warehouse erp_stock_dashboard_idle erp_stock_dashboard_preference_get
    erp_stock_dashboard_preference_set erp_stock_dashboard_stock erp_stock_item_components erp_stock_item_components_save erp_stock_launch
    erp_stock_launch_context erp_stock_ledger erp_stock_lot_get erp_stock_lot_import erp_stock_lot_launch erp_stock_lot_save
    erp_stock_lot_status erp_stock_lots erp_stock_movement_amend erp_stock_movement_lots erp_stock_movement_lots_assign
    erp_stock_movements erp_stock_opening_apply erp_stock_opening_batch erp_stock_opening_command erp_stock_opening_page
    erp_stock_opening_warehouses erp_stock_policy_command erp_stock_policy_get erp_stock_policy_set erp_stock_position_warehouses
    erp_stock_positions erp_stock_post erp_stock_product_compose erp_stock_product_create erp_stock_product_locations
    erp_stock_report_balances_at erp_stock_report_below_min erp_stock_report_financial erp_stock_report_idle erp_stock_report_movements
    erp_stock_report_product erp_stock_report_top erp_stock_report_transfers erp_stock_reverse erp_stock_source_lots
    erp_stock_suppliers erp_stock_totals erp_stock_transfer_batch erp_stock_transfer_positions erp_stock_warehouse_options
    erp_stock_warehouse_save erp_stock_warehouse_set_default erp_stock_warehouses`,
  taxonomy: `erp_catalog_taxonomy_delete erp_catalog_taxonomy_list erp_catalog_taxonomy_save`,
} as const;
export type ErpRpcRule = keyof typeof RPC_GROUPS;
export const ERP_RPC_RULES: Readonly<Record<string, ErpRpcRule>> = Object.freeze(Object.fromEntries(
  Object.entries(RPC_GROUPS).flatMap(([rule, names]) => names.trim().split(/\s+/).map(name => [name, rule as ErpRpcRule])),
));
const obj = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const parse = (value: unknown): any => typeof value === "string" ? JSON.parse(value) : value;
const rowAt = (db: SqlDriver, table: string, id: unknown, key = "id"): Row | null => typeof id === "string" ? one(db, `SELECT * FROM "${table}" WHERE "${key}"=?`, id) : null;
const entityAliases: Record<string, string> = { contato: "contacts", produto: "products", nota_fiscal: "nfe", ordem_servico: "service_orders", pedido_venda: "sales_orders", stock_movements: "warehouses", compositions: "products", product_suppliers: "products", fiscal_invoices: "nfe" };
export function persistedEntityRequirement(db: SqlDriver, table: "erp_documents__document" | "erp_catalog__record", id: unknown, supplied?: unknown): ErpRequirement | null {
  const row = rowAt(db, table, id);
  const entity = row?.kind ?? row?.entity;
  if (entity && supplied != null && supplied !== entity) throw new ErpError("22023", "erp_parts_owner_mismatch");
  return erpEntityRequirement(entity ?? supplied);
}
function typeRequirement(value: unknown) { return erpEntityRequirement(typeof value === "string" ? entityAliases[value] ?? value : value); }
function documentRequirement(ctx: RpcContext, name: string, a: RpcArgs): ErpRequirement | null {
  // Nesta prévia p_kind é o destino, não o discriminador da origem lida.
  if (name === "erp_document_conversion_preview")
    return persistedEntityRequirement(ctx.db, "erp_documents__document", a.p_proposal_id, "sales_proposals");
  const supplied = a.p_kind ?? a.p_entity;
  let id = a.p_document_id ?? a.p_document ?? a.p_proposal_id;
  if (!id && !name.includes("_custom_field_") && /^(erp_document_|erp_proposal_convert|erp_sales_order_convert)/.test(name)) id = a.p_id ?? a.p_source_id;
  if (!id && a.p_id && name.startsWith("erp_attachment_")) id = rowAt(ctx.db, "erp_attachments__attachment", a.p_id)?.document_id;
  if (id) return persistedEntityRequirement(ctx.db, "erp_documents__document", id, supplied);
  if (supplied) return typeRequirement(supplied);
  if (name === "erp_document_supplier_codes") return erpRequirement("erp-produtos", "erp-compras");
  if (["erp_document_checkout_lookup", "erp_document_discount_approval", "erp_document_discount_approval_save"].includes(name)) return erpRequirement("erp-vendas");
  // Famílias exclusivamente comerciais não recebem discriminador.
  if (/sales|proposal|service|seller_commission/.test(name)) return erpRequirement("erp-vendas");
  return null;
}
const fixed: Partial<Record<ErpRpcRule, ErpModuleId[]>> = {
  com1_prepare: ["erp-fiscal", "erp-vendas"], com1_read: ["erp-fiscal"],
  com1_effect: ["erp-fiscal"],
  inbound: ["erp-compras"],
  base: ["erp"], products: ["erp-produtos"], product_purchase: ["erp-produtos", "erp-compras"],
  stock: ["erp-estoque"], sales: ["erp-vendas"], finance: ["erp-financeiro"], billing: ["erp-cobranca"],
  fiscal: ["erp-fiscal"], pos: ["erp-pdv"], purchase_stock: ["erp-compras", "erp-estoque"],
  sales_stock: ["erp-vendas", "erp-estoque"], fiscal_stock: ["erp-fiscal", "erp-estoque"], fiscal_finance: ["erp-fiscal", "erp-financeiro"],
};
/** Requisitos da chamada, resolvidos no mesmo SQLite da operação. */
export function rpcPartsRequirement(ctx: RpcContext, name: string, a: RpcArgs): ErpRequirement | "externo" | null {
  const rule = ERP_RPC_RULES[name], data = obj(a.p_data), ids: ErpModuleId[] = [];
  if (!rule) return null;
  if (rule === "external") return "externo";
  // Commit de evidência não é um envio novo. O registro confere o comando
  // durável e seu token antes de delegar; não depende das partes atuais.
  if (rule === "com1_evidence") return erpRequirement();
  const add = (r: ErpRequirement | null) => { if (!r) throw new ErpError("22023", "erp_parts_unknown_type"); ids.push(...r.all); };
  if (fixed[rule]) ids.push(...fixed[rule]!);
  if (rule === "com1_claim") {
    const input = obj(a.p_input);
    if (input.action !== "emit" && input.action !== "resume") throw new ErpError("22023", "com1_action_invalid");
    ids.push("erp-fiscal");
    // A nota de serviço da ordem (NFS-e, tabelas service_*) exige só a Fiscal;
    // a NF-e (também a das peças da ordem) exige Vendas. O preparo das notas da
    // ordem (erp_com1_os_prepare) confere Vendas e Produtos na NF-e das peças.
    if (input.action === "emit" && !one(ctx.db, "SELECT 1 FROM erp_fiscal_vault__service_emission WHERE id=?", input.emission_id)) ids.push("erp-vendas");
  }
  if (rule === "document" || rule === "document_stock" || rule === "document_finance") {
    add(documentRequirement(ctx, name, a));
    if (name === "erp_document_conversion_preview") add(typeRequirement(a.p_kind));
    if (rule === "document_stock") ids.push("erp-estoque");
    if (rule === "document_finance" || /commission|categories/.test(name)) ids.push("erp-financeiro");
    if (name === "erp_document_invoice_balance") ids.push("erp-fiscal");
    if (/lot_/.test(name)) ids.push("erp-estoque");
    if (/xml/.test(name)) ids.push("erp-fiscal", "erp-produtos");
  }
  if (rule === "entity") {
    const entity = a.p_entity ?? a.p_kind;
    if (name.startsWith("erp_catalog_") && a.p_id) add(persistedEntityRequirement(ctx.db, "erp_catalog__record", a.p_id, entity));
    else add(typeRequirement(entity));
  }
  if (rule === "taxonomy") {
    const saved = rowAt(ctx.db, "erp_catalog__taxonomy", a.p_id);
    if (saved?.kind && (a.p_kind ?? a.p_type) && saved.kind !== (a.p_kind ?? a.p_type)) throw new ErpError("22023", "erp_parts_owner_mismatch");
    add(typeRequirement(saved?.kind ?? a.p_kind ?? a.p_type));
    const parent = rowAt(ctx.db, "erp_catalog__taxonomy", saved?.parent_id ?? data.parent_id);
    const command = rowAt(ctx.db, "erp_catalog__command", a.p_command_id, "command_id");
    const receipt = command && command.actor === a.p_user_id ? obj(parse(command.result)) : {};
    const audit = receipt.kind === (a.p_kind ?? a.p_type) && receipt.deleted === true
      ? one(ctx.db, `SELECT before_data FROM "erp_catalog__taxonomy_audit"
          WHERE command_id=? AND actor=? AND kind=? AND item_id=? AND action='delete'`,
        a.p_command_id, a.p_user_id, receipt.kind, receipt.id)
      : null;
    // Pai e recibos sobreviventes também fixam a origem. Um corpo que omite
    // tag_type não pode trocar a recusa da parte suspensa por acesso legado.
    const types = [saved?.tag_type, data.tag_type, parent?.tag_type,
      receipt.kind === (a.p_kind ?? a.p_type) ? obj(receipt.item).tag_type : null,
      obj(parse(audit?.before_data)).tag_type];
    if (types.includes("invoices")) ids.push("erp-fiscal");
  }
  if (rule === "preference") {
    const saved = name === "erp_preferences_command" ? rowAt(ctx.db, "erp_preferences__command", a.p_command_id) : null;
    add(erpPreferenceRequirement(saved?.page_id ?? a.p_page_id ?? a.p_page));
  }
  if (rule === "report") {
    const reference = ctx.partsReference?.kind === "report" ? ctx.partsReference.id : undefined;
    const saved = rowAt(ctx.db, "erp_preferences__report", reference ?? a.p_report ?? a.p_id);
    if (reference && !saved) throw new ErpError("P0002", "erp_preferences_report_not_found");
    if (saved) add(erpReportRequirement(saved.base, parse(saved.columns), parse(saved.filters)));
    if (!saved || data.base || a.p_base) add(erpReportRequirement(a.p_base ?? data.base, a.p_columns as unknown[] ?? data.columns, a.p_filters as unknown[] ?? data.filters));
  }
  if (rule === "label") {
    if (name === "erp_preferences_label_invoice_products") ids.push("erp-fiscal", "erp-produtos");
    else {
      const reference = ctx.partsReference?.kind === "label" ? ctx.partsReference.id : undefined;
      const saved = rowAt(ctx.db, "erp_preferences__label_template", reference ?? a.p_template ?? a.p_label ?? a.p_id);
      if (reference && !saved) throw new ErpError("P0002", "erp_preferences_label_not_found");
      add(typeRequirement(saved?.type ?? a.p_type ?? data.type));
    }
  }
  if (rule === "situation") {
    const saved = rowAt(ctx.db, "erp_preferences__situation", a.p_situation);
    if (saved && a.p_kind !== saved.kind) throw new ErpError("22023", "erp_parts_owner_mismatch");
    add(typeRequirement(saved?.kind ?? a.p_kind));
  }
  if (rule === "import") {
    const saved = rowAt(ctx.db, "erp_preferences__import_job", a.p_job_id ?? a.p_id);
    const kind = saved?.kind ?? a.p_kind;
    const batch = name === "erp_preferences_import_batch";
    const supplied = erpImportRequirement(a.p_kind), stored = erpImportRequirement(kind);
    if (batch && supplied) add(supplied);
    if (stored) add(stored);
    // Família inválida do batch é validada pelo próprio RPC, depois do papel,
    // preservando a recusa original. Diretório misto filtra cada linha depois.
    else if (batch || !kind) ids.push("erp");
    else add(stored);
  }
  if (rule === "list") {
    const saved = name.endsWith("_command") ? rowAt(ctx.db, "erp_list_preferences__command", a.p_command_id) : null;
    const list = String(saved?.list_id ?? a.p_list_id ?? "");
    add(erpListRequirement(list));
    // Valores ocultos reenviados sem alteração continuam preservados.
    if (name === "erp_list_preferences_save") {
      const stored = one(ctx.db, "SELECT filters FROM erp_list_preferences__preference WHERE user_id=? AND list_id=?", a.p_user_id, list);
      const before = obj(stored ? parse(stored.filters) : null), after = obj(a.p_filters);
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) ids.push(...erpFieldRequirement(key, erpListRequirement(list)!.all[0]).all);
      }
    }
  }
  if (name === "erp_catalog_contact_sales") ids.push("erp-vendas");
  if (name === "erp_catalog_contact_history") add(typeRequirement(a.p_kind));
  if (name.startsWith("erp_stock_item_components")) {
    const item = rowAt(ctx.db, "erp_documents__item", a.p_item_id);
    if (item && a.p_document_id && item.document_id !== a.p_document_id) throw new ErpError("22023", "erp_parts_owner_mismatch");
    add(persistedEntityRequirement(ctx.db, "erp_documents__document", item?.document_id ?? a.p_document_id));
  }
  if (name === "erp_document_trash" && Array.isArray(a.p_ids)) for (const id of a.p_ids) {
    add(persistedEntityRequirement(ctx.db, "erp_documents__document", typeof id === "object" ? obj(id).id : id, a.p_kind));
  }
  if (name === "erp_platform_notifications_run" && a.p_type) add(erpNotificationRequirement(a.p_type));
  if (name === "erp_finance_account_execute" && a.p_action === "account_set_default" && data.target === "boleto") ids.push("erp-cobranca");
  if (/^erp_stock_(invoice|checkin)_/.test(name) || rule === "fiscal_finance") {
    const invoice = rowAt(ctx.db, "erp_fiscal_invoices__invoice", a.p_invoice_id ?? a.p_invoice ?? data.invoice_id);
    if (a.p_purchase_order_id || invoice && one(ctx.db, `SELECT 1 FROM erp_fiscal_invoices__invoice_order o
      JOIN erp_documents__document d ON d.id=o.document_id WHERE o.invoice_id=? AND d.kind='purchase_orders'`, invoice.id)) ids.push("erp-compras");
  }
  if (name === "erp_finance_grouped_billing_execute" && a.p_action === "grouped_billing_generate") {
    for (const item of Array.isArray(data.items) ? data.items : []) {
      for (const id of Array.isArray(item.document_ids) ? item.document_ids : []) add(persistedEntityRequirement(ctx.db, "erp_documents__document", id));
      if (Array.isArray(item.invoice_ids) && item.invoice_ids.length) ids.push("erp-fiscal");
    }
  }
  if (name === "erp_home_business_panel") {
    const panel = String(a.p_panel ?? a.p_dashboard ?? "");
    if (/margin|margem/.test(panel)) ids.push("erp-compras", "erp-estoque");
    if (/forecast|previsao|coverage/.test(panel)) ids.push("erp-estoque");
  }
  if (name === "erp_preferences_framework_delete") {
    const tables: Record<string, string> = { reports: "erp_preferences__report", labels: "erp_preferences__label_template", situations: "erp_preferences__situation" };
    const table = tables[String(a.p_target)];
    if (!table) throw new ErpError("22023", "erp_parts_unknown_type");
    for (const item of Array.isArray(a.p_items) ? a.p_items : []) {
      const saved = rowAt(ctx.db, table, obj(item).id); if (!saved) continue;
      if (a.p_target === "reports") add(erpReportRequirement(saved.base, parse(saved.columns), parse(saved.filters)));
      else add(typeRequirement(saved.type ?? saved.kind));
    }
  }
  if (name.startsWith("erp_platform_") && a.p_task) {
    const task = rowAt(ctx.db, "erp_platform__task", a.p_task);
    if (task) add(erpTaskRequirement(task.purpose, parse(task.payload)));
  }
  if (name === "erp_stock_reservation_command" || name === "erp_purchase_receipts_command") {
    const table = name === "erp_stock_reservation_command" ? "erp_stock__reservation_command" : "erp_purchase_receipts__command";
    const command = rowAt(ctx.db, table, a.p_command_id);
    if (command?.document_id) add(persistedEntityRequirement(ctx.db, "erp_documents__document", command.document_id));
  }
  if (rule === "fiscal" && (a.p_product_id || name.includes("_product_"))) ids.push("erp-produtos");
  if (rule === "fiscal" && a.p_category_id != null) ids.push("erp-financeiro");
  // Filtros das páginas reais usam argumentos escalares, além de p_filters.
  // A categoria de produto é cadastral; não herda a categoria financeira.
  if (rule === "products" || rule === "document") {
    if ([a.p_stock, a.p_warehouse_id, a.p_component_id, a.p_lots].some(v => v != null && v !== "")) ids.push("erp-estoque");
    if (["composition", "no_composition"].includes(String(a.p_product_type)) || a.p_format === "E") ids.push("erp-estoque");
  }
  for (const [key, value] of Object.entries(rule === "list" ? {} : { ...obj(a.p_filters), ...obj(a.p_filter) })) {
    if (value !== null && value !== undefined && value !== "") ids.push(...erpFieldRequirement(key, rule === "products" ? "erp-produtos" : undefined).all);
  }
  if (name.startsWith("erp_stock_reservation_") && a.p_document_id) add(persistedEntityRequirement(ctx.db, "erp_documents__document", a.p_document_id, "sales_orders"));
  if (name.startsWith("erp_purchase_receipts_") && a.p_document_id) add(persistedEntityRequirement(ctx.db, "erp_documents__document", a.p_document_id, "purchase_orders"));
  return erpRequirement(...ids);
}

export function requireRpcParts(ctx: RpcContext, name: string, args: RpcArgs): void {
  if (!ERP_RPC_RULES[name]) throw new ErpError("0A000", `erp_rpc_unclassified:${name}`);
  if (COM1_EVIDENCE_RPCS.has(name)) {
    const input = obj(args.p_input);
    if (typeof input.emission_id !== "string" || typeof input.command_id !== "string" || typeof input.claim_token !== "string")
      throw new ErpError("42501", "com1_claim_required");
    // Sem importar domínios aqui: seus registros criariam ciclo com registry.
    // Repete a capacidade do store, inclusive para evidência tardia após lease.
    // O cupom do balcão (NFC-e) usa a mesma máquina em tabelas irmãs (counter_*).
    // A nota de serviço da ordem (NFS-e), nas irmãs service_*.
    const command = one(ctx.db, "SELECT emission_id,action,token FROM erp_fiscal_vault__order_command WHERE id=?", input.command_id)
      ?? one(ctx.db, "SELECT emission_id,action,token FROM erp_fiscal_vault__counter_command WHERE id=?", input.command_id)
      ?? one(ctx.db, "SELECT emission_id,action,token FROM erp_fiscal_vault__service_command WHERE id=?", input.command_id);
    const actions = name === "erp_com1_record" ? ["emit", "resume"] : ["cancel"];
    if (!command || !command.token || command.token !== input.claim_token || command.emission_id !== input.emission_id || !actions.includes(String(command.action)))
      throw new ErpError("42501", "com1_claim_required");
    return;
  }
  if (maintenanceAllows(ctx, name, args)) { requireErpParts(ctx, erpRequirement("erp")); return; }
  if (ERP_RPC_RULES[name] === "external" && ctx.identity.partsControl) throw new ErpError("erp_route_removed", "Esta rota do ERP não faz parte da instalação principal.");
  // O legado todo ligado conserva exatamente validações, DTOs e erros do oráculo.
  if (ERP_PART_KEYS.every(key => ctx.parts[key]) && !ctx.partsReference && !ctx.identity.partsControl) return;
  const requirement = rpcPartsRequirement(ctx, name, args);
  if (requirement === "externo") throw new ErpError("erp_route_removed", "Esta rota do ERP não faz parte da instalação principal.");
  requireErpParts(ctx, requirement);
}

interface MaintenanceScope { request: ErpMaintenanceRequest; document: string | null; invoice: string | null; title: string | null; sale: string | null }
const maintenance = new WeakMap<RpcContext, MaintenanceScope>();
const scopeDenied = (): never => { throw new ErpError("42501", "erp_maintenance_scope_denied"); };
/** Não altera parts nem papéis. A capacidade só existe durante esta pilha síncrona. */
export function withErpMaintenance<T>(ctx: RpcContext, request: ErpMaintenanceRequest, fn: () => T): T {
  if (maintenance.has(ctx)) return scopeDenied();
  requireErpParts(ctx, erpRequirement("erp"));
  const { type, id } = request.origin, actor = ctx.identity.actor;
  if (!actor || !one(ctx.db, 'SELECT 1 FROM erp_access__membership WHERE user_id=? AND active=1', actor.user_id)) return scopeDenied();
  const s: MaintenanceScope = { request, document: null, invoice: null, title: null, sale: null };
  const db = ctx.db;
  if (["sales_orders", "sales_proposals", "service_orders", "purchase_orders"].includes(type)) {
    const row = rowAt(db, "erp_documents__document", id);
    if (!row || row.kind !== type) return scopeDenied();
    s.document = id;
  } else if (["nfe", "nfce"].includes(type)) {
    const invoice = rowAt(db, "erp_fiscal_invoices__invoice", id);
    if (!invoice || String(invoice.model) !== (type === "nfe" ? "55" : "65")) return scopeDenied(); s.invoice = id;
  } else if (["receivables", "payables"].includes(type)) {
    const row = rowAt(db, "erp_finance__title", id);
    if (!row || row.kind !== (type === "receivables" ? "receivable" : "payable")) return scopeDenied(); s.title = id;
  } else if (type === "pos_sale") {
    const sale = rowAt(db, "erp_pos__sale", id); if (!sale) return scopeDenied(); s.sale = id; s.document = String(sale.document_id);
  } else {
    const table: Record<string, string> = { remittance: "erp_cnab__remittance", return_file: "erp_cnab__return_file", grouped_billing: "erp_finance__grouped_billing" };
    const existing = table[type] && rowAt(db, table[type], id);
    const excluded = type === "remittance" && rowAt(db, "erp_cnab__remittance_exclusion", id, "remittance_id");
    if (!existing && !excluded) return scopeDenied();
    if (request.action === "inspect" && actor.erp_role !== "admin") return scopeDenied();
  }
  const owner = typeRequirement(type) ?? erpRequirement(type === "pos_sale" ? "erp-pdv" : type === "grouped_billing" ? "erp-financeiro" : "erp-cobranca");
  if (!erpRequirementMet(ctx.parts, owner) && actor.erp_role !== "admin") return scopeDenied();
  maintenance.set(ctx, s);
  try { return fn(); } finally { maintenance.delete(ctx); }
}
/** Exportada aos produtores: testa ação E vínculo, nunca só a presença de uma marca. */
export function maintenanceAllows(ctx: RpcContext, name: string, args: RpcArgs): boolean {
  const scope = maintenance.get(ctx); if (!scope) return false;
  const { request: r } = scope, data = obj(args.p_data), db = ctx.db;
  if (r.action === "inspect") {
    const read = maintenanceReadRpc(r.origin);
    if (read?.rpc === name && Object.entries(read.args).every(([k, v]) => args[k] === v)) return true;
    return scopeDenied();
  }
  const root = ERP_MAINTENANCE_ACTIONS[r.action];
  const chained = r.action === "pos_sale_cancel" && ["erp_finance_execute", "erp_document_finance_reverse_preview", "erp_document_finance_reverse", "erp_document_stock_reverse_preview", "erp_document_stock_reverse", "erp_document_transition"].includes(name);
  if (name !== root.rpc && !chained) return scopeDenied();
  if (name === root.rpc && "action" in root && args.p_action !== root.action) return scopeDenied();
  if (name === "erp_document_transition") {
    if (!scope.sale || !scope.document || args.p_id !== scope.document || args.p_kind !== "sales_orders" || args.p_status !== "cancelled") return scopeDenied();
    const document = rowAt(db, "erp_documents__document", scope.document);
    const from = one(db, "SELECT situation_id FROM erp_documents__document_situation WHERE document_id=?", scope.document)?.situation_id ?? document?.status;
    const transition = one(db, "SELECT actions FROM erp_preferences__transition WHERE kind='sales_orders' AND from_key=? AND to_key='cancelled'", from);
    // Fechar a venda pode estornar, nunca aproveitar a capacidade para postar.
    if (transition && (parse(transition.actions) as string[]).some(action => !["reverse_stock", "reverse_finance"].includes(action))) return scopeDenied();
    return true;
  }
  if (name.startsWith("erp_document_")) {
    if (!scope.document || args.p_document_id !== scope.document) return scopeDenied();
    const table = name.includes("_finance_") ? "erp_finance__document_posting" : "erp_stock__document_posting";
    const row = rowAt(db, table, args.p_posting_id);
    return row?.document_id === scope.document || scopeDenied();
  }
  if (name.startsWith("erp_stock_invoice_") || name.startsWith("erp_finance_invoice_")) {
    if (!scope.invoice || (args.p_invoice_id ?? args.p_invoice ?? data.invoice_id) !== scope.invoice) return scopeDenied();
    const table = name.startsWith("erp_stock_") ? "erp_stock__invoice_posting" : "erp_finance__invoice_posting";
    const postingId = args.p_posting_id ?? data.posting_id;
    const posting = postingId ? rowAt(db, table, postingId) : one(db, `SELECT * FROM "${table}" WHERE invoice_id=?`, scope.invoice);
    return posting?.invoice_id === scope.invoice || scopeDenied();
  }
  if (name.startsWith("erp_stock_reservation_")) {
    const row = rowAt(db, "erp_stock__reservation", args.p_reservation_id);
    return args.p_action === "release" && !!scope.document && args.p_document_id === scope.document && row?.document_id === scope.document || scopeDenied();
  }
  if (name.startsWith("erp_purchase_receipts_")) {
    const receipt = rowAt(db, "erp_purchase_receipts__receipt", args.p_receipt_id);
    return !!scope.document && args.p_document_id === scope.document && receipt?.document_id === scope.document || scopeDenied();
  }
  if (name === "erp_finance_execute") {
    const settlement = rowAt(db, "erp_finance__settlement", data.settlement_id);
    const related = scope.title === data.id || (scope.sale && one(db, "SELECT 1 FROM erp_pos__sale_payment WHERE sale_id=? AND settlement_id=? AND title_id=?", scope.sale, data.settlement_id, data.id));
    return args.p_action === "reverse" && !!related && settlement?.title_id === data.id || scopeDenied();
  }
  if (name === "erp_pos_sale_execute") return scope.sale === data.sale_id && args.p_action === "sale_cancel" || scopeDenied();
  if (name === "erp_finance_grouped_billing_execute") return r.origin.type === "grouped_billing" && data.id === r.origin.id && args.p_action === "grouped_billing_delete" || scopeDenied();
  if (name === "erp_cnab_remittance_exclude") return r.origin.type === "remittance" && data.id === r.origin.id || scopeDenied();
  if (name === "erp_cnab_return_exclude") return r.origin.type === "return_file" && data.id === r.origin.id || scopeDenied();
  return scopeDenied();
}
/** Recorte das permissões originais para a leitura das ligações históricas.
 * Sem importar domínios aqui: eles registram RPCs e formariam um ciclo com registry. */
function maintenancePermission(db: SqlDriver, user: string, key: string): boolean {
  if (one(db, "SELECT role FROM erp_access__membership WHERE user_id=? AND active=1", user)?.role === "admin") return true;
  const row = one(db, "SELECT permissions FROM erp_access__user_control WHERE user_id=?", user);
  if (!row || row.permissions === null) return true;
  const granted = parse(row.permissions) as string[];
  const parts = key.split(".");
  return granted.includes(key) && (parts.length < 3 || granted.includes(parts.slice(0, 2).join(".")));
}
/** Executar após a leitura original da origem (papel/permissões originais). */
export function inspectErpEffects(ctx: RpcContext): unknown {
  const s = maintenance.get(ctx); if (!s || s.request.action !== "inspect") return scopeDenied();
  const role = ctx.identity.actor?.erp_role, links: Record<string, unknown[]> = {};
  const user = ctx.identity.actor!.user_id;
  const payable = s.request.origin.type === "purchase_orders" || s.request.origin.type === "payables" ||
    s.invoice && String(rowAt(ctx.db, "erp_fiscal_invoices__invoice", s.invoice)?.direction) === "0";
  const financePermission = payable ? "financas.contas_pagar" : "financas.contas_receber";
  const finance = ["admin", "financeiro", "consulta"].includes(role ?? "") && maintenancePermission(ctx.db, user, financePermission);
  const stock = ["admin", "estoque", "consulta", "vendas", "fiscal"].includes(role ?? "") && maintenancePermission(ctx.db, user, "suprimentos.controle_estoque");
  const rows = (table: string, key: string, id: string) => ctx.db.exec(`SELECT * FROM "${table}" WHERE "${key}"=?`, id).rows;
  if (s.document) {
    if (stock) { links.stock = rows("erp_stock__document_posting", "document_id", s.document); links.reservations = rows("erp_stock__reservation", "document_id", s.document); links.receipts = rows("erp_purchase_receipts__receipt", "document_id", s.document); }
    if (finance) { links.finance = rows("erp_finance__document_posting", "document_id", s.document); links.grouped_billing = rows("erp_finance__grouped_billing_document", "document_id", s.document); }
  }
  if (s.invoice) {
    if (stock) links.stock = rows("erp_stock__invoice_posting", "invoice_id", s.invoice);
    if (finance) {
      links.finance = rows("erp_finance__invoice_posting", "invoice_id", s.invoice).map(posting => ({
        ...posting,
        titles: ctx.db.exec(`SELECT t.id,t.version FROM erp_finance__invoice_title l
          JOIN erp_finance__title t ON t.id=l.title_id WHERE l.posting_id=? ORDER BY t.id`, posting.id).rows,
      }));
      links.grouped_billing = rows("erp_finance__grouped_billing_invoice", "invoice_id", s.invoice);
    }
  }
  if (s.title && finance) { links.settlements = rows("erp_finance__settlement", "title_id", s.title); links.billing = rows("erp_cnab__billing_title", "title_id", s.title); }
  const operations: string[] = [];
  const active = (key: string) => links[key]?.some(value => (value as Row).state === "active");
  const mayReverseStock = stock && ["admin", "estoque"].includes(role ?? "") && maintenancePermission(ctx.db, user, "suprimentos.controle_estoque.insercao");
  const mayReverseFinance = finance && ["admin", "financeiro"].includes(role ?? "");
  // Pedido protegido pela NF-e: não oferecer o estorno que a guarda recusa;
  // o bloqueador traz o mesmo código e o que fazer (inclusive religar a Fiscal).
  const fiscal: { kind: string; count: number; axis: string; code: string; message: string }[] = [];
  const fiscalFree = (axis: "stock" | "finance") => {
    const documents = s.document ? [s.document] : s.invoice
      ? ctx.db.exec("SELECT document_id FROM erp_fiscal_invoices__invoice_order WHERE invoice_id=?", s.invoice).rows.map(row => String(row.document_id)) : [];
    for (const document of documents) {
      const code = com1DirectReverseBlocker(ctx, document, axis);
      if (code) { fiscal.push({ kind: "fiscal_compensation", axis, count: 1, code, message: COM1_REVERSE_MESSAGES[code] }); return false; }
    }
    return true;
  };
  if (s.document && mayReverseStock && active("stock") && fiscalFree("stock")) operations.push("document_stock_reverse_preview", "document_stock_reverse");
  if (s.document && mayReverseFinance && active("finance") && fiscalFree("finance")) operations.push("document_finance_reverse_preview", "document_finance_reverse");
  if (mayReverseStock && active("reservations")) operations.push("reservation_release_preview", "reservation_release");
  if (mayReverseStock && links.receipts?.some(value => !one(ctx.db, "SELECT 1 FROM erp_purchase_receipts__reversal WHERE receipt_id=?", (value as Row).id))) operations.push("purchase_receipt_reverse_preview", "purchase_receipt_reverse");
  if (s.invoice && mayReverseStock && active("stock") && fiscalFree("stock")) operations.push("invoice_stock_reverse_preview", "invoice_stock_reverse");
  if (s.invoice && mayReverseFinance && active("finance") && fiscalFree("finance")) operations.push("invoice_finance_reverse");
  if (mayReverseFinance && links.settlements?.some(value => (value as Row).kind === "payment" && !one(ctx.db, "SELECT 1 FROM erp_finance__settlement WHERE reverses_id=?", (value as Row).id))) operations.push("settlement_reverse");
  if (s.sale && rowAt(ctx.db, "erp_pos__sale", s.sale)?.state !== "cancelled" && ["admin", "vendas"].includes(role ?? "")) operations.push("pos_sale_cancel");
  if (s.request.origin.type === "grouped_billing") operations.push("grouped_billing_delete");
  if (s.request.origin.type === "remittance") {
    links.remittances = ctx.db.exec("SELECT id,CAST(sequence AS TEXT) sequence FROM erp_cnab__remittance WHERE id=?", s.request.origin.id).rows;
    if (links.remittances.length) operations.push("remittance_exclude");
  }
  if (s.request.origin.type === "return_file") operations.push("return_exclude");
  const blocks = (kind: string, value: unknown) => {
    const row = value as Row;
    if (kind === "receipts") return !one(ctx.db, "SELECT 1 FROM erp_purchase_receipts__reversal WHERE receipt_id=?", row.id);
    if (kind === "settlements") return row.kind === "payment" && !one(ctx.db, "SELECT 1 FROM erp_finance__settlement WHERE reverses_id=?", row.id);
    if (kind === "grouped_billing") return Number(row.active) === 1;
    return row.state === "active";
  };
  const blockers = Object.entries(links).flatMap(([kind, values]) => {
    const current = values.filter(value => blocks(kind, value));
    return current.length ? [{ kind, count: current.length }] : [];
  }).concat(fiscal);
  const originTable = s.sale ? "erp_pos__sale" : s.document ? "erp_documents__document" :
    s.invoice ? "erp_fiscal_invoices__invoice" : s.title ? "erp_finance__title" :
      s.request.origin.type === "grouped_billing" ? "erp_finance__grouped_billing" : null;
  const originVersion = originTable ? Number(rowAt(ctx.db, originTable, s.request.origin.id)?.version) : NaN;
  return { origin: s.request.origin, ...(Number.isSafeInteger(originVersion) && originVersion > 0 ? { origin_version: originVersion } : {}), links, operations, blockers };
}
