// public.erp_catalog_page: página de contatos ou depósitos pelo cadastro genérico.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { digits, pageValid } from "../contact-list.ts";
import { CNTRL, btrim, chars, searchTerms } from "../fields.ts";
import { listItem, recordPage } from "../record-list.ts";

export function erpCatalogPage(ctx: RpcContext, a: RpcArgs) {
  const arg = <T>(name: string) => (a[name] ?? null) as T | null;
  const user = arg<string>("p_user_id");
  const entity = arg<string>("p_entity");
  const page = arg<number>("p_page");
  const size = arg<number>("p_size");
  const sort = arg<string>("p_sort");
  const query = arg<string>("p_query");
  const active = arg<boolean>("p_active");
  const role = arg<string>("p_role");
  const personType = arg<string>("p_person_type");
  const state = arg<string>("p_state");
  const city = arg<string>("p_city");
  const phone = arg<string>("p_phone");
  const email = arg<string>("p_email");
  const period = arg<string>("p_period");
  const from = arg<string>("p_from");
  const to = arg<string>("p_to");
  const db = ctx.db;
  requireAccess(db, user, entity, false);
  if (
    entity === null || !["contacts", "warehouses"].includes(entity) || !pageValid(page, size, sort, query, period, from, to) ||
    (entity !== "contacts" && [role, personType, state, city, phone, email].some((x) => x !== null)) ||
    (role !== null && !["customer", "supplier", "carrier", "none"].includes(role)) ||
    (personType !== null && !["F", "J", "E"].includes(personType)) ||
    (state !== null && !/^[A-Z]{2}$/.test(state)) ||
    (city !== null && (chars(city) > 100 || CNTRL.test(city))) ||
    (phone !== null && (chars(phone) > 40 || CNTRL.test(phone) || !/[0-9]/.test(phone))) ||
    (email !== null && (chars(email) > 254 || CNTRL.test(email)))
  )
    raise("22023", "erp_catalog_invalid_query");
  const { total, ids } = recordPage(
    db,
    {
      entity, active, terms: searchTerms(query), role, personType, state,
      city: city === null ? null : btrim(city) || null, phone: phone === null ? null : digits(phone) || null,
      email: email === null ? null : btrim(email) || null, period, from, to,
    },
    sort!,
    (page! - 1) * size!,
    size!,
  );
  return { entity, items: ids.map((id) => listItem(db, id)), page, size, total, sort, data_mode: "erp_native" };
}

registerRpc("erp_catalog_page", erpCatalogPage);
