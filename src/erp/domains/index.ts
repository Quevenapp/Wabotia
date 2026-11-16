// RPCs portados: cada domínio registra os seus ao ser importado. Para portar
// um RPC: escreva src/erp/domains/<domínio>/rpc/<nome>.ts com
// registerRpc("<nome>", fn) e importe aqui; o diferencial
// (tests/erp/harness/dual-fixture.mjs) passa a rodá-lo nos dois motores.
import "./reference/rpc/erp_reference_search.ts";
import "./stock/rpc/erp_stock_post.ts";
import "./catalog/rpc/erp_catalog_employee_get.ts";
import "./catalog/rpc/erp_catalog_employee_page.ts";
import "./catalog/rpc/erp_catalog_employee_save.ts";
