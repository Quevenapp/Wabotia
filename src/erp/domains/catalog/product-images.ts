// Imagens armazenadas do produto (erp_catalog.product_stored_image):
// product_image_authorize, product_image_row, product_image_dto e
// product_images_data. Portado da migração 202610200193 (versões finais no
// oráculo).
//
// A posição única (product_id, position) era DEFERRABLE no Postgres e aqui é
// imediata (docs/ERP-FASE0.md, prova 1): quem reordena passa por um estado
// intermediário válido (ver erp_catalog_product_image_order).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { jsonTimestamp } from "../../engine/time.ts";
import { requireAccess } from "./pricing/deps.ts";

export interface StoredImage {
  id: string;
  product_id: string;
  command_id: string;
  actor: string;
  request_hash: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: string;
  lease_token: string | null;
  lease_actor: string | null;
  /** microssegundos (texto) */
  lease_until: string | null;
  finished_by: string | null;
  created_at: string;
  finished_at: string | null;
  position: number | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_command_id: string | null;
}

const COLUMNS = `id, product_id, command_id, actor, request_hash, filename, mime_type, size_bytes, sha256, status,
  lease_token, lease_actor, CAST(lease_until AS TEXT) lease_until, finished_by, CAST(created_at AS TEXT) created_at,
  CAST(finished_at AS TEXT) finished_at, position, CAST(deleted_at AS TEXT) deleted_at, deleted_by, delete_command_id`;

const toImage = (r: Record<string, unknown>) =>
  ({ ...r, size_bytes: Number(r.size_bytes), position: r.position === null ? null : Number(r.position) }) as StoredImage;

/** clock_timestamp() em microssegundos, sem mexer no relógio do motor. */
export const nowMicros = () => BigInt(Date.now()) * 1000n;

/** erp_catalog.product_image_authorize(p_user_id, p_product_id, p_write) */
export function imageAuthorize(db: SqlDriver, user: string | null, product: string | null, write: boolean | null) {
  if (write === null) raise("22023", "erp_attachment_invalid_action");
  requireAccess(db, user, "products", write);
  if (
    product === null ||
    !one(
      db,
      `SELECT 1 x FROM "erp_catalog__product" p JOIN "erp_catalog__record" r ON r.id=p.record_id
       WHERE p.record_id=? AND r.entity='products'`,
      product,
    )
  )
    raise("P0002", "erp_catalog_not_found");
  if (write && one(db, 'SELECT 1 x FROM "erp_catalog__product_detail" WHERE record_id=? AND deleted_at IS NOT NULL', product))
    raise("40001", "erp_catalog_product_deleted");
}

/** erp_catalog.product_image_row(p_product_id, p_id, p_lock) */
export function imageRow(db: SqlDriver, product: string | null, id: string | null): StoredImage {
  const r =
    product === null || id === null
      ? null
      : one(db, `SELECT ${COLUMNS} FROM "erp_catalog__product_stored_image" WHERE id=? AND product_id=?`, id, product);
  if (!r) raise("P0002", "erp_attachment_not_found");
  return toImage(r);
}

export const imageById = (db: SqlDriver, id: string) => {
  const r = one(db, `SELECT ${COLUMNS} FROM "erp_catalog__product_stored_image" WHERE id=?`, id);
  return r ? toImage(r) : null;
};

/** left(texto, n): caracteres, não unidades UTF-16. */
const left = (s: string, n: number) => [...s].slice(0, n).join("");

/** erp_catalog.product_image_dto(p_id, p_internal default false) */
export function imageDto(db: SqlDriver, id: string, internal = false): Record<string, unknown> | null {
  const f = imageById(db, id);
  if (!f) return null;
  const owner = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', f.actor);
  return {
    id: f.id,
    product_id: f.product_id,
    filename: f.filename,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes,
    sha256: f.sha256,
    status: f.status,
    position: f.position,
    created_at: jsonTimestamp(f.created_at),
    finished_at: f.finished_at === null ? null : jsonTimestamp(f.finished_at),
    deleted: f.deleted_at !== null,
    owner_name: owner ? left(String(owner.name), 120) : null,
    ...(internal ? { bucket: "erp-attachments", object_key: `products/${f.product_id}/${f.id}/${f.sha256}` } : {}),
  };
}

/** erp_catalog.product_images_data(p_product_id) */
export function imagesData(db: SqlDriver, product: string) {
  const ready = db
    .exec(
      `SELECT id, size_bytes FROM "erp_catalog__product_stored_image"
       WHERE product_id=? AND status='ready' AND deleted_at IS NULL ORDER BY position`,
      product,
    )
    .rows;
  const pending = db.exec(
    `SELECT id FROM "erp_catalog__product_stored_image" WHERE product_id=? AND status='reserved' ORDER BY created_at, id`,
    product,
  ).rows;
  return {
    product_id: product,
    items: ready.map((r) => imageDto(db, String(r.id))),
    pending: pending.map((r) => imageDto(db, String(r.id))),
    stored_bytes: String(ready.reduce((s, r) => s + Number(r.size_bytes), 0)),
    limit: 20,
    data_mode: "erp_native",
  };
}

export function imageAudit(
  db: SqlDriver,
  at: bigint,
  row: { image: string | null; product: string; actor: string; action: string; command?: string | null; after?: string | null },
) {
  db.exec(
    `INSERT INTO "erp_catalog__product_image_audit"(image_id, product_id, actor, action, command_id, after_data, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    row.image,
    row.product,
    row.actor,
    row.action,
    row.command ?? null,
    row.after ?? null,
    at.toString(),
  );
}
