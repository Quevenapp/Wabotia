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
  // Relatórios do ERP (structural.ts, relatorios-dre-equipe): DRE e Custos
  // (finance/rpc/erp_finance_dre.ts), gráficos (finance/rpc/erp_finance_charts.ts,
  // stock/rpc/erp_stock_charts.ts, preferences/rpc/erp_report_sales_chart.ts),
  // lotes vencendo (stock/rpc/erp_stock_charts.ts) e pagamento da equipe
  // (finance/rpc/erp_finance_team.ts).
  erp_finance_dre: [["p_user_id", "u"], ["p_args", "j"]],
  erp_finance_dre_cost_set: [["p_user_id", "u"], ["p_command_id", "u"], ["p_category_id", "u"], ["p_cost", "o"]],
  erp_finance_chart: [["p_user_id", "u"], ["p_args", "j"]],
  erp_finance_team_people: [["p_user_id", "u"]],
  erp_finance_team_report: [["p_user_id", "u"], ["p_args", "j"]],
  erp_finance_team_commission: [["p_user_id", "u"], ["p_args", "j"]],
  erp_finance_team_pay: [["p_user_id", "u"], ["p_command_id", "u"], ["p_data", "j"]],
  erp_stock_chart: [["p_user_id", "u"], ["p_args", "j"]],
  erp_stock_lots_expiring: [["p_user_id", "u"], ["p_args", "j"]],
  erp_report_sales_chart: [["p_user_id", "u"], ["p_args", "j"]],
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
