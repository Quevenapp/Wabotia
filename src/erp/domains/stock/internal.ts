// Estoque (erp_stock): funções internas e os gatilhos das tabelas, que no
// SQLite viram a "camada de tabela" (quem escreve na tabela chama a guarda).
// Portado das migrações do Fagoo; os gatilhos que só lançam erro
// (immutable_ledger) já estão em SQL gerado (src/erp/schema).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { formatScaled, fromColumn, toParam } from "../../engine/dec.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { activeRole, permitted } from "../access/public.ts";
import * as sync from "../sync/public.ts";

export const QTY = 6;
const MAX = 999999999999999999n; // 999999999999.999999 na escala 6

/** erp_stock.require_access */
export function requireAccess(db: SqlDriver, user: string, write: boolean) {
  const role = activeRole(db, user);
  if (
    !role ||
    (write && !["admin", "estoque"].includes(role)) ||
    (!write && !["admin", "consulta", "estoque", "vendas", "fiscal"].includes(role))
  )
    raise("42501", "erp_stock_access_denied");
  if (!permitted(db, user, "suprimentos.controle_estoque" + (write ? ".insercao" : "")))
    raise("42501", "erp_stock_access_denied");
}

/** erp_stock.negative_allowed */
export const negativeAllowed = (db: SqlDriver) =>
  !!one(db, 'SELECT allow_negative FROM "erp_stock__policy" WHERE singleton=1')?.allow_negative;

/** erp_stock.reserved_quantity */
export function reservedQuantity(db: SqlDriver, product: string, warehouse: string): bigint {
  const row = one(
    db,
    `SELECT CAST(coalesce(sum(i.quantity),0) AS TEXT) q FROM "erp_stock__reservation_item" i JOIN "erp_stock__reservation" r ON r.id=i.reservation_id WHERE r.state='active' AND i.product_id=? AND i.warehouse_id=?`,
    product,
    warehouse,
  );
  return fromColumn(row!.q);
}

/** erp_stock.composition_own_stock */
export const compositionOwnStock = (db: SqlDriver, product: string) =>
  !!one(
    db,
    `SELECT 1 x FROM "erp_stock__composition" c JOIN "erp_catalog__product" p ON p.record_id=c.product_id WHERE c.product_id=? AND p.format='E' AND c.stock_type='physical'`,
    product,
  );

// ---------------------------------------------------------------------------
// Gatilhos das tabelas (camada de tabela)

/** guard_negative_balance_insert (BEFORE INSERT em balance) */
function guardBalanceInsert(db: SqlDriver, quantity: bigint) {
  if (quantity < 0n && !negativeAllowed(db))
    raise("22023", "erp_stock_insufficient_or_excess_quantity");
}

/** protect_reserved_balance (BEFORE UPDATE em balance) */
function guardBalanceUpdate(
  db: SqlDriver,
  product: string,
  warehouse: string,
  oldQuantity: bigint,
  newQuantity: bigint,
) {
  const reserved = reservedQuantity(db, product, warehouse);
  if (reserved > 0n && newQuantity < reserved)
    raise("40001", "erp_stock_reserved_quantity_unavailable");
  // A importação do espelho (erp_sync.stock_import) nunca vale aqui: o motor
  // não importa saldos nesta fase.
  if (newQuantity < 0n && newQuantity < oldQuantity && !negativeAllowed(db))
    raise("22023", "erp_stock_insufficient_or_excess_quantity");
}

/** Insere o saldo se não existir (on conflict do nothing), com a guarda. */
export function ensureBalance(ctx: RpcContext, product: string, warehouse: string, unit: string) {
  const exists = one(
    ctx.db,
    'SELECT 1 x FROM "erp_stock__balance" WHERE product_id=? AND warehouse_id=?',
    product,
    warehouse,
  );
  if (exists) return;
  guardBalanceInsert(ctx.db, 0n);
  ctx.db.exec(
    'INSERT INTO "erp_stock__balance"(product_id, warehouse_id, unit, updated_at) VALUES(?,?,?,?)',
    product,
    warehouse,
    unit,
    ctx.clock.next().toString(),
  );
}

/** UPDATE de balance com a guarda. */
export function updateBalance(
  ctx: RpcContext,
  product: string,
  warehouse: string,
  oldQuantity: bigint,
  delta: bigint,
) {
  guardBalanceUpdate(ctx.db, product, warehouse, oldQuantity, oldQuantity + delta);
  ctx.db.exec(
    'UPDATE "erp_stock__balance" SET quantity=quantity+?, version=version+1, updated_at=? WHERE product_id=? AND warehouse_id=?',
    toParam(delta),
    ctx.clock.next().toString(),
    product,
    warehouse,
  );
}

/** INSERT em entry com as guardas e os gatilhos AFTER (lote e espelho). */
export function insertEntry(
  ctx: RpcContext,
  e: {
    movement: string;
    ordinal: number;
    product: string;
    warehouse: string;
    quantity: bigint;
    unit: string;
    balanceAfter: bigint;
    balanceVersion: number;
  },
) {
  // guard_negative_entry_insert (sem importação do espelho nesta fase)
  if (e.quantity < 0n && e.balanceAfter < 0n && !negativeAllowed(ctx.db))
    raise("22023", "erp_stock_insufficient_or_excess_quantity");
  ctx.db.exec(
    'INSERT INTO "erp_stock__entry"(movement_id, ordinal, product_id, warehouse_id, quantity, unit, balance_after, balance_version) VALUES(?,?,?,?,?,?,?,?)',
    e.movement,
    e.ordinal,
    e.product,
    e.warehouse,
    toParam(e.quantity),
    e.unit,
    toParam(e.balanceAfter),
    e.balanceVersion,
  );
  // reverse_stock_lot_entries: só para estornos (o erp_stock_post recusa).
  const reversal = one(
    ctx.db,
    `SELECT reverses_id FROM "erp_stock__movement" WHERE id=? AND kind='reversal'`,
    e.movement,
  );
  if (reversal?.reverses_id) raise("0A000", "rpc_not_ported:erp_stock.reverse_lot_entries");
  // zz_origin_sync: erp_sync.capture_stock
  sync.enqueue(ctx, "stock", e.movement, "stock", e.ordinal, {
    product_id: e.product,
    warehouse_id: e.warehouse,
  });
}

/** erp_stock.movement_dto */
export function movementDto(db: SqlDriver, id: string) {
  const m = one(
    db,
    'SELECT id, kind, occurred_on, reason, reference, created_at, reverses_id FROM "erp_stock__movement" WHERE id=?',
    id,
  );
  if (!m) return null;
  const reversedBy = one(db, 'SELECT id FROM "erp_stock__movement" WHERE reverses_id=?', id);
  const entries = db.exec(
    'SELECT product_id, warehouse_id, CAST(quantity AS TEXT) quantity, unit, CAST(balance_after AS TEXT) balance_after, balance_version FROM "erp_stock__entry" WHERE movement_id=? ORDER BY ordinal',
    id,
  ).rows;
  return {
    id: m.id,
    kind: m.kind,
    occurred_on: m.occurred_on,
    reason: m.reason,
    reference: m.reference,
    created_at: jsonTimestamp(m.created_at as number),
    reverses_id: m.reverses_id,
    reversed_by: reversedBy?.id ?? null,
    items: entries.length
      ? entries.map((e) => ({
          product_id: e.product_id,
          warehouse_id: e.warehouse_id,
          quantity: formatScaled(fromColumn(e.quantity), QTY),
          unit: e.unit,
          balance_after: formatScaled(fromColumn(e.balance_after), QTY),
          balance_version: e.balance_version,
        }))
      : null,
  };
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export { MAX as QTY_MAX };
