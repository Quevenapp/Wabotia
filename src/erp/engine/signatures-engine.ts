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
  // Compra pela nota recebida: src/erp/domains/inbound/rpc.ts (rota em src/erp/recebidas/).
  erp_inbound_list: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_get: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_register: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_fetch_claim: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_fetch_record: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_review: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_supplier_create: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_enter: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_reverse: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_settings_get: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_settings_save: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_manifest_claim: [["p_user_id", "u"], ["p_input", "j"]],
  erp_inbound_manifest_record: [["p_user_id", "u"], ["p_input", "j"]],
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
