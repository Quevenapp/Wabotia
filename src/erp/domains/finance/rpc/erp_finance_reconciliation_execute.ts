// Conciliação bancária: public.erp_finance_reconciliation_execute (importar e
// excluir extrato OFX; conciliar, reverter com ou sem estorno, ocultar e
// mostrar linhas; criar lançamento, transferência ou baixa a partir da linha),
// erp_finance_reconciliation_page, erp_finance_reconciliation_candidates e
// erp_finance_reconciliation_dismiss (descartar a sugestão, 212).
import { one, type Row } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { todaySaoPaulo } from "../../../engine/time.ts";
import {
  bool,
  btrim,
  charLength,
  cents,
  cmpText,
  CNTRL,
  day,
  expected,
  field,
  insertAudit,
  insertCommand,
  insertMovement,
  jsonArg,
  jsonBytes,
  keys,
  pgLower,
  replayed,
  requestHash,
  requireAccess,
  reserveCommand,
  setFlag,
  ts,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
  writeRow,
} from "../internal.ts";
import {
  cashAccount,
  cashCategory,
  cashCompensate,
  cashContact,
  cashPost,
  cashText,
  findOrCreateCategory,
  insertCashEntry,
  insertTransfer,
  transferAccount,
  updateCashEntry,
} from "../cash.ts";
import { insertBordero, insertSettlement, postSettlementMovements } from "../settlements.ts";
import { left, updateTitle } from "../titles.ts";
import {
  bankLineDto,
  bumpLine,
  candidateLine,
  contactName,
  ofxText,
  reconcileLinks,
  settlementReverse,
  transferReverse,
} from "../reconciliation.ts";
import { statementLines } from "./erp_finance_statement_page.ts";

const ACTIONS = [
  "statement_import", "statement_delete", "line_reconcile", "line_unreconcile", "line_hide", "line_show",
  "line_create_entry", "line_create_transfer", "line_settle_titles",
];
const LINE_KEYS: Record<string, string[]> = {
  line_reconcile: ["line_id", "expected_version", "links"],
  line_unreconcile: ["line_id", "expected_version", "reverse"],
  line_create_entry: ["line_id", "expected_version", "category_id", "contact_id", "note"],
  line_create_transfer: ["line_id", "expected_version", "other_account_id"],
  line_settle_titles: ["line_id", "expected_version", "items"],
};
const REVERSE_NOTE = "Estornado ao reverter a conciliação";

/** p_data->>chave: o texto do valor JSON (string crua; null se falta ou é null). */
const textOf = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : jsonbText(v));
const notNull = (column: string, table: string) =>
  raise("23502", `null value in column "${column}" of relation "${table}" violates not-null constraint`);

function statementImport(ctx: RpcContext, data: unknown, user: string, command: string) {
  const db = ctx.db;
  keys(data, ["account_id", "file_name", "file_hash", "period_from", "period_to", "lines"]);
  const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
  const from = day(field(data, "period_from"));
  const to = day(field(data, "period_to"));
  const lines = field(data, "lines");
  const hash = textOf(field(data, "file_hash"));
  if (jsonType(lines) !== "array" || (lines as unknown[]).length > 5000 || (hash !== null && !/^[a-f0-9]{64}$/.test(hash)))
    raise("22023", "erp_finance_invalid_items");
  if (hash !== null && one(db, 'SELECT 1 x FROM "erp_finance__bank_statement" WHERE account_id=? AND file_hash=? AND deleted_at IS NULL LIMIT 1', account.id, hash))
    raise("23505", "erp_finance_statement_duplicate");
  const fileName = ofxText(data, "file_name", 200);
  if (fileName === null) notNull("file_name", "bank_statement");
  if (hash === null) notNull("file_hash", "bank_statement");
  const id = crypto.randomUUID();
  const periodFrom = from < to ? from : to;
  const periodTo = from < to ? to : from;
  db.exec(
    'INSERT INTO "erp_finance__bank_statement"(id, account_id, file_name, file_hash, period_from, period_to, bank_lines, new_lines, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)',
    id, account.id, fileName, hash, periodFrom, periodTo, (lines as unknown[]).length, user, command, ctx.clock.next().toString(),
  );
  let total = 0;
  let fresh = 0;
  for (const item of lines as unknown[]) {
    keys(item, ["fitid", "posted_on", "amount_cents", "memo", "trntype"]);
    total++;
    const fitid = ofxText(item, "fitid", 255);
    if (fitid !== null && one(db, 'SELECT 1 x FROM "erp_finance__bank_statement_line" WHERE account_id=? AND fitid=? AND deleted_at IS NULL LIMIT 1', account.id, fitid))
      continue;
    if (fitid === null || cents(field(item, "amount_cents"), true, true) === 0) raise("22023", "erp_finance_invalid_items");
    const trntype = textOf(field(item, "trntype")) ?? "";
    if (!/^([A-Z]{1,20})?$/.test(trntype)) raise("22023", "erp_finance_invalid_items");
    // Ordem das colunas do INSERT (plano genérico do PL/pgSQL). Nas 5 primeiras execuções da sessão o plano
    // custom dobra antes as IMMUTABLE (cents, ofx_text) e o day (STABLE) confere por último: com dois campos
    // inválidos na mesma linha o próprio Postgres responde de um jeito ou de outro conforme o cache de planos.
    const posted = day(field(item, "posted_on"));
    const amount = cents(field(item, "amount_cents"), true, true);
    const memo = ofxText(item, "memo", 255);
    const now = ctx.clock.next().toString();
    db.exec(
      `INSERT INTO "erp_finance__bank_statement_line"(id, statement_id, account_id, fitid, posted_on, amount_cents, memo, trntype, state, version, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',1,?,?)`,
      crypto.randomUUID(), id, account.id, fitid, posted, amount, memo, trntype === "" ? null : trntype, now, now,
    );
    fresh++;
  }
  writeRow(ctx, "erp_finance__bank_statement", "id", id, { new_lines: fresh });
  return {
    entity: "reconciliation",
    record: { id, account_id: account.id, file_name: fileName, period_from: periodFrom, period_to: periodTo, bank_lines: total, new_lines: fresh },
  };
}

function statementDelete(ctx: RpcContext, data: unknown, user: string) {
  const db = ctx.db;
  keys(data, ["id"]);
  const s = one(db, 'SELECT * FROM "erp_finance__bank_statement" WHERE id=?', uuidValue(field(data, "id")));
  if (!s || s.deleted_at !== null) raise("P0002", "erp_finance_not_found");
  // Excluir extrato: só sem linhas conciliadas; as linhas saem da fila e podem ser importadas de novo.
  if (one(db, `SELECT 1 x FROM "erp_finance__bank_statement_line" WHERE statement_id=? AND state='reconciled' LIMIT 1`, s.id))
    raise("40001", "erp_finance_statement_reconciled");
  for (const l of db.exec('SELECT id FROM "erp_finance__bank_statement_line" WHERE statement_id=? AND deleted_at IS NULL', s.id).rows)
    bumpLine(ctx, String(l.id), { deleted_at: ctx.clock.next().toString() });
  writeRow(ctx, "erp_finance__bank_statement", "id", s.id, { deleted_at: ctx.clock.next().toString(), deleted_by: user });
  return { entity: "reconciliation", record: { id: s.id, deleted: true } };
}

export function erpFinanceReconciliationExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 2097152) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let result: Record<string, unknown>;
  let before: unknown = null;
  if (action === "statement_import") result = statementImport(ctx, data, user, command);
  else if (action === "statement_delete") result = statementDelete(ctx, data, user);
  else {
    keys(data, LINE_KEYS[action] ?? ["line_id", "expected_version"]);
    let line = one(db, 'SELECT * FROM "erp_finance__bank_statement_line" WHERE id=?', uuidValue(field(data, "line_id")));
    if (!line || line.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    if (action === "line_settle_titles") {
      const items = field(data, "items");
      if (jsonType(items) !== "array" || (items as unknown[]).length < 1 || (items as unknown[]).length > 50) raise("22023", "erp_finance_invalid_items");
      for (const item of items as unknown[]) uuidValue(field(item, "id"));
    } else if (action === "line_create_transfer") uuidValue(field(data, "other_account_id"));
    const account = cashAccount(db, String(line.account_id));
    line = one(db, 'SELECT * FROM "erp_finance__bank_statement_line" WHERE id=?', line.id)!;
    if (line.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    before = bankLineDto(db, String(line.id), false);
    if (["line_reconcile", "line_create_entry", "line_create_transfer", "line_settle_titles", "line_hide"].includes(action) && line.state !== "pending")
      raise("40001", "erp_finance_line_state");
    if (action === "line_show" && line.state !== "hidden") raise("40001", "erp_finance_line_state");
    if (action === "line_unreconcile" && line.state !== "reconciled") raise("40001", "erp_finance_line_state");
    const amount = Number(line.amount_cents);

    if (action === "line_reconcile") reconcileLinks(ctx, line, field(data, "links"), user, command);
    else if (action === "line_hide" || action === "line_show") bumpLine(ctx, String(line.id), { state: action === "line_hide" ? "hidden" : "pending" });
    else if (action === "line_unreconcile") {
      const reverseValue = field(data, "reverse");
      if (jsonType(reverseValue === undefined ? false : reverseValue) !== "boolean") raise("22023", "erp_finance_invalid_data");
      const reverse = reverseValue === true;
      const active = db.exec('SELECT * FROM "erp_finance__reconciliation_link" WHERE line_id=? AND undone_at IS NULL', line.id).rows;
      if (reverse) {
        const transfers = new Set<string>();
        for (const k of active) {
          const m = k.movement_id === null ? null : one(db, 'SELECT transfer_id FROM "erp_finance__movement" WHERE id=?', k.movement_id);
          if (m && m.transfer_id !== null) transfers.add(String(m.transfer_id));
        }
        if (transfers.size > 1) raise("40001", "erp_finance_reconciliation_reverse_locked");
      }
      for (const k of active)
        writeRow(ctx, "erp_finance__reconciliation_link", "id", k.id, { undone_at: ctx.clock.next().toString(), undone_by: user, undone_command: command });
      if (reverse) {
        const order = (x: Row, y: Row) => Number(x.created_at) - Number(y.created_at) || cmpText(String(x.id), String(y.id));
        for (const k of active.filter((k) => k.entry_id !== null).sort(order)) {
          const entry = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', k.entry_id)!;
          if (entry.deleted_at === null) {
            cashCompensate(ctx, String(entry.id), user, command);
            const now = ctx.clock.next().toString();
            const version = Number(one(db, 'SELECT version FROM "erp_finance__cash_entry" WHERE id=?', entry.id)!.version);
            updateCashEntry(ctx, String(entry.id), { deleted_at: now, deleted_by: user, deleted_note: REVERSE_NOTE, version: version + 1, updated_at: now });
          }
        }
        const moves = active.filter((k) => k.movement_id !== null).sort((x, y) => cmpText(String(x.movement_id), String(y.movement_id)));
        for (const k of moves) {
          const m = one(db, 'SELECT settlement_id, transfer_id FROM "erp_finance__movement" WHERE id=?', k.movement_id)!;
          if (m.settlement_id !== null) settlementReverse(ctx, String(m.settlement_id), user, command, REVERSE_NOTE);
          else if (m.transfer_id !== null) {
            // transfer.command_id → command é FK adiada no Postgres: o recibo é reservado antes.
            reserveCommand(ctx, command, user, hash);
            transferReverse(ctx, String(m.transfer_id), user, command, REVERSE_NOTE);
          }
        }
      }
      bumpLine(ctx, String(line.id), { state: "pending" });
    } else if (action === "line_create_entry") {
      // Novo a partir do extrato: Registro de Caixa "<memo> - Criado via conciliação", conciliado no mesmo comando.
      const category = cashCategory(db, field(data, "category_id"), amount > 0 ? "receivable" : "payable");
      const note =
        cashText(data, "note", 2000, false) ?? left(`${(line.memo as string | null) ?? "Lançamento do extrato"} - Criado via conciliação`, 2000);
      const contact = cashContact(db, field(data, "contact_id"));
      const entry = insertCashEntry(ctx, {
        account_id: account.id, kind: amount > 0 ? "in" : "out", amount_cents: Math.abs(amount), posted_on: line.posted_on, competence_on: line.posted_on,
        contact_id: contact, note, origin: "reconciliation", source_key: `ofx:${line.id}`, actor: user, command_id: command,
      });
      cashPost(ctx, entry, category, user, command);
      updateAccount(ctx, String(account.id), {});
      reconcileLinks(ctx, line, [{ kind: "entry", id: entry.id }], user, command);
    } else if (action === "line_create_transfer") {
      // Transferência a partir do extrato: a perna desta conta é a linha; a outra conta recebe a outra perna.
      const other0 = one(db, 'SELECT id FROM "erp_finance__account" WHERE id=?', uuidValue(field(data, "other_account_id")));
      if (!other0 || other0.id === account.id) raise("22023", "erp_finance_transfer_invalid");
      const other = cashAccount(db, String(other0.id));
      const posted = String(line.posted_on);
      if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id IN (?, ?) AND kind='opening' AND posted_on>? LIMIT 1`, account.id, other.id, posted))
        raise("22023", "erp_finance_transfer_before_opening");
      const value = Math.abs(amount);
      const note = left(amount < 0 ? `Transferência ${account.name} -> ${other.name}` : `Transferência ${other.name} -> ${account.name}`, 500);
      const ca = transferAccount(db, String(amount < 0 ? account.id : other.id))!;
      const cb = transferAccount(db, String(amount < 0 ? other.id : account.id))!;
      const snapshot = (c: Record<string, unknown>, delta: number) => ({
        id: c.id, name: c.name, kind: c.kind, version_before: c.version, version_after: Number(c.version) + 1,
        balance_before_cents: c.balance_cents, balance_after_cents: String(Number(c.balance_cents) + delta), opening_on: c.opening_on,
      });
      reserveCommand(ctx, command, user, hash);
      const transfer = insertTransfer(ctx, {
        command_id: command, actor: user, from_account_id: ca.id, to_account_id: cb.id, amount_cents: value, posted_on: posted, note,
        from_snapshot: snapshot(ca, -value), to_snapshot: snapshot(cb, value), float_days: 0,
      });
      const outCategory = findOrCreateCategory(ctx, "Transferências de saída", "payable");
      const inCategory =
        (one(
          db,
          `SELECT d.category_id FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id WHERE d.key='transfer_in' AND c.active=1 AND c.deleted_at IS NULL`,
        )?.category_id as string | undefined) ?? findOrCreateCategory(ctx, "Transferências de entrada", "receivable");
      insertMovement(ctx, { account_id: String(ca.id), kind: "transfer_out", delta_cents: -value, posted_on: posted, note, actor: user, command_id: command, transfer_id: transfer, category_id: outCategory });
      insertMovement(ctx, { account_id: String(cb.id), kind: "transfer_in", delta_cents: value, posted_on: posted, note, actor: user, command_id: command, transfer_id: transfer, category_id: inCategory });
      for (const acc of [String(account.id), String(other.id)]) updateAccount(ctx, acc, {});
      const movement = one(db, 'SELECT id FROM "erp_finance__movement" WHERE transfer_id=? AND account_id=?', transfer, account.id)!.id;
      reconcileLinks(ctx, line, [{ kind: "movement", id: movement }], user, command);
    } else {
      // Baixa a partir do extrato: as contas escolhidas são baixadas na data e na conta da linha, pelo principal, num borderô.
      const items = field(data, "items") as unknown[];
      const kind = amount > 0 ? "receivable" : "payable";
      const sorted = items.map((item) => ({ item, id: uuidValue(field(item, "id"))! })).sort((x, y) => cmpText(x.id, y.id));
      if (new Set(sorted.map((x) => x.id)).size !== items.length) raise("22023", "erp_finance_invalid_items");
      const posted = String(line.posted_on);
      if (posted > todaySaoPaulo()) raise("22023", "erp_finance_invalid_date");
      if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND kind='opening' AND posted_on>? LIMIT 1`, account.id, posted))
        raise("22023", "erp_finance_payment_before_opening");
      const note = left((line.memo as string | null) ?? "Baixa pela conciliação", 500);
      const bordero = insertBordero(ctx, { kind, posted_on: posted, account_id: String(account.id), note, grouped: items.length > 1, actor: user, command_id: command });
      const links: { kind: string; id: unknown }[] = [];
      for (const { item, id } of sorted) {
        keys(item, ["id", "expected_version", "principal_cents"]);
        const title = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
        if (!title) raise("P0002", "erp_finance_not_found");
        if (title.version !== expected(field(item, "expected_version"))) raise("40001", "erp_finance_version_conflict");
        if (title.kind !== kind || bool(title.cancelled) || title.deleted_at !== null) raise("22023", "erp_finance_invalid_reconciliation");
        if (posted < String(title.issued_on)) raise("22023", "erp_finance_payment_before_issue");
        const principal = cents(field(item, "principal_cents"), false);
        if (principal > Number(title.amount_cents) - Number(title.settled_cents)) raise("40001", "erp_finance_overpayment");
        setFlag(ctx, "erp_finance.bordero_id", bordero);
        setFlag(ctx, "erp_finance.bordero_category", "");
        const settlement = insertSettlement(ctx, {
          title_id: id, account_id: String(account.id), kind: "payment", posted_on: posted, principal_cents: principal,
          interest_cents: 0, penalty_cents: 0, discount_cents: 0, fee_cents: 0, net_cash_cents: principal, note, actor: user, command_id: command,
        });
        setFlag(ctx, "erp_finance.bordero_id", "");
        const fresh = one(db, 'SELECT settled_cents, version FROM "erp_finance__title" WHERE id=?', id)!;
        updateTitle(ctx, id, { settled_cents: Number(fresh.settled_cents) + principal, version: Number(fresh.version) + 1, updated_at: ctx.clock.next().toString() });
        postSettlementMovements(ctx, settlement, kind === "receivable" ? principal : -principal);
        links.push({ kind: "movement", id: one(db, `SELECT id FROM "erp_finance__movement" WHERE settlement_id=? AND kind='payment'`, settlement)!.id });
      }
      updateAccount(ctx, String(account.id), {});
      reconcileLinks(ctx, line, links, user, command);
    }
    result = { entity: "reconciliation", record: bankLineDto(db, String(line.id), false) };
  }

  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

const between = (v: unknown, lo: number, hi: number) => v === null || v === undefined || (Number(v) >= lo && Number(v) <= hi);

export function erpFinanceReconciliationPage(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const account = uuidArg(a.p_account);
  const state = (a.p_state as string | null) ?? null;
  const amount = (a.p_amount_cents as number | null) ?? null;
  const page = (a.p_page as number | null) ?? null;
  const limit = (a.p_limit as number | null) ?? null;
  requireAccess(db, user, false);
  if (
    account === null || state === null || !["pending", "reconciled", "hidden"].includes(state) || !between(amount, 1, 999999999999999) ||
    page === null || page < 1 || page > 100000 || limit === null || limit < 1 || limit > 100
  )
    raise("22023", "erp_finance_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL', account)) raise("P0002", "erp_finance_not_found");
  const all = db.exec('SELECT id, posted_on, fitid, state, amount_cents FROM "erp_finance__bank_statement_line" WHERE account_id=? AND deleted_at IS NULL', account).rows;
  const rows = all
    .filter((l) => l.state === state && (amount === null || Math.abs(Number(l.amount_cents)) === Number(amount)))
    .sort((x, y) => cmpText(String(x.posted_on), String(y.posted_on)) || cmpText(String(x.fitid), String(y.fitid)) || cmpText(String(x.id), String(y.id)));
  const statements = db
    .exec('SELECT id, file_name, created_at, period_from, period_to FROM "erp_finance__bank_statement" WHERE account_id=? AND deleted_at IS NULL', account)
    .rows.sort((x, y) => Number(y.created_at) - Number(x.created_at) || cmpText(String(x.id), String(y.id)))
    .map((s) => ({
      id: s.id, file_name: s.file_name, created_at: ts(s.created_at), period_from: s.period_from, period_to: s.period_to,
      lines: Number(one(db, 'SELECT count(*) n FROM "erp_finance__bank_statement_line" WHERE statement_id=?', s.id)!.n),
      reconciled: Number(one(db, `SELECT count(*) n FROM "erp_finance__bank_statement_line" WHERE statement_id=? AND state='reconciled'`, s.id)!.n),
    }));
  const count = (s: string) => all.filter((l) => l.state === s).length;
  return {
    entity: "reconciliation", account_id: account, state, page, limit, total: rows.length,
    items: rows.slice((page - 1) * limit, (page - 1) * limit + limit).map((l) => bankLineDto(db, String(l.id), state === "pending")),
    counts: { pending: count("pending"), reconciled: count("reconciled"), hidden: count("hidden") },
    statements,
    data_mode: "erp_native",
  };
}

const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
/** to_char(v/100.0,'FM999999999999990.00') com vírgula. */
const money = (cents: number) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
const brDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const concatWs = (...parts: (string | null | undefined)[]) => parts.filter((p) => p !== null && p !== undefined).join(" ");

export function erpFinanceReconciliationCandidates(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const account = uuidArg(a.p_account);
  const from = (a.p_from as string | null) ?? null;
  const to = (a.p_to as string | null) ?? null;
  const query = (a.p_query as string | null) ?? null;
  const amount = (a.p_amount_cents as number | null) ?? null;
  const needle = query === null || btrim(query) === "" ? null : pgLower(btrim(query));
  requireAccess(db, user, false);
  if (
    account === null || from === null || to === null || from > to || daysBetween(from, to) > 3660 || from < "1900-01-01" || to > "2100-12-31" ||
    (query !== null && (charLength(query) > 120 || CNTRL.test(query))) || !between(amount, 1, 999999999999999)
  )
    raise("22023", "erp_finance_invalid_query");
  if (!one(db, 'SELECT 1 x FROM "erp_finance__account" WHERE id=? AND deleted_at IS NULL', account)) raise("P0002", "erp_finance_not_found");
  const movements = statementLines(db, account, from, to, false)
    .filter((l) => candidateLine(db, l) && (amount === null || Math.abs(Number(l.amount_cents)) === Number(amount)))
    .map((l) => ({ l, contact: contactName(db, l.contact_id) }))
    .filter(
      ({ l, contact }) =>
        needle === null ||
        pgLower(concatWs(l.note as string | null, contact, brDate(String(l.posted_on)), money(Math.abs(Number(l.amount_cents))))).includes(needle),
    )
    .sort((x, y) => cmpText(String(x.l.posted_on), String(y.l.posted_on)) || cmpText(String(x.l.line_id), String(y.l.line_id)))
    .slice(0, 100)
    .map(({ l, contact }) => ({
      kind: l.line_kind === "entry" ? "entry" : "movement",
      id: l.line_kind === "entry" ? l.entry_id : l.line_id,
      line_kind: l.line_kind,
      posted_on: l.posted_on,
      amount_cents: String(l.amount_cents),
      note: l.note,
      contact_name: contact,
      title_kind: l.title_kind,
    }))
    .sort((x, y) => cmpText(String(x.posted_on), String(y.posted_on)) || cmpText(String(x.id), String(y.id)));
  const methodName = (id: unknown) =>
    id === null ? null : ((one(db, 'SELECT description FROM "erp_catalog__payment_method" WHERE id=?', id)?.description as string | undefined) ?? null);
  const titles = db
    .exec(
      `SELECT t.id, t.kind, t.version, r.name contact_name, t.description, t.due_on, t.amount_cents, t.settled_cents, t.installment, t.installments,
              t.payment_method_id, t.source_reference
         FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id
        WHERE t.cancelled=0 AND t.deleted_at IS NULL AND t.settled_cents<t.amount_cents AND t.due_on>=? AND t.due_on<=?`,
      from,
      to,
    )
    .rows.map((t) => ({ t, balance: Number(t.amount_cents) - Number(t.settled_cents), method: methodName(t.payment_method_id) }))
    .filter(({ t, balance, method }) =>
      (amount === null || balance === Number(amount)) &&
      (needle === null ||
        pgLower(
          concatWs(t.contact_name as string, t.description as string, t.source_reference as string | null, method, brDate(String(t.due_on)), money(balance)),
        ).includes(needle)),
    )
    .sort((x, y) => cmpText(String(x.t.due_on), String(y.t.due_on)) || cmpText(String(x.t.id), String(y.t.id)))
    .slice(0, 100)
    .map(({ t, balance, method }) => ({
      id: t.id, kind: t.kind, version: t.version, contact_name: t.contact_name, description: t.description, due_on: t.due_on,
      balance_cents: String(balance), installment: t.installment, installments: t.installments, payment_method_name: method === null ? null : left(method, 100),
    }));
  return { entity: "reconciliation_candidates", account_id: account, from, to, movements, titles, data_mode: "erp_native" };
}

export function erpFinanceReconciliationDismiss(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  requireAccess(db, user, true);
  if (command === null || data === null || jsonType(data) !== "object" || jsonBytes(data) > 4096) raise("22023", "erp_finance_invalid_data");
  keys(data, ["line_id", "expected_version", "target"]);
  const target = field(data, "target");
  if (jsonType(target) !== "object") raise("22023", "erp_finance_invalid_data");
  keys(target, ["kind", "id"]);
  const kind = txt(target, "kind", 10, true)!;
  const targetId = uuidValue(field(target, "id"))!;
  if (!["entry", "movement"].includes(kind)) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, "line_dismiss", data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;
  const line = one(db, 'SELECT * FROM "erp_finance__bank_statement_line" WHERE id=? AND deleted_at IS NULL', uuidValue(field(data, "line_id")));
  if (!line) raise("P0002", "erp_finance_not_found");
  if (line.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
  if (line.state !== "pending") raise("40001", "erp_finance_line_not_pending");
  const before = bankLineDto(db, String(line.id), true);
  const suggestion = before.suggestion;
  if (suggestion === null || suggestion.kind !== kind || String(suggestion.id).toLowerCase() !== targetId) raise("40001", "erp_finance_suggestion_changed");
  db.exec(
    'INSERT INTO "erp_finance__bank_line_dismissal"(id, line_id, target_kind, target_id, actor, command_id, created_at) VALUES(?,?,?,?,?,?,?)',
    crypto.randomUUID(), line.id, kind, targetId, user, command, ctx.clock.next().toString(),
  );
  bumpLine(ctx, String(line.id), {});
  requireAccess(db, user, true);
  const result = {
    entity: "reconciliation", action: "line_dismiss", record: bankLineDto(db, String(line.id), true), dismissed: { kind, id: targetId },
    data_mode: "erp_native", replayed: false,
  };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, "line_dismiss", before, result);
  return result;
}

registerRpc("erp_finance_reconciliation_execute", erpFinanceReconciliationExecute);
registerRpc("erp_finance_reconciliation_page", erpFinanceReconciliationPage);
registerRpc("erp_finance_reconciliation_candidates", erpFinanceReconciliationCandidates);
registerRpc("erp_finance_reconciliation_dismiss", erpFinanceReconciliationDismiss);
