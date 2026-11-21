// Assinaturas dos RPCs que só existem no motor (sem função no oráculo, logo
// fora do signatures.generated.ts): mesmo formato ArgSpec, lidas pelo
// prepareArgs depois das do oráculo. tests/erp/signatures.test.mjs exige que
// nenhum nome aqui repita um do oráculo, que todo nome aqui esteja registrado
// e que todo RPC registrado esteja num dos dois mapas. Cada domínio acrescenta
// as suas, com o arquivo do RPC no comentário.
import type { ArgSpec } from "./signatures.generated.ts";

export const ENGINE_SIGNATURES: Record<string, ArgSpec[]> = {
  erp_module_apply: [["p_user_id", "u"], ["p_request", "j"], ["p_evidence", "j"]],
  erp_module_manual_apply: [["p_user_id", "u"], ["p_request", "j"], ["p_evidence", "j"]],
  erp_module_origin_get: [["p_user_id", "u"], ["p_request", "j"], ["p_evidence", "j"]],
  erp_module_command_close: [["p_user_id", "u"], ["p_request", "j"], ["p_evidence", "j"], ["p_reason_code", "t"]],
  // src/erp/domains/fiscal/comnfe/registry.ts. DTOs em commercial-nfe/contracts.ts.
  // Identidade vem do envelope interno; p_user_id apenas confere quem comanda.
  erp_com1_config_get: [["p_user_id", "u"]],
  erp_com1_config_save: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_prepare: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_get: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_list: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_claim: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_record: [["p_input", "j"]],
  erp_com1_cancel_claim: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_cancel_record: [["p_input", "j"]],
  erp_com1_cancel_xml_record: [["p_input", "j"]],
  erp_com1_effect_apply: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_effect_reverse: [["p_user_id", "u"], ["p_input", "j"]],
  // Balcão com NFC-e: src/erp/domains/fiscal/comnfe/nfce.ts.
  erp_com1_nfce_prepare: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_nfce_sales: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_nfce_config_get: [["p_user_id", "u"]],
  erp_com1_nfce_config_save: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_nfce_sale_cancel: [["p_user_id", "u"], ["p_input", "j"]],
  // Notas da ordem de serviço (NFS-e e NF-e das peças): src/erp/domains/fiscal/comnfe/os-notes.ts.
  erp_com1_os_notes: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_os_prepare: [["p_user_id", "u"], ["p_input", "j"]],
  erp_com1_nfse_config_get: [["p_user_id", "u"]],
  erp_com1_nfse_config_save: [["p_user_id", "u"], ["p_input", "j"]],
  // Campos próprios de contato: src/erp/domains/catalog/contact-fields.ts (structural.ts, campos-contato).
  erp_catalog_contact_fields: [["p_user_id", "u"], ["p_audience", "t", "panel"]],
  erp_catalog_contact_field_save: [["p_user_id", "u"], ["p_id", "u", null], ["p_expected_version", "i", 0], ["p_command_id", "u"], ["p_data", "j"]],
  erp_catalog_contact_field_delete: [["p_user_id", "u"], ["p_id", "u"], ["p_expected_version", "i"], ["p_command_id", "u"]],
  erp_catalog_contact_field_values: [["p_user_id", "u"], ["p_contact_id", "u"], ["p_audience", "t", "panel"]],
  erp_catalog_contact_field_values_save: [["p_user_id", "u"], ["p_contact_id", "u"], ["p_command_id", "u"], ["p_values", "j"], ["p_audience", "t", "panel"]],
  erp_catalog_contact_field_bulk: [["p_user_id", "u"], ["p_ids", "U"], ["p_audience", "t", "list"]],
  erp_catalog_contact_field_bulk_save: [["p_user_id", "u"], ["p_command_id", "u"], ["p_items", "j"], ["p_audience", "t", "panel"]],
  erp_catalog_contact_field_page: [["p_user_id", "u"], ["p_page", "i", 1], ["p_size", "i", 100], ["p_sort", "t", "created_desc"], ["p_query", "t", null],
    ["p_situation", "t", "latest"], ["p_type", "t", null], ["p_person_type", "t", null], ["p_state", "t", null], ["p_city", "t", null], ["p_phone", "t", null],
    ["p_email", "t", null], ["p_seller_id", "u", null], ["p_period", "t", null], ["p_from", "d", null], ["p_to", "d", null], ["p_sale_statuses", "T", null],
    ["p_tag", "t", null], ["p_price_list_id", "u", null], ["p_fields", "j", null]],
  // src/erp/domains/fiscal/reform.ts (sessão G; structural.ts, reforma-classificacao)
  erp_fiscal_reform_nature_class_get: [
    ["p_user_id", "u"],
    ["p_nature_id", "u"],
  ],
  erp_fiscal_reform_nature_class_save: [
    ["p_user_id", "u"],
    ["p_command_id", "u"],
    ["p_nature_id", "u"],
    ["p_expected_hash", "t"],
    ["p_rules", "j"],
  ],
};
