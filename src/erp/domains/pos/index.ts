// RPCs portados do domínio: um import por arquivo de src/erp/domains/pos/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
// Bloco opcional erp-pdv: as rotas que chamam estes RPCs só passam pelo portão
// com o módulo ligado (src/erp/blocks.ts, src/erp/api/local-fetch.ts).
import "./rpc/reads.ts";
import "./rpc/settings.ts";
import "./rpc/sale.ts";
