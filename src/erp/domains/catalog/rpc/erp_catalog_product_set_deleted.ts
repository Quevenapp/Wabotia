// public.erp_catalog_product_set_deleted: exclusão lógica do produto (e a
// restauração). O produto excluído fica inativo e só leitura; o ciclo de
// vida liga erp_catalog.product_lifecycle para passar pelo guard_deleted_product.
// Fora (Origin desligado): o UPDATE de erp_catalog.origin (tabela vazia).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { boolArg, intArg, uuidArg } from "../pricing/args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import { capture, productFull } from "../internal.ts";
import { requireAccess } from "../pricing/deps.ts";
import { updateRecord } from "../record.ts";

const MAX_VERSION = 2147483647;

export function erpCatalogProductSetDeleted(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const deleted = boolArg(a, "p_deleted");
  const db = ctx.db;
  requireAccess(db, user, "products", true);
  if (id === null || command === null || deleted === null || expected === null || expected < 1)
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ actor: user, action: "product_set_deleted", id, version: expected, deleted });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  const row = one(
    db,
    `SELECT name, code, active, CAST(version AS TEXT) version FROM "erp_catalog__record" WHERE id=? AND entity='products'`,
    id,
  );
  if (!row) raise("P0002", "erp_catalog_not_found");
  if (Number(row.version) !== expected) raise("40001", "erp_catalog_version_conflict");
  const isDeleted = one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', id) !== null;
  if (isDeleted !== deleted) {
    if (Number(row.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
    ctx.settings.set("erp_catalog.product_lifecycle", "on");
    const before = productFull(db, id);
    if (!one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=?', id)) {
      db.exec('INSERT INTO "erp_catalog__product_detail"(record_id) VALUES(?)', id);
      capture(ctx, id, "upsert"); // zz_origin_sync de product_detail (INSERT)
    }
    db.exec(
      'UPDATE "erp_catalog__product_detail" SET deleted_at=?, deleted_by=? WHERE record_id=?',
      deleted ? ctx.clock.next().toString() : null,
      deleted ? user : null,
      id,
    );
    capture(ctx, id, "upsert"); // zz_origin_sync de product_detail (UPDATE)
    updateRecord(
      ctx,
      id,
      { entity: "products", active: Number(row.active) === 1 },
      { name: String(row.name), code: (row.code as string | null) ?? null, active: !deleted },
      user!,
    );
    db.exec(
      `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      user,
      command,
      "products",
      id,
      deleted ? "delete" : "undelete",
      before === null ? null : jsonbText(before),
      jsonbText(productFull(db, id)),
      ctx.clock.next().toString(),
    );
    ctx.settings.set("erp_catalog.product_lifecycle", "");
  }
  const result = { entity: "products", record: productFull(db, id), replayed: false, data_mode: "erp_native" };
  storeCommand(ctx, command, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_product_set_deleted", erpCatalogProductSetDeleted);
