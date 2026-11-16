// public.erp_catalog_product_image_delete: exclusão lógica de uma imagem
// pronta (fica na trilha); as seguintes sobem uma posição.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { uuidArg } from "../args.ts";
import { imageAudit, imageAuthorize, imageDto, imageRow } from "../product-images.ts";

export function erpCatalogProductImageDelete(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const id = uuidArg(a, "p_id");
  const command = uuidArg(a, "p_command_id");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  if (command === null) raise("22023", "erp_attachment_invalid_action");
  const v = imageRow(db, product, id);
  if (v.delete_command_id !== null && v.delete_command_id === command) {
    if (v.deleted_by !== user) raise("40001", "erp_attachment_command_conflict");
    return { image: imageDto(db, id!), replayed: true, data_mode: "erp_native" };
  }
  if (
    one(db, 'SELECT 1 x FROM "erp_catalog__product_stored_image" WHERE delete_command_id=? OR command_id=?', command, command) ||
    one(db, 'SELECT 1 x FROM "erp_catalog__product_image_command" WHERE command_id=?', command)
  )
    raise("40001", "erp_attachment_command_conflict");
  if (v.status !== "ready" || v.deleted_at !== null) raise("40001", "erp_attachment_not_ready");
  db.exec(
    'UPDATE "erp_catalog__product_stored_image" SET deleted_at=?, deleted_by=?, delete_command_id=?, position=NULL WHERE id=?',
    ctx.clock.next().toString(),
    user,
    command,
    id,
  );
  // Em ordem crescente: a posição de cima já está livre (a única é imediata aqui).
  for (const next of db.exec(
    'SELECT id, position FROM "erp_catalog__product_stored_image" WHERE product_id=? AND position>? ORDER BY position',
    product,
    v.position,
  ).rows)
    db.exec('UPDATE "erp_catalog__product_stored_image" SET position=? WHERE id=?', Number(next.position) - 1, next.id);
  imageAudit(db, ctx.clock.next(), { image: id, product: product!, actor: user!, action: "delete", command });
  return { image: imageDto(db, id!), replayed: false, data_mode: "erp_native" };
}

registerRpc("erp_catalog_product_image_delete", erpCatalogProductImageDelete);
