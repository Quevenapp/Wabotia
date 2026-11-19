// public.erp_finance_cash_execute: Caixas e bancos (registro de caixa,
// excluir e restaurar, ajustar saldo, transferência entre contas e a exclusão
// dela por transferência inversa, alterar a categoria de uma linha do extrato).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { linkedTitleGuard } from "../internal.ts";
import {
  cents,
  day,
  expected,
  field,
  hasKey,
  insertAudit,
  insertCommand,
  insertMovement,
  jsonArg,
  jsonBytes,
  keys,
  reclassifyMovements,
  replayed,
  requestHash,
  requireAccess,
  reserveCommand,
  setFlag,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
} from "../internal.ts";
import {
  activeEntryMovement,
  cashAccount,
  cashCategory,
  cashCompensate,
  cashContact,
  cashEntryView,
  cashPost,
  cashText,
  findOrCreateCategory,
  insertCashEntry,
  insertTransfer,
  insertTransferDeletion,
  transferAccount,
  updateCashEntry,
} from "../cash.ts";
import { left } from "../titles.ts";

const ACTIONS = ["entry_save", "entry_delete", "entry_restore", "balance_adjust", "transfer_create", "transfer_delete", "line_categorize"];

/** data + n dias (date + integer do Postgres). */
function addDays(day: string, n: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function erpFinanceCashExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 16384) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const replay = replayed(db, command, user, hash);
  if (replay) return replay;

  let result: Record<string, unknown>;
  let before: unknown = null;

  if (action === "entry_save") {
    keys(data, ["id", "expected_version", "account_id", "kind", "amount_cents", "posted_on", "competence_on", "category_id", "contact_id", "note", "origin"]);
    const id = uuidValue(field(data, "id"), false);
    const kind = txt(data, "kind", 3, true)!;
    if (!["in", "out"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    const amount = cents(field(data, "amount_cents"), false);
    const postedOn = day(field(data, "posted_on"));
    const competence = day(field(data, "competence_on"));
    const note = cashText(data, "note", 2000, true)!;
    const contact = cashContact(db, field(data, "contact_id"));
    const category = cashCategory(db, field(data, "category_id"), null);
    const origin = txt(data, "origin", 20) ?? "manual";
    if (!["manual", "ledger"].includes(origin)) raise("22023", "erp_finance_invalid_data");
    let entryId: string;
    if (id === null) {
      expected(field(data, "expected_version"), true);
      const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
      const entry = insertCashEntry(ctx, {
        account_id: account.id, kind, amount_cents: amount, posted_on: postedOn, competence_on: competence, contact_id: contact, note, origin, actor: user, command_id: command,
      });
      cashPost(ctx, entry, category, user, command);
      updateAccount(ctx, String(account.id), {});
      entryId = String(entry.id);
    } else {
      const old = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', id);
      if (!old) raise("P0002", "erp_finance_not_found");
      uuidValue(field(data, "account_id"));
      if (old.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
      // Um registro criado pela conciliação ou importado é um lançamento como os outros depois de criado.
      if (old.deleted_at !== null || !["manual", "ledger", "reconciliation", "import"].includes(String(old.origin)))
        raise("40001", "erp_finance_entry_state");
      before = cashEntryView(db, id);
      const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
      const now = () => ctx.clock.next().toString();
      if (account.id !== old.account_id || kind !== old.kind || amount !== Number(old.amount_cents) || postedOn !== old.posted_on) {
        // Mudar valor, data, tipo ou conta compensa o lançamento ativo e lança de novo.
        cashCompensate(ctx, id, user, command);
        const entry = updateCashEntry(ctx, id, {
          account_id: account.id, kind, amount_cents: amount, posted_on: postedOn, competence_on: competence, contact_id: contact, note,
          version: Number(old.version) + 1, updated_at: now(),
        });
        cashPost(ctx, entry, category, user, command);
        for (const acc of [...new Set([String(old.account_id), String(account.id)])]) updateAccount(ctx, acc, {});
      } else {
        updateCashEntry(ctx, id, { competence_on: competence, contact_id: contact, note, version: Number(old.version) + 1, updated_at: now() });
        setFlag(ctx, "erp_finance.reclassify", "on");
        reclassifyMovements(
          ctx,
          `entry_id=? AND kind='entry' AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" c WHERE c.compensates_id="erp_finance__movement".id)`,
          [id],
          category,
        );
        setFlag(ctx, "erp_finance.reclassify", "");
      }
      entryId = id;
    }
    result = { entity: "cash_entries", record: cashEntryView(db, entryId) };
  } else if (action === "entry_delete" || action === "entry_restore") {
    keys(data, ["id", "expected_version", "note"]);
    const id = uuidValue(field(data, "id"))!;
    const old = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', id);
    if (!old) raise("P0002", "erp_finance_not_found");
    if (old.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    before = cashEntryView(db, id);
    const note = cashText(data, "note", 500, false);
    if (action === "entry_delete") {
      if (old.deleted_at !== null) raise("40001", "erp_finance_entry_state");
      cashCompensate(ctx, id, user, command);
      const now = ctx.clock.next().toString();
      updateCashEntry(ctx, id, { deleted_at: now, deleted_by: user, deleted_note: note, version: Number(old.version) + 1, updated_at: now });
    } else {
      if (old.deleted_at === null) raise("40001", "erp_finance_entry_state");
      cashAccount(db, String(old.account_id));
      // Restaurar: um lançamento novo com a categoria que o registro tinha ao ser excluído.
      const category = (one(
        db,
        `SELECT category_id FROM "erp_finance__movement" WHERE entry_id=? AND kind='entry_reversal' ORDER BY created_at DESC LIMIT 1`,
        id,
      )?.category_id ?? null) as string | null;
      const entry = updateCashEntry(ctx, id, {
        deleted_at: null, deleted_by: null, deleted_note: null, version: Number(old.version) + 1, updated_at: ctx.clock.next().toString(),
      });
      cashPost(ctx, entry, category, user, command);
    }
    updateAccount(ctx, String(old.account_id), {});
    result = { entity: "cash_entries", record: cashEntryView(db, id), note };
  } else if (action === "balance_adjust") {
    // Ajustar saldos: a diferença entre o saldo desejado e o atual, na data do ajuste.
    keys(data, ["account_id", "desired_cents", "current_cents", "posted_on"]);
    const account = cashAccount(db, uuidValue(field(data, "account_id"))!);
    const desired = cents(field(data, "desired_cents"), true, true);
    const postedOn = day(field(data, "posted_on"), true);
    const balance = Number(one(db, 'SELECT coalesce(sum(delta_cents),0) b FROM "erp_finance__movement" WHERE account_id=?', account.id)!.b);
    const current = field(data, "current_cents");
    // v_balance::text<>(p_data->>'current_cents') or jsonb_typeof(…)<>'string': ausente não recusa.
    if (current !== undefined && (jsonType(current) !== "string" || String(balance) !== current)) raise("40001", "erp_finance_balance_changed");
    if (desired === balance) raise("22023", "erp_finance_invalid_cents");
    const entry = insertCashEntry(ctx, {
      account_id: account.id, kind: desired > balance ? "in" : "out", amount_cents: Math.abs(desired - balance), posted_on: postedOn, competence_on: postedOn,
      note: "Ajuste de saldo", origin: "adjustment", actor: user, command_id: command,
    });
    cashPost(ctx, entry, null, user, command);
    updateAccount(ctx, String(account.id), {});
    result = { entity: "cash_entries", record: cashEntryView(db, String(entry.id)), balance_cents: String(desired) };
  } else if (action === "transfer_create") {
    // Transferência entre contas: "Transferência A -> B", categorias de transferência e float na perna de entrada.
    keys(data, ["from_account_id", "to_account_id", "amount_cents", "posted_on", "float_days", "note"]);
    const fromId = uuidValue(field(data, "from_account_id"))!;
    const toId = uuidValue(field(data, "to_account_id"))!;
    if (fromId === toId) raise("22023", "erp_finance_transfer_invalid");
    const from = cashAccount(db, fromId);
    const to = cashAccount(db, toId);
    const amount = cents(field(data, "amount_cents"), false);
    const postedOn = day(field(data, "posted_on"), true);
    const floatValue = field(data, "float_days");
    const floatText = floatValue === undefined || floatValue === null ? (floatValue === null ? null : "0") : jsonbText(floatValue);
    if (
      jsonType(floatValue === undefined ? 0 : floatValue) !== "number" ||
      floatText === null ||
      !/^[0-9]{1,2}$/.test(floatText) ||
      Number(floatText) > 30
    )
      raise("22023", "erp_finance_transfer_invalid");
    const floatDays = Number(floatText);
    const inDay = addDays(postedOn, floatDays);
    const note = cashText(data, "note", 500, false) ?? left(`Transferência ${from.name} -> ${to.name}`, 500);
    if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id IN (?, ?) AND kind='opening' AND posted_on>? LIMIT 1`, from.id, to.id, postedOn))
      raise("22023", "erp_finance_transfer_before_opening");
    const outCategory = findOrCreateCategory(ctx, "Transferências de saída", "payable");
    const inCategory =
      (one(
        db,
        `SELECT d.category_id FROM "erp_finance__category_default" d JOIN "erp_finance__category" c ON c.id=d.category_id WHERE d.key='transfer_in' AND c.active=1 AND c.deleted_at IS NULL`,
      )?.category_id as string | undefined) ?? findOrCreateCategory(ctx, "Transferências de entrada", "receivable");
    const ca = transferAccount(db, String(from.id))!;
    const cb = transferAccount(db, String(to.id))!;
    const snapshot = (acc: Record<string, unknown>, snap: Record<string, unknown>, delta: number) => ({
      id: acc.id, name: acc.name, kind: acc.kind, version_before: acc.version, version_after: Number(acc.version) + 1,
      balance_before_cents: snap.balance_cents, balance_after_cents: String(Number(snap.balance_cents) + delta), opening_on: snap.opening_on,
    });
    // transfer.command_id → command é FK adiada no Postgres: o recibo é reservado antes.
    reserveCommand(ctx, command, user, hash);
    const transfer = insertTransfer(ctx, {
      command_id: command, actor: user, from_account_id: from.id, to_account_id: to.id, amount_cents: amount, posted_on: postedOn, note,
      from_snapshot: snapshot(from, ca, -amount), to_snapshot: snapshot(to, cb, amount), in_posted_on: floatDays > 0 ? inDay : null, float_days: floatDays,
    });
    insertMovement(ctx, { account_id: String(from.id), kind: "transfer_out", delta_cents: -amount, posted_on: postedOn, note, actor: user, command_id: command, transfer_id: transfer, category_id: outCategory });
    insertMovement(ctx, { account_id: String(to.id), kind: "transfer_in", delta_cents: amount, posted_on: inDay, note, actor: user, command_id: command, transfer_id: transfer, category_id: inCategory });
    for (const acc of [String(from.id), String(to.id)]) updateAccount(ctx, acc, {});
    result = {
      entity: "transfers",
      record: { id: transfer, from_account_id: from.id, to_account_id: to.id, amount_cents: String(amount), posted_on: postedOn, in_posted_on: inDay, float_days: floatDays, note },
    };
  } else if (action === "transfer_delete") {
    // Excluir transferência: a transferência inversa nas datas das pernas originais; a original fica no histórico.
    keys(data, ["transfer_id", "note"]);
    const t = one(db, 'SELECT * FROM "erp_finance__transfer" WHERE id=?', uuidValue(field(data, "transfer_id")));
    if (!t) raise("P0002", "erp_finance_not_found");
    if (one(db, 'SELECT 1 x FROM "erp_finance__transfer_deletion" WHERE transfer_id=? OR reversal_id=? LIMIT 1', t.id, t.id))
      raise("40001", "erp_finance_transfer_deleted");
    const note = cashText(data, "note", 500, false);
    const from = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', t.to_account_id)!;
    const to = one(db, 'SELECT * FROM "erp_finance__account" WHERE id=?', t.from_account_id)!;
    if (from.deleted_at !== null || to.deleted_at !== null) raise("22023", "erp_finance_invalid_account");
    const reversal = crypto.randomUUID();
    const ca = transferAccount(db, String(from.id))!;
    const cb = transferAccount(db, String(to.id))!;
    const amount = Number(t.amount_cents);
    const snapshot = (acc: Record<string, unknown>, snap: Record<string, unknown>, delta: number) => ({
      id: acc.id, name: acc.name, kind: acc.kind, version_before: acc.version, version_after: Number(acc.version) + 1,
      balance_before_cents: snap.balance_cents, balance_after_cents: String(Number(snap.balance_cents) + delta), opening_on: snap.opening_on,
    });
    const outDay = String(t.in_posted_on ?? t.posted_on);
    reserveCommand(ctx, command, user, hash);
    insertTransfer(ctx, {
      id: reversal, command_id: command, actor: user, from_account_id: from.id, to_account_id: to.id, amount_cents: amount, posted_on: outDay, note: t.note,
      from_snapshot: snapshot(from, ca, -amount), to_snapshot: snapshot(to, cb, amount), in_posted_on: t.in_posted_on !== null ? t.posted_on : null, float_days: 0,
    });
    const categoryOf = (kind: string) =>
      (one(db, 'SELECT category_id FROM "erp_finance__movement" WHERE transfer_id=? AND kind=?', t.id, kind)?.category_id ?? null) as string | null;
    const inCat = categoryOf("transfer_in"),
      outCat = categoryOf("transfer_out");
    insertMovement(ctx, { account_id: String(from.id), kind: "transfer_out", delta_cents: -amount, posted_on: outDay, note: String(t.note), actor: user, command_id: command, transfer_id: reversal, category_id: inCat });
    insertMovement(ctx, { account_id: String(to.id), kind: "transfer_in", delta_cents: amount, posted_on: String(t.posted_on), note: String(t.note), actor: user, command_id: command, transfer_id: reversal, category_id: outCat });
    insertTransferDeletion(ctx, { transfer_id: String(t.id), reversal_id: reversal, actor: user, command_id: command, note });
    for (const acc of [String(from.id), String(to.id)]) updateAccount(ctx, acc, {});
    result = { entity: "transfers", record: { id: t.id, deleted: true, reversal_id: reversal }, note };
  } else {
    // Alterar categorias: uma linha do extrato; a categoria que a pessoa viu é o CAS.
    keys(data, ["line_kind", "line_id", "expected_category_id", "category_id"]);
    const lineKind = txt(data, "line_kind", 20, true)!;
    const id = uuidValue(field(data, "line_id"))!;
    const expectedCategory = uuidValue(field(data, "expected_category_id"), false);
    if (!hasKey(data, "expected_category_id")) raise("22023", "erp_finance_invalid_data");
    setFlag(ctx, "erp_finance.reclassify", "on");
    let category: string | null;
    if (lineKind === "entry") {
      const old = one(db, 'SELECT * FROM "erp_finance__cash_entry" WHERE id=?', id);
      if (!old) raise("P0002", "erp_finance_not_found");
      if (old.deleted_at !== null) raise("40001", "erp_finance_entry_state");
      const m = activeEntryMovement(db, id);
      category = cashCategory(db, field(data, "category_id"), null);
      if ((m?.category_id ?? null) !== expectedCategory) raise("40001", "erp_finance_version_conflict");
      if (m) reclassifyMovements(ctx, "id=?", [m.id], category);
      updateCashEntry(ctx, id, { version: Number(old.version) + 1, updated_at: ctx.clock.next().toString() });
    } else if (lineKind === "transfer") {
      const m = one(db, 'SELECT * FROM "erp_finance__movement" WHERE id=? AND transfer_id IS NOT NULL', id);
      if (!m) raise("P0002", "erp_finance_not_found");
      if (one(db, 'SELECT 1 x FROM "erp_finance__transfer_deletion" WHERE transfer_id=? OR reversal_id=? LIMIT 1', m.transfer_id, m.transfer_id))
        raise("40001", "erp_finance_transfer_deleted");
      category = cashCategory(db, field(data, "category_id"), null);
      if (m.category_id !== expectedCategory) raise("40001", "erp_finance_version_conflict");
      reclassifyMovements(ctx, "id=?", [id], category);
    } else if (lineKind === "settlement") {
      // Uma linha de baixa muda a categoria da baixa no borderô (a da conta fica).
      const m = one(db, 'SELECT * FROM "erp_finance__movement" WHERE id=? AND settlement_id IS NOT NULL', id);
      if (!m) raise("P0002", "erp_finance_not_found");
      if (["bank_fee", "bank_fee_reversal"].includes(String(m.kind))) raise("22023", "erp_finance_invalid_data");
      const s = one(db, 'SELECT id, title_id, reverses_id FROM "erp_finance__settlement" WHERE id=?', m.settlement_id)!;
      linkedTitleGuard(db, s.title_id);
      const kind = String(one(db, 'SELECT kind FROM "erp_finance__title" WHERE id=?', s.title_id)!.kind);
      category = cashCategory(db, field(data, "category_id"), kind);
      const target = String(s.reverses_id ?? s.id);
      const current = one(
        db,
        `SELECT coalesce(i.category_id, b.category_id, t.category_id) c FROM "erp_finance__bordero_item" i JOIN "erp_finance__bordero" b ON b.id=i.bordero_id
           JOIN "erp_finance__settlement" s ON s.id=i.settlement_id JOIN "erp_finance__title" t ON t.id=s.title_id WHERE i.settlement_id=?`,
        target,
      );
      if (!current) raise("P0002", "erp_finance_not_found");
      if ((current.c ?? null) !== expectedCategory) raise("40001", "erp_finance_version_conflict");
      db.exec('UPDATE "erp_finance__bordero_item" SET category_id=? WHERE settlement_id=?', category, target);
    } else raise("22023", "erp_finance_invalid_data");
    setFlag(ctx, "erp_finance.reclassify", "");
    result = { entity: "statement", record: { line_kind: lineKind, line_id: id, category_id: category } };
  }

  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

registerRpc("erp_finance_cash_execute", erpFinanceCashExecute);
