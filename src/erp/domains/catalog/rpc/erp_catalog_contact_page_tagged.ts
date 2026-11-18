// public.erp_catalog_contact_page_tagged: a lista de contatos com o filtro de
// etiqueta (ou "sem etiqueta") e de lista de preço (por contato ou por UF).
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactScope } from "../contact.ts";
import { contactFilterValid, contactListItem, contactPage, contactTagCondition, contactTagFilterValid, digits, pageValid } from "../contact-list.ts";
import { btrim, searchTerms } from "../fields.ts";

export function erpCatalogContactPageTagged(ctx: RpcContext, a: RpcArgs) {
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
  const tag = arg<string>("p_tag");
  const priceList = arg<string>("p_price_list_id");
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (
    !pageValid(page, size, sort, query, null, null, null) ||
    !contactFilterValid(db, { situation, type, personType, state, city, phone, email, period, from, to, statuses }) ||
    !contactTagFilterValid(tag)
  )
    raise("22023", "erp_catalog_invalid_query");
  const scope = contactScope(db, user);
  const { total, ids } = contactPage(
    db,
    {
      situation: situation!, terms: searchTerms(query), type, personType, state,
      city: city === null ? null : btrim(city) || null, phone: phone === null ? null : digits(phone) || null,
      email: email === null ? null : btrim(email) || null, seller, scope, period, from, to, statuses: statuses as string[] | null,
      extra: contactTagCondition(tag, priceList),
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

registerRpc("erp_catalog_contact_page_tagged", erpCatalogContactPageTagged);
