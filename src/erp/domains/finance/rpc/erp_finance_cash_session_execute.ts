// public.erp_finance_cash_session_execute (Controle de caixa: abrir, salvar
// valores e conferido, fechar, reabrir, sangria e suprimento, excluir),
// erp_finance_cash_session_get e erp_finance_cash_session_page.
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { dateArgError, todaySaoPaulo } from "../../../engine/time.ts";
import { actorLabel } from "../../access/public.ts";
import {
  argOr,
  bool,
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  expected,
  field,
  flushDeferred,
  hasKey,
  insertAudit,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  setFlag,
  ts,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import { cashAccount, cashCompensate, cashPost, cashText, insertCashEntry, updateCashEntry } from "../cash.ts";
import { left } from "../titles.ts";

const ACTIONS = ["session_open", "session_save", "session_close", "session_reopen", "session_move", "session_move_delete", "session_delete"];

/** erp_finance.cash_session_view(id, linhas) */
export function cashSessionView(db: SqlDriver, id: string, withLines: boolean) {
  const s = one(db, 'SELECT s.*, a.name account_name FROM "erp_finance__cash_session" s JOIN "erp_finance__account" a ON a.id=s.account_id WHERE s.id=?', id);
  if (!s) return null;
  const moves = db.exec('SELECT * FROM "erp_finance__cash_session_move" WHERE session_id=? AND deleted_at IS NULL', id).rows;
  const supplies = moves.filter((m) => m.kind === "supply").reduce((t, m) => t + Number(m.amount_cents), 0);
  const withdrawals = moves.filter((m) => m.kind === "withdrawal").reduce((t, m) => t + Number(m.amount_cents), 0);
  const informed = db
    .exec('SELECT payment_method_id, sum(amount_cents) amount FROM "erp_finance__cash_session_value" WHERE session_id=? GROUP BY payment_method_id', id)
    .rows;
  const base: Record<string, unknown> = {
    id: s.id,
    account_id: s.account_id,
    account_name: left(String(s.account_name), 200),
    operator_id: s.operator_id,
    operator_name: actorLabel(db, String(s.operator_id)),
    opened_at: ts(s.opened_at),
    opened_on: s.opened_on,
    previous_change_cents: String(s.previous_change_cents),
    change_cents: String(s.change_cents),
    state: s.state,
    closed_by_name: s.closed_by === null ? null : actorLabel(db, String(s.closed_by)),
    closed_at: ts(s.closed_at),
    checked: bool(s.checked),
    supply_cents: String(supplies),
    withdrawal_cents: String(withdrawals),
    expected_cash_cents: String(Number(s.change_cents) + supplies - withdrawals),
    informed_cents: String(informed.reduce((t, i) => t + Number(i.amount), 0)),
    version: s.version,
    created_at: ts(s.created_at),
  };
  if (!withLines) return base;
  const values = db
    .exec(
      'SELECT v.payment_method_id, f.description, v.amount_cents, v.position FROM "erp_finance__cash_session_value" v JOIN "erp_catalog__payment_method" f ON f.id=v.payment_method_id WHERE v.session_id=? ORDER BY v.position',
      id,
    )
    .rows.map((v) => ({ payment_method_id: v.payment_method_id, payment_method_name: left(String(v.description), 100), amount_cents: String(v.amount_cents) }));
  const methods = informed
    .map((i) => ({ id: i.payment_method_id, amount: i.amount, f: one(db, 'SELECT description FROM "erp_catalog__payment_method" WHERE id=?', i.payment_method_id) }))
    .filter((i) => i.f)
    .sort(
      (x, y) =>
        cmpText(pgLower(String(x.f!.description)), pgLower(String(y.f!.description))) ||
        cmpText(String(x.id), String(y.id)),
    )
    .map((i) => ({
      payment_method_id: i.id,
      name: left(String(i.f!.description), 100),
      registered_cents: "0",
      informed_cents: String(i.amount),
      difference_cents: String(i.amount),
    }));
  const moveList = [...moves]
    .sort((x, y) => Number(x.created_at) - Number(y.created_at) || cmpText(String(x.id), String(y.id)))
    .map((m) => ({ id: m.id, kind: m.kind, posted_on: m.posted_on, note: m.note, amount_cents: String(m.amount_cents), created_at: ts(m.created_at) }));
  return { ...base, values, methods, moves: moveList };
}

/** erp_finance.cash_session_values: troca os valores informados. */
function cashSessionValues(ctx: RpcContext, session: string, values: unknown) {
  if (jsonType(values) !== "array" || (values as unknown[]).length > 50) raise("22023", "erp_finance_invalid_items");
  ctx.db.exec('DELETE FROM "erp_finance__cash_session_value" WHERE session_id=?', session);
  let n = 0;
  for (const item of values as unknown[]) {
    keys(item, ["payment_method_id", "amount_cents"]);
    n++;
    const method = uuidValue(field(item, "payment_method_id"))!;
    if (!one(ctx.db, 'SELECT 1 x FROM "erp_catalog__payment_method" WHERE id=? AND deleted_at IS NULL', method))
      raise("22023", "erp_finance_invalid_payment_method");
    ctx.db.exec(
      'INSERT INTO "erp_finance__cash_session_value"(session_id, position, payment_method_id, amount_cents) VALUES(?,?,?,?)',
      session,
      n,
      method,
      cents(field(item, "amount_cents")),
    );
  }
}

export function erpFinanceCashSessionExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  const today = todaySaoPaulo();

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 16384) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let id: string;
  let before: unknown = null;
  if (action === "session_open") {
    // Abrir Caixa: conta do tipo Caixa e o Troco; um caixa aberto por operador em cada conta.
    keys(data, ["account_id", "change_cents"]);
    const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
    if (account.kind !== "cash") raise("22023", "erp_finance_invalid_account");
    if (one(db, `SELECT 1 x FROM "erp_finance__cash_session" WHERE account_id=? AND operator_id=? AND state='open' AND deleted_at IS NULL LIMIT 1`, account.id, user))
      raise("40001", "erp_finance_cash_session_open");
    const previous = one(
      db,
      'SELECT change_cents FROM "erp_finance__cash_session" s WHERE s.account_id=? AND s.deleted_at IS NULL ORDER BY s.opened_at DESC, s.id DESC LIMIT 1',
      account.id,
    );
    const change = cents(field(data, "change_cents"));
    id = crypto.randomUUID();
    const now = ctx.clock.next().toString();
    db.exec(
      `INSERT INTO "erp_finance__cash_session"(id, account_id, operator_id, opened_at, opened_on, previous_change_cents, change_cents, state, checked, version, command_id, created_at) VALUES(?,?,?,?,?,?,?, 'open', 0, 1, ?, ?)`,
      id, account.id, user, now, today, Number(previous?.change_cents ?? 0), change, command, now,
    );
  } else {
    keys(
      data,
      action === "session_save" ? ["id", "expected_version", "values", "checked"]
        : action === "session_close" ? ["id", "expected_version", "values"]
          : action === "session_move" ? ["id", "expected_version", "kind", "posted_on", "amount_cents", "note"]
            : action === "session_move_delete" ? ["id", "expected_version", "move_id"]
              : ["id", "expected_version"],
    );
    id = uuidValue(field(data, "id"))!;
    const session = one(db, 'SELECT * FROM "erp_finance__cash_session" WHERE id=?', id);
    if (!session || session.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    if (session.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    before = cashSessionView(db, id, true);
    const bump = (set: Record<string, unknown> = {}) => writeRow(ctx, "erp_finance__cash_session", "id", id, { ...set, version: Number(one(db, 'SELECT version FROM "erp_finance__cash_session" WHERE id=?', id)!.version) + 1 });
    if (action === "session_save") {
      if (!hasKey(data, "checked") || jsonType(field(data, "checked")) !== "boolean") raise("22023", "erp_finance_invalid_data");
      const checked = field(data, "checked") as boolean;
      if (checked && session.state !== "closed") raise("40001", "erp_finance_cash_session_state");
      if (hasKey(data, "values")) {
        if (session.state !== "open") raise("40001", "erp_finance_cash_session_state");
        cashSessionValues(ctx, id, field(data, "values"));
      }
      bump({
        checked,
        checked_by: checked ? (session.checked_by ?? user) : null,
        checked_at: checked ? (session.checked_at ?? ctx.clock.next().toString()) : null,
      });
    } else if (action === "session_close") {
      if (session.state !== "open") raise("40001", "erp_finance_cash_session_state");
      cashSessionValues(ctx, id, field(data, "values"));
      bump({ state: "closed", closed_by: user, closed_at: ctx.clock.next().toString() });
    } else if (action === "session_reopen") {
      if (session.state !== "closed" || bool(session.checked)) raise("40001", "erp_finance_cash_session_state");
      if (one(db, `SELECT 1 x FROM "erp_finance__cash_session" WHERE account_id=? AND operator_id=? AND state='open' AND deleted_at IS NULL LIMIT 1`, session.account_id, session.operator_id))
        raise("40001", "erp_finance_cash_session_open");
      bump({ state: "open", closed_by: null, closed_at: null });
    } else if (action === "session_move") {
      // Sangria (saída) ou Suprimento (entrada) na conta do caixa, com ele aberto.
      if (session.state !== "open") raise("40001", "erp_finance_cash_session_state");
      const kind = txt(data, "kind", 20, true)!;
      if (!["withdrawal", "supply"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
      const posted = hasKey(data, "posted_on") && field(data, "posted_on") !== null ? day(field(data, "posted_on"), true) : today;
      if (posted < String(session.opened_on)) raise("22023", "erp_finance_invalid_date");
      const account = cashAccount(db, String(session.account_id));
      const moveId = crypto.randomUUID();
      const amount = cents(field(data, "amount_cents"), false);
      const note = cashText(data, "note", 240, false);
      const entry = insertCashEntry(ctx, {
        account_id: account.id, kind: kind === "supply" ? "in" : "out", amount_cents: amount, posted_on: posted, competence_on: posted,
        note: note ?? (kind === "supply" ? "Suprimento de caixa" : "Sangria de caixa"), origin: "cash_session", source_key: `cash_session:${moveId}`,
        actor: user, command_id: command,
      });
      cashPost(ctx, entry, null, user, command);
      updateAccount(ctx, String(account.id), {});
      db.exec(
        'INSERT INTO "erp_finance__cash_session_move"(id, session_id, kind, posted_on, amount_cents, note, cash_entry_id, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        moveId, id, kind, posted, Number(entry.amount_cents), cashText(data, "note", 240, false), entry.id, user, command, ctx.clock.next().toString(),
      );
      bump();
    } else if (action === "session_move_delete") {
      if (session.state !== "open") raise("40001", "erp_finance_cash_session_state");
      const move = one(db, 'SELECT * FROM "erp_finance__cash_session_move" WHERE id=? AND session_id=?', uuidValue(field(data, "move_id")), id);
      if (!move || move.deleted_at !== null) raise("P0002", "erp_finance_not_found");
      const entry = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', move.cash_entry_id)!;
      if (entry.deleted_at === null) {
        setFlag(ctx, "erp_finance.owned_writer", "on");
        cashCompensate(ctx, String(entry.id), user, command);
        const now = ctx.clock.next().toString();
        const version = Number(one(db, 'SELECT version FROM "erp_finance__cash_entry" WHERE id=?', entry.id)!.version);
        updateCashEntry(ctx, String(entry.id), { deleted_at: now, deleted_by: user, deleted_note: "Excluído no Controle de caixa", version: version + 1, updated_at: now });
        setFlag(ctx, "erp_finance.owned_writer", "");
        updateAccount(ctx, String(entry.account_id), {});
      }
      writeRow(ctx, "erp_finance__cash_session_move", "id", move.id, { deleted_at: ctx.clock.next().toString(), deleted_by: user });
      bump();
    } else {
      // Excluir: só caixa sem sangria nem suprimento (os lançamentos ficam em Caixas e bancos).
      if (bool(session.checked) || one(db, 'SELECT 1 x FROM "erp_finance__cash_session_move" WHERE session_id=? AND deleted_at IS NULL LIMIT 1', id))
        raise("40001", "erp_finance_cash_session_in_use");
      bump({ deleted_at: ctx.clock.next().toString(), deleted_by: user });
    }
  }
  let result: Record<string, unknown> = {
    entity: "cash_sessions",
    record: action === "session_delete" ? { id, deleted: true } : cashSessionView(db, id, true),
  };
  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  flushDeferred(ctx);
  return result;
}

export function erpFinanceCashSessionGet(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a.p_user_id)!;
  const id = uuidArg(a.p_id);
  requireAccess(ctx.db, user, false);
  if (id === null || !one(ctx.db, 'SELECT 1 x FROM "erp_finance__cash_session" WHERE id=? AND deleted_at IS NULL', id)) raise("P0002", "erp_finance_not_found");
  return { entity: "cash_sessions", record: cashSessionView(ctx.db, id, true), data_mode: "erp_native" };
}

function dateArg(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const bad = dateArgError(String(v));
  if (bad) raise(bad.code, bad.message);
  return String(v);
}

export function erpFinanceCashSessionPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const from = dateArg(a.p_from);
  const to = dateArg(a.p_to);
  const state = argOr<string>(a, "p_state", "all");
  const all = argOr<boolean>(a, "p_all", false);
  const query = (a.p_query as string | null) ?? null;
  const page = argOr<number>(a, "p_page", 1);
  const limit = argOr<number>(a, "p_limit", 100);
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    state === null || !["all", "open", "closed", "checked"].includes(state) || all === null ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100 ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) ||
    (from !== null && to !== null && from > to) || (from !== null && from < "1900-01-01") || (to !== null && to > "2100-12-31")
  )
    raise("22023", "erp_finance_invalid_query");
  const rows = db
    .exec('SELECT id, operator_id, opened_at, opened_on, state, checked FROM "erp_finance__cash_session" WHERE deleted_at IS NULL')
    .rows.filter(
      (s) =>
        (all || s.operator_id === user) &&
        (from === null || String(s.opened_on) >= from) &&
        (to === null || String(s.opened_on) <= to) &&
        (state === "all" || (state === "open" && s.state === "open") || (state === "closed" && s.state === "closed" && !bool(s.checked)) || (state === "checked" && bool(s.checked))) &&
        (needle === null || pgLower(actorLabel(db, String(s.operator_id))).includes(needle)),
    )
    .sort((x, y) => Number(y.opened_at) - Number(x.opened_at) || cmpText(String(x.id), String(y.id)));
  return {
    entity: "cash_sessions", state, all, from, to, page, limit, total: rows.length,
    items: rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((s) => cashSessionView(db, String(s.id), false)),
    data_mode: "erp_native",
  };
}

registerRpc("erp_finance_cash_session_execute", erpFinanceCashSessionExecute);
registerRpc("erp_finance_cash_session_get", erpFinanceCashSessionGet);
registerRpc("erp_finance_cash_session_page", erpFinanceCashSessionPage);
