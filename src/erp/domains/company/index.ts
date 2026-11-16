// RPCs portados do domínio: um import por arquivo de src/erp/domains/company/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
import "./rpc/identity.ts";
import "./rpc/extra.ts";
import "./rpc/files.ts";
export {};
