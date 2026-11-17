// Documentos (erp_documents): o que outros domínios usam. Portado de
// erp_documents.allowed e guard_trash_child. Dono: O (Documentos); as
// leituras de reads-g.ts foram escritas pela G e assumidas por O.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { toScaled } from "../../engine/dec.ts";
import { ledgerDocumentPrice } from "../stock/public.ts";

export * from "./stubs.generated.ts";

/**
 * erp_documents.report_last_purchase_until(produto, até, saldos): o preço da
 * última entrada do produto até a data (recebimento com quantidade > 0, ou
 * contagem de saldo quando `balances`), sem estorno; o preço vem do
 * movement_detail mais recente, senão do erp_stock.ledger_document_price.
 * Devolve bigint na escala 10 (numeric(24,10)), como o Estoque; texto pelo
 * priceText do stock/public.ts. Pedido da G (erp_home_business_panel).
 */
export function reportLastPurchaseUntil(db: SqlDriver, product: string | null, until: string | null, balances: boolean | null): bigint | null {
  if (product === null || until === null) return null;
  const rows = db
    .exec(
      `SELECT m.id, m.occurred_on, m.created_at, m.kind, e.quantity, e.product_id,
              (SELECT CAST(y.unit_price AS TEXT) FROM "erp_stock__movement_detail" y WHERE y.movement_id=m.id AND y.product_id=e.product_id ORDER BY y.revision DESC LIMIT 1) detail_price,
              EXISTS(SELECT 1 FROM "erp_stock__movement_detail" y WHERE y.movement_id=m.id AND y.product_id=e.product_id) has_detail,
              EXISTS(SELECT 1 FROM "erp_stock__balance_count" c WHERE c.movement_id=m.id) counted
         FROM "erp_stock__entry" e JOIN "erp_stock__movement" m ON m.id=e.movement_id
        WHERE e.product_id=? AND m.occurred_on<=? AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" r WHERE r.reverses_id=m.id)`,
      product,
      until,
    )
    .rows.filter((r) => (r.kind === "receipt" && Number(r.quantity) > 0) || (balances === true && r.counted === 1))
    .map((r) => ({
      id: String(r.id),
      occurred_on: String(r.occurred_on),
      created_at: Number(r.created_at),
      price: r.has_detail === 1 ? (r.detail_price === null ? null : toScaled(String(r.detail_price), 10)) : ledgerDocumentPrice(db, String(r.id), String(r.product_id)),
    }))
    .filter((r) => r.price !== null)
    .sort(
      (x, y) =>
        (String(y.occurred_on) < String(x.occurred_on) ? -1 : String(y.occurred_on) > String(x.occurred_on) ? 1 : 0) ||
        Number(y.created_at) - Number(x.created_at) ||
        (String(y.id) < String(x.id) ? -1 : String(y.id) > String(x.id) ? 1 : 0),
    );
  return rows.length ? rows[0].price : null;
}

/**
 * erp_documents.guard_trash_child: gatilho das tabelas filhas de um documento
 * (no Financeiro, grouped_billing_document): nenhuma linha nova, alterada ou
 * apagada aponta para um documento na lixeira. Chame com o document_id da
 * linha (o novo no INSERT/UPDATE, o antigo no DELETE).
 */
export function guardTrashChild(db: SqlDriver, documentId: string | null) {
  if (documentId !== null && one(db, 'SELECT 1 x FROM "erp_documents__document" WHERE id=? AND deleted_at IS NOT NULL', documentId))
    raise("40001", "erp_document_deleted");
}
export { autoProducts } from "./internal.ts";
export { transitions } from "./preferences.ts";
export { contactUsable, mirrorRequireVisible, mirrorVisible, osPermitted, reportCoverage, requireAccess, requireRole } from "./reads-g.ts";
// Escrito pela N (recebimentos de compra do Estoque); dono: Documentos.
export { stockLaunchDate } from "./stock-n.ts";
export { preference } from "./internal.ts";

const KINDS =["sales_proposals", "sales_orders", "purchase_orders", "service_orders"];

/** erp_documents.allowed(role, kind, write) */
export function allowed(role: string | null, kind: string | null, write: boolean): boolean {
  // kind NULL: "p_kind not in (…)" é NULL e o CASE do Postgres segue para as regras do papel
  // (gravar: admin ou vendas; ler: admin, consulta ou financeiro; o resto dá NULL → false).
  if (kind !== null && !KINDS.includes(kind)) return false;
  if (role === null) return false;
  if (write) return kind === "purchase_orders" ? ["admin", "estoque"].includes(role) : ["admin", "vendas"].includes(role);
  if (["admin", "consulta", "financeiro"].includes(role)) return true;
  if (kind === null) return false;
  if (role === "vendas") return ["sales_proposals", "sales_orders", "service_orders"].includes(kind);
  if (["estoque", "fiscal"].includes(role)) return ["sales_orders", "purchase_orders"].includes(kind);
  return false;
}
