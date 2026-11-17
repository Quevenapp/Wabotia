// public.erp_catalog_seller_page: a lista de vendedores (contatos que têm a
// configuração de vendedor), com busca, tipo, situação, ordem e página, na
// carteira do vendedor quando a preferência está ligada.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// O Fagoo acrescenta "exists(seller)" ao contact_where e pagina no page_sql.
// Aqui o contactPage da P devolve a lista inteira já filtrada e ordenada, e o
// recorte de vendedor e a página acontecem em TS: o mesmo total e os mesmos ids.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { contactScope } from "../contact.ts";
import { contactFilterValid, contactListItem, contactPage, pageValid } from "../contact-list.ts";
import { searchTerms } from "../fields.ts";
import { sellerAccess } from "../seller.ts";

const ALL = 2 ** 31;

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
  const all = contactPage(
    db,
    {
      situation: situation!, terms: searchTerms(query), type, personType: null, state: null, city: null, phone: null, email: null,
      seller: null, scope, period: null, from: null, to: null, statuses: null,
    },
    sort!,
    0,
    ALL,
  ).ids;
  const sellers = new Map(
    db.exec('SELECT id, contact_id, CAST(version AS TEXT) version FROM "erp_catalog__seller"').rows.map((s) => [String(s.contact_id), s]),
  );
  const ids = all.filter((id) => sellers.has(id));
  const items = ids.slice((page! - 1) * size!, (page! - 1) * size! + size!).map((id) => {
    const s = sellers.get(id)!;
    return { ...contactListItem(db, id), seller_id: s.id, seller_version: Number(s.version) };
  });
  return {
    entity: "sellers",
    page,
    size,
    total: ids.length,
    sort,
    situation,
    can_write: role === "admin",
    data_mode: "erp_native",
    items,
  };
}

registerRpc("erp_catalog_seller_page", erpCatalogSellerPage);
