// public.erp_catalog_payment_method_save
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonArg } from "../args.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import {
  accountActive,
  inputColumns,
  insertRow,
  paymentMethodAccess,
  paymentMethodDto,
  paymentMethodInput,
  readRow,
  updateRow,
} from "../payment-method.ts";

const MAX_VERSION = 2147483647;
/** payment_method_dto - id - version - account_name - active - is_default - created_at - updated_at */
const OMIT = ["id", "version", "account_name", "active", "is_default", "created_at", "updated_at"];

export function erpCatalogPaymentMethodSave(ctx: RpcContext, a: RpcArgs) {
  const user = ((a.p_user_id ?? null) as string | null);
  const id = ((a.p_id ?? null) as string | null);
  const expected = ((a.p_expected_version ?? null) as number | null);
  const command = ((a.p_command_id ?? null) as string | null);
  const data = jsonArg(a, "p_data");
  const db = ctx.db;
  paymentMethodAccess(db, user, true);
  if (
    command === null || expected === null || (id === null && expected !== 0) ||
    (id !== null && (expected < 1 || expected > MAX_VERSION))
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-payment-method-save-v1", actor: user, id, version: expected, data });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const v = paymentMethodInput(data);
  const row = id === null ? null : readRow(db, id);
  if (id !== null) {
    if (!row) raise("P0002", "erp_catalog_not_found");
    if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
    if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
  }
  if (v.account_id !== null && v.account_id !== (row?.account_id ?? null) && !accountActive(db, v.account_id))
    raise("22023", "erp_catalog_payment_method_invalid:account_id");
  let target: string;
  if (id === null) {
    target = insertRow(ctx, user!, v);
    auxiliaryAudit(ctx, {
      actor: user!, command, subject: "payment_method", subjectId: target, action: "create", after: paymentMethodDto(db, target),
    });
  } else {
    target = id;
    const before = paymentMethodDto(db, id)!;
    const form = Object.fromEntries(Object.entries(before).filter(([k]) => !OMIT.includes(k)));
    if (jsonbText(form) !== jsonbText(v)) {
      updateRow(ctx, id, {
        ...inputColumns(v),
        version: Number(row!.version) + 1,
        updated_by: user,
        updated_at: ctx.clock.next().toString(),
      });
      auxiliaryAudit(ctx, {
        actor: user!, command, subject: "payment_method", subjectId: id, action: "update", before, after: paymentMethodDto(db, id),
      });
    }
  }
  const result = { entity: "payment_methods", data_mode: "erp_native", replayed: false, item: paymentMethodDto(db, target) };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_payment_method_save", erpCatalogPaymentMethodSave);
