// public.erp_catalog_payment_method_action: forma padrão de cada finalidade
// (troca atômica), ativar, inativar e excluir (arquiva: deleted_at).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { paymentMethodAccess, paymentMethodDto, readRow, updateRow } from "../payment-method.ts";

const MAX_VERSION = 2147483647;
const ACTIONS = [
  "default", "default_recebimentos", "default_pagamentos", "default_devolucoes", "clear_devolucoes", "activate",
  "inactivate", "delete",
];
const COLUMN: Record<string, string> = {
  default_recebimentos: "default_receipt",
  default_pagamentos: "default_payment",
  default_devolucoes: "default_return",
};
const RECEIVES = ["recebimentos", "ambos"];
const PAYS = ["pagamentos", "ambos"];

export function erpCatalogPaymentMethodAction(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const id = ((a.p_id ?? null) as string | null);
  const expected = ((a.p_expected_version ?? null) as number | null);
  const command = ((a.p_command_id ?? null) as string | null);
  const action = ((a.p_action ?? null) as string | null);
  const db = ctx.db;
  paymentMethodAccess(db, user, true);
  if (
    id === null || command === null || expected === null || expected < 1 || expected > MAX_VERSION ||
    action === null || !ACTIONS.includes(action)
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-payment-method-action-v1", actor: user, id, version: expected, action });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const row = readRow(db, id);
  if (!row) raise("P0002", "erp_catalog_not_found");
  if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
  if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
  const before = paymentMethodDto(db, id);
  const touch = (target: string, changes: Record<string, string | number | null>) => {
    const current = readRow(db, target, false)!;
    updateRow(ctx, target, {
      ...changes,
      version: Number(current.version) + 1,
      updated_by: user,
      updated_at: ctx.clock.next().toString(),
    });
  };
  let previous: string | null = null;
  if (action.startsWith("default")) {
    if (!Number(row.active)) raise("22023", "erp_catalog_payment_method_inactive");
    const column = COLUMN[action] ?? (RECEIVES.includes(String(row.applicable)) ? "default_receipt" : "default_payment");
    if (
      (["default_receipt", "default_return"].includes(column) && !RECEIVES.includes(String(row.applicable))) ||
      (column === "default_payment" && !PAYS.includes(String(row.applicable)))
    )
      raise("22023", "erp_catalog_payment_method_purpose");
    if (!Number(row[column])) {
      const prev = one(db, `SELECT id FROM "erp_catalog__payment_method" WHERE ${column}=1`);
      previous = prev ? String(prev.id) : null;
      if (previous !== null) touch(previous, { [column]: 0 });
      touch(id, { [column]: 1 });
    }
  } else if (action === "clear_devolucoes") {
    if (Number(row.default_return)) touch(id, { default_return: 0 });
  } else if (action === "activate") {
    if (!Number(row.active)) touch(id, { active: 1 });
  } else if (action === "inactivate") {
    if (Number(row.active)) touch(id, { active: 0 });
  } else {
    const now = ctx.clock.next().toString();
    touch(id, { deleted_by: user, deleted_at: now });
  }
  const result = {
    entity: "payment_methods",
    data_mode: "erp_native",
    replayed: false,
    id,
    action,
    item: paymentMethodDto(db, id),
    previous_default: previous,
  };
  auxiliaryAudit(ctx, {
    actor: user!,
    command,
    subject: "payment_method",
    subjectId: id,
    action: action === "delete" ? "archive" : action === "activate" || action === "inactivate" ? action : "default",
    before,
    after: result.item,
  });
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_payment_method_action", erpCatalogPaymentMethodAction);
