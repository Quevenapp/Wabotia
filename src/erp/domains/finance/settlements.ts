// Financeiro: baixas e estornos (erp_finance.settlement) e a camada de tabela
// da baixa: reconciled_settlement_guard (antes), settlement_bordero e
// settlement_capture_categories (depois), settlement_posting_check (adiado),
// zz_origin_sync; e erp_finance.post_settlement_movements (o movimento da
// baixa, ou o principal e a tarifa de um plano CNAB).
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { assertSettlementPostings, captureFinance, cnabPlanForSettlement, defer, flag, insertMovement } from "./internal.ts";

export interface SettlementInput {
  title_id: string;
  account_id: string;
  kind: "payment" | "reversal";
  reverses_id?: string | null;
  posted_on: string;
  principal_cents: number;
  interest_cents: number;
  penalty_cents: number;
  discount_cents: number;
  fee_cents: number;
  net_cash_cents: number;
  note: string | null;
  actor: string;
  command_id: string;
  history?: string | null;
}

/** INSERT em settlement com os gatilhos. Devolve o id. */
export function insertSettlement(ctx: RpcContext, s: SettlementInput) {
  const db = ctx.db;
  // reconciled_settlement_guard (BEFORE INSERT)
  if (
    s.kind === "reversal" &&
    one(
      db,
      `SELECT 1 x FROM "erp_finance__reconciliation_link" l JOIN "erp_finance__movement" m ON m.id=l.movement_id WHERE m.settlement_id=? AND l.undone_at IS NULL LIMIT 1`,
      s.reverses_id ?? null,
    )
  )
    raise("40001", "erp_finance_settlement_reconciled");
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_finance__settlement"(id, title_id, account_id, kind, reverses_id, posted_on, principal_cents, interest_cents, penalty_cents, discount_cents, fee_cents, net_cash_cents, note, actor, command_id, created_at, history) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    s.title_id,
    s.account_id,
    s.kind,
    s.reverses_id ?? null,
    s.posted_on,
    s.principal_cents,
    s.interest_cents,
    s.penalty_cents,
    s.discount_cents,
    s.fee_cents,
    s.net_cash_cents,
    s.note,
    s.actor,
    s.command_id,
    ctx.clock.next().toString(),
    s.history ?? null,
  );
  // AFTER INSERT, na ordem do Postgres (nome do gatilho)
  settlementBordero(ctx, id, s);
  settlementCaptureCategories(ctx, id, s);
  defer(ctx, () => assertSettlementPostings(db, id));
  captureFinance(ctx, "settlement", id);
  return id;
}

/** settlement_bordero: a baixa entra no borderô da operação (ou num borderô novo). */
function settlementBordero(ctx: RpcContext, id: string, s: SettlementInput) {
  if (s.kind !== "payment") return;
  let bordero = flag(ctx, "erp_finance.bordero_id") || null;
  const category = flag(ctx, "erp_finance.bordero_category") || null;
  if (bordero === null) {
    const kind = one(ctx.db, 'SELECT kind FROM "erp_finance__title" WHERE id=?', s.title_id)!.kind;
    bordero = insertBordero(ctx, { kind: String(kind), posted_on: s.posted_on, account_id: s.account_id, note: s.note, actor: s.actor, command_id: s.command_id });
  }
  ctx.db.exec(
    'INSERT INTO "erp_finance__bordero_item"(settlement_id, bordero_id, category_id) VALUES(?,?,?)',
    id,
    bordero.toLowerCase(),
    category === null ? null : category.toLowerCase(),
  );
}

/** INSERT em bordero (sem gatilhos de inserção). Devolve o id. */
export function insertBordero(
  ctx: RpcContext,
  b: { kind: string; posted_on: string; account_id: string; note: string | null; actor: string; command_id: string; category_id?: string | null; grouped?: boolean },
) {
  const id = crypto.randomUUID();
  ctx.db.exec(
    `INSERT INTO "erp_finance__bordero"(id, kind, posted_on, account_id, category_id, note, grouped, version, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)`,
    id,
    b.kind,
    b.posted_on,
    b.account_id,
    b.category_id ?? null,
    b.note,
    b.grouped ? 1 : 0,
    b.actor,
    b.command_id,
    ctx.clock.next().toString(),
  );
  return id;
}

/** settlement_capture_categories: as categorias padrão de juros, acréscimos, descontos e tarifa. */
function settlementCaptureCategories(ctx: RpcContext, id: string, s: SettlementInput) {
  if (s.kind !== "payment" || s.interest_cents + s.penalty_cents + s.discount_cents + s.fee_cents === 0) return;
  const kind = one(ctx.db, 'SELECT kind FROM "erp_finance__title" WHERE id=?', s.title_id)!.kind;
  const d = Object.fromEntries(
    ctx.db
      .exec('SELECT key, category_id FROM "erp_finance__category_default" WHERE category_id IS NOT NULL')
      .rows.map((r) => [String(r.key), String(r.category_id)]),
  );
  const pick = (cond: boolean, key: string) => (cond ? (d[key] ?? null) : null);
  const receivable = kind === "receivable";
  ctx.db.exec(
    'INSERT INTO "erp_finance__settlement_category"(settlement_id, interest_category_id, penalty_category_id, discount_category_id, fee_category_id, created_at) VALUES(?,?,?,?,?,?)',
    id,
    pick(s.interest_cents > 0, receivable ? "receipt_interest" : "payment_interest"),
    pick(s.penalty_cents > 0, receivable ? "receipt_additions" : "payment_additions"),
    pick(s.discount_cents > 0, receivable ? "receipt_discounts" : "payment_discounts"),
    pick(s.fee_cents > 0, receivable ? "receipt_fees" : "payment_additions"),
    ctx.clock.next().toString(),
  );
}

/** erp_finance.post_settlement_movements */
export function postSettlementMovements(ctx: RpcContext, settlement: string, delta: number) {
  const s = one(
    ctx.db,
    'SELECT id, account_id, kind, posted_on, note, actor, command_id FROM "erp_finance__settlement" WHERE id=?',
    settlement,
  )!;
  const plan = cnabPlanForSettlement(ctx.db, settlement);
  const base = {
    account_id: String(s.account_id),
    settlement_id: settlement,
    posted_on: String(s.posted_on),
    note: s.note as string | null,
    actor: String(s.actor),
    command_id: String(s.command_id),
  };
  if (!plan || plan.command_id === null) {
    insertMovement(ctx, { ...base, kind: String(s.kind), delta_cents: delta });
    return;
  }
  const direction = s.kind === "payment" ? 1 : -1;
  if (delta !== direction * Number(plan.net_cash_cents)) raise("22023", "erp_finance_cnab_posting_invalid");
  insertMovement(ctx, { ...base, kind: String(s.kind), delta_cents: direction * Number(plan.principal_cents) });
  insertMovement(ctx, {
    ...base,
    kind: s.kind === "payment" ? "bank_fee" : "bank_fee_reversal",
    delta_cents: -direction * Number(plan.fee_cents),
  });
}

export { assertSettlementPostings };
