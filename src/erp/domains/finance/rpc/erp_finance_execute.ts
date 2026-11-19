// public.erp_finance_execute: o escritor 010 (contas e categorias simples,
// grupo de contas, alterar, cancelar, baixar, estornar e saldo inicial).
// Continua em uso: a gaveta e o borderô não cobrem tudo, e a erp-api chama.
import { one } from "../../../engine/driver.ts";
import { moduleFinanceAudit as insertAudit, moduleFinancialGuard, moduleUpdateTitle as updateTitle } from "../module-posting.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  accountRow,
  bool,
  categoryRow,
  cents,
  day,
  expected,
  field,
  hasKey,
  insertAccount,
  insertCategory,
  insertCommand,
  insertMovement,
  jsonArg,
  jsonBytes,
  keys,
  requestHash,
  requireAccess,
  txt,
  updateAccount,
  updateCategory,
  uuidArg,
  uuidValue,
  isReserved,
} from "../internal.ts";
import { insertSettlement, postSettlementMovements } from "../settlements.ts";
import { activeContact, dto, insertTitle, projectResultLink } from "../titles.ts";

const ACTIONS = ["account_save", "category_save", "title_create_group", "title_update", "title_cancel", "settle", "reverse", "opening"];
const ZERO = "0";

export function erpFinanceExecute(ctx: RpcContext, a: RpcArgs) {
  const db = ctx.db;
  const user = uuidArg(a.p_user_id)!;
  const command = uuidArg(a.p_command_id);
  const action = (a.p_action as string | null) ?? null;
  const data = a.p_data === undefined || a.p_data === null ? null : jsonArg(a.p_data);
  moduleFinancialGuard(ctx, action, data);

  requireAccess(db, user, true);
  if (command === null || action === null || !ACTIONS.includes(action)) raise("22023", "erp_finance_invalid_action");
  if (data === null || jsonType(data) !== "object" || jsonBytes(data) > 65536) raise("22023", "erp_finance_invalid_data");
  const hash = requestHash(user, action, data);
  requireAccess(db, user, true);
  const receipt = one(db, 'SELECT actor, request_hash, result FROM "erp_finance__command" WHERE id=?', command);
  if (receipt && !isReserved(ctx, command)) {
    if (receipt.actor !== user || receipt.request_hash !== hash) raise("40001", "erp_finance_command_conflict");
    return { ...projectResultLink(db, JSON.parse(String(receipt.result))), replayed: true };
  }

  let result: Record<string, unknown> = {};
  let before: unknown = null;

  if (action === "account_save" || action === "category_save") {
    keys(data, ["id", "expected_version", "name", "kind", "active"]);
    let id = uuidValue(field(data, "id"), false);
    const version = expected(field(data, "expected_version"), id === null);
    const name = txt(data, "name", 200, true)!;
    const kind = txt(data, "kind", 20, true)!;
    if (hasKey(data, "active") && jsonType(field(data, "active")) !== "boolean") raise("22023", "erp_finance_invalid_active");
    const active = (field(data, "active") as boolean | undefined) ?? true;
    if (action === "account_save") {
      if (!["bank", "cash", "other"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
      if (id === null) id = insertAccount(ctx, { name, kind, active });
      else {
        const account = accountRow(db, id);
        if (!account) raise("P0002", "erp_finance_not_found");
        if (account.version !== version) raise("40001", "erp_finance_version_conflict");
        before = dto(db, "accounts", id);
        updateAccount(ctx, id, { name, kind, active: hasKey(data, "active") ? active : bool(account.active) });
      }
      result = { entity: "accounts", record: dto(db, "accounts", id) };
    } else {
      if (!["receivable", "payable", "both"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
      // Desde a 135 uma categoria é de receita ou de despesa: o CHECK
      // category_kind_split recusa "both" na gravação (camada de tabela).
      if (id === null) id = insertCategory(ctx, { name, kind, parent_id: null, dre_group: null, active });
      else {
        const category = categoryRow(db, id);
        if (!category) raise("P0002", "erp_finance_not_found");
        if (category.version !== version) raise("40001", "erp_finance_version_conflict");
        if (one(db, 'SELECT 1 x FROM "erp_finance__title" WHERE category_id=? AND kind<>? LIMIT 1', id, kind))
          raise("40001", "erp_finance_category_in_use");
        before = dto(db, "categories", id);
        updateCategory(ctx, id, { name, kind, active: hasKey(data, "active") ? active : bool(category.active) });
      }
      result = { entity: "categories", record: dto(db, "categories", id) };
    }
  } else if (action === "title_create_group") {
    keys(data, ["kind", "contact_id", "category_id", "description", "source_reference", "issued_on", "total_cents", "installments"]);
    const kind = txt(data, "kind", 20, true)!;
    const contact = uuidValue(field(data, "contact_id"))!;
    const category = uuidValue(field(data, "category_id"), false);
    if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    if (!activeContact(db, contact)) raise("22023", "erp_finance_invalid_contact");
    if (category !== null && !one(db, `SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND kind IN (?, 'both')`, category, kind))
      raise("22023", "erp_finance_invalid_category");
    const issued = day(field(data, "issued_on"));
    const amount = cents(field(data, "total_cents"), false);
    const description = txt(data, "description", 240, true)!;
    const reference = txt(data, "source_reference", 200);
    const installments = field(data, "installments");
    if (jsonType(installments) !== "array" || (installments as unknown[]).length < 1 || (installments as unknown[]).length > 120)
      raise("22023", "erp_finance_invalid_installments");
    const list = installments as unknown[];
    const group = crypto.randomUUID();
    const items: unknown[] = [];
    let total = 0;
    let index = 0;
    for (const item of list) {
      keys(item, ["amount_cents", "due_on"]);
      const part = cents(field(item, "amount_cents"), false);
      const due = day(field(item, "due_on"));
      if (due < issued) raise("22023", "erp_finance_invalid_due_date");
      index++;
      total += part;
      const id = insertTitle(ctx, {
        group_id: group,
        installment: index,
        installments: list.length,
        kind,
        contact_id: contact,
        category_id: category,
        description,
        source_reference: reference,
        issued_on: issued,
        due_on: due,
        amount_cents: part,
      });
      items.push(dto(db, "titles", id));
    }
    if (total !== amount) raise("22023", "erp_finance_installment_total_mismatch");
    result = { entity: "titles", group_id: group, items };
  } else if (["title_update", "title_cancel", "settle", "reverse"].includes(action)) {
    keys(
      data,
      action === "title_update"
        ? ["id", "expected_version", "description", "source_reference", "due_on", "amount_cents", "category_id"]
        : action === "title_cancel"
          ? ["id", "expected_version", "note"]
          : action === "settle"
            ? ["id", "expected_version", "account_id", "posted_on", "principal_cents", "interest_cents", "penalty_cents", "discount_cents", "fee_cents", "note"]
            : ["id", "expected_version", "settlement_id", "posted_on", "note"],
    );
    const id = uuidValue(field(data, "id"))!;
    const version = expected(field(data, "expected_version"));
    const title = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
    if (!title) raise("P0002", "erp_finance_not_found");
    if (title.version !== version) raise("40001", "erp_finance_version_conflict");
    if (bool(title.cancelled)) raise("40001", "erp_finance_cancelled_title");
    before = dto(db, "titles", id);
    let note: string | null = null;
    let settlement: string | null = null;
    let accountId: string | null = null;
    if (action === "title_update") {
      const amount = hasKey(data, "amount_cents") ? cents(field(data, "amount_cents"), false) : Number(title.amount_cents);
      if (
        amount !== Number(title.amount_cents) &&
        (Number(title.installments) > 1 || one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE title_id=? LIMIT 1', id))
      )
        raise("40001", "erp_finance_principal_locked");
      const due = hasKey(data, "due_on") ? day(field(data, "due_on")) : String(title.due_on);
      if (due < String(title.issued_on)) raise("22023", "erp_finance_invalid_due_date");
      const category = hasKey(data, "category_id") ? uuidValue(field(data, "category_id"), false) : (title.category_id as string | null);
      if (category !== null && !one(db, `SELECT 1 x FROM "erp_finance__category" WHERE id=? AND active=1 AND kind IN (?, 'both')`, category, title.kind))
        raise("22023", "erp_finance_invalid_category");
      const set: Record<string, unknown> = {};
      set.description = hasKey(data, "description") ? txt(data, "description", 240, true) : title.description;
      set.source_reference = hasKey(data, "source_reference") ? txt(data, "source_reference", 200) : title.source_reference;
      Object.assign(set, {
        due_on: due,
        amount_cents: amount,
        category_id: category,
        version: Number(title.version) + 1,
        updated_at: ctx.clock.next().toString(),
      });
      updateTitle(ctx, id, set);
    } else if (action === "title_cancel") {
      if (Number(title.settled_cents) !== 0) raise("40001", "erp_finance_active_payments");
      note = txt(data, "note", 500, true);
      updateTitle(ctx, id, { cancelled: true, version: Number(title.version) + 1, updated_at: ctx.clock.next().toString() });
    } else {
      const postedOn = day(field(data, "posted_on"), true);
      note = txt(data, "note", 500, action === "reverse");
      if (postedOn < String(title.issued_on)) raise("22023", "erp_finance_payment_before_issue");
      const kind = String(title.kind);
      let delta: number;
      if (action === "settle") {
        accountId = uuidValue(field(data, "account_id"))!;
        const account = accountRow(db, accountId);
        if (!account || !bool(account.active)) raise("22023", "erp_finance_invalid_account");
        if (one(db, `SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND kind='opening' AND posted_on>? LIMIT 1`, accountId, postedOn))
          raise("22023", "erp_finance_payment_before_opening");
        const principal = cents(field(data, "principal_cents"), false);
        // coalesce(p_data->'x','"0"'): só a chave ausente vira zero; null no JSON é inválido.
        const orZero = (k: string) => (field(data, k) === undefined ? ZERO : field(data, k));
        const interest = cents(orZero("interest_cents"));
        const penalty = cents(orZero("penalty_cents"));
        const discount = cents(orZero("discount_cents"));
        const fee = cents(orZero("fee_cents"));
        if (principal > Number(title.amount_cents) - Number(title.settled_cents)) raise("40001", "erp_finance_overpayment");
        const net = principal + interest + penalty - discount + (kind === "payable" ? fee : -fee);
        if (net < 0 || net > 999999999999999 || discount > principal + interest + penalty) raise("22023", "erp_finance_invalid_net_cash");
        requireAccess(db, user, true);
        settlement = insertSettlement(ctx, {
          title_id: id,
          account_id: accountId,
          kind: "payment",
          posted_on: postedOn,
          principal_cents: principal,
          interest_cents: interest,
          penalty_cents: penalty,
          discount_cents: discount,
          fee_cents: fee,
          net_cash_cents: net,
          note,
          actor: user,
          command_id: command,
        });
        delta = kind === "receivable" ? net : -net;
        updateTitle(ctx, id, {
          settled_cents: Number(title.settled_cents) + principal,
          version: Number(title.version) + 1,
          updated_at: ctx.clock.next().toString(),
        });
      } else {
        const originalId = uuidValue(field(data, "settlement_id"))!;
        const original = one(db, 'SELECT * FROM "erp_finance__settlement" WHERE id=? AND title_id=?', originalId, id);
        if (!original) raise("P0002", "erp_finance_not_found");
        if (original.kind !== "payment" || one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE reverses_id=? LIMIT 1', original.id))
          raise("40001", "erp_finance_reversal_conflict");
        if (postedOn < String(original.posted_on)) raise("22023", "erp_finance_invalid_reversal_date");
        accountId = String(original.account_id);
        requireAccess(db, user, true);
        settlement = insertSettlement(ctx, {
          title_id: id,
          account_id: accountId,
          kind: "reversal",
          reverses_id: String(original.id),
          posted_on: postedOn,
          principal_cents: Number(original.principal_cents),
          interest_cents: Number(original.interest_cents),
          penalty_cents: Number(original.penalty_cents),
          discount_cents: Number(original.discount_cents),
          fee_cents: Number(original.fee_cents),
          net_cash_cents: Number(original.net_cash_cents),
          note,
          actor: user,
          command_id: command,
        });
        delta = kind === "receivable" ? -Number(original.net_cash_cents) : Number(original.net_cash_cents);
        updateTitle(ctx, id, {
          settled_cents: Number(title.settled_cents) - Number(original.principal_cents),
          version: Number(title.version) + 1,
          updated_at: ctx.clock.next().toString(),
        });
      }
      postSettlementMovements(ctx, settlement, delta);
      updateAccount(ctx, accountId, {});
    }
    result = { entity: "titles", record: dto(db, "titles", id), note };
    if (settlement !== null)
      result = { ...result, settlement: dto(db, "settlements", settlement), account: dto(db, "accounts", accountId!) };
  } else {
    // opening
    keys(data, ["id", "expected_version", "amount_cents", "posted_on", "note"]);
    const id = uuidValue(field(data, "id"))!;
    const version = expected(field(data, "expected_version"));
    const postedOn = day(field(data, "posted_on"), true);
    const amount = cents(field(data, "amount_cents"), true, true);
    const note = txt(data, "note", 500, true);
    const account = accountRow(db, id);
    if (!account) raise("P0002", "erp_finance_not_found");
    if (account.version !== version || bool(account.opening_recorded) || !bool(account.active)) raise("40001", "erp_finance_opening_conflict");
    if (one(db, 'SELECT 1 x FROM "erp_finance__movement" WHERE account_id=? AND posted_on<? LIMIT 1', id, postedOn))
      raise("22023", "erp_finance_opening_after_movement");
    before = dto(db, "accounts", id);
    insertMovement(ctx, { account_id: id, kind: "opening", delta_cents: amount, posted_on: postedOn, note, actor: user, command_id: command });
    updateAccount(ctx, id, { opening_recorded: true });
    result = { entity: "accounts", record: dto(db, "accounts", id) };
  }

  // Um papel pode ter sido revogado enquanto um bloqueio esperava; a falha
  // desfaz tudo antes do recibo do comando.
  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

registerRpc("erp_finance_execute", erpFinanceExecute);
