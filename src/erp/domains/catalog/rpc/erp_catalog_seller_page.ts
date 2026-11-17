// public.erp_catalog_seller_page: a lista de vendedores (contatos que têm a
// configuração de vendedor), com busca, tipo, situação, ordem e página, na
// carteira do vendedor quando a preferência está ligada.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// O Fagoo acrescenta "exists(seller)" ao contact_where e pagina no page_sql;
// aqui a mesma condição entra no WHERE do contactPage da P (extra), e a
// contagem, a ordem e a página ficam no SQL.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { contactScope } from "../contact.ts";
import { contactFilterValid, contactListItem, contactPage, pageValid } from "../contact-list.ts";
import { searchTerms } from "../fields.ts";
import { sellerAccess } from "../seller.ts";

const IS_SELLER = { sql: 'EXISTS(SELECT 1 FROM "erp_catalog__seller" s WHERE s.contact_id=r.id)', params: [] };

export function erpCatalogSellerPage(ctx: RpcContext, a: RpcArgs) {
  const arg = <T>(name: string) => (a[name] ?? null) as T | null;
  const user = arg<string>("p_user_id");
  const page = arg<number>("p_page");
  const size = arg<number>("p_size");
  const sort = arg<string>("p_sort");
  const query = arg<string>("p_query");
  const situation = arg<string>("p_situation");
  const type = arg<string>("p_type");
  const db = ctx.db;
  const role = sellerAccess(db, user, false);
  if (
    !pageValid(page, size, sort, query, null, null, null) ||
    !contactFilterValid(db, {
      situation, type, personType: null, state: null, city: null, phone: null, email: null, period: null, from: null, to: null, statuses: null,
    })
  )
    raise("22023", "erp_catalog_invalid_query");
  const scope = contactScope(db, user);
  const { total, ids } = contactPage(
    db,
    {
      situation: situation!, terms: searchTerms(query), type, personType: null, state: null, city: null, phone: null, email: null,
      seller: null, scope, period: null, from: null, to: null, statuses: null, extra: IS_SELLER,
    },
    sort!,
    (page! - 1) * size!,
    size!,
  );
  const items = ids.map((id) => {
    const s = one(db, 'SELECT id, CAST(version AS TEXT) version FROM "erp_catalog__seller" WHERE contact_id=?', id)!;
    return { ...contactListItem(db, id), seller_id: s.id, seller_version: Number(s.version) };
  });
  return {
    entity: "sellers",
    page,
    size,
    total,
    sort,
    situation,
    can_write: role === "admin",
    data_mode: "erp_native",
    items,
  };
}

registerRpc("erp_catalog_seller_page", erpCatalogSellerPage);
