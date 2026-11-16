// public.erp_catalog_product_image_order: nova ordem das imagens prontas
// (todas, uma vez cada), com recibo do comando.
//
// No Postgres a posição única é conferida no commit e as imagens mudam uma a
// uma. Aqui ela é imediata: primeiro todas saem de posição por um estado que
// os CHECKs aceitam (pronta, "excluída" e sem posição), depois cada uma entra
// na nova posição e volta a não excluída. O estado final é o mesmo.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { uuidArg } from "../pricing/args.ts";
import { requestHash } from "../command.ts";
import { compareText } from "../fields.ts";
import { uuidArrayArg } from "../pricing/args.ts";
import { imageAudit, imageAuthorize, imagesData } from "../product-images.ts";

export function erpCatalogProductImageOrder(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const command = uuidArg(a, "p_command_id");
  const ids = uuidArrayArg(a, "p_ids");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  if (command === null || ids === null || ids.length < 1 || ids.length > 20 || ids.includes(null) || new Set(ids).size !== ids.length)
    raise("22023", "erp_attachment_invalid_action");
  const order = ids as string[];
  const hash = requestHash({ actor: user, action: "image_order", product_id: product, ids: order });
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_catalog__product_image_command" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_attachment_command_conflict");
    return { ...(JSON.parse(String(stored.result)) as Record<string, unknown>), replayed: true };
  }
  if (one(db, 'SELECT 1 x FROM "erp_catalog__product_stored_image" WHERE command_id=? OR delete_command_id=?', command, command))
    raise("40001", "erp_attachment_command_conflict");
  const current = db
    .exec('SELECT id FROM "erp_catalog__product_stored_image" WHERE product_id=? AND position IS NOT NULL', product)
    .rows.map((r) => String(r.id))
    .sort(compareText);
  if (jsonbText(current) !== jsonbText([...order].sort(compareText))) raise("40001", "erp_attachment_order_conflict");
  const parked = ctx.clock.next().toString();
  for (const id of order)
    db.exec(
      'UPDATE "erp_catalog__product_stored_image" SET position=NULL, deleted_at=?, deleted_by=? WHERE id=?',
      parked,
      user,
      id,
    );
  order.forEach((id, n) =>
    db.exec(
      'UPDATE "erp_catalog__product_stored_image" SET position=?, deleted_at=NULL, deleted_by=NULL WHERE id=?',
      n + 1,
      id,
    ),
  );
  const result = { ...imagesData(db, product!), replayed: false };
  imageAudit(db, ctx.clock.next(), {
    image: null,
    product: product!,
    actor: user!,
    action: "order",
    command,
    after: jsonbText({ ids: order }),
  });
  db.exec(
    'INSERT INTO "erp_catalog__product_image_command"(command_id, actor, request_hash, result, created_at) VALUES (?,?,?,?,?)',
    command,
    user,
    hash,
    jsonbText(result),
    ctx.clock.next().toString(),
  );
  return result;
}

registerRpc("erp_catalog_product_image_order", erpCatalogProductImageOrder);
