// public.erp_catalog_save_checked: o erp_catalog_save com os avisos
// confirmados (duplicate_code, duplicate_gtin, invalid_document, duplicate_document).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { warnings } from "../contact-core.ts";
import { validateData } from "../internal.ts";
import { mutate } from "../record.ts";

const CODES = ["duplicate_code", "duplicate_gtin", "invalid_document", "duplicate_document"];

export function erpCatalogSaveChecked(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const entity = (a.p_entity ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const data = jsonArg(a, "p_data");
  const ack = jsonArg(a, "p_acknowledged");
  const db = ctx.db;
  requireAccess(db, user, entity, true);
  const list = ack as unknown[];
  if (
    entity === null || !["contacts", "products"].includes(entity) || command === null || ack === null || jsonType(ack) !== "array" ||
    list.length > 4 || list.some((x) => jsonType(x) !== "string" || !CODES.includes(x as string)) ||
    new Set(list.map((x) => jsonbText(x))).size !== list.length
  )
    raise("22023", "erp_catalog_invalid_command");
  const call = () => mutate(ctx, { user, entity, id, expected, command, data, setActive: false, active: null });
  if (
    one(db, 'SELECT 1 x FROM "erp_catalog__command" WHERE command_id=?', command) ||
    (id !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity=?', id, entity))
  )
    return call();
  const codes = warnings(db, entity, id, validateData(entity, data, false)).map((w) => w.code);
  if (codes.some((c) => !list.includes(c))) raise("40001", "erp_catalog_warning_unacknowledged");
  const result = call();
  if (codes.length > 0)
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,?,?,'warnings_acknowledged',NULL,?,?)`,
      user, command, entity, (result.record as Record<string, unknown> | null)?.id ?? null, jsonbText({ warnings: codes }),
      ctx.clock.next().toString(),
    );
  return result;
}

registerRpc("erp_catalog_save_checked", erpCatalogSaveChecked);
