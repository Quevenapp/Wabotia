// RPCs portados do domínio: um import por arquivo de src/erp/domains/cnab/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
import "./rpc/erp_cnab_reads.ts";
import "./rpc/erp_cnab_lists.ts";
import "./rpc/erp_cnab_human_review_reads.ts";

export {};
