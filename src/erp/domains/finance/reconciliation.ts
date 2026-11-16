// Conciliação bancária (SQL 137, 172 e 212): o DTO da linha do extrato com a
// sugestão, os vínculos, o alvo de um vínculo e os estornos que "Reverter
// conciliação" com Estornar faz (settlement_reverse e transfer_reverse).
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { cmpText, CNTRL, field, insertMovement, keys, txt, updateAccount, uuidValue, writeRow } from "./internal.ts";
import { insertTransfer, insertTransferDeletion, transferAccount } from "./cash.ts";
import { insertSettlement, postSettlementMovements } from "./settlements.ts";
import { left, updateTitle } from "./titles.ts";
import { statementLines } from "./rpc/erp_finance_statement_page.ts";

/** erp_finance.ofx_text */
export function ofxText(data: unknown, key: string, limit: number): string | null {
  const v = txt(data, key, limit);
  if (v !== null && CNTRL.test(v)) raise("22023", "erp_finance_invalid_text");
  return v;
}

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
const contactName = (db: SqlDriver, id: unknown) =>
  id === null || id === undefined ? null : ((one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', id)?.name as string | undefined) ?? null);

/** erp_finance.line_reconciled */
function lineReconciled(db: SqlDriver, kind: string, id: string) {
  const col = kind === "entry" ? "entry_id" : "movement_id";
  return !!one(db, `SELECT 1 x FROM "erp_finance__reconciliation_link" WHERE ${col}=? AND undone_at IS NULL LIMIT 1`, id);
}

/** Linha de lançamento que pode ser vinculada: entry, perna de transferência, ou baixa (pagamento ou tarifa) não estornada. */
function linkable(db: SqlDriver, l: Row) {
  if (!["entry", "transfer", "settlement"].includes(String(l.line_kind))) return false;
  if (lineReconciled(db, String(l.line_kind), String(l.line_id))) return false;
  if (l.line_kind !== "settlement") return true;
  return !!one(
    db,
    `SELECT 1 x FROM "erp_finance__movement" m WHERE m.id=? AND m.kind IN ('payment','bank_fee')
       AND NOT EXISTS(SELECT 1 FROM "erp_finance__settlement" x WHERE x.reverses_id=m.settlement_id)`,
    l.line_id,
  );
}
export { linkable as candidateLine, contactName };

/** erp_finance.reconciliation_link_dto */
function linkDto(db: SqlDriver, k: Row) {
  const posted =
    (one(db, 'SELECT posted_on FROM "erp_finance__cash_entry" WHERE id=?', k.entry_id)?.posted_on as string | undefined) ??
    (one(db, 'SELECT posted_on FROM "erp_finance__movement" WHERE id=?', k.movement_id)?.posted_on as string | undefined) ??
    null;
  const account = one(db, 'SELECT account_id FROM "erp_finance__bank_statement_line" WHERE id=?', k.line_id)?.account_id ?? null;
  const l = statementLines(db, account as string | null, posted, posted, false).find(
    (x) =>
      (k.entry_id !== null && x.line_kind === "entry" && x.entry_id === k.entry_id) || (k.movement_id !== null && x.line_id === k.movement_id),
  );
  if (!l) return null;
  return {
    link_id: k.id,
    kind: k.entry_id !== null ? "entry" : "movement",
    id: k.entry_id ?? k.movement_id,
    line_kind: l.line_kind,
    posted_on: l.posted_on,
    amount_cents: String(l.amount_cents),
    note: l.note,
    contact_name: contactName(db, l.contact_id),
    category_name: l.category_id === null ? null : ((one(db, 'SELECT name FROM "erp_finance__category" WHERE id=?', l.category_id)?.name as string | undefined) ?? null),
    entry_origin: l.entry_origin,
    entry_version: l.entry_version,
    title_kind: l.title_kind,
  };
}

/** erp_finance.bank_line_dto(id, sugestão) */
export function bankLineDto(db: SqlDriver, id: string, suggest: boolean) {
  const b = one(db, 'SELECT * FROM "erp_finance__bank_statement_line" WHERE id=?', id)!;
  const links = db
    .exec('SELECT * FROM "erp_finance__reconciliation_link" WHERE line_id=? AND undone_at IS NULL', id)
    .rows.sort((x, y) => Number(x.created_at) - Number(y.created_at))
    .map((k) => linkDto(db, k));
  let suggestion: Record<string, unknown> | null = null;
  if (suggest && b.state === "pending") {
    const posted = String(b.posted_on);
    const best = statementLines(db, String(b.account_id), addDays(posted, -3), addDays(posted, 3), false)
      .filter((l) => Number(l.amount_cents) === Number(b.amount_cents) && linkable(db, l))
      .filter((l) => {
        const kind = l.line_kind === "entry" ? "entry" : "movement";
        const target = l.line_kind === "entry" ? l.entry_id : l.line_id;
        return !one(db, 'SELECT 1 x FROM "erp_finance__bank_line_dismissal" WHERE line_id=? AND target_kind=? AND target_id=?', b.id, kind, target);
      })
      .sort(
        (x, y) =>
          dayDiff(String(x.posted_on), posted) - dayDiff(String(y.posted_on), posted) ||
          Number(x.created_at) - Number(y.created_at) ||
          cmpText(String(x.line_id), String(y.line_id)),
      )[0];
    if (best)
      suggestion = {
        kind: best.line_kind === "entry" ? "entry" : "movement",
        id: best.line_kind === "entry" ? best.entry_id : best.line_id,
        line_kind: best.line_kind,
        posted_on: best.posted_on,
        amount_cents: String(best.amount_cents),
        note: best.note,
        contact_name: contactName(db, best.contact_id),
      };
  }
  return {
    id: b.id,
    statement_id: b.statement_id,
    account_id: b.account_id,
    fitid: b.fitid,
    posted_on: b.posted_on,
    amount_cents: String(b.amount_cents),
    memo: b.memo,
    trntype: b.trntype,
    state: b.state,
    version: b.version,
    links,
    suggestion,
  };
}

/** erp_finance.reconciliation_target */
function reconciliationTarget(db: SqlDriver, kind: string, id: string) {
  if (kind === "entry") {
    const e = one(db, 'SELECT account_id, kind, amount_cents, deleted_at FROM "erp_finance__cash_entry" WHERE id=?', id);
    if (!e) return null;
    return { account_id: e.account_id, amount: e.kind === "in" ? Number(e.amount_cents) : -Number(e.amount_cents), ok: e.deleted_at === null };
  }
  const m = one(db, 'SELECT id, account_id, delta_cents, transfer_id, settlement_id, kind FROM "erp_finance__movement" WHERE id=?', id);
  if (!m) return null;
  const ok =
    (m.transfer_id !== null &&
      !one(db, 'SELECT 1 x FROM "erp_finance__transfer_deletion" WHERE transfer_id=? OR reversal_id=? LIMIT 1', m.transfer_id, m.transfer_id)) ||
    (m.settlement_id !== null &&
      ["payment", "bank_fee"].includes(String(m.kind)) &&
      !one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE reverses_id=? LIMIT 1', m.settlement_id));
  return { account_id: m.account_id, amount: Number(m.delta_cents), ok };
}

/** erp_finance.reconcile_links: vincula e marca a linha como conciliada; a soma tem de bater. */
export function reconcileLinks(ctx: RpcContext, line: Row, links: unknown, user: string, command: string) {
  const db = ctx.db;
  if (jsonType(links) !== "array" || (links as unknown[]).length < 1 || (links as unknown[]).length > 50) raise("22023", "erp_finance_invalid_items");
  let sum = 0;
  for (const link of links as unknown[]) {
    keys(link, ["kind", "id"]);
    const kind = txt(link, "kind", 20, true)!;
    const id = uuidValue(field(link, "id"))!;
    if (!["entry", "movement"].includes(kind)) raise("22023", "erp_finance_invalid_data");
    const target = reconciliationTarget(db, kind, id);
    if (!target || !target.ok || target.account_id !== line.account_id) raise("22023", "erp_finance_invalid_reconciliation");
    if (lineReconciled(db, kind, id)) raise("40001", "erp_finance_reconciliation_taken");
    db.exec(
      'INSERT INTO "erp_finance__reconciliation_link"(id, line_id, entry_id, movement_id, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      line.id,
      kind === "entry" ? id : null,
      kind === "movement" ? id : null,
      user,
      command,
      ctx.clock.next().toString(),
    );
    sum += target.amount;
  }
  if (sum !== Number(line.amount_cents)) raise("22023", "erp_finance_reconciliation_divergence");
  bumpLine(ctx, String(line.id), { state: "reconciled" });
}

/** UPDATE da linha do extrato com version+1. */
export function bumpLine(ctx: RpcContext, id: string, set: Record<string, unknown>) {
  const v = Number(one(ctx.db, 'SELECT version FROM "erp_finance__bank_statement_line" WHERE id=?', id)!.version);
  writeRow(ctx, "erp_finance__bank_statement_line", "id", id, { ...set, version: v + 1, updated_at: ctx.clock.next().toString() });
}

/** erp_finance.settlement_reverse: o estorno do 010 na data da baixa (null se já estornada). */
export function settlementReverse(ctx: RpcContext, settlement: string, user: string, command: string, note: string) {
  const db = ctx.db;
  const s = one(db, 'SELECT * FROM "erp_finance__settlement" WHERE id=?', settlement);
  if (!s || s.kind !== "payment") raise("40001", "erp_finance_reversal_conflict");
  if (one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE reverses_id=? LIMIT 1', s.id)) return null;
  const t = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', s.title_id)!;
  const id = insertSettlement(ctx, {
    title_id: String(t.id),
    account_id: String(s.account_id),
    kind: "reversal",
    reverses_id: String(s.id),
    posted_on: String(s.posted_on),
    principal_cents: Number(s.principal_cents),
    interest_cents: Number(s.interest_cents),
    penalty_cents: Number(s.penalty_cents),
    discount_cents: Number(s.discount_cents),
    fee_cents: Number(s.fee_cents),
    net_cash_cents: Number(s.net_cash_cents),
    note: left(note, 500),
    actor: user,
    command_id: command,
  });
  const fresh = one(db, 'SELECT settled_cents, version FROM "erp_finance__title" WHERE id=?', t.id)!;
  updateTitle(ctx, String(t.id), {
    settled_cents: Number(fresh.settled_cents) - Number(s.principal_cents),
    version: Number(fresh.version) + 1,
    updated_at: ctx.clock.next().toString(),
  });
  postSettlementMovements(ctx, id, t.kind === "receivable" ? -Number(s.net_cash_cents) : Number(s.net_cash_cents));
  updateAccount(ctx, String(s.account_id), {});
  return id;
}

/**
 * erp_finance.transfer_reverse: a transferência inversa nas datas das pernas
 * originais (null se já excluída). O recibo precisa estar reservado
 * (reserveCommand): transfer.command_id é FK adiada no Postgres.
 */
export function transferReverse(ctx: RpcContext, transferId: string, user: string, command: string, note: string) {
  const db = ctx.db;
  const t = one(db, 'SELECT * FROM "erp_finance__transfer" WHERE id=?', transferId);
  if (!t) raise("P0002", "erp_finance_not_found");
  if (one(db, 'SELECT 1 x FROM "erp_finance__transfer_deletion" WHERE transfer_id=? OR reversal_id=? LIMIT 1', t.id, t.id)) return null;
  const from = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', t.to_account_id)!;
  const to = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', t.from_account_id)!;
  if (from.deleted_at !== null || to.deleted_at !== null) raise("22023", "erp_finance_invalid_account");
  const ca = transferAccount(db, String(from.id))!;
  const cb = transferAccount(db, String(to.id))!;
  const amount = Number(t.amount_cents);
  const snapshot = (acc: Row, snap: Record<string, unknown>, delta: number) => ({
    id: acc.id, name: acc.name, kind: acc.kind, version_before: acc.version, version_after: Number(acc.version) + 1,
    balance_before_cents: snap.balance_cents, balance_after_cents: String(Number(snap.balance_cents) + delta), opening_on: snap.opening_on,
  });
  const outDay = String(t.in_posted_on ?? t.posted_on);
  const reversal = insertTransfer(ctx, {
    id: crypto.randomUUID(), command_id: command, actor: user, from_account_id: from.id, to_account_id: to.id, amount_cents: amount, posted_on: outDay, note: t.note,
    from_snapshot: snapshot(from, ca, -amount), to_snapshot: snapshot(to, cb, amount), in_posted_on: t.in_posted_on !== null ? t.posted_on : null, float_days: 0,
  });
  const categoryOf = (kind: string) =>
    (one(db, 'SELECT category_id FROM "erp_finance__movement" WHERE transfer_id=? AND kind=?', t.id, kind)?.category_id ?? null) as string | null;
  const inCat = categoryOf("transfer_in"),
    outCat = categoryOf("transfer_out");
  insertMovement(ctx, { account_id: String(from.id), kind: "transfer_out", delta_cents: -amount, posted_on: outDay, note: String(t.note), actor: user, command_id: command, transfer_id: reversal, category_id: inCat });
  insertMovement(ctx, { account_id: String(to.id), kind: "transfer_in", delta_cents: amount, posted_on: String(t.posted_on), note: String(t.note), actor: user, command_id: command, transfer_id: reversal, category_id: outCat });
  insertTransferDeletion(ctx, { transfer_id: String(t.id), reversal_id: reversal, actor: user, command_id: command, note: left(note, 500) });
  for (const acc of [String(from.id), String(to.id)]) updateAccount(ctx, acc, {});
  return reversal;
}
