// erp_documents.cost_apply e o gatilho adiado cost_apply_capture (AFTER INSERT OR UPDATE em
// document, DEFERRABLE INITIALLY DEFERRED, só pedido de venda): o custo de cada item de um
// pedido confirmado, gravado uma vez em item_cost_applied. O custo é o médio do estoque,
// senão o preço de custo do fornecedor padrão, senão o do último pedido de compra.
// Sem código no topo do módulo: o Estoque importa este arquivo pelo documents/public.ts.
import { decText, formatScaled } from "../../engine/dec.ts";
import { one } from "../../engine/driver.ts";
import { fromSqlite } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { commissionConfirmed } from "../finance/public.ts";
import { bizUnitCost } from "../preferences/shared.ts";
import { averageCosts } from "../stock/public.ts";

/** erp_documents.cost_apply(documento): quantos itens receberam custo. */
export function costApply(ctx: RpcContext, document: string): number {
  const db = ctx.db;
  const d = one(db, 'SELECT id, kind, status FROM "erp_documents__document" WHERE id=?', document);
  if (!d || d.kind !== "sales_orders" || !commissionConfirmed(d.kind, d.status)) return 0;
  let count = 0;
  const items = db.exec(
    `SELECT i.id, i.product_id FROM "erp_documents__item" i WHERE i.document_id=? AND i.product_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM "erp_documents__item_cost_applied" a WHERE a.item_id=i.id) ORDER BY i.position`,
    d.id,
  ).rows;
  for (const r of items) {
    const product = String(r.product_id);
    const avg = averageCosts(db, [product]).get(product) ?? null;
    let cost: string | null = avg === null || avg === 0n ? null : formatScaled(avg, 10);
    let basis = "custo_medio";
    if (cost === null) {
      const s = one(db, 'SELECT cost_price FROM "erp_catalog__product_supplier" WHERE record_id=? AND is_default=1 LIMIT 1', product);
      cost = s?.cost_price === null || s?.cost_price === undefined ? null : String(s.cost_price);
      basis = "preco_custo";
    }
    if (cost === null) {
      cost = bizUnitCost(db, product);
      basis = "ultimo_pedido_compra";
    }
    if (cost !== null && !cost.trim().startsWith("-")) {
      if (!one(db, 'SELECT 1 x FROM "erp_documents__item_cost_applied" WHERE item_id=?', r.id))
        db.exec(
          'INSERT INTO "erp_documents__item_cost_applied"(item_id, document_id, product_id, unit_cost, basis, applied_on, applied_at) VALUES(?,?,?,?,?,?,?)',
          r.id, d.id, product, decText(cost, 10, true), basis, todaySaoPaulo(), ctx.clock.next().toString(),
        );
      count++;
    }
  }
  return count;
}

/**
 * Gatilho adiado cost_apply_capture: cost_apply num savepoint, que engole
 * data_exception e check_violation desfazendo o que a tentativa escreveu.
 */
export function costApplyCapture(ctx: RpcContext, document: string) {
  try {
    ctx.db.transaction(() => costApply(ctx, document));
  } catch (e) {
    const err = fromSqlite(e);
    if (err.code.startsWith("22") || err.code === "23514") return;
    throw err;
  }
}
