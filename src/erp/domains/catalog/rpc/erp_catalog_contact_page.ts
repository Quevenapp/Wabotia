// public.erp_catalog_contact_page: a lista de contatos com filtros, ordem e
// página (carteira do vendedor quando "Contato acessível somente ao vendedor
// vinculado" está ligado).
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactScope } from "../contact.ts";
import { contactFilterValid, contactListItem, contactPage, digits, pageValid } from "../contact-list.ts";
import { btrim, searchTerms } from "../fields.ts";

export function erpCatalogContactPage(ctx: RpcContext, a: RpcArgs) {
  const arg = <T>(name: string) => (a[name] ?? null) as T | null;
  const user = arg<string>("p_user_id");
  const page = arg<number>("p_page");
  const size = arg<number>("p_size");
  const sort = arg<string>("p_sort");
  const query = arg<string>("p_query");
  const situation = arg<string>("p_situation");
  const type = arg<string>("p_type");
  const personType = arg<string>("p_person_type");
  const state = arg<string>("p_state");
  const city = arg<string>("p_city");
  const phone = arg<string>("p_phone");
  const email = arg<string>("p_email");
  const seller = arg<string>("p_seller_id");
  const period = arg<string>("p_period");
  const from = arg<string>("p_from");
  const to = arg<string>("p_to");
  const statuses = arg<(string | null)[]>("p_sale_statuses");
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (
    !pageValid(page, size, sort, query, null, null, null) ||
    !contactFilterValid(db, { situation, type, personType, state, city, phone, email, period, from, to, statuses })
  )
    raise("22023", "erp_catalog_invalid_query");
  const scope = contactScope(db, user);
  const cityText = city === null ? null : btrim(city) || null;
  const phoneDigits = phone === null ? null : digits(phone) || null;
  const emailText = email === null ? null : btrim(email) || null;
  const { total, ids } = contactPage(
    db,
    {
      situation: situation!, terms: searchTerms(query), type, personType, state, city: cityText, phone: phoneDigits, email: emailText,
      seller, scope, period, from, to, statuses: statuses as string[] | null,
    },
    sort!,
    (page! - 1) * size!,
    size!,
  );
  return {
    entity: "contacts",
    items: ids.map((id) => contactListItem(db, id)),
    page,
    size,
    total,
    sort,
    situation,
    scoped: scope !== null,
    data_mode: "erp_native",
  };
}

registerRpc("erp_catalog_contact_page", erpCatalogContactPage);
