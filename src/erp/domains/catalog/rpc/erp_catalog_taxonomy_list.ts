// public.erp_catalog_taxonomy_list: categorias, grupos de produto, grupos de
// etiquetas e etiquetas (só os tipos que o papel lê), por nome sem acento e id.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { compareText, foldedKey } from "../fields.ts";
import { taxonomyItem } from "../taxonomy.ts";
import { tagTypesReadable, taxonomySpec } from "../taxonomy-access.ts";

export function erpCatalogTaxonomyList(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const kind = (a.p_kind ?? null) as string | null;
  const db = ctx.db;
  if (taxonomySpec(kind) === null) {
    requireAccess(db, user, "products", false);
    raise("22023", "erp_catalog_invalid_query");
  }
  let types: string[] | null = null;
  if (kind === "tag_groups" || kind === "tags") {
    types = tagTypesReadable(db, user, ctx.modules);
    if (types.length === 0) raise("42501", "erp_catalog_access_denied");
  } else requireAccess(db, user, "products", false);
  const rows = db
    .exec('SELECT id, name, name__fold, tag_type FROM "erp_catalog__taxonomy" WHERE kind=?', kind)
    .rows.filter((t) => types === null || (t.tag_type !== null && types.includes(String(t.tag_type))))
    .sort((x, y) => compareText(foldedKey(x, "name") ?? "", foldedKey(y, "name") ?? "") || compareText(String(x.id), String(y.id)));
  return { kind, data_mode: "erp_native", items: rows.map((t) => taxonomyItem(db, String(t.id))) };
}

registerRpc("erp_catalog_taxonomy_list", erpCatalogTaxonomyList);
