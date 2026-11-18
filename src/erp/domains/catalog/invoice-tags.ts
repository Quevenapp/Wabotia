// Etiquetas de nota (erp_catalog.invoice_tag e invoice_tag_state): ids, o
// bloco devolvido à tela, a versão própria, a chave da nota e o alvo (nota
// nativa ou espelhada do Origin). Base do invoice_tags/_save (bloco C) e do
// taxonomy_delete da P (desvincula as notas da etiqueta apagada).
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// Origin: a nota espelhada (origem 'origin', chave numérica) se lê em
// origin_sync.raw_record, como no Fagoo; nada aqui é constante.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { activeRole } from "../access/public.ts";
import { compareText } from "./fields.ts";
import { fold } from "./internal.ts";
import { invoiceTagsAllowed } from "./taxonomy-access.ts";

/**
 * erp_catalog.require_invoice_tags(p_user_id, p_origin, p_write): o papel lê
 * (admin, consulta, fiscal) ou escreve (admin, fiscal) etiquetas de nota; a
 * nota nativa só para admin e fiscal.
 */
export function requireInvoiceTags(db: SqlDriver, user: string | null, origin: string | null, write: boolean): string {
  const role = user === null ? null : activeRole(db, user);
  if (!invoiceTagsAllowed(role, write) || (origin === "brufap" && !["admin", "fiscal"].includes(role!)))
    raise("42501", "erp_catalog_access_denied");
  return role!;
}

const MAX_VERSION = 2147483647;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** erp_catalog.invoice_tag_key_valid(p_origin, p_model, p_id): 55/65 e a chave da origem (número no Origin, uuid na nota nativa). */
export function invoiceTagKeyValid(origin: string | null, model: string | null, id: string | null): boolean {
  if (model === null || !["55", "65"].includes(model) || id === null) return false;
  if (origin === "origin") return /^[0-9]{1,40}$/.test(id);
  if (origin === "brufap") return LOWER_UUID.test(id);
  return false;
}

/** erp_catalog.invoice_tag_ids(p_origin, p_model, p_id): os ids das etiquetas da nota, em ordem de texto. */
export function invoiceTagIds(db: SqlDriver, origin: string, model: string, id: string): string[] {
  return db
    .exec('SELECT tag_id FROM "erp_catalog__invoice_tag" WHERE origin=? AND model=? AND invoice_id=?', origin, model, id)
    .rows.map((r) => String(r.tag_id))
    .sort(compareText);
}

/** erp_catalog.invoice_tags_data(p_origin, p_model, p_id): versão, ids e etiquetas com o grupo, em ordem de nome. */
export function invoiceTagsData(db: SqlDriver, origin: string, model: string, id: string): Record<string, unknown> {
  const state = one(
    db,
    'SELECT CAST(version AS TEXT) version FROM "erp_catalog__invoice_tag_state" WHERE origin=? AND model=? AND invoice_id=?',
    origin, model, id,
  );
  const tags = db
    .exec(
      `SELECT t.id, t.name, t.parent_id, g.name group_name FROM "erp_catalog__invoice_tag" x
       JOIN "erp_catalog__taxonomy" t ON t.id=x.tag_id LEFT JOIN "erp_catalog__taxonomy" g ON g.id=t.parent_id
       WHERE x.origin=? AND x.model=? AND x.invoice_id=?`,
      origin, model, id,
    )
    .rows.map((t) => ({ t, key: fold(String(t.name))! }))
    .sort((a, b) => compareText(a.key, b.key) || compareText(String(a.t.id), String(b.t.id)))
    .map(({ t }) => ({ id: t.id, name: t.name, group_id: t.parent_id, group_name: t.group_name }));
  return { invoice_id: id, version: state ? Number(state.version) : 0, tag_ids: invoiceTagIds(db, origin, model, id), tags };
}

/**
 * erp_catalog.invoice_tag_target(p_origin, p_model, p_id): a nota existe — nativa
 * (erp_fiscal_invoices.invoice do modelo, não excluída) ou espelhada do Origin
 * (origin_sync.raw_record de nfe/nfce).
 */
export function invoiceTagTarget(db: SqlDriver, origin: string, model: string, id: string): boolean {
  if (origin === "brufap")
    return !!one(db, 'SELECT 1 x FROM "erp_fiscal_invoices__invoice" WHERE id=? AND model=? AND deleted_at IS NULL', id, model);
  if (origin === "origin")
    return !!one(db, 'SELECT 1 x FROM "origin_sync__raw_record" WHERE entity=? AND source_id=?', model === "55" ? "nfe" : "nfce", id);
  return false;
}

/** erp_catalog.invoice_tag_bump(p_user_id, p_origin, p_model, p_id): nova versão das etiquetas da nota. */
export function invoiceTagBump(ctx: RpcContext, user: string, origin: string, model: string, id: string) {
  const state = one(
    ctx.db,
    'SELECT CAST(version AS TEXT) version FROM "erp_catalog__invoice_tag_state" WHERE origin=? AND model=? AND invoice_id=?',
    origin, model, id,
  );
  if (state && Number(state.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
  ctx.db.exec(
    `INSERT INTO "erp_catalog__invoice_tag_state"(origin, model, invoice_id, version, updated_by, updated_at) VALUES (?,?,?,1,?,?)
     ON CONFLICT(origin, model, invoice_id) DO UPDATE SET version=version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    origin, model, id, user, ctx.clock.next().toString(),
  );
}
