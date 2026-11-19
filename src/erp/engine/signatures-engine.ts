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
