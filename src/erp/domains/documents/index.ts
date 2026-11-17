// RPCs portados do domínio: um import por arquivo de src/erp/domains/documents/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.

// Leituras (sessão L, combinado com a O): um import por arquivo reads-*.ts.
import "./rpc/reads-config.ts";
import "./rpc/reads-lookup.ts";

export {};
