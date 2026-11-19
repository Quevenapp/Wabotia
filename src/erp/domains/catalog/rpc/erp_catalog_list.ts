// public.erp_catalog_list: lista por cursor (ordem de id), com busca.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { chars, lower, matches, searchTerms } from "../fields.ts";
import { dto, fold } from "../internal.ts";
import { projectCatalogResult } from "../part-projection.ts";

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function erpCatalogList(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const entity = (a.p_entity ?? null) as string | null;
  const limit = (a.p_limit ?? null) as number | null;
  const after = (a.p_after ?? null) as string | null;
  const query = (a.p_query ?? null) as string | null;
  const active = (a.p_active ?? null) as boolean | null;
  const db = ctx.db;
  requireAccess(db, user, entity, false);
  if (limit === null || limit < 1 || limit > 100 || (query !== null && chars(query) > 120)) raise("22023", "erp_catalog_invalid_query");
  const terms = searchTerms(query);
  const where = ["r.entity=?"];
  const params: unknown[] = [entity];
  if (after !== null) (where.push("r.id>?"), params.push(after));
  if (active !== null) (where.push("r.active=?"), params.push(active ? 1 : 0));
  const from = `FROM "erp_catalog__record" r LEFT JOIN "erp_catalog__contact" c ON c.record_id=r.id
    LEFT JOIN "erp_catalog__product" p ON p.record_id=r.id WHERE ${where.join(" AND ")} ORDER BY r.id`;
  let page: string[];
  if (terms === null) page = db.exec(`SELECT r.id ${from} LIMIT ?`, ...params, limit + 1).rows.map((r) => String(r.id));
  else {
    page = [];
    for (const r of db.exec(`SELECT r.id, r.name, r.code, c.trade_name, c.email, c.document, c.phone, c.mobile, p.gtin ${from}`, ...params).rows) {
      const text = fold([r.name, r.code, r.trade_name, r.email, r.document, r.phone, r.mobile, r.gtin].map(s).filter((x) => x !== null).join(" "));
      const compactDoc = lower(s(r.document) ?? "").replace(/[^0-9a-z]/g, "");
      const digitText = [r.document, r.phone, r.mobile].map(s).filter((x) => x !== null).join("|").replace(/[^0-9|]/g, "");
      if (matches(terms, text, compactDoc, digitText)) page.push(String(r.id));
      if (page.length > limit) break;
    }
  }
  const visible = page.slice(0, limit);
  const more = page.length > limit;
  return projectCatalogResult(ctx.parts, {
    entity,
    items: visible.map((id) => dto(db, id)),
    has_more: more,
    next_cursor: more ? visible[visible.length - 1] : null,
    limit,
    data_mode: "erp_native",
  });
}

registerRpc("erp_catalog_list", erpCatalogList);
