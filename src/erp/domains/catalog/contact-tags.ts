// Etiquetas de contato (erp_catalog.contact_tag e contact_tag_state): os
// ids, o bloco devolvido à tela e a versão própria das etiquetas.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { compareText } from "./fields.ts";
import { fold } from "./internal.ts";

const MAX_VERSION = 2147483647;

/** erp_catalog.contact_tag_ids(p_id): os ids das etiquetas, em ordem de texto. */
export function contactTagIds(db: SqlDriver, id: string): string[] {
  return db
    .exec('SELECT tag_id FROM "erp_catalog__contact_tag" WHERE record_id=?', id)
    .rows.map((r) => String(r.tag_id))
    .sort(compareText);
}

/** erp_catalog.contact_tags_data(p_id): versão, ids e etiquetas com o grupo, em ordem de nome. */
export function contactTagsData(db: SqlDriver, id: string): Record<string, unknown> {
  const state = one(db, 'SELECT CAST(version AS TEXT) version FROM "erp_catalog__contact_tag_state" WHERE record_id=?', id);
  const tags = db
    .exec(
      `SELECT t.id, t.name, t.parent_id, g.name group_name FROM "erp_catalog__contact_tag" x
       JOIN "erp_catalog__taxonomy" t ON t.id=x.tag_id LEFT JOIN "erp_catalog__taxonomy" g ON g.id=t.parent_id
       WHERE x.record_id=?`,
      id,
    )
    .rows.map((t) => ({ t, key: fold(String(t.name))! }))
    .sort((a, b) => compareText(a.key, b.key) || compareText(String(a.t.id), String(b.t.id)))
    .map(({ t }) => ({ id: t.id, name: t.name, group_id: t.parent_id, group_name: t.group_name }));
  return { contact_id: id, version: state ? Number(state.version) : 0, tag_ids: contactTagIds(db, id), tags };
}

/** erp_catalog.contact_tag_bump(p_user_id, p_id): nova versão das etiquetas do contato. */
export function contactTagBump(ctx: RpcContext, user: string, id: string) {
  const state = one(ctx.db, 'SELECT CAST(version AS TEXT) version FROM "erp_catalog__contact_tag_state" WHERE record_id=?', id);
  if (state && Number(state.version) === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
  ctx.db.exec(
    `INSERT INTO "erp_catalog__contact_tag_state"(record_id, version, updated_by, updated_at) VALUES (?,1,?,?)
     ON CONFLICT(record_id) DO UPDATE SET version=version+1, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    id,
    user,
    ctx.clock.next().toString(),
  );
}
