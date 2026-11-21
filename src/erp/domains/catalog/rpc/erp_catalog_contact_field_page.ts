// erp_catalog_contact_field_page (Wabotia, campos próprios de contato; esquema
// do ERP versão 20): a lista de contatos de erp_catalog_contact_page_tagged
// (mesmos filtros, ordem, página e carteira do vendedor) com os filtros dos
// campos próprios (p_fields: até 10 filtros de campos marcados como filtro;
// sensível só depois de liberado). Usada pela tela só quando há filtro de
// campo próprio; sem ele, a tela continua na lista portada.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactScope } from "../contact.ts";
import { contactFieldCondition, userArg } from "../contact-fields.ts";
import { contactFilterValid, contactListItem, contactPage, contactTagCondition, contactTagFilterValid, digits, pageValid } from "../contact-list.ts";
import { btrim, searchTerms } from "../fields.ts";

export function erpCatalogContactFieldPage(ctx: RpcContext, a: RpcArgs) {
  const arg = <T>(name: string) => (a[name] ?? null) as T | null;
  const user = userArg(a.p_user_id);
  const page = arg<number>("p_page") ?? 1, size = arg<number>("p_size") ?? 100, sort = arg<string>("p_sort") ?? "created_desc";
  const query = arg<string>("p_query"), situation = arg<string>("p_situation") ?? "latest", type = arg<string>("p_type");
  const personType = arg<string>("p_person_type"), state = arg<string>("p_state"), city = arg<string>("p_city");
  const phone = arg<string>("p_phone"), email = arg<string>("p_email"), seller = arg<string>("p_seller_id");
  const period = arg<string>("p_period"), from = arg<string>("p_from"), to = arg<string>("p_to");
  const statuses = arg<(string | null)[]>("p_sale_statuses"), tag = arg<string>("p_tag"), priceList = arg<string>("p_price_list_id");
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (
    !pageValid(page, size, sort, query, null, null, null) ||
    !contactFilterValid(db, { situation, type, personType, state, city, phone, email, period, from, to, statuses }) ||
    !contactTagFilterValid(tag) || (priceList !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(priceList)) ||
    (seller !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(seller))
  )
    raise("22023", "erp_catalog_invalid_query");
  const custom = contactFieldCondition(db, a.p_fields);
  const tags = contactTagCondition(tag, priceList);
  const scope = contactScope(db, user);
  const { total, ids } = contactPage(
    db,
    {
      situation, terms: searchTerms(query), type, personType, state,
      city: city === null ? null : btrim(city) || null, phone: phone === null ? null : digits(phone) || null,
      email: email === null ? null : btrim(email) || null, seller, scope, period, from, to, statuses: statuses as string[] | null,
      extra: custom ? { sql: `${tags.sql} AND ${custom.sql}`, params: [...tags.params, ...custom.params] } : tags,
    },
    sort,
    (page - 1) * size,
    size,
  );
  return { entity: "contacts", items: ids.map((id) => contactListItem(db, id)), page, size, total, sort, situation, scoped: scope !== null, data_mode: "erp_native" };
}

registerRpc("erp_catalog_contact_field_page", erpCatalogContactFieldPage);
