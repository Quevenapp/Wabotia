// public.erp_catalog_seller_options: até 25 vendedores ativos para um seletor,
// com busca por nome e código; o administrador recebe também as pessoas do ERP.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { CNTRL, chars, compareText, matches, searchTerms } from "../fields.ts";
import { fold } from "../internal.ts";
import { sellerUsers } from "../seller.ts";

export function erpCatalogSellerOptions(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const query = (a.p_query ?? null) as string | null;
  const db = ctx.db;
  const role = requireAccess(db, user, "contacts", false);
  if (query !== null && (chars(query) > 120 || CNTRL.test(query))) raise("22023", "erp_catalog_invalid_query");
  const terms = searchTerms(query);
  const items = db
    .exec(
      `SELECT s.id, r.name, r.code FROM "erp_catalog__seller" s JOIN "erp_catalog__record" r ON r.id=s.contact_id
       WHERE r.active=1`,
    )
    .rows.filter((x) => terms === null || matches(terms, fold([x.name, x.code].filter((v) => v !== null).join(" ")), "", ""))
    .map((x) => ({ x, key: fold(String(x.name))! }))
    .sort((p, q) => compareText(p.key, q.key) || compareText(String(p.x.id), String(q.x.id)))
    .slice(0, 25)
    .map(({ x }) => ({ id: x.id, name: x.name, code: x.code }));
  return { scope: "seller_options", data_mode: "erp_native", users: role === "admin" ? sellerUsers(db) : [], items };
}

registerRpc("erp_catalog_seller_options", erpCatalogSellerOptions);
