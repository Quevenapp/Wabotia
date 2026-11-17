// RPCs portados do domínio: um import por arquivo de src/erp/domains/stock/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
import "./rpc/erp_stock_post.ts";
import "./rpc/policy.ts";
import "./rpc/warehouses.ts";
import "./rpc/balances.ts";
import "./rpc/totals.ts";
import "./rpc/ledger.ts";
import "./rpc/reports.ts";
import "./rpc/dashboards.ts";
import "./rpc/document-stock.ts";
import "./rpc/reservations.ts";
import "./rpc/purchase-receipts.ts";
import "./rpc/launch.ts";
export {};
