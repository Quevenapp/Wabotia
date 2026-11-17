// RPCs portados do domínio: um import por arquivo de src/erp/domains/documents/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.

// Leituras (sessão L, combinado com a O): um import por arquivo reads-*.ts.
import "./rpc/reads-config.ts";
import "./rpc/reads-lookup.ts";
import "./rpc/reads-sales.ts";
import "./rpc/reads-journal.ts";
import "./rpc/reads-commerce.ts";
import "./rpc/reads-proposal.ts";
import "./rpc/reads-history.ts";
import "./rpc/reads-reports.ts";
import "./rpc/reads-b2.ts";
import "./rpc/reads-list.ts";

// Escritores do núcleo (sessão O).
import "./rpc/erp_document_save.ts";

export {};
