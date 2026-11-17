// RPCs portados do domínio: um import por arquivo de src/erp/domains/fiscal/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
import "./rpc/erp_fiscal_natures.ts";
import "./rpc/erp_fiscal_tax_settings.ts";
import "./rpc/erp_fiscal_invoice_support.ts";

export {};
