// public.erp_catalog_contact_save: o formulário de contato (criar ou alterar
// por patch), com avisos de documento e a confirmação deles.
import { raise } from "../../../engine/errors.ts";
import { jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { acknowledgedValid, contactApply } from "../contact-core.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogContactSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const data = jsonArg(a, "p_data");
  const acknowledged = jsonArg(a, "p_acknowledged");
  requireAccess(ctx.db, user, "contacts", true);
  if (
    command === null || expected === null || (id === null && expected !== 0) ||
    (id !== null && (expected < 1 || expected > MAX_VERSION)) ||
    data === null || jsonType(data) !== "object" || Object.keys(data as object).length === 0 || !acknowledgedValid(acknowledged)
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ profile: "erp-contact-save-v1", actor: user, id, version: expected, data, acknowledged });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const result = {
    entity: "contacts",
    record: contactApply(ctx, user!, id, expected, command, data, acknowledged),
    replayed: false,
    data_mode: "erp_native",
  };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_contact_save", erpCatalogContactSave);
