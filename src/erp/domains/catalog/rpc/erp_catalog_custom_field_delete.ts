// public.erp_catalog_custom_field_delete: exclui a definição que nenhum
// produto usa; com valores gravados, responde in_use sem gravar recibo.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { customFieldItem, requireCustomFieldPermission } from "../custom-fields.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogCustomFieldDelete(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  requireCustomFieldPermission(db, user, "ex");
  if (id === null || command === null || expected === null || expected < 1 || expected > MAX_VERSION)
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ actor: user, action: "custom_field_delete", id, version: expected });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const row = one(db, 'SELECT CAST(version AS TEXT) version FROM "erp_catalog__custom_field" WHERE id=?', id);
  if (!row) raise("P0002", "erp_catalog_not_found");
  if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
  const used = Number(one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__product_custom_value" WHERE field_id=?', id)!.n);
  if (used > 0) return { id, deleted: false, reason: "in_use", products: used, replayed: false, data_mode: "erp_native" };
  const before = customFieldItem(db, id);
  db.exec('DELETE FROM "erp_catalog__custom_field" WHERE id=?', id);
  db.exec(
    `INSERT INTO "erp_catalog__custom_field_audit"(actor, command_id, field_id, action, before_data, after_data, created_at)
     VALUES (?,?,?,'delete',?,NULL,?)`,
    user,
    command,
    id,
    jsonbText(before),
    ctx.clock.next().toString(),
  );
  const result = { id, deleted: true, products: 0, replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_custom_field_delete", erpCatalogCustomFieldDelete);
