// public.erp_finance_title_execute: a gaveta de contas a pagar e a receber
// (criar em parcelas, editar com as travas do documento, da importação, do
// boleto e das baixas, e excluir logicamente).
import { one } from "../../../engine/driver.ts";
import { moduleFinanceAudit as insertAudit, moduleFinancialGuard } from "../module-posting.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  bool,
  cents,
  day,
  expected,
  field,
  hasKey,
  insertCommand,
  jsonArg,
  jsonBytes,
  keys,
  requestHash,
  requireAccess,
  txt,
  uuidArg,
  uuidValue,
} from "../internal.ts";
import {
  activeAccount,
  activeCategory,
  activeContact,
  bankNumber,
  bp,
  insertTitle,
  paymentMethodFor,
  projectResultLink,
  sellerFor,
  titleDto,
  titleInheritedSeller,
  titleText,
  updateTitle,
} from "../titles.ts";

const ACTIONS = ["title_create", "title_edit", "title_delete"];

export function erpFinanceTitleExecute(ctx: RpcContext, a: RpcArgs) {
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
  if (receipt) {
    if (receipt.actor !== user || receipt.request_hash !== hash) raise("40001", "erp_finance_command_conflict");
    return { ...projectResultLink(db, JSON.parse(String(receipt.result))), replayed: true };
  }

  let result: Record<string, unknown>;
  let before: unknown = null;

  if (action === "title_create") {
    keys(data, [
      "kind", "contact_id", "category_id", "account_id", "description", "source_reference", "bank_number",
      "issued_on", "competence_on", "interest_month_bp", "penalty_bp", "total_cents", "installments", "payment_method_id", "seller_id",
    ]);
    const kind = txt(data, "kind", 20, true)!;
    if (!["receivable", "payable"].includes(kind)) raise("22023", "erp_finance_invalid_kind");
    const contact = uuidValue(field(data, "contact_id"))!;
    if (!activeContact(db, contact)) raise("22023", "erp_finance_invalid_contact");
    const category = activeCategory(db, uuidValue(field(data, "category_id"), false), kind);
    const account = activeAccount(db, uuidValue(field(data, "account_id"), false));
    const method = paymentMethodFor(db, uuidValue(field(data, "payment_method_id"), false), kind, null);
    const seller = sellerFor(db, uuidValue(field(data, "seller_id"), false), kind, null);
    const issued = day(field(data, "issued_on"));
    const competence = day(field(data, "competence_on"));
    const amount = cents(field(data, "total_cents"), false, false);
    const text = titleText(data);
    const reference = txt(data, "source_reference", 200);
    const bank = bankNumber(data);
    const interest = bp(data, "interest_month_bp") ?? 0;
    const penalty = bp(data, "penalty_bp") ?? 0;
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
      const part = cents(field(item, "amount_cents"), false, false);
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
        description: text.description,
        source_reference: reference,
        issued_on: issued,
        due_on: due,
        amount_cents: part,
        competence_on: competence,
        account_id: account,
        bank_number: bank,
        interest_month_bp: interest,
        penalty_bp: penalty,
        original_due_on: due,
        payment_method_id: method,
        seller_id: seller,
        history: text.history,
      });
      items.push(titleDto(db, id));
    }
    if (total !== amount) raise("22023", "erp_finance_installment_total_mismatch");
    result = { entity: "titles", group_id: group, items };
  } else {
    if (action === "title_edit")
      keys(data, [
        "id", "expected_version", "contact_id", "category_id", "account_id", "description", "source_reference", "bank_number",
        "issued_on", "competence_on", "due_on", "amount_cents", "interest_month_bp", "penalty_bp", "payment_method_id", "seller_id",
      ]);
    else keys(data, ["id", "expected_version", "note"]);
    const id = uuidValue(field(data, "id"))!;
    const version = expected(field(data, "expected_version"));
    const title = one(db, 'SELECT * FROM "erp_finance__title" WHERE id=?', id);
    if (!title) raise("P0002", "erp_finance_not_found");
    if (title.version !== version) raise("40001", "erp_finance_version_conflict");
    if (title.deleted_at !== null) raise("40001", "erp_finance_deleted_title");
    const linked = !!one(db, 'SELECT 1 x FROM "erp_finance__document_title" WHERE title_id=? LIMIT 1', id);
    const imported = !!one(db, 'SELECT 1 x FROM "erp_finance__origin_import_origin" WHERE title_id=? LIMIT 1', id);
    const billed = !!one(db, 'SELECT 1 x FROM "erp_cnab__billing_title" WHERE title_id=? LIMIT 1', id);
    const settled = !!one(db, 'SELECT 1 x FROM "erp_finance__settlement" WHERE title_id=? LIMIT 1', id);
    before = titleDto(db, id);
    let note: string | null = null;

    if (action === "title_edit") {
      if (bool(title.cancelled)) raise("40001", "erp_finance_cancelled_title");
      const kind = String(title.kind);
      const contact = hasKey(data, "contact_id") ? uuidValue(field(data, "contact_id"))! : String(title.contact_id);
      const issued = hasKey(data, "issued_on") ? day(field(data, "issued_on")) : String(title.issued_on);
      const amount = hasKey(data, "amount_cents") ? cents(field(data, "amount_cents"), false, false) : Number(title.amount_cents);
      const reference = hasKey(data, "source_reference") ? txt(data, "source_reference", 200) : (title.source_reference as string | null);
      const bank = hasKey(data, "bank_number") ? bankNumber(data) : (title.bank_number as string | null);
      // Contato, emissão e valor ficam com o documento de origem, a importação, o boleto e as baixas.
      if (contact !== title.contact_id) {
        if (linked || imported || billed || settled) raise("40001", "erp_finance_contact_locked");
        if (!activeContact(db, contact)) raise("22023", "erp_finance_invalid_contact");
      }
      if (issued !== title.issued_on && (linked || imported || settled)) raise("40001", "erp_finance_issue_locked");
      if (amount !== Number(title.amount_cents) && (linked || imported || billed || settled)) raise("40001", "erp_finance_principal_locked");
      if (reference !== title.source_reference && (linked || imported)) raise("40001", "erp_finance_source_locked");
      if (bank !== title.bank_number && billed) raise("40001", "erp_finance_billed_locked");
      const due = hasKey(data, "due_on") ? day(field(data, "due_on")) : String(title.due_on);
      if (due < issued) raise("22023", "erp_finance_invalid_due_date");
      const category = hasKey(data, "category_id") ? uuidValue(field(data, "category_id"), false) : (title.category_id as string | null);
      if (category !== title.category_id) activeCategory(db, category, kind);
      const account = hasKey(data, "account_id") ? uuidValue(field(data, "account_id"), false) : (title.account_id as string | null);
      if (account !== title.account_id) activeAccount(db, account);
      const method = hasKey(data, "payment_method_id")
        ? paymentMethodFor(db, uuidValue(field(data, "payment_method_id"), false), kind, title.payment_method_id as string | null)
        : (title.payment_method_id as string | null);
      const seller = hasKey(data, "seller_id")
        ? sellerFor(db, uuidValue(field(data, "seller_id"), false), kind, title.seller_id as string | null)
        : (title.seller_id as string | null);
      // 246: limpar o vendedor de uma conta cujo documento tem vendedor guarda "sem vendedor".
      const sellerNone = hasKey(data, "seller_id")
        ? seller === null && kind === "receivable" && titleInheritedSeller(db, id) !== null
        : bool(title.seller_none);
      let description = title.description as string;
      let history = title.history as string | null;
      if (hasKey(data, "description")) ({ description, history } = titleText(data));
      const competence = hasKey(data, "competence_on") ? day(field(data, "competence_on")) : String(title.competence_on);
      const interest = bp(data, "interest_month_bp") ?? Number(title.interest_month_bp);
      const penalty = bp(data, "penalty_bp") ?? Number(title.penalty_bp);
      updateTitle(ctx, id, {
        contact_id: contact,
        issued_on: issued,
        amount_cents: amount,
        source_reference: reference,
        bank_number: bank,
        due_on: due,
        category_id: category,
        account_id: account,
        payment_method_id: method,
        seller_id: seller,
        seller_none: sellerNone,
        description,
        history,
        competence_on: competence,
        interest_month_bp: interest,
        penalty_bp: penalty,
        version: Number(title.version) + 1,
        updated_at: ctx.clock.next().toString(),
      });
    } else {
      // Exclusão lógica: só sem baixa ativa, fora de remessa e sem documento de origem ou importação.
      note = txt(data, "note", 500);
      if (Number(title.settled_cents) !== 0) raise("40001", "erp_finance_active_payments");
      if (billed) raise("40001", "erp_finance_billed_locked");
      if (linked || imported) raise("40001", "erp_finance_source_locked");
      const now = ctx.clock.next().toString();
      updateTitle(ctx, id, {
        cancelled: true,
        deleted_at: now,
        deleted_by: user,
        deleted_note: note,
        version: Number(title.version) + 1,
        updated_at: now,
      });
    }
    result = { entity: "titles", record: titleDto(db, id), note };
  }

  // O papel pode ter mudado; a falha desfaz tudo antes do recibo.
  requireAccess(db, user, true);
  result = { ...result, action, data_mode: "erp_native", replayed: false };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  return result;
}

registerRpc("erp_finance_title_execute", erpFinanceTitleExecute);
