// public.erp_catalog_product_list: lista por cursor (id), sem excluídos,
// para integrações (MCP e API).
import { raise } from "../../../engine/errors.ts";
import { registerRpc } from "../../../engine/registry.ts";
import { boolArg, intArg, textArg, uuidArg } from "../pricing/args.ts";
import { CNTRL, btrim, chars, compareText, searchTerms } from "../fields.ts";
import { dto } from "../internal.ts";
import { projectCatalogResult } from "../part-projection.ts";
import { requireAccess } from "../pricing/deps.ts";
import { ncmPresent, pgLower, productRows, searchHit } from "../product-query.ts";

registerRpc("erp_catalog_product_list", (ctx, a) => {
  const user = uuidArg(a, "p_user_id");
  const limit = intArg(a, "p_limit", 25);
  const after = uuidArg(a, "p_after");
  const query = textArg(a, "p_query");
  const active = boolArg(a, "p_active");
  const kind = textArg(a, "p_kind");
  const format = textArg(a, "p_format");
  const presence = textArg(a, "p_ncm_presence");
  const brandArg = textArg(a, "p_brand");
  const db = ctx.db;
  requireAccess(db, user, "products", false);
  if (
    limit === null ||
    limit < 1 ||
    limit > 100 ||
    (query !== null && (chars(query) > 120 || CNTRL.test(query))) ||
    (brandArg !== null && (chars(brandArg) > 100 || CNTRL.test(brandArg))) ||
    (kind !== null && !["P", "S", "N"].includes(kind)) ||
    (format !== null && !["S", "V", "E"].includes(format)) ||
    (presence !== null && !["present", "missing"].includes(presence))
  )
    raise("22023", "erp_catalog_invalid_query");
  const terms = searchTerms(query);
  // strpos(lower(brand), lower(btrim(p_brand))): aqui é lower, não fold.
  const brand = brandArg === null || btrim(brandArg) === "" ? null : pgLower(btrim(brandArg));
  const page = productRows(db)
    .filter(
      (r) =>
        (after === null || compareText(r.id, after) > 0) &&
        (active === null || r.active === active) &&
        !r.deleted &&
        (kind === null || r.kind === kind) &&
        (format === null || r.format === format) &&
        (presence === null || ncmPresent(r.ncm) === (presence === "present")) &&
        (brand === null || pgLower(r.brand ?? "").includes(brand)) &&
        (terms === null || searchHit(terms, r)),
    )
    .map((r) => r.id)
    .sort(compareText)
    .slice(0, limit + 1);
  const visible = page.slice(0, limit);
  const more = page.length > limit;
  return projectCatalogResult(ctx.parts, {
    entity: "products",
    items: visible.map((id) => dto(db, id)),
    has_more: more,
    next_cursor: more ? visible[visible.length - 1] : null,
    limit,
    data_mode: "erp_native",
  });
});
