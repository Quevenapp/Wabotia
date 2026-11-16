// Escritas pela G para o domínio 11 (notificações da home); dono: Estoque (N).
// erp_stock.ignored_warehouse, count_physical, lot_quantity e lots_expiring:
// só leitura. Quantidades na escala 6 (numeric(18,6) do saldo), em BigInt.
import { fromColumn } from "../../engine/dec.ts";
import { one, type SqlDriver } from "../../engine/driver.ts";

/** erp_stock.ignored_warehouse(p_id): "Desconsiderar saldo deste depósito". */
export const ignoredWarehouse = (db: SqlDriver, id: string) =>
  Number(one(db, 'SELECT ignore_balance FROM "erp_stock__warehouse_setting" WHERE warehouse_id=?', id)?.ignore_balance ?? 0) === 1;

/** Soma das linhas (produto ou lote) no depósito dado, ou nos considerados sem depósito. */
function sum(db: SqlDriver, sql: string, key: string, warehouse: string | null): bigint {
  let total = 0n;
  for (const r of db.exec(sql, key).rows) {
    const wh = String(r.warehouse_id);
    if (warehouse !== null ? wh === warehouse : !ignoredWarehouse(db, wh)) total += fromColumn(r.q);
  }
  return total;
}

/** erp_stock.count_physical(p_product, p_warehouse): saldo físico (escala 6). */
export const countPhysical = (db: SqlDriver, product: string, warehouse: string | null = null) =>
  sum(db, 'SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__balance" WHERE product_id=?', product, warehouse);

/** erp_stock.lot_quantity(p_lot, p_warehouse): saldo do lote (escala 6). */
export const lotQuantity = (db: SqlDriver, lot: string, warehouse: string | null = null) =>
  sum(db, 'SELECT warehouse_id, CAST(quantity AS TEXT) q FROM "erp_stock__lot_balance" WHERE lot_id=?', lot, warehouse);

/**
 * erp_stock.lots_expiring(p_from, p_until): lotes ativos de produtos ativos e
 * não excluídos, com validade até p_until (e a partir de p_from) e saldo > 0.
 */
export function lotsExpiring(db: SqlDriver, from: string | null, until: string) {
  return db
    .exec(
      `SELECT l.product_id, l.id, l.code, l.expires_on FROM "erp_stock__lot" l JOIN "erp_catalog__record" r ON r.id=l.product_id
       WHERE l.active=1 AND r.active=1 AND l.expires_on IS NOT NULL AND l.expires_on<=? AND (? IS NULL OR l.expires_on>=?)
       AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=l.product_id AND d.deleted_at IS NOT NULL)`,
      until,
      from,
      from,
    )
    .rows.map((l) => ({
      product_id: String(l.product_id),
      id: String(l.id),
      code: String(l.code),
      expires_on: String(l.expires_on),
      qty: lotQuantity(db, String(l.id)),
    }))
    .filter((l) => l.qty > 0n);
}
