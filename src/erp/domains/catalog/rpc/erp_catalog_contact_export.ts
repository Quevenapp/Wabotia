// public.erp_catalog_contact_export e erp_catalog_contact_export_tagged:
// exportação de contatos ou de aniversariantes (mês/dia da data de
// nascimento no período, qualquer ano; um ano inteiro pega todos), até 10 000,
// em páginas de 100; a versão "tagged" filtra também etiqueta e lista de preço.
// Mesmo filtro da lista (contactPage); itens são contact_dto sem persons e source.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { auxiliaryAudit } from "../command.ts";
import { contactScope } from "../contact.ts";
import { contactDto } from "../contact-core.ts";
import { contactFilterValid, contactPage, contactTagCondition, contactTagFilterValid, digits, pageValid } from "../contact-list.ts";
import { btrim, searchTerms } from "../fields.ts";

const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
const mmdd = (d: string) => d.slice(5, 7) + d.slice(8, 10);
const BIRTH_MMDD = "(substr(cp.birth_date,6,2)||substr(cp.birth_date,9,2))";

function run(ctx: RpcContext, a: RpcArgs, tagged: boolean) {
  const arg = <T>(name: string) => (a[name] ?? null) as T | null;
  const user = arg<string>("p_user_id");
  const kind = arg<string>("p_kind");
  const offset = arg<number>("p_offset");
  const limit = arg<number>("p_limit");
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
  const birthFrom = arg<string>("p_birth_from");
  const birthTo = arg<string>("p_birth_to");
  const tag = tagged ? arg<string>("p_tag") : null;
  const priceList = tagged ? arg<string>("p_price_list_id") : null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (
    kind === null || !["contacts", "birthdays"].includes(kind) || offset === null || offset < 0 || offset > 9999 ||
    limit === null || limit < 1 || limit > 100 ||
    !pageValid(1, 1, sort, query, null, null, null) ||
    !contactFilterValid(db, { situation, type, personType, state, city, phone, email, period, from, to, statuses }) ||
    (tagged && !contactTagFilterValid(tag)) ||
    (kind === "contacts" && (birthFrom !== null || birthTo !== null)) ||
    (kind === "birthdays" &&
      (birthFrom === null || birthTo === null || birthFrom > birthTo || days(birthFrom, birthTo) > 366 ||
        birthFrom < "1900-01-01" || birthTo > "2100-12-31"))
  )
    raise("22023", "erp_catalog_invalid_query");
  const scope = contactScope(db, user);
  const conditions: { sql: string; params: unknown[] }[] = [];
  if (tagged) conditions.push(contactTagCondition(tag, priceList));
  let order: string | null = null;
  if (kind === "birthdays") {
    const whole = days(birthFrom!, birthTo!) >= 365;
    const f = mmdd(birthFrom!),
      t = mmdd(birthTo!);
    conditions.push({
      sql: whole
        ? "cp.birth_date IS NOT NULL"
        : f <= t
          ? `cp.birth_date IS NOT NULL AND ${BIRTH_MMDD} BETWEEN ? AND ?`
          : `cp.birth_date IS NOT NULL AND (${BIRTH_MMDD}>=? OR ${BIRTH_MMDD}<=?)`,
      params: whole ? [] : [f, t],
    });
    order = `${BIRTH_MMDD}, r.name__fold, r.id`;
  }
  const extra = conditions.length
    ? { sql: conditions.map((c) => `(${c.sql})`).join(" AND "), params: conditions.flatMap((c) => c.params) }
    : null;
  const { total, ids } = contactPage(
    db,
    {
      situation: situation!, terms: searchTerms(query), type, personType, state,
      city: city === null ? null : btrim(city) || null, phone: phone === null ? null : digits(phone) || null,
      email: email === null ? null : btrim(email) || null, seller, scope, period, from, to, statuses: statuses as string[] | null,
      extra, order,
    },
    sort!,
    offset,
    limit,
  );
  if (total > 10000) raise("22023", "erp_catalog_export_too_large");
  const items = ids.map((id) => {
    const dto = { ...(contactDto(db, id) as Record<string, unknown>) };
    delete dto.persons;
    delete dto.source;
    return dto;
  });
  if (offset === 0)
    auxiliaryAudit(ctx, {
      actor: user!, command: null, subject: "contacts_export", subjectId: null, action: kind,
      after: {
        total, situation, type, period, query_present: query !== null,
        ...(tagged ? { tag: tag !== null, price_list: priceList !== null } : {}),
      },
    });
  return { scope: "contacts_export", kind, items, offset, limit, total, data_mode: "erp_native" };
}

registerRpc("erp_catalog_contact_export", (ctx, a) => run(ctx, a, false));
registerRpc("erp_catalog_contact_export_tagged", (ctx, a) => run(ctx, a, true));
