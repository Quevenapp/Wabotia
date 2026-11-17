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
import * as preferences from "../preferences/public.ts";
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
  // reverse_stock_lot_entries: o estorno devolve as linhas de lote do lançamento.
  const reversal = one(
    ctx.db,
    `SELECT reverses_id FROM "erp_stock__movement" WHERE id=? AND kind='reversal'`,
    e.movement,
  );
  if (reversal?.reverses_id) {
    const lots = ctx.db.exec(
      'SELECT lot_id, CAST(quantity AS TEXT) q FROM "erp_stock__lot_entry" WHERE movement_id=? AND product_id=? AND warehouse_id=? ORDER BY lot_id',
      reversal.reverses_id,
      e.product,
      e.warehouse,
    ).rows;
    for (const l of lots) lotApply(ctx, e.movement, e.product, e.warehouse, String(l.lot_id), -fromColumn(l.q));
  }
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

/**
 * erp_stock.lot_apply: soma a quantidade ao saldo do lote no depósito e grava
 * a linha do lote (com a guarda guard_lot_entry). O lote nunca fica negativo.
 */
export function lotApply(ctx: RpcContext, movement: string, product: string, warehouse: string, lot: string, quantity: bigint) {
  const db = ctx.db;
  if (!one(db, 'SELECT 1 x FROM "erp_stock__lot_balance" WHERE lot_id=? AND warehouse_id=?', lot, warehouse))
    db.exec('INSERT INTO "erp_stock__lot_balance"(lot_id, warehouse_id, updated_at) VALUES(?,?,?)', lot, warehouse, ctx.clock.next().toString());
  const b = one(db, 'SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__lot_balance" WHERE lot_id=? AND warehouse_id=?', lot, warehouse)!;
  const after = fromColumn(b.q) + quantity;
  if (after < 0n) raise("22023", "erp_stock_lot_insufficient");
  if (after > MAX || b.version === 2147483647) raise("22023", "erp_stock_insufficient_or_excess_quantity");
  db.exec(
    'UPDATE "erp_stock__lot_balance" SET quantity=quantity+?, version=version+1, updated_at=? WHERE lot_id=? AND warehouse_id=?',
    toParam(quantity),
    ctx.clock.next().toString(),
    lot,
    warehouse,
  );
  guardLotEntry(db, movement, product, warehouse, lot, quantity);
  db.exec(
    'INSERT INTO "erp_stock__lot_entry"(movement_id, product_id, warehouse_id, lot_id, quantity, balance_after, created_at) VALUES(?,?,?,?,?,?,?)',
    movement,
    product,
    warehouse,
    lot,
    toParam(quantity),
    toParam(after),
    ctx.clock.next().toString(),
  );
  return { warehouse_id: warehouse, quantity: formatScaled(quantity, QTY), balance_after: formatScaled(after, QTY) };
}

/** erp_stock.guard_lot_entry (BEFORE INSERT de lot_entry; UPDATE/DELETE: gatilho gerado). */
function guardLotEntry(db: SqlDriver, movement: string, product: string, warehouse: string, lot: string, quantity: bigint) {
  const line = one(db, 'SELECT CAST(quantity AS TEXT) q FROM "erp_stock__entry" WHERE movement_id=? AND product_id=? AND warehouse_id=?', movement, product, warehouse);
  const split =
    fromColumn(
      one(db, 'SELECT CAST(coalesce(sum(quantity),0) AS TEXT) q FROM "erp_stock__lot_entry" WHERE movement_id=? AND product_id=? AND warehouse_id=?', movement, product, warehouse)!.q,
    ) + quantity;
  const sign = (v: bigint) => (v > 0n ? 1 : v < 0n ? -1 : 0);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const v = line ? fromColumn(line.q) : null;
  if (v === null || sign(v) !== sign(quantity) || abs(split) > abs(v) || !one(db, 'SELECT 1 x FROM "erp_stock__lot" WHERE id=? AND product_id=?', lot, product))
    raise("22023", "erp_stock_lot_entry_invalid");
}

/**
 * erp_stock.balance_kept: com "estorno de lançamento anterior ao balanço"
 * desligado, a posição contada depois do lançamento mantém o saldo no estorno.
 */
export function balanceKept(db: SqlDriver, movement: string, product: string, warehouse: string): boolean {
  if (preferences.get(db, "estoque.estorno_balanco") !== false) return false;
  if (one(db, `SELECT 1 x FROM "erp_stock__movement" WHERE id=? AND kind='reversal'`, movement)) return false;
  return !!one(
    db,
    `SELECT 1 x FROM "erp_stock__balance_count" c JOIN "erp_stock__movement" b ON b.id=c.movement_id JOIN "erp_stock__movement" o ON o.id=?
      WHERE c.product_id=? AND c.warehouse_id=? AND b.created_at>o.created_at AND NOT EXISTS(SELECT 1 FROM "erp_stock__movement" x WHERE x.reverses_id=b.id)`,
    movement,
    product,
    warehouse,
  );
}

/** md5 → uuid no formato das derivações do Estoque (versão 4, variante 8). */
function md5Uuid(text: string): string {
  const h = createHash("md5").update(text, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** erp_stock.derived_command(p_command, p_part): id determinístico dos ajustes de compensação do estorno. */
export const derivedCommand = (command: string, part: string) => md5Uuid(`stock-reverse-balance-145:${part}:${command}`);
/** erp_stock.supply_part(p_command, p_part): id determinístico dos comandos derivados de suprimentos (183). */
export const supplyPart = (command: string, part: string) => md5Uuid(`stock-supply-183:${part}:${command}`);

/**
 * INSERT em erp_stock.balance_count com a guarda guard_balance_count: o
 * movimento é um ajuste de um só lançamento, com a diferença contada.
 */
export function insertBalanceCount(
  ctx: RpcContext,
  movement: string,
  product: string,
  warehouse: string,
  counted: bigint,
  previous: bigint,
  source: "launch" | "count",
) {
  const db = ctx.db;
  const e = db.exec('SELECT product_id, warehouse_id, CAST(quantity AS TEXT) q, CAST(balance_after AS TEXT) after FROM "erp_stock__entry" WHERE movement_id=?', movement).rows;
  if (
    !one(db, `SELECT 1 x FROM "erp_stock__movement" WHERE id=? AND kind='adjustment'`, movement) || e.length !== 1 ||
    e[0].product_id !== product || e[0].warehouse_id !== warehouse || fromColumn(e[0].q) !== counted - previous || fromColumn(e[0].after) !== counted
  )
    raise("22023", "erp_stock_balance_count_invalid");
  db.exec(
    'INSERT INTO "erp_stock__balance_count"(movement_id, product_id, warehouse_id, counted, previous, source, created_at) VALUES(?,?,?,?,?,?,?)',
    movement, product, warehouse, toParam(counted), toParam(previous), source, ctx.clock.next().toString(),
  );
}

/** erp_stock.reservation_write_access: a linha do usuário (for share, sem efeito no SQLite) e o acesso de escrita. */
export function reservationWriteAccess(db: SqlDriver, user: string) {
  requireAccess(db, user, true);
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * erp_stock.command_taken: o id de comando já foi usado em alguma tabela de
 * comando do Estoque (ou dos recebimentos). O opening_command sai com o
 * Origin, mas a tabela continua no esquema.
 */
const COMMAND_TABLES = [
  "erp_stock__command", "erp_stock__document_command", "erp_stock__reservation_command", "erp_purchase_receipts__command",
  "erp_stock__policy_command", "erp_stock__opening_command", "erp_stock__warehouse_command", "erp_stock__ledger_command",
  "erp_stock__count_command", "erp_stock__dashboard_command", "erp_stock__checkin_command", "erp_stock__supply_command",
  "erp_stock__composition_command", "erp_stock__lot_command", "erp_stock__invoice_command", "erp_stock__item_component_command",
  "erp_stock__unit_conversion_command",
];
export const commandTaken = (db: SqlDriver, id: string) =>
  !!one(db, COMMAND_TABLES.map((t) => `SELECT 1 x FROM "${t}" WHERE id=?`).join(" UNION ALL ") + " LIMIT 1", ...COMMAND_TABLES.map(() => id));
export { MAX as QTY_MAX };
