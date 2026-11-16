// RPCs portados do domínio: um import por arquivo de src/erp/domains/finance/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
import "./rpc/erp_finance_account_execute.ts";
import "./rpc/erp_finance_account_page.ts";
import "./rpc/erp_finance_category_execute.ts";
import "./rpc/erp_finance_payment_methods.ts";
import "./rpc/erp_finance_title_detail.ts";
import "./rpc/erp_finance_title_execute.ts";
export {};
