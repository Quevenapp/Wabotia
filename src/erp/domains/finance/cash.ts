// Financeiro: Caixas e bancos (registros de caixa e transferências) e a camada
// de tabela de cash_entry (reconciled_entry_guard, owned_entry_guard),
// transfer (transfer_pair_check adiado) e transfer_deletion
// (reconciled_transfer_guard).
import { one, type Row, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import {
  bool,
  categorySiblingTaken,
  cmpText,
  defer,
  flag,
  insertCategory,
  insertMovement,
  pgLower,
  ts,
  txt,
  uuidValue,
  writeRow,
} from "./internal.ts";
import { left } from "./titles.ts";

/** erp_finance.cash_text: texto sem controles (aceita \t, \n e \r). */
export function cashText(data: unknown, key: string, limit: number, required: boolean) {
  const v = txt(data, key, limit, required);
  if (v !== null && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) raise("22023", "erp_finance_invalid_text");
  return v;
}

/** erp_finance.cash_contact */
export function cashContact(db: SqlDriver, value: unknown) {
  const v = uuidValue(value, false);
  if (v === null) return null;
  if (!one(db, 'SELECT 1 x FROM "erp_catalog__contact" c JOIN "erp_catalog__record" r ON r.id=c.record_id WHERE c.record_id=? AND r.active=1', v))
    raise("22023", "erp_finance_invalid_contact");
  return v;
}

/** erp_finance.cash_category */
export function cashCategory(db: SqlDriver, value: unknown, kind: string | null) {
  const v = uuidValue(value, false);
  if (v === null) return null;
  if (!one(db, 'SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND deleted_at IS NULL AND (? IS NULL OR kind=?)', v, kind, kind))
    raise("22023", "erp_finance_invalid_category");
  return v;
}

/** erp_finance.cash_account: conta ativa e não excluída. */
export function cashAccount(db: SqlDriver, id: string): Row {
  const v = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', id);
  if (!v || v.deleted_at !== null || !bool(v.active)) raise("22023", "erp_finance_invalid_account");
  return v;
}

/** O movimento ativo de um registro de caixa (o último 'entry' sem compensação). */
export const activeEntryMovement = (db: SqlDriver, entry: string) =>
  one(
    db,
    `SELECT * FROM "erp_finance__movement" x WHERE x.entry_id=? AND x.kind='entry'
       AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" c WHERE c.compensates_id=x.id) ORDER BY x.created_at DESC LIMIT 1`,
    entry,
  );

/** erp_finance.cash_post: o movimento do registro de caixa. */
export function cashPost(ctx: RpcContext, entry: Row, category: string | null, user: string, command: string) {
  if (one(ctx.db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND kind='opening' AND posted_on>? LIMIT 1`, entry.account_id, entry.posted_on))
    raise("22023", "erp_finance_payment_before_opening");
  insertMovement(ctx, {
    account_id: String(entry.account_id),
    entry_id: String(entry.id),
    kind: "entry",
    delta_cents: entry.kind === "in" ? Number(entry.amount_cents) : -Number(entry.amount_cents),
    posted_on: String(entry.posted_on),
    note: left(String(entry.note), 500),
    actor: user,
    command_id: command,
    category_id: category,
  });
}

/** erp_finance.cash_compensate: estorna o movimento ativo na mesma data. */
export function cashCompensate(ctx: RpcContext, entry: string, user: string, command: string) {
  const m = activeEntryMovement(ctx.db, entry);
  if (!m) raise("40001", "erp_finance_entry_state");
  insertMovement(ctx, {
    account_id: String(m.account_id),
    entry_id: String(m.entry_id),
    compensates_id: String(m.id),
    kind: "entry_reversal",
    delta_cents: -Number(m.delta_cents),
    posted_on: String(m.posted_on),
    note: m.note as string | null,
    actor: user,
    command_id: command,
    category_id: m.category_id as string | null,
  });
  return m.category_id as string | null;
}

/** erp_finance.cash_entry_view */
export function cashEntryView(db: SqlDriver, id: string) {
  const e = one(
    db,
    `SELECT e.*, a.name account_name, r.name contact_name FROM "erp_finance__cash_entry" e JOIN "erp_finance__account" a ON a.id=e.account_id
       LEFT JOIN "erp_catalog__record" r ON r.id=e.contact_id WHERE e.id=?`,
    id,
  );
  if (!e) return null;
  const m = activeEntryMovement(db, id);
  const category = m?.category_id ? one(db, 'SELECT name FROM "erp_finance__category" WHERE id=?', m.category_id) : null;
  return {
    id: e.id,
    account_id: e.account_id,
    account_name: e.account_name,
    kind: e.kind,
    amount_cents: String(e.amount_cents),
    posted_on: e.posted_on,
    competence_on: e.competence_on,
    category_id: m?.category_id ?? null,
    category_name: category?.name ?? null,
    contact_id: e.contact_id,
    contact_name: e.contact_name ?? null,
    note: e.note,
    origin: e.origin,
    version: e.version,
    deleted: e.deleted_at !== null,
    created_at: ts(e.created_at),
    updated_at: ts(e.updated_at),
  };
}

/** erp_finance.find_or_create_category: categoria principal pelo nome (cria na primeira vez). */
export function findOrCreateCategory(ctx: RpcContext, name: string, kind: string) {
  const target = pgLower(name);
  const found = ctx.db
    .exec('SELECT id, name, active FROM "erp_finance__category" WHERE kind=? AND parent_id IS NULL AND deleted_at IS NULL', kind)
    .rows.filter((r) => pgLower(String(r.name)) === target)
    .sort((x, y) => Number(bool(y.active)) - Number(bool(x.active)) || cmpText(String(x.id), String(y.id)));
  if (found.length) return String(found[0].id);
  void categorySiblingTaken;
  return insertCategory(ctx, { name, kind, parent_id: null, dre_group: null });
}

/** erp_finance.transfer_account: retrato da conta para o histórico da transferência. */
export function transferAccount(db: SqlDriver, id: string) {
  const a = one(db, 'SELECT id, name, kind, active, opening_recorded, version FROM "erp_finance__account" WHERE id=?', id);
  if (!a) return null;
  const balance = one(db, 'SELECT CAST(coalesce(sum(delta_cents),0) AS TEXT) b FROM "erp_finance__movement" WHERE account_id=?', id)!.b;
  const openings = db.exec(`SELECT posted_on FROM "erp_finance__movement" WHERE account_id=? AND kind='opening'`, id).rows;
  if (openings.length > 1) raise("21000", "more than one row returned by a subquery used as an expression");
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    active: bool(a.active),
    opening_recorded: bool(a.opening_recorded),
    version: a.version,
    balance_cents: String(balance),
    opening_on: openings[0]?.posted_on ?? null,
  };
}

// ---------------------------------------------------------------------------
// Camada de tabela

const ENTRY_COLS = ["id", "account_id", "kind", "amount_cents", "posted_on", "competence_on", "contact_id", "note", "origin", "source_key", "version", "actor", "command_id", "created_at", "updated_at"];

/** INSERT em cash_entry. Devolve a linha gravada. */
export function insertCashEntry(ctx: RpcContext, e: Record<string, unknown>): Row {
  const now = ctx.clock.next().toString();
  const row: Row = { id: crypto.randomUUID(), contact_id: null, source_key: null, version: 1, created_at: now, updated_at: now, ...e };
  ctx.db.exec(
    `INSERT INTO "erp_finance__cash_entry"(${ENTRY_COLS.map((c) => `"${c}"`).join(", ")}) VALUES(${ENTRY_COLS.map(() => "?").join(",")})`,
    ...ENTRY_COLS.map((c) => row[c] ?? null),
  );
  return one(ctx.db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', row.id)!;
}

/** UPDATE de cash_entry com reconciled_entry_guard e owned_entry_guard. Devolve a linha nova. */
export function updateCashEntry(ctx: RpcContext, id: string, set: Record<string, unknown>): Row {
  const db = ctx.db;
  const old = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', id)!;
  const next = { ...old, ...set };
  const core = (r: Row) => [r.account_id, r.kind, Number(r.amount_cents), r.posted_on, r.deleted_at === null];
  const changed = (a: unknown[], b: unknown[]) => a.some((v, i) => v !== b[i]);
  if (changed(core(next), core(old)) && one(db, 'SELECT 1 x FROM "erp_finance__reconciliation_link" WHERE entry_id=? AND undone_at IS NULL LIMIT 1', id))
    raise("40001", "erp_finance_entry_reconciled");
  if (
    ["commission", "cash_session"].includes(String(old.origin)) &&
    flag(ctx, "erp_finance.commission_owner") !== "on" &&
    flag(ctx, "erp_finance.owned_writer") !== "on" &&
    changed([...core(next), next.note], [...core(old), old.note])
  )
    raise("40001", "erp_finance_entry_owned");
  writeRow(ctx, "erp_finance__cash_entry", "id", id, set);
  return one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', id)!;
}

/** INSERT em transfer com o transfer_pair_check adiado. */
export function insertTransfer(ctx: RpcContext, t: Record<string, unknown>) {
  const id = (t.id as string) ?? crypto.randomUUID();
  ctx.db.exec(
    `INSERT INTO "erp_finance__transfer"(id, command_id, actor, from_account_id, to_account_id, amount_cents, posted_on, note, from_snapshot, to_snapshot, created_at, in_posted_on, float_days) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    t.command_id,
    t.actor,
    t.from_account_id,
    t.to_account_id,
    t.amount_cents,
    t.posted_on,
    t.note,
    JSON.stringify(t.from_snapshot),
    JSON.stringify(t.to_snapshot),
    ctx.clock.next().toString(),
    t.in_posted_on ?? null,
    t.float_days ?? 0,
  );
  defer(ctx, () => {
    if (Number(one(ctx.db, 'SELECT count(*) n FROM "erp_finance__movement" WHERE transfer_id=?', id)!.n) !== 2)
      raise("22023", "erp_finance_transfer_incomplete");
  });
  return id;
}

/** INSERT em transfer_deletion com o reconciled_transfer_guard. */
export function insertTransferDeletion(ctx: RpcContext, d: { transfer_id: string; reversal_id: string; actor: string; command_id: string; note: string | null }) {
  if (
    one(
      ctx.db,
      `SELECT 1 x FROM "erp_finance__reconciliation_link" l JOIN "erp_finance__movement" m ON m.id=l.movement_id WHERE m.transfer_id=? AND l.undone_at IS NULL LIMIT 1`,
      d.transfer_id,
    )
  )
    raise("40001", "erp_finance_transfer_reconciled");
  ctx.db.exec(
    'INSERT INTO "erp_finance__transfer_deletion"(transfer_id, reversal_id, actor, command_id, note, created_at) VALUES(?,?,?,?,?,?)',
    d.transfer_id,
    d.reversal_id,
    d.actor,
    d.command_id,
    d.note,
    ctx.clock.next().toString(),
  );
}
