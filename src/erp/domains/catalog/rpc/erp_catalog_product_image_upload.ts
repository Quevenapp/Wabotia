// Envio das imagens do produto: public.erp_catalog_product_image_reserve,
// _claim, _object e _finish (migração 202610200193).
// storage.buckets/objects do Supabase: no Wabotia o objeto fica no R2; o
// bucket sempre existe (erp_attachments.storage_ready não falha, como nos
// arquivos da Empresa) e a confirmação do envio lê o objeto que o hub
// consultou antes da transação (ctx.objects, registerRpc(…, { objects })).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { boolArg, intArg, textArg, uuidArg } from "../args.ts";
import { requestHash } from "../command.ts";
import { imageAudit, imageAuthorize, imageDto, imageRow, nowMicros } from "../product-images.ts";

const BUCKET = "erp-attachments";
const objectKey = (product: string, id: string, sha: string) => `products/${product}/${id}/${sha}`;
const LEASE_MICROS = 120_000_000n;

/** public.erp_catalog_product_image_reserve: reserva o envio (cota de 20 prontas ou reservadas e 60 registros). */
function reserve(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const command = uuidArg(a, "p_command_id");
  const filename = textArg(a, "p_filename");
  const mime = textArg(a, "p_mime_type");
  const size = intArg(a, "p_size_bytes");
  const sha = textArg(a, "p_sha256");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : null;
  if (
    command === null ||
    ext === null ||
    size === null ||
    size < 1 ||
    size > 2097152 ||
    sha === null ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    filename === null ||
    !new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${ext}$`).test(filename)
  )
    raise("22023", "erp_attachment_invalid_metadata");
  const hash = requestHash({ actor: user, product_id: product, filename, mime_type: mime, size_bytes: size, sha256: sha });
  const stored = one(db, 'SELECT id, actor, request_hash FROM "erp_catalog__product_stored_image" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_attachment_command_conflict");
    return { image: imageDto(db, String(stored.id)), replayed: true, data_mode: "erp_native" };
  }
  const count = (where: string) =>
    Number(one(db, `SELECT count(*) n FROM "erp_catalog__product_stored_image" WHERE product_id=? ${where}`, product)!.n);
  if (count("") >= 60 || count("AND (status='reserved' OR (status='ready' AND deleted_at IS NULL))") >= 20)
    raise("54000", "erp_attachment_quota");
  const id = crypto.randomUUID();
  db.exec(
    `INSERT INTO "erp_catalog__product_stored_image"(id, product_id, command_id, actor, request_hash, filename, mime_type, size_bytes,
     sha256, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'reserved',?)`,
    id,
    product,
    command,
    user,
    hash,
    filename,
    mime,
    size,
    sha,
    ctx.clock.next().toString(),
  );
  imageAudit(db, ctx.clock.next(), { image: id, product: product!, actor: user!, action: "reserve", command });
  return { image: imageDto(db, id), replayed: false, data_mode: "erp_native" };
}

/** public.erp_catalog_product_image_claim: toma a posse do envio por 120 segundos. */
function claim(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const id = uuidArg(a, "p_id");
  const lease = uuidArg(a, "p_lease");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  if (lease === null) raise("22023", "erp_attachment_invalid_lease");
  const v = imageRow(db, product, id);
  const held = v.lease_until !== null && BigInt(v.lease_until) > nowMicros();
  if (v.status === "aborted" || v.deleted_at !== null || (v.status === "reserved" && held && (v.lease_token !== lease || v.lease_actor !== user)))
    raise("40001", "erp_attachment_upload_conflict");
  if (v.status === "reserved")
    db.exec(
      'UPDATE "erp_catalog__product_stored_image" SET lease_token=?, lease_actor=?, lease_until=? WHERE id=?',
      lease,
      user,
      (ctx.clock.next() + LEASE_MICROS).toString(),
      id,
    );
  return { ...imageDto(db, id!, true), data_mode: "erp_native" };
}

/** public.erp_catalog_product_image_object: a chave do objeto para ler (pronta) ou enviar (p_write). */
function object(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const id = uuidArg(a, "p_id");
  const write = boolArg(a, "p_write", false) ?? false;
  const db = ctx.db;
  imageAuthorize(db, user, product, write);
  const v = imageRow(db, product, id);
  if (v.status === "aborted" || v.deleted_at !== null || (!write && v.status !== "ready")) raise("40001", "erp_attachment_not_ready");
  return { ...imageDto(db, id!, true), data_mode: "erp_native" };
}

/** public.erp_catalog_product_image_finish: confirma o objeto enviado e põe a imagem na última posição. */
function finish(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const product = uuidArg(a, "p_product_id");
  const id = uuidArg(a, "p_id");
  const lease = uuidArg(a, "p_lease");
  const sha = textArg(a, "p_sha256");
  const size = intArg(a, "p_size_bytes");
  const db = ctx.db;
  imageAuthorize(db, user, product, true);
  const v = imageRow(db, product, id);
  if (sha !== v.sha256 || size !== v.size_bytes) raise("40001", "erp_attachment_integrity_conflict");
  if (v.status === "ready") return { image: imageDto(db, id!), replayed: true, data_mode: "erp_native" };
  if (
    v.status !== "reserved" ||
    lease === null ||
    v.lease_token !== lease ||
    v.lease_actor !== user ||
    v.lease_until === null ||
    BigInt(v.lease_until) <= nowMicros()
  )
    raise("40001", "erp_attachment_upload_conflict");
  const stored = ctx.objects(`${BUCKET}/${objectKey(product!, id!, v.sha256)}`);
  if (!stored || String(stored.size) !== String(v.size_bytes) || stored.mimetype !== v.mime_type)
    raise("40001", "erp_attachment_object_unconfirmed");
  const position =
    Number(one(db, 'SELECT coalesce(max(position),0) p FROM "erp_catalog__product_stored_image" WHERE product_id=? AND position IS NOT NULL', product)!.p) + 1;
  db.exec(
    `UPDATE "erp_catalog__product_stored_image" SET status='ready', lease_token=NULL, lease_actor=NULL, lease_until=NULL,
     finished_by=?, finished_at=?, position=? WHERE id=?`,
    user,
    ctx.clock.next().toString(),
    position,
    id,
  );
  imageAudit(db, ctx.clock.next(), { image: id, product: product!, actor: user!, action: "finalize" });
  return { image: imageDto(db, id!), replayed: false, data_mode: "erp_native" };
}

/** Chave que o finish confere, a partir dos argumentos (p_sha256 tem de ser o da reserva). */
function finishObjects(a: RpcArgs): string[] {
  const uuid = (v: unknown) => (typeof v === "string" ? uuidArg({ v }, "v") : null);
  const product = uuid(a.p_product_id),
    id = uuid(a.p_id);
  return product && id && typeof a.p_sha256 === "string" ? [`${BUCKET}/${objectKey(product, id, a.p_sha256)}`] : [];
}

registerRpc("erp_catalog_product_image_reserve", reserve);
registerRpc("erp_catalog_product_image_claim", claim);
registerRpc("erp_catalog_product_image_object", object);
registerRpc("erp_catalog_product_image_finish", finish, { objects: finishObjects });
