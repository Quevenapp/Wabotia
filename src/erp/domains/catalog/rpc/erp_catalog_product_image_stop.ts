// public.erp_catalog_product_image_stop: desiste da reserva (p_abort) ou
// só solta a posse do envio (lease) de quem a tem.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { boolArg, uuidArg } from "../pricing/args.ts";
import { imageAudit, imageAuthorize, imageDto, imageRow, nowMicros } from "../product-images.ts";

export function erpCatalogProductImageStop(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const id = uuidArg(a, "p_id");
  const abort = boolArg(a, "p_abort");
  const lease = uuidArg(a, "p_lease");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  if (abort === null) raise("22023", "erp_attachment_invalid_action");
  const v = imageRow(db, product, id);
  if (abort) {
    if (v.status === "ready" || (v.lease_until !== null && BigInt(v.lease_until) > nowMicros()))
      raise("40001", "erp_attachment_upload_conflict");
    if (v.status !== "aborted") {
      const now = ctx.clock.next();
      db.exec(
        `UPDATE "erp_catalog__product_stored_image" SET status='aborted', lease_token=NULL, lease_actor=NULL, lease_until=NULL,
         finished_by=?, finished_at=? WHERE id=?`,
        user,
        now.toString(),
        id,
      );
      imageAudit(db, ctx.clock.next(), { image: id, product: product!, actor: user!, action: "abort" });
    }
  } else if (v.status === "reserved" && lease !== null && v.lease_token === lease && v.lease_actor === user) {
    db.exec(
      'UPDATE "erp_catalog__product_stored_image" SET lease_token=NULL, lease_actor=NULL, lease_until=NULL WHERE id=?',
      id,
    );
  }
  return { image: imageDto(db, id!), data_mode: "erp_native" };
}

registerRpc("erp_catalog_product_image_stop", erpCatalogProductImageStop);
