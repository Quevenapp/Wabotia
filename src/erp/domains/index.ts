// RPCs portados: cada domínio registra os seus no próprio index.ts
// (src/erp/domains/<domínio>/index.ts). Dono de cada RPC e das funções
// compartilhadas: ownership.generated.json; regras em docs/ERP-PORTE.md.
import "./reference/index.ts";
import "./company/index.ts";
import "./access/index.ts";
import "./catalog/index.ts";
import "./documents/index.ts";
import "./stock/index.ts";
import "./finance/index.ts";
import "./fiscal/index.ts";
import "./cnab/index.ts";
import "./pos/index.ts";
import "./preferences/index.ts";
import "./sync/index.ts";
import "./inbound/index.ts";
import "./production/index.ts";
