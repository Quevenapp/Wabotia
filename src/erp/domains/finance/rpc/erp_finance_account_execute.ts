// public.erp_finance_account_execute: Contas Financeiras (criar, alterar,
// ativar/inativar, padrões de movimentações e de boletos, excluir sem uso).
// Fonte: 202610200135_finance_accounts_categories.sql e correções posteriores
// (versão final no catálogo do oráculo).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import {
  accountRow,
  accountText,
  accountView,
  bool,
  cents,
  charLength,
  CNTRL,
  day,
  expected,
  field,
  flushDeferred,
  hasKey,
  insertAccount,
  insertAudit,
  insertCommand,
  insertMovement,
  jsonArg,
  jsonBytes,
  keys,
  replayed,
  requestHash,
  requireAccess,
  txt,
  updateAccount,
  uuidArg,
  uuidValue,
} from "../internal.ts";

const ACTIONS = ["account_create", "account_update", "account_set_active", "account_set_default", "account_delete"];

export function erpFinanceAccountExecute(ctx: RpcContext, a: RpcArgs) {
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

  let id: string;
  let before: unknown = null;
  let account: Record<string, unknown> | null = null;

  if (action === "account_create" || action === "account_update") {
    if (action === "account_create")
      keys(data, ["account_type", "institution_code", "institution_name", "name", "agency", "account_number", "account_digit", "start_on", "opening_cents", "default_movements"]);
    else {
      keys(data, ["id", "expected_version", "account_type", "institution_code", "institution_name", "name", "agency", "account_number", "account_digit", "start_on", "opening_cents", "default_movements", "default_boleto"]);
      id = uuidValue(field(data, "id"))!;
      account = accountRow(db, id);
      if (!account || account.deleted_at !== null) raise("P0002", "erp_finance_not_found");
      if (account.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
      before = accountView(db, id);
    }
    const type = txt(data, "account_type", 20, true)!;
    if (!["checking", "savings", "cash", "receiving", "other"].includes(type)) raise("22023", "erp_finance_invalid_kind");
    const kind = type === "checking" || type === "savings" ? "bank" : type === "cash" ? "cash" : "other";
    let code = accountText(data, "institution_code", /^[0-9]{3}$/);
    let institution = txt(data, "institution_name", 80);
    if (["checking", "savings", "receiving"].includes(type) && (code === null || institution === null))
      raise("22023", "erp_finance_institution_required");
    if (type === "cash" || type === "other") {
      code = null;
      institution = null;
    }
    if ((code === null) !== (institution === null) || (institution !== null && CNTRL.test(institution)))
      raise("22023", "erp_finance_invalid_text");
    let agency = accountText(data, "agency", /^[0-9A-Za-z-]{1,10}$/);
    let number = accountText(data, "account_number", /^[0-9A-Za-z.-]{1,20}$/);
    let digit = accountText(data, "account_digit", /^[0-9A-Za-z]{1,2}$/);
    if (kind === "bank" && (agency === null || number === null || digit === null)) raise("22023", "erp_finance_bank_data_required");
    if (kind !== "bank") {
      agency = null;
      number = null;
      digit = null;
    }
    const name = txt(data, "name", 200, true)!;
    // Origin: Descrição com até 50 caracteres; nomes antigos mais longos só mudam quando editados.
    if (charLength(name) > 50 && (action === "account_create" || name !== account!.name)) raise("22023", "erp_finance_invalid_text");
    const start = day(field(data, "start_on"), true);
    const defaultMovements = field(data, "default_movements");
    if (defaultMovements !== undefined && jsonType(defaultMovements) !== "boolean") raise("22023", "erp_finance_invalid_data");
    const isDefault = defaultMovements === true;

    if (action === "account_create") {
      if (!hasKey(data, "opening_cents")) raise("22023", "erp_finance_invalid_cents");
      const opening = cents(field(data, "opening_cents"), true, true);
      if (isDefault) clearDefault(ctx, "default_movements", null);
      id = insertAccount(ctx, {
        name,
        kind,
        account_type: type,
        institution_code: code,
        institution_name: institution,
        agency,
        account_number: number,
        account_digit: digit,
        start_on: start,
        opening_recorded: true,
        default_movements: isDefault,
      });
      insertMovement(ctx, { account_id: id, kind: "opening", delta_cents: opening, posted_on: start, note: "Saldo inicial", actor: user, command_id: command });
    } else {
      const old = account!;
      const profile = one(db, 'SELECT identity FROM "erp_cnab__profile" WHERE account_id=?', id!);
      const identity = profile ? JSON.parse(String(profile.identity)) : null;
      const idText = (k: string) => (identity?.[k] === undefined || identity?.[k] === null ? null : String(identity[k]));
      if (
        profile &&
        (kind !== "bank" || agency !== idText("agency") || number !== idText("account") || digit !== idText("accountDigit"))
      )
        raise("22023", "erp_finance_account_profile_mismatch");
      // "Tornar padrão de emissão de boletos": só conta bancária com cobrança (perfil CNAB) configurada.
      const boletoField = field(data, "default_boleto");
      if (boletoField !== undefined && jsonType(boletoField) !== "boolean") raise("22023", "erp_finance_invalid_data");
      const boleto = boletoField === undefined ? bool(old.default_boleto) : (boletoField as boolean);
      if (boleto && (kind !== "bank" || !profile || !bool(old.active))) raise("22023", "erp_finance_boleto_profile_required");
      if (boleto && !bool(old.default_boleto)) clearDefault(ctx, "default_boleto", id!);
      const first = one(db, 'SELECT min(posted_on) first FROM "erp_finance__movement" WHERE account_id=?', id!)!.first as string | null;
      if (first !== null && start > first) raise("22023", "erp_finance_start_after_movement");
      let opening: number | null = null;
      if (hasKey(data, "opening_cents")) {
        if (bool(old.opening_recorded) || !bool(old.active)) raise("40001", "erp_finance_opening_conflict");
        opening = cents(field(data, "opening_cents"), true, true);
      }
      if (isDefault && !bool(old.default_movements)) {
        if (!bool(old.active)) raise("22023", "erp_finance_invalid_account");
        clearDefault(ctx, "default_movements", id!);
      }
      updateAccount(ctx, id!, {
        name,
        kind,
        account_type: type,
        institution_code: code,
        institution_name: institution,
        agency,
        account_number: number,
        account_digit: digit,
        start_on: start,
        default_movements: isDefault,
        default_boleto: boleto,
        opening_recorded: bool(old.opening_recorded) || opening !== null,
      });
      if (opening !== null)
        insertMovement(ctx, { account_id: id!, kind: "opening", delta_cents: opening, posted_on: start, note: "Saldo inicial", actor: user, command_id: command });
    }
  } else {
    keys(
      data,
      action === "account_set_active"
        ? ["id", "expected_version", "active"]
        : action === "account_set_default"
          ? ["id", "expected_version", "target", "value"]
          : ["id", "expected_version"],
    );
    id = uuidValue(field(data, "id"))!;
    account = accountRow(db, id);
    if (!account || account.deleted_at !== null) raise("P0002", "erp_finance_not_found");
    if (account.version !== expected(field(data, "expected_version"))) raise("40001", "erp_finance_version_conflict");
    before = accountView(db, id);
    if (action === "account_set_active") {
      const active = field(data, "active");
      if (jsonType(active) !== "boolean") raise("22023", "erp_finance_invalid_active");
      if (active === bool(account.active)) raise("40001", "erp_finance_version_conflict");
      // Inativar tira a conta dos padrões, como no Origin.
      updateAccount(ctx, id, {
        active,
        default_movements: bool(account.default_movements) && (active as boolean),
        default_boleto: bool(account.default_boleto) && (active as boolean),
      });
    } else if (action === "account_set_default") {
      const target = txt(data, "target", 20, true)!;
      const value = field(data, "value");
      if (!["movements", "boleto"].includes(target) || jsonType(value) !== "boolean") raise("22023", "erp_finance_invalid_data");
      if (value && !bool(account.active)) raise("22023", "erp_finance_invalid_account");
      if (
        target === "boleto" &&
        value &&
        (account.kind !== "bank" || !one(db, 'SELECT 1 x FROM "erp_cnab__profile" WHERE account_id=?', id))
      )
        raise("22023", "erp_finance_boleto_profile_required");
      const column = target === "movements" ? "default_movements" : "default_boleto";
      if (value === bool(account[column])) raise("40001", "erp_finance_version_conflict");
      if (value) clearDefault(ctx, column, id);
      updateAccount(ctx, id, { [column]: value });
    } else {
      // Excluir: só conta sem uso (o saldo inicial não conta). O saldo inicial é compensado na mesma data.
      if (
        (before as { in_use: boolean }).in_use ||
        one(db, 'SELECT 1 x FROM "erp_finance__transfer" WHERE from_account_id=? OR to_account_id=? LIMIT 1', id, id)
      )
        raise("40001", "erp_finance_account_in_use");
      updateAccount(ctx, id, {
        active: false,
        default_movements: false,
        default_boleto: false,
        deleted_at: ctx.clock.next().toString(),
        deleted_by: user,
      });
      const openings = db.exec(
        `SELECT m.id, m.account_id, m.delta_cents, m.posted_on FROM "erp_finance__movement" m WHERE m.account_id=? AND m.kind='opening' AND m.delta_cents<>0 AND NOT EXISTS(SELECT 1 FROM "erp_finance__movement" c WHERE c.compensates_id=m.id)`,
        id,
      ).rows;
      for (const m of openings)
        insertMovement(ctx, {
          account_id: String(m.account_id),
          kind: "opening_reversal",
          delta_cents: -Number(m.delta_cents),
          posted_on: String(m.posted_on),
          note: "Conta excluída",
          actor: user,
          command_id: command,
          compensates_id: String(m.id),
        });
    }
  }

  requireAccess(db, user, true);
  const result = {
    entity: "financial_accounts",
    record: action === "account_delete" ? { id: id!, deleted: true } : accountView(db, id!),
    action,
    data_mode: "erp_native",
    replayed: false,
  };
  insertCommand(ctx, command, user, hash, result);
  insertAudit(ctx, user, command, action, before, result);
  flushDeferred(ctx);
  return result;
}

/** update account set <coluna>=false,version=version+1,updated_at=… where <coluna> [and id<>?] */
function clearDefault(ctx: RpcContext, column: "default_movements" | "default_boleto", except: string | null) {
  const rows = ctx.db.exec(`SELECT id FROM "erp_finance__account" WHERE ${column}=1 AND id IS NOT ?`, except).rows;
  for (const r of rows) updateAccount(ctx, String(r.id), { [column]: false });
}

registerRpc("erp_finance_account_execute", erpFinanceAccountExecute);
